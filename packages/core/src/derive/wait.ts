/**
 * 開いている待ち（Turnlane から答える の対象。D-240、ADR 0019、m2-api 31章）。
 *
 * 「答える」は待ちそのものに付ける。フォローアップ（返答タスク）は猶予（`reply.delay_minutes`、既定 15 分）の後にしか
 * できないので、フォローアップだけを見ると在席中の問いに猶予の間は答える口が無い。対象は次の順で決める:
 * 1. 開いているフォローアップ（approve / resume_error / reply）があればそれ
 * 2. 無ければ、セッションの待ち（`sessionWaitOf`）: needs_input（AskUserQuestion = ask、許可待ち = permission）か、
 *    your_turn で理由に question を含む（返答待ち = question）セッションの最後のターン。猶予は見ない
 *
 * 判定は `sessionStatus`・`yourTurnCandidates`（状態とフォローアップの判定と同じ関数）を使い、ここで複製しない。
 * 猶予の意味（返答タスクの行・通知・放置の数え方）は変えない。変わるのは「答える口が開く時刻」だけ。
 */
import type { TurnlaneSettings } from "../settings.ts";
import { ASK_REF_SUFFIX, type StatusResult, sessionStatus, yourTurnCandidates } from "./status.ts";
import { type DeriveTiming, normalizeFacts, type WorkItemFacts } from "./types.ts";

/** 答えられる待ちの種類（問い・AskUserQuestion・許可・エラー） */
export type OpenWaitKind = "question" | "ask" | "permission" | "error";

/** フォローアップの無い、セッションの待ち（runner が判定のたびに作る） */
export interface SessionWait {
  kind: "question" | "ask" | "permission";
  /** 待っているセッションの最後のターン */
  turnId: string;
  sessionId: string;
}

/** 答える対象 */
export interface OpenWait {
  kind: OpenWaitKind;
  /** 待ちのターン（フォローアップのトリガのターン、セッションの待ちならその最後のターン） */
  turnId: string | null;
  /** 答える先のフォローアップ（セッションの待ちなら null） */
  followUpId: string | null;
}

/** フォローアップの種類 → 待ちの種類（PR の確認・変更の確認は答える対象にしない） */
export function followUpWaitKind(kind: string, artifactRef: string): OpenWaitKind | null {
  if (kind === "approve") return "permission";
  if (kind === "reply") return artifactRef.endsWith(ASK_REF_SUFFIX) ? "ask" : "question";
  if (kind === "resume_error") return "error";
  return null;
}

/**
 * セッションの待ち（フォローアップの有無・猶予によらない）。カードがエラーなら null（エラーは再開タスクがすぐできる）。
 * needs_input のセッションを先に（新しい活動の順）、無ければ your_turn の question の候補（新しく終わった順）
 */
export function sessionWaitOf(
  facts: WorkItemFacts,
  status: StatusResult,
  now: number,
  settings: Pick<TurnlaneSettings, "replyExpireMs" | "nonGitEditExpireMs">,
  timing: DeriveTiming,
): SessionWait | null {
  if (status.status === "error" || status.status === "done") return null;
  const f = normalizeFacts(facts);
  const sessions = [...f.sessions].sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  for (const s of sessions) {
    const r = sessionStatus(f, s, now, timing);
    if (r?.status !== "needs_input") continue;
    const t = [...f.turns].reverse().find((x) => x.sessionId === s.id);
    if (!t) continue;
    return {
      kind: r.reason === "ask_user_question" ? "ask" : "permission",
      turnId: t.id,
      sessionId: s.id,
    };
  }
  const c = yourTurnCandidates(f, now, settings, timing)
    // Stop の hook で終わり中身がまだ分からないターンも、問いの待ちとして扱う（同じターンの返答タスクになる）
    .filter((x) => x.reasons.includes("question") || x.reasons.includes("stopped"))
    .sort(
      (a, b) =>
        (b.turn.endedAt ?? b.stopAt ?? b.turn.startedAt) -
          (a.turn.endedAt ?? a.stopAt ?? a.turn.startedAt) ||
        b.session.lastActivityAt - a.session.lastActivityAt,
    )[0];
  return c ? { kind: "question", turnId: c.turn.id, sessionId: c.session.id } : null;
}

/**
 * 答える対象: 開いているフォローアップ（答えられる種類のとき）→ 無ければセッションの待ち。どちらも無ければ null。
 * followUp は呼ぶ側が選んだカードの代表（open を先に、approve → resume_error → reply の順）
 */
export function openWaitOf(
  followUp: { id: string; kind: string; artifactRef: string; turnId: string | null } | null,
  session: SessionWait | null,
): OpenWait | null {
  const k = followUp ? followUpWaitKind(followUp.kind, followUp.artifactRef) : null;
  if (followUp && k) return { kind: k, turnId: followUp.turnId, followUpId: followUp.id };
  if (session) return { kind: session.kind, turnId: session.turnId, followUpId: null };
  return null;
}
