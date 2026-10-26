import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nullLogger } from "@turnlane/collectors";
import { listBackups, resolvePaths, type TurnlanePaths } from "@turnlane/core";
import { type RunningDaemon, startDaemon } from "../../daemon/src/main.ts";
import { freePort } from "../../daemon/test/helpers/port.ts";
import { backupCommand, exportCommand } from "../src/commands/data.ts";
import type { CliEnv } from "../src/env.ts";
import { DisabledLaunchctl } from "../src/launchctl.ts";

let home: string;
let paths: TurnlanePaths;
let out: string[];
let errs: string[];
let daemon: RunningDaemon | null = null;

const env = (): CliEnv => ({
  paths,
  launchctl: new DisabledLaunchctl(),
  out: (s) => out.push(s),
  err: (s) => errs.push(s),
  execPath: "/x/turnlane",
  vars: {},
});

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "turnlane-data-"));
  paths = resolvePaths({ HOME: home, TURNLANE_PORT: String(freePort()) }, home);
  out = [];
  errs = [];
});
afterEach(async () => {
  await daemon?.stop();
  daemon = null;
  rmSync(home, { recursive: true, force: true });
});

describe("turnlane backup", () => {
  test("デーモン稼働中は API 経由。起動時の日次バックアップに加えて今日の分を作り直す", async () => {
    daemon = await startDaemon({ paths, logger: nullLogger });
    expect(listBackups(paths.backupDir)).toHaveLength(1); // 起動時の日次バックアップ
    expect(await backupCommand(env())).toBe(0);
    expect(out[0]).toContain("Backed up: ");
    expect(listBackups(paths.backupDir)).toHaveLength(1);
  });

  test("デーモン停止中は DB を読み取り専用で開いて直接取る", async () => {
    const d = await startDaemon({ paths, logger: nullLogger });
    await d.stop();
    rmSync(paths.backupDir, { recursive: true, force: true });
    expect(await backupCommand(env())).toBe(0);
    expect(out[0]).toContain("directly");
    const [b] = listBackups(paths.backupDir);
    expect(statSync(b?.path ?? "").mode & 0o777).toBe(0o600);
  });

  test("DB が無ければ 1", async () => {
    expect(await backupCommand(env())).toBe(1);
  });
});

describe("turnlane export --json", () => {
  test("--out に JSON Lines を 600 で書く（デーモン稼働中でもよい）", async () => {
    daemon = await startDaemon({ paths, logger: nullLogger });
    const file = join(home, "export.jsonl");
    expect(exportCommand(env(), { json: true, out: file })).toBe(0);
    const lines = readFileSync(file, "utf8").trim().split("\n");
    const header = JSON.parse(lines[0] as string);
    expect(header.format).toBe("turnlane-export");
    expect(header.tables.device).toBe(1);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(errs[0]).toContain("Exported");
  });

  test("--json が無ければ使い方を出して 2", () => {
    expect(exportCommand(env(), { json: false })).toBe(2);
  });
});
