/**
 * hook-spool アダプタ（Turnlane 固有。phase0-plan 3.1・3.6）。`turnlane hook` が書いた spool JSONL
 * （<data>/spool/hooks-YYYYMMDD.jsonl）を読み、各ツールのアダプタの HookSpec.normalize で正規化する。
 * 形式は Turnlane 自身が管理する（v=1）。spool のファイル名と行頭のバイト位置が hook_event の自然キー。
 */
import { pickAllowed } from "../../allowlist.ts";
import { defineAdapter, toolId } from "../../define.ts";
import {
  HOOK_ALLOWLIST,
  HOOK_SPOOL_META_KEYS,
  HOOK_TOOL_IDS,
  TERM_HANDLE_RE,
} from "../../hook-allowlist.ts";
import { io } from "../../io.ts";
import { readJsonlIncremental } from "../../readers/jsonl.ts";
import {
  ADAPTER_API_VERSION,
  type HookSpec,
  type NormalizedEvent,
  type StreamSpec,
} from "../../types.ts";
import { claudeHooks } from "../claude-code/index.ts";
import { codexHooks } from "../codex/index.ts";

export const HOOK_SPOOL = toolId("hook_spool");
const PARSER_VERSION = 1;
const SPOOL_RE = /\/hooks-\d{8}\.jsonl$/;

const SPECS: Record<string, HookSpec> = { claude_code: claudeHooks, codex: codexHooks };

/** spool の1行に入りうるキー（全ツールの許可リスト + turnlane hook が付けるメタデータ） */
const LINE_KEYS = [
  ...new Set([...HOOK_SPOOL_META_KEYS, ...HOOK_TOOL_IDS.flatMap((t) => HOOK_ALLOWLIST[t].keys)]),
] as const;

/** spool のディレクトリ（TURNLANE_DATA_DIR があればその下） */
export function spoolDirOf(env: {
  home: string;
  vars: Record<string, string | undefined>;
}): string {
  const data = env.vars.TURNLANE_DATA_DIR || `${env.home}/Library/Application Support/turnlane`;
  return `${data.replace(/\/+$/, "")}/spool`;
}

const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : undefined);

export default defineAdapter({
  apiVersion: ADAPTER_API_VERSION,
  tool: HOOK_SPOOL,
  displayName: "hooks",
  parserId: "hook_spool.v1",
  parserVersion: PARSER_VERSION,
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
  allowlist: { line: LINE_KEYS },

  async detect(env) {
    // spool はまだ無くてもよい（turnlane hook が最初に書いたときに作られる）
    return [{ tool: HOOK_SPOOL, rootPath: spoolDirOf(env), profileLabel: "spool", evidence: [] }];
  },

  watch(root) {
    return [
      {
        dir: root.rootPath,
        recursive: false,
        match: (p) => SPOOL_RE.test(p),
        reconcileEveryMs: 60_000,
      },
    ];
  },

  async listStreams(root, opts) {
    const out: StreamSpec[] = [];
    for (const e of io.readdir(root.rootPath)) {
      const p = `${root.rootPath}/${e.name}`;
      if (!e.isFile() || !SPOOL_RE.test(p)) continue;
      if (opts.sinceMs !== undefined && (io.stat(p)?.mtimeMs ?? 0) < opts.sinceMs) continue;
      out.push({ key: e.name, kind: "jsonl", path: p, priority: "live" });
    }
    return out.sort((a, b) => a.key.localeCompare(b.key));
  },

  streamFor(root, absPath) {
    if (!absPath.startsWith(`${root.rootPath}/`) || !SPOOL_RE.test(absPath)) return null;
    return {
      key: absPath.slice(root.rootPath.length + 1),
      kind: "jsonl",
      path: absPath,
      priority: "live",
    };
  },

  async read(stream, cursor, ctx) {
    const stats = { records: 0, skipped: 0, unknownTypes: 0, missingRequired: 0 };
    const chunk = readJsonlIncremental(stream.path, cursor, { maxBytes: ctx.maxBytes });
    if (!chunk) {
      return {
        events: [],
        next: cursor ?? { byteOffset: 0, parserVersion: PARSER_VERSION },
        stats,
        done: true,
        missing: true,
      };
    }
    const events: NormalizedEvent[] = [];
    for (const line of chunk.lines) {
      if (!line.value || typeof line.value !== "object") {
        stats.skipped++;
        continue;
      }
      const r = pickAllowed(line.value, LINE_KEYS);
      stats.records++;
      const tool = str(r.tool);
      const spec = tool ? SPECS[tool] : undefined;
      if (!spec) {
        stats.unknownTypes++;
        continue;
      }
      const at = typeof r.received_at === "number" ? r.received_at : undefined;
      const n = at === undefined ? null : spec.normalize(r, at);
      if (!n) {
        stats.missingRequired++;
        continue;
      }
      const configRoot = str(r.config_root);
      const term = str(r.term);
      events.push({
        ...n,
        ...(configRoot ? { configRoot } : {}),
        ...(term && TERM_HANDLE_RE.test(term) ? { term } : {}),
        spool: { file: stream.key, offset: line.offset },
      });
    }
    return {
      events,
      next: { ...chunk.next, parserVersion: PARSER_VERSION },
      stats,
      done: chunk.done,
    };
  },
});
