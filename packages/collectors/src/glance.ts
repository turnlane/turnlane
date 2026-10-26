/**
 * 表示の瞬間に読む（glance。D-207、ADR 0005 の追記 2）: 待っている件の中身（許可を求めているツールの引数、AI の問い、
 * 直近の人の指示）を、取り込みのパーサが carry に覚えた行の位置から 1 行だけ読む。
 *
 * - ここの関数は本文を返す。呼び出し元（デーモンの glance）は戻り値を DB・ログ・SSE・MCP・通知・エクスポートに渡さない
 * - 読むのは 1 行（上限 MAX_LINE_BYTES）。位置が古い（ファイルが書き換わった）ときは末尾の TAIL_BYTES だけを逆に見る
 * - JSON のパースの失敗の理由（エラー文はトークンの一部を含む）は返さない。理由はコードだけ
 * - ファイルの読み取りは io（withRootJail が差し替える）を通す。認証ファイルの名前は開かない
 */
import { io, isForbiddenFile } from "./io.ts";
import { promptText } from "./prompt-traits.ts";

/** 1 行の上限。超えたら読まない（大きな tool_result・画像の行） */
export const MAX_LINE_BYTES = 1024 * 1024;
/** 位置が使えないときに末尾から見る長さ */
export const TAIL_BYTES = 1024 * 1024;

export type GlanceReadFail = "missing" | "too_long" | "unreadable";

type Rec = Record<string, unknown>;

/** Claude Code の carry（transcript.ts の ClaudeCarry）から glance の位置だけを取り出す */
export interface ClaudeGlanceHints {
  /** 位置が属するターン（ai_turn.turn_key と比べる） */
  turnKey: string | null;
  textAt: number | null;
  /** 結果の無い tool_use（新しいものが後ろ） */
  pend: { id: string; name: string; at: number }[];
  promptAt: number | null;
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;

export function claudeGlanceHints(carry: unknown): ClaudeGlanceHints | null {
  if (!carry || typeof carry !== "object") return null;
  const c = carry as Rec;
  if (c.v !== 1) return null;
  const t = (c.turn ?? null) as Rec | null;
  const pend = Array.isArray(t?.pend)
    ? (t.pend as unknown[]).flatMap((x) =>
        Array.isArray(x) &&
        typeof x[0] === "string" &&
        typeof x[1] === "string" &&
        num(x[2]) !== null
          ? [{ id: x[0], name: x[1], at: x[2] as number }]
          : [],
      )
    : [];
  return {
    turnKey: typeof t?.key === "string" ? t.key : null,
    textAt: num(t?.textAt),
    pend,
    promptAt: num(c.promptAt),
  };
}

/** offset から 1 行を読んで JSON にする */
export function readJsonLineAt(
  path: string,
  offset: number,
  maxBytes: number = MAX_LINE_BYTES,
): { ok: true; value: unknown } | { ok: false; reason: GlanceReadFail } {
  if (isForbiddenFile(path)) return { ok: false, reason: "unreadable" };
  const st = io.stat(path);
  if (!st?.isFile()) return { ok: false, reason: "missing" };
  if (offset >= st.size) return { ok: false, reason: "unreadable" };
  let buf: Buffer;
  try {
    buf = io.readRange(path, offset, Math.min(maxBytes + 1, st.size - offset));
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  const nl = buf.indexOf(0x0a);
  if (nl < 0 && buf.length > maxBytes) return { ok: false, reason: "too_long" };
  const end = nl < 0 ? buf.length : nl;
  try {
    return { ok: true, value: JSON.parse(buf.toString("utf8", 0, end)) as unknown };
  } catch {
    return { ok: false, reason: "unreadable" };
  }
}

/** 末尾の TAIL_BYTES の完全な行を、新しい順に（位置が使えないときのフォールバック） */
export function readTailRecords(
  path: string,
  bytes: number = TAIL_BYTES,
): { ok: true; records: unknown[] } | { ok: false; reason: GlanceReadFail } {
  if (isForbiddenFile(path)) return { ok: false, reason: "unreadable" };
  const st = io.stat(path);
  if (!st?.isFile()) return { ok: false, reason: "missing" };
  const start = Math.max(0, st.size - bytes);
  let buf: Buffer;
  try {
    buf = io.readRange(path, start, st.size - start);
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  const lines = buf.toString("utf8").split("\n");
  // 途中から読んだなら最初の行は欠けている
  if (start > 0) lines.shift();
  const records: unknown[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = (lines[i] ?? "").trim();
    if (!l) continue;
    try {
      records.push(JSON.parse(l));
    } catch {}
  }
  return { ok: true, records };
}

function content(rec: unknown): unknown[] {
  const c = ((rec as Rec | null)?.message as Rec | undefined)?.content;
  return Array.isArray(c) ? c : [];
}

/** assistant レコードの中の tool_use（id が合うもの。id を省くと最後のもの） */
export function claudeToolUse(
  rec: unknown,
  id?: string,
): { id: string; name: string; input: Rec } | null {
  if ((rec as Rec | null)?.type !== "assistant") return null;
  let found: { id: string; name: string; input: Rec } | null = null;
  for (const it of content(rec)) {
    const x = (it ?? {}) as Rec;
    if (x.type !== "tool_use" || typeof x.name !== "string") continue;
    if (id !== undefined && x.id !== id) continue;
    found = {
      id: typeof x.id === "string" ? x.id : "",
      name: x.name,
      input: x.input && typeof x.input === "object" ? (x.input as Rec) : {},
    };
  }
  return found;
}

/** assistant レコードの最後のテキスト */
export function claudeLastText(rec: unknown): string | null {
  if ((rec as Rec | null)?.type !== "assistant") return null;
  let last: string | null = null;
  for (const it of content(rec)) {
    const x = (it ?? {}) as Rec;
    if (x.type === "text" && typeof x.text === "string" && x.text.trim()) last = x.text;
  }
  return last;
}

/** 人の指示の user レコードの本文（origin.kind が human で isMeta でないもの） */
export function claudeUserText(rec: unknown): string | null {
  const r = (rec ?? {}) as Rec;
  if (r.type !== "user" || r.isMeta === true) return null;
  if ((r.origin as Rec | undefined)?.kind !== "human") return null;
  return promptText((r.message as Rec | undefined)?.content) ?? null;
}

/** 結果の届いた tool_use の ID（user レコードの tool_result） */
export function claudeToolResultIds(rec: unknown): string[] {
  if ((rec as Rec | null)?.type !== "user") return [];
  return content(rec).flatMap((it) => {
    const id = (it as Rec | null)?.tool_use_id;
    return typeof id === "string" ? [id] : [];
  });
}

/**
 * セッションのトランスクリプトの実際の場所。DB の file_path は Codex の作業フォルダの名前を切り落としてある（D-136）ので、
 * そのパスに無ければルートの projects/ の下をセッション ID で探す
 */
export function findClaudeTranscript(
  rootPath: string,
  filePath: string | null,
  sessionId: string,
): string | null {
  const root = rootPath.replace(/\/+$/, "");
  if (filePath?.startsWith(`${root}/projects/`) && io.stat(filePath)?.isFile()) return filePath;
  if (!/^[A-Za-z0-9-]{1,64}$/.test(sessionId)) return null;
  for (const d of io.readdir(`${root}/projects`)) {
    if (!d.isDirectory()) continue;
    const p = `${root}/projects/${d.name}/${sessionId}.jsonl`;
    if (io.stat(p)?.isFile()) return p;
  }
  return null;
}
