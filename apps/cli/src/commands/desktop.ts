/**
 * turnlane desktop install|uninstall|status（desktop-shell.md 6.2、M2-D6）。`turnlane calendar install` と同じ形。
 *
 *   turnlane desktop install [--app <path>] [--dry-run]   Turnlane.app を ~/Applications に置き、LaunchAgent を登録して起動する
 *   turnlane desktop uninstall [--dry-run]                LaunchAgent と .app を消す（設定・データは残す）
 *   turnlane desktop status [--json]                      LaunchAgent、起動中か、デーモンとの接続、通知の許可、ホットキー
 *
 * `turnlane self-install` はコピー元（turnlane と同じディレクトリ）に Turnlane.app があれば install と同じことを行う（--no-desktop で省く）。
 * `turnlane uninstall` はアプリの LaunchAgent と .app も消す。
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { DESKTOP_APP, DESKTOP_LABEL } from "@turnlane/core";
import type { DesktopStatusResponse, NotificationPermission } from "@turnlane/daemon";
import { processesRunningFrom, replaceBundle, signatureKind } from "@turnlane/daemon/bundle";
import { desktopPlist } from "@turnlane/daemon/launchd";
import { callApi, fetchHealth } from "../client.ts";
import type { CliEnv } from "../env.ts";
import { tr } from "../lang.ts";
import { bootoutAndWait, reloadService } from "../launchctl.ts";

const PASS_THROUGH = ["TURNLANE_DATA_DIR", "TURNLANE_LOG_DIR", "TURNLANE_PORT"] as const;

export function desktopAppPath(env: CliEnv): string {
  return join(env.paths.home, "Applications", DESKTOP_APP);
}

export function desktopPlistPath(env: CliEnv): string {
  return join(env.paths.launchAgentsDir, `${DESKTOP_LABEL}.plist`);
}

export function buildDesktopPlist(env: CliEnv): string {
  const passed: Record<string, string> = {};
  for (const k of PASS_THROUGH) {
    const v = env.vars[k];
    if (v) passed[k] = v;
  }
  return desktopPlist({
    label: DESKTOP_LABEL,
    app: desktopAppPath(env),
    logDir: env.paths.logDir,
    env: passed,
  });
}

/** turnlane と同じディレクトリ（ビルドの out/）にある Turnlane.app */
export function desktopSourceApp(env: CliEnv, app?: string): string | null {
  if (app) return resolve(app);
  if (basename(env.execPath) !== "turnlane") return null;
  const p = join(dirname(env.execPath), DESKTOP_APP);
  return existsSync(p) ? p : null;
}

const isApp = (p: string) => existsSync(join(p, "Contents", "MacOS", "turnlane"));

/** 署名の種類（turnlane doctor・status）: Apple Development / Developer ID / ad-hoc / なし（デーモンの自動更新と共通） */
export { signatureKind };

/**
 * 公証のチケットが staple されているか。stapler は .app の Contents/CodeResources にチケットを置く。
 * ファイルを見るだけで、Apple に問い合わせない（spctl はチケットが無いと接続しうるので doctor では使わない）
 */
export function notarizationStapled(app: string): boolean {
  return existsSync(join(app, "Contents", "CodeResources"));
}

/** 動いているアプリを終わらせる（入れ替え・削除の前。launchd 以外から起動したものも） */
function quitRunning(app: string): void {
  Bun.spawnSync(["/usr/bin/pkill", "-f", `${app}/Contents/MacOS/turnlane`], {
    stdout: "ignore",
    stderr: "ignore",
  });
}

export async function installDesktop(
  env: CliEnv,
  src: string,
  o: { dryRun: boolean; step: (s: string) => void },
): Promise<number> {
  if (!isApp(src)) {
    env.err(
      tr(
        `Turnlane.app not found: ${src} (build it with bun run build:desktop and pass it with --app <path>)`,
        `Turnlane.app が見つかりません: ${src}（bun run build:desktop でビルドし、--app <path> で指定してください）`,
      ),
    );
    return 1;
  }
  const dst = desktopAppPath(env);
  const plist = desktopPlistPath(env);
  const content = buildDesktopPlist(env);
  const same = resolve(src) === resolve(dst);
  if (!same) o.step(tr(`Copy: ${src} → ${dst}`, `コピー: ${src} → ${dst}`));
  o.step(`plist: ${plist}`);
  if (o.dryRun) {
    env.out(content);
    o.step(`launchctl bootstrap gui/<uid> ${plist}`);
    return 0;
  }
  if (env.launchctl.print(DESKTOP_LABEL).loaded) bootoutAndWait(env.launchctl, DESKTOP_LABEL);
  quitRunning(dst);
  if (!same) {
    mkdirSync(dirname(dst), { recursive: true });
    // 隣の一時名に写してから rename で入れ替える（ditto は署名を壊さずにバンドルを写す。失敗したら前のものを残す）
    // 前の版から起動したプロセス（デーモン・カレンダーヘルパ）がまだ動いていれば、前の版（.Turnlane.app.old）は消さずに残す
    // （動いている実行ファイルを消すと落ちる）。新しい版のデーモンが起動の後に消す
    const keepOld = existsSync(dst) && processesRunningFrom(dst);
    const err = await replaceBundle(src, dst, undefined, { keepOld });
    if (err) {
      env.err(
        tr(
          `Copy failed (${err === "not_writable" ? "not writable" : "copy or rename failed"}): ${dst}`,
          `コピーに失敗しました（${err === "not_writable" ? "書き込めません" : "写し・名前の変更に失敗"}）: ${dst}`,
        ),
      );
      return 1;
    }
  }
  mkdirSync(env.paths.launchAgentsDir, { recursive: true });
  mkdirSync(env.paths.logDir, { recursive: true, mode: 0o700 });
  writeFileSync(plist, content, { mode: 0o644 });
  reloadService(env.launchctl, DESKTOP_LABEL, plist, { retryHint: "turnlane desktop install" });
  o.step(
    tr(
      `Registered with launchd (${DESKTOP_LABEL}). It starts at login. Open the window with turnlane open`,
      `launchd に登録しました（${DESKTOP_LABEL}）。ログイン時に起動します。turnlane open でウインドウを開きます`,
    ),
  );
  if (signatureKind(dst) === "ad-hoc")
    env.out(
      tr(
        "Note: ad-hoc signature. Notification permission may reset on every rebuild (set TURNLANE_CODESIGN_IDENTITY when building)",
        "注意: ad-hoc 署名です。再ビルドのたびに通知の許可が外れることがあります（TURNLANE_CODESIGN_IDENTITY を設定してビルド）",
      ),
    );
  return 0;
}

export function uninstallDesktop(env: CliEnv, o: { dryRun: boolean; step: (s: string) => void }) {
  if (env.launchctl.print(DESKTOP_LABEL).loaded) {
    o.step(`launchctl bootout gui/<uid>/${DESKTOP_LABEL}`);
    if (!o.dryRun) bootoutAndWait(env.launchctl, DESKTOP_LABEL);
  }
  const app = desktopAppPath(env);
  if (!o.dryRun) quitRunning(app);
  for (const p of [desktopPlistPath(env), app]) {
    if (existsSync(p)) {
      o.step(tr(`Delete: ${p}`, `削除: ${p}`));
      if (!o.dryRun) rmSync(p, { recursive: true, force: true });
    }
  }
}

export interface DesktopStatus {
  installed: boolean;
  signature: string | null;
  launchAgent: { loaded: boolean; running: boolean };
  connected: boolean;
  app: DesktopStatusResponse["app"];
}

export async function desktopStatus(env: CliEnv): Promise<DesktopStatus> {
  const app = desktopAppPath(env);
  const installed = isApp(app);
  const s = env.launchctl.print(DESKTOP_LABEL);
  let remote: DesktopStatusResponse | null = null;
  if (await fetchHealth(env.paths)) {
    const r = await callApi<DesktopStatusResponse>(env.paths, "GET", "/api/desktop/status");
    if (r.ok) remote = r.data;
  }
  return {
    installed,
    signature: installed ? signatureKind(app) : null,
    launchAgent: { loaded: s.loaded, running: s.pid !== undefined },
    connected: remote?.connected ?? false,
    app: remote?.app ?? null,
  };
}

/** 通知の許可（D-080: 生の値を出さない。設定画面の表示と同じ言い方） */
const NOTIF = (): Record<NotificationPermission, string> => ({
  granted: tr("On", "オン"),
  denied: tr(
    "Off — allow them in System Settings > Notifications > Turnlane",
    "オフ — システム設定 > 通知 > Turnlane で許可してください",
  ),
  not_determined: tr(
    "Not set — allow them with “Ask for permission” in the desktop app row of Settings",
    "未設定 — 設定画面のデスクトップアプリの行の「許可を求める」で許可してください",
  ),
  unknown: tr("Checking", "確認中"),
  unsupported: tr(
    "Not available (not started from the .app)",
    "使えません（.app から起動していない）",
  ),
});

/** 1行ずつの表示（turnlane desktop status と turnlane doctor） */
export function desktopLines(s: DesktopStatus): string[] {
  if (!s.installed)
    return [
      tr(
        "Desktop app: not installed (turnlane desktop install)",
        "デスクトップアプリ: 未インストール（turnlane desktop install）",
      ),
    ];
  const lines = [
    tr(
      `Desktop app: ${s.signature ?? ""} signature · LaunchAgent ${s.launchAgent.loaded ? "registered" : "not registered"} · ${s.connected ? "connected" : "not connected"}`,
      `デスクトップアプリ: ${s.signature ?? ""} 署名 · LaunchAgent ${s.launchAgent.loaded ? "登録済み" : "未登録"} · ${s.connected ? "デーモンに接続中" : "未接続"}`,
    ),
  ];
  if (s.app) {
    const notif = NOTIF();
    lines.push(
      tr(
        `  Notifications: ${notif[s.app.notifications] ?? notif.unknown} · Quick add: ${s.app.shortcut.accelerator} ${s.app.shortcut.registered ? "registered" : "can't register (another app uses it; turnlane config set desktop.quick_add_shortcut <key>)"}`,
        `  通知: ${notif[s.app.notifications] ?? notif.unknown} · クイック入力: ${s.app.shortcut.accelerator} ${s.app.shortcut.registered ? "登録済み" : "登録できません（他のアプリが使用中。turnlane config set desktop.quick_add_shortcut <key>）"}`,
      ),
    );
  }
  return lines;
}

export async function desktopCommand(
  env: CliEnv,
  sub: string | undefined,
  o: { app?: string | undefined; dryRun?: boolean; json?: boolean },
): Promise<number> {
  const step = (s: string) => env.out(`${o.dryRun ? "[dry-run] " : ""}${s}`);
  switch (sub ?? "status") {
    case "install": {
      const src = desktopSourceApp(env, o.app);
      if (!src) {
        env.err(
          tr(
            "Turnlane.app not found. Build it with bun run build:desktop and pass it with --app <path>.",
            "Turnlane.app が見つかりません。bun run build:desktop でビルドし、--app <path> で指定してください。",
          ),
        );
        return 1;
      }
      return await installDesktop(env, src, { dryRun: o.dryRun === true, step });
    }
    case "uninstall":
      uninstallDesktop(env, { dryRun: o.dryRun === true, step });
      env.out(
        tr(
          "The notification permission entry (System Settings > Notifications) stays. Remove it by hand if you don't need it.",
          "通知の許可（システム設定 > 通知）の項目は残ります。不要なら手で外してください。",
        ),
      );
      return 0;
    case "status": {
      const s = await desktopStatus(env);
      if (o.json) env.out(JSON.stringify(s));
      else for (const l of desktopLines(s)) env.out(l);
      return 0;
    }
    default:
      env.err(
        tr(
          "Usage: turnlane desktop install [--app <path>] [--dry-run] | uninstall | status [--json]",
          "使い方: turnlane desktop install [--app <path>] [--dry-run] | uninstall | status [--json]",
        ),
      );
      return 2;
  }
}
