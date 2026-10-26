/**
 * サブエージェント（Agent ツール）に作業を渡して親の番が Stop で閉じた後も、サブエージェントが動いている間は親は
 * 働いている（ai-session-ingestion 4.2・4.3・4.5）の結合テスト: 合成のトランスクリプト（親の JSONL ＋
 * `subagents/agent-<id>.jsonl` ＋ `.meta.json`）と hooks の spool を取り込み → 判定 → レーン・AI の時間・離席のまとめ
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readSettings } from "@turnlane/core";
import { awayEvents } from "../src/derive/away.ts";
import { aiTimeByWorkItem, workItemDetail } from "../src/derive/views.ts";
import { buildBoard } from "../src/planner/board.ts";
import { type AiEnv, makeAiEnv } from "./helpers/env.ts";
import { claudeSubagent, claudeTranscript } from "./helpers/transcript.ts";

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 2, 0, 0); // 2026-10-02 09:00 JST
const D = "2026-10-02";
const SID = "22222222-0000-4000-8000-000000000270";
/** 親の最初のターンの終わり（turn_duration のレコードの時刻） */
const E = T0 + 2 * MIN + 100;

let env: AiEnv;
afterEach(async () => {
  await env?.cleanup();
});

function setup() {
  env = makeAiEnv({ now: T0 });
  env.git.repos.set("/w/app", "/w/app");
  env.git.defaults.set("/w/app", "main");
  const root = join(env.home, ".claude");
  const opts = { sid: SID, cwd: "/w/app", branch: "feat/agents" };
  const parent = claudeTranscript(root, opts);
  const spool = join(env.dataDir, "spool");
  mkdirSync(spool, { recursive: true });
  const hooks: string[] = [];
  const hook = (name: string, at: number, extra: Record<string, string> = {}) => {
    hooks.push(
      JSON.stringify({
        v: 1,
        tool: "claude_code",
        received_at: at,
        config_root: root,
        hook_event_name: name,
        session_id: SID,
        ...extra,
      }),
    );
    writeFileSync(join(spool, "hooks-20261002.jsonl"), `${hooks.join("\n")}\n`);
  };
  // 親: 09:00 に頼み、サブエージェントをバックグラウンドで起動して 09:02 に Stop（編集あり）
  parent.human(T0);
  hook("UserPromptSubmit", T0);
  const call = parent.toolUse(T0 + 1 * MIN, "Agent", { prompt: "(task)" });
  parent.toolResult(T0 + 1 * MIN + 1000, call);
  parent.assistantEnd(T0 + 2 * MIN, "(started)", { edits: 1, durationMs: 2 * MIN });
  hook("Stop", T0 + 2 * MIN + 200);
  const sub = claudeSubagent(parent.path, { ...opts, agentId: "a270", start: T0 + 1 * MIN });
  const card = () =>
    env.sqlite
      .query<{ id: string; status: string; status_reason: string }, []>(
        "SELECT id, status, status_reason FROM work_item",
      )
      .get();
  const lane = (now: number) =>
    buildBoard(env.sqlite, readSettings(env.mutate.db, "Asia/Tokyo"), now, 0, D, D).days[0]
      ?.aiLane?.[0];
  return { parent, sub, hook, card, lane };
}

describe("サブエージェントが動いている間の親", () => {
  test("親の番が閉じても running。レーンのブロックは今まで続き、AI の時間はサブエージェントだけの分を 1 回だけ足す", async () => {
    const { parent, sub, card, lane } = setup();
    sub.activity(T0 + 5 * MIN);
    sub.activity(T0 + 9 * MIN);
    env.clock.set(T0 + 10 * MIN);
    await env.sync();
    expect(card()).toMatchObject({ status: "running", status_reason: "subagent:running" });
    // 返答・確認のタスクは作らない（親はまだ働いている）
    expect(env.sqlite.query("SELECT kind FROM follow_up").all()).toEqual([]);
    // 待ち（your_turn）も始まっていない
    expect(env.sqlite.query("SELECT wait_key FROM ai_wait_segment").all()).toEqual([]);
    const l = lane(T0 + 10 * MIN);
    expect(l?.status).toBe("running");
    const runs = l?.runs ?? [];
    expect(runs.at(-1)).toMatchObject({ start: E, end: T0 + 10 * MIN, open: true });
    expect(runs.map((r) => r.turnId.startsWith("subagent:"))).toEqual([false, true]);
    // AI の時間: 親のターン 2 分（turn_duration）＋ サブエージェントだけの分（親のターンの終わり〜今。ターン数は 1）
    const id = card()?.id ?? "";
    expect(aiTimeByWorkItem(env.sqlite, D, T0 + 10 * MIN).get(id)).toEqual({
      aiMs: 2 * MIN + (T0 + 10 * MIN - E),
      turns: 1,
    });

    // サブエージェントが 09:12 に終わり、task-notification で親が再開して 09:13 に終わる
    sub.end(T0 + 12 * MIN);
    parent.human(T0 + 12 * MIN + 5000, { origin: "task-notification" });
    parent.assistantEnd(T0 + 13 * MIN, "(summary)", { durationMs: 55_000 });
    env.clock.set(T0 + 14 * MIN);
    await env.sync();
    // サブエージェントが終わったので従来の判定（最後のターン = 再開したターンで決まる。編集なしで終わった）
    expect(card()).toMatchObject({ status: "done", status_reason: "ended" });
    // 待ちは再開したターンの終わりから
    const w = env.sqlite
      .query<{ start_at: number }, []>("SELECT MIN(start_at) AS start_at FROM ai_wait_segment")
      .get();
    expect(w?.start_at).toBe(T0 + 13 * MIN + 100);
    // AI の時間: 2 分 ＋ サブエージェントだけ（09:02〜09:12）＋ 再開 55 秒。二重に数えない
    expect(aiTimeByWorkItem(env.sqlite, D, T0 + 14 * MIN).get(id)).toEqual({
      aiMs: 2 * MIN + (T0 + 12 * MIN - E) + 55_000,
      turns: 2,
    });
    const detail = workItemDetail(
      env.sqlite,
      id,
      readSettings(env.mutate.db, "Asia/Tokyo"),
      T0 + 14 * MIN,
      0,
    );
    expect(detail?.workItem.turns).toBe(2);
    expect(detail?.turns.map((t) => [t.start, t.end])).toEqual([
      [T0, E],
      [E, T0 + 12 * MIN],
      [T0 + 12 * MIN + 5000, T0 + 13 * MIN + 100],
    ]);
    // 離れていた間のまとめ: 親の最初のターン（サブエージェントが動いていた）は「完了」に数えない
    const done = awayEvents(env.sqlite, T0, T0 + 14 * MIN).filter((e) => e.kind === "done");
    expect(done.map((e) => e.at)).toEqual([T0 + 13 * MIN + 100]);
  });

  test("サブエージェントの最後の活動が 5 分より前（止まった）→ 従来の判定に戻る", async () => {
    const { sub, card } = setup();
    sub.activity(T0 + 3 * MIN);
    env.clock.set(T0 + 10 * MIN);
    await env.sync();
    expect(card()).toMatchObject({ status: "your_turn", status_reason: "edits" });
  });

  test("サブエージェントの許可待ち（hook の agent_id）→ 親の needs_input と承認のタスク。サブエージェントが進むと閉じる", async () => {
    const { sub, hook, card, lane } = setup();
    sub.activity(T0 + 4 * MIN);
    hook("PermissionRequest", T0 + 4 * MIN + 500, { agent_id: "a270", tool_name: "Bash" });
    env.clock.set(T0 + 5 * MIN);
    await env.sync();
    expect(card()).toMatchObject({
      status: "needs_input",
      status_reason: "hook:permission_request",
    });
    const fus = () =>
      env.sqlite
        .query<{ kind: string; status: string }, []>("SELECT kind, status FROM follow_up")
        .all();
    expect(fus()).toEqual([{ kind: "approve", status: "open" }]);
    expect(lane(T0 + 5 * MIN)?.waits.some((w) => w.open && w.tone === "needs_input")).toBe(true);
    // 許可された: サブエージェントのトランスクリプトに活動
    sub.activity(T0 + 6 * MIN);
    env.clock.set(T0 + 7 * MIN);
    await env.sync();
    expect(card()).toMatchObject({ status: "running", status_reason: "subagent:running" });
    expect(fus()).toEqual([{ kind: "approve", status: "done" }]);
  });

  test("bypassPermissions の許可の hook（サブエージェントの呼び出しで出てすぐ許可される）は待ちにしない", async () => {
    const { sub, hook, card } = setup();
    sub.activity(T0 + 4 * MIN);
    for (let i = 0; i < 5; i++)
      hook("PermissionRequest", T0 + 4 * MIN + i * 1000, {
        agent_id: "a270",
        agent_type: "general-purpose",
        tool_name: "Bash",
        permission_mode: "bypassPermissions",
      });
    hook("Notification", T0 + 4 * MIN + 6000, { notification_type: "permission_prompt" });
    env.clock.set(T0 + 5 * MIN);
    await env.sync();
    expect(card()).toMatchObject({ status: "running", status_reason: "subagent:running" });
    expect(env.sqlite.query("SELECT kind FROM follow_up").all()).toEqual([]);
    expect(
      env.sqlite
        .query(
          "SELECT DISTINCT agent_type, permission_mode FROM hook_event WHERE hook_event_name = 'PermissionRequest'",
        )
        .all(),
    ).toEqual([{ agent_type: "general-purpose", permission_mode: "bypassPermissions" }]);
  });
});
