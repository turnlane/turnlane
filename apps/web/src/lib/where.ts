import { repoName } from "@turnlane/core/web";

/**
 * AI の項目のリポジトリの欄の名前: リポジトリ名。壁打ち（プロジェクトに属さない会話。D-135）は label（「壁打ち」）。
 * git 管理外は null（欄を出さない）
 */
export function whereName(
  x: { repoRoot: string | null; scratch?: boolean | undefined },
  label: string,
): string | null {
  return x.scratch && !x.repoRoot ? label : repoName(x.repoRoot);
}
