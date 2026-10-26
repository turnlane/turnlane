/**
 * サブエージェント（ターンを持たない ai_session。Claude Code の `subagents/agent-<id>.jsonl`）だけが動いていた区間
 * （ai-session-ingestion 4.5）。親のターンが閉じた後もサブエージェントが動いていた時間を、親のカードの AI の時間・レーンの
 * ブロックに 1 回だけ足す。親のターンの区間（turn_duration に含まれる分）と並列のサブエージェントどうしは二重に数えない。
 * 読むだけで書かない。
 */
import type { Database } from "bun:sqlite";
import { derive } from "@turnlane/core";
import { withHookEnds } from "./hook-end.ts";

/** サブエージェントがまだ動いているとみなす最後の活動からの時間（Claude Code の runningStale と同じ） */
const SUBAGENT_STALE_MS = 5 * 60_000;

export interface SubagentRun {
  workItemId: string;
  /** 区間を付けた親のターンの論理日（AI の時間の日付。ターンと同じ帰属） */
  localDate: string;
  start: number;
  end: number;
  /** 今も動いている（親のカードが subagent:running で、区間が now まで続く） */
  open: boolean;
}

interface SubRow {
  id: string;
  parent_session_id: string;
  started_at: number;
  last_activity_at: number;
  ended_at: number | null;
}

interface ParentTurnRow {
  id: string;
  work_item_id: string | null;
  local_date: string;
  started_at: number;
  ended_at: number | null;
  duration_ms: number | null;
  status: string;
  last_activity_at: number;
  is_noise: number;
  wi_status: string | null;
  wi_reason: string | null;
}

/**
 * [from, to) にかかるサブエージェントだけの区間。サブエージェントは、その始まりの時点で親が動かしていたターン
 * （始まりが同じか前の最後のターン）のカードに付ける（グルーピングの規則 6 と同じ）。waits はカード → 開いている待ちの
 * 始まり（親の終わっていないターンの区間を AI の時間と同じに切るため）
 */
export function subagentRuns(
  db: Database,
  now: number,
  range: { from: number; to: number },
  waits: Map<string, number>,
): SubagentRun[] {
  const subs = db
    .query<SubRow, [number, number]>(
      `SELECT s.id, s.parent_session_id, s.started_at, s.last_activity_at, s.ended_at FROM ai_session s
       WHERE s.is_subagent = 1 AND s.parent_session_id IS NOT NULL
         AND s.last_activity_at >= ? AND s.started_at < ?
         AND NOT EXISTS (SELECT 1 FROM ai_turn t WHERE t.session_id = s.id)`,
    )
    .all(range.from, range.to);
  if (subs.length === 0) return [];
  const byParent = new Map<string, SubRow[]>();
  for (const s of subs)
    byParent.set(s.parent_session_id, [...(byParent.get(s.parent_session_id) ?? []), s]);
  const out: SubagentRun[] = [];
  const parentTurns = db.query<ParentTurnRow, [string]>(
    `SELECT t.id, t.work_item_id, t.local_date, t.started_at, t.ended_at, t.duration_ms, t.status, p.last_activity_at,
            p.is_noise, w.status AS wi_status, w.status_reason AS wi_reason
     FROM ai_turn t JOIN ai_session p ON p.id = t.session_id LEFT JOIN work_item w ON w.id = t.work_item_id
     WHERE t.session_id = ? ORDER BY t.started_at`,
  );
  for (const [parentId, list] of byParent) {
    // StopFailure・idle_prompt の後に活動の無い終わっていない親のターンは、その hook の時刻で終わったものとして扱う
    const turns = withHookEnds(db, parentTurns.all(parentId));
    if (turns.length === 0 || turns[0]?.is_noise === 1) continue;
    const intervals = turns.map((t) =>
      derive.turnAiInterval(
        {
          startedAt: t.started_at,
          endedAt: t.ended_at,
          durationMs: t.duration_ms,
          status: t.status,
          sessionLastActivityAt: t.last_activity_at,
        },
        {
          status: t.wi_status ?? "done",
          openWaitStart: t.work_item_id ? (waits.get(t.work_item_id) ?? null) : null,
          now,
        },
      ),
    );
    // カードごとに、そのカードに付くサブエージェントの区間を集める
    const byCard = new Map<
      string,
      { turn: ParentTurnRow; ranges: [number, number][]; open: boolean }
    >();
    for (const s of list) {
      const turn = [...turns].reverse().find((t) => t.started_at <= s.started_at) ?? turns[0];
      if (!turn?.work_item_id) continue;
      const open =
        s.ended_at === null &&
        now - s.last_activity_at <= SUBAGENT_STALE_MS &&
        turn.wi_status === "running" &&
        turn.wi_reason === "subagent:running";
      const r = derive.subagentInterval(
        { startedAt: s.started_at, lastActivityAt: s.last_activity_at, endedAt: s.ended_at },
        open,
        now,
      );
      const c = byCard.get(turn.work_item_id) ?? { turn, ranges: [], open: false };
      c.ranges.push(r);
      c.open ||= open;
      byCard.set(turn.work_item_id, c);
    }
    for (const [wi, c] of byCard) {
      for (const [start, end] of derive.subagentOnlyRanges(intervals, c.ranges)) {
        if (end <= range.from || start >= range.to) continue;
        out.push({
          workItemId: wi,
          localDate: c.turn.local_date,
          start,
          end,
          open: c.open && end >= now,
        });
      }
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/**
 * 今も動いているサブエージェントの数（AI の画面の `サブ 2`）: 終わっておらず、最後の活動から SUBAGENT_STALE_MS 以内の
 * サブエージェント。付けるカードは subagentRuns と同じ（その始まりの時点で親が動かしていたターンのカード）。
 * 統合（merged_into_id）はたどらない（呼び出し側で統合先に足す）
 */
export function runningSubagentCounts(db: Database, now: number): Map<string, number> {
  const subs = db
    .query<{ parent_session_id: string; started_at: number }, [number]>(
      `SELECT s.parent_session_id, s.started_at FROM ai_session s
       WHERE s.is_subagent = 1 AND s.parent_session_id IS NOT NULL AND s.ended_at IS NULL
         AND s.last_activity_at >= ?
         AND NOT EXISTS (SELECT 1 FROM ai_turn t WHERE t.session_id = s.id)`,
    )
    .all(now - SUBAGENT_STALE_MS);
  const out = new Map<string, number>();
  if (subs.length === 0) return out;
  const turnsQ = db.query<{ work_item_id: string | null; started_at: number }, [string]>(
    "SELECT work_item_id, started_at FROM ai_turn WHERE session_id = ? ORDER BY started_at",
  );
  const cache = new Map<string, { work_item_id: string | null; started_at: number }[]>();
  for (const s of subs) {
    let turns = cache.get(s.parent_session_id);
    if (!turns) {
      turns = turnsQ.all(s.parent_session_id);
      cache.set(s.parent_session_id, turns);
    }
    const turn = [...turns].reverse().find((t) => t.started_at <= s.started_at) ?? turns[0];
    if (!turn?.work_item_id) continue;
    out.set(turn.work_item_id, (out.get(turn.work_item_id) ?? 0) + 1);
  }
  return out;
}
