/**
 * 自動生成タスクの題名（phase0-plan 3.3、D-046）。
 * 題名は文字列で保存せず、種類（task.title_key）とパラメータ（task.title_params。JSON）を保存し、表示時にここで組み立てる。
 * 英語が正（D-023）、日本語は同じキーの辞書。M2-12 の i18n 基盤（apps/web/src/i18n/）ができたら、
 * キーをそのまま使って辞書をそちらへ移す（このモジュールは置き換えられる前提の最小のフォーマッタ）。
 */
import type { FollowUpKind } from "../derive/types.ts";

export type Locale = "en" | "ja";

export const TASK_TITLE_KEYS = [
  "followup.reply",
  "followup.approve",
  "followup.review_pr",
  "followup.resume_error",
  "followup.check_changes",
  "followup.merge_pr",
] as const;
export type TaskTitleKey = (typeof TASK_TITLE_KEYS)[number];

/** title_params の中身（作成時点の値。無いものは null） */
export interface TaskTitleParams {
  /** カードのタイトル（ユーザーが付けた名前 → PR / AI のタイトル → ブランチ名の整形。タイトルを保存しない設定なら null） */
  title: string | null;
  /** リポジトリ名（repo_root の最後の要素） */
  repo: string | null;
  branch: string | null;
  pr: number | null;
  prTitle: string | null;
  /** 壁打ちのカード（D-135）。題名が無いときの名前を「壁打ち」にする。古い行には無い */
  scratch?: boolean;
}

type Messages = Record<TaskTitleKey, (p: TaskTitleParams, subject: string) => string> & {
  fallback: string;
  scratch: string;
};

const en: Messages = {
  "followup.reply": (_, s) => `Reply: ${s}`,
  "followup.approve": (_, s) => `Approve: ${s}`,
  "followup.review_pr": (p, s) => `Review PR #${p.pr ?? "?"}: ${p.prTitle ?? s}`,
  "followup.resume_error": (_, s) => `Resume: ${s}`,
  "followup.check_changes": (_, s) => `Check changes: ${s}`,
  "followup.merge_pr": (p, s) => `Merge PR #${p.pr ?? "?"}: ${p.prTitle ?? s}`,
  fallback: "AI work",
  scratch: "Scratch",
};

const ja: Messages = {
  "followup.reply": (_, s) => `返答: ${s}`,
  "followup.approve": (_, s) => `許可: ${s}`,
  "followup.review_pr": (p, s) => `PR #${p.pr ?? "?"} をレビュー: ${p.prTitle ?? s}`,
  "followup.resume_error": (_, s) => `再開: ${s}`,
  "followup.check_changes": (_, s) => `変更を確認: ${s}`,
  "followup.merge_pr": (p, s) => `PR #${p.pr ?? "?"} をマージ: ${p.prTitle ?? s}`,
  fallback: "AI の作業",
  scratch: "壁打ち",
};

const MESSAGES: Record<Locale, Messages> = { en, ja };

export function taskTitleKeyFor(kind: FollowUpKind): TaskTitleKey {
  return `followup.${kind}`;
}

function isKey(k: string): k is TaskTitleKey {
  return (TASK_TITLE_KEYS as readonly string[]).includes(k);
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** title_params の JSON を読む（壊れていれば空） */
export function parseTaskTitleParams(json: string | null): TaskTitleParams {
  let v: Record<string, unknown> = {};
  try {
    const x = json ? (JSON.parse(json) as unknown) : null;
    if (x && typeof x === "object" && !Array.isArray(x)) v = x as Record<string, unknown>;
  } catch {}
  return {
    title: str(v.title),
    repo: str(v.repo),
    branch: str(v.branch),
    pr: typeof v.pr === "number" && Number.isFinite(v.pr) ? v.pr : null,
    prTitle: str(v.prTitle),
    ...(v.scratch === true ? { scratch: true } : {}),
  };
}

/** 題名を組み立てる。{title} が無ければ {repo}#{branch}、それも無ければ「AI work」（壁打ちは「Scratch」。D-135） */
export function formatTaskTitle(
  key: string,
  params: TaskTitleParams,
  locale: Locale = "en",
): string {
  const m = MESSAGES[locale];
  const where = params.repo
    ? params.branch
      ? `${params.repo}#${params.branch}`
      : params.repo
    : params.branch;
  const subject = params.title ?? where ?? (params.scratch ? m.scratch : m.fallback);
  return isKey(key) ? m[key](params, subject) : subject;
}

/**
 * 件名（D-207 (5)）: 題名から「許可:」「返答:」などの前置きを外したもの。PR の確認待ち・マージ待ちでも PR の題名は件名に
 * しない（D-214 (1) で spec-glance §2.2 の 2 を改めた。PR の題名は理由の行）。自分の番の行・メニューバー・通知で使う。
 * タスクのカード・Inbox・CLI・MCP・記録は formatTaskTitle のまま
 */
export function formatTaskSubject(
  _key: string,
  params: TaskTitleParams,
  locale: Locale = "en",
): string {
  const m = MESSAGES[locale];
  const where = params.repo
    ? params.branch
      ? `${params.repo}#${params.branch}`
      : params.repo
    : params.branch;
  return params.title ?? where ?? (params.scratch ? m.scratch : m.fallback);
}

/** task の行の表示用の題名: title_key があれば組み立て、無ければ title（人が付けた題名）をそのまま */
export function taskDisplayTitle(
  row: { title: string; titleKey: string | null; titleParams: string | null },
  locale: Locale = "en",
): string {
  if (!row.titleKey) return row.title;
  return formatTaskTitle(row.titleKey, parseTaskTitleParams(row.titleParams), locale);
}
