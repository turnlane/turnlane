/**
 * 離れていた間のまとめ（GET /api/away。ux-mvp 4.13、D-214 (2)）。在席の記録（presence_span）が 10 分以上切れていて、
 * その間に AI の項目に変化があったときだけ、戻ってから 30 分の間返す。保存するのは「閉じた」印（設定 away.dismissed）だけ。
 * 中身は件名・時刻・件数・ファイル数・PR の番号と CI の状態だけ（会話の本文は持たない）。通知には出さない
 */

import type { EpochMs, WorkItemStatus } from "./common.ts";
import type { CiState } from "./launch.ts";

/**
 * 離れていた間に起きたこと（1 件に 1 つ。強い順に wait > error > pr > done で代表を選ぶ）:
 * done = 完了（ターンが質問なしで終わった）、pr_opened = PR を開いた、pr_merged = PR がマージされた、
 * question / ask / permission = 新しい待ち（問い・回答待ち・許可待ち）、error = エラーで止まった
 */
export type AwayKind =
  | "done"
  | "pr_opened"
  | "pr_merged"
  | "question"
  | "ask"
  | "permission"
  | "error";

/** 件数の区分（1 行の `完了 1 · PR 1 · 新しい待ち 1 · エラー 1`） */
export type AwayGroup = "done" | "pr" | "wait" | "error";

/**
 * 変更の量（終わった件の行。PR の値は gh で読めたときだけ。ファイル数は AI の記録の編集の数）
 */
export interface ChangeSize {
  /** 変更したファイルの数（PR の changedFiles。無ければ最後のひと続きの作業で編集したファイルの数の和） */
  files: number | null;
  additions?: number | null;
  deletions?: number | null;
  /** PR の CI の状態（gh で読めたときだけ。none は CI が無い） */
  ci?: CiState | null;
}

export interface AwayItem {
  workItemId: string;
  /** 件名（自分の番の行と同じ。D-214 (1)） */
  title: string | null;
  status: WorkItemStatus;
  kind: AwayKind;
  /** 起きた時刻（完了 = ターンの終わり、待ち = AI が止まった時刻、PR = 見つけた / マージの時刻） */
  at: EpochMs;
  /** 待ちのフォローアップ（開くと engage して端末へ）。無ければ詳細パネルを開く */
  followUpId: string | null;
  pr: { number: number; ref: string; url: string | null } | null;
  change: ChangeSize | null;
  repoRoot: string | null;
  scratch?: boolean;
  branch: string | null;
}

export interface AwayDigest {
  /** このまとめの印（戻った時刻。閉じるときに送る。新しい離席は別の印になる） */
  key: string;
  /** 最後に在席していた時刻（離れた時刻） */
  from: EpochMs;
  /** 戻った時刻 */
  to: EpochMs;
  /** これを過ぎたら出さない（戻ってから 30 分） */
  until: EpochMs;
  counts: Record<AwayGroup, number>;
  items: AwayItem[];
}

export interface AwayResponse {
  digest: AwayDigest | null;
}
