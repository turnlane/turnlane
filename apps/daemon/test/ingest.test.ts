import { afterEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  ingestSnapshot,
  installClaudeCase,
  installCodexCase,
  makeEnv,
  type TestEnv,
} from "./helpers/env.ts";

let env: TestEnv;
afterEach(async () => {
  await env?.cleanup();
});

function findJsonl(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) findJsonl(p, out);
    else if (p.endsWith(".jsonl") && !p.includes("/subagents/")) out.push(p);
  }
  return out;
}

describe("取り込みパイプライン（phase0-plan 3.2、M1-2）", () => {
  test("検出 → 全ストリーム → シンク。カーソルを消して読み直しても DB の内容が同じ（冪等）", async () => {
    env = makeEnv();
    for (const c of [
      "pr-created",
      "question-end",
      "subagent-branch-switch",
      "synthetic-closing-error",
    ]) {
      installClaudeCase(env.home, c);
    }
    installCodexCase(env.home, "desktop-guardian-aborted");
    await env.supervisor.start();
    await env.supervisor.whenIdle();
    const first = ingestSnapshot(env.sqlite) as { sessions: unknown[]; turns: unknown[] };
    expect(first.sessions.length).toBeGreaterThan(5);
    expect(first.turns.length).toBeGreaterThan(15);
    const tools = env.sqlite.query("SELECT tool, profile_label FROM ai_source ORDER BY tool").all();
    expect(tools).toEqual([
      { tool: "claude_code", profile_label: "default" },
      { tool: "codex", profile_label: "default" },
      { tool: "hook_spool", profile_label: "spool" },
      { tool: "report", profile_label: "spool" },
    ]);
    await env.supervisor.reingest();
    await env.supervisor.whenIdle();
    expect(ingestSnapshot(env.sqlite)).toEqual(first);
  });

  test("書き足しながら読んでも、一度に読んだ場合と DB の内容が一致する（行の途中で区切る）", async () => {
    env = makeEnv();
    installClaudeCase(env.home, "subagent-branch-switch");
    const file = findJsonl(join(env.home, ".claude/projects"))[0] as string;
    const full = readFileSync(file);
    // 1回目: 全部
    await env.supervisor.start();
    await env.supervisor.whenIdle();
    const once = ingestSnapshot(env.sqlite);
    // 2回目: 別の DB で、分割して書き足しながら読む
    await env.cleanup();
    env = makeEnv();
    installClaudeCase(env.home, "subagent-branch-switch");
    const f2 = findJsonl(join(env.home, ".claude/projects"))[0] as string;
    writeFileSync(f2, "");
    await env.supervisor.start();
    await env.supervisor.whenIdle();
    const step = Math.ceil(full.length / 9);
    for (let pos = 0; pos < full.length; pos += step) {
      appendFileSync(f2, full.subarray(pos, Math.min(full.length, pos + step)));
      utimesSync(f2, new Date(), new Date(Date.now() + pos));
      await env.supervisor.scanAll();
      await env.supervisor.whenIdle();
    }
    expect(ingestSnapshot(env.sqlite)).toEqual(once);
  });

  test("パーサの版が上がると、走査で先頭から読み直してターンの質問の判定を書き直す（D-066）", async () => {
    env = makeEnv();
    installClaudeCase(env.home, "question-end");
    await env.supervisor.start();
    await env.supervisor.whenIdle();
    const q = () =>
      env.sqlite
        .query<{ n: number }, []>("SELECT count(*) AS n FROM ai_turn WHERE ended_with = 'question'")
        .get()?.n;
    expect(q()).toBe(1);
    // 古い版で取り込んで判定が違っていた状態を作る
    env.sqlite.run("UPDATE ai_turn SET ended_with = 'end_turn' WHERE ended_with = 'question'");
    env.sqlite.run("UPDATE ingest_cursor SET parser_version = 1");
    expect(q()).toBe(0);
    await env.supervisor.scanAll();
    await env.supervisor.whenIdle();
    expect(q()).toBe(1);
    const v = env.sqlite
      .query<{ v: number }, []>(
        "SELECT min(parser_version) AS v FROM ingest_cursor WHERE source_id IN (SELECT id FROM ai_source WHERE tool = 'claude_code')",
      )
      .get()?.v;
    expect(v).toBe(7);
  });

  test("元ファイルが消えても行は残し、transcript_missing_at を記録する", async () => {
    env = makeEnv();
    installClaudeCase(env.home, "question-end");
    await env.supervisor.start();
    await env.supervisor.whenIdle();
    const file = findJsonl(join(env.home, ".claude/projects"))[0] as string;
    rmSync(file);
    await env.supervisor.scanAll();
    await env.supervisor.whenIdle();
    const s = env.sqlite
      .query<{ n: number; missing: number }, []>(
        "SELECT count(*) AS n, sum(transcript_missing_at IS NOT NULL) AS missing FROM ai_session WHERE is_subagent = 0",
      )
      .get();
    expect(s).toEqual({ n: 1, missing: 1 });
    expect(env.sqlite.query("SELECT count(*) AS n FROM ai_turn").get()).toEqual({ n: 1 });
  });

  test("除外ルール（exclude_globs_json）に当たる cwd のセッションは取り込まない", async () => {
    env = makeEnv();
    installClaudeCase(env.home, "pr-created");
    installClaudeCase(env.home, "synthetic-closing-error");
    await env.supervisor.detect();
    env.sqlite.run(
      "UPDATE ai_source SET exclude_globs_json = '[\"/fixture/repo-d\"]' WHERE tool = 'claude_code'",
    );
    await env.supervisor.detect();
    await env.supervisor.scanAll();
    await env.supervisor.whenIdle();
    const cwds = env.sqlite.query("SELECT DISTINCT cwd FROM ai_turn ORDER BY cwd").all();
    expect(cwds).toEqual([{ cwd: "/fixture/repo-a" }]);
  });

  test("Codex: ブランチの無いターンに enrich が git の今のブランチを補う（推定）", async () => {
    env = makeEnv();
    installCodexCase(env.home, "desktop-guardian-aborted");
    env.git.branches.set("/fixture/repo-a", "feat/x");
    await env.supervisor.start();
    await env.supervisor.whenIdle();
    const rows = env.sqlite
      .query<{ git_branch: string | null; cwd: string }, []>("SELECT git_branch, cwd FROM ai_turn")
      .all();
    expect(rows.some((r) => r.cwd === "/fixture/repo-a" && r.git_branch === "feat/x")).toBe(true);
    expect(rows.every((r) => r.cwd !== "/fixture/repo-a" || r.git_branch === "feat/x")).toBe(true);
  });

  test("hooks spool: 何度読み直しても hook_event は (spool_file, spool_offset) で1件。受信元の ai_source に last_hook_at", async () => {
    env = makeEnv();
    mkdirSync(join(env.home, ".claude/projects"), { recursive: true });
    const spool = join(env.dataDir, "spool");
    mkdirSync(spool, { recursive: true });
    const line = (o: object) =>
      `${JSON.stringify({ v: 1, received_at: 1_788_310_800_000, ...o })}\n`;
    writeFileSync(
      join(spool, "hooks-20260902.jsonl"),
      line({
        tool: "claude_code",
        config_root: join(env.home, ".claude"),
        hook_event_name: "Stop",
        session_id: "s1",
      }) + line({ tool: "codex", hook_event_name: "Stop", session_id: "c1" }),
    );
    await env.supervisor.start();
    await env.supervisor.whenIdle();
    await env.supervisor.reingest();
    await env.supervisor.whenIdle();
    expect(env.sqlite.query("SELECT count(*) AS n FROM hook_event").get()).toEqual({ n: 2 });
    const src = env.sqlite
      .query<{ last_hook_at: number | null }, []>(
        "SELECT last_hook_at FROM ai_source WHERE tool = 'claude_code'",
      )
      .get();
    expect(src?.last_hook_at).toBe(1_788_310_800_000);
  });

  test("サブエージェント: 親子付け・終わった時刻（ended_at）、サブエージェントの hook は親のセッションに agent_id 付きで入る", async () => {
    env = makeEnv();
    installClaudeCase(env.home, "subagent-branch-switch");
    const spool = join(env.dataDir, "spool");
    mkdirSync(spool, { recursive: true });
    const parent = "177b70e7-8167-4216-890d-03c0a9f4c604";
    writeFileSync(
      join(spool, "hooks-20260901.jsonl"),
      `${JSON.stringify({
        v: 1,
        tool: "claude_code",
        received_at: Date.parse("2026-09-01T09:01:00.000Z"),
        hook_event_name: "PermissionRequest",
        session_id: parent,
        agent_id: "af6e4ec8b5ae8c77e",
        tool_name: "Bash",
      })}\n`,
    );
    await env.supervisor.start();
    await env.supervisor.whenIdle();
    const sub = env.sqlite
      .query<{ external_id: string; parent: string; is_subagent: number; ended_at: number }, []>(
        "SELECT s.external_id, p.external_id AS parent, s.is_subagent, s.ended_at FROM ai_session s JOIN ai_session p ON p.id = s.parent_session_id",
      )
      .all();
    expect(sub).toEqual([
      {
        external_id: `${parent}/agent-af6e4ec8b5ae8c77e`,
        parent,
        is_subagent: 1,
        ended_at: Date.parse("2026-09-01T09:03:04.409Z"),
      },
    ]);
    expect(
      env.sqlite.query("SELECT session_external_id, agent_id, tool_name FROM hook_event").all(),
    ).toEqual([{ session_external_id: parent, agent_id: "af6e4ec8b5ae8c77e", tool_name: "Bash" }]);
  });
});
