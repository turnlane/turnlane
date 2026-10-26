import { ADAPTER_API_VERSION, type SourceAdapter, type ToolId } from "./types.ts";

export const TOOL_ID_RE = /^[a-z][a-z0-9_]{1,31}$/;

/** ToolId の書式（DB の CHECK と同じ）を検査して ToolId にする */
export function toolId(s: string): ToolId {
  if (!TOOL_ID_RE.test(s)) throw new Error(`invalid ToolId: ${s}`);
  return s as ToolId;
}

/** 本文を運ぶキー。許可リストに入れてはいけない（ADR 0005） */
export const BODY_KEYS = [
  "content",
  "text",
  "prompt",
  "thinking",
  "last_agent_message",
  "last_assistant_message",
  "lastPrompt",
  "tool_input",
  "input",
  "initialMessage",
  "systemPrompt",
  "emailAddress",
  "message",
  "summary",
  "display",
  "pastedContents",
  "stdout",
  "stderr",
  "aggregated_output",
  "formatted_output",
  "toolUseResult",
] as const;

/**
 * アダプタの宣言を検査して返す。各アダプタの index.ts はこれで default export する。
 * - ToolId の書式、apiVersion
 * - 許可リストのキーの末尾に本文系のキーが無いこと（例 `message.content[].text` は不可。
 *   `message.content[].type` のように本文の入れ物の中の型名は可）
 */
export function defineAdapter<A extends SourceAdapter>(a: A): A {
  toolId(a.tool);
  if (a.apiVersion !== ADAPTER_API_VERSION) {
    throw new Error(`${a.tool}: apiVersion ${a.apiVersion} != ${ADAPTER_API_VERSION}`);
  }
  if (!Number.isInteger(a.parserVersion) || a.parserVersion < 1) {
    throw new Error(`${a.tool}: parserVersion must be a positive integer`);
  }
  const lists: Record<string, readonly string[]> = {
    ...a.allowlist,
    ...(a.hooks?.allowlist ?? {}),
  };
  for (const [type, keys] of Object.entries(lists)) {
    for (const k of keys) {
      const last = k.split(".").at(-1)?.replace("[]", "") ?? k;
      if ((BODY_KEYS as readonly string[]).includes(last)) {
        throw new Error(`${a.tool}: allowlist ${type} contains a body key: ${k}`);
      }
    }
  }
  return Object.freeze(a);
}

function parseVersion(v: string): number[] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function cmp(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
  return 0;
}

/**
 * testedVersions の判定。対応する書式は `*` と、空白区切りの `>=x.y.z` / `<x.y.z` / `>x.y.z` / `<=x.y.z` の組み合わせだけ。
 * 書式が分からなければ true（警告を出さない）。
 */
export function satisfiesRange(version: string, range: string): boolean {
  if (range.trim() === "*") return true;
  const v = parseVersion(version);
  if (!v) return true;
  for (const part of range.trim().split(/\s+/)) {
    const m = /^(>=|<=|>|<|=)?(\d+\.\d+\.\d+)$/.exec(part);
    const w = m?.[2] ? parseVersion(m[2]) : null;
    if (!m || !w) return true;
    const c = cmp(v, w);
    const ok =
      m[1] === ">="
        ? c >= 0
        : m[1] === "<="
          ? c <= 0
          : m[1] === ">"
            ? c > 0
            : m[1] === "<"
              ? c < 0
              : c === 0;
    if (!ok) return false;
  }
  return true;
}
