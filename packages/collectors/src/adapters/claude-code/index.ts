/**
 * Claude Code アダプタ（phase0-plan 3.1、ai-session-ingestion 1.1・6.1）。
 *
 * 検出: $CLAUDE_CONFIG_DIR、~/.claude、~/.claude-* のうち projects/ を持つもの。名前に関係なく既定ですべて有効（D-017）
 * ストリーム: projects/<enc-cwd>/<sid>.jsonl（本体）、projects/<enc-cwd>/<sid>/subagents/agent-*.jsonl（親子付けだけ）
 * ライブ状態: sessions/<pid>.json（*.key は開かない）と pid の生存確認。`.claude.json` の利用枠のキャッシュ（使用率と
 *   明ける時刻だけ。更新されたときだけ読む）
 * ストリームのキー（DB の ingest_cursor.stream_key・ai_session.file_path になる）は、Codex の作業フォルダの
 * `<enc-cwd>` を日付までに切り落とす（最初の依頼から作ったフォルダ名を DB に残さない。D-136）。読むときは path（実際の
 * パス。列挙・監視で毎回得る。DB には残さない）を使う。セッション ID はファイル名にあるので、切り落としてもキーは重ならない
 */
import { pickAllowed } from "../../allowlist.ts";
import { defineAdapter, toolId } from "../../define.ts";
import { HOOK_ALLOWLIST, hookValueAllowed, trimClaudeProjectPath } from "../../hook-allowlist.ts";
import { io, isForbiddenFile, walkFiles } from "../../io.ts";
import {
  ADAPTER_API_VERSION,
  type ClaudeLimitsEvent,
  type ClaudeLimitWindowFact,
  type DetectedRoot,
  type HookSpec,
  type LiveProbe,
  type StreamSpec,
} from "../../types.ts";
import { CLAUDE_ALLOWLIST, readSubagent, readTranscript } from "./transcript.ts";

export const CLAUDE_CODE = toolId("claude_code");
/**
 * 2: 質問の判定を広げた（D-066）。3: 表示の瞬間に読む位置（glance。D-207）を carry に足した。4: 自分の指示の 1 行目を
 * ターンに付ける（ADR 0018、D-218。既存の記録から指示を埋めるため読み直す）。5: 題名に cleanTitle を通し、`summary` の行を
 * `ai-title` より優先する（保存済みの題名を直すため読み直す）。6: 先頭からの読み直しで題名の行が空同然のものだけなら題名を
 * 消す（title: null）、自分の指示の 1 行目で相づちだけの行・貼り付けの塊を飛ばす（保存済みの題名・指示を直すため読み直す）。
 * 7: 問いの判定の対象を広げた（見出し＋列挙＋判断待ちの条件文。保存済みのターンの問いを直すため読み直す）。
 * 上げるとデーモンが起動時に先頭から読み直し、
 * ターンの判定を書き直す
 */
const PARSER_VERSION = 7;
const LIVE_MS = 10 * 60_000;
const RECENT_MS = 7 * 86_400_000;

const SESSION_FILE_KEYS = ["pid", "sessionId", "status", "updatedAt", "statusUpdatedAt"] as const;
/**
 * 設定ディレクトリの `.claude.json`（Claude Code の全体の設定。アカウントの情報・プロジェクトごとの履歴なども入る）から
 * 読むキー。利用枠のキャッシュ（cachedUsageUtilization）の、取得時刻と 5 時間・7 日の枠の使用率と明ける時刻だけ
 * （ADR 0005: 使用率と明ける時刻のほかは読まない・ログに出さない・保存しない。accountUuid も読まない）
 */
const CLAUDE_JSON = ".claude.json";
const CLAUDE_JSON_KEYS = [
  "cachedUsageUtilization.fetchedAtMs",
  "cachedUsageUtilization.utilization.five_hour.utilization",
  "cachedUsageUtilization.utilization.five_hour.resets_at",
  "cachedUsageUtilization.utilization.seven_day.utilization",
  "cachedUsageUtilization.utilization.seven_day.resets_at",
] as const;
/** これより大きい `.claude.json` は読まない（プロジェクトの履歴が育ちすぎたもの） */
const CLAUDE_JSON_MAX_BYTES = 32 * 1024 * 1024;
/** ルート → 最後に読んだ `.claude.json` のパスと mtime（変わったときだけ読む。デーモンのメモリだけ） */
const claudeJsonSeen = new Map<string, string>();

/**
 * ルートの `.claude.json`。`<root>/.claude.json` が無く、ルートが既定の設定ディレクトリ（名前が `.claude`。
 * `CLAUDE_CONFIG_DIR` を指定しない Claude Code）なら、Claude Code の既定の置き場所 `<root の親>/.claude.json`
 * （ホームの直下）を見る。`CLAUDE_CONFIG_DIR` 付きのルート（`.claude-*` など）では親を見ない
 */
function claudeJsonOf(
  root: DetectedRoot,
): { path: string; st: NonNullable<ReturnType<typeof io.stat>> } | null {
  const own = `${root.rootPath}/${CLAUDE_JSON}`;
  const cands = [own];
  const i = root.rootPath.lastIndexOf("/");
  if (i > 0 && root.rootPath.slice(i + 1) === ".claude")
    cands.push(`${root.rootPath.slice(0, i)}/${CLAUDE_JSON}`);
  for (const p of cands) {
    if (isForbiddenFile(p)) continue;
    const st = io.stat(p);
    if (st?.isFile()) return { path: p, st };
  }
  return null;
}
const SUBAGENT_RE = /\/subagents\/agent-[^/]+\.jsonl$/;
const MAIN_RE = /\/projects\/[^/]+\/[^/]+\.jsonl$/;

function label(rootPath: string): string {
  const name = rootPath.slice(rootPath.lastIndexOf("/") + 1);
  const l = name.replace(/^\.claude-?/, "");
  return l === "" || l === name ? "default" : l;
}

function priorityOf(mtimeMs: number, now: number): StreamSpec["priority"] {
  if (now - mtimeMs < LIVE_MS) return "live";
  return now - mtimeMs < RECENT_MS ? "recent" : "backfill";
}

function streamOf(root: DetectedRoot, p: string, now = Date.now()): StreamSpec | null {
  if (!p.startsWith(`${root.rootPath}/projects/`) || isForbiddenFile(p)) return null;
  if (!SUBAGENT_RE.test(p) && !MAIN_RE.test(p)) return null;
  const mtime = io.stat(p)?.mtimeMs ?? 0;
  return {
    key: trimClaudeProjectPath(p.slice(root.rootPath.length + 1)),
    kind: "jsonl",
    path: p,
    priority: priorityOf(mtime, now),
  };
}

function hookAllowlist(): Record<string, readonly string[]> {
  const e = HOOK_ALLOWLIST.claude_code;
  return Object.fromEntries(e.events.map((ev) => [ev, e.keys]));
}

const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : undefined);

/** StopFailure のエラーの種類: error を優先し、無ければ error_type。識別子の形のものだけ */
function errorTypeOf(x: Record<string, unknown>): string | undefined {
  for (const k of ["error", "error_type"] as const) {
    const v = str(x[k]);
    if (v && hookValueAllowed(k, v)) return v;
  }
  return undefined;
}

export const claudeHooks: HookSpec = {
  events: HOOK_ALLOWLIST.claude_code.events,
  allowlist: hookAllowlist(),
  normalize(x, at) {
    const sid = str(x.session_id);
    const name = str(x.hook_event_name);
    if (!sid || !name) return null;
    const opt = (k: string, v: unknown) => (str(v) ? { [k]: str(v) as string } : {});
    return {
      kind: "hook",
      ref: { tool: CLAUDE_CODE, externalId: sid },
      at,
      name,
      ...opt("notificationType", x.notification_type),
      ...opt("toolName", x.tool_name),
      // 公式の項目名は error（StopFailure）。古い spool の行は error_type
      ...opt("errorType", errorTypeOf(x)),
      ...opt("turnId", x.turn_id),
      ...opt("promptId", x.prompt_id),
      ...opt("source", x.source),
      ...opt("reason", x.reason),
      ...opt("cwd", x.cwd),
      ...opt("agentId", x.agent_id),
      ...opt("agentType", x.agent_type),
      ...opt("permissionMode", x.permission_mode),
      // 自動再開を止めた理由が「24 時間より先に明ける」（turnlane hook が定型文を見て残した真偽値。文は持たない）
      ...(x.quota_horizon === true && x.notification_type === "quota_auto_resume_disabled"
        ? { horizon: true }
        : {}),
    };
  },
};

/** 枠 1 つ（使用率は 0〜1000 の数、明ける時刻は ISO 8601。どちらかが無い・形が違えば無し） */
function limitWindow(w: unknown): ClaudeLimitWindowFact | undefined {
  if (!w || typeof w !== "object") return undefined;
  const { utilization: pct, resets_at: at } = w as Record<string, unknown>;
  if (typeof pct !== "number" || !Number.isFinite(pct) || pct < 0 || pct > 1000) return undefined;
  if (typeof at !== "string" || at.length > 64) return undefined;
  const resetsAt = Date.parse(at);
  return Number.isFinite(resetsAt) && resetsAt > 0 ? { pct, resetsAt } : undefined;
}

/**
 * ルートの `.claude.json`（claudeJsonOf）の利用枠のキャッシュ。mtime が前回と変わったときだけ読み、許可リストのキーだけを取り出す。
 * 無い・読めない・取得時刻が無い・どの枠も無ければ null（中身はログに出さない）
 */
export function readClaudeLimits(root: DetectedRoot): ClaudeLimitsEvent | null {
  const found = claudeJsonOf(root);
  if (!found) {
    claudeJsonSeen.delete(root.rootPath);
    return null;
  }
  const { path: p, st } = found;
  const seen = `${p}\0${st.mtimeMs}`;
  if (claudeJsonSeen.get(root.rootPath) === seen) return null;
  claudeJsonSeen.set(root.rootPath, seen);
  if (st.size > CLAUDE_JSON_MAX_BYTES) return null;
  let j: Record<string, unknown>;
  try {
    j = pickAllowed(JSON.parse(io.readText(p)), CLAUDE_JSON_KEYS);
  } catch {
    return null;
  }
  const c = j.cachedUsageUtilization as
    | { fetchedAtMs?: unknown; utilization?: { five_hour?: unknown; seven_day?: unknown } }
    | undefined;
  const fetchedAt = c?.fetchedAtMs;
  if (typeof fetchedAt !== "number" || !Number.isFinite(fetchedAt) || fetchedAt <= 0) return null;
  const fiveHour = limitWindow(c?.utilization?.five_hour);
  const sevenDay = limitWindow(c?.utilization?.seven_day);
  if (!fiveHour && !sevenDay) return null;
  return {
    kind: "claude_limits",
    account: root.rootPath,
    fetchedAt,
    ...(fiveHour ? { fiveHour } : {}),
    ...(sevenDay ? { sevenDay } : {}),
  };
}

export default defineAdapter({
  apiVersion: ADAPTER_API_VERSION,
  tool: CLAUDE_CODE,
  displayName: "Claude Code",
  parserId: "claude_code.transcript",
  parserVersion: PARSER_VERSION,
  testedVersions: ">=2.1.0 <2.2.0",
  capabilities: {
    liveStatus: true,
    turns: true,
    tokens: true,
    gitBranch: true,
    prLinks: true,
    hooks: true,
  },
  timing: { runningStaleMs: 5 * 60_000 },
  allowlist: {
    ...CLAUDE_ALLOWLIST,
    "sessions/<pid>.json": SESSION_FILE_KEYS,
    [CLAUDE_JSON]: CLAUDE_JSON_KEYS,
  },
  hooks: claudeHooks,

  async detect(env) {
    const cands = new Set<string>();
    const fromEnv = env.vars.CLAUDE_CONFIG_DIR;
    if (fromEnv) cands.add(fromEnv.replace(/\/+$/, ""));
    for (const p of env.extraRoots ?? []) {
      if (p.startsWith("/")) cands.add(p.replace(/\/+$/, ""));
    }
    for (const e of io.readdir(env.home)) {
      if (e.name === ".claude" || e.name.startsWith(".claude-")) {
        if (e.isDirectory() || e.isSymbolicLink()) cands.add(`${env.home}/${e.name}`);
      }
    }
    const out: DetectedRoot[] = [];
    for (const p of [...cands].sort()) {
      if (!io.stat(`${p}/projects`)?.isDirectory()) continue;
      const evidence = ["has projects/"];
      if (io.exists(`${p}/sessions`)) evidence.push("has sessions/");
      if (io.exists(`${p}/settings.json`)) evidence.push("has settings.json");
      out.push({ tool: CLAUDE_CODE, rootPath: p, profileLabel: label(p), evidence });
    }
    return out;
  },

  watch(root) {
    return [
      {
        dir: `${root.rootPath}/projects`,
        recursive: true,
        match: (p) => p.endsWith(".jsonl") && !isForbiddenFile(p),
        reconcileEveryMs: 60_000,
      },
      {
        dir: `${root.rootPath}/sessions`,
        recursive: false,
        match: (p) => /\/\d+\.json$/.test(p),
        reconcileEveryMs: 60_000,
      },
    ];
  },

  async listStreams(root, opts) {
    const now = Date.now();
    const out = new Map<string, { s: StreamSpec; m: number }>();
    for (const p of walkFiles(`${root.rootPath}/projects`, (p) => p.endsWith(".jsonl"))) {
      const s = streamOf(root, p, now);
      if (!s) continue;
      const m = io.stat(p)?.mtimeMs ?? 0;
      if (opts.sinceMs !== undefined && m < opts.sinceMs) continue;
      // 切り落としたキーが重なる（同じセッション ID のファイルが同じ日付の別のフォルダにある。普通は起きない）ときは
      // 新しいほうだけを読む（同じセッションの行は DB でも1つ）
      const prev = out.get(s.key);
      if (!prev || m > prev.m) out.set(s.key, { s, m });
    }
    return [...out.values()].map((x) => x.s);
  },

  streamFor(root, absPath) {
    return streamOf(root, absPath);
  },

  async read(stream, cursor, ctx) {
    return SUBAGENT_RE.test(stream.path)
      ? readSubagent(CLAUDE_CODE, PARSER_VERSION, stream, cursor, ctx)
      : readTranscript(CLAUDE_CODE, PARSER_VERSION, stream, cursor, ctx);
  },

  async probeLive(root) {
    const dir = `${root.rootPath}/sessions`;
    const out: LiveProbe[] = [];
    const limits = readClaudeLimits(root);
    if (limits) out.push(limits);
    for (const e of io.readdir(dir)) {
      // <pid>.json だけを読む。<pid>.<hash>.key は秘密情報なので開かない（ai-session-ingestion 1.1）
      if (!e.isFile() || !/^\d+\.json$/.test(e.name)) continue;
      let j: Record<string, unknown>;
      try {
        j = pickAllowed(JSON.parse(io.readText(`${dir}/${e.name}`)), SESSION_FILE_KEYS);
      } catch {
        continue;
      }
      const pid = typeof j.pid === "number" ? j.pid : undefined;
      const sid = str(j.sessionId);
      if (!pid || !sid) continue;
      const alive = io.pidAlive(pid);
      const status = j.status === "busy" ? "busy" : "idle";
      const at =
        (typeof j.statusUpdatedAt === "number" ? j.statusUpdatedAt : undefined) ??
        (typeof j.updatedAt === "number" ? j.updatedAt : undefined) ??
        0;
      out.push({
        kind: "live_status",
        ref: { tool: CLAUDE_CODE, externalId: sid },
        at,
        status: alive ? status : "gone",
        pid,
      });
    }
    return out;
  },
});
