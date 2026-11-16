/**
 * 図つきの問い（MCP の ask_user。ADR 0022）の判定: 開いている間はカードが回答待ち（needs_input）で、回答待ちの返答タスクが
 * すぐできる。閉じたら（返した・閉じた・打ち切られた・消えた）返答タスクが閉じ、回答待ちから外れる。中身は判定に渡さない
 */
import { describe, expect, test } from "bun:test";
import {
  askUserIdOf,
  askUserRef,
  deriveStatus,
  desiredFollowUps,
  followUpWaitKind,
  isAskReply,
  isAskUserReply,
  reconcileFollowUps,
  sessionWaitOf,
  type WorkItemFacts,
  waitIntervals,
} from "../../src/derive/index.ts";
import {
  aiEnd,
  at,
  facts,
  followUp,
  MIN,
  SETTINGS,
  session,
  shuffled,
  TIMING,
  turn,
} from "./helpers.ts";

const status = (f: WorkItemFacts, now: number) => deriveStatus(f, now, SETTINGS, TIMING);
const desired = (f: WorkItemFacts, now: number) =>
  desiredFollowUps(f, status(f, now), now, SETTINGS, TIMING);

describe("artifact_ref", () => {
  test("ask_user:<id>:ask は AskUserQuestion と同じ回答待ちで、図つきの問いとして見分けられる", () => {
    const ref = askUserRef("a1");
    expect(ref).toBe("ask_user:a1:ask");
    expect(isAskReply({ kind: "reply", artifactRef: ref })).toBe(true);
    expect(isAskUserReply({ kind: "reply", artifactRef: ref })).toBe(true);
    expect(isAskUserReply({ kind: "reply", artifactRef: "t1:ask" })).toBe(false);
    expect(askUserIdOf(ref)).toBe("a1");
    expect(askUserIdOf("t1:ask")).toBeNull();
    // 端末に送って答える待ちではない
    expect(followUpWaitKind("reply", ref)).toBeNull();
    expect(followUpWaitKind("reply", "t1:ask")).toBe("ask");
  });
});

describe("開いている問い", () => {
  // AI のセッションは結果の無いツールの呼び出しで止まっている（ターンは開いたまま）
  const running = turn({ start: at("10:00"), end: null });
  const base = facts({
    turns: [running],
    sessions: [session({ lastActivityAt: at("10:01") })],
  });
  const asked = { ...base, asks: [{ id: "a1", at: at("10:01"), turnId: running.id }] };

  test("カードは回答待ち（実行中より先）。問いが無ければ実行中のまま", () => {
    expect(status(base, at("10:02")).status).toBe("running");
    expect(status(asked, at("10:02"))).toEqual({
      status: "needs_input",
      reason: "ask_user",
      estimated: false,
    });
    expect(status(shuffled(asked), at("10:02")).status).toBe("needs_input");
  });

  test("記録が古くなっても（Claude Code がバックグラウンドに回して待つ）回答待ちのまま", () => {
    expect(status(asked, at("13:00")).status).toBe("needs_input");
  });

  test("エラーだけは問いより先", () => {
    const err = turn({ start: at("10:00"), end: at("10:01"), status: "error" });
    const f = { ...asked, turns: [err] };
    expect(status(f, at("10:02")).status).toBe("error");
  });

  test("回答待ちの返答タスクをすぐ作る（返答タスクの設定がオフでも・プログラム経由のセッションでも）", () => {
    const d = desired(asked, at("10:01"));
    expect(d).toEqual([
      {
        kind: "reply",
        artifactRef: "ask_user:a1:ask",
        dedupeKey: "wi|reply|ask_user:a1:ask",
        triggerAt: at("10:01"),
        triggerTurnId: running.id,
      },
    ]);
    const off = { ...SETTINGS, followUpKinds: { ...SETTINGS.followUpKinds, reply: false } };
    expect(desiredFollowUps(asked, status(asked, at("10:01")), at("10:01"), off, TIMING)).toEqual(
      d,
    );
    const sdk = { ...asked, sessions: [session({ entrypoint: "sdk-ts", lastActivityAt: 0 })] };
    expect(desired(sdk, at("10:01")).map((x) => x.artifactRef)).toEqual(["ask_user:a1:ask"]);
  });

  test("開いている間は、同じカードの問いで終わったターンの返答タスクを重ねない", () => {
    const q = aiEnd(at("09:00"), { endedWith: "question" });
    const f = {
      ...asked,
      turns: [q, running],
      sessions: [session({ lastActivityAt: at("10:01") })],
    };
    const later = { ...f, turns: [running, aiEnd(at("10:05"), { endedWith: "question" })] };
    expect(desired(later, at("11:00")).map((x) => x.artifactRef)).toEqual(["ask_user:a1:ask"]);
  });

  test("端末で答える待ち（セッションの待ち）は出さない", () => {
    const q = aiEnd(at("10:05"), { endedWith: "question" });
    const f = { ...asked, turns: [q] };
    const st = status(f, at("10:30"));
    expect(sessionWaitOf(f, st, at("10:30"), SETTINGS, TIMING)).toBeNull();
    const without = { ...f, asks: [] };
    expect(
      sessionWaitOf(without, status(without, at("10:30")), at("10:30"), SETTINGS, TIMING)?.kind,
    ).toBe("question");
  });

  test("開いている問いの返答タスクは、新しい返答タスクに置き換えない・72 時間で期限切れにしない", () => {
    const fu = followUp({
      kind: "reply",
      triggerAt: at("10:01"),
      artifactRef: "ask_user:a1:ask",
      dedupeKey: "wi|reply|ask_user:a1:ask",
      triggerTurnId: running.id,
    });
    const f = { ...asked, followUps: [fu] };
    const now = at("10:00", 4);
    const acts = reconcileFollowUps(f, desired(f, now), now, SETTINGS);
    expect(acts).toEqual([]);
  });
});

describe("閉じた問い", () => {
  const running = turn({ start: at("10:00"), end: null });
  const fu = followUp({
    kind: "reply",
    triggerAt: at("10:01"),
    artifactRef: "ask_user:a1:ask",
    dedupeKey: "wi|reply|ask_user:a1:ask",
    triggerTurnId: running.id,
  });
  const f = (closures?: WorkItemFacts["askClosures"]): WorkItemFacts => ({
    ...facts({ turns: [running], sessions: [session({ lastActivityAt: at("10:01") })] }),
    followUps: [fu],
    ...(closures ? { askClosures: closures } : {}),
  });
  const close = (x: WorkItemFacts, now: number) =>
    reconcileFollowUps(x, desired(x, now), now, SETTINGS);

  test.each([
    ["answered", "done", "auto:answered"],
    ["dismissed", "superseded", "auto:ask_dismissed"],
    ["cancelled", "superseded", "auto:ask_cancelled"],
  ] as const)("%s → %s（%s）。閉じた時刻は控えの時刻", (how, st, reason) => {
    const x = f(new Map([["a1", { how, at: at("10:20") }]]));
    expect(close(x, at("10:21"))).toEqual([
      { type: "close", id: fu.id, status: st, reason, at: at("10:20") },
    ]);
    expect(status(x, at("10:21")).status).not.toBe("needs_input");
  });

  test("控えが無い（デーモンが再起動して問いが消えた）→ superseded（auto:ask_lost）", () => {
    expect(close(f(), at("11:00"))).toEqual([
      { type: "close", id: fu.id, status: "superseded", reason: "auto:ask_lost", at: at("11:00") },
    ]);
  });

  test("待ちの区間は開いた時刻から閉じた時刻まで（返したら human_input）", () => {
    const done = {
      ...fu,
      status: "done" as const,
      closedAt: at("10:20"),
      closeReason: "auto:answered",
    };
    const x = { ...f(), followUps: [done] };
    const ivs = waitIntervals(x, at("11:00"), SETTINGS).filter((w) => w.followUpId === fu.id);
    expect(ivs).toHaveLength(1);
    expect(ivs[0]).toMatchObject({
      waitKey: `fu:${fu.id}`,
      start: at("10:01"),
      end: at("10:20"),
      isOpen: false,
      endReason: "human_input",
    });
    expect(at("10:20") - at("10:01")).toBe(19 * MIN);
  });
});
