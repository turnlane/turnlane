/**
 * 報告の受け口（ADR 0021。m2-api 37 章）: `POST /api/ai/reports` と MCP `report_ai_work`（HTTP を通る）。CLI がデーモンに
 * 届かないときに spool へ直接書くのと同じ 1 行を spool に追記し、すぐ取り込みを起こす（道を 1 本にする）。
 * 文はログに出さない（出すのは出どころの名前と状態だけ）
 */
import type { Database } from "bun:sqlite";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  type MetaOnlyLogger,
  meta,
  parseReport,
  REPORT_ENTRYPOINT,
  REPORT_TOOL,
  reportSpoolName,
  reportSpoolText,
  toReportSpoolLine,
} from "@turnlane/collectors";
import type { Clock } from "@turnlane/core";
import type { ReportResponse, ReportSourcesResponse } from "@turnlane/core/api";

export interface ReportReceiverOptions {
  sqlite: Database;
  clock: Clock;
  logger: MetaOnlyLogger;
  spoolDir: string;
  /** いま書いた spool をすぐ取り込む（取り込めなければ false） */
  ingestPath(tool: string, abs: string): boolean;
  /** 取り込みと判定が落ち着くまで待つ（応答の workItemId のため。上限つきで待つ） */
  settle(): Promise<void>;
  /** 待つ上限（既定 2 秒） */
  settleMs?: number;
}

export type ReportResult =
  | { ok: true; body: ReportResponse }
  | { ok: false; status: 400; field: string }
  | { ok: false; status: 500; error: "spool_unwritable" };

export class ReportReceiver {
  constructor(private readonly o: ReportReceiverOptions) {}

  async receive(input: unknown): Promise<ReportResult> {
    const p = parseReport(input);
    if (!p.ok) return { ok: false, status: 400, field: p.field };
    const now = this.o.clock.now();
    const line = toReportSpoolLine(p.report, now, Bun.randomUUIDv7());
    const text = reportSpoolText(line);
    if (text === null) return { ok: false, status: 400, field: "body" };
    const path = join(this.o.spoolDir, reportSpoolName(now));
    try {
      mkdirSync(this.o.spoolDir, { recursive: true, mode: 0o700 });
      // 1 回の追記（O_APPEND。4 KB 未満なので行が混ざらない）
      appendFileSync(path, text, { mode: 0o600 });
    } catch {
      this.o.logger.warn("report.spool_failed", { source: meta(p.report.source) });
      return { ok: false, status: 500, error: "spool_unwritable" };
    }
    this.o.logger.info("report.received", {
      source: meta(p.report.source),
      state: meta(p.report.state),
    });
    const ingesting = this.o.ingestPath(REPORT_TOOL, path);
    if (ingesting) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        this.o.settle(),
        new Promise<void>((r) => {
          timer = setTimeout(r, this.o.settleMs ?? 2000);
        }),
      ]);
      if (timer) clearTimeout(timer);
    }
    return {
      ok: true,
      body: {
        accepted: true,
        workItemId: this.workItemOf(p.report.source, p.report.id),
        queued: !ingesting,
      },
    };
  }

  /** 報告の作業（出どころ・ID）の AI 項目（まだ判定されていなければ null） */
  workItemOf(source: string, id: string): string | null {
    return (
      this.o.sqlite
        .query<{ w: string | null }, [string, string]>(
          `SELECT t.work_item_id AS w FROM ai_turn t JOIN ai_session s ON s.id = t.session_id
           WHERE s.tool = ? AND s.external_id = ? AND t.work_item_id IS NOT NULL
           ORDER BY t.started_at DESC LIMIT 1`,
        )
        .get(source, id)?.w ?? null
    );
  }

  /** 報告してきた出どころ（設定 › AI の取り込み） */
  sources(): ReportSourcesResponse {
    const src = this.o.sqlite
      .query<{ enabled: number }, [string]>("SELECT enabled FROM ai_source WHERE tool = ? LIMIT 1")
      .get(REPORT_TOOL);
    const rows = this.o.sqlite
      .query<{ source: string; items: number; last: number | null }, [string]>(
        `SELECT tool AS source, count(*) AS items, max(last_activity_at) AS last FROM ai_session
         WHERE entrypoint = ? GROUP BY tool ORDER BY tool`,
      )
      .all(REPORT_ENTRYPOINT);
    return {
      enabled: src ? src.enabled === 1 : false,
      sources: rows.map((r) => ({ source: r.source, items: r.items, lastReportAt: r.last })),
    };
  }
}
