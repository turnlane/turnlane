/**
 * 同梱アダプタの一覧（phase0-plan 3.1.1）。daemon の supervisor はこれだけを見る。
 * 新しいアダプタを足すときはここに1行足す（DB・core・daemon の変更は要らない）。
 * claude-desktop（local_*.json）は Phase0 の任意枠で、まだ入れていない。
 */
import claudeCode from "./adapters/claude-code/index.ts";
import codex from "./adapters/codex/index.ts";
import hookSpool from "./adapters/hook-spool/index.ts";
import report from "./adapters/report/index.ts";
import type { SourceAdapter } from "./types.ts";

export const builtinAdapters: readonly SourceAdapter[] = [claudeCode, codex, hookSpool, report];

export function adapterFor(tool: string): SourceAdapter | undefined {
  return builtinAdapters.find((a) => a.tool === tool);
}
