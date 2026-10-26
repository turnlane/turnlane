/**
 * turnlane ai run <起動 ID>（D-107）: デーモンから1回だけ受け取り、ツールを引数の配列で起動する。端末・git・CLI は偽物で、
 * 実際の claude / codex は起動しない（起動の代わりに引数を記録する）
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nullLogger } from "@turnlane/collectors";
import { resolvePaths, type TurnlanePaths } from "@turnlane/core";
import type { AiLaunchResult, TaskView } from "@turnlane/core/api";
import { type RunningDaemon, startDaemon } from "../../daemon/src/main.ts";
import { FakeLaunchSystem } from "../../daemon/test/helpers/launch-system.ts";
import { FakeOpenSystem } from "../../daemon/test/helpers/open-system.ts";
import { callApi } from "../src/client.ts";
import { type AiRunDeps, aiRunCommand, systemAiRun } from "../src/commands/ai-run.ts";
import type { CliEnv } from "../src/env.ts";
import { FakeLaunchctl } from "../src/launchctl.ts";

let home: string;
let daemon: RunningDaemon | null = null;
let out: string[] = [];
let dbPath = "";

afterEach(async () => {
  await daemon?.stop();
  daemon = null;
  rmSync(home, { recursive: true, force: true });
});

async function setup(): Promise<{ env: CliEnv; sys: FakeLaunchSystem; open: FakeOpenSystem }> {
  home = mkdtempSync(join(tmpdir(), "turnlane-cli-airun-"));
  const paths = resolvePaths({ HOME: home }, home);
  const sys = new FakeLaunchSystem();
  sys.paths.add("/w/app");
  const open = new FakeOpenSystem();
  daemon = await startDaemon({
    paths,
    logger: nullLogger,
    port: 0,
    ingest: false,
    calendar: false,
    summary: false,
    launch: { cliPath: "/u/bin/turnlane", sys, open },
  });
  out = [];
  const p: TurnlanePaths = { ...paths, port: daemon.port };
  dbPath = paths.dbPath;
  return {
    env: {
      paths: p,
      launchctl: new FakeLaunchctl(() => "x"),
      out: (s) => out.push(s),
      err: (s) => out.push(`ERR ${s}`),
      execPath: "/usr/local/bin/bun",
      vars: { HOME: home, PATH: "/usr/bin" },
    },
    sys,
    open,
  };
}

/** 偽の起動: 終了コード code で、runMs かかって終わる（時計は deps.now） */
function fakeDeps(found: string | null, o: { code?: number; runMs?: number } = {}) {
  const spawned: { argv: string[]; cwd: string; env: Record<string, string | undefined> }[] = [];
  let ignored = false;
  let clock = 1_000_000;
  const deps: AiRunDeps = {
    which: (cmd) => (found ? `${found}/${cmd}` : null),
    spawn: async (argv, x) => {
      spawned.push({ argv, ...x });
      clock += o.runMs ?? 120_000;
      return o.code ?? 3;
    },
    now: () => clock,
    ignoreInterrupt: () => {
      ignored = true;
    },
    isDir: () => true,
  };
  return { deps, spawned, ignored: () => ignored };
}

async function launch(env: CliEnv): Promise<string> {
  const t = await callApi<{ task: TaskView }>(env.paths, "POST", "/api/tasks", {
    title: "Write the README",
  });
  const r = await callApi<AiLaunchResult>(env.paths, "POST", "/api/ai/launches", {
    taskId: t.data.task.id,
    repo: "/w/app",
    tool: "claude_code",
    worktree: false,
  });
  expect(r.status).toBe(200);
  return r.data.launchId;
}

describe("turnlane ai run", () => {
  test("受け取った cwd と引数でツールを起動し、終了コードを返す。Ctrl-C は子に任せる。2回目は受け取れない", async () => {
    const { env } = await setup();
    const id = await launch(env);
    const f = fakeDeps("/opt/bin");
    expect(await aiRunCommand(env, id, f.deps)).toBe(3);
    expect(f.ignored()).toBe(true);
    expect(f.spawned).toHaveLength(1);
    const s = f.spawned[0];
    expect(s?.cwd).toBe("/w/app");
    expect(s?.argv[0]).toBe("/opt/bin/claude");
    expect(s?.argv.slice(1, 2)).toEqual(["--session-id"]);
    expect(s?.argv.at(-1)).toContain("Write the README");
    expect(s?.env.TURNLANE_LAUNCH_ID).toBe(id);
    expect(s?.env.PATH).toBe("/usr/bin");
    const again = fakeDeps("/opt/bin");
    expect(await aiRunCommand(env, id, again.deps)).toBe(1);
    expect(again.spawned).toHaveLength(0);
    expect(out.at(-1)).toContain("expired or was already picked up");
  });

  test("ツールが PATH に無い → 127。依頼は failed（cli_missing）になる", async () => {
    const { env } = await setup();
    const id = await launch(env);
    const f = fakeDeps(null);
    expect(await aiRunCommand(env, id, f.deps)).toBe(127);
    expect(out.at(-1)).toContain("claude");
    const t = await callApi<{ tasks: TaskView[] }>(env.paths, "GET", "/api/inbox");
    expect(t.data.tasks[0]?.ai).toMatchObject({ state: "failed", failReason: "cli_missing" });
  });

  test("終わったら終了コードと時間をデーモンに知らせる。すぐに 0 以外で終わったら1行出す（長く動いた後・0 では出さない）", async () => {
    const { env } = await setup();
    const id = await launch(env);
    const f = fakeDeps("/opt/bin", { code: 1, runMs: 2400 });
    expect(await aiRunCommand(env, id, f.deps)).toBe(1);
    expect(out.at(-1)).toBe(
      "ERR Claude Code ended after 2s (exit code 1). Check the messages above.",
    );
    const db = new Database(dbPath, { readonly: true });
    expect(
      db
        .query(
          "SELECT exit_code, exit_after_ms, exited_at IS NOT NULL AS exited FROM ai_launch WHERE id = ?",
        )
        .get(id),
    ).toEqual({ exit_code: 1, exit_after_ms: 2400, exited: 1 });
    db.close();
    const t = await callApi<{ tasks: TaskView[] }>(env.paths, "GET", "/api/inbox");
    expect(t.data.tasks[0]?.ai?.exit).toEqual({ code: 1, afterMs: 2400 });

    out = [];
    const id2 = await launch(env);
    expect(await aiRunCommand(env, id2, fakeDeps("/opt/bin", { code: 0, runMs: 1000 }).deps)).toBe(
      0,
    );
    const id3 = await launch(env);
    expect(
      await aiRunCommand(env, id3, fakeDeps("/opt/bin", { code: 2, runMs: 600_000 }).deps),
    ).toBe(2);
    expect(out).toEqual([]);
  });

  test("知らせる口は Bearer だけ（クッキーは 403）・2回目は記録を変えない", async () => {
    const { env } = await setup();
    const id = await launch(env);
    expect(await aiRunCommand(env, id, fakeDeps("/opt/bin", { code: 5, runMs: 3000 }).deps)).toBe(
      5,
    );
    await callApi(env.paths, "POST", `/api/ai/launches/${id}/exit`, { code: 0, afterMs: 9 });
    const db = new Database(dbPath, { readonly: true });
    expect(db.query("SELECT exit_code FROM ai_launch WHERE id = ?").get(id)).toEqual({
      exit_code: 5,
    });
    db.close();
    const bad = await callApi(env.paths, "POST", `/api/ai/launches/${id}/exit`, { code: "x" });
    expect(bad.status).toBe(400);
  });

  test("起動 ID の形が違えば使い方（2）", async () => {
    const { env } = await setup();
    expect(await aiRunCommand(env, "../../x", fakeDeps("/x").deps)).toBe(2);
    expect(await aiRunCommand(env, undefined, fakeDeps("/x").deps)).toBe(2);
  });

  test("選んだ Claude のアカウント（D-122）: 偽の claude に CLAUDE_CONFIG_DIR が渡る。既定を選ぶと端末の CLAUDE_CONFIG_DIR を消す", async () => {
    const { env, sys } = await setup();
    // 取り込みが見つけた設定ディレクトリ（~/.claude と ~/.claude-acme）
    const dirs = [join(home, ".claude"), join(home, ".claude-acme")];
    const db = new Database(dbPath);
    for (const [i, d] of dirs.entries()) {
      mkdirSync(join(d, "projects"), { recursive: true });
      sys.paths.add(d);
      db.run(
        "INSERT INTO ai_source (id, tool, root_path, created_at, updated_at) VALUES (?, 'claude_code', ?, 0, 0)",
        [`src-${i}`, d],
      );
    }
    db.close();
    // 偽の claude: 受け取った CLAUDE_CONFIG_DIR と最初の引数を書き出すだけ
    const bin = join(home, "bin");
    mkdirSync(bin, { recursive: true });
    const record = join(home, "record.txt");
    writeFileSync(
      join(bin, "claude"),
      `#!/bin/sh\nprintf '%s %s\\n' "\${CLAUDE_CONFIG_DIR-unset}" "\${1}" >> '${record}'\n`,
    );
    chmodSync(join(bin, "claude"), 0o755);
    const deps: AiRunDeps = {
      which: (cmd) => join(bin, cmd),
      // 依頼の cwd（/w/app）は実在しないので、一時 HOME で起動する
      spawn: (argv, o) => systemAiRun.spawn(argv, { ...o, cwd: home }),
      ignoreInterrupt: () => {},
      isDir: () => true,
      now: () => Date.now(),
    };
    // 端末のシェルが別の CLAUDE_CONFIG_DIR を持っている
    const shellEnv = { ...env, vars: { ...env.vars, CLAUDE_CONFIG_DIR: "/elsewhere" } };
    const ask = async (account: string) => {
      const t = await callApi<{ task: TaskView }>(env.paths, "POST", "/api/tasks", { title: "x" });
      const r = await callApi<AiLaunchResult>(env.paths, "POST", "/api/ai/launches", {
        taskId: t.data.task.id,
        repo: "/w/app",
        tool: "claude_code",
        worktree: false,
        claudeAccount: account,
      });
      expect(r.status).toBe(200);
      expect(await aiRunCommand(shellEnv, r.data.launchId, deps)).toBe(0);
    };
    await ask(dirs[1] as string);
    await ask(dirs[0] as string);
    expect(readFileSync(record, "utf8").trim().split("\n")).toEqual([
      `${dirs[1]} --session-id`,
      "unset --session-id",
    ]);
  });
});
