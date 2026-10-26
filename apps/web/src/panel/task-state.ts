/**
 * タスクの詳細パネルの頭（タスクのパネルのレビュー v1。AI の詳細パネル D-116 と同じ作り）: 状態の1行と主のボタン。
 * 画面の言葉は i18n のキーで返し、描画は TaskPanel が行う（表駆動のテストのため純粋関数にする）
 */
import type { TaskView, TimeBlockView } from "@turnlane/core/web";

/** 状態の1行の置き場所（太字の最初の語） */
export type TaskPlace =
  | { k: "done"; at: number | null }
  | { k: "inbox" }
  | { k: "today" }
  | { k: "tomorrow" }
  | { k: "date"; date: string };

export interface TaskHead {
  place: TaskPlace;
  /** 時間に置いていればその時刻 */
  range: { start: number; end: number } | null;
  /** 長さ（置いた時間の長さ、無ければ見積）。分 */
  min: number | null;
}

/**
 * 状態の1行: 「Inbox · 1h」「今日 14:00–15:00 · 1h」「10/12（月） · 30m」「完了 · 15:20」。
 * 完了・取り消しは長さを出さず、完了の時刻だけ
 */
export function taskHeadOf(
  task: Pick<TaskView, "status" | "scheduledDate" | "estimateMin" | "completedAt">,
  block: Pick<TimeBlockView, "start" | "end"> | null,
  today: string,
  tomorrow: string,
): TaskHead {
  if (task.status === "done" || task.status === "canceled")
    return { place: { k: "done", at: task.completedAt }, range: null, min: null };
  const range = task.scheduledDate && block ? { start: block.start, end: block.end } : null;
  const min = range ? Math.round((range.end - range.start) / 60_000) : task.estimateMin;
  const d = task.scheduledDate;
  const place: TaskPlace = !d
    ? { k: "inbox" }
    : d === today
      ? { k: "today" }
      : d === tomorrow
        ? { k: "tomorrow" }
        : { k: "date", date: d };
  return { place, range, min };
}

/**
 * 主のボタン（1つ。状態で決める）:
 * - 完了・取り消し → 無し（○ で戻せる。「⋯」に未完了に戻す）
 * - 自分の番のタスク（AI の返答待ち） → 開く（AI の詳細パネルの主のボタンと同じ）
 * - 拡張が作ったタスクで、出どころに主ボタンの文言（ExtTaskOrigin.primary）がある → その画面へ（D-192 §5.4 (3)）
 * - 頼んだ AI が自分を待っている（返答待ち・許可待ち・AI 完了 · 確認） → 開く（頼んだ AI のセッション）
 * - 日付が無い（Inbox） → 日に置く ▾
 * - 日付があり時間が無い → 時間を置く
 * - 時間に置いた・まだ頼んでいない → AI に頼む
 * - 時間に置いた・頼んだ AI がセッションに紐づいた → 開く（頼んだ AI のセッション）
 */
export type TaskPrimary =
  | "openTurn"
  | "extOrigin"
  | "placeDate"
  | "placeTime"
  | "askAi"
  | "openAi"
  | null;

/** 頼んだ AI が自分を待っている状態 */
const WAITING = new Set(["your_turn", "needs_input", "done_check"]);

export function taskPrimaryOf(
  task: Pick<TaskView, "status" | "scheduledDate" | "followUpId" | "ai">,
  hasBlock: boolean,
  /** 拡張の出どころに主ボタンの文言がある（ExtTaskOrigin.primary） */
  extPrimary = false,
): TaskPrimary {
  if (task.status === "done" || task.status === "canceled") return null;
  if (task.followUpId) return "openTurn";
  if (extPrimary) return "extOrigin";
  if (task.ai?.workItemId && WAITING.has(task.ai.state)) return "openAi";
  if (!task.scheduledDate) return "placeDate";
  if (!hasBlock) return "placeTime";
  if (!task.ai) return "askAi";
  return task.ai.workItemId ? "openAi" : null;
}

/** 見積の候補（分。レビュー v1 の 15m / 30m / 1h / 2h） */
export const ESTIMATE_PRESETS = [15, 30, 60, 120] as const;

/** 時間の長さの候補（分） */
export const LENGTH_PRESETS = [15, 30, 60, 120] as const;

/**
 * 見積の任意の入力: 「45」（分）「45m」「1h30m」「1.5h」「90分」「1時間」→ 分。読めない・0・24時間超は null
 */
export function parseEstimate(raw: string): number | null {
  const s = raw.trim().toLowerCase().replace(/\s+/g, "");
  if (!s) return null;
  let min: number | null = null;
  const plain = /^(\d{1,4})$/.exec(s);
  const hm = /^(?:(\d+(?:\.\d+)?)(?:h|時間))?(?:(\d{1,3})(?:m|min|分))?$/.exec(s);
  if (plain) min = Number(plain[1]);
  else if (hm && (hm[1] || hm[2])) min = Math.round(Number(hm[1] ?? 0) * 60 + Number(hm[2] ?? 0));
  return min !== null && Number.isFinite(min) && min > 0 && min <= 24 * 60 ? min : null;
}
