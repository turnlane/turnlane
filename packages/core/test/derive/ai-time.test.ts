/** AI の時間（D-052 (4)）: 終わっていないターンを 0 にしない */
import { describe, expect, test } from "bun:test";
import {
  openTurnHookEnd,
  openTurnStopEnd,
  type TurnTimeInput,
  turnAiInterval,
  turnAiMs,
} from "../../src/derive/ai-time.ts";

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 2, 3, 58); // 12:58 JST
const open = (p: Partial<TurnTimeInput> = {}): TurnTimeInput => ({
  startedAt: T0,
  endedAt: null,
  durationMs: null,
  status: "running",
  sessionLastActivityAt: T0,
  ...p,
});

describe("turnAiMs", () => {
  test.each([
    {
      name: "終わったターンは duration_ms",
      t: open({ status: "completed", endedAt: T0 + 40 * MIN, durationMs: 38 * MIN }),
      c: { status: "done", openWaitStart: null, now: T0 + 6 * 60 * MIN },
      ms: 38 * MIN,
    },
    {
      name: "duration_ms が無い終わったターンは ended_at − started_at",
      t: open({ status: "interrupted", endedAt: T0 + 7 * MIN }),
      c: { status: "your_turn", openWaitStart: null, now: T0 + 60 * MIN },
      ms: 7 * MIN,
    },
    {
      name: "実行中のカードは now まで",
      t: open({ sessionLastActivityAt: T0 + 2 * MIN }),
      c: { status: "running", openWaitStart: null, now: T0 + 22 * MIN },
      ms: 22 * MIN,
    },
    {
      name: "許可待ち（hooks）は待ちの始まりまで（最後の活動より後でも）",
      t: open({ sessionLastActivityAt: T0 }),
      c: { status: "needs_input", openWaitStart: T0 + 5 * MIN, now: T0 + 6 * 60 * MIN },
      ms: 5 * MIN,
    },
    {
      name: "AskUserQuestion で止まっているものは質問の時刻まで",
      t: open({ sessionLastActivityAt: T0 + 4 * MIN }),
      c: { status: "needs_input", openWaitStart: T0 + 4 * MIN, now: T0 + 6 * 60 * MIN },
      ms: 4 * MIN,
    },
    {
      name: "待ちがターンより前のものしか無ければ最後の活動まで",
      t: open({ sessionLastActivityAt: T0 + 3 * MIN }),
      c: { status: "needs_input", openWaitStart: T0 - 10 * MIN, now: T0 + 60 * MIN },
      ms: 3 * MIN,
    },
    {
      name: "止まって見える（running でない）開いたターンは最後の活動まで、now を超えない",
      t: open({ sessionLastActivityAt: T0 + 90 * MIN }),
      c: { status: "your_turn", openWaitStart: null, now: T0 + 30 * MIN },
      ms: 30 * MIN,
    },
    {
      name: "最後の活動が始まりより前でも負にならない",
      t: open({ sessionLastActivityAt: T0 - MIN }),
      c: { status: "your_turn", openWaitStart: null, now: T0 + 30 * MIN },
      ms: 0,
    },
  ])("$name", ({ t, c, ms }) => {
    expect(turnAiMs(t, c)).toBe(ms);
  });

  test("区間は始まりから数える", () => {
    expect(
      turnAiInterval(open(), {
        status: "needs_input",
        openWaitStart: T0 + 5 * MIN,
        now: T0 + 60 * MIN,
      }),
    ).toEqual([T0, T0 + 5 * MIN]);
  });
});

describe("openTurnHookEnd（hook で終わったとみなす終わっていないターン）", () => {
  const S = 1_000_000_000;
  const sec = 1000;
  const h = (
    name: string,
    at: number,
    p: { notificationType?: string; agentId?: string } = {},
  ) => ({
    name,
    occurredAt: S + at * sec,
    ...p,
  });
  const turn = (p: { next?: number; last?: number | null } = {}) => ({
    startedAt: S,
    nextStartedAt: p.next === undefined ? null : S + p.next * sec,
    sessionLastActivityAt:
      p.last === undefined ? S - 60 * sec : p.last === null ? null : S + p.last * sec,
  });

  test("StopFailure の後に活動が無い: その時刻で終わり（同じ秒に開いて AI の記録が無いターン）", () => {
    expect(
      openTurnHookEnd(turn(), [
        h("StopFailure", 0),
        h("Notification", 60, { notificationType: "idle_prompt" }),
      ]),
    ).toBe(S);
  });

  test("Stop の後に活動が無い（トランスクリプトの取り込みが遅れている）: その時刻で終わり", () => {
    expect(openTurnHookEnd(turn(), [h("UserPromptSubmit", 0), h("Stop", 10)])).toBe(S + 10 * sec);
    expect(openTurnStopEnd(turn(), [h("UserPromptSubmit", 0), h("Stop", 10)])).toBe(S + 10 * sec);
    // Stop の後に活動がある（続いた）・サブエージェントの Stop は終わりにしない
    expect(openTurnHookEnd(turn({ last: 20 }), [h("Stop", 10)])).toBeNull();
    expect(openTurnHookEnd(turn(), [h("Stop", 10, { agentId: "a1" })])).toBeNull();
    // openTurnStopEnd は Stop だけを見る（StopFailure・idle_prompt は状態の判定に使わない）
    expect(openTurnStopEnd(turn(), [h("StopFailure", 10)])).toBeNull();
    expect(
      openTurnStopEnd(turn(), [h("Notification", 60, { notificationType: "idle_prompt" })]),
    ).toBeNull();
  });

  test("StopFailure の後に活動がある（続いた）: 終わりにしない", () => {
    expect(openTurnHookEnd(turn({ last: 120 }), [h("StopFailure", 30)])).toBeNull();
  });

  test("idle_prompt: 応答を終えた最後の活動で終わり（hook の時刻より前）", () => {
    expect(
      openTurnHookEnd(turn({ last: 40 }), [
        h("Notification", 100, { notificationType: "idle_prompt" }),
      ]),
    ).toBe(S + 40 * sec);
  });

  test("その後に UserPromptSubmit・quota_auto_resume_fired があれば終わりにしない", () => {
    expect(openTurnHookEnd(turn(), [h("StopFailure", 10), h("UserPromptSubmit", 20)])).toBeNull();
    expect(
      openTurnHookEnd(turn(), [
        h("StopFailure", 10),
        h("Notification", 20, { notificationType: "quota_auto_resume_fired" }),
      ]),
    ).toBeNull();
  });

  test("ほかの通知（permission_prompt）・サブエージェントの hook・次のターンの後の hook では終わりにしない", () => {
    expect(
      openTurnHookEnd(turn(), [h("Notification", 10, { notificationType: "permission_prompt" })]),
    ).toBeNull();
    expect(openTurnHookEnd(turn(), [h("StopFailure", 10, { agentId: "a1" })])).toBeNull();
    expect(openTurnHookEnd(turn({ next: 5 }), [h("StopFailure", 10)])).toBeNull();
  });
});
