import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nullLogger } from "@turnlane/collectors";
import { DAEMON_LABEL, resolvePaths, type TurnlanePaths } from "@turnlane/core";
import { type RunningDaemon, startDaemon } from "../../daemon/src/main.ts";
import { freePort } from "../../daemon/test/helpers/port.ts";
import { daemonLogs, daemonStatus, daemonStop } from "../src/commands/daemon.ts";
import { buildPlist, selfInstall, uninstall } from "../src/commands/install.ts";
import { authUrl, openCommand } from "../src/commands/open.ts";
import { type CliEnv, plistPath } from "../src/env.ts";
import { FakeLaunchctl, LaunchctlError, parsePrint } from "../src/launchctl.ts";

// self-install は書き出した直後のスクリプトを --version で実行する。macOS は新しい実行ファイルの初回起動で検査を挟み
// （1回あたり中央値約0.2秒、最大1秒超）、全体を並べて流すと既定の5秒を超えることがあるので長めにする
setDefaultTimeout(20_000);

let home: string;
let src: string;
let paths: TurnlanePaths;
let out: string[];
let errs: string[];
let daemon: RunningDaemon | null;

/** bootstrap で一時 HOME のデーモンを実際に起動する偽の launchctl（launchd には触れない） */
class DaemonLaunchctl extends FakeLaunchctl {
  constructor() {
    super(() => DAEMON_LABEL);
  }
  override bootstrap(plist: string): void {
    super.bootstrap(plist);
    pending = startDaemon({ paths, logger: nullLogger }).then((d) => {
      daemon = d;
    });
  }
  override bootout(label: string): void {
    super.bootout(label);
    pending = daemon?.stop().then(() => {
      daemon = null;
    });
  }
}
let pending: Promise<void> | undefined;
let launchctl: DaemonLaunchctl;

function env(): CliEnv {
  return {
    paths,
    launchctl,
    out: (s) => out.push(s),
    err: (s) => errs.push(s),
    execPath: join(src, "turnlane"),
    vars: { HOME: home, PATH: "/usr/bin:/bin" },
  };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "turnlane-install-"));
  src = join(home, "build-out");
  mkdirSync(src);
  for (const b of ["turnlane", "turnlaned"]) {
    writeFileSync(join(src, b), `#!/bin/sh\necho "${b} 0.0.0-test"\n`);
    chmodSync(join(src, b), 0o755);
  }
  paths = resolvePaths({ HOME: home, TURNLANE_PORT: String(freePort()) }, home);
  out = [];
  errs = [];
  daemon = null;
  launchctl = new DaemonLaunchctl();
});

afterEach(async () => {
  await pending;
  await daemon?.stop();
  rmSync(home, { recursive: true, force: true });
});

describe("plist", () => {
  test("plutil で妥当な plist。ラベル・プログラム・RunAtLoad・KeepAlive・ログの場所", () => {
    const xml = buildPlist({ ...env(), vars: { TURNLANE_PORT: "17399" } });
    const file = join(home, "p.plist");
    writeFileSync(file, xml);
    const lint = Bun.spawnSync(["/usr/bin/plutil", "-lint", file]);
    expect(lint.exitCode).toBe(0);
    const json = JSON.parse(
      Bun.spawnSync(["/usr/bin/plutil", "-convert", "json", "-o", "-", file]).stdout.toString(),
    );
    expect(json.Label).toBe("dev.turnlane.daemon");
    expect(json.ProgramArguments).toEqual([join(home, ".local/bin/turnlaned")]);
    expect(json.RunAtLoad).toBe(true);
    expect(json.KeepAlive).toBe(true);
    expect(json.StandardErrorPath).toBe(join(home, "Library/Logs/turnlane/turnlaned.stderr.log"));
    expect(json.EnvironmentVariables.TURNLANE_PORT).toBe("17399");
    expect(json.EnvironmentVariables.PATH).toContain("/usr/bin");
  });
});

describe("turnlane self-install", () => {
  test("--dry-run は何も書かない", async () => {
    expect(await selfInstall(env(), { dryRun: true })).toBe(0);
    expect(existsSync(paths.binDir)).toBe(false);
    expect(existsSync(plistPath(paths))).toBe(false);
    expect(launchctl.calls).toEqual([]);
    expect(out.join("\n")).toContain("<key>Label</key>");
  });

  test("コピー・plist・bootstrap・--version・health 待ちまで行う（一時 HOME）", async () => {
    expect(await selfInstall(env())).toBe(0);
    expect(errs).toEqual([]);
    for (const b of ["turnlane", "turnlaned"]) {
      const p = join(paths.binDir, b);
      expect(readFileSync(p, "utf8")).toContain(`${b} 0.0.0-test`);
      expect(statSync(p).mode & 0o777).toBe(0o755);
    }
    expect(readFileSync(plistPath(paths), "utf8")).toContain(join(paths.binDir, "turnlaned"));
    expect(plistPath(paths).startsWith(home)).toBe(true);
    expect(launchctl.calls).toEqual([`bootstrap ${plistPath(paths)}`]);
    // --version を1回実行した出力（初回のコード検査を済ませる）
    expect(out).toContain("turnlane 0.0.0-test");
    expect(out).toContain("turnlaned 0.0.0-test");
    expect(out.some((l) => l.includes(" is running: "))).toBe(true);
    expect(out.some((l) => l.includes("isn't in your PATH"))).toBe(true);
  });

  test("登録済みなら bootout してから bootstrap し直す（再インストール）", async () => {
    await selfInstall(env());
    await pending;
    launchctl.calls.length = 0;
    expect(await selfInstall(env())).toBe(0);
    expect(launchctl.calls).toEqual([`bootout ${DAEMON_LABEL}`, `bootstrap ${plistPath(paths)}`]);
  });

  test("入れ替えで bootout 直後の bootstrap が error 5 でも、再試行して稼働させる", async () => {
    await selfInstall(env());
    await pending;
    launchctl.calls.length = 0;
    let failures = 1;
    const ok = launchctl.bootstrap.bind(launchctl);
    launchctl.bootstrap = (plist: string) => {
      if (failures-- > 0) {
        launchctl.calls.push("bootstrap failed (5)");
        throw new LaunchctlError("bootstrap", 5, "Bootstrap failed: 5: Input/output error");
      }
      ok(plist);
    };
    expect(await selfInstall(env())).toBe(0);
    expect(launchctl.calls).toEqual([
      `bootout ${DAEMON_LABEL}`,
      "bootstrap failed (5)",
      `bootstrap ${plistPath(paths)}`,
    ]);
    expect(out.some((l) => l.includes(" is running: "))).toBe(true);
  });

  test("bootstrap が直らない失敗なら、次の一手（turnlane daemon start / launchctl print）を示して失敗する", async () => {
    launchctl.bootstrap = () => {
      throw new LaunchctlError("bootstrap", 122, "Path had bad ownership/permissions");
    };
    const e = await selfInstall(env()).catch((x: Error) => x);
    expect(e).toBeInstanceOf(Error);
    const msg = (e as Error).message;
    expect(msg).toContain("Could not register with launchd");
    expect(msg).toContain("then run turnlane daemon start again");
    expect(msg).toContain(`launchctl print gui/$(id -u)/${DAEMON_LABEL}`);
    // バイナリは配置済みのまま（再実行で入れ替えられる）
    expect(existsSync(join(paths.binDir, "turnlaned"))).toBe(true);
  });

  test("bun で直接実行している（コピー元が無い）ときは失敗する", async () => {
    const e = { ...env(), execPath: "/opt/homebrew/bin/bun" };
    expect(await selfInstall(e)).toBe(1);
    expect(errs[0]).toContain("from a built turnlane");
  });

  test("--no-load は launchd に登録しない", async () => {
    expect(await selfInstall(env(), { noLoad: true })).toBe(0);
    expect(launchctl.calls).toEqual([]);
    expect(existsSync(plistPath(paths))).toBe(true);
  });
});

describe("turnlane daemon / turnlane open / turnlane uninstall", () => {
  test("status は稼働中なら 0、停止なら 3", async () => {
    expect(await daemonStatus(env())).toBe(3);
    expect(out.join("\n")).toContain("stopped");
    await selfInstall(env());
    out = [];
    expect(await daemonStatus(env())).toBe(0);
    expect(out[0]).toContain("turnlaned: running");
    expect(out.join("\n")).toContain("launchd: registered");
  });

  test("stop は bootout する", async () => {
    await selfInstall(env());
    expect(daemonStop(env())).toBe(0);
    expect(launchctl.calls.at(-1)).toBe(`bootout ${DAEMON_LABEL}`);
  });

  test("open --print は認証付き URL を出し、その URL でクッキーが発行される", async () => {
    await selfInstall(env());
    out = [];
    expect(await openCommand(env(), "board", { print: true })).toBe(0);
    const url = out[0] as string;
    expect(url).toBe(authUrl(paths.port, daemon?.token ?? "", "board"));
    const r = await fetch(url, { redirect: "manual" });
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("/board");
  });

  test("open: デーモンが動いていなければ 1", async () => {
    expect(await openCommand(env(), undefined, { print: true })).toBe(1);
  });

  test("logs はログの末尾 n 行を出す。ログが無ければ 1", async () => {
    expect(await daemonLogs(env(), { lines: 5 })).toBe(1);
    mkdirSync(paths.logDir, { recursive: true });
    writeFileSync(
      paths.logPath,
      `${Array.from({ length: 10 }, (_, i) => `{"i":${i}}`).join("\n")}\n`,
    );
    expect(await daemonLogs(env(), { lines: 3 })).toBe(0);
    expect(out).toEqual(['{"i":7}', '{"i":8}', '{"i":9}']);
  });

  test("uninstall は登録解除・plist・バイナリを消し、データは残す", async () => {
    await selfInstall(env());
    await pending;
    expect(uninstall(env())).toBe(0);
    await pending;
    expect(existsSync(plistPath(paths))).toBe(false);
    expect(existsSync(join(paths.binDir, "turnlane"))).toBe(false);
    expect(existsSync(paths.dbPath)).toBe(true);
    expect(launchctl.calls.at(-1)).toBe(`bootout ${DAEMON_LABEL}`);
  });
});

describe("launchctl print の解析", () => {
  test("state / pid / last exit code", () => {
    const s = parsePrint(
      "gui/501/dev.turnlane.daemon = {\n\tstate = running\n\tpid = 1234\n\tlast exit code = 0\n}",
    );
    expect(s).toEqual({ loaded: true, state: "running", pid: 1234, lastExitCode: 0 });
    expect(parsePrint("state = not running\nlast exit code = (never exited)")).toEqual({
      loaded: true,
      state: "not running",
    });
  });
});

describe("self-install とデスクトップアプリ（desktop-shell.md 6.2、D-056 (4)）", () => {
  test("コピー元に Turnlane.app があれば一緒に置いて登録する手順を出す。--no-desktop で省く", async () => {
    mkdirSync(join(src, "Turnlane.app", "Contents", "MacOS"), { recursive: true });
    writeFileSync(join(src, "Turnlane.app", "Contents", "MacOS", "turnlane"), "");
    expect(await selfInstall(env(), { dryRun: true })).toBe(0);
    expect(out.join("\n")).toContain("Turnlane.app");
    expect(out.join("\n")).toContain("dev.turnlane.desktop.plist");
    out = [];
    expect(await selfInstall(env(), { dryRun: true, noDesktop: true })).toBe(0);
    expect(out.join("\n")).not.toContain("Turnlane.app");
  });
});
