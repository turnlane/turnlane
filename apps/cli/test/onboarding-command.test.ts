import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nullLogger } from "@turnlane/collectors";
import { FakeClock, resolvePaths } from "@turnlane/core";
import { FakeGit } from "../../daemon/src/ingest/git.ts";
import { type RunningDaemon, startDaemon } from "../../daemon/src/main.ts";
import { claudeTranscript } from "../../daemon/test/helpers/transcript.ts";
import { sourcesCommand } from "../src/commands/ai.ts";
import { onboardingCommand } from "../src/commands/onboarding.ts";
import type { CliEnv } from "../src/env.ts";
import { FakeLaunchctl } from "../src/launchctl.ts";
import { checkArgs } from "../src/run.ts";

let home = "";
let daemon: RunningDaemon | null = null;
afterEach(async () => {
  await daemon?.stop();
  daemon = null;
  rmSync(home, { recursive: true, force: true });
});

describe("turnlane onboarding（M6-18〜M6-20）", () => {
  test("status → detect → consent → summary。同意の前は sources が同意待ちを出す", async () => {
    home = mkdtempSync(join(tmpdir(), "turnlane-cli-onb-"));
    const now = Date.now();
    const w = claudeTranscript(join(home, ".claude"), {
      sid: "00000000-0000-4000-8000-000000000009",
      cwd: "/w/app",
      branch: "main",
    });
    w.human(now - 3_600_000);
    w.assistantEnd(now - 3_000_000, "Done.");
    utimesSync(w.path, new Date(now - 3_000_000), new Date(now - 3_000_000));
    const paths = resolvePaths({ HOME: home }, home);
    daemon = await startDaemon({
      paths,
      logger: nullLogger,
      port: 0,
      clock: new FakeClock(now),
      ingest: { git: new FakeGit(), noWatch: true },
      calendar: false,
      summary: false,
    });
    const out: string[] = [];
    const env: CliEnv = {
      paths: { ...paths, port: daemon.port },
      launchctl: new FakeLaunchctl(() => "x"),
      out: (s) => out.push(s),
      err: (s) => out.push(`ERR ${s}`),
      execPath: "/usr/local/bin/bun",
      vars: { HOME: home },
    };
    const o = { json: false, sources: [] as string[] };
    // 同意の前は MCP を登録しない（D-145）
    expect(await onboardingCommand(env, "mcp", o)).toBe(1);
    expect(out.join("\n")).toContain("Agree to the import first");
    expect(existsSync(join(home, ".claude.json"))).toBe(false);
    out.length = 0;
    expect(await onboardingCommand(env, "status", o)).toBe(0);
    expect(out.join("\n")).toContain("waiting for consent");
    out.length = 0;
    expect(await sourcesCommand(env, "list", { json: false })).toBe(0);
    expect(out.at(-1)).toContain("waiting for consent");
    out.length = 0;
    expect(await onboardingCommand(env, "detect", o)).toBe(0);
    expect(out.join("\n")).toMatch(/claude_code\s+default .*7d 1 · last /);
    out.length = 0;
    expect(await onboardingCommand(env, "consent", o)).toBe(0);
    expect(out.join("\n")).toContain("1 sources");
    for (let i = 0; i < 200 && !daemon.supervisor?.backfillDone; i++) await Bun.sleep(10);
    out.length = 0;
    expect(await onboardingCommand(env, "summary", o)).toBe(0);
    expect(out[0]).toMatch(/AI time 0h0\dm, AI work 1,/);
    out.length = 0;
    expect(await onboardingCommand(env, "status", { ...o, json: true })).toBe(0);
    const st = JSON.parse(out[0] as string);
    expect(st).toMatchObject({ state: "consented", consented: true });
    expect(st.progress.doneAt).not.toBeNull();
    // 「AI から Turnlane を使えるようにする」段: 同意した取り込み元（~/.claude）に登録し、段を済みにする
    out.length = 0;
    expect(await onboardingCommand(env, "mcp", { ...o, dryRun: true })).toBe(0);
    expect(out[0]).toContain("[dry-run] Claude Code");
    expect(existsSync(join(home, ".claude.json"))).toBe(false);
    out.length = 0;
    expect(await onboardingCommand(env, "mcp", o)).toBe(0);
    expect(
      JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")).mcpServers.turnlane,
    ).toEqual({
      type: "stdio",
      command: join(home, ".local/bin/turnlane"),
      args: ["mcp"],
      env: {},
    });
    out.length = 0;
    expect(await onboardingCommand(env, "status", { ...o, json: true })).toBe(0);
    expect(JSON.parse(out[0] as string).steps.mcp).toBe("done");
    expect(await onboardingCommand(env, "add", o)).toBe(2);
    expect(await onboardingCommand(env, "bogus", o)).toBe(2);
  });

  test("引数の検査", () => {
    expect(checkArgs("onboarding", ["consent", "--source", "a", "--source", "b"])).toBeNull();
    expect(checkArgs("onboarding", ["consent", "--all"])).toContain("unknown option");
    expect(checkArgs("doctor", ["--redact", "--json"])).toBeNull();
  });
});
