/**
 * Turnlane から答える（D-238、ADR 0019）の純粋な部分: 答えの文の整え方（改行・制御文字・長さ）、AI の問いの番号付きの
 * 選択肢、届け先の短い言葉と知らせの文。デーモン（answer/）と web が同じ関数を使う。
 */
import type { AnswerVia } from "./api/answer.ts";
import type { OpenLanding } from "./api/open.ts";
import type { Locale } from "./i18n/task-title.ts";
import { terminalAppName } from "./open.ts";

/** 答えの文の上限（送る前に切らずに 400 で断る） */
export const ANSWER_MAX = 4000;
/** 問いの全文の上限（GET /wait。超えたら切って truncated） */
export const WAIT_QUESTION_MAX = 2000;

// biome-ignore lint/suspicious/noControlCharactersInRegex: 端末に送る文から制御文字を除く
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/**
 * 答えの文を端末に送る形にする。CRLF を LF に、タブを空白に、制御文字（ESC など。端末の操作になる）を除く。
 * multiline が false なら行を空白でつないで 1 行に畳む（改行を Enter にしない。Enter は最後に 1 回だけ送る）。
 * 空なら null
 */
export function prepareAnswer(
  text: string,
  multiline: boolean,
): { text: string; folded: boolean } | null {
  const lines = text
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, " ")
    .replace(CONTROL, "")
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""));
  while (lines.length > 0 && lines[0]?.trim() === "") lines.shift();
  while (lines.length > 0 && lines.at(-1)?.trim() === "") lines.pop();
  if (lines.length === 0) return null;
  if (lines.length === 1) {
    const one = (lines[0] as string).trim();
    return one ? { text: one, folded: false } : null;
  }
  if (multiline) return { text: lines.join("\n"), folded: false };
  return {
    text: lines
      .map((l) => l.trim())
      .filter(Boolean)
      .join(" "),
    folded: true,
  };
}

const OPTION_LINE = /^\s*(?:[-*]\s+)?\*{0,2}(\d{1,2})[.)．）]\*{0,2}\s+(.+?)\s*$/;

/**
 * AI の問いの文の中の番号付きの選択肢（`1. A` `2) B`）。最後の連続した番号の並び（1 から始まり 1 ずつ増える、2〜9 個）
 * だけを選択肢とみなす。無ければ空
 */
export function numberedOptions(text: string): { n: number; label: string }[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let best: { n: number; label: string }[] = [];
  let run: { n: number; label: string }[] = [];
  const close = () => {
    if (run.length >= 2 && run.length <= 9) best = run;
    run = [];
  };
  for (const line of lines) {
    const m = OPTION_LINE.exec(line);
    if (!m) {
      // 選択肢の説明の行（字下げ）は並びを切らない
      if (run.length > 0 && /^\s{2,}\S/.test(line)) continue;
      if (line.trim() === "" && run.length > 0) continue;
      close();
      continue;
    }
    const n = Number(m[1]);
    if (n === run.length + 1) run.push({ n, label: (m[2] as string).replace(/\*\*/g, "").trim() });
    else {
      close();
      if (n === 1) run.push({ n, label: (m[2] as string).replace(/\*\*/g, "").trim() });
    }
  }
  close();
  return best.map((o) => ({
    n: o.n,
    label: o.label.length > 120 ? `${o.label.slice(0, 119)}…` : o.label,
  }));
}

/**
 * 届け先の短い言葉（送るボタンと行。`Orca · タブ` / `iTerm2 · タブ 3` / `Ghostty · main:1.0`）。
 * tmux のペインはペインの名前、タブの番号が分かればその番号、分からなければ「タブ」
 */
export function answerWhere(
  app: string,
  at: { pane?: string | null; tab?: number | null },
  locale: Locale,
): string {
  const name = terminalAppName(app, locale);
  if (at.pane) return `${name} · ${at.pane}`;
  const tab = locale === "ja" ? "タブ" : "tab";
  return at.tab != null ? `${name} · ${tab} ${at.tab}` : `${name} · ${tab}`;
}

/** 送った後の着地の言葉（タブを前に出した着地があればその番号を使う） */
export function answerLanding(
  app: string,
  via: AnswerVia,
  pane: string | null,
  focus: OpenLanding | null,
  locale: Locale,
): string {
  return answerWhere(
    app,
    { pane: via === "tmux" ? pane : null, tab: focus?.level === "tab" ? focus.tab : null },
    locale,
  );
}

/** 送った後の知らせの文 */
export function answerSentText(
  r: { confirmed: boolean; landing: string; folded?: boolean },
  locale: Locale,
): string {
  const ja = locale === "ja";
  if (!r.confirmed)
    return ja
      ? `送りましたが進んだか確認できません · ${r.landing}`
      : `Sent, but couldn't confirm it went through · ${r.landing}`;
  return ja ? `送りました · ${r.landing}` : `Sent · ${r.landing}`;
}
