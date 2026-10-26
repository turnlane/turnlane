import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nullLogger } from "@turnlane/collectors";
import { resolvePaths, type TurnlanePaths } from "@turnlane/core";
import { type RunningDaemon, startDaemon } from "../../daemon/src/main.ts";
import { aiCommand, dur, queueCommand, sourcesCommand } from "../src/commands/ai.ts";
import { auditDb, doctorCommand } from "../src/commands/doctor.ts";
import type { CliEnv } from "../src/env.ts";
import { FakeLaunchctl } from "../src/launchctl.ts";

const FIXTURES = join(import.meta.dir, "../../../packages/collectors/test/fixtures");
let home: string;
let daemon: RunningDaemon | null = null;
let out: string[] = [];

afterEach(async () => {
  await daemon?.stop();
  daemon = null;
  rmSync(home, { recursive: true, force: true });
});

async function setup(): Promise<CliEnv> {
  home = mkdtempSync(join(tmpdir(), "turnlane-cli-ai-"));
  for (const c of readdirSync(join(FIXTURES, "claude_code/2.1.x"))) {
    cpSync(join(FIXTURES, "claude_code/2.1.x", c, "projects"), join(home, ".claude/projects"), {
      recursive: true,
    });
  }
  const paths = resolvePaths({ HOME: home }, home);
  daemon = await startDaemon({
    paths,
    logger: nullLogger,
    port: 0,
    ingest: { noWatch: true },
    onboarding: { assumeDone: true },
  });
  const ai = daemon.ai;
  for (let i = 0; i < 100 && !ai?.supervisor.backfillDone; i++) await Bun.sleep(20);
  ai?.runner.runOnce();
  out = [];
  const p: TurnlanePaths = { ...paths, port: daemon.port };
  return {
    paths: p,
    launchctl: new FakeLaunchctl(() => "x"),
    out: (s) => out.push(s),
    err: (s) => out.push(`ERR ${s}`),
    execPath: "/usr/local/bin/bun",
    vars: { HOME: home },
  };
}

describe("turnlane ai / turnlane queue / turnlane sources / turnlane doctor（M1-12）", () => {
  test("turnlane ai --days 62 は日ごとにカードを出す。--json も", async () => {
    const env = await setup();
    expect(await aiCommand(env, { days: "62", json: false })).toBe(0);
    expect(out.filter((l) => /^\d{4}-\d{2}-\d{2}/.test(l))).toHaveLength(62);
    expect(out.some((l) => /^ {2}~?(YOUR TURN|done|running|NEEDS INPUT|ERROR)/.test(l))).toBe(true);
    out = [];
    expect(await aiCommand(env, { days: "2", json: true })).toBe(0);
    expect(JSON.parse(out[0] as string).days).toHaveLength(2);
    expect(await aiCommand(env, { days: "0", json: false })).toBe(2);
  });

  test("turnlane queue と turnlane sources", async () => {
    const env = await setup();
    expect(await queueCommand(env, { json: true })).toBe(0);
    expect(Array.isArray(JSON.parse(out[0] as string).items)).toBe(true);
    out = [];
    expect(await sourcesCommand(env, "list", { json: false })).toBe(0);
    expect(out.some((l) => l.includes("claude_code"))).toBe(true);
    expect(out.some((l) => l.includes("hook_spool"))).toBe(true);
  });

  test("turnlane doctor: DB 監査で長文フィールドが 0 件", async () => {
    const env = await setup();
    await daemon?.stop();
    daemon = null;
    expect(auditDb(env.paths.dbPath)).toEqual([]);
    expect(await doctorCommand(env, { json: false })).toBe(0);
    expect(out.some((l) => l.includes("no values longer than"))).toBe(true);
    // MCP の登録（D-145）: 一時 HOME の ~/.claude は ~/.claude.json を見る
    expect(out).toContain(
      `MCP: Claude Code ${join(home, ".claude")} (${join(home, ".claude.json")}): not registered (turnlane mcp install)`,
    );
  });

  test("dur の表記", () => {
    expect([dur(0), dur(30_000), dur(12 * 60_000), dur(72 * 60_000), dur(26 * 3_600_000)]).toEqual([
      "0m",
      "<1m",
      "12m",
      "1h12m",
      "1d2h",
    ]);
  });
});
