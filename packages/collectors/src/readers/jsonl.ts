/**
 * JSONL の増分読み込み（phase0-plan 3.2、ai-session-ingestion 3.5）。アダプタはファイルを直接読まず、これを使う。
 *
 * - 完全な行（`\n` まで）だけを返す。末尾の不完全な行はカーソルを進めない
 * - 同じストリームで (dev, inode) が変わった / サイズが byte_offset より小さくなった → 先頭から読み直す（reset）
 * - 1回で読むのは maxBytes まで。1行が maxBytes より長ければ、その行が終わるまで読む
 * - 壊れた行は value: undefined で返す（呼び出し側が records_skipped に数える）
 */
import { io } from "../io.ts";
import type { Cursor } from "../types.ts";

export interface JsonlLine {
  /** 行頭のバイト位置 */
  offset: number;
  /** パースした値。壊れていれば undefined */
  value: unknown;
}

export interface JsonlChunk {
  lines: JsonlLine[];
  /** 次のカーソル（carry と parserVersion は呼び出し側が入れる） */
  next: Required<Pick<Cursor, "byteOffset" | "dev" | "inode" | "size" | "mtimeMs">>;
  /** 先頭から読み直した（呼び出し側は carry を捨てる） */
  reset: boolean;
  done: boolean;
}

const NL = 0x0a;

export function readJsonlIncremental(
  path: string,
  cursor: Cursor | null,
  opts: { maxBytes: number },
): JsonlChunk | null {
  const st = io.stat(path);
  if (!st?.isFile()) return null;
  const size = st.size;
  let start = cursor?.byteOffset ?? 0;
  let reset = false;
  if (
    cursor &&
    ((cursor.inode !== undefined && cursor.inode !== st.ino) ||
      (cursor.dev !== undefined && cursor.dev !== st.dev) ||
      size < cursor.byteOffset)
  ) {
    start = 0;
    reset = true;
  }
  const base = { dev: st.dev, inode: st.ino, size, mtimeMs: Math.floor(st.mtimeMs) };
  if (start >= size) {
    return { lines: [], next: { ...base, byteOffset: start }, reset, done: true };
  }

  // 改行が見つかるまで読む範囲を広げる（1行が maxBytes を超える場合）
  let want = Math.min(opts.maxBytes, size - start);
  let buf = io.readRange(path, start, want);
  let lastNl = buf.lastIndexOf(NL);
  while (lastNl < 0 && start + want < size) {
    want = Math.min(want * 2, size - start);
    buf = io.readRange(path, start, want);
    lastNl = buf.lastIndexOf(NL);
  }
  if (lastNl < 0) {
    // 末尾の不完全な行だけ。改行が来るまで進めない
    return { lines: [], next: { ...base, byteOffset: start }, reset, done: true };
  }

  const lines: JsonlLine[] = [];
  let pos = 0;
  while (pos <= lastNl) {
    const nl = buf.indexOf(NL, pos);
    const end = nl < 0 ? lastNl : nl;
    if (end > pos) {
      const text = buf.toString("utf8", pos, end).trim();
      if (text) {
        let value: unknown;
        try {
          value = JSON.parse(text);
        } catch {
          value = undefined;
        }
        lines.push({ offset: start + pos, value });
      }
    }
    pos = end + 1;
  }
  const byteOffset = start + lastNl + 1;
  // ファイルの終わりまで読んだなら、残りは不完全な行だけ（改行が来るまで待つ）
  return { lines, next: { ...base, byteOffset }, reset, done: start + buf.length >= size };
}
