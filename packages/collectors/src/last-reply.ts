/**
 * 最後の返答（AI の詳細パネルの「最後の返答」の節。ADR 0019 の Decision 10）: セッションの記録の末尾（新しい順のレコード。
 * readTailRecords の戻り値）から、AI の最後の発言の文を取り出す。
 *
 * - ここの関数は本文を返す。呼び出し元（デーモン）は戻り値を応答にだけ入れ、DB・ログ・SSE・MCP・通知に渡さない
 * - 「最後」の境界: パーサと同じターン（Claude Code は人の指示・task-notification の user レコード、Codex は task_started /
 *   UserMessage）の中で、最後のツール呼び出しより後の文のまとまり。文が無ければ（ツールの結果を待っている間）、その前の
 *   ツール呼び出しまでの文。まとまりの中の文は改行 2 つでつなぐ（Claude Code は 1 つのメッセージの text を別々のレコードに
 *   書くことがある）。thinking・Reasoning・ツールの入出力は含めない
 * - ターンに文がまだ無ければ null（前のターンの文は出さない）
 */

type Rec = Record<string, unknown>;

const rec = (v: unknown): Rec => (v && typeof v === "object" ? (v as Rec) : {});
const text = (v: unknown): string | null =>
  typeof v === "string" && v.trim().length > 0 ? v.trim() : null;

/** 新しい順に積む文のまとまり。ツール呼び出しに当たったら（文を 1 つでも持っていれば）閉じる */
class Segment {
  readonly parts: string[] = [];
  closed = false;
  add(t: string | null): void {
    if (!this.closed && t) this.parts.unshift(t);
  }
  tool(): void {
    if (this.parts.length > 0) this.closed = true;
  }
  value(): string | null {
    return this.parts.length > 0 ? this.parts.join("\n\n") : null;
  }
}

/**
 * Claude Code のトランスクリプトの最後の返答。records は新しい順。サブエージェント（isSidechain）は見ない。
 * assistant レコードの text ブロックを集め、tool_use・tool_result で区切る
 */
export function claudeLastReply(records: readonly unknown[]): string | null {
  const seg = new Segment();
  for (const r0 of records) {
    const r = rec(r0);
    if (r.isSidechain === true) continue;
    if (r.type === "user") {
      const origin = rec(r.origin).kind;
      if ((origin === "human" || origin === "task-notification") && r.isMeta !== true) break;
      const content = rec(r.message).content;
      if (Array.isArray(content) && content.some((x) => rec(x).type === "tool_result")) seg.tool();
      if (seg.closed) break;
      continue;
    }
    if (r.type !== "assistant") continue;
    const content = rec(r.message).content;
    if (!Array.isArray(content)) continue;
    for (let i = content.length - 1; i >= 0 && !seg.closed; i--) {
      const b = rec(content[i]);
      if (b.type === "text") seg.add(text(b.text));
      else if (b.type === "tool_use") seg.tool();
    }
    if (seg.closed) break;
  }
  return seg.value();
}

/** Codex の item_completed のうちツールの呼び出し（rollout.ts の TOOL_ITEMS と同じ） */
const CODEX_TOOL_ITEMS = new Set([
  "CommandExecution",
  "FileChange",
  "McpToolCall",
  "WebSearch",
  "ImageView",
  "Extension",
]);

/** response_item のうちツールの呼び出し・結果 */
const CODEX_TOOL_RESPONSES = new Set([
  "function_call",
  "function_call_output",
  "custom_tool_call",
  "custom_tool_call_output",
  "local_shell_call",
  "web_search_call",
]);

/** AgentMessage の item の文（`content: [{ type: "Text", text }]`。古い形の `text` も読む） */
function agentItemText(item: Rec): string | null {
  if (Array.isArray(item.content)) {
    const s = item.content
      .map((c) => {
        const x = rec(c);
        return typeof x.text === "string" ? x.text : "";
      })
      .join("");
    return text(s);
  }
  return text(item.text);
}

/** response_item の assistant の message の文（`content: [{ type: "output_text", text }]`） */
function responseText(p: Rec): string | null {
  if (!Array.isArray(p.content)) return null;
  return text(
    p.content
      .map((c) => {
        const x = rec(c);
        return x.type === "output_text" && typeof x.text === "string" ? x.text : "";
      })
      .join(""),
  );
}

/**
 * Codex の rollout の最後の返答。records は新しい順。ターンの境界はパーサと同じ task_started（と人の入力の UserMessage）。
 * 文は item_completed の AgentMessage を先に使い、無ければ response_item の assistant の message、それも無ければ
 * task_complete の last_agent_message（同じ発言が複数の形で書かれるので、形を混ぜない）
 */
export function codexLastReply(records: readonly unknown[]): string | null {
  const items = new Segment();
  const responses = new Segment();
  let lastAgent: string | null = null;
  for (const r0 of records) {
    const r = rec(r0);
    const p = rec(r.payload);
    if (r.type === "event_msg") {
      if (p.type === "task_started") break;
      if (p.type === "task_complete") {
        lastAgent ??= text(p.last_agent_message);
        continue;
      }
      if (p.type !== "item_completed") continue;
      const item = rec(p.item);
      if (item.type === "UserMessage") break;
      if (item.type === "AgentMessage") items.add(agentItemText(item));
      else if (typeof item.type === "string" && CODEX_TOOL_ITEMS.has(item.type)) items.tool();
      continue;
    }
    if (r.type === "response_item") {
      if (p.type === "message" && p.role === "assistant") responses.add(responseText(p));
      else if (typeof p.type === "string" && CODEX_TOOL_RESPONSES.has(p.type)) responses.tool();
    }
  }
  return items.value() ?? responses.value() ?? lastAgent;
}

/**
 * 記録の末尾（新しい順）がターンの終わりか（次の指示を送ってよいか。ADR 0019 の Decision 11）。パーサのターンの終わりと同じ:
 * Claude Code は system の turn_duration・stop_reason が end_turn の assistant・API エラー・中断の印。人の指示・ツールの結果・
 * 途中の発言（end_turn でない assistant）が先に来れば動作中（running）。どれも無ければ unknown
 */
export function claudeTurnEnd(records: readonly unknown[]): "ended" | "running" | "unknown" {
  for (const r0 of records) {
    const r = rec(r0);
    if (r.isSidechain === true) continue;
    if (r.type === "system") {
      if (r.subtype === "turn_duration") return "ended";
      continue;
    }
    if (r.type === "assistant") {
      if (r.isApiErrorMessage === true) return "ended";
      return rec(r.message).stop_reason === "end_turn" ? "ended" : "running";
    }
    if (r.type === "user") {
      if (r.isMeta === true) continue;
      const content = rec(r.message).content;
      const first = Array.isArray(content)
        ? rec(content.find((c) => rec(c).type === "text")).text
        : content;
      if (typeof first === "string" && first.startsWith("[Request interrupted")) return "ended";
      return "running";
    }
  }
  return "unknown";
}

/**
 * Codex の rollout の末尾（新しい順）がターンの終わりか（claudeTurnEnd と同じ）。task_complete・turn_aborted で終わり、
 * それより新しいターンの始まり・発言・ツールがあれば動作中
 */
export function codexTurnEnd(records: readonly unknown[]): "ended" | "running" | "unknown" {
  for (const r0 of records) {
    const r = rec(r0);
    const p = rec(r.payload);
    if (r.type === "event_msg") {
      if (p.type === "task_complete" || p.type === "turn_aborted") return "ended";
      if (p.type === "token_count" || p.type === "thread_settings_applied") continue;
      return "running";
    }
    if (r.type === "turn_context" || r.type === "response_item") return "running";
  }
  return "unknown";
}

/**
 * 最後の人の指示の目印（送った後に記録へ新しい指示が現れたかを比べる）。Claude Code は人の指示の user レコードの uuid
 * （無ければ promptId）、Codex は最後の task_started の turn_id。本文は返さない
 */
export function lastPromptMark(tool: string, records: readonly unknown[]): string | null {
  for (const r0 of records) {
    const r = rec(r0);
    if (tool === "codex") {
      const p = rec(r.payload);
      if (r.type === "event_msg" && p.type === "task_started" && typeof p.turn_id === "string")
        return p.turn_id;
      continue;
    }
    if (r.type !== "user" || r.isMeta === true || r.isSidechain === true) continue;
    if (rec(r.origin).kind !== "human") continue;
    if (typeof r.uuid === "string") return r.uuid;
    if (typeof r.promptId === "string") return r.promptId;
  }
  return null;
}
