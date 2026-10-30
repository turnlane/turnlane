/**
 * runner が DB から事実を読む（phase0-plan 3.2 の「事実の読み込み」）。行 → core/derive の型。
 * 読むだけで書かない。
 */

import type { Database } from "bun:sqlite";
import { asksBack } from "@turnlane/collectors";
import type { derive } from "@turnlane/core";

type TurnFact = derive.TurnFact;
type SessionFact = derive.SessionFact;
type HookFact = derive.HookFact;
type PrFact = derive.PrFact;
type FollowUpFact = derive.FollowUpFact;

export interface SessionRow {
  id: string;
  tool: string;
  external_id: string;
  parent_session_id: string | null;
  is_subagent: number;
  is_noise: number;
  has_human_input: number;
  archived: number;
  live_status: "busy" | "idle" | "gone" | null;
  live_checked_at: number | null;
  last_activity_at: number;
  started_at: number;
  /** サブエージェント: トランスクリプトが最後の応答で終わった時刻（終わっていなければ null） */
  ended_at: number | null;
  title: string | null;
  title_source: string | null;
  repo_root: string | null;
  cwd: string | null;
  /** 起動の種類（cli / claude-desktop / sdk-cli など） */
  entrypoint?: string | null;
  /** 報告のセッションのプロジェクトの名前（ADR 0021） */
  project_name?: string | null;
}

export interface TurnRow {
  id: string;
  session_id: string;
  turn_key: string;
  work_item_id: string | null;
  started_at: number;
  ended_at: number | null;
  duration_ms: number | null;
  local_date: string;
  status: TurnFact["status"];
  ended_with: TurnFact["endedWith"];
  initiator: TurnFact["initiator"];
  git_branch: string | null;
  cwd: string | null;
  edited_files_count: number;
  pending_question: number;
  closing_question: number;
  /** 保存した自分の指示の 1 行目（ADR 0018。保存していなければ null。loadTurns だけが付ける） */
  instruction?: string | null;
}

export interface PrRow {
  id: string;
  ref: string;
  session_id: string | null;
  turn_id: string | null;
  work_item_id: string | null;
  url: string | null;
  title: string | null;
  state: PrFact["state"];
  head_ref: string | null;
  state_changed_at: number | null;
  my_review_at: number | null;
  first_seen_at: number;
  state_checked_at: number | null;
}

export interface FollowUpRow {
  id: string;
  work_item_id: string;
  kind: FollowUpFact["kind"];
  artifact_ref: string;
  dedupe_key: string;
  trigger_at: number;
  trigger_turn_id: string | null;
  status: FollowUpFact["status"];
  snooze_until: number | null;
  snoozes_json: string;
  task_id: string | null;
  engaged_at: number | null;
  closed_at: number | null;
  close_reason: string | null;
  created_at: number;
  /** 手で自分の番に戻した時刻（Issue #3。0021。古い行・テストの行には無い） */
  returned_at?: number | null;
  /** loadFollowUps だけが付ける: タスクの時間ブロックの [作った時刻, 開始] の JSON 配列（D-051） */
  scheduled_json?: string | null;
}

export interface WorkItemRow {
  id: string;
  group_key: string;
  repo_root: string | null;
  branch: string | null;
  pr_ref: string | null;
  title_auto: string | null;
  title_source: string | null;
  title_user: string | null;
  status: string;
  status_reason: string | null;
  status_estimated: number;
  status_changed_at: number;
  manual_done_at: number | null;
  merged_into_id: string | null;
  hidden_at: number | null;
  /** 壁打ちのカード（D-135） */
  scratch: number;
  tools_json: string;
  /** プロジェクト（報告のセッションのプロジェクトの名前から。ADR 0021。ほかは null のまま） */
  project_id?: string | null;
  first_activity_at: number;
  last_activity_at: number;
  deleted_at: number | null;
}

export function loadSessions(db: Database): SessionRow[] {
  return db.query<SessionRow, []>("SELECT * FROM ai_session").all();
}

export function loadTurns(db: Database): TurnRow[] {
  return db
    .query<TurnRow, []>(
      `SELECT id, session_id, turn_key, work_item_id, started_at, ended_at, duration_ms, local_date, status, ended_with, initiator, git_branch, cwd, edited_files_count, pending_question, closing_question,
              (SELECT i.text FROM ai_instruction i WHERE i.turn_id = ai_turn.id) AS instruction
       FROM ai_turn ORDER BY started_at, id`,
    )
    .all();
}

/** derive が読む hook の窓（35 日。元のファイルが消えた後の分も hook_event に残る） */
export const HOOK_WINDOW_MS = 35 * 86_400_000;

export function loadHooks(db: Database, since: number): HookFact[] {
  return db
    .query<
      {
        id: string;
        session_external_id: string | null;
        tool: string;
        hook_event_name: string;
        notification_type: string | null;
        error_type: string | null;
        config_root: string | null;
        agent_id: string | null;
        permission_mode: string | null;
        quota_horizon: number | null;
        occurred_at: number;
      },
      [number]
    >(
      // Codex の SessionEnd は app-server のデーモンの入れ替えでも来る（Issue #10）。そのセッションの TUI が生きている間は
      // 終わりの印にしない（待ちを閉じない）
      `SELECT id, session_external_id, tool, hook_event_name, notification_type, error_type, config_root, agent_id, permission_mode, quota_horizon, occurred_at
       FROM hook_event
       WHERE occurred_at >= ?
         AND NOT (tool = 'codex' AND hook_event_name = 'SessionEnd' AND EXISTS (
           SELECT 1 FROM ai_session s WHERE s.tool = 'codex' AND s.external_id = hook_event.session_external_id
             AND s.live_status = 'busy'))
       ORDER BY occurred_at, id`,
    )
    .all(since)
    .filter((r) => r.session_external_id !== null)
    .map((r) => ({
      id: r.id,
      sessionExternalId: r.session_external_id as string,
      tool: r.tool,
      name: r.hook_event_name,
      notificationType: r.notification_type,
      occurredAt: r.occurred_at,
      ...(r.error_type ? { errorType: r.error_type } : {}),
      ...(r.config_root ? { configRoot: r.config_root } : {}),
      ...(r.agent_id ? { agentId: r.agent_id } : {}),
      ...(r.permission_mode ? { permissionMode: r.permission_mode } : {}),
      ...(r.quota_horizon === 1 ? { horizon: true } : {}),
    }));
}

/** Claude の利用枠（claude_limit。アカウントごとの最新の値。上限待ちの終わりの時刻に使う） */
export function loadClaudeLimits(db: Database): derive.ClaudeLimitFact[] {
  try {
    return db
      .query<
        {
          account: string;
          five_hour_pct: number | null;
          five_hour_resets_at: number | null;
          seven_day_pct: number | null;
          seven_day_resets_at: number | null;
        },
        []
      >(
        "SELECT account, five_hour_pct, five_hour_resets_at, seven_day_pct, seven_day_resets_at FROM claude_limit",
      )
      .all()
      .map((r) => ({
        account: r.account,
        fiveHourPct: r.five_hour_pct,
        fiveHourResetsAt: r.five_hour_resets_at,
        sevenDayPct: r.seven_day_pct,
        sevenDayResetsAt: r.seven_day_resets_at,
      }));
  } catch {
    return [];
  }
}

export function loadPrs(db: Database): PrRow[] {
  return db.query<PrRow, []>("SELECT * FROM ai_artifact WHERE kind = 'pr'").all();
}

export function loadFollowUps(db: Database): FollowUpRow[] {
  // タスクを時間に置いていれば、ブロックを作った時刻から開始までを集計外（scheduled）にする（D-051）
  return db
    .query<FollowUpRow, []>(
      `SELECT f.*,
         (SELECT json_group_array(json_array(b.created_at, b.start_at)) FROM time_block b
           WHERE f.task_id IS NOT NULL AND b.task_id = f.task_id AND b.deleted_at IS NULL) AS scheduled_json
       FROM follow_up f WHERE f.deleted_at IS NULL`,
    )
    .all();
}

export function loadWorkItems(db: Database): WorkItemRow[] {
  return db.query<WorkItemRow, []>("SELECT * FROM work_item").all();
}

export function toTurnFact(r: TurnRow): TurnFact {
  return {
    id: r.id,
    sessionId: r.session_id,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    durationMs: r.duration_ms,
    status: r.status,
    endedWith: r.ended_with,
    initiator: r.initiator,
    gitBranch: r.git_branch,
    cwd: r.cwd,
    editedFiles: r.edited_files_count,
    pendingQuestion: r.pending_question === 1,
    closingQuestion: r.closing_question === 1,
    localDate: r.local_date,
    // 問い返し（Issue #3）: 保存した指示の 1 行目が問いの形か。保存していなければ判定しない
    ...(typeof r.instruction === "string" ? { instructionAsks: asksBack(r.instruction) } : {}),
  };
}

export function toSessionFact(r: SessionRow): SessionFact {
  return {
    id: r.id,
    tool: r.tool,
    externalId: r.external_id,
    parentId: r.parent_session_id,
    isSubagent: r.is_subagent === 1,
    isNoise: r.is_noise === 1,
    archived: r.archived === 1,
    liveStatus: r.live_status,
    liveCheckedAt: r.live_checked_at,
    lastActivityAt: r.last_activity_at,
    entrypoint: r.entrypoint ?? null,
  };
}

/** サブエージェントのセッション（ターンを持たないもの）→ 判定の事実。agentId は `<親>/agent-<id>` の <id> */
export function toSubagentFact(r: SessionRow): derive.SubagentFact | null {
  if (r.is_subagent !== 1 || !r.parent_session_id) return null;
  const m = /\/agent-([^/]+)$/.exec(r.external_id);
  return {
    id: r.id,
    parentId: r.parent_session_id,
    agentId: m?.[1] ?? null,
    startedAt: r.started_at,
    lastActivityAt: r.last_activity_at,
    endedAt: r.ended_at,
  };
}

export function prNumber(ref: string): number {
  return Number(ref.slice(ref.lastIndexOf("#") + 1)) || 0;
}

export function toPrFact(r: PrRow): PrFact {
  return {
    ref: r.ref,
    number: prNumber(r.ref),
    state: r.state,
    headRef: r.head_ref,
    title: r.title,
    firstSeenAt: r.first_seen_at,
    stateChangedAt: r.state_changed_at,
    myReviewAt: r.my_review_at,
    stateCheckedAt: r.state_checked_at,
  };
}

export function parseSnoozes(json: string): [number, number][] {
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v)
      ? v.filter(
          (x): x is [number, number] =>
            Array.isArray(x) && typeof x[0] === "number" && typeof x[1] === "number",
        )
      : [];
  } catch {
    return [];
  }
}

export function toFollowUpFact(r: FollowUpRow): FollowUpFact {
  return {
    id: r.id,
    kind: r.kind,
    artifactRef: r.artifact_ref,
    dedupeKey: r.dedupe_key,
    triggerAt: r.trigger_at,
    triggerTurnId: r.trigger_turn_id,
    status: r.status,
    snoozeUntil: r.snooze_until,
    snoozes: parseSnoozes(r.snoozes_json),
    ...(r.scheduled_json ? { scheduled: parseSnoozes(r.scheduled_json) } : {}),
    createdAt: r.created_at,
    engagedAt: r.engaged_at,
    closedAt: r.closed_at,
    closeReason: r.close_reason,
    returnedAt: r.returned_at ?? null,
  };
}
