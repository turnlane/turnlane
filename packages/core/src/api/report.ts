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
