/**
 * リポジトリ → プロジェクト（m2-api.md 19章）。新しく作る自分の番のタスクと、AI カードからの確認タスクに付ける。
 */
import type { Database } from "bun:sqlite";
import { insertRow, type MutateCtx, parseRepoPaths, projectForRepo, schema } from "@turnlane/core";

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

/**
 * 名前 → プロジェクト（報告のプロジェクト。ADR 0021）。同じ名前（大文字小文字を区別しない）の生きているプロジェクトがあれば
 * それ、無ければ作る（turnlane add の #project と同じ）
 */
export function projectIdByName(db: Database, mutate: MutateCtx, name: string): string {
  const r = db
    .query<{ id: string }, [string]>(
      "SELECT id FROM project WHERE deleted_at IS NULL AND lower(name) = lower(?) ORDER BY archived_at IS NOT NULL, created_at LIMIT 1",
    )
    .get(name);
  if (r) return r.id;
  return insertRow(mutate, schema.project, { name }).id;
}
