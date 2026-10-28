/**
 * カード（WorkItem）の5状態の判定（phase0-plan 3.3、ai-session-ingestion 4.3）。
 * 優先順位: error > needs_input > running > your_turn > done。カードを構成するセッションごとに判定し、最も重いものを採る。
 *
 * your_turn の条件（ターン終了後、人間の入力が無い間）。理由は (c) > (a) > (b) の順に採る（AI の問いへの返答は
 * PR の確認より先に自分の番。fix-pr-link）:
 *   (a) open な PR がある（期限なし。D-032）
 *   (b) 最終ターンで編集あり。既定ブランチのカードでは「今も未コミットの変更がある」も条件。git 管理外は24時間で期限切れ
 *   (c) 質問で終了（締めの決まり文句は除く）。72時間で期限切れ。返答タスクが閉じた（返答済み・解決済み（推定）・
 *       対応不要・期限切れ）ターンは条件から外す
 *   (d) トランスクリプトに終わりがまだ無いが、Stop の hook で終わった（中身が分かるまでの推定。理由 'hook:stop'）。
 *       トランスクリプトが追いついたら (a)〜(c) の判定に戻る（同じターンなので返答タスクは同じもの）
 * 条件が無いターン終了は待たずに done。セッションが別のカードの作業へ移った（後に人間の入力がある）場合も done。
 * manual_done_at は、それより後にターンが始まっていなければ有効（your_turn → done）。
 * タスクのない your_turn は72時間で done（no_task_expired。D-048 (4)）: YOUR TURN のタスク（reply / review_pr /
 * approve / resume_error。open / snoozed）が1件も無い状態が、起点（待ちの始点とフォローアップが最後に閉じた時刻の
 * 遅い方）から72時間続いたら done にする。needs_input と error には適用しない。
 */
import type { TurnlaneSettings } from "../settings.ts";
import { openTurnStopEnd } from "./ai-time.ts";
import {
  isClearingHook,
  isPermissionHook,
  isQuotaNotice,
  QUOTA_RESUME_DISABLED,
  QUOTA_RESUME_FIRED,
  QUOTA_RESUME_STALE,
} from "./hook-kinds.ts";
import {
  activityOf,
  isParentHook,
  openSubagentPermission,
  subagentBusy,
  subagentRunningOf,
} from "./subagent.ts";
import {
  type ClaudeLimitFact,
  type DeriveTiming,
  type HookFact,
  isHumanTurn,
  normalizeFacts,
  type PrFact,
  type SessionFact,
  type TurnFact,
  type WorkItemFacts,
  type WorkItemStatus,
} from "./types.ts";

export interface StatusResult {
  status: WorkItemStatus;
  /** 判定根拠（'hook:permission_request'、'question' など。UI の「推定」表示に使う） */
  reason: string;
  estimated: boolean;
}

const RANK: Record<WorkItemStatus, number> = {
  error: 5,
  needs_input: 4,
  running: 3,
  your_turn: 2,
  done: 1,
};

/** stopped = トランスクリプトに終わりがまだ無いが、Stop の hook で終わった（中身はまだ分からない） */
export type YourTurnReason = "pr_open" | "question" | "edits" | "stopped";

export interface YourTurnCandidate {
  turn: TurnFact;
  session: SessionFact;
  reasons: YourTurnReason[];
  /** Stop の hook で終わったとみなした時刻（トランスクリプトに終わりがあれば null） */
  stopAt: number | null;
}

export {
  isClearingHook,
  isPermissionHook,
  isQuotaNotice,
  QUOTA_RESUME_DISABLED,
  QUOTA_RESUME_FIRED,
  QUOTA_RESUME_STALE,
};

/** 上限待ちの終わりが分からないときの長さ（停止から 5 時間。Claude の 5 時間の枠） */
export const LIMIT_FALLBACK_MS = 5 * 3_600_000;
/**
 * 上限待ちの終わりが分からず、Claude Code が「明けるのが 24 時間より先なので自動で続けない」と知らせたとき
 * （quota_auto_resume_disabled の horizon。週の上限など）の長さ（停止から 24 時間）
 */
export const LIMIT_HORIZON_MS = 24 * 3_600_000;
/** 利用枠以外のエラーの状態を閉じるまでの時間（レーンの札「エラー」。再開のタスクは 72 時間のまま） */
export const ERROR_STATUS_MS = 3_600_000;
const FIVE_HOUR_MS = 5 * 3_600_000;
const SEVEN_DAY_MS = 7 * 86_400_000;

/** 上限待ちが明けた後の再開のタスクの artifact_ref の接尾辞（kind は resume_error。設定の種類も resume_error と同じ） */
export const LIMIT_REF_SUFFIX = ":limit";

export function limitRef(turnId: string): string {
  return `${turnId}${LIMIT_REF_SUFFIX}`;
}

/** 上限待ちが明けた後の再開のタスク（「再開できる」）か */
export function isLimitResume(x: { kind: string; artifactRef: string }): boolean {
  return x.kind === "resume_error" && x.artifactRef.endsWith(LIMIT_REF_SUFFIX);
}

const normAccount = (a: string) => a.replace(/\/+$/, "") || "/";

/**
 * 利用枠で止まった時刻 stopAt の上限待ちの終わり（リセットの時刻）。アカウントの利用枠のうち、stopAt を含む枠（リセットの
 * 時刻から枠の長さを引いた始まり ≤ stopAt < リセット）だけを見る（停止の後に始まった新しい枠の値で上書きされていても
 * 先へ延ばさない）。使い切った（100%）枠があればそのリセットの遅い方、無ければ早い方。分からなければ null
 */
export function limitResetAt(
  stopAt: number,
  account: string | null,
  limits: readonly ClaudeLimitFact[],
): number | null {
  if (!account) return null;
  const row = limits.find((l) => normAccount(l.account) === normAccount(account));
  if (!row) return null;
  const wins = [
    { resetsAt: row.fiveHourResetsAt, pct: row.fiveHourPct, len: FIVE_HOUR_MS },
    { resetsAt: row.sevenDayResetsAt, pct: row.sevenDayPct, len: SEVEN_DAY_MS },
  ].filter(
    (w): w is { resetsAt: number; pct: number | null; len: number } =>
      w.resetsAt !== null && w.resetsAt > stopAt && w.resetsAt - w.len <= stopAt,
  );
  if (wins.length === 0) return null;
  const full = wins.filter((w) => (w.pct ?? 0) >= 100);
  return full.length > 0
    ? Math.max(...full.map((w) => w.resetsAt))
    : Math.min(...wins.map((w) => w.resetsAt));
}

/** セッションが止まった事実（StopFailure の hook か、エラーで終わったターン） */
export interface SessionStop {
  /** limit = 利用枠（上限待ち）、error = それ以外のエラー */
  kind: "limit" | "error";
  /**
   * 止まったターン。同じ利用枠の続き（種別の無い StopFailure を前の上限待ちの続きとみなしたもの）は、最初に利用枠で
   * 止まったターン（再開のタスク `<turn>:limit` を 1 回の停止につき 1 件にする）
   */
  turnId: string;
  /** 止まった時刻（再試行で StopFailure が続くときは、その続きの最初） */
  at: number;
  /** 状態（上限待ち・エラー）が終わる時刻 */
  until: number;
  /** until を利用枠のリセットの時刻から取れた（上限待ちだけ。取れなければ停止から 5 時間） */
  untilKnown: boolean;
  reason: string;
  estimated: boolean;
}

/** セッションの最後のターンが止まったか（期限は見ない。状態・再開のタスク・待ち区間が同じ判定を使う） */
export function sessionStopOf(f: WorkItemFacts, s: SessionFact): SessionStop | null {
  if (s.isNoise) return null;
  const last = [...f.turns].reverse().find((t) => t.sessionId === s.id);
  return last ? turnStopOf(f, s, last) : null;
}

/** ターン T の hook の窓（親の hook だけ。T の後に同じセッションのターンがあれば、その始まりより前） */
function turnHooks(f: WorkItemFacts, s: SessionFact, t: TurnFact): HookFact[] {
  const next = (f.sessionTurns.get(s.id) ?? []).find(
    (x) => x.id !== t.id && x.startedAt > t.startedAt,
  )?.startedAt;
  // サブエージェントの hook（agentId 付き）は親のターンの停止に数えない
  return f.hooks.filter(
    (h) =>
      h.sessionExternalId === s.externalId &&
      !h.agentId &&
      h.occurredAt >= t.startedAt - 1000 &&
      (next === undefined || h.occurredAt < next),
  );
}

/**
 * トランスクリプトに終わりの無い開いたターン T が、Stop の hook で終わったとみなせる時刻（無ければ null）。
 * 最後の UserPromptSubmit の後に親の Stop（サブエージェントの Stop は agentId 付きで数えない）があり、その後に
 * トランスクリプトの活動が無いとき（core の openTurnStopEnd）。Codex の rollout など、トランスクリプトの取り込みが
 * hook より遅れる間に「実行中」のまま残さないために使う。トランスクリプトが追いつけば T は終わったターンになる
 */
export function turnHookStopOf(f: WorkItemFacts, s: SessionFact, t: TurnFact): number | null {
  if (t.status !== "running" || t.endedAt !== null) return null;
  return openTurnStopEnd(
    { startedAt: t.startedAt, nextStartedAt: null, sessionLastActivityAt: s.lastActivityAt },
    turnHooks(f, s, t),
  );
}

/** 止まったことを示す hook（StopFailure と、利用枠で待つ・⏎ を待つ通知） */
const isStopSignal = (h: HookFact) =>
  h.name === "StopFailure" ||
  isQuotaNotice(h, QUOTA_RESUME_DISABLED) ||
  isQuotaNotice(h, QUOTA_RESUME_STALE);

/** 止まった後に続いたことを示す hook（入力・正常な終わり・セッションの終わり・利用枠の自動再開） */
const isResumeSignal = (h: HookFact) =>
  h.name === "UserPromptSubmit" ||
  h.name === "Stop" ||
  h.name === "SessionEnd" ||
  isQuotaNotice(h, QUOTA_RESUME_FIRED);

type RawStop =
  /** untyped: 種類の無い StopFailure で、利用枠の手がかりも無い（前の上限待ちの続きかどうかを後で見る） */
  | { type: "stop"; stop: SessionStop; untyped: boolean; stale?: boolean }
  /** 止まった後に Claude Code が自動で続けた（quota_auto_resume_fired）。止まっていない */
  | { type: "resumed" }
  | { type: "none" };

function lastIndex<T>(xs: readonly T[], pred: (x: T) => boolean): number {
  for (let i = xs.length - 1; i >= 0; i--) if (pred(xs[i] as T)) return i;
  return -1;
}

/** i より後の最初の「続いた」hook の位置（無ければ末尾） */
function nextResumeIndex(hooks: readonly HookFact[], i: number): number {
  for (let j = i + 1; j < hooks.length; j++) if (isResumeSignal(hooks[j] as HookFact)) return j;
  return hooks.length;
}

/** ターン T だけを見た停止（前のターンの上限待ちの続きかは見ない） */
function rawTurnStop(f: WorkItemFacts, s: SessionFact, t: TurnFact): RawStop {
  const hooks = turnHooks(f, s, t);
  const sigIdx = lastIndex(hooks, isStopSignal);
  const resIdx = lastIndex(hooks, isResumeSignal);
  const sig = hooks[sigIdx];
  const res = hooks[resIdx];
  // 利用枠の自動再開（fired）が最後の停止より後: Claude Code が続けた。上限待ちは終わり、再開のタスクも要らない
  const fired = [...hooks].reverse().find((h) => isQuotaNotice(h, QUOTA_RESUME_FIRED));
  if (fired && (!sig || fired.occurredAt > sig.occurredAt)) return { type: "resumed" };
  const live =
    sig !== undefined && (!res || res.occurredAt <= sig.occurredAt) && t.status !== "completed";
  if (!live && t.status !== "error") return { type: "none" };
  // 停止のひと続き（anchor まで。その前の最後の「続いた」hook の後から）
  const anchor = live ? sigIdx : lastIndex(hooks, (h) => h.name === "StopFailure");
  let from = 0;
  for (let i = anchor; i >= 0; i--) {
    if (isResumeSignal(hooks[i] as HookFact)) {
      from = i + 1;
      break;
    }
  }
  const run = anchor >= 0 ? hooks.slice(from, anchor + 1) : [];
  const failure = [...run].reverse().find((h) => h.name === "StopFailure");
  const first = run.find(isStopSignal);
  const at = live
    ? (first ?? (sig as HookFact)).occurredAt
    : (t.endedAt ?? failure?.occurredAt ?? t.startedAt);
  // 種類の分かる最後の StopFailure（公式の項目名は error。古い Claude Code・古い記録は種類が無い）
  const typed = [...run].reverse().find((h) => h.name === "StopFailure" && h.errorType);
  const stale = [...run].reverse().find((h) => isQuotaNotice(h, QUOTA_RESUME_STALE));
  // 種類が無くても、同じターンの窓に利用枠の自動再開の通知があれば利用枠で止まっている
  const quota = hooks.some((h) => isQuotaNotice(h));
  if (typed && typed.errorType !== "rate_limit") {
    return {
      type: "stop",
      untyped: false,
      stop: {
        kind: "error",
        turnId: t.id,
        at,
        until: at + ERROR_STATUS_MS,
        untilKnown: false,
        reason: "hook:stop_failure",
        estimated: false,
      },
    };
  }
  if (typed || stale || quota) {
    const account =
      (failure ?? sig)?.configRoot ??
      [...f.hooks].reverse().find((h) => h.sessionExternalId === s.externalId && h.configRoot)
        ?.configRoot ??
      null;
    // ⏎ を待っている（スリープ中にリセットした）: いま再開できる
    const reset = stale ? null : limitResetAt(at, account, f.claudeLimits ?? []);
    // 明けるのが 24 時間より先なので自動で続けない（週の上限など）: 明ける時刻が分からなければ 24 時間の見込み。
    // 停止のひと続きの始まりから、その後の最初の「続いた」hook の前まで（自動の再開を止めた通知は停止の後に来る）
    const horizon = hooks
      .slice(from, nextResumeIndex(hooks, Math.max(anchor, 0)))
      .some((h) => isQuotaNotice(h, QUOTA_RESUME_DISABLED) && h.horizon === true);
    return {
      type: "stop",
      untyped: false,
      stale: stale !== undefined,
      stop: {
        kind: "limit",
        turnId: t.id,
        at,
        until: stale
          ? Math.max(at, stale.occurredAt)
          : (reset ?? at + (horizon ? LIMIT_HORIZON_MS : LIMIT_FALLBACK_MS)),
        untilKnown: stale !== undefined || reset !== null,
        reason: "rate_limit",
        estimated: !typed,
      },
    };
  }
  return {
    type: "stop",
    untyped: failure !== undefined,
    stop: {
      kind: "error",
      turnId: t.id,
      at,
      until: at + ERROR_STATUS_MS,
      untilKnown: false,
      reason: failure ? "hook:stop_failure" : "turn:error",
      estimated: !failure,
    },
  };
}

/**
 * 種類の無い StopFailure の前の、同じセッションの上限待ち（その until が at より後のもの）。前のターンを新しい順に見て、
 * 種類の無い停止・止まっていないターンは飛ばし、正常に終わったターン・自動で続いたターン・利用枠以外と分かる停止で
 * やめる（再試行の嵐を別のエラーにしない）
 */
function priorLimitOf(
  f: WorkItemFacts,
  s: SessionFact,
  t: TurnFact,
  at: number,
): SessionStop | null {
  const before = (f.sessionTurns.get(s.id) ?? []).filter(
    (x) => x.id !== t.id && x.startedAt < t.startedAt,
  );
  for (let i = before.length - 1; i >= 0; i--) {
    const p = before[i] as TurnFact;
    if (p.startedAt < at - SEVEN_DAY_MS || p.status === "completed") return null;
    const r = rawTurnStop(f, s, p);
    if (r.type === "resumed") return null;
    if (r.type === "none") continue;
    if (r.stop.kind === "limit") return at < r.stop.until ? r.stop : null;
    if (!r.untyped) return null;
  }
  return null;
}

/**
 * ターン T が止まったか（T の後に同じセッションのターンがあれば、その始まりより前の hook だけを見る）。
 * - StopFailure の種類（error）が rate_limit → 上限待ち。それ以外の種類 → エラー
 * - 種類が無い: 同じ窓に quota_auto_resume_* の通知があれば上限待ち。同じセッションで先に上限待ちがあり、その until より
 *   前なら同じ上限待ちの続き（最初に止まったターンの停止をそのまま返す）。どちらでもなければエラー。
 *   種類が rate_limit の停止も、先の上限待ちの until より前なら同じ上限待ちの続きにする（明ける時刻と再開のタスクを
 *   1 回の停止につき 1 つにする）
 * - quota_auto_resume_stale → いま再開できる（until = その時刻）。disabled → 上限待ち（until はリセットの時刻か 5 時間。
 *   「明けるのが 24 時間より先」の定型文（horizon）なら、リセットの時刻が分からないときは 24 時間）。
 *   最後の停止の後の fired → 止まっていない（Claude Code が続けた）
 */
export function turnStopOf(f: WorkItemFacts, s: SessionFact, t: TurnFact): SessionStop | null {
  const raw = rawTurnStop(f, s, t);
  if (raw.type !== "stop") return null;
  const continues = raw.untyped || (raw.stop.kind === "limit" && raw.stale !== true);
  if (!continues) return raw.stop;
  return priorLimitOf(f, s, t, raw.stop.at) ?? raw.stop;
}

/** 上限待ちの最中なら、その停止（until を過ぎていれば null） */
export function sessionLimitWait(
  f: WorkItemFacts,
  s: SessionFact,
  now: number,
): SessionStop | null {
  const stop = sessionStopOf(f, s);
  return stop?.kind === "limit" && now < stop.until ? stop : null;
}

/** カードの上限待ち（いちばん遅く明けるもの）。無ければ null */
export function limitWaitOf(facts: WorkItemFacts, now: number): SessionStop | null {
  const f = normalizeFacts(facts);
  let best: SessionStop | null = null;
  for (const s of f.sessions) {
    const w = sessionLimitWait(f, s, now);
    if (w && (!best || w.until > best.until)) best = w;
  }
  return best;
}

/** PR が時刻 at の時点で open だったか */
export function prOpenAt(p: PrFact, at: number): boolean {
  if (p.firstSeenAt > at) return false;
  if (p.state === "merged" || p.state === "closed") {
    return p.stateChangedAt !== null && p.stateChangedAt > at;
  }
  return true;
}

/** ターン T の後に、同じセッションで人間の入力があったか（その時刻） */
export function humanInputAfter(f: WorkItemFacts, sessionId: string, after: number): number | null {
  for (const t of f.sessionTurns.get(sessionId) ?? []) {
    if (t.startedAt > after && isHumanTurn(t)) return t.startedAt;
  }
  return null;
}

/** カードのターンへの人間の入力（セッションを問わない） */
export function workItemHumanInputAfter(f: WorkItemFacts, after: number): number | null {
  for (const t of f.turns) if (t.startedAt > after && isHumanTurn(t)) return t.startedAt;
  return null;
}

/** AskUserQuestion への返答タスクの artifact_ref の接尾辞（D-049 (1)）。質問で終わったターンの返答タスクと区別する */
export const ASK_REF_SUFFIX = ":ask";

export function askRef(turnId: string): string {
  return `${turnId}${ASK_REF_SUFFIX}`;
}

/** AskUserQuestion（needs_input）への返答タスクか */
export function isAskReply(x: { kind: string; artifactRef: string }): boolean {
  return x.kind === "reply" && x.artifactRef.endsWith(ASK_REF_SUFFIX);
}

/** 手で作った返答タスク（AI カードの `y`。D-066 (2)）の artifact_ref の接尾辞。作り直しは `:manual:<n>` */
export const MANUAL_REF_SUFFIX = ":manual";

/** 手で作る返答タスクの artifact_ref（使用済みのものは避ける。dismissed などの行は残るので同じ dedupe_key を使えない） */
export function manualRef(turnId: string, used: (ref: string) => boolean = () => false): string {
  const base = `${turnId}${MANUAL_REF_SUFFIX}`;
  if (!used(base)) return base;
  for (let n = 2; ; n++) if (!used(`${base}:${n}`)) return `${base}:${n}`;
}

/** 手で作った返答タスクか */
export function isManualReply(x: { kind: string; artifactRef: string }): boolean {
  return x.kind === "reply" && /:manual(:\d+)?$/.test(x.artifactRef);
}

const LIVE_STATUSES: readonly string[] = ["open", "snoozed"];

/** ターン T に、手で作った返答タスクが open / snoozed で付いているか（そのターンを「質問で終了」とみなす） */
export function hasLiveManualReply(f: Pick<WorkItemFacts, "followUps">, turnId: string): boolean {
  return f.followUps.some(
    (x) => isManualReply(x) && x.triggerTurnId === turnId && LIVE_STATUSES.includes(x.status),
  );
}

/** 返答タスクが閉じた（返答済み・解決済み・対応不要・期限切れ）トリガのターン */
export function handledTurnIds(f: WorkItemFacts): Set<string> {
  return new Set(
    f.followUps
      .filter(
        (x) =>
          x.kind === "reply" &&
          !isAskReply(x) &&
          x.triggerTurnId &&
          (x.status === "done" || x.status === "dismissed" || x.status === "expired"),
      )
      .map((x) => x.triggerTurnId as string),
  );
}

/**
 * ターンの編集が解決済みか: 同じターンを trigger にした確認のタスク（check_changes）が auto:resolved:* で閉じている、または
 * ターンの終わりより後にコミットがある（WorkItemFacts.editsCommitted）
 */
export function editsResolved(f: WorkItemFacts, turnId: string): boolean {
  if (f.editsCommitted?.has(turnId)) return true;
  return f.followUps.some(
    (x) =>
      x.kind === "check_changes" &&
      x.triggerTurnId === turnId &&
      (x.closeReason ?? "").startsWith("auto:resolved:"),
  );
}

/**
 * プログラム経由のセッション（entrypoint が `sdk-` で始まる）。端末の前に人がいないので、問い・編集の確認・許可は
 * そのプログラムの仕事で、自分の番（(b)(c)(d)）と返答・確認・許可のタスクを出さない。PR の確認（(a)）は人の作業なので出す
 */
export function isProgramSession(s: { entrypoint?: string | null }): boolean {
  return (s.entrypoint ?? "").startsWith("sdk-");
}

/** ターンの「終わった時刻」。終わっていない古いターンは最後の活動の時刻で終わったとみなす */
function endOf(t: TurnFact, s: SessionFact): number {
  return t.endedAt ?? Math.max(t.startedAt, s.lastActivityAt);
}

/**
 * セッションごとの「このカードの最後のターン」について、your_turn の条件を返す（期限切れ・解決済みを除く）。
 * (a) PR はカード単位なので、ここでは (b)(c) だけを見る。
 */
export function yourTurnCandidates(
  f: WorkItemFacts,
  now: number,
  settings: Pick<TurnlaneSettings, "replyExpireMs" | "nonGitEditExpireMs">,
  timing: DeriveTiming,
): YourTurnCandidate[] {
  const handled = handledTurnIds(f);
  const out: YourTurnCandidate[] = [];
  for (const s of f.sessions) {
    if (s.isNoise) continue;
    // プログラム経由（sdk-*）は問い・編集・Stop の終わりを自分の番にしない（そのプログラムの仕事）
    if (isProgramSession(s)) continue;
    const last = [...f.turns].reverse().find((t) => t.sessionId === s.id);
    if (!last) continue;
    // 手で作った返答タスク（D-066 (2)）が付いたターンは、終わり方によらず「質問で終了」とみなす
    const manual = hasLiveManualReply(f, last.id);
    // トランスクリプトに終わりがまだ無いが Stop の hook で終わった（取り込みの遅れ）。その時刻で終わったとみなす
    const stopAt = turnHookStopOf(f, s, last);
    if (last.status !== "completed" && !manual && stopAt === null) {
      const stale = (timing.runningStaleMs[s.tool] ?? 5 * 60_000) < now - s.lastActivityAt;
      if (last.status !== "running" || !stale) continue;
    }
    const end = stopAt ?? endOf(last, s);
    if (humanInputAfter(f, s.id, last.startedAt) !== null) continue;
    if (s.archived) continue;
    // サブエージェントが動いている・許可を待っている間は、親はまだ働いている（問いで終わっていても返答待ちにしない）
    if (subagentBusy(f, s, last, now, timing)) continue;
    // 上限待ちの間は AI の作業の途中（明けたら再開のタスクを出す）
    if (sessionLimitWait(f, s, now)) continue;
    const reasons: YourTurnReason[] = [];
    if (
      manual ||
      (last.status === "completed" &&
        last.endedWith === "question" &&
        !last.closingQuestion &&
        !handled.has(last.id) &&
        now - end < settings.replyExpireMs)
    ) {
      reasons.push("question");
    } else if (stopAt !== null && !handled.has(last.id) && now - end < settings.replyExpireMs) {
      // 終わりの中身（問い・PR・ただの終わり）はトランスクリプトが追いつくまで分からない
      reasons.push("stopped");
    }
    if (last.editedFiles > 0) {
      const expired = f.nonGit && now - end >= settings.nonGitEditExpireMs;
      // 既定ブランチの session カードはリポジトリが汚れている間だけ。ただしこのターンの編集が解決済み（同じターンの確認の
      // タスクが auto:resolved:* で閉じた・ターンの終わりより後にコミットがある）なら、別の作業で汚れても数えない
      const ok = f.defaultBranchCard ? f.dirty === true && !editsResolved(f, last.id) : true;
      if (!expired && ok) reasons.push("edits");
    }
    if (reasons.length > 0) out.push({ turn: last, session: s, reasons, stopAt });
  }
  return out;
}

/** セッション単位の状態（error / needs_input / running。それ以外は null）。フォローアップの生成でも使う */
export function sessionStatus(
  f: WorkItemFacts,
  s: SessionFact,
  now: number,
  timing: DeriveTiming,
): StatusResult | null {
  const last = [...f.turns].reverse().find((t) => t.sessionId === s.id);
  if (!last || s.isNoise) return null;
  // 親の hook だけ（サブエージェントの hook は下で別に見る）
  const hooks = f.hooks.filter(
    (h) =>
      h.sessionExternalId === s.externalId &&
      h.occurredAt >= last.startedAt - 1000 &&
      isParentHook(f, s, h),
  );
  const lastOf = (pred: (h: HookFact) => boolean) => [...hooks].reverse().find(pred);
  const clear = lastOf(isClearingHook);

  // error（利用枠は上限待ちで error にしない。それ以外のエラーは停止から 1 時間で閉じる。閉じた後は止まっているだけ）
  const stop = turnStopOf(f, s, last);
  if (stop) {
    return stop.kind === "error" && now < stop.until
      ? { status: "error", reason: stop.reason, estimated: stop.estimated }
      : null;
  }
  // needs_input（hooks）: 許可待ちの後にツール実行（トランスクリプトの活動。サブエージェントの活動を含む）・Stop・入力が無い
  const permReason = (h: HookFact) =>
    h.name === "PermissionRequest"
      ? "hook:permission_request"
      : `hook:notification:${h.notificationType}`;
  const perm = lastOf(isPermissionHook);
  if (
    perm &&
    (!clear || clear.occurredAt < perm.occurredAt) &&
    activityOf(f, s) <= perm.occurredAt + 1000 &&
    last.status === "running"
  ) {
    return { status: "needs_input", reason: permReason(perm), estimated: false };
  }
  // サブエージェントの許可待ちは親の needs_input（親のターンが閉じていても。理由は親と同じ。ツール名は hook のもの）
  const subPerm = openSubagentPermission(f, s, last.startedAt - 1000);
  if (subPerm) return { status: "needs_input", reason: permReason(subPerm), estimated: false };
  if (last.status === "running") {
    if (last.pendingQuestion)
      return { status: "needs_input", reason: "ask_user_question", estimated: true };
    // Stop の hook で終わった（トランスクリプトの取り込みが遅れている）: 実行中にしない（自分の番の候補 (d)）。
    // Stop より後に見たプロセスの busy だけは、まだ動いているとみなす
    const stopAt = turnHookStopOf(f, s, last);
    const liveFresh = s.liveCheckedAt !== null && now - s.liveCheckedAt < 2 * 60_000;
    if (
      liveFresh &&
      s.liveStatus === "busy" &&
      (stopAt === null || (s.liveCheckedAt as number) > stopAt + 1000)
    )
      return { status: "running", reason: "live:busy", estimated: true };
    const prompt = lastOf((h) => h.name === "UserPromptSubmit");
    if (prompt && (!clear || clear === prompt)) {
      return { status: "running", reason: "hook:user_prompt_submit", estimated: false };
    }
    if (stopAt === null) {
      if (liveFresh && s.liveStatus === "idle") {
        return { status: "needs_input", reason: "live:idle", estimated: true };
      }
      const stale = (timing.runningStaleMs[s.tool] ?? 5 * 60_000) < now - s.lastActivityAt;
      if (!stale) return { status: "running", reason: "turn:open", estimated: true };
    }
  }
  // 親のターンが閉じていても（止まって見えても）、サブエージェントが動いていれば親はまだ働いている
  if (subagentRunningOf(f, s, now, timing))
    return { status: "running", reason: "subagent:running", estimated: true };
  return null;
}

/** YOUR TURN にタスクとして出す種類（D-045 (1)・D-048 (4)）。check_changes は帯に出さない */
const SHOWN_KINDS: readonly string[] = ["reply", "review_pr", "approve", "resume_error"];

/** カードに YOUR TURN のタスク（open / snoozed）があるか。スヌーズ中も「ある」とみなす（D-032） */
export function hasShownTask(f: Pick<WorkItemFacts, "followUps" | "launch">): boolean {
  // 頼んだタスク（D-107）が開いている間はタスクがある
  if (f.launch && f.launch.closedAt === null) return true;
  return f.followUps.some(
    (x) => SHOWN_KINDS.includes(x.kind) && (x.status === "open" || x.status === "snoozed"),
  );
}

/** ターンの終わり（無ければ始まり）の最大。待ち区間の計算でターンごとに呼ばれるので、同じ配列の結果を覚える */
const lastEndCache = new WeakMap<readonly TurnFact[], number>();
function lastEndOf(turns: readonly TurnFact[]): number {
  let v = lastEndCache.get(turns);
  if (v === undefined) {
    v = turns.reduce((m, t) => Math.max(m, t.endedAt ?? t.startedAt), 0);
    lastEndCache.set(turns, v);
  }
  return v;
}

/**
 * タスクのない your_turn が done になる時刻（D-048 (4)。phase0-plan 3.3）。タスクがあれば null。
 * 起点は「待ちの始点（最後のターン終了。PR だけが理由なら PR の初出との遅い方）」と「フォローアップが最後に閉じた時刻」の遅い方
 */
export function noTaskExpiryAt(
  f: WorkItemFacts,
  reason: string,
  settings: Pick<TurnlaneSettings, "replyExpireMs">,
): number | null {
  if (hasShownTask(f)) return null;
  let origin = lastEndOf(f.turns);
  if (reason === "pr_open") {
    for (const p of f.prs)
      if (p.state === "open" || p.state === "draft" || p.state === "unknown")
        origin = Math.max(origin, p.firstSeenAt);
  }
  for (const x of f.followUps) if (x.closedAt !== null) origin = Math.max(origin, x.closedAt);
  return origin + settings.replyExpireMs;
}

export function deriveStatus(
  facts: WorkItemFacts,
  now: number,
  settings: Pick<TurnlaneSettings, "replyExpireMs" | "nonGitEditExpireMs">,
  timing: DeriveTiming,
): StatusResult {
  const f = normalizeFacts(facts);
  let best: StatusResult | null = null;
  const pick = (r: StatusResult | null) => {
    if (r && (!best || RANK[r.status] > RANK[best.status])) best = r;
  };
  for (const s of f.sessions) pick(sessionStatus(f, s, now, timing));
  if (best && RANK[(best as StatusResult).status] > RANK.your_turn) return best;

  const lastStart = f.turns.reduce((m, t) => Math.max(m, t.startedAt), 0);
  const lastEnd = f.turns.reduce((m, t) => Math.max(m, t.endedAt ?? t.startedAt), 0);
  if (f.manualDoneAt !== null && f.manualDoneAt >= lastStart) {
    return { status: "done", reason: "manual", estimated: false };
  }
  // (a) open な PR
  const open = f.prs.filter(
    (p) => p.state === "open" || p.state === "draft" || p.state === "unknown",
  );
  const turn = (r: StatusResult): StatusResult => {
    const at = noTaskExpiryAt(f, r.reason, settings);
    return at !== null && now >= at
      ? { status: "done", reason: "no_task_expired", estimated: r.estimated }
      : r;
  };
  const cands = yourTurnCandidates(f, now, settings, timing);
  const reasons = new Set(cands.flatMap((c) => c.reasons));
  // AI が問いで止まっている（c）なら、PR の確認待ち（a）より先に返答待ちを出す（fix-pr-link）。
  // 返答タスクが閉じる・期限が切れると (c) が外れ、PR が開いていれば (a) に戻る
  if (reasons.has("question"))
    return turn({ status: "your_turn", reason: "question", estimated: true });
  if (open.length > 0) {
    return turn({
      status: "your_turn",
      reason: "pr_open",
      estimated: open.every((p) => p.state === "unknown"),
    });
  }
  // Stop の hook で終わり、中身（問い・PR）がまだ分からない。追いついたら同じ待ちのまま question などに置き換わる
  if (reasons.has("stopped"))
    return turn({ status: "your_turn", reason: "hook:stop", estimated: true });
  if (reasons.has("edits")) return turn({ status: "your_turn", reason: "edits", estimated: true });
  // 上限待ち: AI は止まっているが、人がすることはまだ無い（明けたら再開のタスク）
  if (f.sessions.some((s) => sessionLimitWait(f, s, now)))
    return { status: "done", reason: "rate_limit", estimated: false };
  // 再開のタスク（エラーの状態が閉じた後・上限待ちが明けた後）が出ている間は自分の番
  const resume = f.followUps.filter(
    (x) => x.kind === "resume_error" && LIVE_STATUSES.includes(x.status),
  );
  if (resume.length > 0)
    return {
      status: "your_turn",
      reason: resume.every(isLimitResume) ? "resume_limit" : "resume_error",
      estimated: false,
    };
  // done の理由
  const closed = f.prs.filter((p) => p.state === "merged" || p.state === "closed");
  if (closed.length > 0 && closed.every((p) => (p.stateChangedAt ?? 0) >= lastEnd - 1)) {
    return {
      status: "done",
      reason: closed.some((p) => p.state === "merged") ? "pr_merged" : "pr_closed",
      estimated: false,
    };
  }
  if (f.sessions.some((s) => s.archived))
    return { status: "done", reason: "archived", estimated: false };
  return { status: "done", reason: "ended", estimated: true };
}
