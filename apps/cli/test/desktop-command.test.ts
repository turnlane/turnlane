import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DESKTOP_LABEL, resolvePaths, type TurnlanePaths } from "@turnlane/core";
import {
  buildDesktopPlist,
  desktopAppPath,
  desktopCommand,
  desktopLines,
  desktopPlistPath,
} from "../src/commands/desktop.ts";
import type { CliEnv } from "../src/env.ts";
import { FakeLaunchctl } from "../src/launchctl.ts";

let home: string;
let src: string;
let paths: TurnlanePaths;
let out: string[];
let errs: string[];
let launchctl: FakeLaunchctl;

function env(): CliEnv {
  return {
    paths,
    launchctl,
    out: (s) => out.push(s),
    err: (s) => errs.push(s),
    execPath: join(src, "turnlane"),
    vars: { HOME: home, TURNLANE_PORT: "27999" },
  };
}

/** 中身が実行ファイル1つだけの偽の Turnlane.app */
function fakeApp(dir: string): string {
  const app = join(dir, "Turnlane.app");
  mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
  writeFileSync(join(app, "Contents", "MacOS", "turnlane"), "#!/bin/sh\n", { mode: 0o755 });
  return app;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "turnlane-desktop-"));
  src = join(home, "build-out");
  mkdirSync(src);
  paths = resolvePaths({ HOME: home, TURNLANE_PORT: "27999" }, home);
  out = [];
  errs = [];
  launchctl = new FakeLaunchctl(() => DESKTOP_LABEL);
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("turnlane desktop（desktop-shell.md 6.2）", () => {
  test("LaunchAgent: ログイン時に1回起動し、⌘Q の後は起こさない。--background でメニューバーだけ。TURNLANE_PORT を引き継ぐ", () => {
    const p = buildDesktopPlist(env());
    expect(p).toContain(
      `<string>${home}/Applications/Turnlane.app/Contents/MacOS/turnlane</string>`,
    );
    expect(p).toContain("<string>--background</string>");
    expect(p).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(p).toMatch(/<key>KeepAlive<\/key>\s*<false\/>/);
    expect(p).toContain("<string>Aqua</string>");
    expect(p).toMatch(/<key>TURNLANE_PORT<\/key>\s*<string>27999<\/string>/);
  });

  test("install: ~/Applications へ写し、plist を書いて登録する。uninstall で消す", async () => {
    fakeApp(src);
    expect(await desktopCommand(env(), "install", {})).toBe(0);
    expect(existsSync(join(desktopAppPath(env()), "Contents", "MacOS", "turnlane"))).toBe(true);
    expect(readFileSync(desktopPlistPath(env()), "utf8")).toContain(DESKTOP_LABEL);
    expect(launchctl.calls).toEqual([`bootstrap ${desktopPlistPath(env())}`]);
    // 入れ替え: 登録済みなら外してから登録し直す
    expect(await desktopCommand(env(), "install", {})).toBe(0);
    expect(launchctl.calls.slice(1)).toEqual([
      `bootout ${DESKTOP_LABEL}`,
      `bootstrap ${desktopPlistPath(env())}`,
    ]);
    expect(await desktopCommand(env(), "uninstall", {})).toBe(0);
    expect(existsSync(desktopAppPath(env()))).toBe(false);
    expect(existsSync(desktopPlistPath(env()))).toBe(false);
  });

  test("--dry-run は何も書かない。.app が無ければ失敗する", async () => {
    fakeApp(src);
    expect(await desktopCommand(env(), "install", { dryRun: true })).toBe(0);
    expect(existsSync(desktopAppPath(env()))).toBe(false);
    expect(launchctl.calls).toEqual([]);
    rmSync(join(src, "Turnlane.app"), { recursive: true });
    expect(await desktopCommand(env(), "install", {})).toBe(1);
    expect(errs.join("\n")).toContain("build:desktop");
  });

  test("status の表示: 未インストール、接続中、ホットキーが登録できないとき", () => {
    expect(
      desktopLines({
        installed: false,
        signature: null,
        launchAgent: { loaded: false, running: false },
        connected: false,
        app: null,
      }),
    ).toEqual(["Desktop app: not installed (turnlane desktop install)"]);
    const lines = desktopLines({
      installed: true,
      signature: "Apple Development",
      launchAgent: { loaded: true, running: true },
      connected: true,
      app: {
        version: "0.1.0",
        notifications: "denied",
        shortcut: { accelerator: "Alt+Shift+Space", registered: false },
      },
    });
    expect(lines[0]).toContain("Apple Development signature");
    expect(lines[1]).toContain(
      "Notifications: Off — allow them in System Settings > Notifications > Turnlane",
    );
    expect(lines[1]).not.toContain("denied");
    expect(lines[1]).toContain("turnlane config set desktop.quick_add_shortcut");
  });

  test("通知の許可は生の値を出さない（D-080）", () => {
    const line = (notifications: "granted" | "not_determined" | "unknown" | "unsupported") =>
      desktopLines({
        installed: true,
        signature: "Apple Development",
        launchAgent: { loaded: true, running: true },
        connected: true,
        app: {
          version: "0.1.0",
          notifications,
          shortcut: { accelerator: "Alt+Shift+Space", registered: true },
        },
      })[1] as string;
    expect(line("granted")).toContain("Notifications: On ·");
    expect(line("not_determined")).toContain("Notifications: Not set — ");
    expect(line("not_determined")).toContain("Ask for permission");
    expect(line("unknown")).toContain("Notifications: Checking");
    expect(line("unsupported")).toContain("Notifications: Not available");
    for (const n of ["granted", "not_determined", "unknown", "unsupported"] as const)
      expect(line(n)).not.toContain(n);
  });
});
