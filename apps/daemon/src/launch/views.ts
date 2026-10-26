/**
 * タスクに付く「頼んだ AI」（D-107。plan §B.2）: タスクごとに最後の依頼1件と、その状態（core の taskAiState）。
 * 紐づいたセッションの最後のターンの AI 項目（統合されていれば統合先）の状態と、タスクに付いた開いている自分の番から決める
 */
import type { Database } from "bun:sqlite";
import { taskAiState } from "@turnlane/core";
import type { AiLaunchTool, TaskAiView, WorkItemStatus } from "@turnlane/core/api";
import { blockerOf } from "../derive/views.ts";

interface Row {
  id: string;
  task_id: string;
  tool: AiLaunchTool;
  repo_root: string;
  worktree_path: string | null;
  branch: string | null;
  status: "pending" | "started" | "linked" | "unlinked" | "failed";
  fail_reason: string | null;
  session_id: string | null;
  created_at: number;
  linked_at: number | null;
  updated_at: number;
  unlinked_reason: string | null;
  exit_code: number | null;
  exit_after_ms: number | null;
}

/** 統合（merged_into_id）を10段までたどる */
function resolveWi(db: Database, id: string | null): string | null {
  let cur = id;
  for (let i = 0; i < 10 && cur; i++) {
    const w = db
      .query<{ merged_into_id: string | null }, [string]>(
        "SELECT merged_into_id FROM work_item WHERE id = ?",
      )
      .get(cur);
    if (!w?.merged_into_id) return cur;
    cur = w.merged_into_id;
  }
  return cur;
}

/** 依頼の AI 項目（紐づいたセッションの最後のターンのもの） */
export function launchWorkItem(db: Database, sessionId: string | null): string | null {
  if (!sessionId) return null;
  const t = db
    .query<{ work_item_id: string }, [string]>(
      "SELECT work_item_id FROM ai_turn WHERE session_id = ? AND work_item_id IS NOT NULL ORDER BY started_at DESC LIMIT 1",
    )
    .get(sessionId);
  return resolveWi(db, t?.work_item_id ?? null);
}

/** taskIds を渡せばそのタスクだけ、渡さなければ依頼のあるすべてのタスク */
export function aiByTask(db: Database, taskIds?: readonly string[]): Map<string, TaskAiView> {
  const out = new Map<string, TaskAiView>();
  if (taskIds && taskIds.length === 0) return out;
  const where = taskIds ? `WHERE task_id IN (${taskIds.map(() => "?").join(",")})` : "";
  let rows: Row[];
  try {
    rows = db
      .query<Row, string[]>(
        `SELECT id, task_id, tool, repo_root, worktree_path, branch, status, fail_reason, session_id,
                created_at, linked_at, updated_at, unlinked_reason, exit_code, exit_after_ms
         FROM ai_launch ${where} ORDER BY created_at`,
      )
      .all(...(taskIds ?? []));
  } catch {
    return out;
  }
  const last = new Map<string, Row>();
  for (const r of rows) last.set(r.task_id, r);
  const wiQ = db.query<
    { status: WorkItemStatus; status_reason: string | null; status_changed_at: number },
    [string]
  >("SELECT status, status_reason, status_changed_at FROM work_item WHERE id = ?");
  const fuQ = db.query<{ id: string; kind: string }, [string]>(
    "SELECT id, kind FROM follow_up WHERE task_id = ? AND status IN ('open', 'snoozed') AND deleted_at IS NULL ORDER BY trigger_at DESC LIMIT 1",
  );
  for (const [taskId, r] of last) {
    const wiId = r.status === "linked" ? launchWorkItem(db, r.session_id) : null;
    const w = wiId ? wiQ.get(wiId) : null;
    const fu = fuQ.get(taskId) ?? null;
    const state = taskAiState({
      status: r.status,
      workItem: w ? { status: w.status, reason: w.status_reason } : null,
      openFollowUp: fu?.kind ?? null,
    });
    out.set(taskId, {
      launchId: r.id,
      tool: r.tool,
      state,
      workItemId: wiId,
      followUpId: fu?.id ?? null,
      repoRoot: r.repo_root,
      branch: r.branch,
      worktreePath: r.worktree_path,
      since: w ? Math.max(w.status_changed_at, r.linked_at ?? 0) : r.updated_at,
      failReason: r.fail_reason,
      // 利用枠で止まった（rate_limit）などを拡張が知るため（D-116 の値をそのまま）
      errorKind:
        (state === "error" || state === "limit") && wiId && w
          ? blockerOf(db, wiId, w.status, w.status_reason).errorKind
          : null,
      unlinkedReason:
        r.status === "unlinked" &&
        (r.unlinked_reason === "exited" ||
          r.unlinked_reason === "untrusted" ||
          r.unlinked_reason === "no_session")
          ? r.unlinked_reason
          : null,
      exit:
        r.exit_code !== null && r.exit_after_ms !== null
          ? { code: r.exit_code, afterMs: r.exit_after_ms }
          : null,
    });
  }
  return out;
}
