import type { NoticeMessage } from "../notify/plan.ts";

import type { ImportProgress } from "./onboarding.ts";

/** SSE のイベント（m2-api.md 3.2）。データは載せず「何が・どの日付で変わったか」だけ */
export type SseEventType =
  | "hello"
  | "task"
  | "work_item"
  | "follow_up"
  | "calendar"
  /** 計画の目安（D-106）の設定が変わった。空き時間を取り直す */
  | "plan_guide"
  | "source"
  | "day_boundary"
  | "backup"
  | "settings"
  /** 日報（要約の生成・失敗・編集。M4-6）。儀式と日報のキャッシュだけを取り直す */
  | "daily_note"
  /** デスクトップアプリへの通知（desktop-shell.md 3.2）。web は無視する */
  | "notify"
  /** turnlane open → デスクトップアプリの main を指定の画面で開く（4.3） */
  | "desktop_open"
  /** 設定画面 → デスクトップアプリ: 通知の許可を求める / システム設定の通知を開く（D-080。web は無視する） */
  | "desktop_notifications"
  /** デスクトップアプリの状態（通知の許可・ホットキー）が変わった。web は設定画面の状態を取り直す（D-080） */
  | "desktop_status"
  /**
   * 集中モードの状態・問いが変わった（D-097。m2-api 25章）。web は focus と queue を取り直し、アプリは
   * `prompt: false` かつ `late: false` なら問いの通知を取り下げる
   */
  | "focus"
  /** 拡張（ADR 0015）の中身が変わった。web は `["ext", id]` のキャッシュを取り直す */
  | "ext"
  /** オンボーディングの状態（onboarding.md 5.1）が変わった。GET /api/onboarding を取り直す */
  | "onboarding"
  /** 新しい日からの取り込みの進捗（onboarding.md 5.3）。データ（日ごとの状態）を載せる */
  | "import_progress"
  /** 更新確認（M6-12）の結果が変わった。GET /api/update を取り直す */
  | "update";

export interface SsePayloads {
  hello: { bootId: string; rev: number; today: string };
  task: { rev: number; dates: string[]; ids: string[]; inbox: boolean };
  work_item: { rev: number; dates: string[]; ids: string[] };
  follow_up: { rev: number; ids: string[]; workItemIds: string[] };
  calendar: { rev: number; dates: string[] };
  plan_guide: { rev: number; dates: string[] };
  source: { rev: number };
  day_boundary: { rev: number; today: string; displayToday?: string };
  backup: { date: string };
  settings: { rev: number };
  daily_note: { rev: number; dates: string[] };
  notify: { rev: number; notices: NoticeMessage[] };
  desktop_open: { rev: number; path: string };
  desktop_notifications: {
    rev: number;
    action: "request" | "open_settings" | "open_automation_settings";
  };
  desktop_status: { rev: number };
  /** `late`: 開始の時刻を過ぎて閉じた問いがまだ答えを受ける（アプリは問いの通知を残す。m2-api 25章） */
  focus: { rev: number; active: boolean; prompt: boolean; late: boolean };
  ext: { rev: number; exts: string[] };
  onboarding: { rev: number };
  import_progress: { rev: number } & ImportProgress;
  update: { rev: number };
}
