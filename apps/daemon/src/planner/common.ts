/**
 * 読み取り API（/api/board・/api/queue・/api/inbox など）の共通部品（m2-api.md 2.4・6.1）。
 * - 自動生成タスクの題名を読み取り時に AI 項目の現在の値で組み立てる（resolveTaskTitles。D-047 (3)）
 * - AI 項目のソースバッジ（CC / CX / CD、同じツールの有効なソースが2つ以上のときだけ profile）
 * - TaskView の組み立て
 */

import type { Database } from "bun:sqlite";
import { cleanTitle } from "@turnlane/collectors";
import {
  parseTaskTitleParams,
  TASK_TITLE_KEYS,
  type TaskTitleKey,
  type TurnlaneSettings,
  toLocalDate,
} from "@turnlane/core";
import type {
  ReadMeta,
  SourceBadge,
  SourceTool,
  TaskAiView,
  TaskView,
  TitleSpec,
} from "@turnlane/core/api";
import { titleResolver } from "../derive/subject.ts";
import { aiByTask } from "../launch/views.ts";

export function readMeta(settings: TurnlaneSettings, now: number, rev: number): ReadMeta {
  return {
    today: toLocalDate(now, settings.tz, settings.dayBoundary),
    displayToday: toLocalDate(now, settings.tz, 0),
    now,
    rev,
    tz: settings.tz,
    dayBoundary: settings.dayBoundary,
  };
}

export interface TaskRow {
  id: string;
  title: string;
  notes_md: string | null;
  status: TaskView["status"];
  scheduled_date: string | null;
  lane_order: string;
  estimate_min: number | null;
  priority: number;
  project_id: string | null;
  source: TaskView["origin"]["source"];
  source_ref: string | null;
  external_source: string | null;
  external_id: string | null;
  external_url: string | null;
  rollover_count: number;
  is_highlight: number;
  started_at: number | null;
  completed_at: number | null;
  auto_completed: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  title_key: string | null;
  title_params: string | null;
}

function isKey(k: string | null): k is TaskTitleKey {
  return k !== null && (TASK_TITLE_KEYS as readonly string[]).includes(k);
}

const repoName = (root: string | null) =>
  root ? (root.split("/").filter(Boolean).at(-1) ?? null) : null;

/**
 * 自動生成タスクの題名を読み取り時に解決する（m2-api.md 6.1）。title_params は作成時点の値なので、
 * task → follow_up.task_id → work_item（統合は merged_into_id を10段まで）→ ai_artifact(kind='pr') の現在の値で上書きする
 */
export function resolveTaskTitles(
  db: Database,
  tasks: readonly Pick<TaskRow, "id" | "title" | "title_key" | "title_params">[],
): Map<string, TitleSpec> {
  const out = new Map<string, TitleSpec>();
  const auto = tasks.filter((t) => isKey(t.title_key));
  for (const t of tasks) if (!isKey(t.title_key)) out.set(t.id, { t: "text", text: t.title });
  if (auto.length === 0) return out;
  const ids = auto.map((t) => t.id);
  const placeholders = ids.map(() => "?").join(",");
  const links = new Map(
    db
      .query<{ task_id: string; work_item_id: string }, string[]>(
        `SELECT task_id, work_item_id FROM follow_up WHERE task_id IN (${placeholders})`,
      )
      .all(...ids)
      .map((r) => [r.task_id, r.work_item_id]),
  );
  const wis = new Map(
    db
      .query<
        {
          id: string;
          title_user: string | null;
          title_auto: string | null;
          title_source: string | null;
          repo_root: string | null;
          branch: string | null;
          merged_into_id: string | null;
          scratch: number;
        },
        []
      >(
        "SELECT id, title_user, title_auto, title_source, repo_root, branch, merged_into_id, scratch FROM work_item",
      )
      .all()
      .map((w) => [w.id, w]),
  );
  const resolve = (id: string | undefined) => {
    let w = id ? wis.get(id) : undefined;
    for (let i = 0; i < 10 && w?.merged_into_id; i++) {
      const next = wis.get(w.merged_into_id);
      if (!next) break;
      w = next;
    }
    return w;
  };
  const titles = titleResolver(db);
  const prTitles = new Map<string, Map<number, string>>();
  for (const r of db
    .query<{ work_item_id: string; ref: string; title: string | null }, []>(
      "SELECT work_item_id, ref, title FROM ai_artifact WHERE kind = 'pr' AND work_item_id IS NOT NULL",
    )
    .all()) {
    const n = Number(r.ref.slice(r.ref.lastIndexOf("#") + 1));
    if (!r.title || !Number.isFinite(n)) continue;
    let m = prTitles.get(r.work_item_id);
    if (!m) {
      m = new Map();
      prTitles.set(r.work_item_id, m);
    }
    m.set(n, r.title);
  }
  for (const t of auto) {
    const p = parseTaskTitleParams(t.title_params);
    const w = resolve(links.get(t.id));
    if (w) {
      // 件名は subject.ts の順（ai-title → PR の題名 → ブランチ。問い・許可の待ちの間は PR の題名を使わない。spec-glance §2.2）
      p.title = titles.subject(w).title ?? cleanTitle(p.title, Number.POSITIVE_INFINITY);
      p.repo = repoName(w.repo_root) ?? p.repo;
      p.branch = w.branch ?? p.branch;
      if (w.scratch === 1) p.scratch = true;
      if (p.pr !== null) p.prTitle = prTitles.get(w.id)?.get(p.pr) ?? p.prTitle;
    }
    out.set(t.id, { t: "auto", key: t.title_key as TaskTitleKey, params: p });
  }
  return out;
}

/** AI 項目 → ソースバッジ（セッションの取り込み元から。profile は同じツールの有効なソースが2つ以上のときだけ） */
export function sourcesByWorkItem(db: Database): Map<string, SourceBadge[]> {
  const multi = new Set(
    db
      .query<{ tool: string }, []>(
        "SELECT tool FROM ai_source WHERE enabled = 1 GROUP BY tool HAVING count(*) > 1",
      )
      .all()
      .map((r) => r.tool),
  );
  const out = new Map<string, SourceBadge[]>();
  for (const r of db
    .query<{ work_item_id: string; tool: string; profile_label: string | null }, []>(
      `SELECT DISTINCT t.work_item_id, s.tool, src.profile_label
       FROM ai_turn t JOIN ai_session s ON s.id = t.session_id JOIN ai_source src ON src.id = s.source_id
       WHERE t.work_item_id IS NOT NULL ORDER BY s.tool, src.profile_label`,
    )
    .all()) {
    const badge: SourceBadge = {
      tool: r.tool as SourceTool,
      profile: multi.has(r.tool) ? (r.profile_label ?? null) : null,
    };
    const xs = out.get(r.work_item_id) ?? [];
    if (!xs.some((x) => x.tool === badge.tool && x.profile === badge.profile)) xs.push(badge);
    out.set(r.work_item_id, xs);
  }
  return out;
}

/** デスクトップアプリのクイック入力で作ったタスクの source_ref（task.source は manual） */
export const DESKTOP_SOURCE_REF = "desktop:quick_add";

/** source_ref（`mcp:<client>:<cwd>`）から MCP のクライアント名 */
export function mcpClient(sourceRef: string | null): string | null {
  if (!sourceRef?.startsWith("mcp:")) return null;
  const rest = sourceRef.slice(4);
  const i = rest.indexOf(":");
  return (i >= 0 ? rest.slice(0, i) : rest) || null;
}

export function taskView(
  r: TaskRow,
  titles: Map<string, TitleSpec>,
  fuIn: { followUpId: string; workItemId: string; status?: string } | undefined,
  ai?: TaskAiView,
): TaskView {
  // 頼んだタスク（D-107）は自分の番が付いている間だけ自分の番のタスク（閉じた自分の番は持たない）
  const fu = ai && fuIn && fuIn.status !== "open" && fuIn.status !== "snoozed" ? undefined : fuIn;
  return {
    id: r.id,
    title: titles.get(r.id) ?? { t: "text", text: r.title },
    status: r.status,
    scheduledDate: r.scheduled_date,
    laneOrder: r.lane_order,
    estimateMin: r.estimate_min,
    projectId: r.project_id,
    rolloverCount: r.rollover_count,
    isHighlight: r.is_highlight === 1,
    completedAt: r.completed_at,
    autoCompleted: r.auto_completed === 1,
    origin: {
      source: r.source_ref === DESKTOP_SOURCE_REF ? "desktop" : r.source,
      client: mcpClient(r.source_ref),
      externalSource: r.external_source,
      externalUrl: r.external_url,
    },
    followUpId: fu?.followUpId ?? null,
    // AI カードから作った確認タスクは source_ref（work_item:<id>）から（m2-api 19章）
    workItemId:
      fu?.workItemId ??
      ai?.workItemId ??
      (r.source_ref?.startsWith("work_item:") ? r.source_ref.slice("work_item:".length) : null),
    createdAt: r.created_at,
    deletedAt: r.deleted_at,
    ...(ai ? { ai } : {}),
    ...(r.notes_md?.trim() ? { hasNotes: true } : {}),
  };
}

/** タスク → フォローアップ（自分の番のタスクか、どの AI 項目か） */
export function followUpsByTask(
  db: Database,
): Map<string, { followUpId: string; workItemId: string; status: string }> {
  return new Map(
    db
      .query<{ task_id: string; id: string; work_item_id: string; status: string }, []>(
        // 頼んだタスク（D-107）には複数付きうる。開いているもの（後ろに並べる）を優先する
        `SELECT task_id, id, work_item_id, status FROM follow_up WHERE task_id IS NOT NULL AND deleted_at IS NULL
         ORDER BY status IN ('open', 'snoozed'), trigger_at`,
      )
      .all()
      .map((r) => [r.task_id, { followUpId: r.id, workItemId: r.work_item_id, status: r.status }]),
  );
}

export function viewsFor(db: Database, rows: TaskRow[]): TaskView[] {
  const titles = resolveTaskTitles(db, rows);
  const fus = followUpsByTask(db);
  const ai = aiByTask(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((r) => taskView(r, titles, fus.get(r.id), ai.get(r.id)));
}
