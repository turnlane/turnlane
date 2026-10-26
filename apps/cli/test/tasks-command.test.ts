/**
 * turnlane add / today / ls / done と stdio MCP（M2-10）。外部取り込みの冪等性: source + external_id で2回呼んで1件、
 * 削除後に再送しても作られない、片方だけ指定はエラー、spool 経由でも重複しない、同時に2回呼んでも1件。
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nullLogger } from "@turnlane/collectors";
import { resolvePaths, type TurnlanePaths } from "@turnlane/core";
import { type RunningDaemon, startDaemon } from "../../daemon/src/main.ts";
import { handleMessage } from "../src/commands/mcp.ts";
import {
  addCommand,
  doneCommand,
  editCommand,
  lsCommand,
  rmCommand,
  shortIds,
  todayCommand,
} from "../src/commands/tasks.ts";
import type { CliEnv } from "../src/env.ts";
import { FakeLaunchctl } from "../src/launchctl.ts";

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

async function setup(start = true): Promise<{ env: CliEnv; paths: TurnlanePaths }> {
  home = mkdtempSync(join(tmpdir(), "turnlane-cli-tasks-"));
  const paths = resolvePaths({ HOME: home }, home);
  out = [];
  if (!start) return { env: envFor({ ...paths, port: 1 }), paths };
  daemon = await startDaemon({ paths, logger: nullLogger, port: 0, ingest: false });
  const p = { ...paths, port: daemon.port };
  return { env: envFor(p), paths: p };
}

const count = (paths: TurnlanePaths, where = "1 = 1") => {
  const db = new Database(paths.dbPath, { readonly: true });
  try {
    return (db.query(`SELECT count(*) AS n FROM task WHERE ${where}`).get() as { n: number }).n;
  } finally {
    db.close();
  }
};

const ext = { source: "github", externalId: "issue-42" };

describe("turnlane add / ls / today / done", () => {
  test("自然言語で追加し、ls・today・done", async () => {
    const { env } = await setup();
    expect(await addCommand(env, { text: "Write outline 30m", json: true })).toBe(0);
    const added = JSON.parse(out.at(-1) as string);
    expect(added).toMatchObject({ created: true, task: { estimateMin: 30, scheduledDate: null } });
    expect(added.task.origin.source).toBe("cli");
    out = [];
    expect(await lsCommand(env, { inbox: true, json: false })).toBe(0);
    expect(out[0]).toContain("Write outline");
    out = [];
    expect(await doneCommand(env, (added.task.id as string).slice(0, 8))).toBe(0);
    expect(out[0]).toContain("Done: Write outline");
    out = [];
    expect(await todayCommand(env, { json: true })).toBe(0);
    expect(JSON.parse(out[0] as string)).toMatchObject({ yourTurn: 0 });
  });

  test("外部の識別子: 2回で1件、片方だけはエラー、削除後に再送しても作らない、同時に2回でも1件", async () => {
    const { env, paths } = await setup();
    expect(await addCommand(env, { text: "Fix login bug", ...ext, json: true })).toBe(0);
    expect(await addCommand(env, { text: "Fix login bug (renamed)", ...ext, json: true })).toBe(0);
    expect(JSON.parse(out.at(-1) as string).created).toBe(false);
    expect(count(paths)).toBe(1);
    expect(await addCommand(env, { text: "x", source: "github", json: false })).toBe(2);
    expect(await addCommand(env, { text: "x", externalId: "1", json: false })).toBe(2);
    const id = JSON.parse(out[0] as string).task.id as string;
    await fetch(`http://127.0.0.1:${paths.port}/api/tasks/${id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${daemon?.token}` },
    });
    out = [];
    expect(await addCommand(env, { text: "Fix login bug", ...ext, json: true })).toBe(0);
    expect(JSON.parse(out[0] as string)).toMatchObject({ created: false, skipped: "deleted" });
    await Promise.all([
      addCommand(env, { text: "Same", source: "linear", externalId: "L-1", json: true }),
      addCommand(env, { text: "Same", source: "linear", externalId: "L-1", json: true }),
    ]);
    expect(count(paths, "external_source = 'linear'")).toBe(1);
  });

  test("デーモン停止中は spool に書き、起動時に取り込む（同じ行を2回読んでも1件）", async () => {
    const { env, paths } = await setup(false);
    expect(await addCommand(env, { text: "Offline task tomorrow", json: false })).toBe(0);
    expect(await addCommand(env, { text: "Offline ext", ...ext, json: false })).toBe(0);
    const spool = readdirSync(paths.spoolDir).filter((f) => f.startsWith("cli-"));
    expect(spool).toHaveLength(1);
    const copy = join(home, "copy.jsonl");
    cpSync(join(paths.spoolDir, spool[0] as string), copy);
    daemon = await startDaemon({ paths, logger: nullLogger, port: 0, ingest: false });
    expect(count(paths)).toBe(2);
    expect(existsSync(join(paths.spoolDir, spool[0] as string))).toBe(false);
    // 同じ spool をもう一度置いて再起動しても増えない（clientId と外部の識別子で冪等）
    await daemon.stop();
    cpSync(copy, join(paths.spoolDir, spool[0] as string));
    daemon = await startDaemon({ paths, logger: nullLogger, port: 0, ingest: false });
    expect(count(paths)).toBe(2);
  });
});

describe("ID の接頭辞（同じ時刻付近に作った UUIDv7 を区別する）", () => {
  const A = "01a111e6-aa62-7422-8934-760f4d34a5d0";
  const B = "01a111e6-aa62-7c00-8000-000000000001";
  const C = "01a111e6-bb00-7000-8000-000000000002";
  const D = "01a22222-0000-7000-8000-000000000003";

  test("shortIds: 一覧の中で一意な最短の接頭辞（最低8文字、`-` で終わらない）", () => {
    const ids = shortIds([A, B, C, D]);
    expect(ids.get(D)).toBe("01a22222");
    expect(ids.get(C)).toBe("01a111e6-b");
    expect(ids.get(A)).toBe("01a111e6-aa62-74");
    expect(ids.get(B)).toBe("01a111e6-aa62-7c");
    expect(shortIds([A]).get(A)).toBe("01a111e6");
  });

  async function addWithId(paths: TurnlanePaths, id: string, raw: string) {
    const r = await fetch(`http://127.0.0.1:${paths.port}/api/tasks`, {
      method: "POST",
      headers: { authorization: `Bearer ${daemon?.token}`, "content-type": "application/json" },
      body: JSON.stringify({ raw, clientId: id }),
    });
    expect(r.ok).toBe(true);
  }

  test("ls は区別できる接頭辞を出し、曖昧な接頭辞の done は候補を出してエラー、出した接頭辞で done できる", async () => {
    const { env, paths } = await setup();
    await addWithId(paths, A, "Get the domain");
    await addWithId(paths, B, "Write the post");
    out = [];
    expect(await lsCommand(env, { inbox: true, json: false })).toBe(0);
    const prefixes = out.map((l) => /^\[.\] (\S+)/.exec(l)?.[1] as string);
    expect(new Set(prefixes).size).toBe(2);
    expect(prefixes).toContain("01a111e6-aa62-74");
    out = [];
    expect(await doneCommand(env, "01a111e6")).toBe(1);
    expect(out[0]).toContain("More than one task matches");
    expect(out.join("\n")).toContain("01a111e6-aa62-74  Get the domain");
    expect(out.join("\n")).toContain("01a111e6-aa62-7c  Write the post");
    out = [];
    // `-` の有無は問わない
    expect(await doneCommand(env, "01a111e6aa627c")).toBe(0);
    expect(out[0]).toContain("Done: Write the post");
    out = [];
    expect(await doneCommand(env, "deadbeef")).toBe(1);
    expect(out[0]).toContain("Not found");
  });

  test("turnlane edit: 題名・見積・プロジェクト・日付・Inbox、矛盾する指定と変更なしはエラー。turnlane rm で消える", async () => {
    const { env, paths } = await setup();
    await addWithId(paths, A, "Get the domian");
    const base = { inbox: false, noEst: false, noProject: false, json: true };
    out = [];
    expect(
      await editCommand(env, "01a111e6", {
        ...base,
        title: "Get the domain",
        est: "20",
        project: "turn",
      }),
    ).toBe(0);
    const t1 = JSON.parse(out.at(-1) as string).task;
    expect(t1).toMatchObject({ title: { t: "text", text: "Get the domain" }, estimateMin: 20 });
    expect(t1.projectId).not.toBeNull();
    out = [];
    expect(await editCommand(env, "01a111e6", { ...base, date: "2026-10-09" })).toBe(0);
    expect(JSON.parse(out.at(-1) as string).task.scheduledDate).toBe("2026-10-09");
    out = [];
    expect(await editCommand(env, A, { ...base, inbox: true, noEst: true, noProject: true })).toBe(
      0,
    );
    expect(JSON.parse(out.at(-1) as string).task).toMatchObject({
      scheduledDate: null,
      estimateMin: null,
      projectId: null,
    });
    expect(await editCommand(env, A, base)).toBe(2);
    expect(await editCommand(env, A, { ...base, date: "2026-10-09", inbox: true })).toBe(2);
    expect(await editCommand(env, A, { ...base, est: "abc" })).toBe(2);
    expect(await editCommand(env, A, { ...base, date: "tomorrow" })).toBe(2);
    expect(await editCommand(env, undefined, { ...base, title: "x" })).toBe(2);
    out = [];
    expect(await rmCommand(env, "01a111e6")).toBe(0);
    expect(out[0]).toBe("Deleted: Get the domain");
    expect(count(paths, "deleted_at IS NOT NULL")).toBe(1);
    expect(await rmCommand(env, "01a111e6")).toBe(1);
  });
});

describe("turnlane mcp（3.5）", () => {
  test("initialize の clientInfo を印にし、add_task は Inbox へ・冪等・片方だけはエラー", async () => {
    const { paths } = await setup();
    const state = { ctx: { paths, client: "unknown", cwd: "/w/app" } };
    const init = await handleMessage(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { clientInfo: { name: "claude-code" } },
      },
      state,
    );
    expect(init).toMatchObject({ result: { serverInfo: { name: "turnlane" } } });
    expect(
      await handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, state),
    ).toBeNull();
    const list = (await handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" }, state)) as {
      result: { tools: { name: string }[] };
    };
    expect(list.result.tools.map((t) => t.name)).toContain("add_task");
    const call = (args: object) =>
      handleMessage(
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "add_task", arguments: args },
        },
        state,
      ) as Promise<{ result: { isError?: boolean; structuredContent?: { created: boolean } } }>;
    expect(
      (await call({ title: "Try turnlane", project: "blog" })).result.structuredContent?.created,
    ).toBe(true);
    expect(
      (await call({ title: "From issue", source: "github", external_id: "7" })).result
        .structuredContent?.created,
    ).toBe(true);
    expect(
      (await call({ title: "From issue", source: "github", external_id: "7" })).result
        .structuredContent?.created,
    ).toBe(false);
    expect((await call({ title: "x", source: "github" })).result.isError).toBe(true);
    const db = new Database(paths.dbPath, { readonly: true });
    const rows = db
      .query("SELECT source, source_ref, scheduled_date FROM task ORDER BY created_at")
      .all();
    db.close();
    expect(rows[0]).toEqual({
      source: "mcp",
      source_ref: "mcp:claude-code:/w/app",
      scheduled_date: null,
    });
    expect(rows).toHaveLength(2);
  });

  test("schedule_task はタスクの時間ブロックを1つに保つ（時刻を変えたら置き換え、日付だけなら同じ時刻のまま移す）", async () => {
    const { paths } = await setup();
    const state = { ctx: { paths, client: "claude-code", cwd: "/w/app" } };
    let n = 10;
    const tool = (name: string, args: object) =>
      handleMessage(
        { jsonrpc: "2.0", id: n++, method: "tools/call", params: { name, arguments: args } },
        state,
      ) as Promise<{
        result: { isError?: boolean; structuredContent?: { task: { id: string } | null } };
      }>;
    const added = await tool("add_task", {
      title: "Weekly post",
      date: "2026-10-13",
      estimate_min: 5,
      source: "studio",
      external_id: "p-1",
    });
    const id = added.result.structuredContent?.task?.id ?? "";
    expect(id).not.toBe("");
    const blocks = () => {
      const db = new Database(paths.dbPath, { readonly: true });
      try {
        return db
          .query(
            "SELECT start_at, end_at FROM time_block WHERE task_id = ? AND deleted_at IS NULL ORDER BY start_at",
          )
          .all(id) as { start_at: number; end_at: number }[];
      } finally {
        db.close();
      }
    };
    // JST の 2026-10-<day> hh:mm
    const jst = (day: number, h: number, m = 0) => Date.UTC(2026, 9, day, h - 9, m);
    expect(
      (await tool("schedule_task", { task_id: id, date: "2026-10-13", start: "23:00" })).result
        .isError,
    ).toBeUndefined();
    expect(blocks()).toEqual([{ start_at: jst(13, 23), end_at: jst(13, 23, 5) }]);
    // 日付と時刻を変える: 前のブロックを残さない
    await tool("schedule_task", { task_id: id, date: "2026-10-14", start: "20:00" });
    expect(blocks()).toEqual([{ start_at: jst(14, 20), end_at: jst(14, 20, 5) }]);
    // 日付だけ変える: 同じ時刻のまま日をずらす（ボードのキーの移動と同じ。m2-api 14章）
    await tool("schedule_task", { task_id: id, date: "2026-10-17" });
    expect(blocks()).toEqual([{ start_at: jst(17, 20), end_at: jst(17, 20, 5) }]);
    const db = new Database(paths.dbPath, { readonly: true });
    const row = db.query("SELECT scheduled_date FROM task WHERE id = ?").get(id);
    db.close();
    expect(row).toEqual({ scheduled_date: "2026-10-17" });
  });
});
