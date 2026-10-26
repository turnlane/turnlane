/**
 * Codex の rollout JSONL（sessions/YYYY/MM/DD/rollout-*.jsonl、archived_sessions/rollout-*.jsonl）のパース
 * （ai-session-ingestion 1.4）。SQLite は開かない（S2、D-012）。
 *
 * - ターンは turn_id（task_started → task_complete / turn_aborted）。時間は task_complete.duration_ms
 * - 人間の入力は item_completed の UserMessage。入力の無いターンは initiator='system'
 * - サブエージェントは session_meta.source.subagent（parent_thread_id で親子付け）。guardian と
 *   UserMessage が1件も無い rollout はノイズ
 * - ブランチは session_meta.git.branch（CLI 起動のみ）。無ければ daemon の enrich が git で補う
 * - last_agent_message（本文）はその場で質問の判定にだけ使い、真偽値だけを残す
 * - プロジェクト外の会話の cwd（`~/Documents/Codex/<日付>/<最初の依頼から作った名前>`）は、読んだその場で日付までに
 *   切り落とす（継続状態にも残さない。D-135）
 */
import { homedir } from "node:os";
import { pickAllowed } from "../../allowlist.ts";
import { textTraits } from "../../closing-question.ts";
import { trimCodexScratchCwd } from "../../hook-allowlist.ts";
import { readJsonlIncremental } from "../../readers/jsonl.ts";
import type {
  Cursor,
  NormalizedEvent,
  ReadContext,
  ReadResult,
  StreamSpec,
  ToolId,
  TurnEvent,
} from "../../types.ts";

const COMMON = ["type", "timestamp", "payload.type"] as const;

export const CODEX_ALLOWLIST = {
  session_meta: [
    ...COMMON,
    "payload.id",
    "payload.session_id",
    "payload.timestamp",
    "payload.cwd",
    "payload.originator",
    "payload.cli_version",
    "payload.source",
    "payload.source.subagent.other",
    "payload.parent_thread_id",
    "payload.thread_source",
    "payload.git.branch",
  ],
  turn_context: [...COMMON, "payload.turn_id", "payload.cwd", "payload.model"],
  "event_msg:task_started": [...COMMON, "payload.turn_id", "payload.started_at"],
  "event_msg:task_complete": [
    ...COMMON,
    "payload.turn_id",
    "payload.started_at",
    "payload.completed_at",
    "payload.duration_ms",
  ],
  "event_msg:turn_aborted": [
    ...COMMON,
    "payload.turn_id",
    "payload.started_at",
    "payload.completed_at",
    "payload.duration_ms",
    "payload.reason",
  ],
  "event_msg:item_completed": [...COMMON, "payload.turn_id", "payload.item.type"],
  token_usage_record: [
    ...COMMON,
    "payload.turn_id",
    "payload.turn_token_usage.input_tokens",
    "payload.turn_token_usage.output_tokens",
    "payload.turn_token_usage.cached_input_tokens",
  ],
  "*": COMMON,
} as const satisfies Record<string, readonly string[]>;

const KNOWN_TYPES = new Set([
  "session_meta",
  "turn_context",
  "event_msg",
  "response_item",
  "token_usage_record",
  "world_state",
  "compacted",
]);

/** item_completed のうち、ツール呼び出しとして数える種類 */
const TOOL_ITEMS = new Set([
  "CommandExecution",
  "FileChange",
  "McpToolCall",
  "WebSearch",
  "ImageView",
  "Extension",
]);

/** ユーザーの中断（エラーではない）とみなす turn_aborted.reason */
const USER_ABORT_REASONS = new Set(["interrupted", "replaced", "user_interrupt"]);

interface CodexTurn {
  key: string;
  startedAt: number;
  lastAt: number;
  endedAt?: number | undefined;
  durationMs?: number | undefined;
  status: TurnEvent["status"];
  human: boolean;
  cwd?: string | undefined;
  edits: number;
  tools: Record<string, number>;
  tokIn?: number | undefined;
  tokOut?: number | undefined;
  tokCache?: number | undefined;
  question: boolean;
  closing: boolean;
}

export interface CodexCarry {
  v: 1;
  id?: string | undefined;
  firstAt?: number | undefined;
  lastAt?: number | undefined;
  cwd?: string | undefined;
  originator?: string | undefined;
  cliVersion?: string | undefined;
  branch?: string | undefined;
  model?: string | undefined;
  subagent: boolean;
  guardian: boolean;
  parent?: string | undefined;
  human: boolean;
  /** 未完了のターンと、直近に終わったターン（token_usage_record が後から来る場合に備える） */
  turns: CodexTurn[];
}

type Rec = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : undefined);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const ts = (v: unknown) => {
  if (typeof v !== "string") return undefined;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : t;
};
/** Codex の started_at / completed_at は秒（ms の場合もある） */
const secOrMs = (v: unknown) => {
  const n = num(v);
  if (n === undefined) return undefined;
  return n < 1e11 ? Math.round(n * 1000) : n;
};

const KEEP_ENDED = 5;

export function codexTurnEvent(tool: ToolId, sid: string, t: CodexTurn, c: CodexCarry): TurnEvent {
  const ended = t.status !== "running";
  const endedWith: TurnEvent["endedWith"] =
    t.status === "error"
      ? "error"
      : t.status === "interrupted"
        ? "aborted"
        : t.status === "completed"
          ? t.question
            ? "question"
            : "end_turn"
          : undefined;
  const hasTokens = t.tokIn !== undefined || t.tokOut !== undefined;
  return {
    kind: "turn",
    ref: { tool, externalId: sid },
    turnKey: t.key,
    startedAt: t.startedAt,
    ...(ended && t.endedAt !== undefined ? { endedAt: t.endedAt } : {}),
    ...(ended && t.durationMs !== undefined ? { durationMs: t.durationMs } : {}),
    status: t.status,
    ...(endedWith ? { endedWith } : {}),
    initiator: t.human ? "human" : "system",
    ...(c.branch ? { gitBranch: c.branch } : {}),
    ...((t.cwd ?? c.cwd) ? { cwd: (t.cwd ?? c.cwd) as string } : {}),
    ...(hasTokens
      ? { tokens: { input: t.tokIn ?? 0, output: t.tokOut ?? 0, cacheRead: t.tokCache ?? 0 } }
      : {}),
    toolCounts: { ...t.tools },
    editedFiles: t.edits,
    pendingQuestion: false,
    closingQuestion: t.status === "completed" && t.question && t.closing,
    lastActivityAt: t.lastAt,
  };
}

export function readRollout(
  tool: ToolId,
  parserVersion: number,
  stream: StreamSpec,
  cursor: Cursor | null,
  ctx: ReadContext,
  archived: boolean,
): ReadResult {
  const stats = { records: 0, skipped: 0, unknownTypes: 0, missingRequired: 0 };
  const chunk = readJsonlIncremental(stream.path, cursor, { maxBytes: ctx.maxBytes });
  if (!chunk) {
    return {
      events: [],
      next: cursor ?? { byteOffset: 0, parserVersion },
      stats,
      done: true,
      missing: true,
    };
  }
  const prev = chunk.reset ? undefined : (cursor?.carry as CodexCarry | undefined);
  const c: CodexCarry =
    prev?.v === 1
      ? structuredClone(prev)
      : { v: 1, subagent: false, guardian: false, human: false, turns: [] };
  const touched = new Set<string>();
  const turnOf = (id: string | undefined) =>
    id ? c.turns.find((t) => t.key === id) : c.turns.at(-1);
  const home = ctx.home ?? homedir();
  const cwdOf = (v: unknown) => {
    const s = str(v);
    return s ? trimCodexScratchCwd(s, home) : undefined;
  };

  for (const line of chunk.lines) {
    const raw = line.value;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      stats.skipped++;
      continue;
    }
    const type = str((raw as Rec).type) ?? "";
    if (!KNOWN_TYPES.has(type)) {
      stats.unknownTypes++;
      continue;
    }
    const ptype = str(((raw as Rec).payload as Rec | undefined)?.type);
    const key = type === "event_msg" ? `event_msg:${ptype}` : type;
    // 本文に触れる判定（task_complete.last_agent_message）はここで済ませる
    const traits =
      key === "event_msg:task_complete"
        ? textTraits(((raw as Rec).payload as Rec | undefined)?.last_agent_message)
        : null;
    const keys =
      (CODEX_ALLOWLIST as Record<string, readonly string[]>)[key] ?? CODEX_ALLOWLIST["*"];
    const r = pickAllowed(raw, keys);
    const p = (r.payload as Rec | undefined) ?? {};
    stats.records++;
    const at = ts(r.timestamp);
    if (at !== undefined) {
      c.firstAt = Math.min(c.firstAt ?? at, at);
      c.lastAt = Math.max(c.lastAt ?? at, at);
    }

    if (type === "session_meta") {
      const id = str(p.id) ?? str(p.session_id);
      if (!id) {
        stats.missingRequired++;
        continue;
      }
      c.id = id;
      const t0 = ts(p.timestamp);
      if (t0 !== undefined) c.firstAt = Math.min(c.firstAt ?? t0, t0);
      if (str(p.cwd)) c.cwd = cwdOf(p.cwd);
      if (str(p.originator)) c.originator = str(p.originator);
      if (str(p.cli_version)) c.cliVersion = str(p.cli_version);
      const branch = str((p.git as Rec | undefined)?.branch);
      if (branch) c.branch = branch;
      const src = p.source;
      if (src && typeof src === "object") {
        const sub = (src as Rec).subagent as Rec | undefined;
        if (sub) {
          c.subagent = true;
          if (str(sub.other) === "guardian") c.guardian = true;
        }
      }
      if (str(p.thread_source) === "guardian_review") c.guardian = true;
      if (str(p.parent_thread_id)) c.parent = str(p.parent_thread_id);
      continue;
    }
    if (!c.id) continue;
    if (type === "turn_context") {
      const t = turnOf(str(p.turn_id));
      if (str(p.cwd)) {
        c.cwd = cwdOf(p.cwd);
        if (t) t.cwd = c.cwd;
      }
      if (str(p.model)) c.model = str(p.model);
      if (t) touched.add(t.key);
      continue;
    }
    if (key === "event_msg:task_started") {
      const id = str(p.turn_id);
      const started = secOrMs(p.started_at) ?? at;
      if (!id || started === undefined) {
        stats.missingRequired++;
        continue;
      }
      if (!c.turns.some((t) => t.key === id)) {
        c.turns.push({
          key: id,
          startedAt: started,
          lastAt: started,
          status: "running",
          human: false,
          ...(c.cwd ? { cwd: c.cwd } : {}),
          edits: 0,
          tools: {},
          question: false,
          closing: false,
        });
      }
      touched.add(id);
      continue;
    }
    if (key === "event_msg:task_complete" || key === "event_msg:turn_aborted") {
      const t = turnOf(str(p.turn_id));
      if (!t) {
        stats.missingRequired++;
        continue;
      }
      const end = secOrMs(p.completed_at) ?? at ?? t.lastAt;
      t.endedAt = end;
      t.lastAt = Math.max(t.lastAt, end);
      const d = num(p.duration_ms);
      t.durationMs = d ?? Math.max(0, end - t.startedAt);
      if (key === "event_msg:task_complete") {
        t.status = "completed";
        if (traits) {
          t.question = traits.question;
          t.closing = traits.closing;
        }
      } else {
        t.status = USER_ABORT_REASONS.has(str(p.reason) ?? "") ? "interrupted" : "error";
      }
      touched.add(t.key);
      continue;
    }
    if (key === "event_msg:item_completed") {
      const t = turnOf(str(p.turn_id));
      const it = str((p.item as Rec | undefined)?.type);
      if (it === "UserMessage") {
        c.human = true;
        if (t) t.human = true;
      }
      if (t && it) {
        if (TOOL_ITEMS.has(it)) t.tools[it] = (t.tools[it] ?? 0) + 1;
        if (it === "FileChange") t.edits++;
        if (at !== undefined && t.status === "running") t.lastAt = Math.max(t.lastAt, at);
        touched.add(t.key);
      }
      continue;
    }
    if (type === "token_usage_record") {
      const t = turnOf(str(p.turn_id));
      const u = p.turn_token_usage as Rec | undefined;
      if (t && u) {
        t.tokIn = num(u.input_tokens) ?? t.tokIn;
        t.tokOut = num(u.output_tokens) ?? t.tokOut;
        t.tokCache = num(u.cached_input_tokens) ?? t.tokCache;
        touched.add(t.key);
      }
      continue;
    }
    // response_item など: 活動の時刻だけ反映する
    const t = c.turns.at(-1);
    if (t && t.status === "running" && at !== undefined) t.lastAt = Math.max(t.lastAt, at);
  }

  const events: NormalizedEvent[] = [];
  if (c.id) {
    for (const t of c.turns) if (touched.has(t.key)) events.push(codexTurnEvent(tool, c.id, t, c));
    // 終わったターンは直近の KEEP_ENDED 件だけ carry に残す
    const open = c.turns.filter((t) => t.status === "running");
    const ended = c.turns.filter((t) => t.status !== "running").slice(-KEEP_ENDED);
    c.turns = [...ended, ...open].sort((a, b) => a.startedAt - b.startedAt);
    if (c.lastAt !== undefined) {
      events.push({
        kind: "session_seen",
        ref: { tool, externalId: c.id },
        at: c.lastAt,
        ...(c.firstAt !== undefined ? { startedAt: c.firstAt } : {}),
        ...(c.cwd ? { cwd: c.cwd } : {}),
        ...(c.originator ? { entrypoint: c.originator } : {}),
        ...(c.cliVersion ? { clientVersion: c.cliVersion } : {}),
        ...(c.model ? { model: c.model } : {}),
        ...(c.parent ? { parent: { tool, externalId: c.parent } } : {}),
        isSubagent: c.subagent,
        ...(archived ? { archived: true } : {}),
        hasHumanInput: c.human,
        noise: c.guardian || !c.human,
        filePath: stream.path,
      });
    }
  }
  return { events, next: { ...chunk.next, carry: c, parserVersion }, stats, done: chunk.done };
}

export const SESSION_INDEX_KEYS = ["id", "thread_name", "updated_at"] as const;

/** session_index.jsonl: スレッド名（タイトル）。同じ id は後の行が新しい */
export function readSessionIndex(
  tool: ToolId,
  parserVersion: number,
  stream: StreamSpec,
  cursor: Cursor | null,
  ctx: ReadContext,
): ReadResult {
  const stats = { records: 0, skipped: 0, unknownTypes: 0, missingRequired: 0 };
  const chunk = readJsonlIncremental(stream.path, cursor, { maxBytes: ctx.maxBytes });
  if (!chunk) {
    return {
      events: [],
      next: cursor ?? { byteOffset: 0, parserVersion },
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
    const r = pickAllowed(line.value, SESSION_INDEX_KEYS);
    stats.records++;
    const id = str(r.id);
    const at = ts(r.updated_at);
    if (!id || at === undefined) {
      stats.missingRequired++;
      continue;
    }
    const name = str(r.thread_name);
    if (!name || !ctx.privacy.storeTitles) continue;
    events.push({
      kind: "session_seen",
      ref: { tool, externalId: id },
      at,
      title: name,
      titleSource: "thread_name",
    });
  }
  return { events, next: { ...chunk.next, parserVersion }, stats, done: chunk.done };
}
