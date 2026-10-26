/**
 * 利用枠の停止の手がかり（StopFailure のエラーの種類 error と、Notification の quota_auto_resume_*）の表駆動テスト。
 * 合成データの項目名は公式の hooks の入力（StopFailure の error、Notification の notification_type）に合わせる
 * （HookFact では errorType・notificationType）。
 * - quota_auto_resume_fired: 最後の停止の後なら止まっていない（Claude Code が続けた）。再開のタスクを作らない
 * - quota_auto_resume_disabled: 上限待ち（until はリセットの時刻か停止から 5 時間）
 * - quota_auto_resume_stale: いま再開できる（すぐに「再開できる」）
 * - 種類の無い StopFailure（古い記録）: 同じターンの窓に quota の通知があれば利用枠。同じセッションの先の上限待ちの
 *   until より前なら、その続き。種類が rate_limit 以外と分かるものはエラー
 * - 再試行の嵐（StopFailure が何百件）でも、再開のタスク（＝通知）は 1 回の停止につき 1 件
 */
import { describe, expect, test } from "bun:test";
import {
  deriveStatus,
  desiredFollowUps,
  type FollowUpFact,
  type HookFact,
  LIMIT_REF_SUFFIX,
  limitWaitOf,
  reconcileFollowUps,
  type TurnFact,
  turnStopOf,
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
const H = 60 * MIN;

const status = (f: WorkItemFacts, now: number) => {
  const a = deriveStatus(f, now, SETTINGS, TIMING);
  expect(deriveStatus(shuffled(f), now, SETTINGS, TIMING)).toEqual(a);
  return a;
};

const desired = (f: WorkItemFacts, now: number) =>
  desiredFollowUps(f, status(f, now), now, SETTINGS, TIMING);

/** StopFailure（公式の error の項目。省略すると種類の無い古い記録） */
const failure = (occurredAt: number, error?: string) =>
  hook("StopFailure", occurredAt, error ? { errorType: error } : {});
const notice = (type: string, occurredAt: number) =>
  hook("Notification", occurredAt, { notificationType: type });

/** from から to まで step ごとの StopFailure（Claude Code の再試行） */
function storm(from: number, to: number, step: number, error?: string): HookFact[] {
  const out: HookFact[] = [];
  for (let x = from; x <= to; x += step) out.push(failure(x, error));
  return out;
}

/**
 * 利用枠で止まったセッション（実際に起きた並びを時刻だけ変えたもの）:
 * 10:00 に始まった親のターン A が 10:05 から StopFailure を出し続け、13:41 に fired と UserPromptSubmit（自動の再開）、
 * 13:42 に disabled、その後も StopFailure が 14:01:44 まで続く。14:01:44 にシステム起点のターン C が開き、同じ秒に
 * StopFailure（C には AI の記録が無い）。14:02:44 に idle_prompt
 */
function quotaStorm(error?: string, disabled: Partial<HookFact> = {}) {
  const a = turn({
    start: at("10:00"),
    end: at("13:42"),
    status: "error",
    endedWith: "error",
  });
  const c = turn({ start: at("14:01") + 44 * SEC, end: null, initiator: "system" });
  const hooks = [
    hook("UserPromptSubmit", at("10:00")),
    ...storm(at("10:05"), at("13:40"), 30 * SEC, error),
    notice("quota_auto_resume_fired", at("13:41")),
    hook("UserPromptSubmit", at("13:41")),
    failure(at("13:41") + 30 * SEC, error),
    { ...notice("quota_auto_resume_disabled", at("13:42")), ...disabled },
    ...storm(at("13:42") + 30 * SEC, at("14:01") + 30 * SEC, 30 * SEC, error),
    failure(at("14:01") + 44 * SEC, error),
    notice("idle_prompt", at("14:02") + 44 * SEC),
  ];
  const f = facts({
    turns: [a, c],
    sessions: [session({ lastActivityAt: at("13:42") })],
    hooks,
  });
  return { a, c, f };
}

describe("quota_auto_resume_* の通知", () => {
  test("種類の無い StopFailure ＋ fired・disabled（古い記録）: 利用枠。止まった時刻は自動の再開の後の最初の停止", () => {
    const { a, c, f } = quotaStorm();
    expect(f.hooks.filter((h) => h.name === "StopFailure").length).toBeGreaterThan(400);
    const s = f.sessions[0] as never;
    // A は自動の再開（13:41）の後にまた止まった（disabled）。上限待ちで、明けるのは 13:41:30 から 5 時間
    expect(turnStopOf(f, s, a)).toMatchObject({
      kind: "limit",
      turnId: a.id,
      at: at("13:41") + 30 * SEC,
      until: at("13:41") + 30 * SEC + 5 * H,
      reason: "rate_limit",
      estimated: true,
    });
    // C の種類の無い StopFailure は A の上限待ちの続き（別のエラーにしない）
    expect(turnStopOf(f, s, c)).toEqual(turnStopOf(f, s, a));
    expect(status(f, at("15:00"))).toEqual({
      status: "done",
      reason: "rate_limit",
      estimated: false,
    });
    expect(desired(f, at("15:00"))).toEqual([]);
  });

  test("公式の error（rate_limit）の嵐でも同じ（推定ではない）", () => {
    const { a, f } = quotaStorm("rate_limit");
    expect(limitWaitOf(f, at("15:00"))).toMatchObject({
      turnId: a.id,
      at: at("13:41") + 30 * SEC,
      estimated: false,
    });
  });

  test("最後の停止の後の fired: 止まっていない（ターンは UserPromptSubmit で実行中）。再開のタスクを作らない", () => {
    const t = turn({ start: at("10:00"), end: null });
    const f = facts({
      turns: [t],
      sessions: [session({ lastActivityAt: at("12:01") })],
      hooks: [
        hook("UserPromptSubmit", at("10:00")),
        ...storm(at("10:05"), at("11:59"), MIN, "rate_limit"),
        notice("quota_auto_resume_fired", at("12:00")),
        hook("UserPromptSubmit", at("12:00")),
      ],
    });
    expect(turnStopOf(f, f.sessions[0] as never, t)).toBeNull();
    expect(limitWaitOf(f, at("12:02"))).toBeNull();
    expect(status(f, at("12:02"))).toEqual({
      status: "running",
      reason: "hook:user_prompt_submit",
      estimated: false,
    });
    expect(desired(f, at("18:00")).filter((x) => x.kind === "resume_error")).toEqual([]);
  });

  test("エラーで終わったターンの後の fired（次のターンがまだ取り込まれていない）も止まっていない", () => {
    const t = turn({ start: at("10:00"), end: at("10:20"), status: "error", endedWith: "error" });
    const f = facts({
      turns: [t],
      sessions: [session({ lastActivityAt: at("10:20") })],
      hooks: [failure(at("10:20")), notice("quota_auto_resume_fired", at("12:00"))],
    });
    expect(turnStopOf(f, f.sessions[0] as never, t)).toBeNull();
    expect(desired(f, at("12:01"))).toEqual([]);
  });

  test("disabled（StopFailure が無くても）: 上限待ち。明けたら「再開できる」を 1 件", () => {
    const t = turn({ start: at("10:00"), end: null });
    const f = facts({
      turns: [t],
      sessions: [session({ lastActivityAt: at("10:10") })],
      hooks: [
        hook("UserPromptSubmit", at("10:00")),
        notice("quota_auto_resume_disabled", at("10:20")),
      ],
    });
    expect(limitWaitOf(f, at("11:00"))).toMatchObject({
      at: at("10:20"),
      until: at("15:20"),
      untilKnown: false,
    });
    expect(desired(f, at("11:00"))).toEqual([]);
    expect(desired(f, at("15:21")).map((x) => x.artifactRef)).toEqual([
      `${t.id}${LIMIT_REF_SUFFIX}`,
    ]);
  });

  test("stale: いま ⏎ で再開できる。上限待ちにせず、すぐに「再開できる」（trigger はその時刻）", () => {
    const t = turn({ start: at("10:00"), end: null });
    const f = facts({
      turns: [t],
      sessions: [session({ lastActivityAt: at("10:20") })],
      hooks: [
        hook("UserPromptSubmit", at("10:00")),
        failure(at("10:20"), "rate_limit"),
        notice("quota_auto_resume_stale", at("12:30")),
      ],
    });
    const now = at("12:31");
    expect(limitWaitOf(f, now)).toBeNull();
    expect(turnStopOf(f, f.sessions[0] as never, t)).toMatchObject({
      kind: "limit",
      until: at("12:30"),
      untilKnown: true,
    });
    expect(desired(f, now)).toEqual([
      {
        kind: "resume_error",
        artifactRef: `${t.id}${LIMIT_REF_SUFFIX}`,
        dedupeKey: `wi|resume_error|${t.id}${LIMIT_REF_SUFFIX}`,
        triggerAt: at("12:30"),
        triggerTurnId: t.id,
      },
    ]);
  });
});

describe("種類の無い StopFailure（古い記録・古い Claude Code）", () => {
  test("quota の通知も先の上限待ちも無ければ、今までどおりエラー", () => {
    const t = turn({ start: at("10:00"), end: at("10:20"), status: "error", endedWith: "error" });
    const f = facts({
      turns: [t],
      sessions: [session({ lastActivityAt: at("10:20") })],
      hooks: [failure(at("10:20"))],
    });
    expect(status(f, at("10:30"))).toEqual({
      status: "error",
      reason: "hook:stop_failure",
      estimated: false,
    });
  });

  test("先の上限待ちの until を過ぎた種類の無い停止は、別のエラー", () => {
    const { a, f: base } = quotaStorm();
    const late = turn({ start: at("20:00"), end: null });
    const f = facts({
      turns: [a, late],
      sessions: [session({ lastActivityAt: at("13:42") })],
      hooks: [...base.hooks, hook("UserPromptSubmit", at("20:00")), failure(at("20:01"))],
    });
    expect(turnStopOf(f, f.sessions[0] as never, late)).toMatchObject({
      kind: "error",
      turnId: late.id,
    });
  });

  test("種類が rate_limit 以外と分かる停止は、上限待ちの最中でもエラー", () => {
    const { a, f: base } = quotaStorm();
    const next = turn({ start: at("15:00"), end: null });
    const f = facts({
      turns: [a, next],
      sessions: [session({ lastActivityAt: at("13:42") })],
      hooks: [...base.hooks, failure(at("15:01"), "authentication_failed")],
    });
    expect(turnStopOf(f, f.sessions[0] as never, next)).toMatchObject({
      kind: "error",
      reason: "hook:stop_failure",
    });
  });

  test("間に正常に終わったターンがあれば、前の上限待ちの続きにしない", () => {
    const { a, f: base } = quotaStorm();
    const ok = turn({ start: at("14:30"), end: at("14:35") });
    const next = turn({ start: at("14:40"), end: null });
    const f = facts({
      turns: [a, ok, next],
      sessions: [session({ lastActivityAt: at("14:40") })],
      hooks: [...base.hooks.filter((h) => h.occurredAt < at("14:01")), failure(at("14:41"))],
    });
    expect(turnStopOf(f, f.sessions[0] as never, next)).toMatchObject({
      kind: "error",
      turnId: next.id,
    });
  });
});

describe("利用枠の停止の通知は 1 回だけ", () => {
  /** hooks が届くのに合わせて 5 分ごとに derive を回し、作られた再開のタスク（＝通知の元）を数える */
  function simulate(all: { turns: TurnFact[]; hooks: HookFact[] }, from: number, to: number) {
    let fus: FollowUpFact[] = [];
    const created: string[] = [];
    for (let now = from; now <= to; now += 5 * MIN) {
      const turns = all.turns
        .filter((t) => t.startedAt <= now)
        .map((t) =>
          t.endedAt !== null && t.endedAt > now
            ? { ...t, endedAt: null, durationMs: null, status: "running" as const }
            : t,
        );
      const f = facts({
        turns,
        sessions: [session({ lastActivityAt: Math.min(now, at("13:42")) })],
        hooks: all.hooks.filter((h) => h.occurredAt <= now),
        followUps: fus,
      });
      for (const a of reconcileFollowUps(f, desired(f, now), now, SETTINGS)) {
        if (a.type === "create") {
          created.push(a.spec.dedupeKey);
          fus = [...fus, followUp({ ...a.spec, status: "open" })];
        } else if (a.type === "close") {
          fus = fus.map((x) =>
            x.id === a.id ? { ...x, status: a.status, closedAt: a.at, closeReason: a.reason } : x,
          );
        }
      }
    }
    return created;
  }

  test("公式の error（rate_limit）の StopFailure が何百件続いても、「再開できる」は 1 件だけ", () => {
    const { a, c, f } = quotaStorm("rate_limit");
    const created = simulate({ turns: [a, c], hooks: f.hooks }, at("10:00"), at("21:00"));
    expect(created).toEqual([`wi|resume_error|${a.id}${LIMIT_REF_SUFFIX}`]);
  });

  test("自動の再開の後に止まったターンが新しく開いても、明ける時刻とタスクは最初の停止のもの", () => {
    const t = turn({ start: at("10:00"), end: at("10:30"), status: "error", endedWith: "error" });
    const next = turn({ start: at("11:00"), end: null, initiator: "system" });
    const hooks = [
      hook("UserPromptSubmit", at("10:00")),
      ...storm(at("10:05"), at("10:30"), MIN, "rate_limit"),
      failure(at("11:00"), "rate_limit"),
    ];
    const f = facts({
      turns: [t, next],
      sessions: [session({ lastActivityAt: at("10:30") })],
      hooks,
    });
    expect(limitWaitOf(f, at("12:00"))).toMatchObject({
      turnId: t.id,
      at: at("10:05"),
      until: at("15:05"),
    });
    const created = simulate({ turns: [t, next], hooks }, at("10:00"), at("17:00"));
    expect(created).toEqual([`wi|resume_error|${t.id}${LIMIT_REF_SUFFIX}`]);
  });
});

describe("quota_auto_resume_disabled の「明けるのが 24 時間より先」（horizon。週の上限など）", () => {
  const ACCOUNT = "/fixture/config-a";
  const stopAt = at("13:41") + 30 * SEC;

  test("定型文あり: 明ける時刻が分からなければ停止から 24 時間（untilKnown: false）。定型文なしは 5 時間のまま", () => {
    const yes = quotaStorm(undefined, { horizon: true });
    const s = yes.f.sessions[0] as never;
    expect(turnStopOf(yes.f, s, yes.a)).toMatchObject({
      kind: "limit",
      at: stopAt,
      until: stopAt + 24 * H,
      untilKnown: false,
    });
    const no = quotaStorm();
    expect(turnStopOf(no.f, no.f.sessions[0] as never, no.a)).toMatchObject({
      until: stopAt + 5 * H,
      untilKnown: false,
    });
    // 5 時間を過ぎても上限待ちのまま（「再開できる」にしない）
    expect(limitWaitOf(yes.f, stopAt + 6 * H)).toMatchObject({ until: stopAt + 24 * H });
    expect(limitWaitOf(no.f, stopAt + 6 * H)).toBeNull();
    expect(desired(yes.f, stopAt + 6 * H)).toEqual([]);
  });

  test("種類の無い StopFailure を同じ上限待ちの続きにする規則は 24 時間の見込みでも同じ", () => {
    const { a, c, f } = quotaStorm(undefined, { horizon: true });
    const s = f.sessions[0] as never;
    // C（14:01:44 に開いたシステム起点のターン）の種類の無い StopFailure は A の上限待ちの続き
    expect(turnStopOf(f, s, c)).toEqual(turnStopOf(f, s, a));
    expect(limitWaitOf(f, at("20:00"))).toMatchObject({ turnId: a.id, until: stopAt + 24 * H });
    // 明けた後の再開のタスクは 1 件（A のターン）
    expect(desired(f, stopAt + 24 * H + MIN).map((d) => d.dedupeKey)).toEqual([
      `wi|resume_error|${a.id}${LIMIT_REF_SUFFIX}`,
    ]);
  });

  test("利用枠の明ける時刻が取れればそちらが勝つ（7 日の枠を使い切っている → その明け）", () => {
    const { a, f } = quotaStorm(undefined, { horizon: true, configRoot: ACCOUNT });
    const weekly = at("18:00", 2);
    const g: WorkItemFacts = {
      ...f,
      claudeLimits: [
        {
          account: `${ACCOUNT}/`,
          fiveHourPct: 38,
          fiveHourResetsAt: at("15:00"),
          sevenDayPct: 100,
          sevenDayResetsAt: weekly,
        },
      ],
    };
    expect(turnStopOf(g, g.sessions[0] as never, a)).toMatchObject({
      until: weekly,
      untilKnown: true,
    });
  });

  test("horizon の無い disabled（設定で自動再開を切った）は 5 時間のまま", () => {
    const off = quotaStorm(undefined, { horizon: false });
    expect(turnStopOf(off.f, off.f.sessions[0] as never, off.a)?.until).toBe(stopAt + 5 * H);
  });
});
