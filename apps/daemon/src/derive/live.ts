/**
 * AI の画面の読み取り（GET /api/ai/live。m2-api 33章、ux-mvp 4.19）: 生きている AI 項目の候補。読むだけで書かない。
 *
 * - running の項目（ターンが開いている・サブエージェントだけが動いている）
 * - Claude Code のプロセスが動いている（ai_session.live_*。「開く」と同じ新しさ）
 * - プロセスの有無が分からない取り込み元（Codex・Claude Desktop）で、最後の動きから 6 時間以内（推定）
 * - 頼んだ起動の片付けが残っている（launches。LaunchService が worktree と turnlane ai run を調べたもの）
 *
 * 判定は core の live.ts（isLiveCandidate・itemProcess・runStartOf）。セッションは最後のターンの項目に付け、統合された項目は
 * 統合先にまとめる。隠した項目は出さない
 */
import type { Database } from "bun:sqlite";
import {
  isLiveCandidate,
  itemProcess,
  type LiveSessionFact,
  runStartOf,
  UNKNOWN_PROCESS_MS,
} from "@turnlane/core";
import type { LiveItem, LiveLaunch, WorkItemStatus } from "@turnlane/core/api";
import { sourcesByWorkItem } from "../planner/common.ts";
import { cardLimitWait } from "./limit.ts";
import { runningSubagentCounts } from "./subagents.ts";
import { titleResolver } from "./subject.ts";

interface WiRow {
  id: string;
  title_auto: string | null;
  title_user: string | null;
  title_source: string | null;
  status: string;
  status_reason: string | null;
  status_estimated: number;
  repo_root: string | null;
  scratch: number;
  branch: string | null;
  pr_ref: string | null;
  hidden_at: number | null;
  merged_into_id: string | null;
  last_activity_at: number;
}

interface SessionRow {
  tool: string;
  live_status: "busy" | "idle" | "gone" | null;
  live_pid: number | null;
  live_checked_at: number | null;
  last_activity_at: number;
  work_item_id: string | null;
}

/** 統合（merged_into_id）を 10 段までたどる */
function resolver(wis: Map<string, WiRow>): (id: string | null) => string | null {
  return (id) => {
    let cur = id;
    for (let i = 0; i < 10 && cur; i++) {
      const next = wis.get(cur)?.merged_into_id ?? null;
      if (!next) return cur;
      cur = next;
    }
    return cur;
  };
}

/**
 * 生きている AI 項目の候補（最後の動きの新しい順）。launches は AI 項目 → 片付けが残っている起動（無ければ空の Map）
 */
export function liveItems(
  db: Database,
  now: number,
  launches: ReadonlyMap<string, LiveLaunch>,
): LiveItem[] {
  const wis = new Map(
    db
      .query<WiRow, []>(
        `SELECT id, title_auto, title_user, title_source, status, status_reason, status_estimated, repo_root, scratch,
                branch, pr_ref, hidden_at, merged_into_id, last_activity_at
         FROM work_item WHERE deleted_at IS NULL`,
      )
      .all()
      .map((w) => [w.id, w]),
  );
  const root = resolver(wis);
  // セッション（サブエージェント・ノイズを除く）: プロセスが動いている扱いのものと、6 時間以内に動いたもの。最後のターンの項目に付ける
  const sessions = db
    .query<SessionRow, [number]>(
      `SELECT s.tool, s.live_status, s.live_pid, s.live_checked_at, s.last_activity_at,
              (SELECT t.work_item_id FROM ai_turn t WHERE t.session_id = s.id AND t.work_item_id IS NOT NULL
                ORDER BY t.started_at DESC LIMIT 1) AS work_item_id
       FROM ai_session s
       WHERE s.is_subagent = 0 AND s.is_noise = 0
         AND (s.live_status IN ('busy', 'idle') OR s.last_activity_at >= ?)`,
    )
    .all(now - UNKNOWN_PROCESS_MS);
  const byItem = new Map<string, LiveSessionFact[]>();
  for (const s of sessions) {
    const id = root(s.work_item_id);
    if (!id) continue;
    byItem.set(id, [
      ...(byItem.get(id) ?? []),
      {
        tool: s.tool,
        liveStatus: s.live_status,
        livePid: s.live_pid,
        liveCheckedAt: s.live_checked_at,
        lastActivityAt: s.last_activity_at,
      },
    ]);
  }
  const subs = new Map<string, number>();
  for (const [id, n] of runningSubagentCounts(db, now)) {
    const r = root(id);
    if (r) subs.set(r, (subs.get(r) ?? 0) + n);
  }
  const launchOf = new Map<string, LiveLaunch>();
  for (const [id, l] of launches) {
    const r = root(id);
    if (r && !launchOf.has(r)) launchOf.set(r, l);
  }
  const cands = new Set<string>([...byItem.keys(), ...launchOf.keys()]);
  for (const w of wis.values()) if (w.status === "running") cands.add(w.id);
  const titles = titleResolver(db);
  const sources = sourcesByWorkItem(db);
  const turnsQ = db.query<
    { started_at: number; ended_at: number | null; duration_ms: number | null },
    [string]
  >("SELECT started_at, ended_at, duration_ms FROM ai_turn WHERE work_item_id = ?");
  const out: LiveItem[] = [];
  for (const id of cands) {
    const w = wis.get(id);
    if (!w || w.hidden_at !== null || w.merged_into_id !== null) continue;
    const { process, liveSessions } = itemProcess(byItem.get(id) ?? [], now);
    const launch = launchOf.get(id) ?? null;
    const status = w.status as WorkItemStatus;
    const base = { status, process, lastActivityAt: w.last_activity_at, launch };
    if (!isLiveCandidate(base, now)) continue;
    const subject = titles.subject(w);
    // 上限待ち（done · rate_limit）は明ける時刻を添える（札を「完了」にしない）
    const lw =
      status === "done" && w.status_reason === "rate_limit" ? cardLimitWait(db, id, now) : null;
    out.push({
      id,
      title: subject.title,
      titleSource: subject.source,
      ...(w.title_user !== null ? { userTitled: true } : {}),
      status,
      reason: w.status_reason,
      estimated: w.status_estimated === 1,
      sources: sources.get(id) ?? [],
      repoRoot: w.repo_root,
      ...(w.scratch === 1 ? { scratch: true } : {}),
      branch: w.branch,
      prRef: w.pr_ref,
      lastActivityAt: w.last_activity_at,
      runStartedAt:
        status === "running"
          ? runStartOf(
              turnsQ.all(id).map((t) => ({
                start: t.started_at,
                end: t.ended_at ?? (t.duration_ms !== null ? t.started_at + t.duration_ms : now),
              })),
            )
          : null,
      process,
      liveSessions,
      subagentsRunning: subs.get(id) ?? 0,
      launch,
      ...(lw ? { limitWait: { since: lw.since, until: lw.until, untilKnown: lw.untilKnown } } : {}),
    });
  }
  return out.sort((a, b) => b.lastActivityAt - a.lastActivityAt || a.id.localeCompare(b.id));
}
