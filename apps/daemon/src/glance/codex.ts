/**
 * Codex の rollout を表示の瞬間に読む（最後の返答・glance の問い・「答える」の問いの全文。ADR 0019 の Decision 4・10）。
 *
 * - 読むのは rollout の末尾だけ。最後の発言は collectors の codexLastReply（パーサと同じターンの、最後のツール呼び出しより
 *   後の文）。Codex の問いは最後の発言そのもの
 * - 読んだ文は返すだけ。DB・ログ・SSE・MCP・通知に渡さない。このモジュールはロガーを受け取らない
 */
import { codexLastReply, readTailRecords } from "@turnlane/collectors";
import type { SessionRow } from "./index.ts";

/** Codex の rollout の場所（DB の file_path は絶対パス）。アーカイブに動いていれば archived_sessions/ の同じ名前 */
export function codexRolloutPath(s: Pick<SessionRow, "root_path" | "file_path">): string[] {
  const root = s.root_path.replace(/\/+$/, "");
  const p = s.file_path;
  // 取り込み元のルートの外は読まない
  if (!p?.startsWith(`${root}/`) || p.includes("/../")) return [];
  const name = p.slice(p.lastIndexOf("/") + 1);
  return [p, `${root}/archived_sessions/${name}`];
}

/** Codex のセッションの最後の発言（ターンに発言がまだ無ければ text: null）。記録が無い・読めなければ fail */
export function readCodexLastText(
  s: Pick<SessionRow, "root_path" | "file_path">,
): { text: string | null } | { fail: "missing" | "unreadable" } {
  for (const path of codexRolloutPath(s)) {
    const tail = readTailRecords(path);
    if (tail.ok) return { text: codexLastReply(tail.records) };
    if (tail.reason !== "missing") return { fail: "unreadable" };
  }
  return { fail: "missing" };
}
