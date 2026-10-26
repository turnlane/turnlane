/**
 * ⌘K の検索（GET /api/search。m2-api.md 17章、M2-15）。
 * 見るのはタスクの題名、AI 項目の題名・リポジトリ名・ブランチ・PR 番号、予定の題名だけ。
 * セッションの本文・プロンプト・ツールの入力、タスクのメモ、予定の場所は読まない（ADR 0005）。
 */
import type { Database } from "bun:sqlite";
import {
  matchesAll,
  repoName,
  searchTokens,
  type TurnlaneSettings,
  toLocalDate,
} from "@turnlane/core";
import type {
  SearchAiItem,
  SearchEvent,
  SearchResponse,
  SearchTask,
  TitleSpec,
  WorkItemStatus,
} from "@turnlane/core/api";
import {
  readMeta,
  resolveTaskTitles,
  sourcesByWorkItem,
  type TaskRow,
  viewsFor,
} from "./common.ts";

/** 題名の検索に使う文字列（自動生成の題名は解決した params。6.1） */
function titleHaystack(t: TitleSpec): string {
  if (t.t === "text") return t.text;
  const p = t.params;
  return [p.title, p.repo, p.branch, p.pr !== null ? `PR #${p.pr}` : null, p.prTitle]
    .filter((x) => x !== null)
    .join(" ");
}

const prNumber = (ref: string | null): number | null => {
  if (!ref) return null;
  const n = Number(ref.slice(ref.lastIndexOf("#") + 1));
  return Number.isInteger(n) && n > 0 ? n : null;
};

export function searchAll(
  db: Database,
  settings: TurnlaneSettings,
  now: number,
  rev: number,
  q: string,
  limit: number,
): SearchResponse {
  const tokens = searchTokens(q);
  const meta = readMeta(settings, now, rev);
  return {
    ...meta,
    q,
    tasks: searchTasks(db, tokens, limit, meta.today),
    aiItems: searchAiItems(db, settings, tokens, limit),
    events: searchEvents(db, settings, now, tokens, limit),
  };
}

function searchTasks(db: Database, tokens: string[], limit: number, today: string): SearchTask[] {
  const rows = db
    .query<TaskRow, []>("SELECT * FROM task WHERE deleted_at IS NULL AND status <> 'canceled'")
    .all();
  const titles = resolveTaskTitles(db, rows);
  const hits = rows.filter((r) =>
    matchesAll(titleHaystack(titles.get(r.id) ?? { t: "text", text: r.title }), tokens),
  );
  const dist = (d: string | null) =>
    d === null ? Number.POSITIVE_INFINITY : Math.abs(Date.parse(d) - Date.parse(today));
  hits.sort((a, b) => {
    const da = a.status === "done" ? 1 : 0;
    const db_ = b.status === "done" ? 1 : 0;
    if (da !== db_) return da - db_;
    if (da === 1) return (b.completed_at ?? 0) - (a.completed_at ?? 0);
    return dist(a.scheduled_date) - dist(b.scheduled_date) || b.updated_at - a.updated_at;
  });
  return viewsFor(db, hits.slice(0, limit)).map((task) => ({ task }));
}

function searchAiItems(
  db: Database,
  settings: TurnlaneSettings,
  tokens: string[],
  limit: number,
): SearchAiItem[] {
  const rows = db
    .query<
      {
        id: string;
        title_user: string | null;
        title_auto: string | null;
        repo_root: string | null;
        scratch: number;
        branch: string | null;
        pr_ref: string | null;
        status: WorkItemStatus;
        status_estimated: number;
        last_activity_at: number;
      },
      []
    >(
      `SELECT id, title_user, title_auto, repo_root, scratch, branch, pr_ref, status, status_estimated, last_activity_at
       FROM work_item
       WHERE deleted_at IS NULL AND merged_into_id IS NULL AND hidden_at IS NULL
       ORDER BY last_activity_at DESC`,
    )
    .all();
  const prs = new Map<string, number[]>();
  for (const r of db
    .query<{ work_item_id: string; ref: string }, []>(
      "SELECT work_item_id, ref FROM ai_artifact WHERE kind = 'pr' AND work_item_id IS NOT NULL ORDER BY first_seen_at DESC",
    )
    .all()) {
    const n = prNumber(r.ref);
    if (n === null) continue;
    const xs = prs.get(r.work_item_id) ?? [];
    if (!xs.includes(n)) xs.push(n);
    prs.set(r.work_item_id, xs);
  }
  const out: SearchAiItem[] = [];
  let sources: ReturnType<typeof sourcesByWorkItem> | null = null;
  for (const w of rows) {
    const nums = [...new Set([prNumber(w.pr_ref), ...(prs.get(w.id) ?? [])])].filter(
      (n): n is number => n !== null,
    );
    const title = w.title_user ?? w.title_auto;
    const repo = repoName(w.repo_root);
    // 壁打ち（D-135）は「Scratch」「壁打ち」でも引ける
    const hay = [
      title,
      repo,
      w.scratch === 1 ? "Scratch 壁打ち" : null,
      w.branch,
      ...nums.map((n) => `PR #${n}`),
    ]
      .filter((x) => x !== null)
      .join(" ");
    if (!matchesAll(hay, tokens)) continue;
    sources ??= sourcesByWorkItem(db);
    out.push({
      id: w.id,
      title,
      status: w.status,
      estimated: w.status_estimated === 1,
      sources: sources.get(w.id) ?? [],
      repo,
      ...(w.scratch === 1 ? { scratch: true } : {}),
      branch: w.branch,
      prs: nums,
      lastActivityAt: w.last_activity_at,
      date: toLocalDate(w.last_activity_at, settings.tz, 0),
    });
    if (out.length >= limit) break;
  }
  return out;
}

function searchEvents(
  db: Database,
  settings: TurnlaneSettings,
  now: number,
  tokens: string[],
  limit: number,
): SearchEvent[] {
  const rows = db
    .query<
      {
        id: string;
        title: string | null;
        start_at: number;
        end_at: number;
        all_day: number;
        start_date: string | null;
      },
      []
    >(
      `SELECT e.id, e.title, e.start_at, e.end_at, e.all_day, e.start_date
       FROM calendar_event e JOIN calendar c ON c.id = e.calendar_id
       WHERE c.role = 'source' AND e.is_own_timeblock = 0
         AND (e.status IS NULL OR e.status <> 'cancelled') AND e.title IS NOT NULL`,
    )
    .all();
  return rows
    .filter((e) => matchesAll(e.title ?? "", tokens))
    .sort((a, b) => Math.abs(a.start_at - now) - Math.abs(b.start_at - now))
    .slice(0, limit)
    .map((e) => ({
      id: e.id,
      title: e.title,
      start: e.start_at,
      end: e.end_at,
      allDay: e.all_day === 1,
      date:
        e.all_day === 1 && e.start_date ? e.start_date : toLocalDate(e.start_at, settings.tz, 0),
    }));
}
