/**
 * フォローアップ（自分の番）の「あるべき集合」と差分（phase0-plan 3.3・3.3.1、ai-session-ingestion 5）。
 *
 * | kind | トリガ | artifact_ref | 自動クローズ |
 * |---|---|---|---|
 * | approve | needs_input の許可待ち（hooks。hooks なしはプロセスが idle で最終ターンが未完了）。すぐ作る | トリガのターン | 次のツール実行 / Stop / 人間入力 |
 * | reply | (1) 質問で終わった your_turn（締めの決まり文句を除く。トランスクリプトがまだ追いつかず Stop の hook で終わった
 *   ターンを含む）で、ターン終了から15分人間入力が無い（終了の時刻に本人が
 *   いなかった（在席の外）ならすぐ。D-214 (3)）。(2) needs_input の AskUserQuestion（すぐ作る）。(3) AI カードの `y`（手動。daemon の UserOps が作る。D-066 (2)） | トリガのターン（(2) は `<turn>:ask`、(3) は `<turn>:manual`） | 返答済み / 解決済み（推定）/ 72時間で期限切れ。(2) は質問に答えたら（auto:answered）。(3) は your_turn を外れても閉じない |
 * | review_pr | PR が open（pr-link の初出） | PR ref | merged / closed / 自分のレビュー |
 * | resume_error | error（利用枠以外。エラーの状態が 1 時間で閉じた後も止まったままなら残す） | トリガのターン | 次のターンが成功 / 72時間で期限切れ（D-045） |
 * | resume_error（`<turn>:limit`）| 上限待ち（利用枠）が明けた（until を過ぎた）。trigger_at = until | `<turn>:limit` | 人間入力 / そのセッションの次のターン・Stop など（あるべき集合から外れた）。期限なし（対応不要まで残る） |
 * | check_changes（既定オフ） | your_turn・編集あり・PR なし | トリガのターン | コミット / PR / 手動 |
 *
 * dismissed など閉じた行は残すので、同じ dedupe_key では作り直さない。同じカードで reply / approve が新しく
 * できたら、古い open なものは superseded で閉じる。
 * トリガ（待ちの開始）が72時間より古いものは作らない（初回の取り込みで過去の履歴をタスクにしない。D-045 (3)）。
 * needs_input は hooks の有無によらず必ずタスクにする（D-049 (1)。AI が自分を待っている瞬間を YOUR TURN と通知に出す）。
 */
import type { FollowUpKindSetting, TurnlaneSettings } from "../settings.ts";
import {
  askRef,
  humanInputAfter,
  isAskReply,
  isClearingHook,
  isLimitResume,
  isManualReply,
  isPermissionHook,
  isProgramSession,
  limitRef,
  limitWaitOf,
  type StatusResult,
  sessionStatus,
  sessionStopOf,
  yourTurnCandidates,
} from "./status.ts";
import {
  type DeriveTiming,
  type FollowUpFact,
  type FollowUpKind,
  normalizeFacts,
  type WorkItemFacts,
} from "./types.ts";

export interface FollowUpSpec {
  kind: FollowUpKind;
  artifactRef: string;
  dedupeKey: string;
  triggerAt: number;
  triggerTurnId: string | null;
}

export function dedupeKey(workItemId: string, kind: FollowUpKind, artifactRef: string): string {
  return `${workItemId}|${kind}|${artifactRef}`;
}

type Settings = Pick<
  TurnlaneSettings,
  "replyDelayMs" | "replyExpireMs" | "nonGitEditExpireMs" | "followUpKinds"
>;

function on(settings: Settings, k: FollowUpKindSetting): boolean {
  return settings.followUpKinds[k] === true;
}

export function desiredFollowUps(
  facts: WorkItemFacts,
  status: StatusResult,
  now: number,
  settings: Settings,
  timing: DeriveTiming,
): FollowUpSpec[] {
  const f = normalizeFacts(facts);
  const out: FollowUpSpec[] = [];
  const add = (kind: FollowUpKind, ref: string, at: number, turnId: string | null) => {
    if (out.some((x) => x.dedupeKey === dedupeKey(f.workItemId, kind, ref))) return;
    out.push({
      kind,
      artifactRef: ref,
      dedupeKey: dedupeKey(f.workItemId, kind, ref),
      triggerAt: at,
      triggerTurnId: turnId,
    });
  };
  const lastTurn = f.turns.at(-1);
  // プログラム経由（sdk-*）のセッションの許可待ちは、そのプログラムが決める（状態は needs_input のまま。タスク・通知は出さない）
  const programOf = (sessionId: string | undefined) => {
    const s = f.sessions.find((x) => x.id === sessionId);
    return s ? isProgramSession(s) : false;
  };

  if (
    status.status === "needs_input" &&
    status.reason.startsWith("hook:") &&
    on(settings, "approve") &&
    lastTurn &&
    !programOf(lastTurn.sessionId)
  ) {
    const perm = [...f.hooks].reverse().find(isPermissionHook);
    // 同じターンで許可した後にまた止まった（2 回目以降の PermissionRequest）は別の待ち。閉じた 1 回目と同じ dedupe_key だと
    // 作り直されず、自分の番にも詳細の「待っている理由」にも出ない。1 回目は今までどおりターンの ID、2 回目からは `:perm<n>`
    const session = f.sessions.find((s) => s.id === lastTurn.sessionId);
    const reqs = f.hooks.filter(
      (h) =>
        h.name === "PermissionRequest" &&
        isPermissionHook(h) &&
        h.occurredAt >= lastTurn.startedAt &&
        (!session || h.sessionExternalId === session.externalId),
    );
    const n = reqs.length;
    const req = reqs.at(-1);
    if (n > 1 && req) add("approve", `${lastTurn.id}:perm${n}`, req.occurredAt, lastTurn.id);
    else add("approve", lastTurn.id, perm?.occurredAt ?? now, lastTurn.id);
  }
  // hooks の無い needs_input（D-049 (1)）: セッションごとに、AskUserQuestion は返答タスク、プロセスが idle の
  // 許可待ちは approve。待ちの開始（最後の活動）ですぐ作る
  for (const s of f.sessions) {
    if (isProgramSession(s)) continue;
    const r = sessionStatus(f, s, now, timing);
    if (r?.status !== "needs_input" || r.reason.startsWith("hook:")) continue;
    const t = [...f.turns].reverse().find((x) => x.sessionId === s.id);
    if (!t) continue;
    const since = Math.max(t.startedAt, s.lastActivityAt);
    if (r.reason === "ask_user_question" && on(settings, "reply")) {
      add("reply", askRef(t.id), since, t.id);
    } else if (r.reason === "live:idle" && on(settings, "approve")) {
      add("approve", t.id, since, t.id);
    }
  }
  // 再開のタスク: エラー（利用枠以外）は止まっている間（エラーの状態が 1 時間で閉じた後も）。利用枠は上限待ちが明けてから
  if (on(settings, "resume_error") && lastTurn) {
    for (const s of f.sessions) {
      const stop = sessionStopOf(f, s);
      if (stop?.kind === "error") {
        add("resume_error", lastTurn.id, lastTurn.endedAt ?? lastTurn.startedAt, lastTurn.id);
      } else if (stop?.kind === "limit" && now >= stop.until) {
        add("resume_error", limitRef(stop.turnId), stop.until, stop.turnId);
      }
    }
  }
  if (
    status.status === "your_turn" ||
    status.status === "running" ||
    status.status === "needs_input"
  ) {
    for (const c of yourTurnCandidates(f, now, settings, timing)) {
      // Stop の hook で終わったターン（トランスクリプトが遅れている）はその時刻を終わりにする
      const end = c.turn.endedAt ?? c.stopAt ?? c.turn.startedAt;
      // 手で返答タスクを作ったターンには、自動の返答タスクを重ねない（D-066 (2)）
      const manual = f.followUps.some((x) => isManualReply(x) && x.triggerTurnId === c.turn.id);
      // 猶予（15 分）は「端末の前にいたなら自分で気づく」ための待ち。止まった時刻にいなかったなら待たずに自分の番にする
      // （D-214 (3)。放置の数え方は変えない）
      // Stop の hook だけで終わったターン（中身が分からない）も同じターンの返答タスクにする。トランスクリプトが追いついて
      // 問いだったら同じ dedupe_key のまま（作り直さない・二重に通知しない）。ただの終わりなら「あるべき」から外れて閉じる
      if (
        (c.reasons.includes("question") || c.reasons.includes("stopped")) &&
        !manual &&
        on(settings, "reply") &&
        (now - end >= settings.replyDelayMs || timing.awayAt?.(end) === true)
      ) {
        add("reply", c.turn.id, end, c.turn.id);
      }
      if (c.reasons.includes("edits") && f.prs.length === 0 && on(settings, "check_changes")) {
        add("check_changes", c.turn.id, end, c.turn.id);
      }
    }
  }
  if (on(settings, "review_pr")) {
    for (const p of f.prs) {
      if (p.myReviewAt !== null) continue;
      // 状態が分からない PR（gh で未確認）には作らない。gh で確かめても分からなかった（gh が無い等）ものは作る。
      // どちらも初出から72時間を過ぎたものは作らない（reconcileFollowUps の isTooOldToCreate。D-045 (3)）
      const unknownOk =
        p.state === "unknown" && p.stateCheckedAt !== null && p.stateCheckedAt !== undefined;
      if (p.state === "open" || p.state === "draft" || unknownOk) {
        add("review_pr", p.ref, p.firstSeenAt, null);
      }
    }
  }
  return out;
}

/** 返答タスクの「解決の兆候」（phase0-plan 3.3.1）。runner が repo_root・ブランチで絞って渡す */
export interface ResolutionSignals {
  /** 同じ repo_root・ブランチで、since より後の最初のコミットの時刻 */
  commitAfter(since: number): number | null;
  /**
   * トリガのセッション以外で、since より後に始まったセッションの、同じ repo_root・ブランチの人間入力ターンが始まった時刻
   * （並行して前から開いていたセッションへの入力は数えない）
   */
  newSessionAfter(since: number): number | null;
  /** その head ブランチの PR が since より後に merged になった時刻 */
  prMergedAfter(since: number): number | null;
}

export const NO_SIGNALS: ResolutionSignals = {
  commitAfter: () => null,
  newSessionAfter: () => null,
  prMergedAfter: () => null,
};

export type FollowUpAction =
  | { type: "create"; spec: FollowUpSpec }
  | {
      type: "close";
      id: string;
      status: "done" | "expired" | "superseded";
      reason: string;
      at: number;
    }
  | { type: "wake"; id: string }
  /**
   * 自動で閉じた行を開き直す（上限待ちが明けた後の再開のタスク `<turn>:limit` だけ。上限待ちの明ける時刻が伸びて、
   * 先に作った行を閉じていたもの）。trigger_at を新しい明ける時刻にする。利用者が閉じた行（dismissed）は開き直さない
   */
  | { type: "reopen"; id: string; triggerAt: number };

/**
 * 上限待ちの明ける時刻が伸びたので、先に作った再開のタスク（`<turn>:limit`）を閉じたときの理由（まだ明けていない。
 * 明けたら同じ行を開き直す）
 */
export const LIMIT_EXTENDED_REASON = "auto:limit_extended";
/**
 * 開き直してよい、自動で閉じた再開のタスクの理由。auto:next_turn_ok は、明ける時刻を 5 時間の見込みで作った後に週の
 * 明けへ伸びた旧版の行（今は LIMIT_EXTENDED_REASON で閉じる）
 */
const REOPENABLE_LIMIT_REASONS: ReadonlySet<string> = new Set([
  LIMIT_EXTENDED_REASON,
  "auto:next_turn_ok",
]);

const LIVE: readonly string[] = ["open", "snoozed"];

/** 返答タスクの閉じ方（返答済み・解決済み（推定）・期限切れ）。まだ閉じないなら null */
export function replyClosure(
  fu: FollowUpFact,
  f: WorkItemFacts,
  now: number,
  settings: Pick<TurnlaneSettings, "replyExpireMs">,
  signals: ResolutionSignals,
): { status: "done" | "expired"; reason: string; at: number } | null {
  const trigger = f.turns.find((t) => t.id === fu.triggerTurnId);
  const candidates: { reason: string; at: number }[] = [];
  if (trigger) {
    const human = humanInputAfter(f, trigger.sessionId, trigger.startedAt);
    if (human !== null) candidates.push({ reason: "auto:human_input", at: human });
  }
  // 問いを出したセッションのプロセスが生きている（busy / idle）間は、コミットと別セッションを兆候にしない（同じ
  // リポジトリで並行して別の作業をしているだけで、問いはまだ立っている）。gone や生死が取れない（null）ときは使う
  const triggerSession = trigger ? f.sessions.find((x) => x.id === trigger.sessionId) : undefined;
  const alive = triggerSession?.liveStatus === "busy" || triggerSession?.liveStatus === "idle";
  if (!alive) {
    const c = signals.commitAfter(fu.triggerAt);
    if (c !== null) candidates.push({ reason: "auto:resolved:commit", at: c });
    const s = signals.newSessionAfter(fu.triggerAt);
    if (s !== null) candidates.push({ reason: "auto:resolved:new_session", at: s });
  }
  const m = signals.prMergedAfter(fu.triggerAt);
  if (m !== null) candidates.push({ reason: "auto:resolved:pr_merged", at: m });
  const expireAt = fu.triggerAt + settings.replyExpireMs;
  const first = candidates
    .filter((x) => x.at <= now && x.at < expireAt)
    .sort((a, b) => a.at - b.at)[0];
  if (first) return { status: "done", ...first };
  if (now >= expireAt) return { status: "expired", reason: "auto:expired", at: expireAt };
  return null;
}

/**
 * トリガ（待ちの開始）が72時間（reply.expire_hours）以上前のものは作らない（D-045 (3)）。
 * 起動中は待ちが始まってすぐ作るので、効くのは初回の取り込みと、デーモンが長く止まっていた後だけ。
 * 既にあるものには関係しない（あるべき集合からは外さないので、古さで閉じることもない）。
 */
export function isTooOldToCreate(
  d: Pick<FollowUpSpec, "triggerAt">,
  now: number,
  settings: Pick<TurnlaneSettings, "replyExpireMs">,
): boolean {
  return now - d.triggerAt >= settings.replyExpireMs;
}

export function reconcileFollowUps(
  facts: WorkItemFacts,
  desired: FollowUpSpec[],
  now: number,
  settings: Pick<TurnlaneSettings, "replyExpireMs">,
  signals: ResolutionSignals = NO_SIGNALS,
): FollowUpAction[] {
  const f = normalizeFacts(facts);
  const actions: FollowUpAction[] = [];
  const known = new Set(f.followUps.map((x) => x.dedupeKey));
  const byKey = new Map(f.followUps.map((x) => [x.dedupeKey, x]));
  // 今の上限待ち（明ける前）。その停止の再開のタスクが先にあれば、閉じずに「まだ明けていない」として持つ
  const wait = limitWaitOf(f, now);
  const waitRef = wait ? limitRef(wait.turnId) : null;
  const want = new Map(desired.map((d) => [d.dedupeKey, d]));
  const live = f.followUps.filter((x) => LIVE.includes(x.status));
  const closed = new Set<string>();

  // 返答タスクは「あるべき」かどうかに関係なく、返答済み・解決の兆候・期限切れで閉じる
  for (const fu of live) {
    if (fu.kind !== "reply") continue;
    const c = replyClosure(fu, f, now, settings, signals);
    if (c) {
      actions.push({ type: "close", id: fu.id, ...c });
      closed.add(fu.id);
    }
  }
  // 再開タスクは、まだエラーのまま（あるべき集合にある）で72時間たったら期限切れ（D-045 (3)）。上限待ちが明けた後の
  // 再開（`:limit`）は期限なし（ほかの待ちと同じく、再開するか対応不要にするまで残す。日をまたいでも残る）
  for (const fu of live) {
    if (fu.kind !== "resume_error" || !want.has(fu.dedupeKey) || isLimitResume(fu)) continue;
    const expireAt = fu.triggerAt + settings.replyExpireMs;
    if (now >= expireAt) {
      actions.push({
        type: "close",
        id: fu.id,
        status: "expired",
        reason: "auto:expired",
        at: expireAt,
      });
      closed.add(fu.id);
    }
  }
  // 新しく作る。reply / approve は同じカードの古い open なものを superseded にする
  for (const d of desired) {
    if (known.has(d.dedupeKey)) {
      // 上限待ちの明ける時刻が伸びて自動で閉じた再開のタスクは、新しく明けた時点で同じ行を開き直す（作り直さない）
      const ex = byKey.get(d.dedupeKey);
      if (
        ex &&
        isLimitResume(ex) &&
        !LIVE.includes(ex.status) &&
        ex.status !== "dismissed" &&
        REOPENABLE_LIMIT_REASONS.has(ex.closeReason ?? "") &&
        d.triggerAt > ex.triggerAt
      )
        actions.push({ type: "reopen", id: ex.id, triggerAt: d.triggerAt });
      continue;
    }
    if (isTooOldToCreate(d, now, settings)) continue;
    actions.push({ type: "create", spec: d });
    if (d.kind === "reply" || d.kind === "approve") {
      for (const fu of live) {
        if (fu.kind === d.kind && !closed.has(fu.id) && fu.triggerAt < d.triggerAt) {
          actions.push({
            type: "close",
            id: fu.id,
            status: "superseded",
            reason: "superseded",
            at: now,
          });
          closed.add(fu.id);
        }
      }
    }
  }
  for (const fu of live) {
    if (closed.has(fu.id) || want.has(fu.dedupeKey)) continue;
    // 手で作った返答タスクは「あるべき集合」に入らないが、上の返答の閉じ方（返答済み・解決・期限切れ）でだけ閉じる
    if (isManualReply(fu)) continue;
    const close = (status: "done" | "expired" | "superseded", reason: string, at = now) => {
      actions.push({ type: "close", id: fu.id, status, reason, at });
      closed.add(fu.id);
    };
    if (isAskReply(fu)) {
      // 質問に答えてターンが進んだ（D-049 (1)）。答えた時刻は分からないので、最後の活動と now の早い方
      const trigger = f.turns.find((t) => t.id === fu.triggerTurnId);
      const s = trigger ? f.sessions.find((x) => x.id === trigger.sessionId) : undefined;
      const last = s && s.lastActivityAt > fu.triggerAt ? s.lastActivityAt : now;
      close("done", "auto:answered", Math.max(fu.triggerAt, Math.min(now, last)));
      continue;
    }
    switch (fu.kind) {
      case "review_pr": {
        const p = f.prs.find((x) => x.ref === fu.artifactRef);
        if (p?.state === "merged") close("done", "auto:pr_merged", p.stateChangedAt ?? now);
        else if (p?.state === "closed") close("done", "auto:pr_closed", p.stateChangedAt ?? now);
        else if (p?.myReviewAt) close("done", "auto:pr_reviewed", p.myReviewAt);
        else if (!p) close("done", "auto:status_left");
        break;
      }
      case "approve": {
        const trigger = f.turns.find((t) => t.id === fu.triggerTurnId);
        const human = trigger ? humanInputAfter(f, trigger.sessionId, trigger.startedAt) : null;
        const cleared = f.hooks.find((h) => h.occurredAt >= fu.triggerAt && isClearingHook(h));
        close(
          "done",
          human !== null ? "auto:human_input" : "auto:next_turn_ok",
          Math.min(now, human ?? cleared?.occurredAt ?? now),
        );
        break;
      }
      case "resume_error": {
        // 上限待ちの明ける時刻が伸びて、まだ明けていない（同じ停止の上限待ちが続いている）: 「まだ明けていない」として
        // 閉じ、明けたら同じ行を開き直す（上の reopen）。完了とは数えない
        if (isLimitResume(fu) && waitRef !== null && fu.artifactRef === waitRef) {
          close("superseded", LIMIT_EXTENDED_REASON);
          break;
        }
        // 上限待ちが明けた後の再開は、新しい入力で閉じる（その時刻）
        const trigger = isLimitResume(fu)
          ? f.turns.find((t) => t.id === fu.triggerTurnId)
          : undefined;
        const human = trigger ? humanInputAfter(f, trigger.sessionId, trigger.startedAt) : null;
        if (human !== null)
          close("done", "auto:human_input", Math.min(now, Math.max(fu.triggerAt, human)));
        else close("done", "auto:next_turn_ok");
        break;
      }
      default:
        close("done", "auto:status_left");
    }
  }
  // スヌーズが明けたら open に戻す
  for (const fu of live) {
    if (
      !closed.has(fu.id) &&
      fu.status === "snoozed" &&
      fu.snoozeUntil !== null &&
      fu.snoozeUntil <= now
    ) {
      actions.push({ type: "wake", id: fu.id });
    }
  }
  return actions;
}

/** 自動クローズ時の実績の推定（U7）: engaged_at があればそこからクローズまで（上限30分）、無ければ3分 */
export function estimateResponse(
  engagedAt: number | null,
  closedAt: number,
): { start: number; end: number } {
  if (engagedAt !== null && engagedAt <= closedAt) {
    return { start: engagedAt, end: Math.min(closedAt, engagedAt + 30 * 60_000) };
  }
  return { start: closedAt - 3 * 60_000, end: closedAt };
}
