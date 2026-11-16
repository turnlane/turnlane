/**
 * 図つきの問い（MCP の ask_user。ADR 0022）の純粋な部分: 上限、デーモンが受ける本文の検証、答えの検証。
 * MCP のプロセス（apps/cli）とデーモンと web が同じ値を使う。Bun・DB に依存しない（web からも読む）。
 */
import type { AskAnswerInput, AskCreateInput, AskFigureInput } from "./api/ask.ts";

/** 問いの 1 行 */
export const ASK_QUESTION_MAX = 120;
/** 背景（2〜3 文） */
export const ASK_CONTEXT_MAX = 600;
export const ASK_OPTIONS_MIN = 2;
export const ASK_OPTIONS_MAX = 4;
/** 案の名前（カードの 1 行。仮置き） */
export const ASK_LABEL_MAX = 80;
/** 案の説明（仮置き） */
export const ASK_DESCRIPTION_MAX = 300;
/** 図のファイル 1 つの上限（バイト） */
export const ASK_FILE_MAX = 200 * 1024;
/** メモ（答えに添える文）。答える欄と同じ上限 */
export const ASK_NOTE_MAX = 4000;
/** デーモンが同時に開いておく問いの数 */
export const ASK_OPEN_MAX = 20;

/**
 * 図に渡す CSS 変数（Turnlane の今の明暗の色と文字）。web が枠の中の :root に入れ、AI への指示（ツールの説明・スキル）が
 * 同じ名前を案内する。名前は変えない（AI が書いた図が読めなくなる）
 */
export const ASK_FIGURE_VARS = [
  "--tl-bg",
  "--tl-surface",
  "--tl-sunken",
  "--tl-border",
  "--tl-text",
  "--tl-text-2",
  "--tl-text-3",
  "--tl-accent",
  "--tl-warn",
  "--tl-bad",
  "--tl-font",
  "--tl-mono",
] as const;

type Parsed<T> = { ok: true; value: T } | { ok: false; field: string };

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** 前後の空白を除いた 1 行以上の文で、上限以下か */
function text(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s.length > 0 && s.length <= max ? s : null;
}

/** 図の中身（HTML / SVG の文字列）が上限以下か。UTF-8 のバイト数で数える */
export function figureBytes(html: string): number {
  return new TextEncoder().encode(html).length;
}

function figure(v: unknown): AskFigureInput | null {
  if (!isObj(v)) return null;
  if (typeof v.html === "string")
    return figureBytes(v.html) <= ASK_FILE_MAX ? { html: v.html } : { error: "too_large" };
  if (v.error === "too_large" || v.error === "unreadable") return { error: v.error };
  return null;
}

/**
 * POST /api/asks の本文を確かめる。上限を超えた文は切らずに断る（AI が書き直せるように、どの項目かを返す）。
 * 大きすぎる図は断らずに「読めない図」にする（案は選べる）
 */
export function parseAskInput(input: unknown): Parsed<AskCreateInput> {
  if (!isObj(input)) return { ok: false, field: "body" };
  const question = text(input.question, ASK_QUESTION_MAX);
  if (!question) return { ok: false, field: "question" };
  let context: string | undefined;
  if (input.context !== undefined && input.context !== null && input.context !== "") {
    const c = text(input.context, ASK_CONTEXT_MAX);
    if (!c) return { ok: false, field: "context" };
    context = c;
  }
  if (
    !Array.isArray(input.options) ||
    input.options.length < ASK_OPTIONS_MIN ||
    input.options.length > ASK_OPTIONS_MAX
  )
    return { ok: false, field: "options" };
  const options: AskCreateInput["options"] = [];
  const labels = new Set<string>();
  for (const [i, o] of input.options.entries()) {
    if (!isObj(o)) return { ok: false, field: `options[${i}]` };
    const label = text(o.label, ASK_LABEL_MAX);
    if (!label || labels.has(label)) return { ok: false, field: `options[${i}].label` };
    labels.add(label);
    const description = text(o.description, ASK_DESCRIPTION_MAX);
    if (!description) return { ok: false, field: `options[${i}].description` };
    if (o.recommended !== undefined && typeof o.recommended !== "boolean")
      return { ok: false, field: `options[${i}].recommended` };
    let fig: AskFigureInput | undefined;
    if (o.figure !== undefined) {
      const f = figure(o.figure);
      if (!f) return { ok: false, field: `options[${i}].figure` };
      fig = f;
    }
    options.push({
      label,
      description,
      ...(o.recommended === true ? { recommended: true } : {}),
      ...(fig ? { figure: fig } : {}),
    });
  }
  let explain: AskFigureInput | undefined;
  if (input.explain !== undefined) {
    const f = figure(input.explain);
    if (!f) return { ok: false, field: "explain" };
    explain = f;
  }
  const pid =
    typeof input.pid === "number" && Number.isInteger(input.pid) && input.pid > 1
      ? input.pid
      : undefined;
  const cwd =
    typeof input.cwd === "string" && input.cwd.startsWith("/") && input.cwd.length <= 4096
      ? input.cwd
      : undefined;
  const client =
    typeof input.client === "string" && /^[\w.@/-]{1,64}$/.test(input.client)
      ? input.client
      : undefined;
  return {
    ok: true,
    value: {
      question,
      ...(context ? { context } : {}),
      options,
      ...(explain ? { explain } : {}),
      ...(pid ? { pid } : {}),
      ...(cwd ? { cwd } : {}),
      ...(client ? { client } : {}),
    },
  };
}

/** POST /api/asks/:id/answer の本文。案は今の案の名前のどれか。案もメモも無ければ断る */
export function parseAskAnswer(
  input: unknown,
  labels: readonly string[],
): Parsed<{ choice?: string; note?: string }> {
  if (!isObj(input)) return { ok: false, field: "body" };
  const a = input as AskAnswerInput;
  let choice: string | undefined;
  if (a.choice !== undefined && a.choice !== null) {
    if (typeof a.choice !== "string" || !labels.includes(a.choice))
      return { ok: false, field: "choice" };
    choice = a.choice;
  }
  let note: string | undefined;
  if (a.note !== undefined && a.note !== null) {
    if (typeof a.note !== "string" || a.note.length > ASK_NOTE_MAX)
      return { ok: false, field: "note" };
    const n = a.note.trim();
    if (n) note = n;
  }
  if (!choice && !note) return { ok: false, field: "choice" };
  return { ok: true, value: { ...(choice ? { choice } : {}), ...(note ? { note } : {}) } };
}
