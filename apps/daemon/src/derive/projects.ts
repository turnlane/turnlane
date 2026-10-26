/**
 * リポジトリ → プロジェクト（m2-api.md 19章）。新しく作る自分の番のタスクと、AI カードからの確認タスクに付ける。
 */
import type { Database } from "bun:sqlite";
import { parseRepoPaths, projectForRepo } from "@turnlane/core";

export function projectIdForRepo(db: Database, repoRoot: string | null | undefined): string | null {
  if (!repoRoot) return null;
  const rows = db
    .query<{ id: string; repo_paths_json: string }, []>(
      "SELECT id, repo_paths_json FROM project WHERE deleted_at IS NULL AND archived_at IS NULL AND repo_paths_json <> '[]'",
    )
    .all();
  return projectForRepo(
    repoRoot,
    rows.map((r) => ({ id: r.id, repoPaths: parseRepoPaths(r.repo_paths_json) })),
  );
}
