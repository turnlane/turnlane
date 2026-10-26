/** サブエージェントが動いている間の親の状態・待ち・時間（ai-session-ingestion 4.2・4.3・4.5）の表駆動テスト */
import { describe, expect, test } from "bun:test";
import {
  deriveStatus,
  desiredFollowUps,
  humanInputAfter,
  isHumanTurn,
  reconcileFollowUps,
  type SubagentFact,
  sessionWaitOf,
  subagentInterval,
  subagentOnlyRanges,
  type TurnFact,
  type WorkItemFacts,
  waitIntervals,
} from "../../src/derive/index.ts";
import {
  at,
  facts,
  followUp,
  hook,
  MIN,
  SETTINGS,
  session,
  shuffled,
  TIMING,
  turn,
} from "./helpers.ts";

const status = (f: WorkItemFacts, now: number) => {
  const a = deriveStatus(f, now, SETTINGS, TIMING);
  expect(deriveStatus(shuffled(f), now, SETTINGS, TIMING)).toEqual(a);
  return a;
};

function sub(p: Partial<SubagentFact> & { start: number; last: number }): SubagentFact {
  const { start, last, ...rest } = p;
  return {
    id: "sub1",
    parentId: "s1",
    agentId: "a1",
    startedAt: start,
    lastActivityAt: last,
    endedAt: null,
    ...rest,
  };
}

/** 親: 10:00 に頼んで 10:05 に Stop（編集あり）。サブエージェントは 10:03 から */
const parent = (p: Partial<TurnFact> = {}) =>
  turn({ id: "p1", start: at("10:00"), end: at("10:05"), editedFiles: 1, ...p });

const withSubs = (turns: TurnFact[], subagents: SubagentFact[], p: Partial<WorkItemFacts> = {}) =>
  facts({
    turns,
    sessions: [
      session({ lastActivityAt: Math.max(...turns.map((t) => t.endedAt ?? t.startedAt)) }),
    ],
    subagents,
    ...p,
  });

describe("親のターンが閉じた後もサブエージェントが動いている", () => {
  test("サブエージェントが動いている → 親は running（subagent:running）。サブエージェントが無ければ従来どおり your_turn", () => {
    const now = at("10:14");
    expect(status(withSubs([parent()], []), now)).toEqual({
      status: "your_turn",
      reason: "edits",
      estimated: true,
    });
    expect(
      status(withSubs([parent()], [sub({ start: at("10:03"), last: at("10:12") })]), now),
    ).toEqual({ status: "running", reason: "subagent:running", estimated: true });
  });

  test.each([
    {
      name: "サブエージェントが終わった（end_turn）",
      s: sub({ start: at("10:03"), last: at("10:12"), endedAt: at("10:12") }),
    },
    {
      name: "サブエージェントの最後の活動が runningStale（5 分）より前",
      s: sub({ start: at("10:03"), last: at("10:06") }),
    },
  ])("$name → 親は従来の判定に戻る", ({ s }) => {
    const now = at("10:14");
    const without = status(withSubs([parent()], []), now);
    expect(status(withSubs([parent()], [s]), now)).toEqual(without);
  });

  test("サブエージェントの完了で親が再開した（task-notification。initiator=system）→ 再開したターンの判定に戻る", () => {
    const resumed = turn({
      id: "p2",
      start: at("10:12") + 10_000,
      end: at("10:14"),
      initiator: "system",
    });
    const s = sub({ start: at("10:03"), last: at("10:12"), endedAt: at("10:12") });
    const now = at("10:20");
    expect(status(withSubs([parent(), resumed], [s]), now)).toEqual(
      status(withSubs([parent(), resumed], []), now),
    );
    // 再開のターンは人の入力ではない（待ちを閉じない）
    expect(isHumanTurn(resumed)).toBe(false);
    const f = withSubs([parent(), resumed], [s]);
    expect(humanInputAfter(f, "s1", at("10:00"))).toBeNull();
  });

  test("サブエージェントが動いている途中に親が再開していれば、その後の活動が無いサブエージェントは止まったとみなす", () => {
    const resumed = turn({ id: "p2", start: at("10:13"), end: at("10:14"), initiator: "system" });
    const f = withSubs([parent(), resumed], [sub({ start: at("10:03"), last: at("10:12") })]);
    expect(status(f, at("10:15")).reason).not.toBe("subagent:running");
  });

  test("親のターンが開いたまま古くなっても（前景のサブエージェントを待っている）、サブエージェントが動いていれば running", () => {
    const open = turn({ id: "p1", start: at("10:00"), end: null });
    const f = facts({
      turns: [open],
      sessions: [session({ lastActivityAt: at("10:01") })],
      subagents: [sub({ start: at("10:01"), last: at("10:19") })],
    });
    expect(status(f, at("10:20"))).toEqual({
      status: "running",
      reason: "subagent:running",
      estimated: true,
    });
  });

  test("問いで終わった親（endedWith=question）でも、サブエージェントが終わるまで返答待ちにしない（返答タスクも作らない）", () => {
    const q = parent({ endedWith: "question", editedFiles: 0 });
    const running = withSubs([q], [sub({ start: at("10:03"), last: at("10:24") })]);
    const now = at("10:25"); // 猶予（15 分）を過ぎている
    const st = status(running, now);
    expect(st.status).toBe("running");
    const want = desiredFollowUps(running, st, now, SETTINGS, TIMING);
    expect(want.filter((x) => x.kind === "reply")).toEqual([]);
    expect(sessionWaitOf(running, st, now, SETTINGS, TIMING)).toBeNull();
    // サブエージェントが終わって親が再開しなければ、問いの返答待ちに戻る
    const ended = withSubs(
      [q],
      [sub({ start: at("10:03"), last: at("10:24"), endedAt: at("10:24") })],
    );
    expect(status(ended, now)).toMatchObject({ status: "your_turn", reason: "question" });
  });
});

describe("サブエージェントの許可待ち", () => {
  test("agentId 付きの PermissionRequest（親のターンが閉じた後）→ 親の needs_input。承認のタスクを作る", () => {
    const f = withSubs([parent()], [sub({ start: at("10:03"), last: at("10:10") })], {
      hooks: [hook("Stop", at("10:05")), hook("PermissionRequest", at("10:10"), { agentId: "a1" })],
    });
    const now = at("10:12");
    const st = status(f, now);
    expect(st).toEqual({
      status: "needs_input",
      reason: "hook:permission_request",
      estimated: false,
    });
    expect(desiredFollowUps(f, st, now, SETTINGS, TIMING).map((x) => x.kind)).toEqual(["approve"]);
    expect(sessionWaitOf(f, st, now, SETTINGS, TIMING)).toMatchObject({ kind: "permission" });
  });

  test("親の Stop（許可待ちの後）ではサブエージェントの許可待ちを閉じない", () => {
    const f = withSubs([parent()], [sub({ start: at("10:03"), last: at("10:04") })], {
      hooks: [hook("PermissionRequest", at("10:04"), { agentId: "a1" }), hook("Stop", at("10:05"))],
    });
    expect(status(f, at("10:20")).status).toBe("needs_input");
  });

  test("サブエージェントのトランスクリプトに後の活動 → 許可待ちが閉じて running に戻る。承認のタスクも閉じる", () => {
    const hooks = [hook("PermissionRequest", at("10:10"), { agentId: "a1" })];
    const f = withSubs([parent()], [sub({ start: at("10:03"), last: at("10:11") })], { hooks });
    const now = at("10:12");
    const st = status(f, now);
    expect(st).toEqual({ status: "running", reason: "subagent:running", estimated: true });
    const approve = followUp({ kind: "approve", triggerAt: at("10:10"), triggerTurnId: "p1" });
    const actions = reconcileFollowUps(
      { ...f, followUps: [approve] },
      desiredFollowUps(f, st, now, SETTINGS, TIMING),
      now,
      SETTINGS,
    );
    expect(actions).toContainEqual(expect.objectContaining({ type: "close", id: approve.id }));
  });

  test("agentId の無い許可の通知（古い spool）でも、親のターンが閉じた後でサブエージェントが動いていれば親の needs_input", () => {
    const f = withSubs([parent()], [sub({ start: at("10:03"), last: at("10:10") })], {
      hooks: [
        hook("Stop", at("10:05")),
        hook("Notification", at("10:10"), { notificationType: "permission_prompt" }),
      ],
    });
    expect(status(f, at("10:12"))).toEqual({
      status: "needs_input",
      reason: "hook:notification:permission_prompt",
      estimated: false,
    });
    // サブエージェントが無ければ、閉じたターンの後の通知は従来どおり見ない
    expect(status(withSubs([parent()], [], { hooks: f.hooks }), at("10:12")).status).toBe(
      "your_turn",
    );
  });

  test("前景のサブエージェントの許可（親のターンが開いている）も、サブエージェントの活動で閉じる", () => {
    const open = turn({ id: "p1", start: at("10:00"), end: null });
    const base = {
      turns: [open],
      sessions: [session({ lastActivityAt: at("10:01") })],
      hooks: [
        hook("PermissionRequest", at("10:05"), { agentId: "a1" }),
        hook("Notification", at("10:05") + 6000, { notificationType: "permission_prompt" }),
      ],
    };
    const waiting = facts({ ...base, subagents: [sub({ start: at("10:01"), last: at("10:05") })] });
    expect(status(waiting, at("10:06")).status).toBe("needs_input");
    const resumed = facts({ ...base, subagents: [sub({ start: at("10:01"), last: at("10:07") })] });
    expect(status(resumed, at("10:08"))).toEqual({
      status: "running",
      reason: "subagent:running",
      estimated: true,
    });
  });
});

describe("待ち・時間（二重に数えない）", () => {
  test("待ち（your_turn）はサブエージェントと再開したターンが終わってから。動いている間は待ちを作らない", () => {
    const running = withSubs([parent()], [sub({ start: at("10:03"), last: at("10:12") })]);
    expect(waitIntervals(running, at("10:14"), SETTINGS, TIMING)).toEqual([]);
    const resumed = turn({
      id: "p2",
      start: at("10:20") + 10_000,
      end: at("10:22"),
      initiator: "system",
    });
    const done = withSubs(
      [parent(), resumed],
      [sub({ start: at("10:03"), last: at("10:20"), endedAt: at("10:20") })],
    );
    const iv = waitIntervals(done, at("10:30"), SETTINGS, TIMING);
    expect(iv.map((x) => [x.waitKey, x.start, x.isOpen])).toEqual([["turn:p1", at("10:22"), true]]);
    // サブエージェントが無ければ従来どおり親のターンの終わりから
    expect(
      waitIntervals(withSubs([parent(), resumed], []), at("10:30"), SETTINGS, TIMING)[0]?.start,
    ).toBe(at("10:05"));
  });

  test("サブエージェントの許可待ちの区間は、サブエージェントの次の活動まで", () => {
    const f = withSubs([parent()], [sub({ start: at("10:03"), last: at("10:13") })], {
      hooks: [hook("Stop", at("10:05")), hook("PermissionRequest", at("10:10"), { agentId: "a1" })],
    });
    const iv = waitIntervals(f, at("10:14"), SETTINGS, TIMING).filter((x) =>
      x.waitKey.startsWith("hook:"),
    );
    expect(iv.map((x) => [x.start, x.end, x.isOpen])).toEqual([[at("10:10"), at("10:13"), false]]);
  });

  test("サブエージェントだけが動いていた時間は、親のターンの区間を除いて 1 回だけ（並列は和集合）", () => {
    const turns: [number, number][] = [
      [at("10:00"), at("10:05")],
      [at("10:20"), at("10:22")],
    ];
    const subs: [number, number][] = [
      [at("10:03"), at("10:20")],
      [at("10:04"), at("10:15")],
    ];
    expect(subagentOnlyRanges(turns, subs)).toEqual([[at("10:05"), at("10:20")]]);
    // 親のターンの中で終わったサブエージェント（前景）は足さない
    expect(subagentOnlyRanges([[at("10:00"), at("10:30")]], subs)).toEqual([]);
    // 動いているサブエージェントは now まで、それ以外は終わった時刻（無ければ最後の活動）まで
    const s = { startedAt: at("10:03"), lastActivityAt: at("10:10"), endedAt: null };
    expect(subagentInterval(s, true, at("10:12"))).toEqual([at("10:03"), at("10:12")]);
    expect(subagentInterval(s, false, at("10:12"))).toEqual([at("10:03"), at("10:10")]);
    expect(MIN).toBe(60_000);
  });
});

describe("権限のモード（permission_mode）", () => {
  test("bypassPermissions の PermissionRequest と permission_prompt は待ちにしない（状態・承認のタスク・待ち区間のどれにも出ない）", () => {
    const open = turn({ id: "p1", start: at("10:00"), end: null });
    const f = facts({
      turns: [open],
      sessions: [session({ lastActivityAt: at("10:01") })],
      hooks: [
        hook("PermissionRequest", at("10:01"), { permissionMode: "bypassPermissions" }),
        hook("PermissionRequest", at("10:02"), {
          agentId: "a1",
          permissionMode: "bypassPermissions",
        }),
        // Notification は permission_mode を持たない: 前の hook のモードを引き継ぐ
        hook("Notification", at("10:02") + 6000, { notificationType: "permission_prompt" }),
      ],
      subagents: [sub({ start: at("10:01"), last: at("10:02") })],
    });
    const now = at("10:03");
    const st = status(f, now);
    expect(st.status).toBe("running");
    expect(
      desiredFollowUps(f, st, now, SETTINGS, TIMING).filter((x) => x.kind === "approve"),
    ).toEqual([]);
    expect(
      waitIntervals(f, now, SETTINGS, TIMING).filter((x) => x.waitKey.startsWith("hook:")),
    ).toEqual([]);
  });

  test("auto: サブエージェントの許可の 3 秒後にサブエージェントの活動があれば閉じる", () => {
    const h = hook("PermissionRequest", at("10:10"), { agentId: "a1", permissionMode: "auto" });
    const f = withSubs([parent()], [sub({ start: at("10:03"), last: at("10:10") + 3000 })], {
      hooks: [hook("Stop", at("10:05")), h],
    });
    const now = at("10:10") + 4000;
    expect(status(f, now)).toEqual({
      status: "running",
      reason: "subagent:running",
      estimated: true,
    });
    const iv = waitIntervals(f, now, SETTINGS, TIMING).filter((x) => x.waitKey.startsWith("hook:"));
    expect(iv.map((x) => [x.start, x.end, x.isOpen])).toEqual([
      [at("10:10"), at("10:10") + 3000, false],
    ]);
  });
});
