/**
 * turnlane ai report（ADR 0021。phase0-plan 3.6）: 自分のスクリプト・エージェントの作業の状態を Turnlane に書く第一の口。
 * MCP の report_ai_work と POST /api/ai/reports と同じ型（collectors の report.ts）。
 * - デーモンに届けば HTTP（Bearer）。届かなければ spool/report-YYYYMMDD.jsonl に 1 行追記して exit 0（turnlane add と同じ。
 *   デーモンが起きたときに取り込む）。spool にも書けなければ exit 1 と 1 行
 * - client_id（UUIDv7）を付けて送るので、HTTP と spool のどちらで届いても 1 回だけ反映する
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  parseReport,
  type ReportInput,
  reportSpoolName,
  reportSpoolText,
  toReportSpoolLine,
} from "@turnlane/collectors";
import type { ReportResponse } from "@turnlane/core/api";
import { callApi, fetchHealth } from "../client.ts";
import type { CliEnv } from "../env.ts";
import { tr } from "../lang.ts";

export interface AiReportOptions {
  source?: string | undefined;
  id?: string | undefined;
  title?: string | undefined;
  project?: string | undefined;
  state?: string | undefined;
  kind?: string | undefined;
  text?: string | undefined;
  options: string[];
  label?: string | undefined;
  errorKind?: string | undefined;
  url?: string | undefined;
  at?: string | undefined;
  clientId?: string | undefined;
  json: boolean;
}

/** オプション → 報告の型（検証は parseReport） */
export function reportBody(o: AiReportOptions): Record<string, unknown> {
  const body: Record<string, unknown> = { source: o.source, id: o.id, state: o.state };
  if (o.title !== undefined) body.title = o.title;
  if (o.project !== undefined) body.project = o.project;
  if (o.kind !== undefined || o.text !== undefined || o.options.length > 0 || o.label !== undefined)
    body.wait = {
      kind: o.kind ?? (o.state === "waiting" ? "question" : undefined),
      text: o.text,
      ...(o.options.length > 0 ? { options: o.options } : {}),
      ...(o.label !== undefined ? { label: o.label } : {}),
    };
  if (o.errorKind !== undefined) body.error = { kind: o.errorKind };
  if (o.url !== undefined) body.url = o.url;
  if (o.at !== undefined) body.at = /^\d+$/.test(o.at) ? Number(o.at) : Date.parse(o.at);
  if (o.clientId !== undefined) body.client_id = o.clientId;
  return body;
}

/** 検証できなかった項目 → オプションの名前 */
const OPTION_OF: Record<string, string> = {
  source: "--source",
  id: "--id",
  state: "--state",
  title: "--title",
  project: "--project",
  wait: "--kind / --text",
  "wait.kind": "--kind",
  "wait.text": "--text",
  "wait.options": "--option",
  "wait.label": "--label",
  error: "--error-kind",
  "error.kind": "--error-kind",
  url: "--url",
  at: "--at",
  client_id: "--client-id",
  body: "--text / --title",
};

export async function aiReportCommand(
  env: CliEnv,
  o: AiReportOptions,
  now: () => number = Date.now,
): Promise<number> {
  const p = parseReport(reportBody(o));
  if (!p.ok) {
    env.err(
      tr(
        `turnlane ai report: check ${OPTION_OF[p.field] ?? p.field}`,
        `turnlane ai report: ${OPTION_OF[p.field] ?? p.field} を確かめてください`,
      ),
    );
    return 2;
  }
  const report: ReportInput = { ...p.report, client_id: p.report.client_id ?? Bun.randomUUIDv7() };
  if (await fetchHealth(env.paths)) {
    const r = await callApi<ReportResponse | { error: string; field?: string }>(
      env.paths,
      "POST",
      "/api/ai/reports",
      report,
    ).catch(() => null);
    if (r?.ok && "accepted" in r.data) {
      const d = r.data;
      if (o.json)
        env.out(JSON.stringify({ accepted: true, workItemId: d.workItemId, queued: d.queued }));
      return 0;
    }
    if (r && r.status === 400) {
      const f = "field" in r.data ? r.data.field : undefined;
      env.err(
        tr(
          `turnlane ai report: check ${(f && OPTION_OF[f]) ?? f ?? "the options"}`,
          `turnlane ai report: ${(f && OPTION_OF[f]) ?? f ?? "オプション"} を確かめてください`,
        ),
      );
      return 2;
    }
    // デーモンが受けられなかった（spool に書けないなど）: 自分で spool に書く
  }
  const at = now();
  const text = reportSpoolText(toReportSpoolLine(report, at, report.client_id as string));
  if (text === null) {
    env.err(
      tr("turnlane ai report: the report is too long", "turnlane ai report: 報告が長すぎます"),
    );
    return 2;
  }
  try {
    mkdirSync(env.paths.spoolDir, { recursive: true, mode: 0o700 });
    appendFileSync(join(env.paths.spoolDir, reportSpoolName(at)), text, { mode: 0o600 });
  } catch {
    env.err(
      `Turnlane: could not reach the daemon or write to ${env.paths.spoolDir} (the sandbox may need approval)`,
    );
    return 1;
  }
  if (o.json) env.out(JSON.stringify({ accepted: true, workItemId: null, queued: true }));
  return 0;
}
