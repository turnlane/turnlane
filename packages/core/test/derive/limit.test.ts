/**
 * 利用枠で止まったセッション（上限待ち）と、エラーの状態の期限の表駆動テスト。
 * - rate_limit の StopFailure → error にせず上限待ち（カードは done・理由 rate_limit）。終わり（until）は利用枠のリセットの時刻、
 *   無ければ停止から 5 時間
 * - until を過ぎたら状態は無し、再開のタスク（resume_error `<turn>:limit`）を 1 件。期限なし（日をまたいでも残る）。
 *   新しい入力・そのセッションの Stop で閉じる。対応不要にしたら作り直さない
 * - それ以外のエラーの状態は停止から 1 時間で閉じる。再開のタスクは 72 時間のまま
 */
import { describe, expect, test } from "bun:test";
import {
  type ClaudeLimitFact,
  deriveStatus,
  desiredFollowUps,
  type FollowUpFact,
  isLimitResume,
  LIMIT_EXTENDED_REASON,
  LIMIT_REF_SUFFIX,
  limitResetAt,
  limitWaitOf,
  reconcileFollowUps,
  sessionStatus,
  type WorkItemFacts,
  waitIntervals,
} from "../../src/derive/index.ts";
import {
  at,
  facts,
  followUp,
  hook,
  human,
  SETTINGS,
  session,
  shuffled,
  TIMING,
  turn,
} from "./helpers.ts";

const ACCOUNT = "/fixture/config-a";

const status = (f: WorkItemFacts, now: number) => {
  const a = deriveStatus(f, now, SETTINGS, TIMING);
  expect(deriveStatus(shuffled(f), now, SETTINGS, TIMING)).toEqual(a);
  return a;
};

const desired = (f: WorkItemFacts, now: number) =>
  desiredFollowUps(f, status(f, now), now, SETTINGS, TIMING);

/** 10:00 に始まり 10:20 に利用枠で止まったターン（トランスクリプトはエラーで終わる） */
function limited(p: { limits?: ClaudeLimitFact[]; configRoot?: string | null } = {}) {
  const t = turn({ start: at("10:00"), end: at("10:20"), status: "error", endedWith: "error" });
  const f = facts({
    turns: [t],
    sessions: [session({ lastActivityAt: at("10:20") })],
    hooks: [
      hook("UserPromptSubmit", at("10:00"), { configRoot: p.configRoot ?? ACCOUNT }),
      hook("StopFailure", at("10:20"), {
        errorType: "rate_limit",
        configRoot: p.configRoot === undefined ? ACCOUNT : p.configRoot,
      }),
    ],
    ...(p.limits ? { claudeLimits: p.limits } : {}),
  });
  return { t, f };
}

const limitRow = (p: Partial<ClaudeLimitFact> = {}): ClaudeLimitFact => ({
  account: ACCOUNT,
  fiveHourPct: 100,
  fiveHourResetsAt: at("12:00"),
  sevenDayPct: 40,
  sevenDayResetsAt: at("10:00", 3),
  ...p,
});

describe("上限待ち（rate_limit）", () => {
  test("rate_limit の StopFailure は error にしない。カードは done（rate_limit）、再開のタスクは作らない", () => {
    const { f } = limited();
    const now = at("11:00");
    expect(status(f, now)).toEqual({ status: "done", reason: "rate_limit", estimated: false });
    expect(sessionStatus(f, f.sessions[0] as never, now, TIMING)).toBeNull();
    expect(desired(f, now)).toEqual([]);
  });

  test("hook が無くても StopFailure が生きていれば（ターンが走ったまま）上限待ち", () => {
    const t = turn({ start: at("10:00"), end: null });
    const f = facts({
      turns: [t],
      sessions: [session({ lastActivityAt: at("10:20") })],
      hooks: [hook("StopFailure", at("10:20"), { errorType: "rate_limit" })],
    });
    expect(status(f, at("10:21"))).toEqual({
      status: "done",
      reason: "rate_limit",
      estimated: false,
    });
    expect(limitWaitOf(f, at("10:21"))).toMatchObject({ at: at("10:20"), until: at("15:20") });
  });

  test("until: 利用枠が無ければ停止から 5 時間（untilKnown: false）", () => {
    const { f } = limited();
    expect(limitWaitOf(f, at("11:00"))).toMatchObject({
      kind: "limit",
      at: at("10:20"),
      until: at("15:20"),
      untilKnown: false,
    });
  });

  test("until: アカウント（hook の設定ディレクトリ）の利用枠の、停止を含む枠のリセットの時刻", () => {
    const { f } = limited({ limits: [limitRow()] });
    expect(limitWaitOf(f, at("11:00"))).toMatchObject({ until: at("12:00"), untilKnown: true });
    // 末尾の / の違いは同じアカウント
    const g = limited({ limits: [limitRow({ account: `${ACCOUNT}/` })] }).f;
    expect(limitWaitOf(g, at("11:00"))?.until).toBe(at("12:00"));
  });

  test("until: 別のアカウントの利用枠は使わない。設定ディレクトリが分からなければ 5 時間", () => {
    const other = limited({ limits: [limitRow({ account: "/fixture/config-b" })] }).f;
    expect(limitWaitOf(other, at("11:00"))?.until).toBe(at("15:20"));
    const none = limited({ limits: [limitRow()], configRoot: null }).f;
    // UserPromptSubmit の hook の設定ディレクトリで結び付ける
    expect(limitWaitOf(none, at("11:00"))?.until).toBe(at("12:00"));
    const bare = facts({
      ...none,
      hooks: none.hooks.map((h) => ({ ...h, configRoot: null })),
    });
    expect(limitWaitOf(bare, at("11:00"))?.until).toBe(at("15:20"));
  });

  test("limitResetAt: 停止の後に始まった枠では延ばさない。使い切った 7 日の枠があればそのリセットまで", () => {
    // 停止（10:20）の後に新しい 5 時間の枠（11:00〜16:00）の値で上書きされた
    expect(
      limitResetAt(at("10:20"), ACCOUNT, [
        limitRow({ fiveHourResetsAt: at("16:00"), sevenDayResetsAt: null }),
      ]),
    ).toBeNull();
    // 7 日の枠を使い切っている（5 時間の枠は余っている）
    expect(
      limitResetAt(at("10:20"), ACCOUNT, [limitRow({ fiveHourPct: 30, sevenDayPct: 100 })]),
    ).toBe(at("10:00", 3));
    // どちらも使い切っていなければ早い方
    expect(limitResetAt(at("10:20"), ACCOUNT, [limitRow({ fiveHourPct: 98 })])).toBe(at("12:00"));
    expect(limitResetAt(at("10:20"), null, [limitRow()])).toBeNull();
  });

  test("until を過ぎたら上限待ちは終わり、状態は無し。再開のタスク（`:limit`）を until に 1 件", () => {
    const { t, f } = limited({ limits: [limitRow()] });
    const now = at("12:01");
    expect(limitWaitOf(f, now)).toBeNull();
    expect(sessionStatus(f, f.sessions[0] as never, now, TIMING)).toBeNull();
    expect(status(f, now)).toEqual({ status: "done", reason: "ended", estimated: true });
    const d = desired(f, now);
    expect(d).toEqual([
      {
        kind: "resume_error",
        artifactRef: `${t.id}${LIMIT_REF_SUFFIX}`,
        dedupeKey: `wi|resume_error|${t.id}${LIMIT_REF_SUFFIX}`,
        triggerAt: at("12:00"),
        triggerTurnId: t.id,
      },
    ]);
    expect(isLimitResume(d[0] as never)).toBe(true);
    expect(reconcileFollowUps(f, d, now, SETTINGS).map((a) => a.type)).toEqual(["create"]);
  });

  test("再開のタスクが出ている間のカードは your_turn（resume_limit）。期限なし（3 時間後も翌日も残る）", () => {
    const { t, f: base } = limited({ limits: [limitRow()] });
    const fu = limitFollowUp(t.id, at("12:00"));
    const f = { ...base, followUps: [fu] };
    for (const now of [at("12:30"), at("15:00"), at("09:00", 1), at("18:00", 1)]) {
      expect(status(f, now)).toEqual({
        status: "your_turn",
        reason: "resume_limit",
        estimated: false,
      });
      expect(reconcileFollowUps(f, desired(f, now), now, SETTINGS)).toEqual([]);
    }
  });

  test("明けてから時間がたって見つけた「再開できる」も作る（72 時間より前に明けたもの）", () => {
    const { f } = limited({ limits: [limitRow()] });
    for (const now of [at("15:05"), at("11:00", 1)]) {
      const d = desired(f, now);
      expect(d).toHaveLength(1);
      expect(reconcileFollowUps(f, d, now, SETTINGS).map((a) => a.type)).toEqual(["create"]);
    }
    // 初回の取り込みで過去の履歴をタスクにしない（72 時間）規則はそのまま
    const old = at("12:00", 3);
    expect(reconcileFollowUps(f, desired(f, old), old, SETTINGS)).toEqual([]);
  });

  test("対応不要にした「再開できる」は作り直さない（閉じたまま）", () => {
    const { t, f: base } = limited({ limits: [limitRow()] });
    const fu = limitFollowUp(t.id, at("12:00"), {
      status: "dismissed",
      closedAt: at("12:30"),
      closeReason: "dismissed",
    });
    const f = { ...base, followUps: [fu] };
    const now = at("10:00", 1);
    expect(desired(f, now)).toHaveLength(1);
    expect(reconcileFollowUps(f, desired(f, now), now, SETTINGS)).toEqual([]);
    expect(status(f, now).reason).not.toBe("resume_limit");
  });

  test("そのセッションの Stop（止まった後に正常に終わった）で閉じる", () => {
    // トランスクリプトのターンはまだ走っている（hook だけで止まったと分かる）
    const t = turn({ start: at("10:00"), end: null });
    const base = facts({
      turns: [t],
      sessions: [session({ lastActivityAt: at("10:20") })],
      hooks: [hook("StopFailure", at("10:20"), { errorType: "rate_limit" })],
    });
    const fu = limitFollowUp(t.id, at("15:20"));
    const before = { ...base, followUps: [fu] };
    expect(reconcileFollowUps(before, desired(before, at("18:00")), at("18:00"), SETTINGS)).toEqual(
      [],
    );
    const f = { ...before, hooks: [...base.hooks, hook("Stop", at("18:10"))] };
    const now = at("18:15");
    expect(desired(f, now).filter(isLimitResume)).toEqual([]);
    expect(reconcileFollowUps(f, desired(f, now), now, SETTINGS)).toEqual([
      { type: "close", id: fu.id, status: "done", reason: "auto:next_turn_ok", at: now },
    ]);
  });

  test("新しい入力が来たら再開のタスクを閉じる（その時刻）", () => {
    const { t, f: base } = limited({ limits: [limitRow()] });
    const fu = limitFollowUp(t.id, at("12:00"));
    const next = human(at("12:10"));
    const f = facts({
      hooks: base.hooks,
      claudeLimits: base.claudeLimits ?? [],
      turns: [t, next],
      sessions: [session({ lastActivityAt: at("12:12") })],
      followUps: [fu],
    });
    const now = at("12:15");
    expect(reconcileFollowUps(f, desired(f, now), now, SETTINGS)).toEqual([
      { type: "close", id: fu.id, status: "done", reason: "auto:human_input", at: at("12:10") },
    ]);
  });

  test("上限待ちの間に入力したら、明けても再開のタスクは作らない", () => {
    const { t, f: base } = limited({ limits: [limitRow()] });
    const f = facts({
      hooks: base.hooks,
      claudeLimits: base.claudeLimits ?? [],
      turns: [
        t,
        turn({ start: at("11:00"), end: at("11:01"), status: "error", endedWith: "error" }),
      ],
      sessions: [session({ lastActivityAt: at("11:01") })],
    });
    // 11:00 のターンは利用枠の hook を持たない（別のエラー）。上限待ちのタスクは作らない
    expect(desired(f, at("12:30")).filter(isLimitResume)).toEqual([]);
  });

  test("上限待ちの間は編集ありでも自分の番にしない（明けた後の再開のタスクに任せる）", () => {
    const t = turn({ start: at("10:00"), end: null, editedFiles: 2 });
    const f = facts({
      turns: [t],
      sessions: [session({ lastActivityAt: at("10:20") })],
      hooks: [hook("StopFailure", at("10:20"), { errorType: "rate_limit" })],
    });
    expect(status(f, at("11:00")).reason).toBe("rate_limit");
  });

  test("待ち区間: 停止から、明けた後の再開のタスクが閉じるまで（期限なし）。タスクは明けてから", () => {
    const { t, f: base } = limited({ limits: [limitRow()] });
    const open = waitIntervals(base, at("11:00"), SETTINGS);
    expect(open).toMatchObject([
      {
        waitKey: `turn:${t.id}:error`,
        start: at("10:20"),
        end: at("11:00"),
        isOpen: true,
        shown: [],
      },
    ]);
    // 翌日もまだ開いている
    const fu = limitFollowUp(t.id, at("12:00"), { createdAt: at("12:00") });
    const next = waitIntervals({ ...base, followUps: [fu] }, at("09:00", 1), SETTINGS);
    expect(next).toMatchObject([{ start: at("10:20"), end: at("09:00", 1), isOpen: true }]);
    // 対応不要で閉じる
    const dismissed = { ...fu, status: "dismissed" as const, closedAt: at("10:00", 1) };
    const done = waitIntervals({ ...base, followUps: [dismissed] }, at("11:00", 1), SETTINGS);
    expect(done).toMatchObject([
      {
        start: at("10:20"),
        end: at("10:00", 1),
        isOpen: false,
        endReason: "dismissed",
        followUpId: fu.id,
      },
    ]);
    // 以前の版で期限切れにしたもの（閉じた時刻で終わる）
    const expired = {
      ...fu,
      status: "expired" as const,
      closedAt: at("13:00"),
      closeReason: "auto:expired",
    };
    expect(waitIntervals({ ...base, followUps: [expired] }, at("14:00"), SETTINGS)).toMatchObject([
      { end: at("13:00"), isOpen: false, endReason: "expired" },
    ]);
  });
});

describe("明ける時刻が伸びた上限待ちの再開のタスク", () => {
  // 5 時間の見込み（15:20）で作った後、利用枠の値が届いて 7 日の枠の明け（3 日後の 10:00）まで伸びた
  const weekly = at("10:00", 3);
  const extended = () => limited({ limits: [limitRow({ fiveHourPct: 30, sevenDayPct: 100 })] });

  test("開いていた `:limit` は「まだ明けていない」として閉じる（完了と数えない。auto:limit_extended）", () => {
    const { t, f: base } = extended();
    const fu = limitFollowUp(t.id, at("15:20"));
    const f = { ...base, followUps: [fu] };
    const now = at("16:00");
    expect(limitWaitOf(f, now)?.until).toBe(weekly);
    expect(reconcileFollowUps(f, desired(f, now), now, SETTINGS)).toEqual([
      { type: "close", id: fu.id, status: "superseded", reason: LIMIT_EXTENDED_REASON, at: now },
    ]);
  });

  test("自動で閉じた行（auto:limit_extended・旧版の auto:next_turn_ok）は、明けたら同じ行を開き直す（trigger_at を明けの時刻に）", () => {
    const { t, f: base } = extended();
    for (const [status, reason] of [
      ["superseded", LIMIT_EXTENDED_REASON],
      ["done", "auto:next_turn_ok"],
    ] as const) {
      const fu = limitFollowUp(t.id, at("15:20"), {
        status,
        closedAt: at("16:00"),
        closeReason: reason,
      });
      const f = { ...base, followUps: [fu] };
      // 明ける前は何もしない（後でに出る）
      expect(reconcileFollowUps(f, desired(f, at("12:00", 1)), at("12:00", 1), SETTINGS)).toEqual(
        [],
      );
      const now = weekly + 60_000;
      expect(reconcileFollowUps(f, desired(f, now), now, SETTINGS)).toEqual([
        { type: "reopen", id: fu.id, triggerAt: weekly },
      ]);
      // 開き直した後は同じ行のまま（もう一度は開き直さない）
      const reopened = {
        ...f,
        followUps: [
          { ...fu, status: "open" as const, triggerAt: weekly, closedAt: null, closeReason: null },
        ],
      };
      expect(reconcileFollowUps(reopened, desired(reopened, now), now, SETTINGS)).toEqual([]);
    }
  });

  test("利用者が閉じた行（dismissed）は開き直さない。明ける時刻が伸びていなければ開き直さない", () => {
    const { t, f: base } = extended();
    const now = weekly + 60_000;
    const dismissed = limitFollowUp(t.id, at("15:20"), {
      status: "dismissed",
      closedAt: at("16:00"),
      closeReason: "dismissed",
    });
    const f = { ...base, followUps: [dismissed] };
    expect(reconcileFollowUps(f, desired(f, now), now, SETTINGS)).toEqual([]);
    const same = limitFollowUp(t.id, weekly, {
      status: "done",
      closedAt: weekly + 1000,
      closeReason: "auto:next_turn_ok",
    });
    const g = { ...base, followUps: [same] };
    expect(reconcileFollowUps(g, desired(g, now), now, SETTINGS)).toEqual([]);
  });
});

describe("エラー（rate_limit 以外）", () => {
  const failed = () => {
    const t = turn({ start: at("10:00"), end: at("10:20"), status: "error", endedWith: "error" });
    const f = facts({
      turns: [t],
      sessions: [session({ lastActivityAt: at("10:20") })],
      hooks: [hook("StopFailure", at("10:20"), { errorType: "server_error" })],
    });
    return { t, f };
  };

  test("エラーの状態は停止から 1 時間。過ぎたら止まっているだけ（状態は無し）", () => {
    const { f } = failed();
    expect(status(f, at("11:19"))).toEqual({
      status: "error",
      reason: "hook:stop_failure",
      estimated: false,
    });
    expect(sessionStatus(f, f.sessions[0] as never, at("11:20"), TIMING)).toBeNull();
    expect(status(f, at("11:20"))).toEqual({ status: "done", reason: "ended", estimated: true });
  });

  test("hook の無いエラー（turn:error）も 1 時間で閉じる", () => {
    const t = turn({ start: at("10:00"), end: at("10:20"), status: "error", endedWith: "error" });
    const f = facts({ turns: [t] });
    expect(status(f, at("11:00")).status).toBe("error");
    expect(status(f, at("11:21")).status).toBe("done");
  });

  test("再開のタスクは 1 時間を過ぎても残り、72 時間で期限切れ。出ている間のカードは your_turn（resume_error）", () => {
    const { t, f: base } = failed();
    expect(desired(base, at("10:21")).map((x) => [x.kind, x.artifactRef])).toEqual([
      ["resume_error", t.id],
    ]);
    const fu = followUp({ kind: "resume_error", triggerAt: at("10:20"), triggerTurnId: t.id });
    const f = { ...base, followUps: [fu] };
    // 1 時間を過ぎても、あるべき集合に残る（閉じない）
    expect(reconcileFollowUps(f, desired(f, at("12:00")), at("12:00"), SETTINGS)).toEqual([]);
    expect(status(f, at("12:00"))).toEqual({
      status: "your_turn",
      reason: "resume_error",
      estimated: false,
    });
    const exp = at("10:20", 3);
    expect(reconcileFollowUps(f, desired(f, exp), exp, SETTINGS)).toEqual([
      { type: "close", id: fu.id, status: "expired", reason: "auto:expired", at: exp },
    ]);
  });
});

function limitFollowUp(
  turnId: string,
  triggerAt: number,
  p: Partial<FollowUpFact> = {},
): FollowUpFact {
  const ref = `${turnId}${LIMIT_REF_SUFFIX}`;
  return followUp({
    kind: "resume_error",
    triggerAt,
    triggerTurnId: turnId,
    artifactRef: ref,
    dedupeKey: `wi|resume_error|${ref}`,
    ...p,
  });
}
