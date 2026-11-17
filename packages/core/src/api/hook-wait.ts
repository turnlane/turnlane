/**
 * hook で答える（ADR 0023。m2-api 42 章）の口の型。Claude Code の PermissionRequest の hook（`turnlane hook --tool
 * claude_code --answer`）が、待つかをデーモンに聞き、待つなら人の答えを long-poll で受け取って Claude Code に返す。
 *
 * - POST /api/hook-waits: 待ちを開く（待たないときは `{ wait: false, reason }`。hook は何も出さずに終わる）
 * - GET /api/hook-waits/:id/result?wait=<ms>: 答えを待つ
 * - POST /api/hook-waits/:id/cancel: hook の側で終わった（シグナル・親が消えた）
 *
 * 渡すのは識別子とツールの名前だけ。ツールの入力（コマンド・問いの文）は hook からデーモンに送らない（ADR 0005）。答えは
 * 選択肢の番号（と自由な文）で返し、hook が自分の持つ入力から選択肢の名前に直す。どの応答も `Cache-Control: no-store`
 */

/** POST /api/hook-waits の本文（hook の入力の許可したキーと、hook が環境から取る印） */
export interface HookWaitOpenInput {
  /** Claude Code の session_id */
  session: string;
  /** サブエージェントの中の許可待ちなら agent_id（不透明な ID） */
  agentId?: string;
  /** 許可を求めているツールの名前（AskUserQuestion なら問い） */
  tool: string;
  /** 環境変数 CLAUDE_CODE_ENTRYPOINT（sdk-* はプログラム経由。D-342） */
  entrypoint?: string;
  /** 委任で立った子のセッション（T3CODE_THREAD_ID の接頭辞。D-360。真偽値だけ） */
  delegated?: boolean;
  /** 権限のモード（permission_mode。種類だけ） */
  permissionMode?: string;
}

/** 待たない理由（hook はどれでも何も出さずに終わる） */
export type HookWaitSkip = "off" | "program" | "unsupported";

export type HookWaitOpenResponse =
  | { wait: true; id: string }
  | { wait: false; reason: HookWaitSkip };

/** AskUserQuestion の 1 問の答え: 選択肢の番号（0 始まり。複数選択は複数）か、自由な文 */
export type HookAskChoice = { options: number[] } | { text: string };

/**
 * GET /api/hook-waits/:id/result の応答
 * - open: まだ答えが無い（hook はもう一度聞く）
 * - allow: この 1 回だけ許可する（今後も許可・拒否は返さない。ADR 0019 の Decision 2）
 * - answer: AskUserQuestion の答え（`count` は問いの数。hook は自分の入力の問いの数と合わなければ何も出さない）
 * - withdrawn: 別の形で待ちが閉じた・取り下げた（hook は何も出さずに終わる）
 */
export type HookWaitResult =
  | { state: "open" }
  | { state: "allow" }
  | { state: "answer"; count: number; answers: HookAskChoice[] }
  | { state: "withdrawn" };
