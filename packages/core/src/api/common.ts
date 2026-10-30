/**
 * UI 向け API の共通の型（m2-api.md 2.3）。サーバーは表示文字列を返さない（6章）: 時刻は epoch ms、時間は ms、
 * 状態・理由は列挙値、自動生成タスクの題名は { key, params }。そのまま返す文字列はユーザーや外部が書いたものだけ。
 */
import type { TaskTitleKey, TaskTitleParams } from "../i18n/task-title.ts";

export type EpochMs = number;
/** YYYY-MM-DD（日付区切りを反映した論理日付） */
export type LocalDate = string;
export interface Interval {
  start: EpochMs;
  end: EpochMs;
}

export type WorkItemStatus = "running" | "needs_input" | "your_turn" | "done" | "error";
export type FollowUpKind =
  | "approve"
  | "reply"
  | "review_pr"
  | "resume_error"
  | "check_changes"
  | "merge_pr";
/** Turnlane が自分で読む取り込み元のツール */
export type KnownSourceTool = "claude_code" | "codex" | "claude_desktop";
/**
 * セッションの取り込み元のツール。報告（ADR 0021）の出どころは利用者が決める小文字の識別子（`^[a-z0-9_]{2,32}$`）なので、
 * 知っている 3 つのほかの文字列も入る。UI は知らないものを汎用のバッジ（識別子の先頭 2 文字）で出す
 */
export type SourceTool = KnownSourceTool | (string & {});

/**
 * Turnlane 自身の spool を読む取り込み元（hooks・報告）。オンボーディングの検出と「取り込み元がある」の判定には数えない
 */
export function isInternalSource(tool: string): boolean {
  return tool === "hook_spool" || tool === "report";
}

/** すべての読み取り応答に付ける */
export interface ReadMeta {
  /** 今の論理日（日付区切りを適用。儀式・集計の「今日」） */
  today: LocalDate;
  /** 今の暦日（表示の「今日」。D-054） */
  displayToday: LocalDate;
  now: EpochMs;
  /** 単調増加の版。SSE の rev と比べて古い応答を捨てるのに使う（m2-api.md 4.3） */
  rev: number;
  /** 論理日付と時刻の表示に使うタイムゾーン（IANA 名）と日付区切り（0 時からの分） */
  tz: string;
  dayBoundary: number;
}

/** 表示文字列を持たない題名（D-046）。params は読み取り時に AI 項目の現在の値で上書きしたもの（D-047 (3)） */
export type TitleSpec =
  | { t: "text"; text: string }
  | { t: "auto"; key: TaskTitleKey; params: TaskTitleParams };

/** エラー応答（メッセージ文はサーバーで作らない。6.2） */
export interface ApiError {
  error: string;
}
