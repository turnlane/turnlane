/**
 * 人の指示（Claude Code の user レコードの本文）が「件名に使える指示か」の判定（D-207 (3)、spec-glance §2.2）。
 * 取り込みのパーサはその場で真偽値だけを残し（本文は捨てる）、表示の瞬間に glance が同じ規則で 1 行目を取り出す。
 *
 * 飛ばすもの:
 * - 短い返事: 空白を除いて 8 文字以下（日本語）/ 3 語以下（英語）で、相づちの語（はい・OK・続けて・continue など）で
 *   始まるもの、数字だけ（選択肢の番号）
 * - スラッシュコマンドだけの指示（`/compact` など。後ろに文があればその文を使う）。`<command-name>` の形は
 *   `<command-args>` に文があればそれを使う
 * - ツールや hooks が差し込んだタグの形（`<local-command-stdout>` など。`<` で始まるもの）
 *
 * 1 行目: 最初の空でない行。行頭の `#`・`-`・`*`・`>`・番号付きの印を外す。コードの囲み・URL だけ・パスだけの行は飛ばす。
 * 改行・連続空白は 1 つの空白にし、120 文字で切る。
 */

import { cleanSubjectLine, stripPastedBlocks } from "./title.ts";

/** 件名の長さの上限（表示は幅で切る） */
export const PROMPT_SUBJECT_MAX = 120;

/** 相づちの語（小文字。先頭に当たれば短い返事） */
const ACK = [
  "はい",
  "いいえ",
  "うん",
  "ok",
  "okay",
  "yes",
  "no",
  "y",
  "n",
  "続けて",
  "進めて",
  "お願いします",
  "お願い",
  "どうぞ",
  "よろしく",
  "了解",
  "continue",
  "go",
  "go ahead",
  "proceed",
  "sure",
  "thanks",
  "lgtm",
];

const URL_ONLY = /^(<)?https?:\/\/\S+(>)?$/i;
const PATH_ONLY = /^(~|\.{1,2})?\/?[\w.@~-]+(\/[\w.@~-]+)+\/?$/;
const MARKER = /^\s*([#>*+-]+|\d+[.)])\s+/;

/** user レコードの message.content（文字列か、text のブロックの配列）から本文を取り出す */
export function promptText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const c of content) {
    if (c && typeof c === "object" && (c as Record<string, unknown>).type === "text") {
      const t = (c as Record<string, unknown>).text;
      if (typeof t === "string") parts.push(t);
    }
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

const isAscii = (s: string) => [...s].every((ch) => ch.charCodeAt(0) < 128);

function isShortReply(text: string): boolean {
  const compact = text.replace(/\s+/g, "");
  if (/^[0-9０-９]+[.)]?$/.test(compact)) return true;
  const lower = text
    .trim()
    .toLowerCase()
    .replace(/[。.!！?？、,]+$/g, "");
  const words = lower.split(/\s+/).filter(Boolean);
  const short = isAscii(lower) ? words.length <= 3 : compact.length <= 8;
  if (!short) return false;
  // 英語の語は語の切れ目まで（`y` が `yarn build` に当たらないように）、日本語の語は前方一致（「はい、お願いします」）
  return ACK.some((a) =>
    isAscii(a)
      ? lower === a || new RegExp(`^${a.replace(/ /g, "\\s+")}(?![a-z0-9])`).test(lower)
      : lower.startsWith(a),
  );
}

function firstLine(text: string): string | null {
  let fence = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^(```|~~~)/.test(line)) {
      fence = !fence;
      continue;
    }
    if (fence || line.length === 0) continue;
    const s = line.replace(MARKER, "").replace(/\s+/g, " ").trim();
    if (s.length === 0 || URL_ONLY.test(s) || PATH_ONLY.test(s)) continue;
    // 相づちだけ・タグだけ・記号だけの行は飛ばす（題名の掃除と同じ規則。ai-session-ingestion 4.4）
    const c = cleanSubjectLine(s, PROMPT_SUBJECT_MAX);
    if (c === null) continue;
    return c;
  }
  return null;
}

/**
 * 件名に使える指示なら 1 行目（120 文字まで）、使えなければ null。戻り値はログに出さない。保存するのは ADR 0018 の範囲だけ
 * （設定 turn.store_detail がオンのとき、デーモンのシンクが伏せ字を通してから ai_instruction に持つ）
 */
export function promptSubject(text: unknown): string | null {
  if (typeof text !== "string") return null;
  let s = text.trim();
  if (s.length === 0) return null;
  if (s.startsWith("<command-name>")) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(s)?.[1]?.trim() ?? "";
    return args ? promptSubject(args) : null;
  }
  if (s.startsWith("<")) return null;
  const slash = /^\/[\w:-]+(?:\s+|$)/.exec(s);
  if (slash) {
    s = s.slice(slash[0].length).trim();
    if (s.length === 0) return null;
  }
  if (isShortReply(s)) return null;
  // 貼り付けの塊は中身ごと除く（貼り付けた本文を件名にしない）
  return firstLine(stripPastedBlocks(s));
}

/** パーサ用: 件名に使える指示か（本文は返さない） */
export function promptTraits(text: unknown): { usable: boolean } {
  return { usable: promptSubject(text) !== null };
}
