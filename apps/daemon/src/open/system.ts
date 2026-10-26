/**
 * タスクから開く（D-059）が OS に触れるところ。テストでは偽物に差し替える。
 * コマンドは引数の配列で起動し、シェルを通さない（m2-api 13章）。
 */
import {
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  rmdirSync,
  statSync,
  writeSync,
} from "node:fs";
import { TTY } from "./locate.ts";

export interface RunOptions {
  /** 打ち切るまでの時間（osascript はオートメーションの許可の確認で待たされるため） */
  timeoutMs?: number;
  /** 標準入力に書く（pbcopy） */
  stdin?: string;
  /** 標準出力を返す長さ（既定 200。Orca の CLI の JSON の受け取り。中身はログに書かない） */
  stdoutMax?: number;
}

/** 起動の結果（失敗の理由を見るとき。B-5） */
export interface RunDetail {
  ok: boolean;
  /** 標準エラー出力（短く切る。中身はログに書かない） */
  stderr: string;
  /** timeoutMs で打ち切った */
  timedOut: boolean;
  /** 標準出力（短く切る。AppleScript の返したタブの番号を読む。中身はログに書かない） */
  stdout?: string;
}

export interface OpenSystem {
  exists(path: string): boolean;
  isDir(path: string): boolean;
  /** 終了コード 0 なら true。打ち切り・起動の失敗は false */
  run(argv: readonly string[], o?: RunOptions): Promise<boolean>;
  /** run と同じで、失敗の理由（標準エラー出力・打ち切り）も返す。無ければ run の結果だけで判断する */
  runDetail?(argv: readonly string[], o?: RunOptions): Promise<RunDetail>;
  /** プロセスの祖先をたどって最初に見つかった（外側の）`.app` のパス。無ければ null（tmux の中など） */
  hostApp(pid: number): string | null;
  /** `.app` の bundle ID（Info.plist の CFBundleIdentifier）。読めなければ null */
  bundleId(appPath: string): string | null;
  /**
   * 起動して標準出力を返す（終了コード 0 のときだけ。ps・tmux の一覧。locate.ts）。無ければ居場所は hostApp だけで調べる
   */
  capture?(argv: readonly string[]): Promise<string | null>;
  /** 擬似端末（`/dev/ttysNNN` だけ）に書く（Ghostty の目印の OSC 7。focus.ts）。書けなければ false */
  writeTty?(tty: string, data: string): boolean;
  /**
   * repoRoot の worktree のうち branch を取り出しているもののパス（`git worktree list --porcelain`）。無ければ null。
   * セッションの無いカード（PR だけのカード）を開くとき、PR の head ブランチの worktree に向ける
   */
  worktreeOf?(repoRoot: string, branch: string): string | null;
  /** 目印のフォルダを作る・消す（空のフォルダだけ） */
  makeDir?(path: string): void;
  removeDir?(path: string): void;
}

/** `git worktree list --porcelain` → branch を取り出している worktree のパス */
export function parseWorktreeFor(out: string, branch: string): string | null {
  let path: string | null = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
    else if (line === `branch refs/heads/${branch}` && path) return path;
    else if (line === "") path = null;
  }
  return null;
}

/** `/Applications/X.app/Contents/Frameworks/Y Helper.app/…` → `/Applications/X.app`（外側の .app） */
export function outerApp(execPath: string): string | null {
  const m = /^(\/.*?\.app)(?:\/|$)/.exec(execPath);
  return m ? (m[1] as string) : null;
}

/** `ps -o ppid=,comm=` の1行 → [ppid, comm] */
export function parsePsLine(line: string): [number, string] | null {
  const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
  return m ? [Number(m[1]), m[2] as string] : null;
}

export const systemOpen: OpenSystem = {
  exists: (p) => existsSync(p),
  isDir: (p) => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  },
  async run(argv, o = {}) {
    return (await systemOpen.runDetail?.(argv, o))?.ok ?? false;
  },
  async runDetail(argv, o = {}) {
    try {
      const p = Bun.spawn([...argv], {
        stdin: o.stdin !== undefined ? new TextEncoder().encode(o.stdin) : "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      let timedOut = false;
      const timer = o.timeoutMs
        ? setTimeout(() => {
            timedOut = true;
            p.kill();
          }, o.timeoutMs)
        : null;
      const [code, err, out] = await Promise.all([
        p.exited,
        new Response(p.stderr).text(),
        new Response(p.stdout).text(),
      ]);
      if (timer) clearTimeout(timer);
      return {
        ok: code === 0,
        stderr: err.slice(0, 500),
        timedOut,
        stdout: out.slice(0, o.stdoutMax ?? 200),
      };
    } catch {
      return { ok: false, stderr: "", timedOut: false };
    }
  },
  bundleId(appPath) {
    try {
      const r = Bun.spawnSync(
        [
          "/usr/bin/plutil",
          "-extract",
          "CFBundleIdentifier",
          "raw",
          "-o",
          "-",
          `${appPath}/Contents/Info.plist`,
        ],
        { stdout: "pipe", stderr: "ignore", timeout: 2000 },
      );
      const v = r.exitCode === 0 ? r.stdout.toString().trim() : "";
      return v || null;
    } catch {
      return null;
    }
  },
  async capture(argv) {
    try {
      const p = Bun.spawn([...argv], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
      const timer = setTimeout(() => p.kill(), 3_000);
      const [code, out] = await Promise.all([p.exited, new Response(p.stdout).text()]);
      clearTimeout(timer);
      return code === 0 ? out.slice(0, 256 * 1024) : null;
    } catch {
      return null;
    }
  },
  writeTty(tty, data) {
    // 擬似端末のスレーブ（キャラクタデバイス）だけ。ファイルやほかのデバイスには書かない
    if (!TTY.test(tty)) return false;
    try {
      if (!lstatSync(tty).isCharacterDevice()) return false;
      // O_NOCTTY: 制御端末にしない。O_NONBLOCK: 端末が出力を止めていても待たない
      const fd = openSync(tty, constants.O_WRONLY | constants.O_NOCTTY | constants.O_NONBLOCK);
      try {
        writeSync(fd, data);
      } finally {
        closeSync(fd);
      }
      return true;
    } catch {
      return false;
    }
  },
  worktreeOf(repoRoot, branch) {
    try {
      const r = Bun.spawnSync(
        ["git", "--no-optional-locks", "-C", repoRoot, "worktree", "list", "--porcelain"],
        {
          stdout: "pipe",
          stderr: "ignore",
          timeout: 3000,
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
        },
      );
      return r.exitCode === 0 ? parseWorktreeFor(r.stdout.toString(), branch) : null;
    } catch {
      return null;
    }
  },
  makeDir(path) {
    mkdirSync(path, { recursive: true });
  },
  removeDir(path) {
    try {
      rmdirSync(path);
    } catch {
      // 消せなくても OS の一時フォルダの片付けに任せる
    }
  },
  hostApp(pid) {
    let cur = pid;
    for (let i = 0; i < 32 && Number.isInteger(cur) && cur > 1; i++) {
      const r = Bun.spawnSync(["/bin/ps", "-o", "ppid=,comm=", "-p", String(cur)], {
        stdout: "pipe",
        stderr: "ignore",
      });
      const parsed = parsePsLine(r.stdout.toString().trim());
      if (!parsed) return null;
      const app = outerApp(parsed[1]);
      if (app) return app;
      cur = parsed[0];
    }
    return null;
  },
};
