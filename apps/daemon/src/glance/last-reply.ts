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
import { claudeLastReply, findClaudeTranscript, readTailRecords } from "@turnlane/collectors";
import { type LastReplyBody, lastReplyOf, lastReplyState } from "@turnlane/core";
import type { LastReplyResponse } from "@turnlane/core/api";
import { readCodexLastText } from "./codex.ts";
import { type SessionRow, sessionOf } from "./index.ts";

function bodyOf(s: SessionRow): LastReplyBody {
  if (s.tool === "claude_code") {
    const path = findClaudeTranscript(s.root_path, s.file_path, s.external_id);
    if (!path) return lastReplyState("gone");
    const tail = readTailRecords(path);
    if (!tail.ok) return lastReplyState(tail.reason === "missing" ? "gone" : "unreadable");
    return lastReplyOf(claudeLastReply(tail.records));
  }
  if (s.tool === "codex") {
    const r = readCodexLastText(s);
    return "fail" in r
      ? lastReplyState(r.fail === "missing" ? "gone" : "unreadable")
      : lastReplyOf(r.text);
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
