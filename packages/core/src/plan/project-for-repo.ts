/**
 * プロジェクトとリポジトリの対応（`project.repo_paths_json`。m2-api.md 19章）。repo_root に最も長く前方一致する
 * パスを持つプロジェクトを返す。前方一致はパスの区切りで見る（`/w/app` は `/w/app2` に当てない）。
 */
export interface ProjectRepoRule {
  id: string;
  repoPaths: readonly string[];
}

function under(repo: string, path: string): boolean {
  const p = path.replace(/\/+$/, "");
  if (!p) return false;
  return repo === p || repo.startsWith(`${p}/`);
}

export function projectForRepo(
  repoRoot: string | null | undefined,
  projects: readonly ProjectRepoRule[],
): string | null {
  if (!repoRoot) return null;
  let best: { id: string; len: number } | null = null;
  for (const pr of projects) {
    for (const path of pr.repoPaths) {
      if (!under(repoRoot, path)) continue;
      const len = path.replace(/\/+$/, "").length;
      if (!best || len > best.len) best = { id: pr.id, len };
    }
  }
  return best?.id ?? null;
}

/** repo_paths_json を読む（壊れた値は空） */
export function parseRepoPaths(json: string | null | undefined): string[] {
  try {
    const v = JSON.parse(json ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x !== "") : [];
  } catch {
    return [];
  }
}
