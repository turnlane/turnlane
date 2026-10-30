/**
 * AI の待ち（phase0-plan 3.3.1、U22・D-019〜D-022・D-032・D-045・D-105）。
 *
 * 待ち区間は status_log（検知した時刻）ではなく、事実の時刻から再生して求める。
 * - 始点（your_turn）: your_turn の条件（(a) open な PR、(b) 編集あり、(c) 質問で終了（締めの決まり文句を除く））を
 *   満たしたターンの ended_at
 * - 始点（needs_input）: hooks の PermissionRequest / Notification(permission_prompt, agent_needs_input)。
 *   AskUserQuestion と hooks なしの許可待ちは、作ったタスク（reply `<turn>:ask` / approve）の trigger_at から
 *   閉じた時刻まで（推定。D-049 (1)）。タスクが無い（設定でオフ・72時間より古い）ものは今開いている区間だけ
 * - 始点（error）: status='error' のターンの ended_at（D-045。resume_error が出ている間を放置に数えるため）
 * - 終点（最も早いもの）: 人間入力、フォローアップの engaged_at、your_turn を外れる事実（PR の merged / closed、
 *   manual_done_at）、解決の兆候・対応不要（返答タスクの閉じた時刻）、期限切れ（質問・エラー 72時間、
 *   git 管理外の編集 24時間）、error は同じセッションの次のターン、now
 *
 * 区分: 猶予（放置に数えうる時間に入ってから合計15分。D-058）/ 放置（Mac を使っていた時間のうち busy な予定と重ならず、
 *       タスクが出ていてスヌーズ中でない。D-105）/
 *       集計外（不在 away、予定 event、タスクなし no_task、スヌーズ中 snoozed、
 *       時間に置いた開始の前 scheduled（D-051））/
 *       期限切れ（期限切れで終わった待ちの猶予以外）
 * 放置に数えるのは YOUR TURN にタスク（reply / review_pr / approve / resume_error）が出ている間だけ（D-045 (1)）。
 * 日付区切りをまたぐ区間は論理日付ごとに分ける。日別の集計は和集合（D-045 (2)）。
 */
import { addDays, dayEndMs, toLocalDate } from "../dates.ts";
import type { TurnlaneSettings } from "../settings.ts";
import {
  humanInputAfter,
  isAskReply,
  isClearingHook,
  isLimitResume,
  isManualReply,
  isPermissionHook,
  isReportSession,
  noTaskExpiryAt,
  prOpenAt,
  turnStopOf,
} from "./status.ts";
import { activityOf, hookOwner, settledAfter, subagentPermissionEnd } from "./subagent.ts";
import {
  type DeriveTiming,
  type FollowUpFact,
  type FollowUpKind,
  type HookFact,
  isHumanTurn,
  normalizeFacts,
  type TurnFact,
  type WorkItemFacts,
} from "./types.ts";

export type WaitEndReason =
  | "human_input"
  | "engaged"
  | "status_left"
  | "resolved"
  | "dismissed"
  | "expired"
  | "superseded";

type Range = [number, number];

/** YOUR TURN にタスクとして出す種類（D-045 (1)）。check_changes は帯に出さないので数えない */
export const SHOWN_FOLLOW_UP_KINDS: readonly FollowUpKind[] = [
  "reply",
  "review_pr",
  "approve",
  "resume_error",
];

export interface WaitInterval {
  waitKey: string;
  workItemId: string;
  start: number;
  end: number;
  isOpen: boolean;
  endReason: WaitEndReason | null;
  estimated: boolean;
  followUpId: string | null;
  /** 期限切れで終わった（猶予以外は expired） */
  expired: boolean;
  /** この待ちに付くタスクが YOUR TURN に出ていた区間（和集合。スヌーズ中を含む。D-045 (1)） */
  shown: Range[];
  /** shown のうちスヌーズ中でない区間（D-032） */
  active: Range[];
  /** active のうち、時間に置いた開始の前でもない区間（D-051）。省略時は active と同じ */
  ready?: Range[];
  /**
   * 猶予を付けない（報告の待ち。ADR 0021: 報告した側は端末の前にいないので、自分の番はすぐ出る。区間も最初から放置）
   */
  noGrace?: boolean;
}

type Settings = Pick<TurnlaneSettings, "graceMs" | "replyExpireMs" | "nonGitEditExpireMs">;

interface End {
  at: number;
  reason: WaitEndReason | null;
  expired?: boolean;
}

function earliest(xs: (End | null)[]): End | null {
  let best: End | null = null;
  for (const x of xs) if (x && (!best || x.at < best.at)) best = x;
  return best;
}

function lastWithReasons(a: End, b: End): End {
  return a.at >= b.at ? a : b;
}

// ---------- 区間の演算 ----------

/** 区間の和集合（開始順に並んだ、重ならない区間） */
export function unionRanges(ranges: readonly Range[]): Range[] {
  const sorted = ranges.filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0]);
  const out: Range[] = [];
  for (const [s, e] of sorted) {
    const prev = out.at(-1);
    if (prev && s <= prev[1]) prev[1] = Math.max(prev[1], e);
    else out.push([s, e]);
  }
  return out;
}

/** 和集合の長さ */
export function unionLength(ranges: readonly Range[]): number {
  return unionRanges(ranges).reduce((sum, [s, e]) => sum + (e - s), 0);
}

function subtract(ranges: Range[], cut: readonly Range[]): Range[] {
  let out = ranges;
  for (const [cs, ce] of cut) {
    const next: Range[] = [];
    for (const [s, e] of out) {
      if (ce <= s || cs >= e) next.push([s, e]);
      else {
        if (cs > s) next.push([s, cs]);
        if (ce < e) next.push([ce, e]);
      }
    }
    out = next;
  }
  return out;
}

/** 区間の積。with_ は重ならない区間であること（unionRanges の結果など） */
function intersect(ranges: readonly Range[], with_: readonly Range[]): Range[] {
  const out: Range[] = [];
  for (const [s, e] of ranges) {
    for (const [ws, we] of with_) {
      const a = Math.max(s, ws);
      const b = Math.min(e, we);
      if (a < b) out.push([a, b]);
    }
  }
  return out;
}

/**
 * タスクが出ていた区間 [max(trigger_at, created_at), closed_at)（閉じていなければ終わりなし）と、スヌーズを除いた区間。
 * 始まりに created_at を使うのは、初回の取り込みやデーモンの停止中に後から作ったタスクを、見えていなかった過去に遡って
 * 放置に数えないため（起動中は待ちの開始・猶予の終わりから tick の遅れ（最大60秒）で作るので、ほぼ trigger_at と同じ）
 */
function taskRanges(fus: readonly FollowUpFact[]): {
  shown: Range[];
  active: Range[];
  ready: Range[];
} {
  const shown: Range[] = [];
  const active: Range[] = [];
  const ready: Range[] = [];
  for (const fu of fus) {
    if (!SHOWN_FOLLOW_UP_KINDS.includes(fu.kind)) continue;
    const r: Range = [
      Math.max(fu.triggerAt, fu.createdAt ?? fu.triggerAt),
      fu.closedAt ?? Number.POSITIVE_INFINITY,
    ];
    if (r[1] <= r[0]) continue;
    shown.push(r);
    const a = subtract([r], fu.snoozes);
    active.push(...a);
    // 時間に置いたタスクは、置いた時刻からブロックの開始まで数えない（D-051）
    ready.push(
      ...subtract(
        a,
        (fu.scheduled ?? []).filter(([s, e]) => e > s),
      ),
    );
  }
  return { shown: unionRanges(shown), active: unionRanges(active), ready: unionRanges(ready) };
}

/** 頼んだタスク（D-107）が出ている区間 [依頼, 閉じた時刻) を、タスクが出ていた区間に足す */
function withLaunch(
  r: { shown: Range[]; active: Range[]; ready: Range[] },
  launch: { at: number; closedAt: number | null } | null,
): { shown: Range[]; active: Range[]; ready: Range[] } {
  if (!launch) return r;
  const lr: Range = [launch.at, launch.closedAt ?? Number.POSITIVE_INFINITY];
  if (lr[1] <= lr[0]) return r;
  return {
    shown: unionRanges([...r.shown, lr]),
    active: unionRanges([...r.active, lr]),
    ready: unionRanges([...r.ready, lr]),
  };
}

// ---------- 待ち区間 ----------

/**
 * your_turn の待ち区間。始まりはターンの終わり。ただし、その時に動いていたサブエージェントと、その完了で親が再開した
 * ターン（人の入力でないもの）が終わるまでは AI が働いているので、待ちはその後から（まだ働いていれば作らない）
 */
function yourTurnWaits(
  f: WorkItemFacts,
  now: number,
  settings: Settings,
  timing?: DeriveTiming,
): WaitInterval[] {
  const out: WaitInterval[] = [];
  const ended = f.turns
    .filter(
      (t): t is TurnFact & { endedAt: number } => t.status === "completed" && t.endedAt !== null,
    )
    .sort((a, b) => a.endedAt - b.endedAt);
  let busyUntil = Number.NEGATIVE_INFINITY;
  const manual = f.manualDoneAt;
  for (const t of ended) {
    const settled = settledAfter(f, t, now, timing);
    if (settled === null) continue; // サブエージェントがまだ働いている
    const start = settled;
    if (start < busyUntil) continue; // 前の待ちが続いている（system 起点のターンなど）
    const a = f.prs.some((p) => prOpenAt(p, start));
    const manualReply = f.followUps.find((x) => isManualReply(x) && x.triggerTurnId === t.id);
    const c = (t.endedWith === "question" && !t.closingQuestion) || manualReply !== undefined;
    const edits = t.editedFiles > 0 && (!f.defaultBranchCard || f.dirty !== false);
    // (d) 頼んだ AI（D-107）が質問・許可・エラーなしで終わった（AI 完了 · 確認）。依頼より後のターンだけ
    const launch = f.launch ?? null;
    const done = launch !== null && t.endedWith === "end_turn" && start >= launch.at;
    if (!a && !c && !edits && !done) continue;

    const wiHuman = (() => {
      const at = f.turns.find((x) => x.startedAt > start && isHumanTurn(x))?.startedAt;
      return at !== undefined ? { at, reason: "human_input" as const } : null;
    })();
    const sessHuman = (() => {
      const at = humanInputAfter(f, t.sessionId, t.startedAt);
      return at !== null && at > start ? { at, reason: "human_input" as const } : null;
    })();
    const replies = f.followUps.filter(
      (x) => x.kind === "reply" && !isAskReply(x) && x.triggerTurnId === t.id,
    );
    // 手で作り直したもの（D-066 (2)）があれば、閉じていないものを優先する
    const reply =
      replies.find((x) => x.status === "open" || x.status === "snoozed") ?? replies.at(-1);
    const replyEnd: End | null =
      reply && reply.closedAt !== null && (reply.status === "done" || reply.status === "dismissed")
        ? {
            at: reply.closedAt,
            reason:
              reply.status === "dismissed"
                ? "dismissed"
                : reply.closeReason?.startsWith("auto:resolved") === true
                  ? "resolved"
                  : "human_input",
          }
        : null;
    const manualEnd: End | null =
      manual !== null && manual > start ? { at: manual, reason: "status_left" } : null;

    const reasonEnds: End[] = [];
    if (a) {
      // open な PR がすべて閉じた時刻
      const openPrs = f.prs.filter((p) => prOpenAt(p, start));
      const allClosed = openPrs.every(
        (p) => p.stateChangedAt !== null && (p.state === "merged" || p.state === "closed"),
      );
      const prEnd: End | null = allClosed
        ? { at: Math.max(...openPrs.map((p) => p.stateChangedAt as number)), reason: "status_left" }
        : null;
      reasonEnds.push(
        earliest([wiHuman, prEnd, manualEnd]) ?? { at: Number.POSITIVE_INFINITY, reason: null },
      );
    }
    if (c) {
      // 手で作った返答タスクの期限は作った時刻から（D-066 (2)）
      const expFrom = manualReply ? Math.max(start, manualReply.triggerAt) : start;
      const exp: End = { at: expFrom + settings.replyExpireMs, reason: "expired", expired: true };
      reasonEnds.push(earliest([wiHuman, sessHuman, replyEnd, manualEnd, exp]) as End);
    }
    if (edits) {
      const exp: End | null = f.nonGit
        ? { at: start + settings.nonGitEditExpireMs, reason: "expired", expired: true }
        : null;
      reasonEnds.push(
        earliest([wiHuman, sessHuman, manualEnd, exp]) ?? {
          at: Number.POSITIVE_INFINITY,
          reason: null,
        },
      );
    }
    if (done && !a && !c && !edits) {
      reasonEnds.push(
        earliest([wiHuman, sessHuman, manualEnd]) ?? {
          at: Number.POSITIVE_INFINITY,
          reason: null,
        },
      );
    }
    let end = reasonEnds.reduce(lastWithReasons);
    // 頼んだタスクを閉じたら（完了・削除）、待ちもそこで終わる
    if (launch?.closedAt != null && launch.closedAt > start && launch.closedAt < end.at)
      end = { at: launch.closedAt, reason: "status_left" };
    // タスクのない your_turn の72時間（D-048 (4)）で your_turn を外れたら、待ちもそこで終わる
    const noTaskAt = noTaskExpiryAt(f, a && !c && !edits ? "pr_open" : "turn", settings);
    if (noTaskAt !== null && noTaskAt > start && noTaskAt < end.at)
      end = { at: noTaskAt, reason: "status_left" };
    // ⏎（engaged）からは自分の応答
    const engaged = f.followUps
      .filter((x) => x.engagedAt !== null && (x.triggerTurnId === t.id || x.kind === "review_pr"))
      .map((x) => x.engagedAt as number)
      .filter((x) => x >= start)
      .sort((x, y) => x - y)[0];
    if (engaged !== undefined && engaged < end.at) end = { at: engaged, reason: "engaged" };
    // サブエージェントの終わりまで始まりを延ばした待ちが、その間に終わっていた（返答・手動の完了など）
    if (start > t.endedAt && end.at <= start) continue;
    const isOpen = end.at > now;
    const endAt = Math.min(end.at, now);
    // この待ちに付くタスク: そのターンの返答タスクと、カードの PR レビュー（PR はカード単位）
    const tasks = f.followUps.filter(
      (x) =>
        (x.kind === "reply" && !isAskReply(x) && x.triggerTurnId === t.id) ||
        x.kind === "review_pr",
    );
    const followUp =
      reply ??
      (a
        ? f.followUps.find(
            (x) =>
              x.kind === "review_pr" &&
              f.prs.some((p) => p.ref === x.artifactRef && prOpenAt(p, start)),
          )
        : undefined);
    out.push({
      waitKey: `turn:${t.id}`,
      workItemId: f.workItemId,
      start,
      end: endAt,
      isOpen,
      endReason: isOpen ? null : end.reason,
      estimated: false,
      followUpId: followUp?.id ?? null,
      expired: !isOpen && end.expired === true,
      ...withLaunch(taskRanges(tasks), launch),
    });
    busyUntil = isOpen ? Number.POSITIVE_INFINITY : endAt;
  }
  return out;
}

/**
 * needs_input の待ち区間（hooks の許可待ち。hooks なしの AskUserQuestion は今開いている区間だけ）。
 * サブエージェントの許可待ち（subagent.ts の hookOwner）は親のセッションの待ちとして、サブエージェントの活動・終わり・
 * 親の再開・入力で閉じる（親の Stop では閉じない）
 */
function needsInputWaits(f: WorkItemFacts, now: number): WaitInterval[] {
  const out: WaitInterval[] = [];
  for (const s of f.sessions) {
    // 報告のセッション（ADR 0021）の待ちには猶予を付けない
    const report = isReportSession(s) ? { noGrace: true } : {};
    const all = f.hooks.filter((h) => h.sessionExternalId === s.externalId);
    const ownerKey = (h: HookFact) => {
      const o = hookOwner(f, s, h);
      return o === "parent" ? "parent" : `sub:${o?.id ?? h.agentId ?? "?"}`;
    };
    const keys = new Map(all.map((h) => [h.id, ownerKey(h)]));
    for (let j = 0; j < all.length; j++) {
      const h = all[j];
      if (!h || !isPermissionHook(h)) continue;
      const key = keys.get(h.id);
      // 同じ持ち主（親・サブエージェントごと）の hook の並び
      const hooks = all.filter((x) => keys.get(x.id) === key);
      const i = hooks.indexOf(h);
      // 同じ待ちの続き（PermissionRequest の直後の Notification など）は1つにまとめる
      const prev = hooks
        .slice(0, i)
        .reverse()
        .find((x) => isPermissionHook(x) || (key === "parent" && isClearingHook(x)));
      if (prev && isPermissionHook(prev)) {
        // サブエージェントの前の許可待ちが閉じていなければ、その続き
        if (key === "parent") continue;
        const o = hookOwner(f, s, prev);
        const prevEnd = subagentPermissionEnd(f, s, prev, o === "parent" ? null : o);
        if (prevEnd === null || prevEnd > h.occurredAt) continue;
      }
      const human = f.turns.find((t) => t.startedAt > h.occurredAt && isHumanTurn(t))?.startedAt;
      let cands: number[];
      if (key === "parent") {
        const next = hooks.slice(i + 1).find((x) => isClearingHook(x));
        const turnEnd = f.turns
          .filter(
            (t) =>
              t.sessionId === s.id && t.endedAt !== null && (t.endedAt as number) > h.occurredAt,
          )
          .map((t) => t.endedAt as number)[0];
        cands = [next?.occurredAt, turnEnd, human].filter((x): x is number => x !== undefined);
        // トランスクリプトに許可の後の活動（サブエージェントの活動を含む）があれば、その時刻までに解除されている（上限）
        const act = activityOf(f, s);
        if (cands.length === 0 && act > h.occurredAt + 1000) cands.push(act);
      } else {
        const o = hookOwner(f, s, h);
        const e = subagentPermissionEnd(f, s, h, o === "parent" ? null : o);
        cands = e === null ? [] : [e];
      }
      const endAt = cands.length > 0 ? Math.min(...cands) : now;
      const isOpen = cands.length === 0;
      // この待ちに付くタスク: 待ちの間に作られた（trigger_at が待ちの中にある）approve
      const tasks = f.followUps.filter(
        (x) => x.kind === "approve" && x.triggerAt >= h.occurredAt && x.triggerAt <= endAt,
      );
      out.push({
        waitKey: `hook:${h.id}`,
        workItemId: f.workItemId,
        start: h.occurredAt,
        end: Math.min(endAt, now),
        isOpen,
        endReason: isOpen
          ? null
          : human !== undefined && human === endAt
            ? "human_input"
            : "status_left",
        estimated: false,
        followUpId: tasks[0]?.id ?? null,
        expired: false,
        ...taskRanges(tasks),
        ...report,
      });
    }
    // タスクの無い未回答の AskUserQuestion（設定でオフ・72時間より古い）は、今開いているものだけ（推定）。
    // タスクがあるものは下でタスクから作る
    const last = [...f.turns].reverse().find((t) => t.sessionId === s.id);
    const permAfter =
      last && all.some((h) => isPermissionHook(h) && h.occurredAt >= last.startedAt);
    if (
      last &&
      last.status === "running" &&
      last.pendingQuestion &&
      !permAfter &&
      !f.followUps.some((x) => isAskReply(x) && x.triggerTurnId === last.id)
    ) {
      out.push({
        waitKey: `turn:${last.id}:ask`,
        workItemId: f.workItemId,
        start: s.lastActivityAt,
        end: now,
        isOpen: true,
        endReason: null,
        estimated: true,
        followUpId: null,
        expired: false,
        shown: [],
        active: [],
        ...report,
      });
    }
  }
  // AskUserQuestion の返答タスクと、hooks の待ちに付かない approve（hooks なしの許可待ち）は、タスクの
  // trigger_at から閉じた時刻までを待ちにする（D-049 (1)。答えた後も履歴に残す）
  const hooked = new Set(out.map((w) => w.followUpId).filter((x): x is string => x !== null));
  const covered = (fu: FollowUpFact) =>
    out.some(
      (w) => w.waitKey.startsWith("hook:") && fu.triggerAt >= w.start && fu.triggerAt <= w.end,
    );
  for (const fu of f.followUps) {
    const ask = isAskReply(fu);
    if (!ask && !(fu.kind === "approve" && !hooked.has(fu.id) && !covered(fu))) continue;
    if (fu.status === "superseded" && fu.closedAt !== null && fu.closedAt <= fu.triggerAt) continue;
    let end: End =
      fu.closedAt === null
        ? { at: Number.POSITIVE_INFINITY, reason: null }
        : {
            at: fu.closedAt,
            reason:
              fu.status === "dismissed"
                ? "dismissed"
                : fu.status === "expired"
                  ? "expired"
                  : fu.status === "superseded"
                    ? "superseded"
                    : fu.closeReason?.startsWith("auto:resolved") === true
                      ? "resolved"
                      : fu.closeReason === "auto:human_input" || fu.closeReason === "auto:answered"
                        ? "human_input"
                        : "status_left",
            expired: fu.status === "expired",
          };
    if (fu.engagedAt !== null && fu.engagedAt >= fu.triggerAt && fu.engagedAt < end.at)
      end = { at: fu.engagedAt, reason: "engaged" };
    const isOpen = end.at > now;
    const trigger = f.turns.find((t) => t.id === fu.triggerTurnId);
    const ts = trigger ? f.sessions.find((x) => x.id === trigger.sessionId) : undefined;
    out.push({
      ...(ts && isReportSession(ts) ? { noGrace: true } : {}),
      waitKey: ask ? `turn:${fu.triggerTurnId ?? fu.id}:ask` : `fu:${fu.id}`,
      workItemId: f.workItemId,
      start: fu.triggerAt,
      end: Math.min(end.at, now),
      isOpen,
      endReason: isOpen ? null : end.reason,
      estimated: true,
      followUpId: fu.id,
      expired: !isOpen && end.expired === true,
      ...taskRanges([fu]),
    });
  }
  return out;
}

/**
 * error の待ち区間（D-045）。同じセッションの次のターン・人間入力・再開タスクの閉じた時刻・72時間の期限切れまで。
 * 利用枠で止まったターン（上限待ち）は期限なし（明けた後の再開のタスク `<turn>:limit` が閉じるか、次のターン・人間入力まで）。
 * タスクが出るのは明けてからなので、明けるまでは放置に数えない（タスクなし）
 */
function errorWaits(f: WorkItemFacts, now: number, settings: Settings): WaitInterval[] {
  const out: WaitInterval[] = [];
  for (const t of f.turns) {
    if (t.status !== "error") continue;
    const session = f.sessions.find((x) => x.id === t.sessionId);
    const stop = session ? turnStopOf(f, session, t) : null;
    const limit = stop?.kind === "limit" ? stop : null;
    const start = t.endedAt ?? t.startedAt;
    const nextAt = (f.sessionTurns.get(t.sessionId) ?? []).find(
      (x) => x.id !== t.id && x.startedAt > t.startedAt,
    )?.startedAt;
    const next: End | null =
      nextAt !== undefined ? { at: Math.max(start, nextAt), reason: "status_left" } : null;
    const humanAt = f.turns.find((x) => x.startedAt > start && isHumanTurn(x))?.startedAt;
    const human: End | null = humanAt !== undefined ? { at: humanAt, reason: "human_input" } : null;
    const fu = f.followUps.find(
      (x) => x.kind === "resume_error" && x.triggerTurnId === t.id && isLimitResume(x) === !!limit,
    );
    const fuEnd: End | null =
      fu && fu.closedAt !== null && (fu.status === "done" || fu.status === "dismissed")
        ? { at: fu.closedAt, reason: fu.status === "dismissed" ? "dismissed" : "status_left" }
        : fu && fu.closedAt !== null && fu.status === "expired"
          ? // 以前の版で期限切れにした再開のタスク（上限待ちの後の再開は以前は 1 時間で期限切れだった）
            { at: fu.closedAt, reason: "expired", expired: true }
          : null;
    const manual: End | null =
      f.manualDoneAt !== null && f.manualDoneAt > start
        ? { at: f.manualDoneAt, reason: "status_left" }
        : null;
    const exp: End | null = limit
      ? null
      : { at: start + settings.replyExpireMs, reason: "expired", expired: true };
    let end: End = earliest([next, human, fuEnd, manual, exp]) ?? {
      at: Number.POSITIVE_INFINITY,
      reason: null,
    };
    const engaged = fu?.engagedAt ?? null;
    if (engaged !== null && engaged >= start && engaged < end.at)
      end = { at: engaged, reason: "engaged" };
    if (end.at <= start) continue;
    const isOpen = end.at > now;
    out.push({
      waitKey: `turn:${t.id}:error`,
      workItemId: f.workItemId,
      start,
      end: Math.min(end.at, now),
      isOpen,
      endReason: isOpen ? null : end.reason,
      estimated: false,
      followUpId: fu?.id ?? null,
      expired: !isOpen && end.expired === true,
      ...taskRanges(fu ? [fu] : []),
    });
  }
  return out;
}

export function waitIntervals(
  facts: WorkItemFacts,
  now: number,
  settings: Settings,
  /** runningStale（サブエージェントがまだ動いているかの判定）。省略は 5 分 */
  timing?: DeriveTiming,
): WaitInterval[] {
  const f = normalizeFacts(facts);
  return [
    ...yourTurnWaits(f, now, settings, timing),
    ...needsInputWaits(f, now),
    ...errorWaits(f, now, settings),
  ].sort((a, b) => a.start - b.start);
}

// ---------- 区分 ----------

export type WaitKind = "grace" | "idle" | "excluded" | "expired";
/** closed は D-192 より前に一日を閉じていた区間（古い行にだけ残る。新しくは作らない） */
export type ExcludedBy = "closed" | "away" | "event" | "snoozed" | "no_task" | "scheduled";

export interface WaitSegment {
  localDate: string;
  kind: WaitKind;
  excludedBy: ExcludedBy | null;
  start: number;
  end: number;
}

export interface CalendarEventFact {
  startAt: number;
  endAt: number;
  status: "confirmed" | "tentative" | "cancelled" | null;
  availability: "busy" | "free" | "tentative" | "unavailable" | null;
  selfResponse: "accepted" | "declined" | "tentative" | "pending" | "unknown" | null;
  isOwnTimeblock: boolean;
  /** カレンダーの役割 */
  calendarRole: "source" | "writeback" | "ignored";
}

/** busy な予定（3.3.1）: 取り消し・辞退・free・自分の時間ブロック・source 以外のカレンダーは除く */
export function isBusyEvent(e: CalendarEventFact): boolean {
  return (
    e.status !== "cancelled" &&
    e.selfResponse !== "declined" &&
    (e.availability === "busy" || e.availability === "unavailable") &&
    !e.isOwnTimeblock &&
    e.calendarRole === "source"
  );
}

export interface ClassifyContext {
  settings: Pick<TurnlaneSettings, "graceMs" | "tz" | "dayBoundary">;
  /** 在席の区間（D-105。Mac を使っていた時間）。この外は不在（away） */
  presence: Range[];
  /** busy な予定の区間 */
  busy: Range[];
}

/** 区間を論理日付（日付区切り。D-054）で分ける */
function splitByDate(r: Range, ctx: ClassifyContext): { date: string; range: Range }[] {
  const out: { date: string; range: Range }[] = [];
  let [s, e] = r;
  while (s < e) {
    const date = toLocalDate(s, ctx.settings.tz, ctx.settings.dayBoundary);
    const segEnd = Math.min(e, dayEndMs(date, ctx.settings.tz, ctx.settings.dayBoundary));
    out.push({ date, range: [s, segEnd] });
    s = segEnd;
  }
  return out;
}

/**
 * 待ち区間を区分に切る（3.3.1）。まず全体を、閉じていた → 不在 → 予定 → タスクなし → スヌーズ中 → 時間に置いた開始の前 の順で
 * 集計外にし、残りを放置にする。そのうえで、放置に数えうる時間の最初の `graceMs` を猶予にする（D-058）。
 *
 * - 猶予は待ちの始まりからではなく、数えうる時間に入ってから数える。夜に始まった待ちは翌朝 Mac を使い始めた時点から、会議中に
 *   始まった待ちは会議の終わりから猶予になる
 * - 猶予は1つの待ちにつき合計 `graceMs` だけ。途中で会議などの数えない時間に入っても、出たときに新しく付け直さない
 *   （猶予の途中で入った場合は残りの分だけ続く）
 * - タスクがまだ一度も出ていない間（返答タスクは待ちの始まりから15分で作る）は、タスクなし以外の条件を満たせば
 *   猶予に使える。返答タスクが YOUR TURN に出る時刻と放置が始まる時刻を揃えるため（W1・W2・W30b）
 * - 期限切れで終わった待ちは、猶予以外をすべて期限切れにする（D-022）
 */
export function classifyWait(iv: WaitInterval, ctx: ClassifyContext): WaitSegment[] {
  const base = classifyCountable(iv, ctx);
  const firstShown = iv.shown[0]?.[0] ?? Number.POSITIVE_INFINITY;
  const grace: Range[] = [];
  let left = iv.noGrace ? 0 : ctx.settings.graceMs;
  for (const s of base) {
    if (left <= 0) break;
    const end =
      s.kind === "idle"
        ? s.end
        : s.excludedBy === "no_task"
          ? Math.min(s.end, firstShown)
          : s.start;
    if (end <= s.start) continue;
    const take = Math.min(end - s.start, left);
    grace.push([s.start, s.start + take]);
    left -= take;
  }
  const out: WaitSegment[] = [];
  for (const s of base) {
    const r: Range = [s.start, s.end];
    for (const g of intersect([r], grace)) out.push(seg(s.localDate, "grace", null, g));
    for (const x of subtract([r], grace))
      out.push(
        iv.expired
          ? seg(s.localDate, "expired", null, x)
          : seg(s.localDate, s.kind, s.excludedBy, x),
      );
  }
  return merge(out);
}

/** 猶予を考えずに、待ち区間全体を集計外（理由つき）と放置に分ける。時刻順 */
function classifyCountable(iv: WaitInterval, ctx: ClassifyContext): WaitSegment[] {
  const segs: WaitSegment[] = [];
  if (iv.end <= iv.start) return segs;
  const busyAll = unionRanges(ctx.busy);
  const presentAll = unionRanges(ctx.presence);
  for (const p of splitByDate([iv.start, iv.end], ctx)) {
    const open: Range[] = [p.range];
    for (const r of subtract(open, presentAll)) segs.push(seg(p.date, "excluded", "away", r));
    const inHours = intersect(open, presentAll);
    for (const r of intersect(inHours, busyAll)) segs.push(seg(p.date, "excluded", "event", r));
    const free = subtract(inHours, busyAll);
    for (const r of subtract(free, iv.shown)) segs.push(seg(p.date, "excluded", "no_task", r));
    const shown = intersect(free, iv.shown);
    for (const r of subtract(shown, iv.active)) segs.push(seg(p.date, "excluded", "snoozed", r));
    const active = intersect(shown, iv.active);
    const ready = iv.ready ?? iv.active;
    for (const r of subtract(active, ready)) segs.push(seg(p.date, "excluded", "scheduled", r));
    for (const r of intersect(active, ready)) segs.push(seg(p.date, "idle", null, r));
  }
  return segs.filter((s) => s.end > s.start).sort((a, b) => a.start - b.start);
}

function seg(
  localDate: string,
  kind: WaitKind,
  excludedBy: ExcludedBy | null,
  r: Range,
): WaitSegment {
  return { localDate, kind, excludedBy, start: r[0], end: r[1] };
}

/** 時刻順に並べ、同じ日付・区分で隣り合うものをまとめる */
function merge(segs: WaitSegment[]): WaitSegment[] {
  const sorted = segs.filter((s) => s.end > s.start).sort((a, b) => a.start - b.start);
  const out: WaitSegment[] = [];
  for (const s of sorted) {
    const prev = out.at(-1);
    if (
      prev &&
      prev.localDate === s.localDate &&
      prev.kind === s.kind &&
      prev.excludedBy === s.excludedBy &&
      prev.end === s.start
    ) {
      prev.end = s.end;
    } else out.push({ ...s });
  }
  return out;
}

// ---------- 集計 ----------

export interface DayAggregate {
  date: string;
  /** 放置の和集合（壁時計。D-045 (2)） */
  idleMs: number;
  expiredCount: number;
  /** repo_root（git 管理外は null）→ その repo の放置の和集合 */
  idleByRepo: Map<string | null, number>;
  /** カード → そのカードの放置の和集合 */
  idleByWorkItem: Map<string, number>;
}

/**
 * 日別の集計（3.3.1）。放置は和集合で数える: 複数のカードが同時に放置中でも1回だけ数えるので、
 * 日別 Idle はその日の在席時間を超えない。repo 別・カード別もそれぞれの中で和集合をとる。
 */
export function aggregateDays(
  segments: readonly (WaitSegment & { workItemId: string; repoRoot: string | null })[],
  expiredFollowUps: readonly { closedAt: number }[],
  settings: Pick<TurnlaneSettings, "tz" | "dayBoundary">,
): Map<string, DayAggregate> {
  const all = new Map<string, Range[]>();
  const byRepo = new Map<string, Map<string | null, Range[]>>();
  const byWi = new Map<string, Map<string, Range[]>>();
  const add = <K>(m: Map<K, Range[]>, k: K, r: Range) => {
    const xs = m.get(k);
    if (xs) xs.push(r);
    else m.set(k, [r]);
  };
  const inner = <K>(m: Map<string, Map<K, Range[]>>, date: string) => {
    let x = m.get(date);
    if (!x) {
      x = new Map();
      m.set(date, x);
    }
    return x;
  };
  for (const s of segments) {
    if (s.kind !== "idle") continue;
    const r: Range = [s.start, s.end];
    add(all, s.localDate, r);
    add(inner(byRepo, s.localDate), s.repoRoot, r);
    add(inner(byWi, s.localDate), s.workItemId, r);
  }
  const out = new Map<string, DayAggregate>();
  const day = (date: string) => {
    let d = out.get(date);
    if (!d) {
      d = { date, idleMs: 0, expiredCount: 0, idleByRepo: new Map(), idleByWorkItem: new Map() };
      out.set(date, d);
    }
    return d;
  };
  for (const [date, rs] of all) {
    const d = day(date);
    d.idleMs = unionLength(rs);
    for (const [k, xs] of byRepo.get(date) ?? []) d.idleByRepo.set(k, unionLength(xs));
    for (const [k, xs] of byWi.get(date) ?? []) d.idleByWorkItem.set(k, unionLength(xs));
  }
  for (const f of expiredFollowUps)
    day(toLocalDate(f.closedAt, settings.tz, settings.dayBoundary)).expiredCount++;
  return out;
}

/**
 * 1件の自分の番の応答時間（D-057。3.3.1 の集計値「平均応答時間」）。壁時計ではなく、Idle と同じ物差しで数える:
 * 応答の窓 [trigger_at, min(engaged_at ?? closed_at, closed_at)] のうち、その待ちの猶予（grace）と放置（idle）の
 * 区間の和集合の長さ。閉じていた間・不在・会議中・スヌーズ中・時間に置いた開始の前・タスクなし（集計外）と期限切れは入れない。
 * segments はその待ちの区間（区分を問わない）。窓と重なる区間が1つも無ければ、待ち区間が分からないので null
 * （平均に入れない）
 */
export function countedResponseMs(
  f: { triggerAt: number; engagedAt: number | null; closedAt: number },
  segments: readonly { kind: WaitKind; start: number; end: number }[],
): number | null {
  const end = Math.min(f.engagedAt ?? f.closedAt, f.closedAt);
  if (end <= f.triggerAt) return 0;
  const win: Range[] = [[f.triggerAt, end]];
  const all = segments.map((s): Range => [s.start, s.end]);
  if (intersect(win, unionRanges(all)).length === 0) return null;
  const counted = segments
    .filter((s) => s.kind === "grace" || s.kind === "idle")
    .map((s): Range => [s.start, s.end]);
  return unionLength(intersect(win, unionRanges(counted)));
}

/**
 * 待ち区間を自動で作り直すか（W25）。カレンダーの窓（7日前〜）より古い日は、予定が消えると結果が変わるので
 * 確定扱いにし、自動では作り直さない。`turnlane rederive --wait --since <date>` で明示したときだけ作り直す。
 * 在席の記録を始めた日（presenceSinceDate。D-105・D-110 (3)）より前は、明示しても作り直さない（過去の在席の記録が無い）
 */
export function waitRecomputeFrom(
  today: string,
  settings: Pick<TurnlaneSettings, "waitRecomputeDays">,
  since?: string,
  presenceSinceDate?: string | null,
): string {
  const auto = addDays(today, -settings.waitRecomputeDays);
  const from = since && since < auto ? since : auto;
  return presenceSinceDate && presenceSinceDate > from ? presenceSinceDate : from;
}
