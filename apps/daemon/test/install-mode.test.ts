/** 配置の方式（M6-15・M6-17。ADR 0011 の決定 4・5・7）: install.json・固定の場所のリンク・バンドルの版の監視・Install ▸ */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nullLogger } from "@turnlane/collectors";
import {
  bundledCliLinkPath,
  detectInstall,
  installStatus,
  readInstallInfo,
  resolvePaths,
} from "@turnlane/core";
import {
  CalendarConnectError,
  cliCalendarConnect,
  summarizeStderr,
} from "../src/calendar/connect.ts";
import {
  bundleBuild,
  bundledHelperVersion,
  ensureSymlink,
  InstallService,
  plistString,
} from "../src/install/index.ts";
import { bundleAgentPlist } from "../src/launchd/plist.ts";
import { type RunningDaemon, startDaemon } from "../src/main.ts";

let home: string;
let app: string;
let dataDir: string;

function fakeApp(build: string) {
  mkdirSync(join(app, "Contents", "Helpers"), { recursive: true });
  writeFileSync(join(app, "Contents", "Helpers", "turnlane"), "#!/bin/sh\n");
  writeFileSync(
    join(app, "Contents", "Info.plist"),
    `<plist><dict><key>CFBundleShortVersionString</key><string>0.7.0</string><key>TurnlaneBuild</key><string>${build}</string></dict></plist>`,
  );
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "turnlane-install-mode-"));
  app = join(home, "Applications", "Turnlane.app");
  dataDir = join(home, "Library", "Application Support", "turnlane");
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function svc(o: Partial<ConstructorParameters<typeof InstallService>[0]> = {}) {
  return new InstallService({
    mode: "app",
    appPath: app,
    dataDir,
    home,
    version: "0.7.0+abc",
    logger: nullLogger,
    now: () => 1000,
    pathVar: "/usr/bin",
    homebrewCandidates: [],
    ...o,
  });
}

describe("配置の方式の判定", () => {
  test("Turnlane.app/Contents/Helpers/<名前> なら app、それ以外は dev", () => {
    expect(detectInstall("/Applications/Turnlane.app/Contents/Helpers/turnlaned")).toEqual({
      mode: "app",
      appPath: "/Applications/Turnlane.app",
    });
    expect(detectInstall("/Users/a/.local/bin/turnlaned")).toEqual({ mode: "dev", appPath: null });
    expect(detectInstall("/x/Helpers/turnlaned")).toEqual({ mode: "dev", appPath: null });
    expect(detectInstall(null)).toEqual({ mode: "dev", appPath: null });
  });

  test("Info.plist の TurnlaneBuild（無ければ短い版）を読む", () => {
    fakeApp("0.7.0+abc");
    expect(bundleBuild(app)).toBe("0.7.0+abc");
    expect(plistString("<key>A</key> <string>x</string>", "A")).toBe("x");
    expect(bundleBuild(join(home, "none.app"))).toBeNull();
  });
});

describe("InstallService", () => {
  test("start: install.json（600）を書き、固定の場所をアプリの中の turnlane へのリンクにする", () => {
    fakeApp("0.7.0+abc");
    const s = svc();
    s.start();
    s.stop();
    const info = readInstallInfo(dataDir);
    expect(info).toMatchObject({ mode: "app", appPath: app, version: "0.7.0+abc" });
    expect(lstatSync(join(dataDir, "install.json")).mode & 0o777).toBe(0o600);
    const link = bundledCliLinkPath(dataDir);
    expect(readlinkSync(link)).toBe(join(app, "Contents", "Helpers", "turnlane"));
    expect(s.hooksCli).toBe(link);
    expect(s.status().cli.fixedLink.ok).toBe(true);
  });

  test("アプリを動かしたら次の起動でリンク先を合わせ直す（hooks の command は変わらない）", () => {
    fakeApp("b1");
    svc().start();
    const moved = join(home, "Other", "Turnlane.app");
    mkdirSync(join(moved, "Contents", "Helpers"), { recursive: true });
    const s2 = svc({ appPath: moved });
    s2.start();
    s2.stop();
    expect(readlinkSync(bundledCliLinkPath(dataDir))).toBe(
      join(moved, "Contents", "Helpers", "turnlane"),
    );
    expect(s2.hooksCli).toBe(bundledCliLinkPath(dataDir));
  });

  test("dev: install.json の方式だけ書き、リンクは作らない。hooks の turnlane は今までどおり", () => {
    const s = svc({ mode: "dev", appPath: null });
    s.start();
    expect(readInstallInfo(dataDir)?.mode).toBe("dev");
    expect(() => lstatSync(bundledCliLinkPath(dataDir))).toThrow();
    expect(s.hooksCli).toBeNull();
  });

  test("バンドルの版が変わったら終わる（読めない間は待つ）", () => {
    fakeApp("b1");
    let exited = 0;
    let build: string | null = "b1";
    const s = svc({ readBuild: () => build, exit: () => exited++ });
    expect(s.checkBundle("b1")).toBe(false);
    build = null;
    expect(s.checkBundle("b1")).toBe(false);
    build = "b2";
    expect(s.checkBundle("b1")).toBe(true);
    expect(exited).toBe(1);
  });

  test("ヘルパの版の入れ替え: 動いている版が同梱の版と違えば登録をし直す（同じ組み合わせは1回だけ）", async () => {
    let running: string | null = null;
    const calls: string[] = [];
    let ok = true;
    const s = svc({
      helperVersion: () => running,
      reregisterHelper: async (a) => {
        calls.push(a);
        return ok;
      },
    });
    // 同梱のヘルパの Info.plist
    const plist = join(app, "Contents/Library/LoginItems/TurnlaneCalendarHelper.app/Contents");
    mkdirSync(plist, { recursive: true });
    writeFileSync(
      join(plist, "Info.plist"),
      "<plist><dict><key>CFBundleShortVersionString</key><string>0.8.0</string></dict></plist>",
    );
    expect(bundledHelperVersion(app)).toBe("0.8.0");
    // 未接続・同じ版では何もしない
    expect(await s.checkHelper()).toBe(false);
    running = "0.8.0";
    expect(await s.checkHelper()).toBe(false);
    // 古いヘルパが動いたまま → し直す。同じ組み合わせでは繰り返さない（失敗しても）
    running = "0.7.0";
    ok = false;
    expect(await s.checkHelper()).toBe(false);
    expect(await s.checkHelper()).toBe(false);
    expect(calls).toEqual([app]);
    // 別の組み合わせなら試す
    running = "0.6.0";
    ok = true;
    expect(await s.checkHelper()).toBe(true);
    expect(calls).toEqual([app, app]);
    // dev（開発時の配置）では触らない。同梱のヘルパが無ければ何もしない
    expect(
      await svc({ mode: "dev", appPath: null, helperVersion: () => "0.1.0" }).checkHelper(),
    ).toBe(false);
    rmSync(plist, { recursive: true });
    expect(
      await svc({ helperVersion: () => "0.1.0", reregisterHelper: async () => true }).checkHelper(),
    ).toBe(false);
  });

  test("ビルドが前回と違えば、カレンダーヘルパの登録を 1 回し直す（ad-hoc の置き換え。2026-10-21 の Neo）", async () => {
    const calls: string[] = [];
    const s = svc({
      reregisterHelper: async (a) => {
        calls.push(a);
        return true;
      },
    });
    mkdirSync(dataDir, { recursive: true });
    // 記録が無い（この仕組みの前の版から更新した）ときもし直す
    expect(await s.reregisterOnBuildChange("0.7.0+aaa")).toBe(true);
    expect(readFileSync(join(dataDir, "helper-build"), "utf8").trim()).toBe("0.7.0+aaa");
    // 同じビルドでは繰り返さない
    expect(await s.reregisterOnBuildChange("0.7.0+aaa")).toBe(false);
    // 同じ版の別のビルド（zip で置き換えた）
    expect(await s.reregisterOnBuildChange("0.7.0+bbb")).toBe(true);
    expect(calls).toEqual([app, app]);
    // 開発時の配置では触らない
    expect(await svc({ mode: "dev", appPath: null }).reregisterOnBuildChange("x")).toBe(false);
  });

  test("Install ▸: ~/.local/bin/turnlane をリンクにする。開発時のバイナリがあれば置き換えない", () => {
    fakeApp("b1");
    const s = svc({ pathVar: `/usr/bin:${join(home, ".local", "bin")}` });
    const r = s.installCliLink();
    expect(r.ok).toBe(true);
    expect(r.status.cli.localBin).toMatchObject({ linked: true, inPath: true });
    // もう一度押しても同じ
    expect(s.installCliLink().ok).toBe(true);
    // 実体のファイルは置き換えない
    const local = join(home, ".local", "bin", "turnlane");
    rmSync(local);
    writeFileSync(local, "binary");
    expect(s.installCliLink()).toMatchObject({ ok: false, reason: "occupied" });
    expect(readFileSync(local, "utf8")).toBe("binary");
    expect(svc({ mode: "dev", appPath: null }).installCliLink().reason).toBe("not_app");
  });

  test("Homebrew の binary があれば homebrew（Install ▸ を出さない）", () => {
    const st = installStatus({
      mode: "app",
      appPath: app,
      version: "x",
      dataDir,
      home,
      pathVar: "",
      exists: (p) => p === "/opt/homebrew/bin/turnlane",
    });
    expect(st.cli.homebrew).toBe(true);
  });

  test("ensureSymlink: 新規・更新・同じ", () => {
    const l = join(home, "l");
    expect(ensureSymlink(l, "/a")).toBe("created");
    expect(ensureSymlink(l, "/a")).toBe("unchanged");
    expect(ensureSymlink(l, "/b")).toBe("updated");
  });
});

describe("バンドルの LaunchAgent", () => {
  test("BundleProgram は相対、利用者ごとの値（ログ・環境変数の場所）を書かない", () => {
    const x = bundleAgentPlist({
      label: "dev.turnlane.daemon",
      bundleProgram: "Contents/Helpers/turnlaned",
      associatedBundleId: "dev.turnlane.desktop",
      keepAlive: true,
    });
    expect(x).toContain(
      "<key>BundleProgram</key>\n    <string>Contents/Helpers/turnlaned</string>",
    );
    expect(x).toContain("<string>dev.turnlane.desktop</string>");
    expect(x).not.toContain("ProgramArguments");
    expect(x).not.toContain("/Users/");
    expect(x).not.toContain("TURNLANE_");
    const p = Bun.spawnSync(["/usr/bin/plutil", "-lint", "-"], {
      stdin: new TextEncoder().encode(x),
    });
    expect(p.exitCode).toBe(0);
  });
});

describe("API", () => {
  let d: RunningDaemon | null = null;
  afterEach(async () => {
    await d?.stop();
    d = null;
  });

  test("GET /api/install と POST /api/install/cli-link。app なら MCP・hooks に固定の場所を書く", async () => {
    fakeApp("b1");
    const paths = resolvePaths({ HOME: home }, home);
    d = await startDaemon({
      paths,
      logger: nullLogger,
      port: 0,
      onboarding: { assumeDone: true },
      install: {
        mode: "app",
        appPath: app,
        pathVar: "",
        homebrewCandidates: [],
        readBuild: () => "b1",
      },
    });
    const call = (m: string, p: string) =>
      fetch(`${d?.url}/api${p}`, {
        method: m,
        headers: { authorization: `Bearer ${d?.token}` },
      }).then((r) => r.json() as Promise<Record<string, unknown>>);
    const st = await call("GET", "/install");
    expect(st).toMatchObject({ mode: "app", appPath: app });
    const r = await call("POST", "/install/cli-link");
    expect(r.ok).toBe(true);
    // 同意した取り込み元に書く turnlane は固定の場所
    const plan = (await fetch(`${d.url}/api/onboarding/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${d.token}`, "content-type": "application/json" },
      body: JSON.stringify({ dryRun: true }),
    }).then((x) => x.json())) as { cli: string };
    expect(plan.cli).toBe(bundledCliLinkPath(paths.dataDir));
  });
});

describe("カレンダーの接続（O4）", () => {
  test("開発時の配置は calendar install → authorize。配布版はアプリが登録した後なので authorize --app <同梱のヘルパ> だけ", async () => {
    const runs: string[][] = [];
    const run = async (argv: string[]) => {
      runs.push(argv);
      return { code: 0, stderr: "" };
    };
    await cliCalendarConnect({ cli: "/t", logger: nullLogger, run })();
    expect(runs).toEqual([
      ["/t", "calendar", "install"],
      ["/t", "calendar", "authorize"],
    ]);
    runs.length = 0;
    await cliCalendarConnect({ cli: "/t", logger: nullLogger, run, bundledHelper: "/A/H.app" })();
    expect(runs).toEqual([["/t", "calendar", "authorize", "--app", "/A/H.app"]]);
  });

  test("許可の後、常駐のヘルパがフルアクセスでつながらなければ起こし直す（2026-10-21 の Neo）", async () => {
    const ok = async () => ({ code: 0, stderr: "" });
    const sleep = async () => {};
    // すぐつながる: 起こし直さない
    let restarts = 0;
    await cliCalendarConnect({
      cli: "/t",
      logger: nullLogger,
      bundledHelper: "/A/H.app",
      run: ok,
      sleep,
      helperReady: () => true,
      restartHelper: async () => {
        restarts++;
        return true;
      },
    })();
    expect(restarts).toBe(0);
    // つながらない → 起こし直すとつながる
    let ready = false;
    await cliCalendarConnect({
      cli: "/t",
      logger: nullLogger,
      bundledHelper: "/A/H.app",
      run: ok,
      sleep,
      readyWaitMs: 1000,
      helperReady: () => ready,
      restartHelper: async () => {
        restarts++;
        ready = true;
        return true;
      },
    })();
    expect(restarts).toBe(1);
    // 起こし直してもつながらない → 次の一手（アプリの開き直し）を理由にした失敗
    const err = await cliCalendarConnect({
      cli: "/t",
      logger: nullLogger,
      bundledHelper: "/A/H.app",
      run: ok,
      sleep,
      readyWaitMs: 1000,
      helperReady: () => false,
      restartHelper: async () => false,
    })().catch((e) => e);
    expect(err).toBeInstanceOf(CalendarConnectError);
    expect((err as CalendarConnectError).detail).toContain("Quit and reopen Turnlane");
  });

  test("終了コードが 0 でなければ stderr の要約を持った CalendarConnectError（install が失敗したら authorize しない）", async () => {
    const runs: string[][] = [];
    const fail = (code: number, stderr: string) => async (argv: string[]) => {
      runs.push(argv);
      return { code, stderr };
    };
    const err = await cliCalendarConnect({
      cli: "/t",
      logger: nullLogger,
      bundledHelper: "/A/H.app",
      run: fail(
        1,
        'Showing nothing here\nmacOS did not show the calendar access dialog (access is still "not decided").\n',
      ),
    })().catch((e) => e);
    expect(err).toBeInstanceOf(CalendarConnectError);
    expect((err as CalendarConnectError).exitCode).toBe(1);
    expect((err as CalendarConnectError).detail).toBe(
      'Showing nothing here macOS did not show the calendar access dialog (access is still "not decided").',
    );
    runs.length = 0;
    const e2 = await cliCalendarConnect({
      cli: "/t",
      logger: nullLogger,
      run: fail(3, ""),
    })().catch((e) => e);
    expect((e2 as CalendarConnectError).step).toBe("install");
    expect((e2 as CalendarConnectError).detail).toBe("turnlane calendar install exited with 3");
    expect(runs).toEqual([["/t", "calendar", "install"]]);
    expect(summarizeStderr(`${"x".repeat(400)}\n`)).toHaveLength(300);
  });
});
