/**
 * phase0-plan 5.5 の在席と待ちのシナリオ（W1〜W32）。在席（Mac を使っていた時間。D-105）はテストの入力で、
 * ops を渡すと論理日ごとに最初〜最後の操作を在席とみなす（helpers.ts の presenceOf。勤務時間で書いたシナリオを写したもの）。TZ=Asia/Tokyo、日付区切り 04:00、猶予15分、返答の期限72時間。
 * 各シナリオは「事実の列と now → 区間（区分・分）と集計」を比べ、同じ事実を逆順に入れても結果が同じことを確かめる
 * （status_log を使わないことの確認。取り込みの遅れ・デーモンの停止で事実の届く順序が変わっても結果は変わらない）。
 * 放置は YOUR TURN にタスクが出ている間だけ数える（D-045 (1)）ので、W1〜W8・W20・W21 は「質問で終了し、返答タスクが
 * 出ている」待ちで書く。タスクの無い待ちは W27。
 */
import { describe, expect, test } from "bun:test";
import { addDays } from "../../src/dates.ts";
import {
  aggregateDays,
  countedResponseMs,
  deriveStatus,
  desiredFollowUps,
  expandPresence,
  isWorkOp,
  NO_SIGNALS,
  PRESENCE_MAX_GAP_MS,
  type PresenceRow,
  type PrevSample,
  presenceStep,
  type ResolutionSignals,
  reconcileFollowUps,
  waitRecomputeFrom,
} from "../../src/derive/index.ts";
import type { TurnFact, WorkItemFacts } from "../../src/derive/types.ts";
import {
  aiEnd,
  at,
  busyEvent,
  compute,
  D,
  facts,
  followUp,
  hook,
  human,
  MIN,
  pr,
  SETTINGS,
  session,
  shuffled,
  TIMING,
  turn,
} from "./helpers.ts";

const D1 = addDays(D, 1);
const D3 = addDays(D, 3);

/** 質問で終わったターンと、その返答タスク（D-045 (1)。closedAt を渡さなければ開いたまま） */
function asked(end: number, p: Partial<TurnFact> = {}, closedAt: number | null = null) {
  const t = aiEnd(end, { endedWith: "question", ...p });
  const reply = followUp({
    kind: "reply",
    triggerAt: end,
    triggerTurnId: t.id,
    ...(closedAt !== null
      ? { status: "done" as const, closedAt, closeReason: "auto:human_input" }
      : {}),
  });
  return { t, reply };
}

/** 同じ事実を逆順に入れても同じ結果になることを確かめつつ集計を返す */
function run(
  f: Parameters<typeof compute>[0],
  now: number,
  input: Parameters<typeof compute>[2] = {},
) {
  const a = compute(f, now, input);
  const b = compute(shuffled(f), now, input);
  expect(b.summary).toEqual(a.summary);
  return a;
}

describe("5.5 在席と待ち", () => {
  test("W1: 操作 9:00、ターン終了（質問・返答タスク）10:00、人間入力 10:10 → 猶予 10分、放置 0", () => {
    const { t, reply } = asked(at("10:00"), {}, at("10:10"));
    const f = facts({ turns: [t, human(at("10:10"))], followUps: [reply] });
    expect(run(f, at("12:00"), { ops: [at("09:00")] }).summary).toEqual({ [D]: { grace: 10 } });
  });

  test("W2: 同上で人間入力 10:40 → 猶予 15分、放置 25分", () => {
    const { t, reply } = asked(at("10:00"), {}, at("10:40"));
    const f = facts({ turns: [t, human(at("10:40"))], followUps: [reply] });
    expect(run(f, at("12:00"), { ops: [at("09:00")] }).summary).toEqual({
      [D]: { grace: 15, idle: 25 },
    });
  });

  test("W3: busy な予定 10:20〜10:50、人間入力 11:00 → 猶予 15、放置 5 + 10、集計外（event）30", () => {
    const { t, reply } = asked(at("10:00"));
    const f = facts({ turns: [t, human(at("11:00"))], followUps: [reply] });
    const r = run(f, at("12:00"), {
      ops: [at("09:00")],
      events: [busyEvent(at("10:20"), at("10:50"))],
    });
    expect(r.summary).toEqual({ [D]: { grace: 15, idle: 15, event: 30 } });
  });

  test("W4: 予定が declined / free / cancelled / 自分の時間ブロック → どれも予定として扱わず、放置 45", () => {
    const { t, reply } = asked(at("10:00"));
    const f = facts({ turns: [t, human(at("11:00"))], followUps: [reply] });
    for (const p of [
      { selfResponse: "declined" as const },
      { availability: "free" as const },
      { status: "cancelled" as const },
      { isOwnTimeblock: true },
      { calendarRole: "writeback" as const },
    ]) {
      const r = run(f, at("12:00"), {
        ops: [at("09:00")],
        events: [busyEvent(at("10:20"), at("10:50"), p)],
      });
      expect(r.summary).toEqual({ [D]: { grace: 15, idle: 45 } });
    }
  });

  test("W5: 操作 9:00〜18:55、ターン終了 18:50、D+1 の最初の操作が人間入力 9:30 → 猶予 5（Mac を離れるまで。不在は猶予にしない。D-058）、集計外、放置 0", () => {
    const { t, reply } = asked(at("18:50"));
    const f = facts({ turns: [t, human(at("09:30", 1))], followUps: [reply] });
    const r = run(f, at("12:00", 1), { ops: [at("09:00"), at("18:55")] });
    expect(r.summary).toEqual({
      [D]: { grace: 5, away: (at("04:00", 1) - at("18:55")) / MIN },
      [D1]: { away: (at("09:30", 1) - at("04:00", 1)) / MIN },
    });
  });

  test("W6: W5 で D+1 に turnlane の操作 9:00、人間入力 9:30 → D+1 は猶予の残り 10（9:00〜9:10）、放置 20", () => {
    const { t, reply } = asked(at("18:50"));
    const f = facts({ turns: [t, human(at("09:30", 1))], followUps: [reply] });
    const r = run(f, at("12:00", 1), { ops: [at("09:00"), at("18:55"), at("09:00", 1)] });
    expect(r.summary[D]).toMatchObject({ grace: 5 });
    expect(r.summary[D1]).toEqual({
      away: (at("09:00", 1) - at("04:00", 1)) / MIN,
      grace: 10,
      idle: 20,
    });
  });

  test("W7: 今日。操作 9:00、ターン終了 14:00、最後の操作 14:05、now 15:00、入力なし → 放置 45（今日の終了は now）。開いている区間", () => {
    const { t, reply } = asked(at("14:00"));
    const f = facts({ turns: [t], followUps: [reply] });
    const r = run(f, at("15:00"), { ops: [at("09:00"), at("14:05")] });
    expect(r.summary).toEqual({ [D]: { grace: 15, idle: 45 } });
    expect(r.intervals[0]?.isOpen).toBe(true);
  });

  test("W8: ターン終了 03:50（論理日付は前日）、人間入力 07:30 → 論理日付で分け、それぞれの日の在席で判定", () => {
    const D0 = addDays(D, -1);
    const { t, reply } = asked(at("03:50"));
    const f = facts({ turns: [t, human(at("07:30"))], followUps: [reply] });
    const r = run(f, at("12:00"), { ops: [at("10:00", -1), at("03:55")] });
    // 前日（D-1）の在席は 10:00〜03:55。03:50〜03:55 は猶予、03:55〜04:00 は不在、04:00 以降は D。
    // D は 07:30（人間入力）の一瞬だけなので、D の待ちはすべて不在
    expect(r.summary).toEqual({ [D0]: { grace: 5, away: 5 }, [D]: { away: 210 } });
  });

  test("W8b（D-105）: 日付区切りをまたぐ待ちは時刻で論理日に振り分ける（D-084 の前日への寄せはしない）", () => {
    const D0 = addDays(D, -1);
    const { t, reply } = asked(at("03:50"));
    const f = facts({ turns: [t, human(at("04:30"))], followUps: [reply] });
    // 前日の 10:00 から 04:30 まで続けて Mac を使っていた
    const r = run(f, at("12:00"), { presence: [[at("10:00", -1), at("04:30")]] });
    expect(r.summary).toEqual({ [D0]: { grace: 10 }, [D]: { grace: 5, idle: 25 } });
  });

  test("W9: 質問で終了 D 10:00、以後入力なし → D 10:15 に返答タスク、D+3 10:00 に期限切れ。Idle に入らず、Expired は D+3 に1件", () => {
    const t = aiEnd(at("10:00"), { endedWith: "question" });
    const f0 = facts({ turns: [t] });
    // D 10:14: まだ作らない / 10:15: 作る
    expect(
      desiredFollowUps(
        f0,
        deriveStatus(f0, at("10:14"), SETTINGS, TIMING),
        at("10:14"),
        SETTINGS,
        TIMING,
      ),
    ).toEqual([]);
    const desired = desiredFollowUps(
      f0,
      deriveStatus(f0, at("10:15"), SETTINGS, TIMING),
      at("10:15"),
      SETTINGS,
      TIMING,
    );
    expect(desired.map((d) => [d.kind, d.triggerAt])).toEqual([["reply", at("10:00")]]);
    // 期限前（D+1 12:00）は放置として数えている
    const reply = followUp({
      kind: "reply",
      triggerAt: at("10:00"),
      triggerTurnId: t.id,
      dedupeKey: (desired[0] as { dedupeKey: string }).dedupeKey,
    });
    const f1 = facts({ turns: [t], followUps: [reply] });
    const before = run(f1, at("12:00", 1), { ops: [at("09:00"), at("18:00"), at("09:00", 1)] });
    expect(before.summary[D]?.idle).toBeGreaterThan(0);
    // D+3 10:00: 期限切れで閉じる
    const actions = reconcileFollowUps(f1, [], at("10:01", 3), SETTINGS);
    expect(actions).toEqual([
      {
        type: "close",
        id: reply.id,
        status: "expired",
        reason: "auto:expired",
        at: at("10:00", 3),
      },
    ]);
    const expired = {
      ...reply,
      status: "expired" as const,
      closedAt: at("10:00", 3),
      closeReason: "auto:expired",
    };
    const f2 = facts({ turns: [t], followUps: [expired] });
    expect(deriveStatus(f2, at("10:01", 3), SETTINGS, TIMING).status).toBe("done");
    const after = run(f2, at("10:01", 3), {
      ops: [at("09:00"), at("18:00"), at("09:00", 1), at("09:00", 2), at("09:00", 3)],
    });
    for (const d of Object.values(after.summary)) expect(d.idle).toBeUndefined();
    expect(after.summary[D]?.grace).toBe(15);
    const agg = aggregateDays([], [{ closedAt: at("10:00", 3) }], SETTINGS);
    expect(agg.get(D3)?.expiredCount).toBe(1);
  });

  const signalsAt = (
    p: Partial<{ commit: number; session: number; merged: number }>,
  ): ResolutionSignals => ({
    commitAfter: (since) => (p.commit !== undefined && p.commit > since ? p.commit : null),
    newSessionAfter: (since) => (p.session !== undefined && p.session > since ? p.session : null),
    prMergedAfter: (since) => (p.merged !== undefined && p.merged > since ? p.merged : null),
  });

  /** liveStatus: 問いを出したセッションのプロセスの状態（省略は null = 生死が取れない） */
  function resolvedScenario(
    signals: ResolutionSignals,
    liveStatus: "busy" | "idle" | "gone" | null = null,
  ) {
    const t = aiEnd(at("10:00"), { endedWith: "question" });
    const reply = followUp({ kind: "reply", triggerAt: at("10:00"), triggerTurnId: t.id });
    const sessions = [session({ lastActivityAt: at("10:00"), liveStatus })];
    const f = facts({ turns: [t], sessions, followUps: [reply] });
    const desired = desiredFollowUps(
      f,
      deriveStatus(f, at("12:00"), SETTINGS, TIMING),
      at("12:00"),
      SETTINGS,
      TIMING,
    );
    const actions = reconcileFollowUps(f, desired, at("12:00"), SETTINGS, signals);
    const close = actions.find((a) => a.type === "close");
    if (close?.type !== "close") return { close: null, summary: null };
    const closed = {
      ...reply,
      status: close.status as "done",
      closedAt: close.at,
      closeReason: close.reason,
    };
    const r = run(facts({ turns: [t], sessions, followUps: [closed] }), at("12:00"), {
      ops: [at("09:00")],
    });
    return { close, summary: r.summary };
  }

  test("W10: 質問で終了 10:00、同じ repo・ブランチでコミット 11:00 → 11:00 に解決済み（推定）。放置 45", () => {
    const r = resolvedScenario(signalsAt({ commit: at("11:00") }));
    expect(r.close).toMatchObject({
      status: "done",
      reason: "auto:resolved:commit",
      at: at("11:00"),
    });
    expect(r.summary).toEqual({ [D]: { grace: 15, idle: 45 } });
  });

  test("W11: 別セッションの人間入力 10:50 / head ブランチの PR が 10:40 に merged → それぞれ兆候の時刻まで", () => {
    const a = resolvedScenario(signalsAt({ session: at("10:50") }));
    expect(a.close).toMatchObject({ reason: "auto:resolved:new_session", at: at("10:50") });
    expect(a.summary).toEqual({ [D]: { grace: 15, idle: 35 } });
    const b = resolvedScenario(signalsAt({ merged: at("10:40") }));
    expect(b.close).toMatchObject({ reason: "auto:resolved:pr_merged", at: at("10:40") });
    expect(b.summary).toEqual({ [D]: { grace: 15, idle: 25 } });
  });

  test("W11b: 問いのセッションのプロセスが生きている（idle / busy）間は、別セッションの入力・コミットで閉じない", () => {
    for (const live of ["idle", "busy"] as const) {
      expect(resolvedScenario(signalsAt({ session: at("10:50") }), live).close).toBeNull();
      expect(resolvedScenario(signalsAt({ commit: at("11:00") }), live).close).toBeNull();
    }
  });

  test("W11c: 問いのセッションのプロセスが gone なら、別セッションの入力・コミットで従来どおり閉じる", () => {
    const a = resolvedScenario(signalsAt({ session: at("10:50") }), "gone");
    expect(a.close).toMatchObject({ reason: "auto:resolved:new_session", at: at("10:50") });
    expect(a.summary).toEqual({ [D]: { grace: 15, idle: 35 } });
    const b = resolvedScenario(signalsAt({ commit: at("11:00") }), "gone");
    expect(b.close).toMatchObject({ reason: "auto:resolved:commit", at: at("11:00") });
  });

  test("W11d: プロセスの生死が取れない（live_status なし。Codex など）なら従来どおり閉じる", () => {
    const a = resolvedScenario(signalsAt({ session: at("10:50") }), null);
    expect(a.close).toMatchObject({ reason: "auto:resolved:new_session", at: at("10:50") });
    const b = resolvedScenario(signalsAt({ commit: at("11:00") }), null);
    expect(b.close).toMatchObject({ reason: "auto:resolved:commit", at: at("11:00") });
  });

  test("W11e: PR の merged はプロセスが生きていても兆候にする（変えない）", () => {
    const r = resolvedScenario(signalsAt({ merged: at("10:40"), session: at("10:30") }), "idle");
    expect(r.close).toMatchObject({ reason: "auto:resolved:pr_merged", at: at("10:40") });
    expect(r.summary).toEqual({ [D]: { grace: 15, idle: 25 } });
  });

  test("W11f: 既に解決（推定）で閉じた返答タスクは、プロセスが生きていて兆候が消えても開き直さない", () => {
    const t = aiEnd(at("10:00"), { endedWith: "question" });
    const done = followUp({
      kind: "reply",
      triggerAt: at("10:00"),
      triggerTurnId: t.id,
      status: "done",
      closedAt: at("10:50"),
      closeReason: "auto:resolved:new_session",
    });
    const f = facts({
      turns: [t],
      sessions: [session({ lastActivityAt: at("10:00"), liveStatus: "idle" })],
      followUps: [done],
    });
    const now = at("12:00");
    const desired = desiredFollowUps(
      f,
      deriveStatus(f, now, SETTINGS, TIMING),
      now,
      SETTINGS,
      TIMING,
    );
    expect(reconcileFollowUps(f, desired, now, SETTINGS, NO_SIGNALS)).toEqual([]);
    expect(
      reconcileFollowUps(f, desired, now, SETTINGS, signalsAt({ commit: at("11:00") })),
    ).toEqual([]);
  });

  test("W12: 兆候が別ブランチ・別 repo → 兆候にしない（runner が repo・ブランチで絞った結果、何も来ない）", () => {
    const r = resolvedScenario(signalsAt({}));
    expect(r.close).toBeNull();
  });

  test("W13: 質問で終了 10:00、e（対応不要）10:30 → dismissed、放置 15", () => {
    const t = aiEnd(at("10:00"), { endedWith: "question" });
    const reply = followUp({
      kind: "reply",
      triggerAt: at("10:00"),
      triggerTurnId: t.id,
      status: "dismissed",
      closedAt: at("10:30"),
      closeReason: "dismissed",
    });
    const f = facts({ turns: [t], followUps: [reply] });
    expect(run(f, at("12:00"), { ops: [at("09:00")] }).summary).toEqual({
      [D]: { grace: 15, idle: 15 },
    });
    expect(deriveStatus(f, at("12:00"), SETTINGS, TIMING).status).toBe("done");
  });

  test("W14: 締めの決まり文句の質問で終了、編集・PR なし → 返答タスクを作らない、待たずに done、待ち区間なし", () => {
    const f = facts({
      turns: [aiEnd(at("10:00"), { endedWith: "question", closingQuestion: true })],
    });
    const st = deriveStatus(f, at("11:00"), SETTINGS, TIMING);
    expect(st.status).toBe("done");
    expect(desiredFollowUps(f, st, at("11:00"), SETTINGS, TIMING)).toEqual([]);
    expect(run(f, at("11:00"), { ops: [at("09:00")] }).intervals).toEqual([]);
  });

  test("W15: 締めの決まり文句の質問で終了、ただし編集あり → your_turn（(b)）。返答タスクは作らない", () => {
    const f = facts({
      turns: [aiEnd(at("10:00"), { endedWith: "question", closingQuestion: true, editedFiles: 1 })],
    });
    const st = deriveStatus(f, at("11:00"), SETTINGS, TIMING);
    expect(st).toMatchObject({ status: "your_turn", reason: "edits" });
    expect(desiredFollowUps(f, st, at("11:00"), SETTINGS, TIMING)).toEqual([]);
  });

  test("W16: 質問で終了 10:00、返答タスクを ⏎ 10:30、人間入力 10:45 → 放置 15（10:15〜10:30）。以降は自分の応答", () => {
    const t = aiEnd(at("10:00"), { endedWith: "question" });
    const reply = followUp({
      kind: "reply",
      triggerAt: at("10:00"),
      triggerTurnId: t.id,
      engagedAt: at("10:30"),
    });
    const f = facts({ turns: [t, human(at("10:45"))], followUps: [reply] });
    const r = run(f, at("12:00"), { ops: [at("09:00")] });
    expect(r.summary).toEqual({ [D]: { grace: 15, idle: 15 } });
    expect(r.intervals[0]?.endReason).toBe("engaged");
  });

  test("W17: hooks あり。PermissionRequest 10:00、Stop 10:20 → needs_input の待ち。猶予 15、放置 5", () => {
    const t = turn0(at("09:55"), at("10:21"));
    const hooks = [
      hook("UserPromptSubmit", at("09:55")),
      hook("PermissionRequest", at("10:00")),
      hook("Stop", at("10:20")),
    ];
    const approve = followUp({
      kind: "approve",
      triggerAt: at("10:00"),
      triggerTurnId: t.id,
      status: "done",
      closedAt: at("10:20"),
      closeReason: "auto:next_turn_ok",
    });
    const f = facts({ turns: [t], hooks, followUps: [approve] });
    expect(run(f, at("12:00"), { ops: [at("09:00")] }).summary).toEqual({
      [D]: { grace: 15, idle: 5 },
    });
    // approve が無ければ（hooks なし・設定でオフ）放置にしない
    expect(run(facts({ turns: [t], hooks }), at("12:00"), { ops: [at("09:00")] }).summary).toEqual({
      [D]: { grace: 15, no_task: 5 },
    });
  });

  test("W18: open な PR の your_turn が D 16:00 から D+1 11:00（merged）まで。在席 D 9:00〜18:00、D+1 9:00〜 → D: 猶予 15・放置 1h45m、D+1: 放置 2h。期限切れにしない", () => {
    const t = aiEnd(at("16:00"));
    const review = followUp({
      kind: "review_pr",
      triggerAt: at("15:58"),
      artifactRef: "org/repo#1",
      status: "done",
      closedAt: at("11:00", 1),
      closeReason: "auto:pr_merged",
    });
    const f = facts({
      turns: [t],
      prs: [pr({ firstSeenAt: at("15:58"), state: "merged", stateChangedAt: at("11:00", 1) })],
      followUps: [review],
    });
    const r = run(f, at("12:00", 1), { ops: [at("09:00"), at("18:00"), at("09:00", 1)] });
    expect(r.summary[D]).toMatchObject({ grace: 15, idle: 105 });
    expect(r.summary[D1]).toMatchObject({ idle: 120 });
    expect(r.intervals[0]).toMatchObject({ expired: false, endReason: "status_left" });
  });

  test("W18b: マージされない PR のレビュー待ちは期限なく放置として数え続ける（D-032）", () => {
    const review = followUp({
      kind: "review_pr",
      triggerAt: at("15:58"),
      artifactRef: "org/repo#1",
    });
    const f = facts({
      turns: [aiEnd(at("16:00"))],
      prs: [pr({ firstSeenAt: at("15:58") })],
      followUps: [review],
    });
    const r = run(f, at("12:00", 5), {
      ops: [0, 1, 2, 3, 4, 5].flatMap((d) => [at("09:00", d), at("18:00", d)]),
    });
    expect(r.intervals[0]?.isOpen).toBe(true);
    expect(r.summary[addDays(D, 4)]?.idle).toBeGreaterThan(0);
    expect(deriveStatus(f, at("12:00", 5), SETTINGS, TIMING)).toMatchObject({
      status: "your_turn",
      reason: "pr_open",
    });
  });

  test("W19: 質問で終了 10:00、返答タスクを 10:20 に1時間スヌーズ、人間入力 12:00 → 放置 5 + 40、集計外（snoozed）60（D-032）", () => {
    const t = aiEnd(at("10:00"), { endedWith: "question" });
    const reply = followUp({
      kind: "reply",
      triggerAt: at("10:00"),
      triggerTurnId: t.id,
      snoozes: [[at("10:20"), at("11:20")]],
    });
    const f = facts({ turns: [t, human(at("12:00"))], followUps: [reply] });
    const r = run(f, at("13:00"), { ops: [at("09:00")] });
    expect(r.summary).toEqual({ [D]: { grace: 15, idle: 45, snoozed: 60 } });
    expect(r.intervals[0]).toMatchObject({ start: at("10:00"), end: at("12:00") });
  });

  test("W20（D-105）: 昼に Mac を離れた 12:00〜13:00 は不在。戻ってからは猶予の残りがなければすぐ放置", () => {
    const { t, reply } = asked(at("11:50"));
    const f = facts({ turns: [t, human(at("13:30"))], followUps: [reply] });
    const r = run(f, at("14:00"), {
      presence: [
        [at("09:00"), at("12:00")],
        [at("13:00"), at("14:00")],
      ],
    });
    // 11:50〜12:00 猶予 10、12:00〜13:00 不在、13:00〜13:05 猶予の残り 5、13:05〜13:30 放置 25
    expect(r.summary).toEqual({ [D]: { grace: 15, away: 60, idle: 25 } });
  });

  test("W21（D-105）: 最後の操作から T 分の後は不在。今 Mac を使っていなければ放置は増えない", () => {
    const { t, reply } = asked(at("16:00"));
    const f = facts({ turns: [t], followUps: [reply] });
    // 17:00 に最後の操作、T = 5分 → 在席は 17:05 まで
    const r = run(f, at("18:00"), { presence: [[at("09:00"), at("17:05")]] });
    expect(r.summary).toEqual({ [D]: { grace: 15, idle: 50, away: 55 } });
  });

  /** 返答タスクを 10:30 に 15:00〜15:30 の時間ブロックへ置いた（D-051） */
  const placed = (reply: ReturnType<typeof asked>["reply"]) => ({
    ...reply,
    scheduled: [[at("10:30"), at("15:00")]] as [number, number][],
  });

  test("W38: 時間に置いた返答タスク（D-051）: 10:30 に 15:00 へ置き、人間入力 15:20 → 放置 15 + 20、集計外（scheduled）4h30m", () => {
    const { t, reply } = asked(at("10:00"));
    const f = facts({ turns: [t, human(at("15:20"))], followUps: [placed(reply)] });
    const r = run(f, at("18:00"), { ops: [at("09:00")] });
    expect(r.summary).toEqual({ [D]: { grace: 15, idle: 35, scheduled: 270 } });
    expect(r.intervals[0]).toMatchObject({ start: at("10:00"), end: at("15:20") });
  });

  test("W39: W38 で手を付けないまま now 16:00 → 開始 15:00 を過ぎたら放置（15 + 60）", () => {
    const { t, reply } = asked(at("10:00"));
    const f = facts({ turns: [t], followUps: [placed(reply)] });
    const r = run(f, at("16:00"), { ops: [at("09:00")] });
    expect(r.summary).toEqual({ [D]: { grace: 15, idle: 75, scheduled: 270 } });
  });

  test("W40: 「今日」にしただけ（ブロックなし）、ブロックを消した → 従来どおり放置 15 + 4h50m", () => {
    const { t, reply } = asked(at("10:00"));
    for (const fu of [reply, { ...reply, scheduled: [] as [number, number][] }]) {
      const f = facts({ turns: [t, human(at("15:20"))], followUps: [fu] });
      expect(run(f, at("18:00"), { ops: [at("09:00")] }).summary).toEqual({
        [D]: { grace: 15, idle: 305 },
      });
    }
  });

  test("W41: W38 で 10:30〜11:30 のスヌーズも重なる → スヌーズが先（snoozed 60、scheduled 3h30m）", () => {
    const { t, reply } = asked(at("10:00"));
    const fu = { ...placed(reply), snoozes: [[at("10:30"), at("11:30")]] as [number, number][] };
    const f = facts({ turns: [t, human(at("15:20"))], followUps: [fu] });
    const r = run(f, at("18:00"), { ops: [at("09:00")] });
    expect(r.summary).toEqual({ [D]: { grace: 15, idle: 35, snoozed: 60, scheduled: 210 } });
  });

  test("W42: 深夜 02:34 の待ち（D-058、デイビューの主役の場面）→ Mac を使い始める 8:42 まで不在、8:42〜8:50 猶予、8:50 に ⏎ → Idle 0", () => {
    const D0 = addDays(D, -1);
    const t = aiEnd(at("02:34"), { endedWith: "question" });
    // 返答タスクは従来どおり待ちの始まりから15分（02:49）で作る。YOUR TURN に出す時刻は変えない
    expect(
      desiredFollowUps(
        facts({ turns: [t] }),
        deriveStatus(facts({ turns: [t] }), at("02:48"), SETTINGS, TIMING),
        at("02:48"),
        SETTINGS,
        TIMING,
      ),
    ).toEqual([]);
    const f0 = facts({ turns: [t] });
    const desired = desiredFollowUps(
      f0,
      deriveStatus(f0, at("02:49"), SETTINGS, TIMING),
      at("02:49"),
      SETTINGS,
      TIMING,
    );
    expect(desired.map((d) => [d.kind, d.triggerAt])).toEqual([["reply", at("02:34")]]);
    const reply = followUp({
      kind: "reply",
      triggerAt: at("02:34"),
      triggerTurnId: t.id,
      createdAt: at("02:49"),
      engagedAt: at("08:50"),
    });
    const f = facts({ turns: [t, human(at("08:58"))], followUps: [reply] });
    // 前日（論理日付 D-1）の在席は 10:00〜01:40、D は 8:42 から
    const r = run(f, at("12:00"), { ops: [at("10:00", -1), at("01:40"), at("08:42")] });
    expect(r.intervals[0]).toMatchObject({ start: at("02:34"), end: at("08:50") });
    expect(r.summary).toEqual({
      [D0]: { away: (at("04:00") - at("02:34")) / MIN },
      [D]: { away: (at("08:42") - at("04:00")) / MIN, grace: 8 },
    });
    expect(
      r.segments.filter((x) => x.kind === "grace").map((x) => [x.start, x.end, x.localDate]),
    ).toEqual([[at("08:42"), at("08:50"), D]]);
    const agg = aggregateDays(
      r.segments.map((x) => ({ ...x, workItemId: "wi", repoRoot: null })),
      [],
      SETTINGS,
    );
    expect(agg.get(D)?.idleMs ?? 0).toBe(0);
    // 平均応答時間（D-057）も新しい区分で数える: 猶予 8 分だけ
    expect(
      countedResponseMs(
        { triggerAt: at("02:34"), engagedAt: at("08:50"), closedAt: at("08:58") },
        r.segments,
      ),
    ).toBe(8 * MIN);
  });

  test("W43: 会議中（10:00〜11:00）の 10:10 に始まった待ち、人間入力 11:20 → 集計外（event）50、猶予 11:00〜11:15、放置 5", () => {
    const { t, reply } = asked(at("10:10"));
    const live = { ...reply, createdAt: at("10:25") };
    const f = facts({ turns: [t, human(at("11:20"))], followUps: [live] });
    const r = run(f, at("12:00"), {
      ops: [at("09:00")],
      events: [busyEvent(at("10:00"), at("11:00"))],
    });
    expect(r.summary).toEqual({ [D]: { event: 50, grace: 15, idle: 5 } });
    expect(r.segments.find((x) => x.kind === "grace")).toMatchObject({
      start: at("11:00"),
      end: at("11:15"),
    });
  });

  test("W44: 猶予の途中で会議に入り出た（10:05〜10:30）、人間入力 10:45 → 猶予は合計 15（5 + 10）だけ。付け直さない、放置 5", () => {
    const { t, reply } = asked(at("10:00"));
    const f = facts({ turns: [t, human(at("10:45"))], followUps: [reply] });
    const r = run(f, at("12:00"), {
      ops: [at("09:00")],
      events: [busyEvent(at("10:05"), at("10:30"))],
    });
    expect(r.summary).toEqual({ [D]: { grace: 15, event: 25, idle: 5 } });
    expect(r.segments.filter((x) => x.kind === "grace").map((x) => [x.start, x.end])).toEqual([
      [at("10:00"), at("10:05")],
      [at("10:30"), at("10:40")],
    ]);
    // 猶予を使い切った後の会議（W3）は、出たところからすぐ放置（もう一度 15分を付けない）
    const r2 = run(f, at("12:00"), {
      ops: [at("09:00")],
      events: [busyEvent(at("10:20"), at("10:35"))],
    });
    expect(r2.summary).toEqual({ [D]: { grace: 15, event: 15, idle: 15 } });
  });

  test("W45: 不在の 7:00 の待ちを 7:20 に Mac を使い始める（9:00）より後の 10:00 までスヌーズ、人間入力 10:30 → スヌーズ明けから猶予 15、放置 15", () => {
    const { t, reply } = asked(at("07:00"));
    const fu = {
      ...reply,
      createdAt: at("07:15"),
      snoozes: [[at("07:20"), at("10:00")]] as [number, number][],
    };
    const f = facts({ turns: [t, human(at("10:30"))], followUps: [fu] });
    // 7:00 の依頼（人間入力 6:55）の後は Mac を離れ、9:00 から使い始めた日
    const r = run(f, at("12:00"), { presence: [[at("09:00"), at("12:00")]] });
    expect(r.summary).toEqual({ [D]: { away: 120, snoozed: 60, grace: 15, idle: 15 } });
  });

  test("W46: 不在の 7:00 の待ちを 7:30 に 11:00〜11:30 の時間ブロックへ置き、人間入力 11:20 → 置いた開始から猶予 15、放置 5", () => {
    const { t, reply } = asked(at("07:00"));
    const fu = {
      ...reply,
      createdAt: at("07:15"),
      scheduled: [[at("07:30"), at("11:00")]] as [number, number][],
    };
    const f = facts({ turns: [t, human(at("11:20"))], followUps: [fu] });
    // 7:00 の依頼（人間入力 6:55）の後は Mac を離れ、9:00 から使い始めた日
    const r = run(f, at("12:00"), { presence: [[at("09:00"), at("12:00")]] });
    expect(r.summary).toEqual({ [D]: { away: 120, scheduled: 120, grace: 15, idle: 5 } });
  });

  test("W47: 期限切れの待ちは猶予（数えうる時間の最初の 15分）以外がすべて期限切れ。夜に始まったものは翌朝 Mac を使い始めてから猶予", () => {
    const { t, reply } = asked(at("22:00"));
    const expired = {
      ...reply,
      createdAt: at("22:15"),
      status: "expired" as const,
      closedAt: at("22:00", 3),
      closeReason: "auto:expired",
    };
    const ops = [0, 1, 2, 3].flatMap((x) => [at("09:00", x), at("18:00", x)]);
    const r = run(facts({ turns: [t], followUps: [expired] }), at("23:00", 3), { ops });
    expect(r.summary[D]).toEqual({ expired: (at("04:00", 1) - at("22:00")) / MIN });
    expect(r.summary[D1]).toEqual({
      expired: (at("04:00", 2) - at("04:00", 1)) / MIN - 15,
      grace: 15,
    });
    expect(r.segments.find((x) => x.kind === "grace")).toMatchObject({
      start: at("09:00", 1),
      end: at("09:15", 1),
    });
  });

  test("D-051: ブロックの開始が置いた時刻より前（過去に置いた）なら何も外さない", () => {
    const { t, reply } = asked(at("10:00"));
    const fu = { ...reply, scheduled: [[at("12:00"), at("11:00")]] as [number, number][] };
    const f = facts({ turns: [t, human(at("13:00"))], followUps: [fu] });
    expect(run(f, at("18:00"), { ops: [at("09:00")] }).summary).toEqual({
      [D]: { grace: 15, idle: 165 },
    });
  });

  test("W22: 操作の種類（MCP の add_task・ui_open・自動クローズ・カレンダーヘルパは操作にしない）", () => {
    expect(isWorkOp({ kind: "usage_event", at: 1, usageKind: "ui_open" })).toBe(false);
    expect(isWorkOp({ kind: "usage_event", at: 1, usageKind: "task_added" })).toBe(false);
    expect(isWorkOp({ kind: "task_completed", at: 1, autoCompleted: true })).toBe(false);
    expect(isWorkOp({ kind: "ai_turn", at: 1, initiator: "system" })).toBe(false);
    // ブラウザでのタスク完了・turnlane add（user_op）・Claude への入力は操作
    expect(isWorkOp({ kind: "task_completed", at: 1, autoCompleted: false })).toBe(true);
    expect(isWorkOp({ kind: "usage_event", at: 1, usageKind: "user_op" })).toBe(true);
    expect(isWorkOp({ kind: "ai_turn", at: 1, initiator: "human" })).toBe(true);
    expect(isWorkOp({ kind: "ai_turn", at: 1, initiator: "queued" })).toBe(true);
  });

  test("W23: 操作が1件も無い日に AI のスケジュール実行が your_turn で終わる → 在席なし。待ちはすべて集計外（猶予も付かない）", () => {
    const f = facts({ turns: [aiEnd(at("10:00"), { editedFiles: 1, initiator: "scheduled" })] });
    const r = run(f, at("12:00"));
    expect(r.summary).toEqual({ [D]: { away: 120 } });
  });

  test("W25: カレンダー窓より古い日は自動では作り直さない。--since を指定したときだけ。在席の記録を始めた日より前は作り直さない（D-110 (3)）", () => {
    expect(waitRecomputeFrom(D, SETTINGS, undefined, addDays(D, -2))).toBe(addDays(D, -2));
    expect(waitRecomputeFrom(D, SETTINGS, addDays(D, -30), addDays(D, -2))).toBe(addDays(D, -2));
    expect(waitRecomputeFrom(D, SETTINGS, undefined, addDays(D, -30))).toBe(addDays(D, -7));
    expect(waitRecomputeFrom(D, SETTINGS)).toBe(addDays(D, -7));
    expect(waitRecomputeFrom(D, SETTINGS, addDays(D, -30))).toBe(addDays(D, -30));
    expect(waitRecomputeFrom(D, SETTINGS, addDays(D, -1))).toBe(addDays(D, -7));
  });

  test("W26: 日別集計（Idle は和集合、Expired の件数、repo_root 別の放置。git 管理外は null）が区間と一致する", () => {
    const { t, reply } = asked(at("10:00"));
    const f = facts({ turns: [t, human(at("10:40"))], followUps: [reply] });
    const r = run(f, at("12:00"), { ops: [at("09:00")] });
    const segs = [
      ...r.segments.map((s) => ({ ...s, workItemId: "wi", repoRoot: "/fixture/repo-a" })),
      ...r.segments.map((s) => ({ ...s, workItemId: "wi2", repoRoot: null })),
    ];
    const agg = aggregateDays(
      segs,
      [{ closedAt: at("11:00") }, { closedAt: at("03:00") }],
      SETTINGS,
    ).get(D);
    // 同じ時刻に2枚が放置中なので、日別は 25 分（合計の 50 分ではない）
    expect(agg?.idleMs).toBe(25 * MIN);
    expect(agg?.expiredCount).toBe(1); // 03:00 は前日の論理日付
    expect(agg?.idleByRepo.get("/fixture/repo-a")).toBe(25 * MIN);
    expect(agg?.idleByRepo.get(null)).toBe(25 * MIN);
    expect(agg?.idleByWorkItem.get("wi2")).toBe(25 * MIN);
  });

  test("W27: 見えない your_turn（編集ありのみ、PR なし）10:00、人間入力 11:00 → 区間は記録、放置 0（no_task 45）。check_changes があっても同じ", () => {
    const t = aiEnd(at("10:00"), { editedFiles: 2 });
    const f = facts({ turns: [t, human(at("11:00"))] });
    const r = run(f, at("12:00"), { ops: [at("09:00")] });
    expect(r.intervals).toHaveLength(1);
    expect(r.summary).toEqual({ [D]: { grace: 15, no_task: 45 } });
    const check = followUp({ kind: "check_changes", triggerAt: at("10:00"), triggerTurnId: t.id });
    const g = facts({ turns: [t, human(at("11:00"))], followUps: [check] });
    expect(run(g, at("12:00"), { ops: [at("09:00")] }).summary).toEqual({
      [D]: { grace: 15, no_task: 45 },
    });
  });

  test("W28: 並列の待ちは和集合。A（repo-a）11:00・B（repo-b）11:30・C（repo-a）10:45 に返答 → カード 45・75・30、日別 75、repo-a 45・repo-b 75", () => {
    const card = (id: string, repo: string, humanAt: number) => {
      const { t, reply } = asked(at("10:00"), { sessionId: `s-${id}` }, humanAt);
      const h = human(humanAt, { sessionId: `s-${id}` });
      const f = facts({
        workItemId: id,
        turns: [t, h],
        sessions: [session({ id: `s-${id}`, externalId: `ext-${id}`, lastActivityAt: humanAt })],
        followUps: [reply],
      });
      return run(f, at("12:00"), { ops: [at("09:00")] }).segments.map((s) => ({
        ...s,
        workItemId: id,
        repoRoot: repo,
      }));
    };
    const segs = [
      ...card("A", "/fixture/repo-a", at("11:00")),
      ...card("B", "/fixture/repo-b", at("11:30")),
      ...card("C", "/fixture/repo-a", at("10:45")),
    ];
    const agg = aggregateDays(segs, [], SETTINGS).get(D);
    expect(agg?.idleByWorkItem.get("A")).toBe(45 * MIN);
    expect(agg?.idleByWorkItem.get("B")).toBe(75 * MIN);
    expect(agg?.idleByWorkItem.get("C")).toBe(30 * MIN);
    expect(agg?.idleMs).toBe(75 * MIN);
    expect(agg?.idleByRepo.get("/fixture/repo-a")).toBe(45 * MIN);
    expect(agg?.idleByRepo.get("/fixture/repo-b")).toBe(75 * MIN);
  });

  test("W29: 在席 9:00〜12:00 の日に10枚が 9:00〜12:00 同時に返答待ち → 日別 Idle 2h45m（在席 3h を超えない）", () => {
    const segs = Array.from({ length: 10 }, (_, i) => {
      const { t, reply } = asked(at("09:00"), { sessionId: `s${i}` }, at("12:00"));
      const f = facts({
        workItemId: `w${i}`,
        turns: [t, human(at("12:00"), { sessionId: `s${i}` })],
        sessions: [session({ id: `s${i}`, externalId: `e${i}`, lastActivityAt: at("12:00") })],
        followUps: [reply],
      });
      return run(f, at("13:00"), { ops: [at("09:00")] }).segments.map((s) => ({
        ...s,
        workItemId: `w${i}`,
        repoRoot: "/fixture/repo-a",
      }));
    }).flat();
    const agg = aggregateDays(segs, [], SETTINGS).get(D);
    expect(agg?.idleMs).toBe(165 * MIN);
    expect(agg?.idleMs ?? 0).toBeLessThanOrEqual(at("12:00") - at("09:00"));
    expect(agg?.idleByRepo.get("/fixture/repo-a")).toBe(165 * MIN);
  });

  test("W30: バックフィル。D+4 に初めて取り込む → 72時間より古い待ちからはどのタスクも作らない。区間は残り放置 0。D+2 なら作る", () => {
    const q = aiEnd(at("10:00"), { endedWith: "question" });
    const p = pr({ firstSeenAt: at("09:00"), stateCheckedAt: at("09:01") });
    const created = (now: number) => {
      const f = facts({
        turns: [q],
        prs: [p],
      });
      const st = deriveStatus(f, now, SETTINGS, TIMING);
      const d = [
        ...desiredFollowUps(f, st, now, SETTINGS, TIMING),
        // 許可待ちと再開はカードの状態で決まるので、仕様（トリガの古さ）だけを直接確かめる
        {
          kind: "approve" as const,
          artifactRef: "x",
          dedupeKey: "wi|approve|x",
          triggerAt: at("13:00"),
          triggerTurnId: null,
        },
        {
          kind: "resume_error" as const,
          artifactRef: "e",
          dedupeKey: "wi|resume_error|e",
          triggerAt: at("11:00"),
          triggerTurnId: null,
        },
      ];
      return reconcileFollowUps(f, d, now, SETTINGS)
        .filter((a) => a.type === "create")
        .map((a) => (a.type === "create" ? a.spec.kind : ""))
        .sort();
    };
    expect(created(at("12:00", 4))).toEqual([]);
    expect(created(at("12:00", 2))).toEqual(["approve", "reply", "resume_error", "review_pr"]);
    // タスクが無いので、待ち区間は残るが放置にはならない
    const f = facts({ turns: [aiEnd(at("10:00"), { editedFiles: 1 })], prs: [p] });
    const r = run(f, at("12:00", 4), {
      ops: [0, 1, 2, 3, 4].flatMap((d) => [at("09:00", d), at("18:00", d)]),
    });
    expect(r.intervals.length).toBeGreaterThan(0);
    for (const d of Object.values(r.summary)) expect(d.idle).toBeUndefined();
    expect(r.summary[D]?.no_task).toBeGreaterThan(0);
  });

  test("W30b: 72時間以内の待ちを後から（初回の取り込みで）タスクにしたら、作った時刻から数える（見えていなかった過去は数えない）", () => {
    const { t, reply } = asked(at("10:00"));
    const late = { ...reply, createdAt: at("12:00", 1) };
    const ops = [0, 1].flatMap((d) => [at("09:00", d), at("18:00", d)]);
    const r = run(facts({ turns: [t], followUps: [late] }), at("13:00", 1), { ops });
    expect(r.summary[D]?.idle).toBeUndefined();
    expect(r.summary[D1]).toMatchObject({ idle: 60 });
    // 起動中に作った（猶予の終わりに作った）ものは trigger_at から
    const live = { ...reply, createdAt: at("10:15") };
    expect(run(facts({ turns: [t], followUps: [live] }), at("11:00"), { ops }).summary).toEqual({
      [D]: { grace: 15, idle: 45 },
    });
  });

  test("W31: error で終了 D 10:00、以後ターンなし → resume_error を作り、D+3 10:00 に期限切れ。Idle に入らず、Expired は D+3 に1件", () => {
    const t = { ...aiEnd(at("10:00")), status: "error" as const };
    const f0 = facts({ turns: [t] });
    const st = deriveStatus(f0, at("10:01"), SETTINGS, TIMING);
    expect(st.status).toBe("error");
    const d = desiredFollowUps(f0, st, at("10:01"), SETTINGS, TIMING);
    expect(d.map((x) => [x.kind, x.triggerAt])).toEqual([["resume_error", at("10:00")]]);
    const fu = followUp({
      kind: "resume_error",
      triggerAt: at("10:00"),
      triggerTurnId: t.id,
      dedupeKey: (d[0] as { dedupeKey: string }).dedupeKey,
    });
    const f1 = facts({ turns: [t], followUps: [fu] });
    const ops = [0, 1, 2, 3].flatMap((x) => [at("09:00", x), at("18:00", x)]);
    // 期限前は放置として数えている
    expect(run(f1, at("12:00"), { ops }).summary[D]).toEqual({ grace: 15, idle: 105 });
    // D+3 10:00 に期限切れ
    const acts = reconcileFollowUps(
      f1,
      desiredFollowUps(f1, st, at("10:01", 3), SETTINGS, TIMING),
      at("10:01", 3),
      SETTINGS,
    );
    expect(acts).toEqual([
      { type: "close", id: fu.id, status: "expired", reason: "auto:expired", at: at("10:00", 3) },
    ]);
    const expired = {
      ...fu,
      status: "expired" as const,
      closedAt: at("10:00", 3),
      closeReason: "auto:expired",
    };
    const after = run(facts({ turns: [t], followUps: [expired] }), at("10:01", 3), { ops });
    for (const x of Object.values(after.summary)) expect(x.idle).toBeUndefined();
    expect(after.intervals[0]).toMatchObject({ expired: true, endReason: "expired" });
    expect(aggregateDays([], [{ closedAt: at("10:00", 3) }], SETTINGS).get(D3)?.expiredCount).toBe(
      1,
    );
  });

  test("W32: error で終了 10:00、resume_error あり、同じセッションの次のターン 10:40 → 猶予 15、放置 25。resume_error は done", () => {
    const t = { ...aiEnd(at("10:00")), status: "error" as const };
    const next = human(at("10:40"));
    const fu = followUp({ kind: "resume_error", triggerAt: at("10:00"), triggerTurnId: t.id });
    const f = facts({ turns: [t, next], followUps: [fu] });
    expect(run(f, at("12:00"), { ops: [at("09:00")] }).summary).toEqual({
      [D]: { grace: 15, idle: 25 },
    });
    const st = deriveStatus(f, at("10:41"), SETTINGS, TIMING);
    expect(st.status).not.toBe("error");
    const acts = reconcileFollowUps(
      f,
      desiredFollowUps(f, st, at("10:41"), SETTINGS, TIMING),
      at("10:41"),
      SETTINGS,
    );
    expect(acts).toEqual([
      { type: "close", id: fu.id, status: "done", reason: "auto:next_turn_ok", at: at("10:41") },
    ]);
  });

  test("W33: タスクのない your_turn（編集ありのみ、PR なし）D 10:00 → D+3 10:00 まで your_turn、以後 done（no_task_expired）。待ちはそこで終わり、放置 0・Expired 0", () => {
    const t = aiEnd(at("10:00"), { editedFiles: 2 });
    const f = facts({ turns: [t] });
    expect(deriveStatus(f, at("09:59", 3), SETTINGS, TIMING)).toMatchObject({
      status: "your_turn",
      reason: "edits",
    });
    expect(deriveStatus(f, at("10:00", 3), SETTINGS, TIMING)).toMatchObject({
      status: "done",
      reason: "no_task_expired",
    });
    const r = run(f, at("12:00", 4), {
      ops: [at("09:00"), at("09:00", 1), at("09:00", 2), at("09:00", 3)],
    });
    expect(r.intervals).toHaveLength(1);
    expect(r.intervals[0]).toMatchObject({
      end: at("10:00", 3),
      isOpen: false,
      endReason: "status_left",
      expired: false,
    });
    for (const d of Object.values(r.summary)) expect(d.idle).toBeUndefined();
    // 新しいターンが始まれば判定し直す
    const again = facts({ turns: [t, aiEnd(at("10:00", 4), { editedFiles: 1 })] });
    expect(deriveStatus(again, at("10:30", 4), SETTINGS, TIMING).status).toBe("your_turn");
  });

  test("W34: PR の初出 D 9:00、review_pr を D+1 9:00 に自分のレビューで閉じた。PR は open のまま → D+4 9:00 に done。D+1 9:00 以降の放置 0", () => {
    const t = aiEnd(at("09:00"));
    const p = pr({ firstSeenAt: at("09:00"), myReviewAt: at("09:00", 1) });
    const review = followUp({
      kind: "review_pr",
      triggerAt: at("09:00"),
      artifactRef: p.ref,
      status: "done",
      closedAt: at("09:00", 1),
      closeReason: "auto:pr_reviewed",
    });
    const f = facts({ turns: [t], prs: [p], followUps: [review] });
    expect(deriveStatus(f, at("08:59", 4), SETTINGS, TIMING).status).toBe("your_turn");
    expect(deriveStatus(f, at("09:00", 4), SETTINGS, TIMING)).toMatchObject({
      status: "done",
      reason: "no_task_expired",
    });
    const r = run(f, at("12:00", 5), {
      ops: [at("08:00"), at("18:00"), at("08:00", 1), at("18:00", 1), at("08:00", 2)],
    });
    expect(r.summary[D]?.idle).toBeGreaterThan(0);
    expect(r.summary[D1]?.idle).toBe(60); // D+1 8:00〜9:00 だけ
    expect(r.intervals[0]).toMatchObject({ end: at("09:00", 4), endReason: "status_left" });
  });

  test("W35: 質問で終了 D 10:00、返答タスクを D 10:20 に明日朝までスヌーズ → スヌーズ中もタスクありとみなし、72時間の規則では done にしない", () => {
    const { t, reply } = asked(at("10:00"));
    const snoozed = {
      ...reply,
      status: "snoozed" as const,
      snoozeUntil: at("09:00", 1),
      snoozes: [[at("10:20"), at("09:00", 1)]] as [number, number][],
    };
    // 質問の期限（72時間）より前は your_turn、タスクがあるので no_task_expired にはならない
    const f = facts({ turns: [t], followUps: [snoozed] });
    expect(deriveStatus(f, at("09:30", 1), SETTINGS, TIMING)).toMatchObject({
      status: "your_turn",
      reason: "question",
    });
    // 編集あり（期限なし）でも、スヌーズ中のタスクがある間は done にしない
    const e = facts({ turns: [{ ...t, editedFiles: 1 }], followUps: [snoozed] });
    expect(deriveStatus(e, at("10:00", 5), SETTINGS, TIMING).status).toBe("your_turn");
  });

  /** 走っているターン（人間入力 start で始まり、まだ終わっていない） */
  const runningTurn = (start: number, p: Partial<TurnFact> = {}) =>
    ({ ...human(start), endedAt: null, durationMs: null, status: "running", ...p }) as TurnFact;

  /** desired → reconcile を1回まわし、作成・クローズを事実に反映する */
  function step(f: WorkItemFacts, now: number) {
    const st = deriveStatus(f, now, SETTINGS, TIMING);
    const desired = desiredFollowUps(f, st, now, SETTINGS, TIMING);
    const actions = reconcileFollowUps(f, desired, now, SETTINGS);
    let fus = [...f.followUps];
    for (const a of actions) {
      if (a.type === "create")
        fus.push(
          followUp({
            kind: a.spec.kind,
            triggerAt: a.spec.triggerAt,
            triggerTurnId: a.spec.triggerTurnId,
            artifactRef: a.spec.artifactRef,
            dedupeKey: a.spec.dedupeKey,
            createdAt: now,
          }),
        );
      else if (a.type === "close")
        fus = fus.map((x) =>
          x.id === a.id ? { ...x, status: a.status, closedAt: a.at, closeReason: a.reason } : x,
        );
    }
    return { st, desired, actions, f: { ...f, followUps: fus } };
  }

  test("W36: hooks なしの AskUserQuestion で止まる 10:00 → 15分待たずに reply（<turn>:ask）を作る。10:40 に答えたら auto:answered。猶予 15、放置 25、区間は残る（D-049 (1)）", () => {
    const t = runningTurn(at("09:55"), { pendingQuestion: true });
    const f0 = facts({ turns: [t], sessions: [session({ lastActivityAt: at("10:00") })] });
    const s1 = step(f0, at("10:00"));
    expect(s1.st).toMatchObject({ status: "needs_input", reason: "ask_user_question" });
    expect(s1.desired.map((d) => [d.kind, d.artifactRef, d.triggerAt])).toEqual([
      ["reply", `${t.id}:ask`, at("10:00")],
    ]);
    expect(s1.actions.map((a) => a.type)).toEqual(["create"]);
    // 待っている間（10:30）は開いた区間で、タスクが出ているので放置に数える
    const mid = run(s1.f, at("10:30"), { ops: [at("09:00")] });
    expect(mid.summary).toEqual({ [D]: { grace: 15, idle: 15 } });
    expect(mid.intervals[0]).toMatchObject({ isOpen: true, estimated: true });
    // 10:40 に答えた（ターンは続いている。pending が外れ、最後の活動が 10:40）。10:41 に閉じる
    const answered = { ...t, pendingQuestion: false };
    const f2 = {
      ...s1.f,
      turns: [answered],
      sessionTurns: new Map([["s1", [answered]]]),
      sessions: [session({ lastActivityAt: at("10:40") })],
    };
    const s2 = step(f2, at("10:41"));
    expect(s2.st.status).toBe("running");
    expect(s2.actions).toEqual([
      {
        type: "close",
        id: (s1.f.followUps[0] as { id: string }).id,
        status: "done",
        reason: "auto:answered",
        at: at("10:40"),
      },
    ]);
    const after = run(s2.f, at("12:00"), { ops: [at("09:00")] });
    expect(after.summary).toEqual({ [D]: { grace: 15, idle: 25 } });
    expect(after.intervals).toHaveLength(1);
    expect(after.intervals[0]).toMatchObject({ isOpen: false, endReason: "human_input" });
    // hooks が入っていても（許可待ちの hook が無ければ）同じく reply を作る
    const withHooks = facts({
      turns: [t],
      sessions: [session({ lastActivityAt: at("10:00") })],
      hooks: [hook("UserPromptSubmit", at("09:55"))],
    });
    expect(step(withHooks, at("10:00")).desired.map((d) => d.kind)).toEqual(["reply"]);
    // 質問で終わったターンの返答タスクとは別のもの（終わったターンの (c) を「対応済み」にしない）
    expect(
      deriveStatus(
        facts({ turns: [{ ...aiEnd(at("11:00"), { endedWith: "question" }), id: t.id }] }),
        at("11:05"),
        SETTINGS,
        TIMING,
      ).reason,
    ).toBe("question");
  });

  test("W37: hooks なしの許可待ち（プロセスが idle で最終ターンが未完了）10:00 → approve をすぐ作る。ターンが進んだ 10:20 に閉じる。猶予 15、放置 5（D-049 (1)）", () => {
    const t = runningTurn(at("09:55"));
    const idle = session({
      lastActivityAt: at("10:00"),
      liveStatus: "idle",
      liveCheckedAt: at("10:01"),
    });
    const f0 = facts({ turns: [t], sessions: [idle] });
    const s1 = step(f0, at("10:01"));
    expect(s1.st).toMatchObject({ status: "needs_input", reason: "live:idle" });
    expect(s1.desired.map((d) => [d.kind, d.artifactRef, d.triggerAt])).toEqual([
      ["approve", t.id, at("10:00")],
    ]);
    // 10:20 に許可して動き出した（busy）
    const busy = session({
      lastActivityAt: at("10:20"),
      liveStatus: "busy",
      liveCheckedAt: at("10:20"),
    });
    const s2 = step({ ...s1.f, sessions: [busy] }, at("10:20"));
    expect(s2.st.status).toBe("running");
    expect(s2.actions).toMatchObject([
      { type: "close", status: "done", reason: "auto:next_turn_ok", at: at("10:20") },
    ]);
    expect(run(s2.f, at("12:00"), { ops: [at("09:00")] }).summary).toEqual({
      [D]: { grace: 15, idle: 5 },
    });
    // 設定で approve をオフにしたら作らない
    const off = { ...SETTINGS, followUpKinds: { ...SETTINGS.followUpKinds, approve: false } };
    expect(desiredFollowUps(f0, s1.st, at("10:01"), off, TIMING).map((d) => d.kind)).toEqual([]);
  });
});

describe("countedResponseMs: 平均応答時間は猶予と放置の区間だけで数える（D-057）", () => {
  test("W6 のように夜をまたいだ返答（壁時計 14h40m）→ 猶予 5 + 翌朝の猶予の残り 10 + 放置 20 = 35分", () => {
    const { t, reply } = asked(at("18:50"), {}, at("09:30", 1));
    const f = facts({ turns: [t, human(at("09:30", 1))], followUps: [reply] });
    const r = run(f, at("12:00", 1), { ops: [at("09:00"), at("18:55"), at("09:00", 1)] });
    const fu = { triggerAt: at("18:50"), engagedAt: null, closedAt: at("09:30", 1) };
    expect(fu.closedAt - fu.triggerAt).toBe((14 * 60 + 40) * MIN);
    expect(countedResponseMs(fu, r.segments)).toBe(35 * MIN);
  });

  test("会議中・スヌーズ中は数えない。⏎（engaged_at）で止める", () => {
    const { t, reply } = asked(at("10:00"));
    const snoozed = {
      ...reply,
      snoozes: [[at("11:00"), at("11:30")]] as [number, number][],
      engagedAt: at("12:00"),
      status: "done" as const,
      closedAt: at("12:10"),
      closeReason: "manual",
    };
    const f = facts({ turns: [t], followUps: [snoozed] });
    const r = run(f, at("13:00"), {
      ops: [at("09:00")],
      events: [busyEvent(at("10:30"), at("10:45"))],
    });
    // 10:00〜12:00 = 猶予 15、放置 15（10:15〜10:30）+ 15（10:45〜11:00）+ 30（11:30〜12:00）、会議 15、スヌーズ 30
    expect(
      countedResponseMs(
        { triggerAt: at("10:00"), engagedAt: at("12:00"), closedAt: at("12:10") },
        r.segments,
      ),
    ).toBe(75 * MIN);
  });

  test("窓と重なる待ち区間が無ければ null（平均に入れない）。終わりが始まり以前なら 0", () => {
    const fu = { triggerAt: at("10:00"), engagedAt: null, closedAt: at("11:00") };
    expect(countedResponseMs(fu, [])).toBeNull();
    expect(
      countedResponseMs(fu, [{ kind: "excluded", start: at("12:00"), end: at("13:00") }]),
    ).toBeNull();
    expect(
      countedResponseMs(fu, [{ kind: "excluded", start: at("10:00"), end: at("11:00") }]),
    ).toBe(0);
    expect(countedResponseMs({ ...fu, closedAt: at("10:00") }, [])).toBe(0);
  });
});

/** 走っている途中で許可待ちになったターン（end はトランスクリプトの最後の活動） */
function turn0(start: number, end: number) {
  return { ...human(start), endedAt: end, status: "completed" as const };
}

describe("手で作った返答タスクの待ち（D-066 (2)）", () => {
  test("質問と判定されなかったターン 10:00、10:30 に y、人間入力 11:00 → 待ちはターン終了から。放置はタスクを作ってから", () => {
    const t = aiEnd(at("10:00"));
    const reply = followUp({
      kind: "reply",
      triggerAt: at("10:30"),
      createdAt: at("10:30"),
      triggerTurnId: t.id,
      artifactRef: `${t.id}:manual`,
      status: "done",
      closedAt: at("11:00"),
      closeReason: "auto:human_input",
    });
    const f = facts({ turns: [t, human(at("11:00"))], followUps: [reply] });
    const r = run(f, at("12:00"), { ops: [at("09:00")] });
    expect(r.intervals.map((i) => [i.start, i.end, i.followUpId])).toEqual([
      [at("10:00"), at("11:00"), reply.id],
    ]);
    expect(r.summary).toEqual({ [D]: { grace: 15, no_task: 15, idle: 30 } });
  });
});

describe("在席のサンプル（D-105・D-110 (2)・D-139、ADR 0013）", () => {
  const T = 5 * MIN;
  type Sample = { at: number; idleMs: number | null; locked: boolean; offConsole: boolean };
  const sample = (
    atMs: number,
    idleMs: number | null,
    p: { locked?: boolean; off?: boolean } = {},
  ): Sample => ({
    at: atMs,
    idleMs,
    locked: p.locked ?? false,
    offConsole: p.off ?? false,
  });

  /** サンプルの列を保存の形（入力のあった区間）にする（デーモンの PresenceService と同じ手順） */
  function record(
    samples: Sample[],
    init: { rows?: PresenceRow[]; prev?: PrevSample | null } = {},
  ) {
    const rows: PresenceRow[] = [...(init.rows ?? [])];
    let prev: PrevSample | null = init.prev ?? null;
    for (const s of samples) {
      const step = presenceStep(rows.at(-1) ?? null, s, prev);
      if (step.update) rows[rows.length - 1] = step.update;
      if (step.insert) rows.push(step.insert);
      prev = step.prev;
    }
    return { rows, prev };
  }
  /** from から to まで 30 秒ごと。idle(t) は最後の入力からの経過 */
  const every30 = (from: number, to: number, lastInputAt: (t: number) => number) => {
    const out: Sample[] = [];
    for (let t = from; t <= to; t += 30_000) out.push(sample(t, t - lastInputAt(t)));
    return out;
  };

  test("保存するのは入力のあった区間で、T は読むときに足す。終わりは続けて見ていたサンプルの時刻を超えない", () => {
    // 10:00 から 10:00:20 まで入力し、そのあと 10:07 までサンプルだけ続く
    const lastIn = (t: number) => Math.min(t - 5000, at("10:00") + 20_000);
    const { rows } = record(every30(at("10:00"), at("10:07"), lastIn));
    expect(rows).toEqual([
      { start: at("10:00") - 5000, end: at("10:00") + 20_000, seenUntil: at("10:07") },
    ]);
    expect(expandPresence(rows, T)).toEqual([[at("10:00") - 5000, at("10:05") + 20_000]]);
    // T を変えれば同じ行から数え直せる（D-139）
    expect(expandPresence(rows, 2 * MIN)).toEqual([[at("10:00") - 5000, at("10:02") + 20_000]]);
    expect(expandPresence(rows, 10 * MIN)).toEqual([[at("10:00") - 5000, at("10:07")]]);
    // 途中（10:04:30）までしか見ていなければ、そこまで
    const mid = record(every30(at("10:00"), at("10:04") + 30_000, lastIn)).rows;
    expect(expandPresence(mid, T)).toEqual([[at("10:00") - 5000, at("10:04") + 30_000]]);
  });

  test("入力の間が 2 分以内なら同じ区間、それより長ければ区間を分けて残す（短い T でも数え直せる）", () => {
    // 10:00:00 と 10:01:30 と 10:05:00 に入力。10:10 まで見ている
    const inputs = [at("10:00"), at("10:01") + 30_000, at("10:05")];
    const lastIn = (t: number) => Math.max(...inputs.filter((x) => x <= t));
    const { rows } = record(every30(at("10:00"), at("10:10"), lastIn));
    expect(rows).toEqual([
      { start: at("10:00"), end: at("10:01") + 30_000, seenUntil: at("10:05") },
      { start: at("10:05"), end: at("10:05"), seenUntil: at("10:10") },
    ]);
    expect(expandPresence(rows, T)).toEqual([[at("10:00"), at("10:10")]]);
    expect(expandPresence(rows, 2 * MIN)).toEqual([
      [at("10:00"), at("10:03") + 30_000],
      [at("10:05"), at("10:07")],
    ]);
  });

  test("画面ロック中・別ユーザーに切り替え中・読めないときは足さず、続きも延ばさない", () => {
    const first = record([sample(at("10:00"), 1000), sample(at("10:00") + 30_000, 31_000)]);
    for (const s of [
      sample(at("10:01"), 1000, { locked: true }),
      sample(at("10:01"), 1000, { off: true }),
      sample(at("10:01"), null),
    ]) {
      const r = record([s], first);
      expect(r.rows).toEqual(first.rows);
      expect(r.prev).toEqual({ at: at("10:01"), lastInput: null });
    }
  });

  test("2分以上サンプルが空いたら（スリープ）、その間は不在。空いた後は前のサンプルより後の入力だけを証拠にする", () => {
    const before = record([sample(at("10:00"), 1000), sample(at("10:00") + 30_000, 31_000)]);
    // スリープの前の入力のまま（入力なし）→ 足さない。前の区間の続きも延ばさない
    const slept = record([sample(at("11:00"), 60 * MIN)], before);
    expect(slept.rows).toEqual(before.rows);
    expect(expandPresence(slept.rows, T)).toEqual([[at("10:00") - 1000, at("10:00") + 30_000]]);
    // 起こしたときの入力（10秒前）→ そこから
    const woke = record([sample(at("11:00"), 10_000)], before);
    expect(expandPresence(woke.rows, T)).toEqual([
      [at("10:00") - 1000, at("10:00") + 30_000],
      [at("11:00") - 10_000, at("11:00")],
    ]);
    expect(PRESENCE_MAX_GAP_MS).toBe(2 * MIN);
    // 起動直後（前のサンプルなし）は1間隔より前の入力を証拠にしない
    expect(record([sample(at("11:00"), 2 * MIN)]).rows).toEqual([]);
    expect(record([sample(at("11:00"), 10_000)]).rows).toEqual([
      { start: at("11:00") - 10_000, end: at("11:00") - 10_000, seenUntil: at("11:00") },
    ]);
  });

  test("前回の最後の区間を前のサンプルとして引き継ぐと、デーモンの再起動で続きが切れない（D-139 (3)）", () => {
    // 10:00 に入力、10:01 で停止、10:01:40 に起動して最初のサンプル（入力 1 分 40 秒前）
    const before = record(every30(at("10:00"), at("10:01"), () => at("10:00")));
    const last = before.rows.at(-1);
    if (!last?.seenUntil) throw new Error("no row");
    const carried = record([sample(at("10:01") + 40_000, 100_000)], {
      rows: before.rows,
      prev: { at: last.seenUntil, lastInput: last.end },
    });
    expect(expandPresence(carried.rows, T)).toEqual([[at("10:00"), at("10:01") + 40_000]]);
    // 引き継がなければ、起動の前の入力は証拠にならず、10:01 で切れる
    const fresh = record([sample(at("10:01") + 40_000, 100_000)], { rows: before.rows });
    expect(expandPresence(fresh.rows, T)).toEqual([[at("10:00"), at("10:01")]]);
  });

  test("expandPresence: 重なる・接する区間はまとめ、長さ 0 は落とす。seenUntil が無い行は上限なし", () => {
    expect(
      expandPresence(
        [
          { start: at("10:00"), end: at("10:00"), seenUntil: at("10:00") },
          { start: at("10:10"), end: at("10:12"), seenUntil: null },
          { start: at("10:15"), end: at("10:16"), seenUntil: at("10:17") },
        ],
        T,
      ),
    ).toEqual([[at("10:10"), at("10:17")]]);
  });

  /** D-139 より前の記録の仕方（保存のときに T を足していた）。同じサンプルの列から同じ在席になることの確認用 */
  function legacy(samples: Sample[], tailMs: number): [number, number][] {
    const spans: [number, number][] = [];
    let prev: PrevSample | null = null;
    for (const s of samples) {
      const valid = !(s.locked || s.offConsole || s.idleMs === null || s.idleMs < 0);
      if (valid && s.idleMs !== null) {
        const lastInput = s.at - s.idleMs;
        const gap = prev === null || s.at - prev.at >= PRESENCE_MAX_GAP_MS;
        const out: [number, number][] = [];
        if (!gap && prev !== null && prev.lastInput !== null) {
          const end = Math.min(prev.lastInput + tailMs, s.at);
          if (end > prev.at) out.push([prev.at, end]);
        }
        const floor = gap ? (prev?.at ?? s.at - 30_000) : Number.NEGATIVE_INFINITY;
        const end = Math.min(lastInput + tailMs, s.at);
        if (lastInput > floor && end > lastInput) out.push([lastInput, end]);
        for (const r of out.sort((a, b) => a[0] - b[0])) {
          const last = spans.at(-1);
          if (last && r[0] <= last[1]) {
            last[0] = Math.min(last[0], r[0]);
            last[1] = Math.max(last[1], r[1]);
          } else spans.push([...r]);
        }
        prev = { at: s.at, lastInput };
      } else prev = { at: s.at, lastInput: null };
    }
    return spans;
  }

  test("入力・スリープ・ロックの列から、どの T でも D-139 より前の記録の仕方と同じ在席になる", () => {
    // 疑似乱数（固定の種）で 1 日分の入力・スリープ・ロックを作る。スリープの明けとロックを解いたときは入力から始める
    let seed = 139;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let round = 0; round < 20; round++) {
      const samples: Sample[] = [];
      let t = at("09:00");
      // 起動して最初のサンプル（09:00:30）は入力 20 秒前から
      let lastInput = t + 10_000;
      for (let i = 0; i < 1200; i++) {
        const r = rnd();
        if (r < 0.01) {
          t += (3 + Math.floor(rnd() * 60)) * MIN; // スリープ
          lastInput = t - Math.floor(rnd() * 20_000);
        } else if (r < 0.02) {
          // 画面ロック（数サンプル）。解くときは入力がある
          for (let k = 1 + Math.floor(rnd() * 6); k > 0; k--) {
            t += 30_000;
            samples.push(sample(t, t - lastInput, { locked: true }));
          }
          t += 30_000;
          lastInput = t - Math.floor(rnd() * 20_000);
        } else {
          t += 30_000;
          if (rnd() < (round % 2 === 0 ? 0.3 : 0.08)) lastInput = t - Math.floor(rnd() * 30_000);
        }
        samples.push(sample(t, t - lastInput));
      }
      const { rows } = record(samples);
      for (const tail of [2, 3, 5, 10, 15].map((m) => m * MIN))
        expect(expandPresence(rows, tail)).toEqual(legacy(samples, tail));
    }
  });
});

describe("頼んだ AI（D-107。plan §B.2）", () => {
  test("W70: 依頼 9:50、質問・編集なしで 10:00 に終わる → 頼んだタスクが出ているので AI 完了から猶予 15、放置 45（人間入力 11:00）", () => {
    const t = aiEnd(at("10:00"), { endedWith: "end_turn" });
    const f = facts({
      turns: [t, turn({ start: at("11:00"), end: null })],
      launch: { at: at("09:50"), closedAt: null },
    });
    expect(run(f, at("12:00"), { ops: [at("09:00")] }).summary).toEqual({
      [D]: { grace: 15, idle: 45 },
    });
  });

  test("W71: 同上で 10:30 に頼んだタスクを完了 → 待ちはそこで終わる（猶予 15、放置 15）", () => {
    const t = aiEnd(at("10:00"), { endedWith: "end_turn" });
    const f = facts({ turns: [t], launch: { at: at("09:50"), closedAt: at("10:30") } });
    expect(run(f, at("12:00"), { ops: [at("09:00")] }).summary).toEqual({
      [D]: { grace: 15, idle: 15 },
    });
  });

  test("W72: 編集ありで終わった（返答タスクなし）→ 頼んだタスクが出ているので放置に数える（頼んでいなければ集計外 no_task）", () => {
    const t = aiEnd(at("10:00"), { endedWith: "end_turn", editedFiles: 3 });
    const launched = facts({
      turns: [t, turn({ start: at("10:40"), end: null })],
      launch: { at: at("09:50"), closedAt: null },
    });
    expect(run(launched, at("12:00"), { ops: [at("09:00")] }).summary).toEqual({
      [D]: { grace: 15, idle: 25 },
    });
    const plain = facts({ turns: [t, turn({ start: at("10:40"), end: null })] });
    expect(run(plain, at("12:00"), { ops: [at("09:00")] }).summary).toEqual({
      [D]: { grace: 15, no_task: 25 },
    });
  });

  test("W73: 依頼より前に終わったターンは数えない", () => {
    const t = aiEnd(at("10:00"), { endedWith: "end_turn" });
    const f = facts({ turns: [t], launch: { at: at("10:30"), closedAt: null } });
    expect(run(f, at("12:00"), { ops: [at("09:00")] }).summary).toEqual({});
  });
});
