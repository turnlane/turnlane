/**
 * enrich（phase0-plan 3.2 の「enrich」、M1-6）。アダプタが出したイベントにデーモン側の知識を足す。
 * - Codex など、ファイルからブランチが分からないツールのターンに `git rev-parse --abbrev-ref HEAD` を補う（推定）
 * - 除外ルール（ai_source.exclude_globs_json / include_globs_json）に当たる cwd のセッションのイベントを落とす
 * - セッションの repo_root（worktree は本体リポジトリに寄せる）
 * - Codex のプロジェクト外の作業フォルダ（`~/Documents/Codex/<日付>/<最初の依頼から作った名前>`）は、どのツールの
 *   イベントでも日付までに切り落とす（D-135。アダプタ・turnlane hook でも落としている。ここは最後の砦）
 * local_date はシンクが日付区切りで計算する。
 */
import {
  type NormalizedEvent,
  type SourceAdapter,
  trimCodexScratchCwd,
} from "@turnlane/collectors";
import type { GitProbe } from "./git.ts";

export interface SourceRules {
  include: string[];
  exclude: string[];
}

function globs(list: string[]): Bun.Glob[] {
  return list.map((g) => new Bun.Glob(g));
}

export function parseRules(includeJson: string, excludeJson: string): SourceRules {
  const parse = (s: string) => {
    try {
      const v = JSON.parse(s) as unknown;
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    } catch {
      return [];
    }
  };
  return { include: parse(includeJson), exclude: parse(excludeJson) };
}

/** glob の特殊文字を外す（ディレクトリのパスをそのまま glob にする） */
export function escapeGlob(path: string): string {
  return path.replace(/[\\*?[\]{}()!]/g, (c) => `\\${c}`);
}

/** ディレクトリとその下を当てる glob（日報の AI 要約の作業ディレクトリの除外。M4-6） */
export function dirExcludeGlobs(dir: string): string[] {
  const d = escapeGlob(dir.replace(/\/+$/, ""));
  return [d, `${d}/**`];
}

/** cwd が取り込み対象か（include が空なら全部、exclude に当たれば対象外） */
export function cwdAllowed(cwd: string | undefined, rules: SourceRules): boolean {
  if (!cwd) return true;
  const inc = globs(rules.include);
  const exc = globs(rules.exclude);
  const hit = (gs: Bun.Glob[]) => gs.some((g) => g.match(cwd) || g.match(`${cwd}/`));
  if (inc.length > 0 && !hit(inc)) return false;
  return !hit(exc);
}

const refKey = (r: { tool: string; externalId: string }) => `${r.tool}:${r.externalId}`;

export interface EnrichResult {
  events: NormalizedEvent[];
  /** セッション（tool:externalId）→ repo_root（解決できたものだけ） */
  repoRoots: Map<string, string | null>;
  dropped: number;
}

/** イベントの cwd を切り落とす（D-135） */
function trimCwd(e: NormalizedEvent, home: string | undefined): NormalizedEvent {
  if (!home || !("cwd" in e) || !e.cwd) return e;
  const cwd = trimCodexScratchCwd(e.cwd, home);
  return cwd === e.cwd ? e : { ...e, cwd };
}

export function enrich(
  events: NormalizedEvent[],
  adapter: SourceAdapter,
  rules: SourceRules,
  git: GitProbe,
  home?: string,
): EnrichResult {
  const excluded = new Set<string>();
  for (const e of events) {
    if ((e.kind === "turn" || e.kind === "session_seen") && !cwdAllowed(e.cwd, rules)) {
      excluded.add(refKey(e.ref));
    }
  }
  const repoRoots = new Map<string, string | null>();
  const out: NormalizedEvent[] = [];
  for (const raw of events) {
    if (raw.kind !== "hook" && raw.kind !== "claude_limits" && excluded.has(refKey(raw.ref)))
      continue;
    const e = trimCwd(raw, home);
    if (e.kind === "turn" && !e.gitBranch && e.cwd && !adapter.capabilities.gitBranch) {
      const b = git.currentBranch(e.cwd);
      out.push(b ? { ...e, gitBranch: b } : e);
      continue;
    }
    if (e.kind === "session_seen" && e.cwd) repoRoots.set(refKey(e.ref), git.repoRoot(e.cwd));
    out.push(e);
  }
  return { events: out, repoRoots, dropped: events.length - out.length };
}
