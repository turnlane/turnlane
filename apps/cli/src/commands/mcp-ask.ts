/**
 * MCP の ask_user（ADR 0022。m2-api 41 章）: AI が人の判断を仰ぐ問いを Turnlane の自分の番に出し、画面で選ばれた答えを
 * ツールの結果として返す。
 *
 * - 図のファイルを読むのはこのプロセス（AI と同じ権限）。デーモンには読んだ中身だけを送る（デーモンに手元のパスを読む口は
 *   作らない）。1 ファイル 200 KB まで。読めない・大きすぎる図は理由だけを送る（案は選べる）
 * - 答えは long-poll（GET /api/asks/:id/result?wait=25000）で待つ。デーモンに届かない間は 60 秒まで再接続する。デーモンが
 *   再起動して問いが消えたら（404）エラーにして、端末で聞き直すように言う
 * - クライアントが progressToken を付けていれば、待っている間 60 秒ごとに進捗の通知を送る（Claude Code は 30 分なにも届かない
 *   呼び出しを打ち切る）
 * - クライアントが取り消したら（notifications/cancelled）、Turnlane の問いも閉じる（画面は「もう進んでいます」）
 */
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
  ASK_CONTEXT_MAX,
  ASK_DESCRIPTION_MAX,
  ASK_FIGURE_VARS,
  ASK_FILE_MAX,
  ASK_LABEL_MAX,
  ASK_OPTIONS_MAX,
  ASK_OPTIONS_MIN,
  ASK_QUESTION_MAX,
  baseUrl,
  readToken,
} from "@turnlane/core";
import type { AskCreateResponse, AskFigureInput, AskResultResponse } from "@turnlane/core/api";

type Json = Record<string, unknown>;

/** 1 回の呼び出しの文脈（取り消しと進捗） */
export interface CallContext {
  signal: AbortSignal;
  /** 進捗の通知（クライアントが progressToken を付けたときだけ送る） */
  progress: (message: string) => void;
}

export interface AskContext {
  paths: { port: number; tokenPath: string };
  client: string;
  cwd: string;
  /** 呼んだ AI のプロセス（このプロセスの親） */
  pid: number | null;
}

export class AskToolError extends Error {}

/** long-poll の 1 回の長さ */
export const POLL_MS = 25_000;
/** 進捗の通知の間隔 */
export const PROGRESS_MS = 60_000;
/** デーモンに届かない間に再接続を続ける長さ */
export const RECONNECT_MS = 60_000;

const FALLBACK = "Ask the user in the terminal instead.";

export const ASK_USER_DESCRIPTION =
  "Ask the user to choose between concrete alternatives, shown in Turnlane's Your turn with a small figure per option " +
  "and an explanation page. Blocks until the user answers in Turnlane (can be hours) and returns " +
  '{"choice": "<label>", "note"?: "<text>"}, {"note": "<text>"} when they only wrote a note, or {"dismissed": true}. ' +
  `One question per call (question <= ${ASK_QUESTION_MAX} chars, context <= ${ASK_CONTEXT_MAX}, ${ASK_OPTIONS_MIN}-${ASK_OPTIONS_MAX} options). ` +
  "Figures are files you write: static HTML or SVG with inline CSS only (no scripts, no network, no external images or fonts; " +
  `each <= ${ASK_FILE_MAX / 1024} KB). Use these CSS variables so they read in light and dark: ${ASK_FIGURE_VARS.join(", ")}. ` +
  "On error, ask the user in the terminal instead.";

export const ASK_USER_SCHEMA: Json = {
  type: "object",
  properties: {
    question: { type: "string", description: `the question in one line (<= ${ASK_QUESTION_MAX})` },
    context: {
      type: "string",
      description: `2-3 sentences of background (<= ${ASK_CONTEXT_MAX})`,
    },
    options: {
      type: "array",
      minItems: ASK_OPTIONS_MIN,
      maxItems: ASK_OPTIONS_MAX,
      items: {
        type: "object",
        properties: {
          label: { type: "string", description: `short name (<= ${ASK_LABEL_MAX})` },
          description: {
            type: "string",
            description: `what this option means (<= ${ASK_DESCRIPTION_MAX})`,
          },
          recommended: { type: "boolean", description: "your recommendation (at most one)" },
          figure_path: {
            type: "string",
            description: "path to a small static HTML/SVG figure for this option",
          },
        },
        required: ["label", "description"],
      },
    },
    explain_path: {
      type: "string",
      description:
        "path to one static HTML page: why decide now, the alternatives side by side, what you actually looked at",
    },
  },
  required: ["question", "options"],
};

/** 図のファイルを読む（相対パスは作業ディレクトリから）。読めない・大きすぎるときは理由 */
export function readFigure(path: string, cwd: string): AskFigureInput {
  const p = isAbsolute(path) ? path : resolve(cwd, path);
  try {
    const st = statSync(p);
    if (!st.isFile()) return { error: "unreadable" };
    if (st.size > ASK_FILE_MAX) return { error: "too_large" };
    const buf = readFileSync(p);
    if (buf.length > ASK_FILE_MAX) return { error: "too_large" };
    const html = new TextDecoder("utf-8", { fatal: true }).decode(buf);
    return { html };
  } catch {
    return { error: "unreadable" };
  }
}

const str = (v: unknown) => (typeof v === "string" && v.trim().length > 0 ? v : undefined);

/** 引数 → POST /api/asks の本文（図はこのプロセスが読む）。形の誤りはデーモンが項目の名前で返す */
export function askBody(a: Json, ctx: AskContext): Json {
  const options = Array.isArray(a.options)
    ? a.options.map((o) => {
        if (typeof o !== "object" || o === null) return o;
        const x = o as Json;
        const fp = str(x.figure_path);
        return {
          label: x.label,
          description: x.description,
          ...(x.recommended !== undefined ? { recommended: x.recommended } : {}),
          ...(fp ? { figure: readFigure(fp, ctx.cwd) } : {}),
        };
      })
    : a.options;
  const ep = str(a.explain_path);
  return {
    question: a.question,
    ...(a.context !== undefined ? { context: a.context } : {}),
    options,
    ...(ep ? { explain: readFigure(ep, ctx.cwd) } : {}),
    ...(ctx.pid ? { pid: ctx.pid } : {}),
    cwd: ctx.cwd,
    client: ctx.client,
  };
}

interface Http {
  status: number;
  data: unknown;
}

async function http(
  ctx: AskContext,
  method: "GET" | "POST",
  path: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<Http> {
  const res = await fetch(`${baseUrl(ctx.paths.port)}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${readToken(ctx.paths.tokenPath)}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    ...(signal ? { signal } : {}),
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {}
  return { status: res.status, data };
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((r) => {
    const t = setTimeout(r, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        r();
      },
      { once: true },
    );
  });

export interface AskTimings {
  pollMs: number;
  progressMs: number;
  reconnectMs: number;
  retryMs: number;
  now: () => number;
}

const DEFAULT_TIMINGS: AskTimings = {
  pollMs: POLL_MS,
  progressMs: PROGRESS_MS,
  reconnectMs: RECONNECT_MS,
  retryMs: 2_000,
  now: () => Date.now(),
};

/** ask_user を実行する（答えが来るまで返らない） */
export async function runAskUser(
  a: Json,
  ctx: AskContext,
  call: CallContext,
  timings: Partial<AskTimings> = {},
): Promise<Json> {
  const t = { ...DEFAULT_TIMINGS, ...timings };
  let created: Http;
  try {
    created = await http(ctx, "POST", "/api/asks", askBody(a, ctx));
  } catch {
    throw new AskToolError(`Turnlane is not running. ${FALLBACK}`);
  }
  if (created.status === 400) {
    const field = (created.data as { field?: string } | null)?.field ?? "body";
    throw new AskToolError(
      `invalid_input: ${field} (question <= ${ASK_QUESTION_MAX} chars, context <= ${ASK_CONTEXT_MAX}, ` +
        `${ASK_OPTIONS_MIN}-${ASK_OPTIONS_MAX} options with unique labels <= ${ASK_LABEL_MAX} and descriptions <= ${ASK_DESCRIPTION_MAX})`,
    );
  }
  if (created.status !== 201) {
    const code = (created.data as { error?: string } | null)?.error ?? `http_${created.status}`;
    if (code === "no_card")
      throw new AskToolError(`Turnlane can't show the question (AI import is off). ${FALLBACK}`);
    throw new AskToolError(`${code}. ${FALLBACK}`);
  }
  const id = (created.data as AskCreateResponse).id;
  const cancel = () =>
    http(ctx, "POST", `/api/asks/${encodeURIComponent(id)}/cancel`, undefined).catch(() => null);
  let lastProgress = t.now();
  let unreachableSince: number | null = null;
  const progressTimer = setInterval(() => {
    call.progress("Waiting for the user's answer in Turnlane");
    lastProgress = t.now();
  }, t.progressMs);
  try {
    for (;;) {
      if (call.signal.aborted) {
        await cancel();
        throw new AskToolError("cancelled");
      }
      let r: Http;
      try {
        r = await http(
          ctx,
          "GET",
          `/api/asks/${encodeURIComponent(id)}/result?wait=${t.pollMs}`,
          undefined,
          call.signal,
        );
        unreachableSince = null;
      } catch {
        if (call.signal.aborted) continue;
        // デーモンに届かない（再起動中など）。戻れば 404（消えた）か続き
        unreachableSince ??= t.now();
        if (t.now() - unreachableSince >= t.reconnectMs)
          throw new AskToolError(
            `Turnlane is not reachable, so the question was lost. ${FALLBACK}`,
          );
        await sleep(t.retryMs, call.signal);
        continue;
      }
      if (r.status === 404)
        throw new AskToolError(`Turnlane restarted and the question was lost. ${FALLBACK}`);
      if (r.status !== 200) {
        const code = (r.data as { error?: string } | null)?.error ?? `http_${r.status}`;
        throw new AskToolError(`${code}. ${FALLBACK}`);
      }
      const res = r.data as AskResultResponse;
      if (res.state === "open") {
        if (t.now() - lastProgress >= t.progressMs) {
          call.progress("Waiting for the user's answer in Turnlane");
          lastProgress = t.now();
        }
        continue;
      }
      if (res.state === "answered")
        return {
          ...(res.choice !== undefined ? { choice: res.choice } : {}),
          ...(res.note !== undefined ? { note: res.note } : {}),
        };
      if (res.state === "dismissed") return { dismissed: true };
      throw new AskToolError(`The question was closed in Turnlane. ${FALLBACK}`);
    }
  } finally {
    clearInterval(progressTimer);
  }
}
