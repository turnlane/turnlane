/**
 * 待っている件の中身（GET /api/work-items/:id/glance。D-207、ADR 0005 の追記 2）。
 * 表示の瞬間にデーモンが手元のセッションの記録から 1 行だけ読んで返す。`Cache-Control: no-store`。
 * 一覧（/api/queue・/api/work-items）・SSE・MCP・通知・記録・エクスポートには入れない。文字列は伏せ字を通してある。
 */
import type { EpochMs } from "./common.ts";
import type { ErrorKind } from "./work-items.ts";

/** 中身を出せない理由（行には出さず、ホバーと詳細で言う。spec-glance §5.3） */
export type GlanceUnavailable =
  /** セッションの記録が見つからない（消えた・動いた） */
  | "missing"
  /** 読めない（壊れた行・知らない形・長すぎる行・位置が古い） */
  | "unreadable"
  /** hooks が無く、許可待ちは推定（中身は読めたときだけ出す） */
  | "no_hooks"
  /** まだ読まない取り込み元（Codex は後から。D-207 (7)） */
  | "unsupported"
  /** 設定「行に中身を出す」がオフ */
  | "off";

/** 許可を求めているツールの呼び出し（引数は表示に要るものだけ。Edit / Write の中身・MCP の引数の値は読まない） */
export interface GlancePermission {
  /** ツール名（`Bash`・`Edit`・MCP はサーバー名） */
  tool: string;
  /** MCP のツール名（`mcp__<server>__<tool>` の tool） */
  sub?: string;
  /** Claude が書いた短い説明（Bash・Agent の description）。D-207 (2) で中身より先に出す */
  label?: string;
  /** 中身の 1 行目（コマンド・リポジトリからの相対パス・host/path・検索語）。伏せ字済み */
  detail?: string;
  /** detail の形（command / path / url は等幅、query は「」で囲む） */
  detailKind?: "command" | "path" | "url" | "query";
  /** 複数行のコマンドの残りの行数 */
  moreLines?: number;
  /** 詳細に出す全文（20 行まで。伏せ字済み） */
  full?: string;
  /** 新規のファイル（Write） */
  isNew?: boolean;
  /** MCP の引数のキー名（値は出さない） */
  argKeys?: string[];
  /** 伏せたものがある */
  masked: boolean;
}

export interface GlanceResponse {
  workItemId: string;
  /** permission = 許可待ち、question = 返答待ちの問い、ask = AskUserQuestion、none = 中身なし */
  kind: "permission" | "question" | "ask" | "none";
  permission?: GlancePermission;
  /** AI の問い（row = 行の 1 文 80 文字まで、detail = 2 文 300 文字まで）。伏せ字済み */
  question?: { row: string; detail: string; masked: boolean };
  /** AskUserQuestion（最初の問いと選択肢。複数問なら questions に全部） */
  ask?: {
    question: string;
    options: string[];
    /** 4 つ目以降の選択肢の数 */
    more: number;
    questions: { question: string; options: string[] }[];
  };
  /** 件名に使える直近の自分の指示の 1 行目（120 文字まで。伏せ字済み。D-207 (3)） */
  prompt?: { text: string };
  /** エラーで止まっているときのエラーの種類（StopFailure の hook の error_type。DB に保存してある値） */
  error?: ErrorKind;
  unavailable?: GlanceUnavailable;
  readAt: EpochMs;
}
