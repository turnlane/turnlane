/**
 * Stop の hook でターンを終える（トランスクリプトの取り込みが hook より遅れる間）。Codex の rollout は Stop の hook より
 * 1 分近く遅れて取り込まれることがある。その間「実行中」のまま残さず、自分の番（理由 hook:stop）にし、追いついたら
 * 同じ待ちのまま問いなどに置き換える。返答タスク（通知の元）は 1 件だけ
 */
import { describe, expect, test } from "bun:test";
import {
  deriveStatus,
  desiredFollowUps,
  type FollowUpFact,
  reconcileFollowUps,
  sessionWaitOf,
  type TurnFact,
  type WorkItemFacts,
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

const SEC = 1000;
const status = (f: WorkItemFacts, now: number) => {
  const a = deriveStatus(f, now, SETTINGS, TIMING);
  expect(deriveStatus(shuffled(f), now, SETTINGS, TIMING)).toEqual(a);
  return a;
};

for (const tool of ["codex", "claude_code"] as const) {
  describe(`Stop の hook の後にトランスクリプトが 60 秒遅れて来る（${tool}）`, () => {
    const start = at("10:00");
    const stopAt = start + 10 * SEC;
    const caughtUp = stopAt + 60 * SEC;
    const h = (name: string, t: number, p = {}) => hook(name, t, { tool, ...p });
    const hooks = [h("UserPromptSubmit", start), h("Stop", stopAt)];
    // 取り込み前: ターンは開いたまま（トランスクリプトの最後の活動は始まりの 2 秒後）
    const open = turn({ id: "t-open", start, end: null });
    const before = (extra: Partial<WorkItemFacts> = {}) =>
      facts({
        turns: [open],
        sessions: [session({ tool, lastActivityAt: start + 2 * SEC })],
        hooks,
        ...extra,
      });
    // 取り込み後: 同じターンが問いで終わった
    const done: TurnFact = {
      ...open,
      endedAt: stopAt - SEC,
      durationMs: stopAt - SEC - start,
      status: "completed",
      endedWith: "question",
    };
    const after = (extra: Partial<WorkItemFacts> = {}) =>
      facts({
        turns: [done],
        sessions: [session({ tool, lastActivityAt: stopAt - SEC })],
        hooks,
        ...extra,
      });

    test("Stop の前は実行中、Stop の時点で実行中が切れて自分の番（hook:stop）", () => {
      const running = facts({
        turns: [open],
        sessions: [session({ tool, lastActivityAt: start + 2 * SEC })],
        hooks: [h("UserPromptSubmit", start)],
      });
      expect(status(running, stopAt - SEC).status).toBe("running");
      expect(status(before(), stopAt + SEC)).toEqual({
        status: "your_turn",
        reason: "hook:stop",
        estimated: true,
      });
      // 答える口（セッションの待ち）も Stop の時点で開く
      const f = before();
      expect(sessionWaitOf(f, status(f, stopAt + SEC), stopAt + SEC, SETTINGS, TIMING)).toEqual({
        kind: "question",
        turnId: open.id,
        sessionId: "s1",
      });
    });

    test("追いついたら同じ待ちのまま問い（question）に置き換わる", () => {
      expect(status(after(), caughtUp).reason).toBe("question");
      expect(status(after(), caughtUp).status).toBe("your_turn");
    });

    test("返答タスク（通知の元）は 1 件だけ: 1 分ごとに判定して、追いついた時点で作り直さない", () => {
      let fus: FollowUpFact[] = [];
      let created = 0;
      for (let now = stopAt; now <= stopAt + 30 * MIN; now += 30 * SEC) {
        const f = now < caughtUp ? before({ followUps: fus }) : after({ followUps: fus });
        const st = deriveStatus(f, now, SETTINGS, TIMING);
        expect(st.status).toBe("your_turn");
        const actions = reconcileFollowUps(
          f,
          desiredFollowUps(f, st, now, SETTINGS, TIMING),
          now,
          SETTINGS,
        );
        for (const a of actions) {
          if (a.type === "create") {
            created++;
            fus = [
              ...fus,
              followUp({
                kind: a.spec.kind,
                triggerAt: a.spec.triggerAt,
                triggerTurnId: a.spec.triggerTurnId,
                artifactRef: a.spec.artifactRef,
                dedupeKey: a.spec.dedupeKey,
              }),
            ];
          } else expect(a.type).not.toBe("close");
        }
      }
      expect(created).toBe(1);
      expect(fus[0]).toMatchObject({ kind: "reply", triggerTurnId: open.id });
    });

    test("追いつくのが猶予（15 分）より遅くても、Stop で作った返答タスクを問いのものとしてそのまま使う", () => {
      const now = stopAt + 16 * MIN;
      const f = before();
      const d = desiredFollowUps(f, status(f, now), now, SETTINGS, TIMING);
      expect(d.map((x) => [x.kind, x.artifactRef, x.triggerAt])).toEqual([
        ["reply", open.id, stopAt],
      ]);
      const fu = followUp({
        kind: "reply",
        triggerAt: stopAt,
        triggerTurnId: open.id,
        artifactRef: open.id,
        dedupeKey: d[0]?.dedupeKey as string,
      });
      const g = after({ followUps: [fu] });
      const later = now + MIN;
      expect(
        reconcileFollowUps(
          g,
          desiredFollowUps(g, status(g, later), later, SETTINGS, TIMING),
          later,
          SETTINGS,
        ),
      ).toEqual([]);
    });

    test("猶予（15 分）の前は返答タスクを作らない", () => {
      const now = stopAt + 14 * MIN;
      const f = before();
      expect(desiredFollowUps(f, status(f, now), now, SETTINGS, TIMING)).toEqual([]);
    });

    test("サブエージェントの Stop（agentId 付き）は親の終わりにしない", () => {
      const f = facts({
        turns: [open],
        sessions: [session({ tool, lastActivityAt: start + 2 * SEC })],
        hooks: [h("UserPromptSubmit", start), h("Stop", stopAt, { agentId: "agent-1" })],
      });
      expect(status(f, stopAt + SEC).status).toBe("running");
    });

    test("Stop の後にトランスクリプトの活動がある（続いた）・新しい入力がある → 実行中のまま", () => {
      const cont = before({ sessions: [session({ tool, lastActivityAt: stopAt + 5 * SEC })] });
      expect(status(cont, stopAt + 6 * SEC).status).toBe("running");
      const again = before({ hooks: [...hooks, h("UserPromptSubmit", stopAt + 3 * SEC)] });
      expect(status(again, stopAt + 4 * SEC)).toMatchObject({
        status: "running",
        reason: "hook:user_prompt_submit",
      });
    });
  });
}

describe("Stop の hook とプロセスの状態（sessions/<pid>.json）", () => {
  const start = at("10:00");
  const stopAt = start + 10 * SEC;
  const f = (liveCheckedAt: number) =>
    facts({
      turns: [turn({ start, end: null })],
      sessions: [session({ lastActivityAt: start + 2 * SEC, liveStatus: "busy", liveCheckedAt })],
      hooks: [hook("UserPromptSubmit", start), hook("Stop", stopAt)],
    });

  test("Stop より前に見た busy は使わない（自分の番）", () => {
    expect(status(f(start + 5 * SEC), stopAt + 20 * SEC).reason).toBe("hook:stop");
  });

  test("Stop より後に見た busy はまだ動いている（実行中）", () => {
    expect(status(f(stopAt + 15 * SEC), stopAt + 20 * SEC)).toMatchObject({
      status: "running",
      reason: "live:busy",
    });
  });
});
