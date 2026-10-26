/**
 * Claude Code のトランスクリプト（projects/<enc-cwd>/<sessionId>.jsonl）のパース（ai-session-ingestion 1.1）。
 *
 * - ターンは origin.kind=="human" / "task-notification" の user レコードで始まる。turnKey は promptId（無ければ uuid。U6）
 * - task-notification 起点のターンは initiator='system'（人間入力ではない）
 * - ターンの gitBranch / cwd はターン内で最後のレコードの値
 * - system/turn_duration か assistant.stop_reason=="end_turn" で終了
 * - pr-link はセッション内で (prRepository, prNumber) が初めて出たレコードだけを artifact にする（既出の組は carry）
 * - AskUserQuestion の tool_use で pendingQuestion、対応する tool_result で解除
 * - 最終 assistant テキストが質問で終わるか・締めの決まり文句かはパース中にだけ判定し、真偽値だけを残す
 * - 表示の瞬間に読む位置（glance。D-207）: carry に行の先頭のバイト位置（数値）だけを持つ。ターンの最後の assistant の
 *   テキストの行（textAt）、結果（tool_result）がまだ無い tool_use の行と ID・ツール名（pend）、件名に使える直近の
 *   人の指示の行（promptAt）。本文は carry に残さない（ADR 0005）
 * - 自分の指示の 1 行目（ADR 0018、D-218）: privacy.storeDetails のとき、ターンを始めた件名に使える指示の 1 行目を
 *   TurnEvent.instruction に付ける（指示の行を読んだチャンクのイベントだけ。carry には入れない。伏せ字はシンクで通す）
 * - 題名（ai-session-ingestion 4.4）: privacy.storeTitles のとき、`summary` の行の `summary`（最新のもの）を `ai-title` より
 *   優先する。どちらも cleanTitle を通し、空同然なら使わない。`summary` の行で読むのはこのキーだけ（leafUuid も読まない）
 */
import { homedir } from "node:os";
import { pickAllowed } from "../../allowlist.ts";
import { textTraits } from "../../closing-question.ts";
import { trimClaudeProjectPath, trimCodexScratchCwd } from "../../hook-allowlist.ts";
import { promptSubject, promptText } from "../../prompt-traits.ts";
import { readJsonlIncremental } from "../../readers/jsonl.ts";
import { cleanTitle } from "../../title.ts";
import type {
  Cursor,
  NormalizedEvent,
  ReadContext,
  ReadResult,
  StreamSpec,
  ToolId,
  TurnEvent,
} from "../../types.ts";

const COMMON = [
  "type",
  "subtype",
  "timestamp",
  "sessionId",
  "uuid",
  "isSidechain",
  "isMeta",
  "cwd",
  "gitBranch",
  "version",
  "entrypoint",
] as const;

export const CLAUDE_ALLOWLIST = {
  user: [
    ...COMMON,
    "promptId",
    "origin.kind",
    "promptSource",
    "message.content[].type",
    "message.content[].tool_use_id",
  ],
  assistant: [
    ...COMMON,
    "isApiErrorMessage",
    "error",
    "message.id",
    "message.model",
    "message.stop_reason",
    "message.usage.input_tokens",
    "message.usage.output_tokens",
    "message.usage.cache_read_input_tokens",
    "message.content[].type",
    "message.content[].name",
    "message.content[].id",
  ],
  system: [...COMMON, "durationMs"],
  attachment: [...COMMON, "attachment.type"],
  "ai-title": ["type", "sessionId", "aiTitle"],
  "pr-link": ["type", "sessionId", "timestamp", "prNumber", "prRepository", "prUrl"],
  "*": ["type", "timestamp", "sessionId"],
} as const satisfies Record<string, readonly string[]>;

const SUBAGENT_KEYS = ["type", "timestamp", "sessionId", "cwd", "message.stop_reason"] as const;

/** 型ごとの必須キー（欠落率で縮退を判定する。ai-session-ingestion 3.4） */
const REQUIRED: Record<string, readonly string[]> = {
  user: ["timestamp", "sessionId"],
  assistant: ["timestamp", "sessionId"],
  system: ["timestamp"],
  "pr-link": ["prNumber", "prRepository"],
  "ai-title": ["aiTitle"],
};

const KNOWN_TYPES = new Set([
  "user",
  "assistant",
  "system",
  "attachment",
  "ai-title",
  "pr-link",
  "last-prompt",
  "permission-mode",
  "mode",
  "bridge-session",
  "file-history-snapshot",
  "file-history-delta",
  "queue-operation",
  "summary",
  "custom-title",
  "atis-latch",
  "cost-state",
]);

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

interface OpenTurn {
  key: string;
  startedAt: number;
  lastAt: number;
  endedAt?: number | undefined;
  durationMs?: number | undefined;
  tdCount: number;
  initiator: "human" | "queued" | "system";
  branch?: string | undefined;
  cwd?: string | undefined;
  edits: number;
  tools: Record<string, number>;
  tokIn: number;
  tokOut: number;
  tokCache: number;
  lastMsgId?: string | undefined;
  lastStop?: string | undefined;
  question: boolean;
  closing: boolean;
  interrupted: boolean;
  error: boolean;
  /** 未回答の AskUserQuestion の tool_use id */
  ask: string[];
  /** glance: ターンの最後の assistant のテキストの行の位置 */
  textAt?: number | undefined;
  /** glance: 結果（tool_result）がまだ無い tool_use（[id, ツール名, 行の位置]。新しいものが後ろ。最大 PEND_MAX 件） */
  pend?: [string, string, number][] | undefined;
}

/** carry に持つ未解決の tool_use の上限（並列の呼び出しでも足りる数） */
const PEND_MAX = 16;

export interface ClaudeCarry {
  v: 1;
  sid?: string | undefined;
  firstAt?: number | undefined;
  lastAt?: number | undefined;
  cwd?: string | undefined;
  entrypoint?: string | undefined;
  version?: string | undefined;
  model?: string | undefined;
  title?: string | undefined;
  /** `summary` の行の要約（cleanTitle 済み。最新のもの）。title より優先する */
  sum?: string | undefined;
  /** 題名の行（ai-title・summary）があったが、どれも空同然だった */
  junkTitle?: boolean | undefined;
  /** 先頭から読み直している途中（版の更新・新しいファイル。終わりまで読んだら消す） */
  fromStart?: boolean | undefined;
  human: boolean;
  prs: string[];
  turn: OpenTurn | null;
  /** glance: 件名に使える直近の人の指示（user レコード）の行の位置（D-207 (3)） */
  promptAt?: number | undefined;
}

type Rec = Record<string, unknown>;

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 ? v : undefined;
const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;
const ts = (v: unknown): number | undefined => {
  if (typeof v !== "string") return undefined;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : t;
};

/** 本文に触れる判定（その場で真偽値にして捨てる） */
function rawAssistantLastText(raw: Rec): string | undefined {
  const content = (raw.message as Rec | undefined)?.content;
  if (!Array.isArray(content)) return undefined;
  let last: string | undefined;
  for (const c of content) {
    if (
      c &&
      typeof c === "object" &&
      (c as Rec).type === "text" &&
      typeof (c as Rec).text === "string"
    ) {
      last = (c as Rec).text as string;
    }
  }
  return last;
}

function rawIsInterruptMarker(raw: Rec): boolean {
  const content = (raw.message as Rec | undefined)?.content;
  const first = Array.isArray(content)
    ? (
        content.find((c) => c && typeof c === "object" && (c as Rec).type === "text") as
          | Rec
          | undefined
      )?.text
    : content;
  return typeof first === "string" && first.startsWith("[Request interrupted");
}

function turnStatus(t: OpenTurn): TurnEvent["status"] {
  if (t.error) return "error";
  if (t.interrupted) return "interrupted";
  if (t.tdCount > 0 || t.lastStop === "end_turn") return "completed";
  return "running";
}

export function turnEventOf(tool: ToolId, sid: string, t: OpenTurn, closed: boolean): TurnEvent {
  let status = turnStatus(t);
  // 次の人間入力で閉じたのに終わっていなかったターンは中断とみなす（S3）
  if (closed && status === "running") status = "interrupted";
  const ended = status !== "running";
  const endedAt = ended ? (t.endedAt ?? t.lastAt) : undefined;
  const durationMs =
    t.tdCount > 0
      ? t.durationMs
      : ended && endedAt !== undefined
        ? Math.max(0, endedAt - t.startedAt)
        : undefined;
  const endedWith: TurnEvent["endedWith"] =
    status === "error"
      ? "error"
      : status === "interrupted"
        ? "aborted"
        : status === "completed"
          ? t.question
            ? "question"
            : "end_turn"
          : undefined;
  return {
    kind: "turn",
    ref: { tool, externalId: sid },
    turnKey: t.key,
    startedAt: t.startedAt,
    ...(endedAt !== undefined ? { endedAt } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    status,
    ...(endedWith ? { endedWith } : {}),
    initiator: t.initiator,
    ...(t.branch ? { gitBranch: t.branch } : {}),
    ...(t.cwd ? { cwd: t.cwd } : {}),
    tokens: { input: t.tokIn, output: t.tokOut, cacheRead: t.tokCache },
    toolCounts: { ...t.tools },
    editedFiles: t.edits,
    pendingQuestion: t.ask.length > 0,
    closingQuestion: status === "completed" && t.question && t.closing,
    lastActivityAt: t.lastAt,
  };
}

/** cwd（Codex の作業フォルダは日付までに切り落とす。D-135・D-136） */
function cwdOf(v: unknown, home: string): string | undefined {
  const s = typeof v === "string" && v.length > 0 ? v : undefined;
  return s ? trimCodexScratchCwd(s, home) : undefined;
}

export function readTranscript(
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
  const prev = chunk.reset ? undefined : (cursor?.carry as ClaudeCarry | undefined);
  const c: ClaudeCarry =
    prev?.v === 1 ? structuredClone(prev) : { v: 1, human: false, prs: [], turn: null };
  const fileSid = stream.path.slice(stream.path.lastIndexOf("/") + 1, -".jsonl".length);
  if (!c.sid) c.sid = fileSid;
  if (!prev) c.fromStart = true;
  // Codex の作業フォルダの名前（最初の依頼から作ったもの）は継続状態（DB の carry_state_json）にも残さない（D-136）
  const home = ctx.home ?? homedir();
  const events: NormalizedEvent[] = [];
  const closedTurns: OpenTurn[] = [];
  /** ターン → 指示の 1 行目（このチャンクで読んだものだけ。carry には残さない） */
  const instructions = new Map<string, string>();
  let touched = false;

  for (const line of chunk.lines) {
    const raw = line.value;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      stats.skipped++;
      continue;
    }
    const type = typeof (raw as Rec).type === "string" ? ((raw as Rec).type as string) : "";
    if (!KNOWN_TYPES.has(type)) {
      stats.unknownTypes++;
      continue;
    }
    // 本文に触れる判定はここで済ませ、以降は許可リストを通した r だけを使う
    const traits = type === "assistant" ? textTraits(rawAssistantLastText(raw as Rec)) : null;
    const interruptMarker = type === "user" ? rawIsInterruptMarker(raw as Rec) : false;
    const subject =
      type === "user"
        ? promptSubject(promptText(((raw as Rec).message as Rec | undefined)?.content))
        : null;
    const usablePrompt = subject !== null;
    // `summary` の行は要約の文字列だけをその場で題名の候補にする（本文のキーなので許可リストには入れない）
    const summaryTitle =
      type === "summary" && ctx.privacy.storeTitles ? cleanTitle((raw as Rec).summary) : null;
    const keys =
      (CLAUDE_ALLOWLIST as Record<string, readonly string[]>)[type] ?? CLAUDE_ALLOWLIST["*"];
    const r = pickAllowed(raw, keys);
    stats.records++;
    if ((REQUIRED[type] ?? []).some((k) => r[k] === undefined)) {
      stats.missingRequired++;
      continue;
    }
    touched = true;
    const at = ts(r.timestamp);
    if (at !== undefined) {
      c.firstAt = Math.min(c.firstAt ?? at, at);
      c.lastAt = Math.max(c.lastAt ?? at, at);
    }

    if (type === "ai-title") {
      const t = ctx.privacy.storeTitles ? cleanTitle(r.aiTitle) : null;
      if (t) c.title = t;
      else if (ctx.privacy.storeTitles) c.junkTitle = true;
      continue;
    }
    if (type === "summary") {
      if (summaryTitle) c.sum = summaryTitle;
      else if (ctx.privacy.storeTitles) c.junkTitle = true;
      continue;
    }
    if (type === "pr-link") {
      const repo = str(r.prRepository);
      const n = num(r.prNumber);
      if (!repo || n === undefined) continue;
      const ref = `${repo}#${n}`;
      if (!c.prs.includes(ref)) {
        c.prs.push(ref);
        const url = str(r.prUrl);
        events.push({
          kind: "artifact",
          ref: { tool, externalId: c.sid },
          ...(c.turn ? { turnKey: c.turn.key } : {}),
          at: at ?? c.lastAt ?? ctx.now,
          artifact: { kind: "pr", repo, number: n, ...(url ? { url } : {}) },
        });
      }
      continue;
    }
    if (r.isSidechain === true) continue;
    const ep = str(r.entrypoint);
    if (ep && !c.entrypoint) c.entrypoint = ep;
    const ver = str(r.version);
    if (ver) c.version = ver;
    const cwd = cwdOf(r.cwd, home);
    if (cwd) c.cwd = cwd;

    if (type === "user") {
      const origin = str((r.origin as Rec | undefined)?.kind);
      if (
        (origin === "human" || origin === "task-notification") &&
        at !== undefined &&
        r.isMeta !== true
      ) {
        if (c.turn) closedTurns.push(c.turn);
        const src = str(r.promptSource);
        c.turn = {
          key: str(r.promptId) ?? str(r.uuid) ?? `t${at}`,
          startedAt: at,
          lastAt: at,
          tdCount: 0,
          initiator:
            origin === "task-notification" ? "system" : src === "queued" ? "queued" : "human",
          ...(str(r.gitBranch) ? { branch: str(r.gitBranch) as string } : {}),
          ...(cwd ? { cwd } : {}),
          edits: 0,
          tools: {},
          tokIn: 0,
          tokOut: 0,
          tokCache: 0,
          question: false,
          closing: false,
          interrupted: false,
          error: false,
          ask: [],
        };
        if (origin === "human") {
          c.human = true;
          if (usablePrompt) c.promptAt = line.offset;
          // 指示の 1 行目（ADR 0018）は carry に入れず、このチャンクのイベントにだけ付ける
          if (subject !== null && ctx.privacy.storeDetails) instructions.set(c.turn.key, subject);
        }
        continue;
      }
      const t = c.turn;
      if (!t) continue;
      const content = (r.message as Rec | undefined)?.content;
      if (Array.isArray(content)) {
        for (const item of content) {
          const id = str((item as Rec | null)?.tool_use_id);
          if (id) {
            t.ask = t.ask.filter((x) => x !== id);
            if (t.pend) t.pend = t.pend.filter((x) => x[0] !== id);
          }
        }
      }
      if (interruptMarker) t.interrupted = true;
      if (at !== undefined) t.lastAt = Math.max(t.lastAt, at);
      if (str(r.gitBranch)) t.branch = str(r.gitBranch) as string;
      if (cwd) t.cwd = cwd;
      continue;
    }

    const t = c.turn;
    if (!t) continue;
    if (type !== "attachment") {
      if (str(r.gitBranch)) t.branch = str(r.gitBranch) as string;
      if (cwd) t.cwd = cwd;
      if (at !== undefined) t.lastAt = Math.max(t.lastAt, at);
    }
    if (type === "assistant") {
      const m = (r.message as Rec | undefined) ?? {};
      const model = str(m.model);
      if (model && model !== "<synthetic>") c.model = model;
      const stop = str(m.stop_reason);
      if (stop) t.lastStop = stop;
      if (r.isApiErrorMessage === true) t.error = true;
      const msgId = str(m.id);
      const usage = m.usage as Rec | undefined;
      if (usage && msgId && msgId !== t.lastMsgId) {
        t.tokIn += num(usage.input_tokens) ?? 0;
        t.tokOut += num(usage.output_tokens) ?? 0;
        t.tokCache += num(usage.cache_read_input_tokens) ?? 0;
      }
      if (msgId) t.lastMsgId = msgId;
      const content = m.content;
      if (Array.isArray(content)) {
        for (const item of content) {
          const it = (item ?? {}) as Rec;
          if (it.type === "tool_use") {
            const name = str(it.name) ?? "unknown";
            t.tools[name] = (t.tools[name] ?? 0) + 1;
            if (EDIT_TOOLS.has(name)) t.edits++;
            const id = str(it.id);
            if (name === "AskUserQuestion" && id) t.ask.push(id);
            if (id)
              t.pend = [
                ...(t.pend ?? []),
                [id, name, line.offset] as [string, string, number],
              ].slice(-PEND_MAX);
          }
        }
      }
      if (traits && rawHasText(r)) {
        t.question = traits.question;
        t.closing = traits.closing;
        t.textAt = line.offset;
      }
      if (stop === "end_turn" && at !== undefined && t.tdCount === 0) t.endedAt = at;
      continue;
    }
    if (type === "system" && r.subtype === "turn_duration") {
      const d = num(r.durationMs);
      if (d !== undefined) {
        t.durationMs = (t.tdCount > 0 ? (t.durationMs ?? 0) : 0) + d;
        t.tdCount++;
        if (at !== undefined) t.endedAt = at;
      }
    }
  }

  const withInstruction = (e: TurnEvent): TurnEvent => {
    const x = instructions.get(e.turnKey);
    return x ? { ...e, instruction: x } : e;
  };
  for (const t of closedTurns) events.push(withInstruction(turnEventOf(tool, c.sid, t, true)));
  if (c.turn && (touched || chunk.reset))
    events.push(withInstruction(turnEventOf(tool, c.sid, c.turn, false)));
  const title = c.sum ?? c.title;
  if (c.lastAt !== undefined) {
    events.push({
      kind: "session_seen",
      ref: { tool, externalId: c.sid },
      at: c.lastAt,
      ...(c.firstAt !== undefined ? { startedAt: c.firstAt } : {}),
      ...(c.cwd ? { cwd: c.cwd } : {}),
      ...(c.entrypoint ? { entrypoint: c.entrypoint } : {}),
      ...(c.version ? { clientVersion: c.version } : {}),
      ...(c.model ? { model: c.model } : {}),
      // 先頭からの読み直しで題名の行が空同然のものだけなら、保存済みの古い題名を消す（通常の追記では消さない）
      ...(title
        ? { title, titleSource: "ai_title" }
        : c.fromStart && c.junkTitle
          ? { title: null, titleSource: null }
          : {}),
      hasHumanInput: c.human,
      noise: !c.human,
      filePath: trimClaudeProjectPath(stream.path),
    });
  }
  if (chunk.done) c.fromStart = undefined;
  return {
    events,
    next: { ...chunk.next, carry: c, parserVersion },
    stats,
    done: chunk.done,
  };
}

/** 許可リストを通した assistant レコードにテキストのブロックがあるか（型名だけで判定） */
function rawHasText(r: Rec): boolean {
  const content = (r.message as Rec | undefined)?.content;
  return Array.isArray(content) && content.some((x) => (x as Rec | null)?.type === "text");
}

/**
 * サブエージェントのトランスクリプト: 親子付けと「まだ動いているか」のための session_seen だけを出す（ターンは出さない。
 * 時間は親ターンに含まれ、親のターンが閉じた後の分は判定が親の時間として数える）。最後のレコードが最後の応答
 * （assistant の stop_reason == "end_turn"）なら endedAt にその時刻を入れ、その後に活動があれば null に戻す
 */
export function readSubagent(
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
  type SubCarry = { v: 1; firstAt?: number; lastAt?: number; cwd?: string; endedAt?: number };
  const prev = chunk.reset ? undefined : (cursor?.carry as SubCarry | undefined);
  const c: SubCarry = prev?.v === 1 ? { ...prev } : { v: 1 };
  for (const line of chunk.lines) {
    if (!line.value || typeof line.value !== "object") {
      stats.skipped++;
      continue;
    }
    const r = pickAllowed(line.value, SUBAGENT_KEYS);
    stats.records++;
    const at = ts(r.timestamp);
    if (at !== undefined) {
      c.firstAt = Math.min(c.firstAt ?? at, at);
      c.lastAt = Math.max(c.lastAt ?? at, at);
      const stop = str((r.message as Rec | undefined)?.stop_reason);
      if (r.type === "assistant" && stop === "end_turn") c.endedAt = Math.max(c.endedAt ?? at, at);
      else if (c.endedAt !== undefined && at > c.endedAt) delete c.endedAt;
    }
    const cwd = cwdOf(r.cwd, ctx.home ?? homedir());
    if (cwd) c.cwd = cwd;
  }
  // <root>/projects/<enc>/<sid>/subagents/agent-<id>.jsonl
  const parts = stream.path.split("/");
  const agent = (parts.at(-1) ?? "").replace(/\.jsonl$/, "");
  const parentSid = parts.at(-3) ?? "";
  const events: NormalizedEvent[] = [];
  if (c.lastAt !== undefined && parentSid) {
    events.push({
      kind: "session_seen",
      ref: { tool, externalId: `${parentSid}/${agent}` },
      parent: { tool, externalId: parentSid },
      isSubagent: true,
      at: c.lastAt,
      ...(c.firstAt !== undefined ? { startedAt: c.firstAt } : {}),
      ...(c.cwd ? { cwd: c.cwd } : {}),
      hasHumanInput: false,
      filePath: trimClaudeProjectPath(stream.path),
      endedAt: c.endedAt ?? null,
    });
  }
  return { events, next: { ...chunk.next, carry: c, parserVersion }, stats, done: chunk.done };
}
