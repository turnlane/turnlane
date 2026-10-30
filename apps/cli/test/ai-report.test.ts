/**
 * turnlane ai report と MCP の report_ai_work（ADR 0021）: デーモンに届けば HTTP、届かなければ spool、spool にも書けなければ
 * exit 1。合成の報告だけ（一時 HOME。オーナーのデーモン・データには触れない）
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fromReportSpoolLine, nullLogger } from "@turnlane/collectors";
import { FakeClock, resolvePaths, type TurnlanePaths } from "@turnlane/core";
import { FakeGit } from "../../daemon/src/ingest/git.ts";
import { type RunningDaemon, startDaemon } from "../../daemon/src/main.ts";
import { type AiReportOptions, aiReportCommand } from "../src/commands/ai-report.ts";
import { reportSpoolBacklog } from "../src/commands/doctor.ts";
import { handleMessage, TOOLS } from "../src/commands/mcp.ts";
import type { CliEnv } from "../src/env.ts";
import { FakeLaunchctl } from "../src/launchctl.ts";
import { runCommand } from "../src/run.ts";

let home: string;
let daemon: RunningDaemon | null = null;
let out: string[] = [];

afterEach(async () => {
  await daemon?.stop();
  daemon = null;
  rmSync(home, { recursive: true, force: true });
});

function envFor(paths: TurnlanePaths): CliEnv {
  return {
    paths,
    launchctl: new FakeLaunchctl(() => "x"),
    out: (s) => out.push(s),
    err: (s) => out.push(`ERR ${s}`),
    execPath: "/usr/local/bin/bun",
    vars: { HOME: home },
  };
}

async function setup(start = false): Promise<{ env: CliEnv; paths: TurnlanePaths }> {
  home = mkdtempSync(join(tmpdir(), "turnlane-cli-report-"));
  const paths = resolvePaths({ HOME: home }, home);
  out = [];
  if (!start) return { env: envFor({ ...paths, port: 1 }), paths: { ...paths, port: 1 } };
  daemon = await startDaemon({
    paths,
    logger: nullLogger,
    port: 0,
    clock: new FakeClock(Date.UTC(2026, 9, 2)),
    ingest: { git: new FakeGit(), noWatch: true },
    calendar: false,
    summary: false,
  });
  const p = { ...paths, port: daemon.port };
  return { env: envFor(p), paths: p };
}

const opts = (o: Partial<AiReportOptions>): AiReportOptions => ({
  source: "myscript",
  id: "job-1",
  state: "started",
  options: [],
  json: true,
  ...o,
});

const spoolLines = (paths: TurnlanePaths) =>
  readdirSync(paths.spoolDir)
    .filter((f) => f.startsWith("report-"))
    .flatMap((f) =>
      readFileSync(join(paths.spoolDir, f), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>),
    );

describe("turnlane ai report", () => {
  test("デーモンが止まっていれば spool に 1 行書いて exit 0（client_id つき。あとで同じ型で読める）", async () => {
    const { env, paths } = await setup();
    const code = await aiReportCommand(
      env,
      opts({
        state: "waiting",
        title: "Nightly export",
        kind: "question",
        text: "Overwrite?",
        options: ["Yes", "No"],
      }),
      () => new Date(2026, 9, 2, 9).getTime(),
    );
    expect(code).toBe(0);
    expect(JSON.parse(out[0] ?? "{}")).toEqual({ accepted: true, workItemId: null, queued: true });
    const [line] = spoolLines(paths);
    const v = fromReportSpoolLine(line ?? {});
    expect(v?.report).toMatchObject({
      source: "myscript",
      id: "job-1",
      state: "waiting",
      title: "Nightly export",
      wait: { kind: "question", text: "Overwrite?", options: ["Yes", "No"] },
    });
    expect(v?.clientId).toMatch(/^[0-9a-f-]{36}$/);
    expect(readdirSync(paths.spoolDir)).toContain("report-20261002.jsonl");
    expect(reportSpoolBacklog(paths.dbPath, paths.spoolDir)).toBe(1);
  });

  test("spool にも書けなければ exit 1 と 1 行", async () => {
    const { paths } = await setup();
    const blocker = join(home, "not-a-dir");
    writeFileSync(blocker, "");
    const env = envFor({ ...paths, spoolDir: join(blocker, "spool") });
    expect(await aiReportCommand(env, opts({}))).toBe(1);
    expect(out.at(-1)).toContain("could not reach the daemon or write to");
  });

  test("だめなオプションは exit 2 とオプションの名前", async () => {
    const { env } = await setup();
    expect(await aiReportCommand(env, opts({ state: "paused" }))).toBe(2);
    expect(out.at(-1)).toContain("--state");
    expect(await aiReportCommand(env, opts({ source: "codex" }))).toBe(2);
    expect(out.at(-1)).toContain("--source");
    expect(await aiReportCommand(env, opts({ state: "waiting" }))).toBe(2);
    expect(out.at(-1)).toContain("--kind / --text");
  });

  test("コマンドの引数（--option は何度でも、--help に出る）", async () => {
    const { env, paths } = await setup();
    const code = await runCommand(
      "ai",
      [
        "report",
        "--source",
        "nightly",
        "--id",
        "backup",
        "--state",
        "waiting",
        "--kind",
        "permission",
        "--text",
        "Delete 3 old snapshots",
        "--label",
        "Delete snapshots",
        "--option",
        "a",
        "--option",
        "b",
      ],
      env,
    );
    expect(code).toBe(0);
    expect(spoolLines(paths)[0]).toMatchObject({
      source: "nightly",
      wait_kind: "permission",
      wait_label: "Delete snapshots",
      wait_options: ["a", "b"],
    });
    out = [];
    await runCommand("ai", ["--help"], env);
    expect(out.join("\n")).toContain("turnlane ai report --source");
  });

  test("デーモンに届けば HTTP で受け、同じ spool の 1 行になる", async () => {
    const { env, paths } = await setup(true);
    expect(await aiReportCommand(env, opts({ title: "Nightly export" }))).toBe(0);
    expect(JSON.parse(out[0] ?? "{}")).toMatchObject({ accepted: true });
    expect(spoolLines(paths)).toEqual([
      expect.objectContaining({ kind: "report", source: "myscript", state: "started" }),
    ]);
  });
});

describe("MCP report_ai_work", () => {
  test("ツールの一覧に出て、HTTP と同じ型を受ける。だめなら項目の名前", async () => {
    const { paths } = await setup(true);
    expect(TOOLS.map((t) => t.name)).toContain("report_ai_work");
    const state = { ctx: { paths, client: "test", cwd: home } };
    const call = (args: Record<string, unknown>) =>
      handleMessage(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "report_ai_work", arguments: args },
        },
        state,
      );
    const ok = (await call({ source: "myscript", id: "job-2", state: "started" })) as {
      result: { structuredContent: { accepted: boolean }; isError?: boolean };
    };
    expect(ok.result.isError).toBeUndefined();
    expect(ok.result.structuredContent.accepted).toBe(true);
    const bad = (await call({ source: "claude_code", id: "x", state: "started" })) as {
      result: { content: { text: string }[]; isError: boolean };
    };
    expect(bad.result.isError).toBe(true);
    expect(bad.result.content[0]?.text).toBe("invalid_input: source");
  });
});
