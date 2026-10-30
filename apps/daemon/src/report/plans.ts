/**
 * 報告の予定（state scheduled。ADR 0021 の追記。0.8.1）: ai_session.scheduled_at のある報告のセッション。AI の項目にはせず、
 * AI のレーンの予定の帯と AI の画面の「後で」にだけ出す。既存の判定（status.ts）には乗せない
 */
import type { Database } from "bun:sqlite";
import { REPORT_PLAN_LATE_MS, type ReportPlanView } from "@turnlane/core/api";

/** 予定（from〜to に始めるもの。省略は全部）。始める早い順 */
export function reportPlans(
  db: Database,
  now: number,
  range?: { from: number; to: number },
): ReportPlanView[] {
  return db
    .query<
      {
        id: string;
        tool: string;
        external_id: string;
        title: string | null;
        project_name: string | null;
        scheduled_at: number;
      },
      [number, number]
    >(
      `SELECT s.id, s.tool, s.external_id, s.title, s.project_name, s.scheduled_at FROM ai_session s
       JOIN ai_source src ON src.id = s.source_id
       WHERE s.entrypoint = 'report' AND s.scheduled_at IS NOT NULL AND src.enabled = 1
         AND s.scheduled_at >= ? AND s.scheduled_at < ?
       ORDER BY s.scheduled_at, s.id`,
    )
    .all(range?.from ?? 0, range?.to ?? Number.MAX_SAFE_INTEGER)
    .map((r) => ({
      id: r.id,
      source: r.tool,
      externalId: r.external_id,
      title: r.title,
      project: r.project_name,
      at: r.scheduled_at,
      overdue: now > r.scheduled_at + REPORT_PLAN_LATE_MS,
    }));
}
