/**
 * git の読み取り（enrich と derive runner が使う。phase0-plan 3.2・3.3・3.3.1）。
 * 読み取り系のコマンドだけを `--no-optional-locks` 付きで実行する（index.lock を取らない）。
 * 結果は cwd / repo ごとにキャッシュする。テストでは FakeGit に差し替える。
 */
import { existsSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";

export interface GitProbe {
  /** cwd → 本体リポジトリのルート（worktree は本体に寄せる）。git 管理外・cwd が無いなら null */
  repoRoot(cwd: string): string | null;
  /** cwd が今も存在するか（消えた cwd の repo を引き継ぐ判定に使う） */
  cwdExists(cwd: string): boolean;
  /** cwd の今のブランチ（Codex の補完。推定） */
  currentBranch(cwd: string): string | null;
  /** origin/HEAD が指すブランチ（無ければ null） */
  defaultBranch(repoRoot: string): string | null;
  /** 未コミットの変更があるか（短時間キャッシュ） */
  isDirty(repoRoot: string): boolean | null;
  /** branch に since より後（committer 時刻）のコミットがあれば、その最初の時刻 */
  firstCommitAfter(repoRoot: string, branch: string, since: number): number | null;
  /**
   * リモートの `owner/repo`（小文字。`git remote -v` の URL の末尾 2 要素）。PR の属するリポジトリをローカルのパスに
   * 結ぶ（PR のカードのリポジトリは PR の属するリポジトリ。fix-pr-card-repo）。リモートが無ければ空
   */
  remoteRepos(repoRoot: string): string[];
}

/** リモートの URL（https・ssh・scp 形式）→ `owner/repo`（小文字）。読めなければ null */
export function remoteSlug(url: string): string | null {
  const m = /[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}

const DEFAULT_BRANCHES = new Set(["main", "master", "develop"]);

/** 既定ブランチか（main / master / develop、origin/HEAD、HEAD・空） */
export function isDefaultBranch(git: GitProbe, repoRoot: string, branch: string | null): boolean {
  if (!branch || branch === "HEAD") return true;
  return DEFAULT_BRANCHES.has(branch) || branch === git.defaultBranch(repoRoot);
}

function run(args: string[], timeoutMs = 5000): string | null {
  try {
    const p = Bun.spawnSync(["git", "--no-optional-locks", ...args], {
      stdout: "pipe",
      stderr: "ignore",
      timeout: timeoutMs,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
    });
    return p.exitCode === 0 ? p.stdout.toString().trim() : null;
  } catch {
    return null;
  }
}

export class SystemGit implements GitProbe {
  readonly #repo = new Map<string, string | null>();
  readonly #default = new Map<string, string | null>();
  readonly #branch = new Map<string, { v: string | null; at: number }>();
  readonly #dirty = new Map<string, { v: boolean | null; at: number }>();
  readonly #commits = new Map<string, { v: number | null; at: number }>();
  readonly #remotes = new Map<string, { v: string[]; at: number }>();
  readonly #ttlMs: number;
  readonly #now: () => number;

  constructor(opts: { ttlMs?: number; now?: () => number } = {}) {
    this.#ttlMs = opts.ttlMs ?? 30_000;
    this.#now = opts.now ?? Date.now;
  }

  repoRoot(cwd: string): string | null {
    if (this.#repo.has(cwd)) return this.#repo.get(cwd) ?? null;
    let v: string | null = null;
    if (existsSync(cwd)) {
      const top = run(["-C", cwd, "rev-parse", "--show-toplevel"]);
      if (top) {
        const common = run(["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
        v = common?.endsWith("/.git") ? dirname(common) : top;
      }
      // 存在するディレクトリの結果だけをキャッシュする（後から git init されることがある）
      this.#repo.set(cwd, v);
    }
    return v;
  }

  cwdExists(cwd: string): boolean {
    return existsSync(cwd);
  }

  currentBranch(cwd: string): string | null {
    const hit = this.#branch.get(cwd);
    if (hit && this.#now() - hit.at < this.#ttlMs) return hit.v;
    const v = existsSync(cwd) ? run(["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"]) : null;
    this.#branch.set(cwd, { v, at: this.#now() });
    return v;
  }

  defaultBranch(repoRoot: string): string | null {
    // PR のリポジトリが手元に無いカードの repo_root は `owner/repo`（パスでない）。git を呼ばない
    if (!isAbsolute(repoRoot)) return null;
    if (this.#default.has(repoRoot)) return this.#default.get(repoRoot) ?? null;
    const r = run(["-C", repoRoot, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
    const v = r ? r.replace(/^origin\//, "") : null;
    this.#default.set(repoRoot, v);
    return v;
  }

  isDirty(repoRoot: string): boolean | null {
    const hit = this.#dirty.get(repoRoot);
    if (hit && this.#now() - hit.at < this.#ttlMs) return hit.v;
    const out =
      isAbsolute(repoRoot) && existsSync(repoRoot)
        ? run(["-C", repoRoot, "status", "--porcelain"])
        : null;
    const v = out === null ? null : out.length > 0;
    this.#dirty.set(repoRoot, { v, at: this.#now() });
    return v;
  }

  firstCommitAfter(repoRoot: string, branch: string, since: number): number | null {
    const key = `${repoRoot}\0${branch}\0${since}`;
    const hit = this.#commits.get(key);
    if (hit && this.#now() - hit.at < this.#ttlMs) return hit.v;
    const out =
      isAbsolute(repoRoot) && existsSync(repoRoot)
        ? run([
            "-C",
            repoRoot,
            "log",
            "--format=%ct",
            `--since=@${Math.floor(since / 1000)}`,
            "--end-of-options",
            branch,
          ])
        : null;
    let v: number | null = null;
    for (const line of out?.split("\n") ?? []) {
      const t = Number(line) * 1000;
      if (Number.isFinite(t) && t > since && (v === null || t < v)) v = t;
    }
    this.#commits.set(key, { v, at: this.#now() });
    return v;
  }

  remoteRepos(repoRoot: string): string[] {
    if (!isAbsolute(repoRoot)) return [];
    // リモートは後から足されることがあるので、ほかより長めの TTL（10 分）で読み直す
    const hit = this.#remotes.get(repoRoot);
    if (hit && this.#now() - hit.at < 20 * this.#ttlMs) return hit.v;
    const out = existsSync(repoRoot) ? run(["-C", repoRoot, "remote", "-v"]) : null;
    const v = [
      ...new Set(
        (out ?? "").split("\n").flatMap((line) => {
          const url = line.split(/\s+/)[1];
          const slug = url ? remoteSlug(url) : null;
          return slug ? [slug] : [];
        }),
      ),
    ];
    this.#remotes.set(repoRoot, { v, at: this.#now() });
    return v;
  }
}

/**
 * 壁打ちのフォルダ（D-135。core/scratch.ts）を git 管理外として扱う GitProbe。印のフォルダが git の中でもリポジトリに
 * しない（プロジェクトの一覧に出さず、既定ブランチの session カードにもしない）。壁打ちのフォルダは消えていても
 * 「今も在る」とみなす（消えた cwd の repo を引き継いでリポジトリのカードへ寄せない）
 */
export class ScratchAwareGit implements GitProbe {
  constructor(
    private readonly git: GitProbe,
    private readonly isScratch: (cwd: string) => boolean,
  ) {}

  repoRoot(cwd: string): string | null {
    return this.isScratch(cwd) ? null : this.git.repoRoot(cwd);
  }
  cwdExists(cwd: string): boolean {
    return this.isScratch(cwd) || this.git.cwdExists(cwd);
  }
  currentBranch(cwd: string): string | null {
    return this.isScratch(cwd) ? null : this.git.currentBranch(cwd);
  }
  defaultBranch(repoRoot: string): string | null {
    return this.git.defaultBranch(repoRoot);
  }
  isDirty(repoRoot: string): boolean | null {
    return this.git.isDirty(repoRoot);
  }
  firstCommitAfter(repoRoot: string, branch: string, since: number): number | null {
    return this.git.firstCommitAfter(repoRoot, branch, since);
  }
  remoteRepos(repoRoot: string): string[] {
    return this.git.remoteRepos(repoRoot);
  }
}

/** テスト用 */
export class FakeGit implements GitProbe {
  repos = new Map<string, string | null>();
  branches = new Map<string, string>();
  defaults = new Map<string, string>();
  dirty = new Map<string, boolean>();
  commits = new Map<string, number[]>();
  /** repo_root → リモートの `owner/repo` */
  remotes = new Map<string, string[]>();
  /** 消えた（今は存在しない）cwd */
  missing = new Set<string>();

  repoRoot(cwd: string): string | null {
    if (this.repos.has(cwd)) return this.repos.get(cwd) ?? null;
    for (const [k, v] of this.repos) if (cwd.startsWith(`${k}/`)) return v;
    return null;
  }
  cwdExists(cwd: string): boolean {
    return !this.missing.has(cwd);
  }
  currentBranch(cwd: string): string | null {
    return this.branches.get(cwd) ?? null;
  }
  defaultBranch(repoRoot: string): string | null {
    return this.defaults.get(repoRoot) ?? null;
  }
  isDirty(repoRoot: string): boolean | null {
    return this.dirty.get(repoRoot) ?? null;
  }
  firstCommitAfter(repoRoot: string, branch: string, since: number): number | null {
    const ts = (this.commits.get(`${repoRoot}#${branch}`) ?? []).filter((t) => t > since);
    return ts.length > 0 ? Math.min(...ts) : null;
  }
  remoteRepos(repoRoot: string): string[] {
    return this.remotes.get(repoRoot) ?? [];
  }
}
