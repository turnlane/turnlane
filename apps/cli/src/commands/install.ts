/**
 * turnlane self-install / turnlane uninstall（phase0-plan 3.6、M0-6）。
 *
 * self-install:
 *   1. 実行中の turnlane と同じディレクトリにある turnlane / turnlaned を ~/.local/bin へコピー（一時名 → rename）
 *   2. LaunchAgent の plist を ~/Library/LaunchAgents/dev.turnlane.daemon.plist に書く
 *   3. launchctl bootstrap で登録・起動し、health が返るまで待つ（--no-load なら登録しない）。
 *      登録済みなら bootout して外れるまで待ってから bootstrap する。error 5 / 37 は再試行する
 *      （bootout 直後は launchd がまだ解体中で bootstrap が失敗することがある）
 *   4. コピーした turnlane / turnlaned を --version で1回実行する（新しいバイナリの初回のコード検査を済ませる。S4 の C4）
 * --dry-run なら何も書かずに手順と plist を表示する。
 *
 *   5. コピー元に Turnlane.app があれば ~/Applications に置き、LaunchAgent dev.turnlane.desktop を登録して起動する
 *      （ログイン時の自動起動。D-056 (4)。--no-desktop で省く。desktop-shell.md 6.2）
 * uninstall: launchd から外し、plist とバイナリ（Turnlane.app も）を消す。データ（DB・バックアップ）とログは残す。
 */

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { DAEMON_LABEL, DESKTOP_APP } from "@turnlane/core";
import { daemonPlist } from "@turnlane/daemon/launchd";
import { waitForHealth } from "../client.ts";
import { type CliEnv, plistPath } from "../env.ts";
import { tr } from "../lang.ts";
import { bootoutAndWait, reloadService } from "../launchctl.ts";
import { installDesktop, uninstallDesktop } from "./desktop.ts";
import { refreshMcpPaths } from "./mcp-config.ts";

const BINARIES = ["turnlane", "turnlaned"] as const;
/** plist に引き継ぐ環境変数（既定以外の場所・ポートで動かす場合） */
const PASS_THROUGH = ["TURNLANE_DATA_DIR", "TURNLANE_LOG_DIR", "TURNLANE_PORT"] as const;

export interface SelfInstallOptions {
  from?: string | undefined;
  dryRun?: boolean;
  noLoad?: boolean;
  /** Turnlane.app を置かない・登録しない */
  noDesktop?: boolean;
  waitMs?: number;
  /** MCP の登録の書き換え前のバックアップ名の時刻（テスト用） */
  now?: number;
}

function sourceDir(env: CliEnv, from: string | undefined): string | null {
  if (from) return resolve(from);
  // bun で直接実行している（開発時）ならコピー元が無い
  if (basename(env.execPath) !== "turnlane") return null;
  return dirname(env.execPath);
}

export function buildPlist(env: CliEnv): string {
  const passed: Record<string, string> = {};
  for (const k of PASS_THROUGH) {
    const v = env.vars[k];
    if (v) passed[k] = v;
  }
  return daemonPlist({
    label: DAEMON_LABEL,
    program: join(env.paths.binDir, "turnlaned"),
    logDir: env.paths.logDir,
    env: passed,
  });
}

function atomicCopy(src: string, dst: string): void {
  const tmp = `${dst}.tmp-${process.pid}`;
  copyFileSync(src, tmp);
  chmodSync(tmp, 0o755);
  renameSync(tmp, dst);
}

function runVersion(bin: string): string {
  const p = Bun.spawnSync([bin, "--version"], { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`${bin} --version failed: ${p.stderr.toString().trim()}`);
  return p.stdout.toString().trim();
}

export async function selfInstall(env: CliEnv, opts: SelfInstallOptions = {}): Promise<number> {
  const { paths } = env;
  const src = sourceDir(env, opts.from);
  if (!src) {
    env.err(
      tr(
        "Run self-install from a built turnlane (for example: bun run build && out/turnlane self-install). You can also pass --from <dir>.",
        "self-install はビルド済みの turnlane から実行してください（例: bun run build && out/turnlane self-install）。--from <dir> でも指定できます。",
      ),
    );
    return 1;
  }
  const missing = BINARIES.filter((b) => !existsSync(join(src, b)));
  if (missing.length > 0) {
    env.err(
      tr(
        `${missing.join(", ")} not found in ${src}.`,
        `コピー元 ${src} に ${missing.join(", ")} がありません。`,
      ),
    );
    return 1;
  }
  const plist = plistPath(paths);
  const content = buildPlist(env);
  const sameDir = resolve(src) === resolve(paths.binDir);
  const step = (s: string) => env.out(`${opts.dryRun ? "[dry-run] " : ""}${s}`);

  for (const b of BINARIES) {
    if (sameDir)
      step(
        tr(
          `${join(paths.binDir, b)} is already in place`,
          `${join(paths.binDir, b)} は既に配置済み`,
        ),
      );
    else
      step(
        tr(
          `Copy: ${join(src, b)} → ${join(paths.binDir, b)}`,
          `コピー: ${join(src, b)} → ${join(paths.binDir, b)}`,
        ),
      );
  }
  const desktopSrc = join(src, DESKTOP_APP);
  const withDesktop = !opts.noDesktop && existsSync(desktopSrc);
  if (opts.dryRun) {
    // MCP の登録が古いパスを指していれば直す（D-145。登録の無いところには足さない）
    refreshMcpPaths(env, join(paths.binDir, "turnlane"), { dryRun: true, now: opts.now, step });
    step(`plist: ${plist}`);
    env.out(content);
    if (withDesktop) installDesktop(env, desktopSrc, { dryRun: true, step });
    step(
      opts.noLoad
        ? tr("Skip registering with launchd (--no-load)", "launchd への登録はしない（--no-load）")
        : `launchctl bootstrap gui/<uid> ${plist}`,
    );
    step(
      tr(
        `Run ${join(paths.binDir, "turnlane")} --version / turnlaned --version once`,
        `${join(paths.binDir, "turnlane")} --version / turnlaned --version を1回実行`,
      ),
    );
    return 0;
  }

  mkdirSync(paths.binDir, { recursive: true });
  if (!sameDir) for (const b of BINARIES) atomicCopy(join(src, b), join(paths.binDir, b));
  // MCP の登録が古いパス（別の場所）を指していれば、新しいパスに直す（D-145。登録の無いところには足さない）
  refreshMcpPaths(env, join(paths.binDir, "turnlane"), { dryRun: false, now: opts.now, step });
  step(`plist: ${plist}`);
  mkdirSync(paths.launchAgentsDir, { recursive: true });
  mkdirSync(paths.logDir, { recursive: true, mode: 0o700 });
  const prev = existsSync(plist) ? readFileSync(plist, "utf8") : null;
  if (prev !== content) writeFileSync(plist, content, { mode: 0o644 });

  // 初回実行のコード検査（約1秒）をここで済ませる。デーモンの起動より先に行う
  for (const b of BINARIES) step(runVersion(join(paths.binDir, b)));

  if (opts.noLoad) {
    step(
      tr(
        "Skipped registering with launchd (--no-load)",
        "launchd への登録は省略しました（--no-load）",
      ),
    );
  } else {
    // bootout 直後の bootstrap は launchd の解体待ちで error 5 になることがあるので、待って再試行する
    reloadService(env.launchctl, DAEMON_LABEL, plist, {
      retryHint: "turnlane daemon start",
      onReplace: () =>
        step(
          tr(
            "Stopping the registered background service to replace it",
            "登録済みのデーモンを停止して入れ替えます",
          ),
        ),
    });
    step(
      tr(`Registered with launchd (${DAEMON_LABEL})`, `launchd に登録しました（${DAEMON_LABEL}）`),
    );
    const h = await waitForHealth(paths, opts.waitMs ?? 10_000);
    if (!h) {
      env.err(
        tr(
          `turnlaned isn't responding. Check turnlane daemon logs (${paths.logPath})`,
          `デーモンが応答しません。turnlane daemon logs で確認してください（${paths.logPath}）`,
        ),
      );
      return 1;
    }
    step(
      tr(
        `turnlaned ${h.version} is running: http://127.0.0.1:${h.port}/`,
        `turnlaned ${h.version} が稼働中です: http://127.0.0.1:${h.port}/`,
      ),
    );
  }
  if (withDesktop && !opts.noLoad) {
    const r = installDesktop(env, desktopSrc, { dryRun: false, step });
    if (r !== 0) return r;
  }
  const pathVar = env.vars.PATH ?? "";
  if (!pathVar.split(":").includes(paths.binDir)) {
    env.out(
      tr(
        `Note: ${paths.binDir} isn't in your PATH. Add it in your shell settings.`,
        `注意: ${paths.binDir} が PATH にありません。シェルの設定に追加してください。`,
      ),
    );
  }
  return 0;
}

export interface UninstallOptions {
  dryRun?: boolean;
}

export function uninstall(env: CliEnv, opts: UninstallOptions = {}): number {
  const { paths } = env;
  const plist = plistPath(paths);
  const step = (s: string) => env.out(`${opts.dryRun ? "[dry-run] " : ""}${s}`);
  const loaded = env.launchctl.print(DAEMON_LABEL).loaded;
  if (loaded) {
    step(`launchctl bootout gui/<uid>/${DAEMON_LABEL}`);
    if (!opts.dryRun) bootoutAndWait(env.launchctl, DAEMON_LABEL);
  }
  if (existsSync(plist)) {
    step(tr(`Delete: ${plist}`, `削除: ${plist}`));
    if (!opts.dryRun) rmSync(plist);
  }
  uninstallDesktop(env, { dryRun: opts.dryRun === true, step });
  for (const b of BINARIES) {
    const p = join(paths.binDir, b);
    if (existsSync(p)) {
      step(tr(`Delete: ${p}`, `削除: ${p}`));
      // 実行中の turnlane 自身も消せる（macOS は実行中のファイルの unlink を許す）
      if (!opts.dryRun) rmSync(p);
    }
  }
  env.out(
    tr(
      `Your data (${paths.dataDir}) and logs (${paths.logDir}) are kept.`,
      `データ（${paths.dataDir}）とログ（${paths.logDir}）は残しています。`,
    ),
  );
  return 0;
}
