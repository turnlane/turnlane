/**
 * プロジェクトとリポジトリの対応（設定画面。M2-9、m2-api.md 19章）。書き込みは mutate() 経由（project は同期対象）。
 */
import type { Database } from "bun:sqlite";
import { insertRow, type MutateCtx, parseRepoPaths, schema, updateRow } from "@turnlane/core";
import type { ProjectReposResponse, ProjectView } from "@turnlane/core/api";
import { OpError } from "../derive/ops.ts";

interface Row {
  id: string;
  name: string;
  color: string | null;
  repo_paths_json: string;
  archived_at: number | null;
  worktree_default: number | null;
  worktree_copy_globs_json: string;
  test_command: string | null;
}

function globs(json: string): string[] {
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

const view = (r: Row): ProjectView => ({
  id: r.id,
  name: r.name,
  color: r.color,
  repoPaths: parseRepoPaths(r.repo_paths_json),
  archivedAt: r.archived_at,
  worktreeDefault: r.worktree_default === null ? null : r.worktree_default === 1,
  worktreeCopyGlobs: globs(r.worktree_copy_globs_json),
  testCommand: r.test_command,
});

/** 末尾の / を外し、重なりを除く */
function cleanPaths(xs: readonly string[]): string[] {
  return [...new Set(xs.map((x) => x.trim().replace(/\/+$/, "")).filter((x) => x.startsWith("/")))];
}

export class ProjectService {
  constructor(
    private readonly sqlite: Database,
    private readonly mutate: MutateCtx,
    private readonly onChanged: () => void,
  ) {}

  #row(id: string): Row {
    const r = this.sqlite
      .query<Row, [string]>(
        "SELECT id, name, color, repo_paths_json, archived_at, worktree_default, worktree_copy_globs_json, test_command FROM project WHERE id = ? AND deleted_at IS NULL",
      )
      .get(id);
    if (!r) throw new OpError(404, "not_found");
    return r;
  }

  #nameTaken(name: string, except: string | null): boolean {
    return (
      this.sqlite
        .query<{ id: string }, [string]>(
          "SELECT id FROM project WHERE name = ? AND deleted_at IS NULL",
        )
        .all(name)
        .filter((r) => r.id !== except).length > 0
    );
  }

  list(all: boolean): ProjectView[] {
    return this.sqlite
      .query<Row, []>(
        `SELECT id, name, color, repo_paths_json, archived_at, worktree_default, worktree_copy_globs_json, test_command FROM project
          WHERE deleted_at IS NULL ${all ? "" : "AND archived_at IS NULL"} ORDER BY name`,
      )
      .all()
      .map(view);
  }

  create(p: {
    name: string;
    color?: string | null | undefined;
    repoPaths?: string[] | undefined;
  }): ProjectView {
    const name = p.name.trim();
    if (this.#nameTaken(name, null)) throw new OpError(409, "name_taken");
    const r = insertRow(this.mutate, schema.project, {
      name,
      color: p.color ?? null,
      repoPathsJson: JSON.stringify(cleanPaths(p.repoPaths ?? [])),
    });
    this.onChanged();
    return view(this.#row(r.id));
  }

  patch(
    id: string,
    p: {
      name?: string | undefined;
      color?: string | null | undefined;
      repoPaths?: string[] | undefined;
      archived?: boolean | undefined;
      worktreeDefault?: boolean | null | undefined;
      worktreeCopyGlobs?: string[] | undefined;
      testCommand?: string | null | undefined;
    },
  ): ProjectView {
    const cur = this.#row(id);
    const name = p.name?.trim();
    if (name !== undefined && name !== cur.name && this.#nameTaken(name, id))
      throw new OpError(409, "name_taken");
    updateRow(this.mutate, schema.project, id, {
      ...(name !== undefined ? { name } : {}),
      ...(p.color !== undefined ? { color: p.color } : {}),
      ...(p.repoPaths !== undefined
        ? { repoPathsJson: JSON.stringify(cleanPaths(p.repoPaths)) }
        : {}),
      ...(p.archived !== undefined
        ? { archivedAt: p.archived ? (cur.archived_at ?? this.mutate.clock.now()) : null }
        : {}),
      ...(p.worktreeDefault !== undefined
        ? { worktreeDefault: p.worktreeDefault === null ? null : p.worktreeDefault ? 1 : 0 }
        : {}),
      ...(p.worktreeCopyGlobs !== undefined
        ? { worktreeCopyGlobsJson: JSON.stringify([...new Set(p.worktreeCopyGlobs)]) }
        : {}),
      ...(p.testCommand !== undefined ? { testCommand: p.testCommand || null } : {}),
    });
    this.onChanged();
    return view(this.#row(id));
  }

  /** 対応付けの候補: AI 項目のリポジトリ（最後に動いた順） */
  repos(): ProjectReposResponse {
    return {
      repos: this.sqlite
        .query<{ path: string; at: number }, []>(
          `SELECT repo_root AS path, MAX(last_activity_at) AS at FROM work_item
            WHERE repo_root LIKE '/%' AND deleted_at IS NULL GROUP BY repo_root ORDER BY at DESC LIMIT 100`,
        )
        .all()
        .map((r) => ({ path: r.path, lastActivityAt: r.at })),
    };
  }
}
