/**
 * AI に頼む（D-107）のテスト用の OS: git は応答を決めておける偽物（呼んだ引数を記録する）、CLI の検出・テスト・gh も偽物。
 * real を渡すと git だけ本物（一時ディレクトリのリポジトリで worktree を作る・消すテスト）
 */
import type { GitRoots } from "@turnlane/core";
import type { AiLaunchTool } from "@turnlane/core/api";
import type {
  GitResult,
  LaunchGhCheck,
  LaunchGit,
  LaunchSystem,
  TestRun,
} from "../../src/launch/system.ts";

export class FakeLaunchSystem implements LaunchSystem {
  /** git の呼び出し（cwd と引数） */
  readonly gitCalls: { cwd: string; args: string[] }[] = [];
  /** 引数の先頭からの一致 → 結果（無ければ ok・空） */
  readonly gitReplies: {
    match: (cwd: string, args: readonly string[]) => boolean;
    r: GitResult;
  }[] = [];
  readonly paths = new Set<string>();
  installed: AiLaunchTool[] = ["claude_code"];
  testResult: TestRun = { exitCode: 0, timedOut: false, tail: ["12 pass", "0 fail"] };
  readonly testCalls: { command: string; cwd: string }[] = [];
  pr: LaunchGhCheck | null = null;
  readonly copies: [string, string][] = [];
  globs = new Map<string, string[]>();

  constructor(private readonly real?: LaunchGit) {}

  reply(match: (cwd: string, args: readonly string[]) => boolean, r: GitResult): void {
    this.gitReplies.unshift({ match, r });
  }

  git: LaunchGit = {
    run: async (cwd, args, timeoutMs) => {
      this.gitCalls.push({ cwd, args: [...args] });
      if (this.real) return this.real.run(cwd, args, timeoutMs);
      const hit = this.gitReplies.find((x) => x.match(cwd, args));
      if (hit) return hit.r;
      if (args[0] === "worktree" && args[1] === "add") this.paths.add(args[2] as string);
      if (args[0] === "worktree" && args[1] === "remove") this.paths.delete(args.at(-1) as string);
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return { ok: true, out: cwd };
      return { ok: true, out: "" };
    },
  };

  /** 画面のロック（人のいないときの起動のテスト） */
  locked = false;

  async screenLocked(): Promise<boolean> {
    return this.locked;
  }

  async tools(): Promise<AiLaunchTool[]> {
    return this.installed;
  }

  async runTest(command: string, cwd: string): Promise<TestRun> {
    this.testCalls.push({ command, cwd });
    return this.testResult;
  }

  async prCheck(): Promise<LaunchGhCheck | null> {
    return this.pr;
  }

  exists(path: string): boolean {
    return this.paths.has(path);
  }

  copyFile(from: string, to: string): boolean {
    this.copies.push([from, to]);
    return true;
  }

  glob(cwd: string, pattern: string): string[] {
    return this.globs.get(`${cwd}|${pattern}`) ?? [];
  }

  /** 信頼している（設定のファイル → キー）。設定のファイルが unreadable にあれば読めない */
  readonly trusted = new Map<string, Set<string>>();
  readonly unreadable = new Set<string>();
  readonly trustReads: { file: string; keys: string[] }[] = [];

  trust(file: string, ...keys: string[]): void {
    const s = this.trusted.get(file) ?? new Set<string>();
    for (const k of keys) s.add(k);
    this.trusted.set(file, s);
  }

  trustFlags(configFile: string, keys: readonly string[]): Record<string, boolean> | null {
    this.trustReads.push({ file: configFile, keys: [...keys] });
    if (this.unreadable.has(configFile)) return null;
    const s = this.trusted.get(configFile);
    return Object.fromEntries(keys.map((k) => [k, s?.has(k) ?? false]));
  }

  /** フォルダ → git の位置（無ければフォルダが git のルート） */
  readonly roots = new Map<string, GitRoots>();

  gitRoots(path: string): GitRoots & { real: string } {
    return { real: path, ...(this.roots.get(path) ?? { top: path, main: path }) };
  }
}
