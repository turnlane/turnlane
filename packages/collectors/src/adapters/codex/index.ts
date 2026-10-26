/**
 * Codex アダプタ（phase0-plan 3.1、ai-session-ingestion 1.4）。CLI / Desktop アプリ共通。
 * 読むのは rollout JSONL・session_index.jsonl・archived_sessions/ の3つだけ（SQLite は開かない。S2、D-012）。
 */
import { defineAdapter, toolId } from "../../define.ts";
import { HOOK_ALLOWLIST } from "../../hook-allowlist.ts";
import { io, isForbiddenFile, walkFiles } from "../../io.ts";
import {
  ADAPTER_API_VERSION,
  type DetectedRoot,
  type HookSpec,
  type StreamSpec,
} from "../../types.ts";
import { CODEX_ALLOWLIST, readRollout, readSessionIndex, SESSION_INDEX_KEYS } from "./rollout.ts";

export const CODEX = toolId("codex");
/**
 * 2: 質問の判定を広げた（D-066）。3: プロジェクト外の会話の cwd を日付までに切り落とす（D-135。継続状態に残っている
 * 切り落とす前の cwd を捨てる）。4: 問いの判定の対象を広げた（見出し＋列挙＋判断待ちの条件文）。上げるとデーモンが起動時に先頭から読み直し、ターンの判定を書き直す
 */
const PARSER_VERSION = 4;
const LIVE_MS = 10 * 60_000;
const RECENT_MS = 7 * 86_400_000;
const ROLLOUT_RE = /\/rollout-[^/]+\.jsonl$/;

function priorityOf(mtimeMs: number, now: number): StreamSpec["priority"] {
  if (now - mtimeMs < LIVE_MS) return "live";
  return now - mtimeMs < RECENT_MS ? "recent" : "backfill";
}

function streamOf(root: DetectedRoot, p: string, now = Date.now()): StreamSpec | null {
  if (isForbiddenFile(p)) return null;
  const rel = p.startsWith(`${root.rootPath}/`) ? p.slice(root.rootPath.length + 1) : null;
  if (!rel) return null;
  const ok =
    rel === "session_index.jsonl" ||
    ((rel.startsWith("sessions/") || rel.startsWith("archived_sessions/")) && ROLLOUT_RE.test(p));
  if (!ok) return null;
  const mtime = io.stat(p)?.mtimeMs ?? 0;
  // タイトルは他のストリームより先に読む（カードのタイトルが早く決まる）
  const priority = rel === "session_index.jsonl" ? "live" : priorityOf(mtime, now);
  return { key: rel, kind: "jsonl", path: p, priority };
}

const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : undefined);

export const codexHooks: HookSpec = {
  events: HOOK_ALLOWLIST.codex.events,
  allowlist: Object.fromEntries(
    HOOK_ALLOWLIST.codex.events.map((e) => [e, HOOK_ALLOWLIST.codex.keys]),
  ),
  normalize(x, at) {
    const sid = str(x.session_id);
    const name = str(x.hook_event_name);
    if (!sid || !name) return null;
    const opt = (k: string, v: unknown) => (str(v) ? { [k]: str(v) as string } : {});
    return {
      kind: "hook",
      ref: { tool: CODEX, externalId: sid },
      at,
      name,
      ...opt("toolName", x.tool_name),
      ...opt("turnId", x.turn_id),
      ...opt("source", x.source),
      ...opt("reason", x.reason),
      ...opt("cwd", x.cwd),
      // サブエージェントの中で出た hook の ID（付いていれば）。親のターンの終わり・停止に数えない
      ...opt("agentId", x.agent_id),
    };
  },
};

export default defineAdapter({
  apiVersion: ADAPTER_API_VERSION,
  tool: CODEX,
  displayName: "Codex",
  parserId: "codex.rollout",
  parserVersion: PARSER_VERSION,
  testedVersions: ">=0.147.0 <0.160.0",
  capabilities: {
    liveStatus: false,
    turns: true,
    tokens: true,
    gitBranch: false,
    prLinks: false,
    hooks: true,
  },
  timing: { runningStaleMs: 10 * 60_000 },
  allowlist: { ...CODEX_ALLOWLIST, "session_index.jsonl": SESSION_INDEX_KEYS },
  hooks: codexHooks,

  async detect(env) {
    const p = (env.vars.CODEX_HOME || `${env.home}/.codex`).replace(/\/+$/, "");
    const evidence: string[] = [];
    if (io.stat(`${p}/sessions`)?.isDirectory()) evidence.push("has sessions/");
    if (io.exists(`${p}/session_index.jsonl`)) evidence.push("has session_index.jsonl");
    if (io.stat(`${p}/archived_sessions`)?.isDirectory()) evidence.push("has archived_sessions/");
    if (evidence.length === 0) return [];
    return [{ tool: CODEX, rootPath: p, profileLabel: "default", evidence }];
  },

  watch(root) {
    return [
      {
        dir: `${root.rootPath}/sessions`,
        recursive: true,
        match: (p) => ROLLOUT_RE.test(p),
        reconcileEveryMs: 60_000,
        // Codex は rollout を開いたまま追記する。macOS の fs.watch は閉じるまで知らせないので、mtime を 10 秒ごとに見る
        pollEveryMs: 10_000,
      },
      {
        dir: `${root.rootPath}/archived_sessions`,
        recursive: false,
        match: (p) => ROLLOUT_RE.test(p),
        reconcileEveryMs: 60_000,
      },
      {
        dir: root.rootPath,
        recursive: false,
        match: (p) => p.endsWith("/session_index.jsonl"),
        reconcileEveryMs: 60_000,
      },
    ];
  },

  async listStreams(root, opts) {
    const now = Date.now();
    const files = [
      ...walkFiles(`${root.rootPath}/sessions`, (p) => ROLLOUT_RE.test(p)),
      ...walkFiles(`${root.rootPath}/archived_sessions`, (p) => ROLLOUT_RE.test(p)),
    ];
    if (io.exists(`${root.rootPath}/session_index.jsonl`))
      files.push(`${root.rootPath}/session_index.jsonl`);
    const out: StreamSpec[] = [];
    for (const p of files) {
      if (opts.sinceMs !== undefined && (io.stat(p)?.mtimeMs ?? 0) < opts.sinceMs) continue;
      const s = streamOf(root, p, now);
      if (s) out.push(s);
    }
    return out;
  },

  streamFor(root, absPath) {
    return streamOf(root, absPath);
  },

  async read(stream, cursor, ctx) {
    if (stream.key === "session_index.jsonl") {
      return readSessionIndex(CODEX, PARSER_VERSION, stream, cursor, ctx);
    }
    return readRollout(
      CODEX,
      PARSER_VERSION,
      stream,
      cursor,
      ctx,
      stream.key.startsWith("archived_sessions/"),
    );
  },
});
