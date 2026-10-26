/**
 * 終わっていないターン（ai_turn の status = running、ended_at が無い）のうち、hook で終わったとみなせるものの時刻
 * （core の openTurnHookEnd）。Stop・StopFailure・idle_prompt の後にトランスクリプトの活動が無いターンを、流れ・AI の時間・
 * 詳細パネル・レーンのブロックで「今」まで伸ばさない。
 *
 * ai_turn は書き換えない（トランスクリプトが正で、取り込みは代入だけ。ADR 0004）。hook は補助なので、読むときに求める
 * （ai-session-ingestion「hooks が補う終わり」）
 */
import type { Database } from "bun:sqlite";
import { derive } from "@turnlane/core";

export interface OpenTurnRef {
  id: string;
  status: string;
  ended_at: number | null;
}

/** turnId → hook で終わったとみなせる時刻。終わっていないターンだけを見る */
export function hookEndsOf(db: Database, turns: readonly OpenTurnRef[]): Map<string, number> {
  const out = new Map<string, number>();
  const open = turns.filter((t) => t.status === "running" && t.ended_at === null);
  if (open.length === 0) return out;
  const meta = db.query<
    {
      started_at: number;
      external_id: string;
      tool: string;
      last_activity_at: number | null;
      next_at: number | null;
    },
    [string]
  >(
    `SELECT t.started_at, s.external_id, s.tool, s.last_activity_at,
            (SELECT MIN(n.started_at) FROM ai_turn n WHERE n.session_id = t.session_id AND n.started_at > t.started_at) AS next_at
     FROM ai_turn t JOIN ai_session s ON s.id = t.session_id WHERE t.id = ?`,
  );
  const hooks = db.query<
    {
      hook_event_name: string;
      notification_type: string | null;
      agent_id: string | null;
      occurred_at: number;
    },
    [string, string, number, number]
  >(
    `SELECT hook_event_name, notification_type, agent_id, occurred_at FROM hook_event
     WHERE session_external_id = ? AND tool = ? AND occurred_at >= ? AND occurred_at < ?
       AND hook_event_name IN ('Stop', 'StopFailure', 'Notification', 'UserPromptSubmit')
     ORDER BY occurred_at, id`,
  );
  for (const t of open) {
    const m = meta.get(t.id);
    if (!m) continue;
    const end = derive.openTurnHookEnd(
      {
        startedAt: m.started_at,
        nextStartedAt: m.next_at,
        sessionLastActivityAt: m.last_activity_at,
      },
      hooks
        .all(m.external_id, m.tool, m.started_at - 1000, m.next_at ?? Number.MAX_SAFE_INTEGER)
        .map((h) => ({
          name: h.hook_event_name,
          notificationType: h.notification_type,
          agentId: h.agent_id,
          occurredAt: h.occurred_at,
        })),
    );
    if (end !== null) out.set(t.id, end);
  }
  return out;
}

/**
 * 行の ended_at を、hook で終わったとみなせる時刻で埋める（終わっていないターンだけ。status はそのまま）。
 * 流れ・AI の時間・レーンのブロックは ended_at があれば終わったターンとして扱う
 */
export function withHookEnds<T extends OpenTurnRef>(db: Database, rows: readonly T[]): T[] {
  const ends = hookEndsOf(db, rows);
  if (ends.size === 0) return [...rows];
  return rows.map((r) => {
    const end = ends.get(r.id);
    return end === undefined ? r : { ...r, ended_at: end };
  });
}
