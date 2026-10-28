/**
 * 次の指示（Issue #9、ADR 0019 の Decision 11。m2-api 35章）の API の型。
 * - POST /api/work-items/:id/instruct: 待ちの無いセッションに、次の指示を端末のタブに文字として届ける（答えると同じ口）。保存しない
 * - 送れるかの事前の判定は GET /api/work-items/:id/last-reply の `instruct` に入る
 */
import type { AnswerResult, AnswerVia } from "./answer.ts";

/**
 * 送らない理由（409 の error にも同じ言葉）
 * - off: 設定「Turnlane から答える」（turn.answer）がオフ
 * - session_ended: セッションのプロセスが終わっている（文がシェルに入るので送らない）
 * - process_unknown: プロセスが動いているか確かめられない（Codex・Claude Desktop など）
 * - wait_open: 開いている待ち（問い・許可）がある（次の指示ではなく「答える」）
 * - turn_in_progress: 動作中（ツールの呼び出しの途中・結果待ち・指示を受けた直後）
 * - unreadable: 記録が無い・読めない（ターンの終わりを確かめられない）
 * - unsupported / not_found: 答えると同じ（送る口の無い端末・タブが見つからない）
 */
export type InstructBlocked =
  | "off"
  | "session_ended"
  | "process_unknown"
  | "wait_open"
  | "turn_in_progress"
  | "unreadable"
  | "unsupported"
  | "not_found";

/** 送れるか（送れるなら届け先。表示は答えると同じ `Orca · タブ`） */
export type InstructCheck =
  | { ok: true; via: AnswerVia; terminal: string; landing: string; multiline: boolean }
  | { ok: false; reason: InstructBlocked; terminal: string | null };

export interface InstructInput {
  text: string;
}

/** 送った結果（答えると同じ形。confirmed は 3 秒以内に記録へ新しい自分の指示が現れた） */
export type InstructResult = AnswerResult;
