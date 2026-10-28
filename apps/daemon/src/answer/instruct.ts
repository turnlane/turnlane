/**
 * 次の指示（Issue #9、ADR 0019 の Decision 11。m2-api 35章）の送る前の事実: AI 項目の最後のセッションのプロセス・記録の末尾が
 * ターンの終わりか・開いている待ち。判定は core の instructBlock。端末のタブを探す（ps・tmux）のはこの判定が通った後だけ。
 *
 * - 記録は末尾だけを読み、ターンの終わりか（collectors の claudeTurnEnd / codexTurnEnd）と最後の人の指示の目印
 *   （lastPromptMark。送った後に新しい指示が現れたかを比べる）だけを取り出す。本文は返さない。ロガーを受け取らない
 */
import type { Database } from "bun:sqlite";
import {
  claudeTurnEnd,
  codexTurnEnd,
  findClaudeTranscript,
  lastPromptMark,
  readTailRecords,
} from "@turnlane/collectors";
import { type derive, type InstructFacts, itemProcess } from "@turnlane/core";
import { codexRolloutPath } from "../glance/codex.ts";
import { type SessionRow, sessionOf } from "../glance/index.ts";
import { openWaitFor } from "./wait.ts";

/** 記録の末尾の確かめに読む長さ（ターンの終わりと最後の指示が入れば足りる） */
const TAIL = 256 * 1024;

export interface InstructRead {
  facts: Omit<InstructFacts, "enabled">;
  session: SessionRow | null;
  /** 最後の人の指示の目印（送った後に比べる） */
  mark: string | null;
}

/** セッションの記録の末尾（新しい順）。記録が無い・読めなければ null */
export function sessionTail(s: SessionRow): unknown[] | null {
  const paths =
    s.tool === "claude_code"
      ? [findClaudeTranscript(s.root_path, s.file_path, s.external_id)].filter(
          (p): p is string => !!p,
        )
      : s.tool === "codex"
        ? codexRolloutPath(s)
        : [];
  for (const p of paths) {
    const t = readTailRecords(p, TAIL);
    if (t.ok) return t.records;
    if (t.reason !== "missing") return null;
  }
  return null;
}

/** 記録の末尾から、ターンの終わりか・最後の指示の目印 */
export function tailState(s: SessionRow): { turn: InstructFacts["turn"]; mark: string | null } {
  const records = sessionTail(s);
  if (!records) return { turn: "missing", mark: null };
  const turn = s.tool === "codex" ? codexTurnEnd(records) : claudeTurnEnd(records);
  return { turn, mark: lastPromptMark(s.tool, records) };
}

/** 送る前の事実を読む。AI 項目が無ければ null */
export function readInstruct(
  db: Database,
  workItemId: string,
  o: { now: number; sessionWait: derive.SessionWait | null },
): InstructRead | null {
  const wi = db
    .query<{ id: string }, [string]>("SELECT id FROM work_item WHERE id = ? AND deleted_at IS NULL")
    .get(workItemId);
  if (!wi) return null;
  const s = sessionOf(db, workItemId, null);
  const live = s
    ? db
        .query<
          {
            live_status: "busy" | "idle" | "gone" | null;
            live_pid: number | null;
            live_checked_at: number | null;
            last_activity_at: number;
          },
          [string]
        >(
          "SELECT live_status, live_pid, live_checked_at, last_activity_at FROM ai_session WHERE id = ?",
        )
        .get(s.id)
    : null;
  const process =
    s && live
      ? itemProcess(
          [
            {
              tool: s.tool,
              liveStatus: live.live_status,
              livePid: live.live_pid,
              liveCheckedAt: live.live_checked_at,
              lastActivityAt: live.last_activity_at,
            },
          ],
          o.now,
        ).process
      : "gone";
  const openWait = openWaitFor(db, workItemId, o.sessionWait) !== null;
  // プロセスが動いていなければ記録も読まない（送らないことは決まっている）
  const tail = s && process === "alive" ? tailState(s) : { turn: "unknown" as const, mark: null };
  return { facts: { process, openWait, turn: tail.turn }, session: s, mark: tail.mark };
}
