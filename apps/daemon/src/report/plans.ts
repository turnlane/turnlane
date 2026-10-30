/**
 * 報告の予定（state scheduled。ADR 0021 の追記。0.8.1）: ai_session.scheduled_at のある報告のセッション。AI の項目にはせず、
 * AI のレーンの予定の帯と AI の画面の「後で」にだけ出す。既存の判定（status.ts）には乗せない
 */
import type { Database } from "bun:sqlite";
import { isOpenableReportUrl, REPORT_ENTRYPOINT } from "@turnlane/collectors";
import {
  REPORT_PLAN_LATE_MS,
  type ReportItemResponse,
  type ReportPlanView,
} from "@turnlane/core/api";

/** 予定として出す条件（非表示にした時刻と同じ間は隠す。送り直して時刻が変われば出る） */
const SHOWN =
  "s.scheduled_at IS NOT NULL AND (s.plan_hidden_at IS NULL OR s.plan_hidden_at <> s.scheduled_at)";

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
       WHERE s.entrypoint = 'report' AND ${SHOWN} AND src.enabled = 1
         AND s.scheduled_at >= ? AND s.scheduled_at < ?
       ORDER BY s.scheduled_at, s.id`,
    )
    .all(range?.from ?? 0, range?.to ?? Number.MAX_SAFE_INTEGER)
    .map((r) => planView(r, now));
}

function planView(
  r: {
    id: string;
    tool: string;
    external_id: string;
    title: string | null;
    project_name: string | null;
    scheduled_at: number;
  },
  now: number,
): ReportPlanView {
  return {
    id: r.id,
    source: r.tool,
    externalId: r.external_id,
    title: r.title,
    project: r.project_name,
    at: r.scheduled_at,
    overdue: now > r.scheduled_at + REPORT_PLAN_LATE_MS,
  };
}

interface SessionRow {
  id: string;
  tool: string;
  external_id: string;
  title: string | null;
  project_name: string | null;
  open_url: string | null;
  scheduled_at: number | null;
  plan_hidden_at: number | null;
  enabled: number;
}

function sessionOf(db: Database, source: string, id: string): SessionRow | null {
  return db
    .query<SessionRow, [string, string, string]>(
      `SELECT s.id, s.tool, s.external_id, s.title, s.project_name, s.open_url, s.scheduled_at,
              s.plan_hidden_at, src.enabled FROM ai_session s
       JOIN ai_source src ON src.id = s.source_id
       WHERE s.entrypoint = ? AND s.tool = ? AND s.external_id = ? LIMIT 1`,
    )
    .get(REPORT_ENTRYPOINT, source, id);
}

/**
 * 報告の作業 1 つ（予定の詳細パネル）。無い・取り込み元を止めている間は null。workItemId は呼ぶ側が引く（ReportReceiver）
 */
export function reportItem(
  db: Database,
  now: number,
  source: string,
  id: string,
  workItemId: string | null,
): ReportItemResponse | null {
  const s = sessionOf(db, source, id);
  if (!s || s.enabled !== 1) return null;
  const shown = s.scheduled_at !== null && s.plan_hidden_at !== s.scheduled_at;
  return {
    source: s.tool,
    externalId: s.external_id,
    title: s.title,
    project: s.project_name,
    url: s.open_url && isOpenableReportUrl(s.open_url) ? s.open_url : null,
    plan:
      shown && s.scheduled_at !== null
        ? planView({ ...s, scheduled_at: s.scheduled_at }, now)
        : null,
    workItemId,
  };
}

/** 予定を非表示にする（いまの始める時刻を覚える）。隠したら始める時刻を返す（予定が無ければ null） */
export function hidePlan(db: Database, source: string, id: string): number | null {
  const s = sessionOf(db, source, id);
  if (!s || s.scheduled_at === null) return null;
  db.run("UPDATE ai_session SET plan_hidden_at = ? WHERE id = ?", [s.scheduled_at, s.id]);
  return s.scheduled_at;
}

/** 報告の作業のいまの始める時刻（予定でなければ null。受けた前後で変わった日を知らせるため） */
export function scheduledAtOf(db: Database, source: string, id: string): number | null {
  return sessionOf(db, source, id)?.scheduled_at ?? null;
}
