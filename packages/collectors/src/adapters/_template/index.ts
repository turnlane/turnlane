/**
 * 新しいアダプタの雛形（packages/collectors/README.md の「アダプタ追加手順」と対応）。
 * `src/adapters/<tool>/` にコピーして、TODO を埋める。registry.ts には登録しない（これは雛形）。
 *
 * 守ること（phase0-plan 3.1.1、ADR 0005）:
 * - ファイルは io.ts（io.readText / readJsonlIncremental）経由で読む。検出したルートの外を読まない
 * - パースした直後に pickAllowed() を通す。本文系のキーを許可リストに入れない
 * - 本文の性質（質問で終わるか等）が要るときは、その場で判定して真偽値だけを残す
 * - 子プロセスを起動しない・ネットワークに出ない・書き込まない
 * - イベントは累積値を運ぶ（シンクは代入だけ。何度読み直しても同じ結果になる）
 */
import { pickAllowed } from "../../allowlist.ts";
import { defineAdapter, toolId } from "../../define.ts";
import { io, walkFiles } from "../../io.ts";
import { readJsonlIncremental } from "../../readers/jsonl.ts";
import {
  ADAPTER_API_VERSION,
  type Cursor,
  type DetectedRoot,
  type NormalizedEvent,
  type ReadContext,
  type ReadResult,
  type StreamSpec,
} from "../../types.ts";

const TOOL = toolId("template_tool"); // TODO: ToolId（^[a-z][a-z0-9_]{1,31}$、既存と重複しない）

const ALLOWLIST = {
  // TODO: レコード型 → 読むキー
  event: ["type", "timestamp", "session_id", "cwd"],
} as const;

interface Carry {
  sessionId?: string;
  startedAt?: number;
}

export default defineAdapter({
  apiVersion: ADAPTER_API_VERSION,
  tool: TOOL,
  displayName: "Template",
  parserId: "template.v1",
  parserVersion: 1,
  testedVersions: "*",
  capabilities: {
    liveStatus: false,
    turns: false,
    tokens: false,
    gitBranch: false,
    prLinks: false,
    hooks: false,
  },
  timing: { runningStaleMs: 5 * 60_000 },
  allowlist: ALLOWLIST,

  async detect(env) {
    const rootPath = `${env.home}/.template-tool`; // TODO
    if (!io.exists(rootPath)) return [];
    return [{ tool: TOOL, rootPath, profileLabel: "default", evidence: ["exists"] }];
  },

  watch(root) {
    return [
      {
        dir: root.rootPath,
        recursive: true,
        match: (p) => p.endsWith(".jsonl"),
        reconcileEveryMs: 60_000,
      },
    ];
  },

  async listStreams(root, opts) {
    return walkFiles(root.rootPath, (p) => p.endsWith(".jsonl"))
      .filter((p) => (io.stat(p)?.mtimeMs ?? 0) >= (opts.sinceMs ?? 0))
      .map((p) => streamOf(root, p));
  },

  streamFor(root, absPath) {
    return absPath.startsWith(`${root.rootPath}/`) && absPath.endsWith(".jsonl")
      ? streamOf(root, absPath)
      : null;
  },

  async read(stream: StreamSpec, cursor: Cursor | null, ctx: ReadContext): Promise<ReadResult> {
    const chunk = readJsonlIncremental(stream.path, cursor, { maxBytes: ctx.maxBytes });
    const stats = { records: 0, skipped: 0, unknownTypes: 0, missingRequired: 0 };
    if (!chunk) {
      return {
        events: [],
        next: cursor ?? { byteOffset: 0, parserVersion: 1 },
        stats,
        done: true,
        missing: true,
      };
    }
    const carry: Carry = chunk.reset ? {} : { ...((cursor?.carry as Carry | undefined) ?? {}) };
    const events: NormalizedEvent[] = [];
    for (const line of chunk.lines) {
      if (line.value === undefined) {
        stats.skipped++;
        continue;
      }
      const r = pickAllowed(line.value, ALLOWLIST.event);
      stats.records++;
      if (typeof r.session_id !== "string") {
        stats.missingRequired++;
        continue;
      }
      // TODO: レコードを解釈して carry を更新し、イベントを積む
      carry.sessionId = r.session_id;
    }
    if (carry.sessionId) {
      events.push({
        kind: "session_seen",
        ref: { tool: TOOL, externalId: carry.sessionId },
        at: ctx.now,
        filePath: stream.path,
      });
    }
    return {
      events,
      next: { ...chunk.next, carry, parserVersion: 1 },
      stats,
      done: chunk.done,
    };
  },
});

function streamOf(root: DetectedRoot, p: string): StreamSpec {
  return { key: p.slice(root.rootPath.length + 1), kind: "jsonl", path: p, priority: "recent" };
}
