/**
 * hook で答える（ADR 0023）: hook の待ちの判定に使う DB の事実。プログラム経由のセッションか、カードに同じ待ちが開いているか、
 * 待ちを開いた後に届いたそのセッションの hook のイベント。読むのは識別子・種類・時刻だけ
 */
import type { Database } from "bun:sqlite";
import { derive, type HookWaitEntry, type LaterHook } from "@turnlane/core";
import { SESSION_SELECT, type SessionRow, toSessionFact } from "../derive/load.ts";
import { sessionOf } from "../glance/index.ts";
import { openWaitFor } from "./wait.ts";

/** プログラム経由のセッション（sdk-*・委任の子。core の isProgramSession）。まだ取り込んでいなければ false */
export function isProgramHookSession(db: Database, session: string): boolean {
  const r = db
    .query<SessionRow, [string]>(
      `${SESSION_SELECT} WHERE s.external_id = ? AND s.tool = 'claude_code' ORDER BY s.last_activity_at DESC LIMIT 1`,
    )
    .get(session);
  return r ? derive.isProgramSession(toSessionFact(r)) : false;
}

/** そのセッションの最後のターンのカード */
function workItemOfSession(db: Database, session: string): string | null {
  return (
    db
      .query<{ w: string }, [string]>(
        `SELECT t.work_item_id AS w FROM ai_turn t JOIN ai_session s ON s.id = t.session_id
         WHERE s.external_id = ? AND s.tool = 'claude_code' AND t.work_item_id IS NOT NULL
         ORDER BY t.started_at DESC LIMIT 1`,
      )
      .get(session)?.w ?? null
  );
}

const LATER_EVENTS = ["SessionEnd", "UserPromptSubmit", "Stop", "StopFailure"] as const;

/** 取り下げの手がかり（core の hookWaitWithdrawal に渡す） */
export function hookWaitFacts(
  db: Database,
  sessionWait: (workItemId: string) => derive.SessionWait | null,
): (e: HookWaitEntry) => { open: boolean; later: LaterHook[] } {
  return (e) => {
    const later = db
      .query<{ name: string; agent: string | null; at: number }, [string, number]>(
        `SELECT hook_event_name AS name, agent_id AS agent, occurred_at AS at FROM hook_event
         WHERE session_external_id = ? AND tool = 'claude_code' AND occurred_at >= ?
           AND hook_event_name IN (${LATER_EVENTS.map((n) => `'${n}'`).join(", ")})`,
      )
      .all(e.session, e.openedAt)
      .map((r) => ({ name: r.name, agentId: r.agent, at: r.at }));
    const wi = workItemOfSession(db, e.session);
    let open = false;
    if (wi) {
      const w = openWaitFor(db, wi, sessionWait(wi));
      const kind = e.tool === "AskUserQuestion" ? "ask" : "permission";
      if (w && w.kind === kind) open = sessionOf(db, wi, w.turnId)?.external_id === e.session;
    }
    return { open, later };
  };
}
