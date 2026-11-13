/**
 * プログラム経由のセッション（記録の entrypoint が `sdk-*`）の結合テスト: 取り込み → 判定で、問いで終わっても自分の番・
 * 返答タスクにならず、ボードの札（ソースの sdk）が付く。合成のトランスクリプト・偽の git。
 * T3 Code（Agent SDK の上のアプリ。D-360）: 人の入力に origin が無い記録でも自分の番になる。委任の子（turnlane hook が
 * T3CODE_THREAD_ID から付けた delegated の印）はプログラム経由と同じ。T3 Code から動かした Codex の委任の子も同じ。hook は
 * 本物の turnlane hook をプロセスとして起こす
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { sourcesByWorkItem } from "../src/planner/common.ts";
import { type AiEnv, makeAiEnv, present } from "./helpers/env.ts";
import { claudeTranscript, codexRollout } from "./helpers/transcript.ts";

let env: AiEnv;
afterEach(async () => {
  await env?.cleanup();
});

const MIN = 60_000;
const T0 = Date.UTC(2026, 8, 14, 1, 0); // 2026-09-14 10:00 JST

const SID = "33333333-0000-4000-8000-000000000001";
const CODEX_SID = "33333333-0000-4000-8000-000000000002";

/** 本物の turnlane hook（apps/cli）を、セッションの中と同じ環境変数で起こして spool に 1 行書かせる */
function runHook(threadId: string | undefined, tool: "claude_code" | "codex" = "claude_code") {
  mkdirSync(join(env.dataDir, "spool"), { recursive: true });
  const p = Bun.spawnSync(
    [process.execPath, join(import.meta.dir, "../../cli/src/main.ts"), "hook", "--tool", tool],
    {
      env: {
        HOME: env.home,
        TURNLANE_DATA_DIR: env.dataDir,
        PATH: process.env.PATH ?? "",
        ...(threadId !== undefined ? { T3CODE_THREAD_ID: threadId } : {}),
      },
      stdin: new TextEncoder().encode(
        JSON.stringify({
          hook_event_name: "SessionStart",
          session_id: tool === "codex" ? CODEX_SID : SID,
          source: "startup",
        }),
      ),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  expect(p.exitCode).toBe(0);
}

async function run(
  entrypoint: string,
  o: { sdkPrompts?: boolean; hook?: { threadId: string | undefined } } = {},
) {
  env = makeAiEnv({ now: T0 });
  present(env.sqlite, T0 - 60 * MIN, T0 + 14 * 60 * MIN);
  env.git.repos.set("/w/app", "/w/app");
  env.git.defaults.set("/w/app", "main");
  const tr = claudeTranscript(join(env.home, ".claude"), {
    sid: SID,
    cwd: "/w/app",
    branch: "feat/x",
    entrypoint,
    ...(o.sdkPrompts ? { sdkPrompts: true } : {}),
  });
  if (o.hook) runHook(o.hook.threadId);
  tr.human(T0 - 2 * MIN);
  tr.assistantEnd(T0, "Which option do you prefer?");
  env.clock.set(T0 + 20 * MIN);
  await env.sync();
  const wi = env.sqlite
    .query<{ id: string; status: string }, []>("SELECT id, status FROM work_item")
    .get();
  const fus = env.sqlite.query<{ kind: string }, []>("SELECT kind FROM follow_up").all();
  return { status: wi?.status, fus, sources: sourcesByWorkItem(env.sqlite).get(wi?.id ?? "") };
}

describe("runner: プログラム経由のセッション", () => {
  test("sdk-cli: 問いで終わっても done、返答タスクを作らない。ソースに sdk の印", async () => {
    const r = await run("sdk-cli");
    expect(r.status).toBe("done");
    expect(r.fus).toEqual([]);
    expect(r.sources).toEqual([{ tool: "claude_code", profile: null, sdk: true }]);
  });

  test("cli: 今までどおり自分の番と返答タスク。印は無い", async () => {
    const r = await run("cli");
    expect(r.status).toBe("your_turn");
    expect(r.fus).toEqual([{ kind: "reply" }]);
    expect(r.sources).toEqual([{ tool: "claude_code", profile: null }]);
  });

  test("t3-code（origin の無い人の入力）: 今までどおり自分の番と返答タスク。印は無い", async () => {
    const r = await run("t3-code", { sdkPrompts: true });
    expect(r.status).toBe("your_turn");
    expect(r.fus).toEqual([{ kind: "reply" }]);
    expect(r.sources).toEqual([{ tool: "claude_code", profile: null }]);
  });

  test("t3-code の委任の子（T3CODE_THREAD_ID が thread:delegated-task:）: done、返答タスクを作らない。ソースに sdk の印", async () => {
    const r = await run("t3-code", {
      sdkPrompts: true,
      hook: { threadId: "thread:delegated-task:00000000-0000-4000-8000-0000000000aa" },
    });
    expect(r.status).toBe("done");
    expect(r.fus).toEqual([]);
    expect(r.sources).toEqual([{ tool: "claude_code", profile: null, sdk: true }]);
    // 印は真偽値だけ。スレッドの ID は DB に入らない
    const rows = env.sqlite
      .query<{ delegated: number | null }, []>("SELECT delegated FROM hook_event")
      .all();
    expect(rows).toEqual([{ delegated: 1 }]);
    const dump = JSON.stringify(env.sqlite.query("SELECT * FROM hook_event").all());
    expect(dump).not.toContain("thread:");
  });

  test("t3-code で hook が mcp:launch: や未設定なら、普通に自分の番", async () => {
    for (const threadId of ["mcp:launch:00000000-0000-4000-8000-0000000000bb", undefined]) {
      const r = await run("t3-code", { sdkPrompts: true, hook: { threadId } });
      expect(r.status).toBe("your_turn");
      expect(r.fus).toEqual([{ kind: "reply" }]);
      expect(r.sources).toEqual([{ tool: "claude_code", profile: null }]);
      expect(
        env.sqlite.query<{ n: number }, []>("SELECT count(*) AS n FROM hook_event").get()?.n,
      ).toBe(1);
      await env.cleanup();
    }
  });

  /** T3 Code から動かした Codex のセッション（originator が T3 Code）。問いで終わる 1 ターン */
  async function runCodex(threadId: string | undefined) {
    env = makeAiEnv({ now: T0 });
    present(env.sqlite, T0 - 60 * MIN, T0 + 14 * 60 * MIN);
    env.git.repos.set("/w/app", "/w/app");
    env.git.defaults.set("/w/app", "main");
    env.git.branches.set("/w/app", "feat/x");
    const r = codexRollout(join(env.home, ".codex"), {
      sid: CODEX_SID,
      cwd: "/w/app",
      at: T0 - 3 * MIN,
      originator: "T3 Code",
    });
    runHook(threadId, "codex");
    r.turn(T0 - 2 * MIN, T0, "Which option do you prefer?");
    env.clock.set(T0 + 20 * MIN);
    await env.sync();
    const wi = env.sqlite
      .query<{ id: string; status: string }, []>("SELECT id, status FROM work_item")
      .get();
    const fus = env.sqlite.query<{ kind: string }, []>("SELECT kind FROM follow_up").all();
    return { status: wi?.status, fus, sources: sourcesByWorkItem(env.sqlite).get(wi?.id ?? "") };
  }

  test("T3 Code から動かした Codex の委任の子（T3CODE_THREAD_ID が thread:delegated-task:）: done、返答タスクを作らない。ソースに sdk の印", async () => {
    const r = await runCodex("thread:delegated-task:00000000-0000-4000-8000-0000000000cc");
    expect(r.status).toBe("done");
    expect(r.fus).toEqual([]);
    expect(r.sources).toEqual([{ tool: "codex", profile: null, sdk: true }]);
    const rows = env.sqlite
      .query<{ tool: string; delegated: number | null }, []>(
        "SELECT tool, delegated FROM hook_event",
      )
      .all();
    expect(rows).toEqual([{ tool: "codex", delegated: 1 }]);
    const dump = JSON.stringify(env.sqlite.query("SELECT * FROM hook_event").all());
    expect(dump).not.toContain("thread:");
  });

  test("T3 Code から動かした Codex で hook が mcp:launch: や未設定なら、普通に自分の番", async () => {
    for (const threadId of ["mcp:launch:00000000-0000-4000-8000-0000000000dd", undefined]) {
      const r = await runCodex(threadId);
      expect(r.status).toBe("your_turn");
      expect(r.fus).toEqual([{ kind: "reply" }]);
      expect(r.sources).toEqual([{ tool: "codex", profile: null }]);
      expect(
        env.sqlite.query<{ n: number }, []>("SELECT count(*) AS n FROM hook_event").get()?.n,
      ).toBe(1);
      await env.cleanup();
    }
  });
});
