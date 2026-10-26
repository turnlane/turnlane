/**
 * 頼んだ AI と判定のつなぎ（D-107。plan §B.2）: 紐づいたセッションを持つ AI 項目には、頼んだタスクがある。
 * - 判定（derive runner）は事実に「依頼した時刻と、頼んだタスクを閉じた時刻」を足す（AI 完了からの待ち）
 * - 自分の番は新しいタスクを作らず、頼んだタスクに付ける（同じ用件がボードに2枚並ばない）
 * - 自分の番が閉じても、頼んだタスクは閉じない（タスクを閉じるのは本人）
 */
import type { Database } from "bun:sqlite";

export interface LaunchLink {
  sessionId: string;
  taskId: string;
  createdAt: number;
  /** 頼んだタスクを閉じた時刻（完了・取り消し・削除）。開いていれば null */
  closedAt: number | null;
  /** 頼んだタスクが開いている（todo / doing で削除されていない） */
  alive: boolean;
}

export function loadLaunchLinks(db: Database): LaunchLink[] {
  return db
    .query<
      {
        session_id: string;
        task_id: string;
        created_at: number;
        status: string;
        completed_at: number | null;
        deleted_at: number | null;
        updated_at: number;
      },
      []
    >(
      `SELECT l.session_id, l.task_id, l.created_at, t.status, t.completed_at, t.deleted_at, t.updated_at
       FROM ai_launch l JOIN task t ON t.id = l.task_id
       WHERE l.session_id IS NOT NULL ORDER BY l.created_at`,
    )
    .all()
    .map((r) => {
      const alive = r.deleted_at === null && (r.status === "todo" || r.status === "doing");
      return {
        sessionId: r.session_id,
        taskId: r.task_id,
        createdAt: r.created_at,
        closedAt: alive ? null : (r.deleted_at ?? r.completed_at ?? r.updated_at),
        alive,
      };
    });
}

/** AI 項目のセッションに紐づいた依頼のうち最後のもの（無ければ null） */
export function launchForSessions(
  links: readonly LaunchLink[],
  sessionIds: readonly string[],
): LaunchLink | null {
  let best: LaunchLink | null = null;
  for (const l of links)
    if (sessionIds.includes(l.sessionId) && (!best || l.createdAt >= best.createdAt)) best = l;
  return best;
}

/**
 * AI に頼んだタスクか（ai_launch がある）。頼んだタスクに付けた自分の番が閉じても、タスクは閉じない
 * （自分の番が作ったタスクだけを自動で閉じる。D-107）
 */
export function isLaunchTask(db: Database, taskId: string): boolean {
  return (
    db
      .query<{ n: number }, [string]>("SELECT count(*) AS n FROM ai_launch WHERE task_id = ?")
      .get(taskId)?.n !== 0
  );
}
