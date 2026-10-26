/** タスクから開く（D-059）のテスト用の OS: 何も起動せず、起動しようとした引数を記録する */
import type { OpenSystem, RunOptions } from "../../src/open/system.ts";

export class FakeOpenSystem implements OpenSystem {
  /** 存在するファイル（.app のパス） */
  readonly files = new Set<string>();
  /** 存在するディレクトリ */
  readonly dirs = new Set<string>();
  /** 起動した引数（pbcopy は copies へ） */
  readonly runs: string[][] = [];
  readonly copies: string[] = [];
  /** 失敗させる起動（引数の先頭2つまでで判定する関数） */
  fail: (argv: readonly string[]) => boolean = () => false;
  /** 失敗の理由（runDetail）。失敗させる起動の stderr と打ち切り */
  failWhy: (argv: readonly string[]) => { stderr?: string; timedOut?: boolean } = () => ({});
  readonly hosts = new Map<number, string>();
  /** capture の出力（引数を空白でつないだもの → 標準出力）。無ければ失敗（null） */
  readonly outputs = new Map<string, string>();
  /** runDetail の標準出力（AppleScript の返すタブの番号） */
  stdout: (argv: readonly string[]) => string = () => "";
  /** tty に書いたもの・作った／消したフォルダ（Ghostty の目印） */
  readonly ttyWrites: { tty: string; data: string }[] = [];
  readonly madeDirs: string[] = [];
  readonly removedDirs: string[] = [];
  /** .app のパス → bundle ID */
  readonly bundles = new Map<string, string>();
  /** `<repo>#<branch>` → そのブランチを取り出している worktree のパス */
  readonly worktrees = new Map<string, string>();

  worktreeOf(repoRoot: string, branch: string): string | null {
    return this.worktrees.get(`${repoRoot}#${branch}`) ?? null;
  }

  exists(p: string): boolean {
    return this.files.has(p) || this.dirs.has(p);
  }
  isDir(p: string): boolean {
    return this.dirs.has(p);
  }
  async run(argv: readonly string[], o: RunOptions = {}): Promise<boolean> {
    if (argv[0] === "/usr/bin/pbcopy") {
      this.copies.push(o.stdin ?? "");
      return true;
    }
    this.runs.push([...argv]);
    return !this.fail(argv);
  }
  async runDetail(argv: readonly string[], o: RunOptions = {}) {
    const ok = await this.run(argv, o);
    const why = ok ? {} : this.failWhy(argv);
    return {
      ok,
      stderr: why.stderr ?? "",
      timedOut: why.timedOut ?? false,
      stdout: ok ? this.stdout(argv) : "",
    };
  }
  async capture(argv: readonly string[]): Promise<string | null> {
    return this.outputs.get(argv.join(" ")) ?? null;
  }
  writeTty(tty: string, data: string): boolean {
    this.ttyWrites.push({ tty, data });
    return true;
  }
  makeDir(p: string): void {
    this.madeDirs.push(p);
  }
  removeDir(p: string): void {
    this.removedDirs.push(p);
  }
  hostApp(pid: number): string | null {
    return this.hosts.get(pid) ?? null;
  }
  bundleId(appPath: string): string | null {
    return this.bundles.get(appPath) ?? null;
  }
}
