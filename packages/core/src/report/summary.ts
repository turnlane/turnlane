/**
 * 日報の AI 要約（M4-6。D-041、ADR 0005 の追記）の純粋な部分: 子プロセスの stdin に渡す文の組み立て、
 * 出力の検証、日報の先頭に付ける Summary の節。
 *
 * 送るのは固定のプロンプトと日報の Markdown だけ。組み立て関数の入力は「日報の Markdown 文字列」と言語だけにして、
 * 会話本文などを渡せない形にしておく（ADR 0005 の追記）。
 */
import type { ReportLocale } from "../api/index.ts";

export type SummaryTool = "claude_code" | "codex";

export const SUMMARY_TOOLS: readonly SummaryTool[] = ["claude_code", "codex"];

/** 出力の上限（これを超えたら失敗。phase0-plan M4-6） */
export const SUMMARY_MAX_CHARS = 2000;
/** stdout を読む上限（これより後は読み捨てる） */
export const SUMMARY_STDOUT_LIMIT = 16 * 1024;

/** CLI のコマンド名（表示にも使う。`(summary by claude)`） */
export function summaryToolCommand(tool: SummaryTool): "claude" | "codex" {
  return tool === "claude_code" ? "claude" : "codex";
}

/** 固定のプロンプト（出力言語は UI の言語、日報に無いことを書かない、2〜3文、見出しを付けない） */
export function summaryPrompt(locale: ReportLocale): string {
  const lang = locale === "ja" ? "Japanese" : "English";
  return [
    "You are summarizing a personal daily work report.",
    `Write 2-3 sentences in ${lang} that say what this day was about: the main work, what moved forward, and what is still open.`,
    "Use only facts that appear in the report below. Do not invent tasks, numbers, names or reasons.",
    "Do not add a heading, a list, a preface or a closing remark. Output the sentences only.",
    "Do not use any tools.",
  ].join("\n");
}

/**
 * 子プロセスの stdin に渡す全文。入力は日報の Markdown と言語だけ（構造で ADR 0005 を守る）。
 * 日報は区切りの行で囲み、指示と混ざらないようにする
 */
export function buildSummaryInput(reportMarkdown: string, locale: ReportLocale): string {
  return `${summaryPrompt(locale)}\n\n<daily-report>\n${reportMarkdown.trim()}\n</daily-report>\n`;
}

export type SummaryOutputCheck =
  | { ok: true; text: string }
  | { ok: false; reason: "empty" | "too_long" };

/**
 * 出力の検証: 前後の空白を外し、空なら empty、2,000文字を超えたら too_long。先頭に付いた見出し（`## Summary` など）は外す
 */
export function checkSummaryOutput(raw: string): SummaryOutputCheck {
  let text = raw.replace(/\r\n/g, "\n").trim();
  text = text.replace(/^#{1,6}\s+[^\n]*\n+/, "").trim();
  if (!text) return { ok: false, reason: "empty" };
  if ([...text].length > SUMMARY_MAX_CHARS) return { ok: false, reason: "too_long" };
  return { ok: true, text };
}

const HEADING: Record<ReportLocale, string> = { en: "Summary", ja: "要約" };

export function summaryHeading(locale: ReportLocale): string {
  return HEADING[locale];
}

/** `(summary by claude)` / `（claude による要約）` */
export function summaryCredit(tool: SummaryTool | null, locale: ReportLocale): string | null {
  if (!tool) return null;
  const cmd = summaryToolCommand(tool);
  return locale === "ja" ? `（${cmd} による要約）` : `(summary by ${cmd})`;
}

/** 日報の先頭に付ける Summary の節（要約が無ければ空文字） */
export function renderSummarySection(
  summary: string | null | undefined,
  tool: SummaryTool | null,
  locale: ReportLocale,
): string {
  const s = summary?.trim();
  if (!s) return "";
  const credit = summaryCredit(tool, locale);
  return `## ${summaryHeading(locale)}\n${s}\n${credit ? `\n${credit}\n` : ""}\n`;
}

/** コピー・turnlane report・MCP 用: 日報の全文の先頭に Summary を付ける */
export function withSummary(
  reportMarkdown: string,
  summary: string | null | undefined,
  tool: SummaryTool | null,
  locale: ReportLocale,
): string {
  return `${renderSummarySection(summary, tool, locale)}${reportMarkdown}`;
}

/** 失敗の理由（メタデータ。stdout / stderr の中身は含めない） */
export type SummaryFailure =
  | { kind: "not_found" }
  | { kind: "timed_out" }
  | { kind: "exit"; code: number | null; signal?: string | null }
  | { kind: "empty" }
  | { kind: "too_long" }
  | { kind: "spawn_failed" };
