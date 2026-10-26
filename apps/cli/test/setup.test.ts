/**
 * 配布版の配置（M6-15・M6-16）: 開発用のコマンドを止める・turnlane link・uninstall --all・setup migrate とその戻し。
 * 一時 HOME と偽の launchctl・偽のアプリの登録で確かめる（launchd・SMAppService・実の設定には触れない）
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bundledCliLinkPath,
  CALENDAR_HELPER_LABEL,
  DAEMON_LABEL,
  DESKTOP_LABEL,
  readInstallInfo,
  resolvePaths,
  type TurnlanePaths,
  writeInstallInfo,
} from "@turnlane/core";
import { claudePlan, install as installHooks } from "@turnlane/core/hooks";
import { freePort } from "../../daemon/test/helpers/port.ts";
import {
  type AppSetupRunner,
  linkCommand,
  setupMigrate,
  uninstallAll,
} from "../src/commands/setup.ts";
import type { CliEnv } from "../src/env.ts";
import { FakeLaunchctl } from "../src/launchctl.ts";
import { runCommand } from "../src/run.ts";

let home: string;
let paths: TurnlanePaths;
let app: string;
let out: string[];
let errs: string[];
let lc: FakeLaunchctl;
let calls: string[][];

const labelOf = (p: string) => p.slice(p.lastIndexOf("/") + 1, -".plist".length);
const appSetup: AppSetupRunner = (_app, args) => {
  calls.push(args);
  return { code: 0, out: "{}" };
};

function env(execPath = join(app, "Contents", "Helpers", "turnlane"), vars = {}): CliEnv {
  return {
    paths,
    launchctl: lc,
    out: (s) => out.push(s),
    err: (s) => errs.push(s),
    execPath,
    vars: { HOME: home, PATH: "/usr/bin", ...vars },
  };
}

function settings(): string {
  return join(home, ".claude", "settings.json");
}

/** 開発時の配置（self-install の後の形） */
function devLayout(o: { helper?: boolean; plistEnv?: string } = {}) {
  const la = join(home, "Library", "LaunchAgents");
  mkdirSync(la, { recursive: true });
  for (const l of [DAEMON_LABEL, DESKTOP_LABEL, ...(o.helper ? [CALENDAR_HELPER_LABEL] : [])]) {
    const extra =
      o.plistEnv && l === DAEMON_LABEL ? `<key>${o.plistEnv}</key><string>/x</string>` : "";
    writeFileSync(
      join(la, `${l}.plist`),
      `<plist><dict><key>Label</key><string>${l}</string>${extra}</dict></plist>`,
    );
    lc.bootstrap(join(la, `${l}.plist`));
  }
  const bin = join(home, ".local", "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "turnlane"), "old cli");
  writeFileSync(join(bin, "turnlaned"), "old daemon");
  for (const a of ["Turnlane.app", ...(o.helper ? ["TurnlaneCalendarHelper.app"] : [])])
    mkdirSync(join(home, "Applications", a, "Contents"), { recursive: true });
  mkdirSync(join(home, ".claude"), { recursive: true });
  const { next } = installHooks({ theme: "dark" }, claudePlan(join(bin, "turnlane")));
  writeFileSync(settings(), JSON.stringify(next, null, 2));
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "turnlane-setup-"));
  paths = resolvePaths({ HOME: home, TURNLANE_PORT: String(freePort()) }, home);
  app = join(home, "Apps", "Turnlane.app");
  mkdirSync(join(app, "Contents", "Helpers"), { recursive: true });
  for (const b of ["turnlane", "turnlaned"]) writeFileSync(join(app, "Contents", "Helpers", b), "");
  out = [];
  errs = [];
  lc = new FakeLaunchctl(labelOf);
  calls = [];
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("配置の方式が app のとき", () => {
  test("開発用のコマンド（self-install・calendar install・desktop install・uninstall）を止める", async () => {
    writeInstallInfo(paths.dataDir, { mode: "app", appPath: app, version: "x", writtenAt: 0 });
    for (const args of [
      ["self-install"],
      ["calendar", "install"],
      ["desktop", "install"],
      ["uninstall"],
    ]) {
      errs = [];
      const [cmd, ...rest] = args as [string, ...string[]];
      expect(await runCommand(cmd, rest, env())).toBe(1);
      expect(errs.join("\n")).toContain("Turnlane.app");
    }
    expect(lc.calls).toEqual([]);
  });

  test("turnlane link: ~/.local/bin/turnlane をアプリの中の turnlane へのリンクに。実体のファイルは置き換えない", () => {
    expect(linkCommand(env(), { dryRun: false })).toBe(0);
    const link = join(home, ".local", "bin", "turnlane");
    expect(readlinkSync(link)).toBe(join(app, "Contents", "Helpers", "turnlane"));
    rmSync(link);
    writeFileSync(link, "binary");
    expect(linkCommand(env(), { dryRun: false })).toBe(1);
    expect(readFileSync(link, "utf8")).toBe("binary");
  });
});

describe("turnlane setup migrate（M6-16）", () => {
  test("--dry-run は何も変えずに手順を出す", async () => {
    devLayout({ helper: true });
    const before = readFileSync(settings(), "utf8");
    expect(await setupMigrate(env(), { dryRun: true, appSetup, now: 1_000 })).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("[dry-run]");
    expect(text).toContain(DAEMON_LABEL);
    expect(text).toContain("Trash");
    expect(readFileSync(settings(), "utf8")).toBe(before);
    expect(existsSync(join(home, "Library", "LaunchAgents", `${DAEMON_LABEL}.plist`))).toBe(true);
    expect(existsSync(join(home, ".local", "bin", "turnlaned"))).toBe(true);
    expect(lc.calls.filter((c) => c.startsWith("bootout"))).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("移す: エージェントを止めて退避、バイナリを退避してリンク、hooks を固定の場所に、アプリをゴミ箱へ、登録", async () => {
    devLayout({ helper: true });
    expect(await setupMigrate(env(), { dryRun: false, appSetup, now: 1_000, waitMs: 100 })).toBe(0);
    for (const l of [DAEMON_LABEL, DESKTOP_LABEL, CALENDAR_HELPER_LABEL]) {
      expect(existsSync(join(home, "Library", "LaunchAgents", `${l}.plist`))).toBe(false);
      expect(lc.print(l).loaded).toBe(false);
    }
    const legacy = join(paths.dataDir, "legacy", "19700101T000001Z");
    expect(existsSync(join(legacy, "LaunchAgents", `${DAEMON_LABEL}.plist`))).toBe(true);
    expect(readFileSync(join(legacy, "bin", "turnlaned"), "utf8")).toBe("old daemon");
    const bundled = join(app, "Contents", "Helpers", "turnlane");
    expect(readlinkSync(join(home, ".local", "bin", "turnlane"))).toBe(bundled);
    expect(existsSync(join(home, ".local", "bin", "turnlaned"))).toBe(false);
    expect(readlinkSync(bundledCliLinkPath(paths.dataDir))).toBe(bundled);
    // hooks は固定の場所を指す（他の設定はそのまま）。書き換え前を退避
    const s = readFileSync(settings(), "utf8");
    expect(s).toContain(bundledCliLinkPath(paths.dataDir));
    expect(s).not.toContain(join(home, ".local", "bin", "turnlane"));
    expect(JSON.parse(s).theme).toBe("dark");
    expect(existsSync(`${settings()}.bak-turnlane-19700101T000001Z`)).toBe(true);
    // アプリはゴミ箱へ（消さない）
    expect(existsSync(join(home, "Applications", "Turnlane.app"))).toBe(false);
    expect(existsSync(join(home, ".Trash", "Turnlane-19700101T000001Z.app"))).toBe(true);
    expect(readInstallInfo(paths.dataDir)).toMatchObject({ mode: "app", appPath: app });
    expect(calls).toEqual([
      ["register", "daemon"],
      ["register", "mainApp"],
      ["register", "calendarHelper"],
    ]);
    // もう一度実行しても壊れない（済んだ段は飛ばす）
    out = [];
    expect(await setupMigrate(env(), { dryRun: false, appSetup, now: 2_000, waitMs: 100 })).toBe(0);
    expect(readlinkSync(join(home, ".local", "bin", "turnlane"))).toBe(bundled);
  });

  test("--rollback: 登録を外し、バイナリ・アプリ・plist・hooks を戻して読み込む", async () => {
    devLayout({ helper: true });
    const before = JSON.parse(readFileSync(settings(), "utf8"));
    await setupMigrate(env(), { dryRun: false, appSetup, now: 1_000, waitMs: 100 });
    calls = [];
    expect(await setupMigrate(env(), { dryRun: false, rollback: true, appSetup, now: 3_000 })).toBe(
      0,
    );
    expect(calls).toEqual([["unregister-all"]]);
    expect(readFileSync(join(home, ".local", "bin", "turnlane"), "utf8")).toBe("old cli");
    expect(readFileSync(join(home, ".local", "bin", "turnlaned"), "utf8")).toBe("old daemon");
    expect(existsSync(join(home, "Applications", "Turnlane.app"))).toBe(true);
    expect(existsSync(join(home, "Applications", "TurnlaneCalendarHelper.app"))).toBe(true);
    for (const l of [DAEMON_LABEL, DESKTOP_LABEL, CALENDAR_HELPER_LABEL]) {
      expect(existsSync(join(home, "Library", "LaunchAgents", `${l}.plist`))).toBe(true);
      expect(lc.print(l).loaded).toBe(true);
    }
    expect(JSON.parse(readFileSync(settings(), "utf8"))).toEqual(before);
    expect(existsSync(bundledCliLinkPath(paths.dataDir))).toBe(false);
    expect(readInstallInfo(paths.dataDir)?.mode).toBe("dev");
    // 2回は戻さない
    expect(await setupMigrate(env(), { dryRun: false, rollback: true, appSetup })).toBe(1);
  });

  test("場所を変えている（plist か環境変数）・アプリが見つからないときは何も変えずに止まる", async () => {
    devLayout({ plistEnv: "TURNLANE_DATA_DIR" });
    expect(await setupMigrate(env(), { dryRun: false, appSetup })).toBe(1);
    expect(errs.join("\n")).toContain("TURNLANE_DATA_DIR");
    expect(existsSync(join(home, ".local", "bin", "turnlaned"))).toBe(true);
    errs = [];
    expect(
      await setupMigrate(env(undefined, { TURNLANE_PORT: "27317" }), { dryRun: false, appSetup }),
    ).toBe(1);
    errs = [];
    expect(await setupMigrate(env(join(home, "x", "turnlane")), { dryRun: false, appSetup })).toBe(
      1,
    );
    expect(errs.join("\n")).toContain("Turnlane.app");
    expect(calls).toEqual([]);
  });
});

describe("turnlane uninstall --all", () => {
  test("hooks の Turnlane のエントリ・リンク・install.json を外し、登録を外す。データは残す", async () => {
    devLayout();
    await setupMigrate(env(), { dryRun: false, appSetup, now: 1_000, waitMs: 100 });
    calls = [];
    expect(await uninstallAll(env(), { dryRun: false, appSetup, now: 5_000 })).toBe(0);
    const s = JSON.parse(readFileSync(settings(), "utf8"));
    expect(s.hooks).toBeUndefined();
    expect(s.theme).toBe("dark");
    expect(existsSync(join(home, ".local", "bin", "turnlane"))).toBe(false);
    expect(existsSync(bundledCliLinkPath(paths.dataDir))).toBe(false);
    expect(readInstallInfo(paths.dataDir)).toBeNull();
    expect(calls).toEqual([["unregister-all"]]);
    expect(existsSync(paths.dataDir)).toBe(true);
  });
});
