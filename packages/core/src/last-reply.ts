/**
 * 最後の返答（ADR 0019 の Decision 10。m2-api 34章）の純粋な部分: 記録から取り出した AI の最後の発言を、応答の形にする
 * （伏せ字 → 2,000 字で切る）。記録の読み方（ターンの境界）は collectors の claudeLastReply / codexLastReply。
 */
import type { LastReplyResponse, LastReplyState } from "./api/last-reply.ts";
import { redact } from "./glance/redact.ts";

/** 最後の返答の上限（問いの全文と同じ。超えたら切って truncated） */
export const LAST_REPLY_MAX = 2000;

export type LastReplyBody = Pick<LastReplyResponse, "state" | "text" | "truncated" | "masked">;

/**
 * 取り出した文 → 応答の中身。伏せ字は保存する行と同じ規則（ADR 0005 の 2026-10-16 の追記）を、切る前に通す
 * （切った後だと鍵の途中で切れて伏せ字の規則に当たらない）。文が無ければ none
 */
export function lastReplyOf(raw: string | null | undefined): LastReplyBody {
  const s = raw?.trim();
  if (!s) return { state: "none" };
  const r = redact(s);
  const truncated = r.text.length > LAST_REPLY_MAX;
  return {
    state: "ok",
    text: truncated ? `${r.text.slice(0, LAST_REPLY_MAX - 1)}…` : r.text,
    truncated,
    masked: r.masked,
  };
}

/** 文の無い状態（記録が無い・読めない・設定でオフ） */
export function lastReplyState(state: Exclude<LastReplyState, "ok">): LastReplyBody {
  return { state };
}
