/**
 * カードの上限待ち（利用枠で止まったセッション。core の limitWaitOf）を読み取りのときに求める。レーンの札
 * （`利用上限 · 15:00 まで`）と待ち線の色に使う。runner と同じ事実（そのカードのターン・セッション・hook・利用枠）から
 * 同じ関数で求めるので、判定を複製しない。カードの理由が rate_limit のときだけ呼ぶ。自分の番の画面の「後で」の行
 * （`limitQueue`）と、その行の対応不要（明けた後の再開のタスクを閉じた形で先に作る）にも使う
 */
import type { Database } from "bun:sqlite";
import { derive } from "@turnlane/core";
import {
  HOOK_WINDOW_MS,
  loadClaudeLimits,
  type SessionRow,
  type TurnRow,
  toSessionFact,
  toTurnFact,
} from "./load.ts";

export interface CardLimitWait {
  /** 止まった時刻 */
  since: number;
  /** 明ける時刻 */
  until: number;
  /** until を利用枠のリセットの時刻から取れた（取れなければ停止から 5 時間） */
  untilKnown: boolean;
  /** 止まったターン（明けた後の再開のタスク `<turn>:limit` の元） */
  turnId: string;
}

const TURN_COLS =
  "id, session_id, turn_key, work_item_id, started_at, ended_at, duration_ms, local_date, status, ended_with, initiator, git_branch, cwd, edited_files_count, pending_question, closing_question";

export function cardLimitWait(db: Database, workItemId: string, now: number): CardLimitWait | null {
  const turns = db
    .query<TurnRow, [string]>(
      `SELECT ${TURN_COLS} FROM ai_turn WHERE work_item_id = ? ORDER BY started_at, id`,
    )
    .all(workItemId);
  if (turns.length === 0) return null;
  const sessIds = [...new Set(turns.map((t) => t.session_id))];
  const marks = sessIds.map(() => "?").join(",");
  const sessions = db
    .query<SessionRow, string[]>(`SELECT * FROM ai_session WHERE id IN (${marks})`)
    .all(...sessIds);
  const sessionTurns = new Map<string, derive.TurnFact[]>();
  for (const id of sessIds)
    sessionTurns.set(
      id,
      db
        .query<TurnRow, [string]>(
          `SELECT ${TURN_COLS} FROM ai_turn WHERE session_id = ? ORDER BY started_at, id`,
        )
        .all(id)
        .map(toTurnFact),
    );
  // 種類の無い停止を前の上限待ちの続きとみなすために、セッションの前のターンの hook も読む（runner の hook の窓と同じ 35 日まで）
  const sessionStarts = [...sessionTurns.values()].flat().map((t) => t.startedAt);
  const since = Math.max(
    Math.min(...turns.map((t) => t.started_at), ...sessionStarts) - 1000,
    now - HOOK_WINDOW_MS,
  );
  const ext = sessions.map((s) => s.external_id);
  const hooks: derive.HookFact[] = db
    .query<
      {
        id: string;
        session_external_id: string;
        tool: string;
        hook_event_name: string;
        notification_type: string | null;
        error_type: string | null;
        config_root: string | null;
        agent_id: string | null;
        quota_horizon: number | null;
        occurred_at: number;
      },
      (string | number)[]
    >(
      `SELECT id, session_external_id, tool, hook_event_name, notification_type, error_type, config_root, agent_id, quota_horizon, occurred_at
       FROM hook_event WHERE session_external_id IN (${ext.map(() => "?").join(",")}) AND occurred_at >= ?
       ORDER BY occurred_at, id`,
    )
    .all(...ext, since)
    .map((r) => ({
      id: r.id,
      sessionExternalId: r.session_external_id,
      tool: r.tool,
      name: r.hook_event_name,
      notificationType: r.notification_type,
      occurredAt: r.occurred_at,
      ...(r.error_type ? { errorType: r.error_type } : {}),
      ...(r.config_root ? { configRoot: r.config_root } : {}),
      // サブエージェントの hook は親のターンの停止に数えない（core の turnStopOf）
      ...(r.agent_id ? { agentId: r.agent_id } : {}),
      ...(r.quota_horizon === 1 ? { horizon: true } : {}),
    }));
  const w = derive.limitWaitOf(
    {
      workItemId,
      kind: "session",
      nonGit: false,
      defaultBranchCard: false,
      turns: turns.map(toTurnFact),
      sessions: sessions.map(toSessionFact),
      sessionTurns,
      hooks,
      prs: [],
      manualDoneAt: null,
      dirty: null,
      followUps: [],
      claudeLimits: loadClaudeLimits(db),
    },
    now,
  );
  return w ? { since: w.at, until: w.until, untilKnown: w.untilKnown, turnId: w.turnId } : null;
}
