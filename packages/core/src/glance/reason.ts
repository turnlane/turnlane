/**
 * 自分の番の行の件名と理由の組み立て（D-207、spec-glance §2・§3・§4）。画面（行・メニューバー・ホバー・詳細）が同じ部品を
 * 使う。言葉（待ちの種類・「＋N 行」など）は画面の辞書で付けるので、ここは部品だけを返す。
 *
 * 表示の瞬間に読んだ中身（glance）はデーモンで伏せ字を通してあるが、ここでもう一度通す（伏せる前の文字列を画面に渡さない）。
 * 通知はここを使わない（glance を入れない。D-207 (4)）
 */
import type { GlanceResponse, GlanceUnavailable } from "../api/glance.ts";
import type { QueueItem } from "../api/queue.ts";
import type { ErrorKind } from "../api/work-items.ts";
import type { Locale } from "../i18n/task-title.ts";
import { followUpSubject, primaryFollowUp, type WhyKind, whyOf } from "../notify/plan.ts";
import { redact } from "./redact.ts";

export interface ReasonParts {
  why: WhyKind | null;
  /** 許可を求めているツール（MCP はサーバー名） */
  tool?: string;
  /** MCP のツール名 */
  sub?: string;
  /** Claude の短い説明（D-207 (2) で中身より先に出す） */
  label?: string;
  /** 中身（コマンド・パス・URL・検索語） */
  detail?: string;
  detailKind?: "command" | "path" | "url" | "query";
  moreLines?: number;
  isNew?: boolean;
  /** 詳細に出す全文 */
  full?: string;
  /** AI の問い（行の 1 文） */
  quote?: string;
  /** AI の問い（詳細の 2 文） */
  quoteDetail?: string;
  /** AskUserQuestion の選択肢（3 つまで） */
  options?: string[];
  moreOptions?: number;
  moreQuestions?: number;
  /** AskUserQuestion の全部の問い（詳細） */
  questions?: { question: string; options: string[] }[];
  /** PR の確認待ち・マージ待ちの PR 番号 */
  pr?: number | null;
  /** PR の確認待ち・マージ待ちの PR の題名（D-214 (1)。件名ではなく理由の行に「PR #190 題名」と出す） */
  prTitle?: string;
  /** 件名が PR の題名（fix-subject-pr）。理由の行は `PR #8 · 2 ファイル · +12 −8 · CI 通過`（番号が先、題名は出さない） */
  prFirst?: true;
  /** エラーの種類（hook の error_type。保存してある値） */
  error?: ErrorKind | null;
  /** 上限待ちが明けた（「利用枠が戻りました」） */
  limitBack?: true;
  masked: boolean;
  unavailable?: GlanceUnavailable;
  /** 待ちの種類の言葉のほかに出すものがある */
  hasContent: boolean;
}

const r = (s: string | undefined, onMask: () => void): string | undefined => {
  if (s === undefined) return undefined;
  const x = redact(s);
  if (x.masked) onMask();
  return x.text;
};

/** 猶予中の行の待ちの種類（問い = 返答待ち、AskUserQuestion = 回答待ち）。猶予中でなければ null */
function graceWhy(item: QueueItem): WhyKind | null {
  if (!item.grace || !item.wait) return null;
  if (item.wait.kind === "ask") return "answer";
  return item.wait.kind === "question" ? "reply" : null;
}

/** 行の理由の部品 */
export function reasonParts(
  item: QueueItem,
  glance: GlanceResponse | null | undefined,
): ReasonParts {
  const fu = primaryFollowUp(item);
  // 猶予中（D-245）は返答タスクが無いので、待ち（D-240 の wait）の種類から言葉を決める
  let why = whyOf(fu) ?? graceWhy(item);
  let masked = false;
  const mask = () => {
    masked = true;
  };
  const out: ReasonParts = { why, masked: false, hasContent: false };
  if (glance?.unavailable) out.unavailable = glance.unavailable;
  const g = glance ?? null;
  if (g?.kind === "permission" && g.permission && (why === "approve" || why === null)) {
    const p = g.permission;
    out.tool = p.tool;
    if (p.sub !== undefined) out.sub = p.sub;
    const label = r(p.label, mask);
    if (label) out.label = label;
    const detail = r(p.detail, mask);
    if (detail) out.detail = detail;
    if (p.detailKind) out.detailKind = p.detailKind;
    if (p.moreLines) out.moreLines = p.moreLines;
    if (p.isNew) out.isNew = true;
    const full = r(p.full, mask);
    if (full) out.full = full;
    if (p.masked) masked = true;
    out.hasContent = true;
  } else if (g?.kind === "ask" && g.ask && (why === "answer" || why === "reply")) {
    why = "answer";
    out.why = why;
    out.quote = r(g.ask.question, mask) ?? "";
    out.options = g.ask.options.map((o) => r(o, mask) ?? "");
    if (g.ask.more > 0) out.moreOptions = g.ask.more;
    if (g.ask.questions.length > 1) out.moreQuestions = g.ask.questions.length - 1;
    out.questions = g.ask.questions.map((q) => ({
      question: r(q.question, mask) ?? "",
      options: q.options.map((o) => r(o, mask) ?? ""),
    }));
    out.hasContent = out.quote.length > 0;
  } else if (g?.kind === "question" && g.question && why === "reply") {
    out.quote = r(g.question.row, mask) ?? "";
    out.quoteDetail = r(g.question.detail, mask) ?? "";
    if (g.question.masked) masked = true;
    out.hasContent = out.quote.length > 0;
  }
  if (why === "review_pr" || why === "merge_pr") {
    const spec = fu?.title;
    out.pr = spec?.t === "auto" ? spec.params.pr : null;
    const prTitle = spec?.t === "auto" ? spec.params.prTitle : null;
    if (prTitle) out.prTitle = prTitle;
    out.hasContent = out.pr !== null;
  }
  if (why === "resume_error" && g?.error) {
    out.error = g.error;
    out.hasContent = true;
  }
  if (why === "resume_limit") {
    out.limitBack = true;
    out.hasContent = true;
  }
  out.masked = masked;
  return out;
}

/**
 * 件名（spec-glance §2.2、D-214 (1)、fix-subject-pr）: 自分で付けた名前 → 直近の意味のある自分の指示の 1 行目（glance）→
 * 自動の題名（ai-title → PR の題名 → ブランチ → リポジトリ。デーモンが title に入れる。問い・許可の待ちの間は PR の題名を
 * 使わない）。session は件名と違うときの自動の題名（ホバーと詳細の「セッション:」）。fromPr は件名が PR の題名（理由の行は
 * PR の番号と量だけにして題名を繰り返さない）
 */
export function turnSubject(
  item: QueueItem,
  glance: GlanceResponse | null | undefined,
  locale: Locale,
): { subject: string; session: string | null; fromPr?: true } {
  const base = followUpSubject(item, locale);
  if (!item.userTitled && glance?.prompt?.text) {
    const subject = redact(glance.prompt.text).text;
    const auto = item.title;
    return { subject, session: auto && auto !== subject ? auto : null };
  }
  const auto = item.userTitled ? null : item.title;
  const fromPr = !item.userTitled && item.titleSource === "pr" && base === item.title;
  return {
    subject: base,
    session: auto && auto !== base ? auto : null,
    ...(fromPr ? { fromPr: true as const } : {}),
  };
}

/**
 * 件名が PR の題名のときの理由の部品（fix-subject-pr）: 題名を外して番号と量だけにする（prFirst で番号を量より先に出す）
 */
export function withSubject(parts: ReasonParts, s: { fromPr?: true }): ReasonParts {
  if (!s.fromPr || parts.pr === undefined || parts.pr === null) return parts;
  const { prTitle: _drop, ...rest } = parts;
  return { ...rest, prFirst: true };
}

/**
 * AI の項目（AI の線・AI の詳細パネルの見出し・今日閉じた一覧）の件名（spec-glance §2.2。D-214 (1)）: 自分で付けた名前
 * （titleSource が user）はそのまま。ほかは直近の意味のある指示（glance）→ 自動の題名
 */
export function aiItemSubject(
  item: { title: string | null; titleSource: string | null },
  glance: GlanceResponse | null | undefined,
): string | null {
  if (item.titleSource === "user") return item.title;
  const p = glance?.prompt?.text;
  return p ? redact(p).text : item.title;
}
