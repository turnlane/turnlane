/**
 * 外の作業の報告（ADR 0021。m2-api 37 章）: `POST /api/ai/reports`・MCP `report_ai_work`・`turnlane ai report` が同じ型を受ける。
 * 型と検証は collectors の report.ts（spool の 1 行を読むアダプタと同じもの）。ここは応答の型だけ
 */
export type { ReportInput, ReportState } from "@turnlane/collectors";

/** POST /api/ai/reports の応答（202）。workItemId は取り込んだ後に分かれば */
export interface ReportResponse {
  accepted: true;
  workItemId: string | null;
  /** 取り込みがまだ（spool に書いただけ）。CLI のデーモンに届かなかったときの 1 行と同じ意味 */
  queued: boolean;
}

/**
 * 報告の予定（state scheduled。0.8.1）: その時刻に始める予定で、まだ動いていない作業。AI の項目にはせず、AI のレーンの
 * 予定の帯（DayColumn.aiPlans）と AI の画面の「後で」（AiLiveResponse.plans）にだけ出す
 */
export interface ReportPlanView {
  /** ai_session.id */
  id: string;
  /** 出どころ */
  source: string;
  /** 出どころの中の作業の ID */
  externalId: string;
  title: string | null;
  project: string | null;
  /** 始める時刻 */
  at: number;
  /** 始める時刻を 30 分過ぎても started などが来ていない（札を「予定の時刻を過ぎています」にする。自分の番にはしない） */
  overdue: boolean;
}

/**
 * GET /api/ai/reports/:source/:id（予定の詳細パネル。0.8.1）: 報告の作業 1 つ。予定のあいだは plan があり、started などで
 * AI の項目になったら workItemId が入る（パネルはその項目の詳細に切り替える）
 */
export interface ReportItemResponse {
  source: string;
  externalId: string;
  title: string | null;
  project: string | null;
  /** 報告の開く先（開けるものだけ。無ければ null） */
  url: string | null;
  /** 予定（非表示にした・予定でなくなったら null） */
  plan: ReportPlanView | null;
  /** この作業の AI 項目（まだ無ければ null） */
  workItemId: string | null;
}

/** 予定の時刻を過ぎたとみなすまでの余裕 */
export const REPORT_PLAN_LATE_MS = 30 * 60_000;

/** GET /api/ai/reports/sources の 1 行（報告してきた出どころ） */
export interface ReportSourceView {
  source: string;
  /** 報告の作業（セッション）の数 */
  items: number;
  lastReportAt: number | null;
}

export interface ReportSourcesResponse {
  /** 報告の取り込み元（ai_source の report の行）が有効か */
  enabled: boolean;
  sources: ReportSourceView[];
}
