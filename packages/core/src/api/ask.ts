/**
 * 図つきの問い（MCP の ask_user。ADR 0022。m2-api 41 章）の API の型。
 * 問い・背景・案・図・答えは、問いが開いている間だけデーモンのメモリにある。DB・spool・ログ・SSE・書き出し・バックアップには
 * 入れない。DB に残るのは「回答待ちだった」というフォローアップの行（種類と時刻）だけ。
 *
 * - POST /api/asks: MCP のプロセスが問いを開く（図はそのプロセスが読んだ中身を送る。デーモンは手元のパスを読まない）
 * - GET /api/asks/:id/result?wait=<ms>: MCP のプロセスが答えを待つ（long-poll）。デーモンが再起動していれば 404
 * - POST /api/asks/:id/cancel: MCP のプロセスが取り消す（AI 側で打ち切られた）
 * - GET /api/asks/:id: 画面が中身を読む（`no-store`）。POST /api/asks/:id/answer・/dismiss: 画面が答える・閉じる
 */
import type { EpochMs } from "./common.ts";

/** 図（MCP のプロセスが読んだ HTML / SVG の中身。読めなければ理由だけ） */
export type AskFigureInput = { html: string } | { error: "too_large" | "unreadable" };

export interface AskOptionInput {
  label: string;
  description: string;
  recommended?: boolean;
  figure?: AskFigureInput;
}

/** POST /api/asks の本文 */
export interface AskCreateInput {
  question: string;
  context?: string;
  options: AskOptionInput[];
  explain?: AskFigureInput;
  /** 呼んだ AI のプロセス（MCP のプロセスの親）。その AI のセッションのカードに付ける */
  pid?: number;
  /** MCP のプロセスの作業ディレクトリ（リポジトリ × ブランチのカードを探す） */
  cwd?: string;
  /** MCP のクライアントの名前（initialize の clientInfo.name） */
  client?: string;
}

export interface AskCreateResponse {
  id: string;
  /** 付けたカード */
  workItemId: string | null;
  /** カードを新しく作った（AI のセッションのカードが見つからなかった） */
  ownCard: boolean;
}

/** 問いの状態。open 以外は閉じた（answered = 返した、dismissed = 閉じた、cancelled = AI 側で打ち切られた） */
export type AskState = "open" | "answered" | "dismissed" | "cancelled";

/** GET /api/asks/:id/result の応答 */
export type AskResultResponse =
  | { state: "open" }
  | { state: "answered"; choice?: string; note?: string }
  | { state: "dismissed" }
  | { state: "cancelled" };

/** 画面に出す図（読めなかったら error） */
export type AskFigureView = { html: string } | { error: "too_large" | "unreadable" };

/** GET /api/asks/:id の応答（画面が表示の瞬間に読む。`no-store`） */
export interface AskView {
  id: string;
  workItemId: string | null;
  state: AskState;
  createdAt: EpochMs;
  /** 閉じた時刻（開いていれば null） */
  closedAt: EpochMs | null;
  /** 開いている間だけ（閉じたら中身は捨てる） */
  question?: string;
  context?: string;
  options?: {
    n: number;
    label: string;
    description: string;
    recommended: boolean;
    figure?: AskFigureView;
  }[];
  explain?: AskFigureView;
}

/** POST /api/asks/:id/answer の本文: 案（label）とメモのどちらか、または両方 */
export interface AskAnswerInput {
  choice?: string;
  note?: string;
}

export interface AskAnswerResponse {
  state: "answered";
  answeredAt: EpochMs;
}
