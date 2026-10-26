/**
 * AI に頼む（D-107）が OS に触れるところ: git（worktree の作成・片付けと差分の読み取り）、入っている CLI の検出、
 * テストのコマンドの実行、gh の PR の CI。テストと dev:board は偽物に差し替える。端末を開くのは open/system.ts の OpenSystem。
 * コマンドは引数の配列で起動する（テストのコマンドだけは利用者が設定した文字列をログインシェルで実行する）
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type { GitRoots } from "@turnlane/core";
import type { AiLaunchTool } from "@turnlane/core/api";
import { type DetectOptions, findCli } from "../summary/cli.ts";

export interface GitResult {
  ok: boolean;
  out: string;
}

export interface LaunchGit {
  /** `git -C <cwd> <args>`。終了コード 0 なら ok */
  run(cwd: string, args: readonly string[], timeoutMs?: number): Promise<GitResult>;
}

export interface TestRun {
  exitCode: number | null;
  timedOut: boolean;
  /** 最後の50行 */
  tail: string[];
}

export interface LaunchGhCheck {
  url: string | null;
  additions: number | null;
  deletions: number | null;
  files: number | null;
  rollup: unknown;
}

export interface LaunchSystem {
  git: LaunchGit;
  /** 入っている CLI（Claude Code / Codex） */
  tools(): Promise<AiLaunchTool[]>;
  /** テストのコマンド（利用者の設定）を cwd で実行する。上限を過ぎたら止める */
  runTest(command: string, cwd: string, timeoutMs: number): Promise<TestRun>;
  /** PR の CI と変更の量（gh。使えなければ null） */
  prCheck(repo: string, number: number): Promise<LaunchGhCheck | null>;
  exists(path: string): boolean;
  /** 追跡外のファイルを worktree にコピーする（相対パス） */
  copyFile(from: string, to: string): boolean;
  /** glob に合うファイル（repo からの相対パス。追跡外のもの） */
  glob(cwd: string, pattern: string): string[];
  /**
   * 画面がロックされているか（人のいないときの起動の前に見る）。ログインウインドウのセッションの
   * CGSSessionScreenIsLocked（ioreg。root 不要）。読めなければ false（試してみて、開けなければ呼び出し側に返す）
   */
  screenLocked(): Promise<boolean>;
  /**
   * Claude Code の設定のファイル（JSON）の `projects[<キー>].hasTrustDialogAccepted` だけを読む（キーごとに true か）。
   * ほかの値は返さない・持たない。読めなければ null
   */
  trustFlags(configFile: string, keys: readonly string[]): Record<string, boolean> | null;
  /** フォルダの git の位置（`.git` を上へ探す。worktree は `.git` のファイルから元のリポジトリ）。シンボリックリンクは解く */
  gitRoots(path: string): GitRoots & { real: string };
}

const TAIL = 50;

async function spawnText(
  argv: string[],
  o: { cwd?: string; timeoutMs: number; env?: Record<string, string | undefined> },
): Promise<{ code: number | null; out: string; err: string; timedOut: boolean }> {
  let p: ReturnType<typeof Bun.spawn>;
  try {
    p = Bun.spawn(argv, {
      ...(o.cwd ? { cwd: o.cwd } : {}),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: o.env ?? process.env,
    });
  } catch {
    return { code: null, out: "", err: "", timedOut: false };
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    p.kill("SIGTERM");
    setTimeout(() => p.kill("SIGKILL"), 2000);
  }, o.timeoutMs);
  const [out, err] = await Promise.all([
    new Response(p.stdout as ReadableStream).text(),
    new Response(p.stderr as ReadableStream).text(),
  ]);
  const code = await p.exited;
  clearTimeout(timer);
  return { code: timedOut ? null : code, out, err, timedOut };
}

export class SystemLaunch implements LaunchSystem {
  #tools: { at: number; v: AiLaunchTool[] } | null = null;

  constructor(private readonly detect: DetectOptions) {}

  git: LaunchGit = {
    run: async (cwd, args, timeoutMs = 20_000) => {
      const r = await spawnText(["git", "-C", cwd, ...args], {
        timeoutMs,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
      });
      return { ok: r.code === 0, out: r.code === 0 ? r.out.trimEnd() : "" };
    },
  };

  async tools(): Promise<AiLaunchTool[]> {
    const now = Date.now();
    if (this.#tools && now - this.#tools.at < 5 * 60_000) return this.#tools.v;
    const out: AiLaunchTool[] = [];
    for (const t of ["claude_code", "codex"] as const)
      if (await findCli(t, null, this.detect).catch(() => null)) out.push(t);
    this.#tools = { at: now, v: out };
    return out;
  }

  async runTest(command: string, cwd: string, timeoutMs: number): Promise<TestRun> {
    const shell = process.env.SHELL || "/bin/zsh";
    const r = await spawnText([shell, "-lc", command], { cwd, timeoutMs });
    // 標準出力と標準エラーをまとめて、最後の50行だけを持つ（メモリだけ）
    const lines = `${r.out}${r.err ? `\n${r.err}` : ""}`.split("\n");
    while (lines.length > 0 && lines.at(-1)?.trim() === "") lines.pop();
    return { exitCode: r.code, timedOut: r.timedOut, tail: lines.slice(-TAIL) };
  }

  async prCheck(repo: string, number: number): Promise<LaunchGhCheck | null> {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return null;
    const r = await spawnText(
      [
        "gh",
        "pr",
        "view",
        String(number),
        "-R",
        repo,
        "--json",
        "url,additions,deletions,changedFiles,statusCheckRollup",
      ],
      { timeoutMs: 20_000, env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" } },
    );
    if (r.code !== 0) return null;
    try {
      const j = JSON.parse(r.out) as Record<string, unknown>;
      const num = (v: unknown) => (typeof v === "number" ? v : null);
      return {
        url: typeof j.url === "string" ? j.url : null,
        additions: num(j.additions),
        deletions: num(j.deletions),
        files: num(j.changedFiles),
        // 名前と状態だけを使う（summarizeChecks）。ログ・本文は読まない
        rollup: j.statusCheckRollup,
      };
    } catch {
      return null;
    }
  }

  exists(path: string): boolean {
    return existsSync(path);
  }

  copyFile(from: string, to: string): boolean {
    try {
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(from, to);
      return true;
    } catch {
      return false;
    }
  }

  async screenLocked(): Promise<boolean> {
    const r = await spawnText(["/usr/sbin/ioreg", "-n", "Root", "-d1", "-a"], { timeoutMs: 5000 });
    return r.code === 0 && screenLockedFromIoreg(r.out);
  }

  trustFlags(configFile: string, keys: readonly string[]): Record<string, boolean> | null {
    return trustFlagsFrom(configFile, keys);
  }

  gitRoots(path: string): GitRoots & { real: string } {
    return gitRootsOf(path);
  }

  glob(cwd: string, pattern: string): string[] {
    try {
      return [...new Bun.Glob(pattern).scanSync({ cwd, dot: true, onlyFiles: true })].slice(0, 200);
    } catch {
      return [];
    }
  }
}

/**
 * `ioreg -n Root -d1 -a`（plist）から、コンソールのセッションの CGSSessionScreenIsLocked を読む。
 * キーの直後の値が <true/> なら true（plist の構造は読まず、キーと値の並びだけを見る）
 */
export function screenLockedFromIoreg(plist: string): boolean {
  return /<key>CGSSessionScreenIsLocked<\/key>\s*<true\s*\/>/.test(plist);
}

/** SystemLaunch.trustFlags の中身（テストから直接呼ぶ） */
export function trustFlagsFrom(
  configFile: string,
  keys: readonly string[],
): Record<string, boolean> | null {
  try {
    const j = JSON.parse(readFileSync(configFile, "utf8")) as { projects?: unknown };
    const projects =
      j.projects && typeof j.projects === "object" ? (j.projects as Record<string, unknown>) : {};
    const out: Record<string, boolean> = {};
    for (const k of keys) {
      const v = Object.hasOwn(projects, k) ? projects[k] : undefined;
      out[k] =
        !!v &&
        typeof v === "object" &&
        (v as { hasTrustDialogAccepted?: unknown }).hasTrustDialogAccepted === true;
    }
    return out;
  } catch {
    return null;
  }
}

/** SystemLaunch.gitRoots の中身（テストから直接呼ぶ） */
export function gitRootsOf(path: string): GitRoots & { real: string } {
  let real = path;
  try {
    real = realpathSync(path);
  } catch {}
  let s = real;
  for (let i = 0; i < 256; i++) {
    const g = `${s === "/" ? "" : s}/.git`;
    try {
      const st = statSync(g);
      if (st.isDirectory()) return { real, top: s, main: s };
      // worktree: `gitdir: <元のリポジトリ>/.git/worktrees/<名前>`
      const m = /^gitdir:\s*(.+)\s*$/m.exec(readFileSync(g, "utf8").slice(0, 4096));
      const dir = m?.[1] ? (isAbsolute(m[1]) ? m[1] : resolve(s, m[1])) : null;
      const i2 = dir ? dir.lastIndexOf("/.git/worktrees/") : -1;
      return { real, top: s, main: dir && i2 > 0 ? dir.slice(0, i2) : s };
    } catch {}
    const up = dirname(s);
    if (up === s) break;
    s = up;
  }
  return { real, top: null, main: null };
}
