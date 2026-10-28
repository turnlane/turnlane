/**
 * 最後の返答（GET /api/work-items/:id/last-reply。ADR 0019 の Decision 10、m2-api 34章）: AI の詳細パネルを開いた瞬間に、
 * その AI 項目の最後のセッションの記録（Claude Code のトランスクリプト・Codex の rollout）の末尾を読み、AI の最後の発言を返す。
 *
 * - 読んだ文は返すだけ。DB・ログ・SSE・MCP・通知・記録・エクスポートに渡さない。このモジュールはロガーを受け取らない
 * - 伏せ字と 2,000 字の切り詰めは core の lastReplyOf（保存する行と同じ伏せ字の規則）
 * - 「最後」の境界は collectors の claudeLastReply / codexLastReply（パーサと同じターン）
 * - 設定「行に中身を出す」（turn.show_detail）がオフなら記録を読まない（off）
 */
import type { Database } from "bun:sqlite";
import {
  claudeLastReply,
  codexLastReply,
  findClaudeTranscript,
  readTailRecords,
} from "@turnlane/collectors";
import { type LastReplyBody, lastReplyOf, lastReplyState } from "@turnlane/core";
import type { LastReplyResponse } from "@turnlane/core/api";
import { type SessionRow, sessionOf } from "./index.ts";

/** Codex の rollout の場所（DB の file_path は絶対パス）。アーカイブに動いていれば archived_sessions/ の同じ名前 */
function codexRolloutPath(s: SessionRow): string[] {
  const root = s.root_path.replace(/\/+$/, "");
  const p = s.file_path;
  // 取り込み元のルートの外は読まない
  if (!p?.startsWith(`${root}/`) || p.includes("/../")) return [];
  const name = p.slice(p.lastIndexOf("/") + 1);
  return [p, `${root}/archived_sessions/${name}`];
}

function bodyOf(s: SessionRow): LastReplyBody {
  if (s.tool === "claude_code") {
    const path = findClaudeTranscript(s.root_path, s.file_path, s.external_id);
    if (!path) return lastReplyState("gone");
    const tail = readTailRecords(path);
    if (!tail.ok) return lastReplyState(tail.reason === "missing" ? "gone" : "unreadable");
    return lastReplyOf(claudeLastReply(tail.records));
  }
  if (s.tool === "codex") {
    for (const path of codexRolloutPath(s)) {
      const tail = readTailRecords(path);
      if (tail.ok) return lastReplyOf(codexLastReply(tail.records));
      if (tail.reason !== "missing") return lastReplyState("unreadable");
    }
    return lastReplyState("gone");
  }
  return lastReplyState("unreadable");
}

/** 最後の返答を表示の瞬間に読む。AI 項目が無ければ null */
export function readLastReply(
  db: Database,
  workItemId: string,
  o: { now: number; showDetail: boolean },
): LastReplyResponse | null {
  const wi = db
    .query<{ id: string }, [string]>("SELECT id FROM work_item WHERE id = ? AND deleted_at IS NULL")
    .get(workItemId);
  if (!wi) return null;
  const base = { workItemId, readAt: o.now };
  if (!o.showDetail) return { ...base, ...lastReplyState("off") };
  const s = sessionOf(db, workItemId, null);
  if (!s) return { ...base, ...lastReplyState("none") };
  return { ...base, ...bodyOf(s) };
}
