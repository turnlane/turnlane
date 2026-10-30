import type { SourceBadge } from "@turnlane/core/web";
import { repoName } from "@turnlane/core/web";

/**
 * AI の項目のリポジトリの欄の名前: リポジトリ名。壁打ち（プロジェクトに属さない会話。D-135）は label（「壁打ち」）。
 * 報告の項目（ADR 0021。リポジトリもブランチも無い）は `出どころ · プロジェクト`（プロジェクトが無ければ出どころ）。
 * git 管理外は null（欄を出さない）
 */
export function whereName(
  x: {
    repoRoot: string | null;
    scratch?: boolean | undefined;
    sources?: readonly Pick<SourceBadge, "tool" | "report" | "project">[] | undefined;
  },
  label: string,
): string | null {
  if (!x.repoRoot) {
    const r = x.sources?.find((s) => s.report);
    if (r) return r.project ? `${r.tool} · ${r.project}` : r.tool;
  }
  return x.scratch && !x.repoRoot ? label : repoName(x.repoRoot);
}
