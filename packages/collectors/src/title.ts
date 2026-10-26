/**
 * ツールが生成した題名（Claude Code の `ai-title`・`summary`、Codex の `thread_name` など）の掃除（ai-session-ingestion 4.4）。
 * 取り込み時（保存する題名そのもの）とカードの題名の導出（保存済みの古い題名）の両方で同じ判定を通す。
 *
 * - タグをはがす: `<pasted_content …>…</pasted_content>` は中身ごと、ほかの `<…>` の形（閉じの無い
 *   `<pasted_content id="…">` を含む）はタグだけを取り除く
 * - 先頭の相づちと句読点をはがす（「OK。コミットしておいて」→「コミットしておいて」）
 * - 空同然（空白を除いて 3 文字以下・相づちだけ・句読点と記号だけ）なら null（カードは次の候補に落ちる）
 * - 改行・連続空白は 1 つの空白に。TITLE_MAX 文字で切る
 */

/** 題名の長さの上限（表示は幅で切る） */
export const TITLE_MAX = 80;

/** 相づち・短い定型（小文字）。題名がこれだけなら無い扱い、先頭にあればはがす */
export const TITLE_ACKS: readonly string[] = [
  "ok",
  "okay",
  "yes",
  "y",
  "sure",
  "thanks",
  "thank you",
  "lgtm",
  "continue",
  "go ahead",
  "proceed",
  "はい",
  "いいえ",
  "うん",
  "ええ",
  "了解",
  "了解です",
  "了解しました",
  "承知しました",
  "進めて",
  "進めてください",
  "続けて",
  "続けてください",
  "つづけて",
  "つづきやって",
  "続きやって",
  "お願いします",
  "お願い",
  "よろしく",
  "どうぞ",
  "同上",
  "ありがとう",
  "ありがとうございます",
];

/** 長いものから当てる（「了解しました」を「了解」より先に） */
const ACKS_BY_LENGTH = [...TITLE_ACKS].sort((a, b) => b.length - a.length);

const PASTED_BLOCK = /<pasted_content\b[^>]*>[\s\S]*?<\/pasted_content\s*>/gi;
const TAG = /<\/?[A-Za-z][\w:.-]*(?:\s[^<>]*)?\/?>/g;
/** 相づちの後の区切り（句読点と空白。`-`・`/` は語の一部なので入れない） */
const SEP = /^[\s。、，,.．!！?？…:：;；]+/u;
const ONLY_PUNCT = /^[\p{P}\p{S}\s]*$/u;
const isAscii = (s: string) => [...s].every((ch) => ch.charCodeAt(0) < 128);

/**
 * 先頭の相づちを 1 つはがした残り（当たらなければ null）。相づちの直後は終わりか区切りだけ
 * （`OKR`・`yarn`・「続けて実装」には当てない）。英語の相づちは空白だけの区切りなら後ろが日本語のときだけ
 * （「OK button」「Continue the refactor」は題名のまま、「OK コミットしておいて」ははがす）
 */
function stripLeadingAck(s: string): string | null {
  const lower = s.toLowerCase();
  for (const a of ACKS_BY_LENGTH) {
    if (!lower.startsWith(a)) continue;
    const rest = s.slice(a.length);
    if (rest.length === 0) return "";
    const sep = SEP.exec(rest)?.[0];
    if (!sep) continue;
    const after = rest.slice(sep.length);
    if (isAscii(a) && sep.trim() === "" && after.length > 0 && isAscii(after[0] ?? "")) continue;
    return after;
  }
  return null;
}

/** 貼り付けの塊（`<pasted_content …>…</pasted_content>`）を中身ごと改行に置き換える（指示の 1 行目を探す前に使う） */
export function stripPastedBlocks(s: string): string {
  return s.replace(PASTED_BLOCK, "\n");
}

/**
 * 題名として使える文字列か、無い扱い（null）か。戻り値はログに出さない。max は切る長さ（既定 TITLE_MAX。保存した自分の指示の
 * 1 行目は PROMPT_SUBJECT_MAX、保存済みの題名を直すときは切らない Infinity）
 */
export function cleanTitle(raw: unknown, max: number = TITLE_MAX): string | null {
  if (typeof raw !== "string") return null;
  let s = raw.replace(PASTED_BLOCK, " ").replace(TAG, " ").replace(/\s+/g, " ").trim();
  for (let i = 0; i < 4; i++) {
    const rest = stripLeadingAck(s);
    if (rest === null) break;
    s = rest.trim();
  }
  if (ONLY_PUNCT.test(s)) return null;
  const chars = [...s];
  if (chars.filter((ch) => !/\s/.test(ch)).length <= 3) return null;
  if (chars.length <= max) return s;
  const cut = chars.slice(0, max - 1).join("");
  return `${cut.trimEnd()}…`;
}

/**
 * 自分の指示の 1 行目（件名）の掃除: 空同然（cleanTitle が null。相づちだけ・タグだけ・記号だけ・3 文字以下）なら null、
 * それ以外はタグを除いて空白を 1 つにし、max 文字で切る。相づちで始まる文（「はい、その方針で進めて」）ははがさない
 * （指示は自分の書いた文なので、題名と違い文のまま出す。spec-glance §2.2）
 */
export function cleanSubjectLine(raw: unknown, max: number): string | null {
  if (cleanTitle(raw, Number.POSITIVE_INFINITY) === null) return null;
  const s = (raw as string)
    .replace(PASTED_BLOCK, " ")
    .replace(TAG, " ")
    .replace(/\s+/g, " ")
    .trim();
  const chars = [...s];
  if (chars.length <= max) return s;
  return `${chars
    .slice(0, max - 1)
    .join("")
    .trimEnd()}…`;
}
