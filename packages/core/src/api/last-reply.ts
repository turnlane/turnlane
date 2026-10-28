/**
 * 最後の返答（ADR 0019 の Decision 10。m2-api 34章）の API の型。
 * - GET /api/work-items/:id/last-reply: その AI 項目の最後のセッションの、AI の最後の発言（表示の瞬間に記録から読む。保存しない）。
 *   `no-store`
 */
import type { EpochMs } from "./common.ts";
import type { InstructCheck } from "./instruct.ts";

/**
 * 読めたか
 * - ok: 文がある
 * - none: 記録はあるが、そのターンに AI の発言がまだ無い（AI 項目にセッションが無いときも）
 * - gone: 記録が無い・消えている（Claude Code は既定 30 日で消す）
 * - unreadable: 記録はあるが読めない（知らない形・長すぎる行）
 * - off: 設定「行に中身を出す」（turn.show_detail）がオフ
 */
export type LastReplyState = "ok" | "none" | "gone" | "unreadable" | "off";

export interface LastReplyResponse {
  workItemId: string;
  state: LastReplyState;
  /** AI の最後の発言（2,000 字まで。伏せ字済み）。state が ok のときだけ */
  text?: string;
  /** 2,000 字で切った（続きは端末で） */
  truncated?: boolean;
  /** 伏せ字を入れた */
  masked?: boolean;
  /**
   * 次の指示を送れるか（Issue #9、m2-api 35章）。デーモンが答えると同じ届け先の判定で付ける。設定「行に中身を出す」が
   * オフでも付く（文を読まない判定）
   */
  instruct?: InstructCheck;
  readAt: EpochMs;
}
