/**
 * 配布版（Turnlane.app）の配置（ADR 0011 の決定 2・4・7・8、onboarding.md 2.4・2.6・2.7、phase0-plan M6-15・M6-16）。
 *
 *   turnlane link [--dry-run]                    ~/.local/bin/turnlane をアプリの中の turnlane へのリンクにする
 *   turnlane uninstall --all [--dry-run]         hooks・MCP の Turnlane の項目、常駐の登録（SMAppService）、リンク、
 *                                                install.json を外す（データとログは残す）
 *   turnlane setup migrate [--dry-run] [--app <path>]
 *                                                開発時の配置（~/.local/bin・LaunchAgent dev.turnlane.*・~/Applications）
 *                                                から、アプリの配置（SMAppService）へ移す
 *   turnlane setup migrate --rollback [--dry-run]  直前の移行を戻す
 *
 * どの段も今の状態を見て、済んでいなければ行う（途中で失敗しても同じコマンドで続きから）。
 * 消さずに退避する（plist・バイナリは <データ>/legacy/<時刻>/、アプリはゴミ箱）。
 * 何をしたかを <データ>/legacy/<時刻>/manifest.json に残し、--rollback はそれを見て戻す。
 * 常駐の登録はアプリのプロセスでしかできない（SMAppService）ので、同梱のアプリを `--setup register <項目>` で起こす。
 * install.json が app のときは、開発用のコマンド（self-install・calendar install・desktop install）を止める
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  bundledBinary,
  bundledCliLinkPath,
  CALENDAR_HELPER_APP,
  CALENDAR_HELPER_LABEL,
  DAEMON_LABEL,
  DESKTOP_APP,
  DESKTOP_LABEL,
  detectInstall,
  installJsonPath,
  linkTarget,
  readInstallInfo,
  writeInstallInfo,
} from "@turnlane/core";
import {
  ConfigParseError,
  claudePlan,
  codexHome,
  codexPlan,
  detectClaudeDirs,
  status as hooksStatus,
  install as installHooks,
  loadJson,
  type Plan,
  saveJson,
  uninstall as uninstallHooks,
} from "@turnlane/core/hooks";
import { mcpTargets } from "@turnlane/core/mcp";
import { fetchHealth, waitForHealth } from "../client.ts";
import type { CliEnv } from "../env.ts";
import { tr } from "../lang.ts";
import { bootoutAndWait, reloadService } from "../launchctl.ts";
import { applyToTargets, refreshMcpPaths } from "./mcp-config.ts";

/** 同梱のアプリの登録の操作（`<app>/Contents/MacOS/turnlane --setup …`）。テストでは差し替える */
export type AppSetupRunner = (app: string, args: string[]) => { code: number; out: string };

export const systemAppSetup: AppSetupRunner = (app, args) => {
  const p = Bun.spawnSync([join(app, "Contents", "MacOS", "turnlane"), "--setup", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: p.exitCode ?? 1, out: p.stdout.toString().trim() };
};

const LABELS = [DESKTOP_LABEL, CALENDAR_HELPER_LABEL, DAEMON_LABEL] as const;
/** 開発時の LaunchAgent が場所を変えていたら移さない（配布版の plist は既定の場所しか使えない） */
const LOCATION_VARS = ["TURNLANE_DATA_DIR", "TURNLANE_LOG_DIR", "TURNLANE_PORT"] as const;

function stamp(now: number): string {
  return new Date(now)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

/** 配置の方式が app なら、開発用のコマンドを止める（理由を出して true） */
export function refuseInApp(env: CliEnv, cmd: string): boolean {
  const info = readInstallInfo(env.paths.dataDir);
  if (info?.mode !== "app") return false;
  env.err(
    tr(
      `turnlane ${cmd} is for the developer install. This Mac uses Turnlane.app (${info.appPath ?? "unknown"}), which manages the background process itself. To go back to the developer install, run turnlane setup migrate --rollback.`,
      `turnlane ${cmd} は開発時の配置のコマンドです。この Mac は Turnlane.app（${info.appPath ?? "不明"}）で、常駐はアプリが管理しています。開発時の配置に戻すときは turnlane setup migrate --rollback を実行してください。`,
    ),
  );
  return true;
}

/** 対象のアプリ: --app、同梱の turnlane として動いていればそのアプリ、無ければ install.json の場所 */
export function targetApp(env: CliEnv, explicit?: string): string | null {
  if (explicit) return resolve(explicit);
  const own = detectInstall(env.execPath).appPath;
  if (own) return own;
  return readInstallInfo(env.paths.dataDir)?.appPath ?? null;
}

function isBundledApp(app: string): boolean {
  return existsSync(bundledBinary(app, "turnlaned")) && existsSync(bundledBinary(app, "turnlane"));
}

function pointsTo(link: string, target: string): boolean {
  const t = linkTarget(link);
  return t !== null && resolve(dirname(link), t) === target;
}

function makeLink(link: string, target: string): void {
  mkdirSync(dirname(link), { recursive: true });
  const tmp = `${link}.tmp-${process.pid}`;
  rmSync(tmp, { force: true });
  symlinkSync(target, tmp);
  renameSync(tmp, link);
}

// ---------- turnlane link ----------

export function linkCommand(env: CliEnv, o: { dryRun: boolean; app?: string | undefined }): number {
  const app = targetApp(env, o.app);
  if (!app || !isBundledApp(app)) {
    env.err(
      tr(
        "Turnlane.app not found. Run this from the turnlane inside Turnlane.app, or pass --app <path>.",
        "Turnlane.app が見つかりません。Turnlane.app の中の turnlane から実行するか、--app <path> を付けてください。",
      ),
    );
    return 1;
  }
  const link = join(env.paths.binDir, "turnlane");
  const target = bundledBinary(app, "turnlane");
  const pre = o.dryRun ? "[dry-run] " : "";
  if (pointsTo(link, target)) {
    env.out(tr(`${link} already points to ${target}`, `${link} は既に ${target} を指しています`));
  } else if (existsSync(link) && linkTarget(link) === null) {
    env.err(
      tr(
        `${link} is a file (a developer install?). Move to the app with turnlane setup migrate first.`,
        `${link} はファイルです（開発時の配置？）。先に turnlane setup migrate でアプリの配置に移してください。`,
      ),
    );
    return 1;
  } else {
    env.out(`${pre}${link} → ${target}`);
    if (!o.dryRun) makeLink(link, target);
  }
  if (!(env.vars.PATH ?? "").split(":").includes(env.paths.binDir))
    env.out(
      tr(
        `Note: ${env.paths.binDir} isn't in your PATH. Add it in your shell settings.`,
        `注意: ${env.paths.binDir} が PATH にありません。シェルの設定に追加してください。`,
      ),
    );
  return 0;
}

// ---------- hooks の書き換え（移行・戻し・uninstall --all） ----------

interface HooksTarget {
  tool: "claude_code" | "codex";
  file: string;
  plan: Plan;
}

function hooksTargets(env: CliEnv, cli: string): HooksTarget[] {
  const out: HooksTarget[] = detectClaudeDirs(env.paths.home, env.vars).map((d) => ({
    tool: "claude_code" as const,
    file: join(d, "settings.json"),
    plan: claudePlan(cli),
  }));
  const ch = codexHome(env.paths.home, env.vars);
  if (existsSync(ch))
    out.push({ tool: "codex", file: join(ch, "hooks.json"), plan: codexPlan(cli) });
  return out;
}

/** Turnlane のエントリが既にあるファイルだけを、cli を指すように同じ位置で書き換える。書き換えたファイルの数 */
function rewriteHooks(
  env: CliEnv,
  cli: string,
  o: { dryRun: boolean; suffix: string; pre: string },
): { changed: string[]; codex: boolean; failed: number } {
  const changed: string[] = [];
  let codex = false;
  let failed = 0;
  for (const t of hooksTargets(env, cli)) {
    try {
      const f = loadJson(t.file);
      if (hooksStatus(f.value, t.plan).state === "none") continue;
      const { next } = installHooks(f.value, t.plan);
      const r = saveJson(f, next, { backupSuffix: o.suffix, dryRun: o.dryRun });
      if (!r.changed) continue;
      env.out(tr(`${o.pre}hooks: ${t.file} → ${cli}`, `${o.pre}hooks: ${t.file} → ${cli}`));
      changed.push(t.file);
      if (t.tool === "codex") codex = true;
    } catch (e) {
      env.err(`${t.file}: ${e instanceof ConfigParseError ? e.message : (e as Error).message}`);
      failed++;
    }
  }
  return { changed, codex, failed };
}

// ---------- turnlane uninstall --all ----------

export async function uninstallAll(
  env: CliEnv,
  o: { dryRun: boolean; now?: number; app?: string | undefined; appSetup?: AppSetupRunner },
): Promise<number> {
  const pre = o.dryRun ? "[dry-run] " : "";
  const suffix = `.bak-turnlane-${stamp(o.now ?? Date.now())}`;
  let failed = 0;
  // hooks（Turnlane のエントリだけ）
  for (const t of hooksTargets(env, "turnlane")) {
    try {
      const f = loadJson(t.file);
      const { next, removed } = uninstallHooks(f.value);
      const r = saveJson(f, next, { backupSuffix: suffix, dryRun: o.dryRun });
      if (r.changed)
        env.out(`${pre}hooks: ${t.file}: ${tr("removed", "削除")} ${removed.join(", ")}`);
      if (r.changed && t.tool === "codex")
        env.out(
          tr(
            `${pre}  Codex: approve the remaining hooks again with /hooks if Codex asks`,
            `${pre}  Codex: 求められたら残りの hook を /hooks で承認し直してください`,
          ),
        );
    } catch (e) {
      env.err(`${t.file}: ${(e as Error).message}`);
      failed++;
    }
  }
  // MCP（turnlane の項目だけ）
  failed += applyToTargets(env, mcpTargets(env.paths.home, env.vars), "uninstall", "turnlane", {
    dryRun: o.dryRun,
    now: o.now,
  }).failed;
  // 常駐の登録（アプリのプロセスで外す）
  const app = targetApp(env, o.app);
  if (app && isBundledApp(app)) {
    env.out(`${pre}${tr("Background items: unregister", "常駐の登録を外す")} (${app})`);
    if (!o.dryRun) {
      const r = (o.appSetup ?? systemAppSetup)(app, ["unregister-all"]);
      if (r.code !== 0) {
        env.err(
          tr(
            "Couldn't unregister the background items. Turn Turnlane off in System Settings › General › Login Items.",
            "常駐の登録を外せませんでした。システム設定 › 一般 › ログイン項目 で Turnlane をオフにしてください。",
          ),
        );
        failed++;
      }
    }
    // リンク（アプリの中を指すものだけ）
    for (const l of [join(env.paths.binDir, "turnlane"), bundledCliLinkPath(env.paths.dataDir)]) {
      if (linkTarget(l) === null) continue;
      env.out(`${pre}${tr("Delete", "削除")}: ${l}`);
      if (!o.dryRun) rmSync(l, { force: true });
    }
  }
  if (existsSync(installJsonPath(env.paths.dataDir))) {
    env.out(`${pre}${tr("Delete", "削除")}: ${installJsonPath(env.paths.dataDir)}`);
    if (!o.dryRun) rmSync(installJsonPath(env.paths.dataDir), { force: true });
  }
  env.out(
    tr(
      `Your data (${env.paths.dataDir}) and logs (${env.paths.logDir}) are kept. Move Turnlane.app to the Trash to finish.`,
      `データ（${env.paths.dataDir}）とログ（${env.paths.logDir}）は残しています。最後に Turnlane.app をゴミ箱に入れてください。`,
    ),
  );
  return failed > 0 ? 1 : 0;
}

// ---------- turnlane setup migrate ----------

export interface MigrateManifest {
  version: 1;
  at: number;
  app: string;
  /** 外した LaunchAgent（退避した plist の場所と、読み込まれていたか） */
  agents: { label: string; from: string; to: string; loaded: boolean }[];
  /** 退避したバイナリ */
  binaries: { from: string; to: string }[];
  /** ゴミ箱へ移したアプリ */
  apps: { from: string; to: string }[];
  /** 書き換えた hooks の設定ファイル */
  hooks: string[];
  /** 前の hooks・MCP の turnlane */
  previousCli: string;
  rolledBackAt: number | null;
}

export interface DevInstall {
  agents: { label: string; plist: string; exists: boolean; loaded: boolean; envVars: string[] }[];
  binaries: string[];
  apps: string[];
}

/** 開発時の配置を見つける（何も変えない） */
export function detectDevInstall(env: CliEnv, app: string): DevInstall {
  const agents = LABELS.map((label) => {
    const plist = join(env.paths.launchAgentsDir, `${label}.plist`);
    const exists = existsSync(plist);
    const text = exists ? readFileSync(plist, "utf8") : "";
    return {
      label,
      plist,
      exists,
      loaded: env.launchctl.print(label).loaded,
      envVars: LOCATION_VARS.filter((k) => text.includes(`<key>${k}</key>`)),
    };
  });
  const binaries = ["turnlane", "turnlaned"]
    .map((b) => join(env.paths.binDir, b))
    .filter((p) => {
      try {
        return lstatSync(p).isFile();
      } catch {
        return false;
      }
    });
  const apps = [DESKTOP_APP, CALENDAR_HELPER_APP]
    .map((a) => join(env.paths.home, "Applications", a))
    .filter((p) => existsSync(p) && resolve(p) !== resolve(app));
  return { agents, binaries, apps };
}

function legacyRoot(env: CliEnv): string {
  return join(env.paths.dataDir, "legacy");
}

function latestManifest(env: CliEnv): { dir: string; m: MigrateManifest } | null {
  const root = legacyRoot(env);
  if (!existsSync(root)) return null;
  const dirs = readdirSync(root)
    .filter((d) => existsSync(join(root, d, "manifest.json")))
    .sort();
  const last = dirs.at(-1);
  if (!last) return null;
  const dir = join(root, last);
  return {
    dir,
    m: JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as MigrateManifest,
  };
}

function saveManifest(dir: string, m: MigrateManifest): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(m, null, 2)}\n`, { mode: 0o600 });
}

function move(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true });
  renameSync(from, to);
}

export interface SetupMigrateOptions {
  dryRun: boolean;
  rollback?: boolean;
  app?: string | undefined;
  now?: number;
  appSetup?: AppSetupRunner;
  /** 旧のデーモンが止まったのを待つ上限（テストでは短く） */
  waitMs?: number;
}

export async function setupMigrate(env: CliEnv, o: SetupMigrateOptions): Promise<number> {
  return o.rollback ? rollback(env, o) : migrate(env, o);
}

async function migrate(env: CliEnv, o: SetupMigrateOptions): Promise<number> {
  const pre = o.dryRun ? "[dry-run] " : "";
  const step = (s: string) => env.out(`${pre}${s}`);
  const now = o.now ?? Date.now();
  const app = targetApp(env, o.app);
  // 0. 点検（何も変えない）
  if (!app || !isBundledApp(app)) {
    env.err(
      tr(
        "Turnlane.app (with turnlaned inside) not found. Run this from the turnlane inside the new Turnlane.app, or pass --app <path>.",
        "turnlaned の入った Turnlane.app が見つかりません。新しい Turnlane.app の中の turnlane から実行するか、--app <path> を付けてください。",
      ),
    );
    return 1;
  }
  if (app.includes("/AppTranslocation/") || app.startsWith("/Volumes/")) {
    env.err(
      tr(
        `${app} is not in Applications. Move Turnlane.app to /Applications first.`,
        `${app} は Applications にありません。先に Turnlane.app を /Applications に移してください。`,
      ),
    );
    return 1;
  }
  const moved = LOCATION_VARS.filter((k) => env.vars[k]);
  const dev = detectDevInstall(env, app);
  const relocated = dev.agents.flatMap((a) => a.envVars);
  if (moved.length > 0 || relocated.length > 0) {
    env.err(
      tr(
        `The data, logs, or port are moved with ${[...new Set([...moved, ...relocated])].join(", ")}. Turnlane.app only uses the default places, so nothing was changed.`,
        `${[...new Set([...moved, ...relocated])].join(", ")} でデータ・ログ・ポートの場所を変えています。Turnlane.app は既定の場所しか使えないので、何も変えていません。`,
      ),
    );
    return 1;
  }
  const oldCli = join(env.paths.binDir, "turnlane");
  const fixed = bundledCliLinkPath(env.paths.dataDir);
  const bundledCli = bundledBinary(app, "turnlane");
  const dir = join(legacyRoot(env), stamp(now));
  const m: MigrateManifest = {
    version: 1,
    at: now,
    app,
    agents: [],
    binaries: [],
    apps: [],
    hooks: [],
    previousCli: oldCli,
    rolledBackAt: null,
  };
  const helperInstalled = dev.agents.some(
    (a) => a.label === CALENDAR_HELPER_LABEL && (a.exists || a.loaded),
  );
  step(tr(`Move to the app: ${app}`, `アプリの配置に移す: ${app}`));

  // 1. 開発時の LaunchAgent を止めて外し、plist を退避する（アプリ → ヘルパ → デーモンの順）
  for (const a of dev.agents) {
    if (!a.exists && !a.loaded) continue;
    const to = join(dir, "LaunchAgents", `${a.label}.plist`);
    step(
      tr(`Stop ${a.label} and move its plist to ${to}`, `${a.label} を止め、plist を ${to} へ退避`),
    );
    if (o.dryRun) continue;
    if (a.loaded) bootoutAndWait(env.launchctl, a.label);
    if (a.exists) move(a.plist, to);
    m.agents.push({ label: a.label, from: a.plist, to, loaded: a.loaded });
    saveManifest(dir, m);
  }
  // 2. 旧のデーモンが応答しないことを確かめる（同じポートで新しいデーモンを起こすため）
  if (!o.dryRun) {
    const until = Date.now() + (o.waitMs ?? 10_000);
    while ((await fetchHealth(env.paths, 300)) && Date.now() < until) await Bun.sleep(200);
    if (await fetchHealth(env.paths, 300)) {
      env.err(
        tr(
          `Something still answers on port ${env.paths.port}. Stop it and run this again (finished steps are skipped).`,
          `ポート ${env.paths.port} でまだ何かが応答しています。止めてからもう一度実行してください（済んだ段は飛ばします）。`,
        ),
      );
      return 1;
    }
  }
  // 3. 固定の場所（hooks・MCP が書く turnlane）をアプリの中の turnlane へのリンクに
  step(`${fixed} → ${bundledCli}`);
  if (!o.dryRun) makeLink(fixed, bundledCli);
  // 4. ~/.local/bin のバイナリを退避し、turnlane はアプリの中の turnlane へのリンクに
  for (const b of dev.binaries) {
    const to = join(dir, "bin", b.slice(b.lastIndexOf("/") + 1));
    step(tr(`Move ${b} to ${to}`, `${b} を ${to} へ退避`));
    if (o.dryRun) continue;
    move(b, to);
    m.binaries.push({ from: b, to });
    saveManifest(dir, m);
  }
  if (!pointsTo(oldCli, bundledCli)) {
    step(`${oldCli} → ${bundledCli}`);
    if (!o.dryRun) makeLink(oldCli, bundledCli);
  }
  // 5. hooks を固定の場所に書き換える（Turnlane のエントリがあるファイルだけ。書き換え前に退避）
  const suffix = `.bak-turnlane-${stamp(now)}`;
  const h = rewriteHooks(env, fixed, { dryRun: o.dryRun, suffix, pre });
  if (!o.dryRun) {
    m.hooks = h.changed;
    saveManifest(dir, m);
  }
  // 6. MCP の登録を固定の場所に（登録の無いところには足さない）
  refreshMcpPaths(env, fixed, { dryRun: o.dryRun, now, step });
  // 7. 開発時のアプリとヘルパをゴミ箱へ
  for (const a of dev.apps) {
    const to = join(
      env.paths.home,
      ".Trash",
      `${a.slice(a.lastIndexOf("/") + 1, -4)}-${stamp(now)}.app`,
    );
    step(tr(`Move ${a} to the Trash`, `${a} をゴミ箱へ`));
    if (o.dryRun) continue;
    move(a, to);
    m.apps.push({ from: a, to });
    saveManifest(dir, m);
  }
  // 8. install.json と常駐の登録（アプリのプロセスで）
  step(tr("Register Turnlane's background items (SMAppService)", "常駐を登録する（SMAppService）"));
  if (!o.dryRun) {
    writeInstallInfo(env.paths.dataDir, { mode: "app", appPath: app, version: "", writtenAt: now });
    saveManifest(dir, m);
    const run = o.appSetup ?? systemAppSetup;
    const items = ["daemon", "mainApp", ...(helperInstalled ? ["calendarHelper"] : [])];
    const bad = items.filter((it) => run(app, ["register", it]).code !== 0);
    if (bad.length > 0)
      env.out(
        tr(
          `Couldn't register ${bad.join(", ")} from here. Open ${app}; it registers them when it starts.`,
          `${bad.join(", ")} をここから登録できませんでした。${app} を開いてください（起動したときに登録します）。`,
        ),
      );
    else {
      const ok = await waitForHealth(env.paths, o.waitMs ?? 15_000);
      env.out(
        ok
          ? tr(
              `turnlaned ${ok.version} is running from the app`,
              `アプリの turnlaned ${ok.version} が動いています`,
            )
          : tr(
              "turnlaned hasn't answered yet. Open Turnlane.app; if it asks, turn Turnlane on in System Settings › General › Login Items.",
              "turnlaned がまだ応答しません。Turnlane.app を開き、求められたら システム設定 › 一般 › ログイン項目 で Turnlane をオンにしてください。",
            ),
      );
    }
  }
  // 9. 案内
  const notes = [
    tr(
      "macOS may ask for calendar, notification, and automation access again.",
      "カレンダー・通知・オートメーションの許可を、macOS がもう一度聞くことがあります。",
    ),
    ...(helperInstalled
      ? [
          tr(
            "Calendar: if events don't show, open Settings › Calendar and press Connect calendar.",
            "カレンダー: 予定が出なければ、設定 › カレンダー の「カレンダーをつなぐ」を押してください。",
          ),
        ]
      : []),
    ...(h.codex
      ? [
          tr(
            "Codex: the hook command changed, so approve the Turnlane hooks again with /hooks.",
            "Codex: hook のコマンドが変わったので、/hooks で Turnlane の hook を承認し直してください。",
          ),
        ]
      : []),
    tr("Run hash -r in open shells.", "開いているシェルでは hash -r を実行してください。"),
    tr(
      `To undo: ${bundledCli} setup migrate --rollback`,
      `戻すとき: ${bundledCli} setup migrate --rollback`,
    ),
  ];
  for (const n of notes) env.out(`${pre}${n}`);
  if (o.dryRun) env.out(tr("(dry run: nothing was changed)", "（dry-run: 何も変えていません）"));
  return h.failed > 0 ? 1 : 0;
}

async function rollback(env: CliEnv, o: SetupMigrateOptions): Promise<number> {
  const pre = o.dryRun ? "[dry-run] " : "";
  const step = (s: string) => env.out(`${pre}${s}`);
  const found = latestManifest(env);
  if (!found || found.m.rolledBackAt !== null) {
    env.err(tr("No migration to undo.", "戻す移行がありません。"));
    return 1;
  }
  const { dir, m } = found;
  const now = o.now ?? Date.now();
  // 1. アプリの常駐の登録を外す（同じラベルの LaunchAgent を戻す前に）
  step(tr(`Unregister the background items of ${m.app}`, `${m.app} の常駐の登録を外す`));
  if (!o.dryRun) {
    if ((o.appSetup ?? systemAppSetup)(m.app, ["unregister-all"]).code !== 0)
      env.out(
        tr(
          "Couldn't unregister from here. Turn Turnlane off in System Settings › General › Login Items afterwards.",
          "ここから外せませんでした。後で システム設定 › 一般 › ログイン項目 で Turnlane をオフにしてください。",
        ),
      );
    for (const l of [DAEMON_LABEL, CALENDAR_HELPER_LABEL])
      if (env.launchctl.print(l).loaded) bootoutAndWait(env.launchctl, l);
  }
  // 2. バイナリ・アプリを戻す
  const cliLink = join(env.paths.binDir, "turnlane");
  if (linkTarget(cliLink) !== null) {
    step(`${tr("Delete", "削除")}: ${cliLink}`);
    if (!o.dryRun) rmSync(cliLink, { force: true });
  }
  for (const x of [...m.binaries, ...m.apps]) {
    step(tr(`Put back ${x.from}`, `${x.from} を戻す`));
    if (!o.dryRun && existsSync(x.to) && !existsSync(x.from)) move(x.to, x.from);
  }
  // 3. hooks・MCP を前の turnlane に
  rewriteHooks(env, m.previousCli, {
    dryRun: o.dryRun,
    suffix: `.bak-turnlane-${stamp(now)}`,
    pre,
  });
  refreshMcpPaths(env, m.previousCli, { dryRun: o.dryRun, now, step });
  // 4. LaunchAgent を戻して読み込む（デーモン → ヘルパ → アプリ）
  for (const a of [...m.agents].reverse()) {
    step(tr(`Put back ${a.from} and load it`, `${a.from} を戻して読み込む`));
    if (o.dryRun) continue;
    if (existsSync(a.to) && !existsSync(a.from)) move(a.to, a.from);
    if (a.loaded && existsSync(a.from))
      reloadService(env.launchctl, a.label, a.from, { retryHint: "turnlane daemon start" });
  }
  const fixed = bundledCliLinkPath(env.paths.dataDir);
  if (linkTarget(fixed) !== null) {
    step(`${tr("Delete", "削除")}: ${fixed}`);
    if (!o.dryRun) rmSync(fixed, { force: true });
  }
  if (!o.dryRun) {
    writeInstallInfo(env.paths.dataDir, {
      mode: "dev",
      appPath: null,
      version: "",
      writtenAt: now,
    });
    saveManifest(dir, { ...m, rolledBackAt: now });
  }
  env.out(
    tr(
      `Back to the developer install. Remove ${m.app} if you don't need it.`,
      `開発時の配置に戻しました。不要なら ${m.app} を削除してください。`,
    ),
  );
  return 0;
}
