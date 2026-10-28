/**
 * 最後の返答（GET /api/work-items/:id/last-reply。ADR 0019 の Decision 10、m2-api 34章）の結合テスト。
 * 本文はすべて合成のダミー。DB・ログ・SSE・MCP に出ないことの全体の確かめは test/privacy.test.ts
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { LAST_REPLY_MAX, putSetting } from "@turnlane/core";
import type { LastReplyResponse } from "@turnlane/core/api";
import { MASK } from "@turnlane/core/web";
import { createApp } from "../src/http/app.ts";
import { type AiEnv, makeAiEnv } from "./helpers/env.ts";
import { claudeTranscript, codexRollout } from "./helpers/transcript.ts";

const TOKEN = "b".repeat(64);
const HOST = "127.0.0.1:7317";
const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 2, 0, 0);
const SENTINEL = "SENTINEL_LASTREPLY_7c2a";
/** 合成の鍵（本物ではない） */
const FAKE_KEY = `sk-proj${"Zz9Yy8Xx".repeat(4)}`;
const SID = "88888888-0000-4000-8000-000000000001";

let env: AiEnv;
afterEach(async () => {
  await env?.cleanup();
});

function setup() {
  env = makeAiEnv({ now: T0 });
  env.git.repos.set("/w/app", "/w/app");
  env.git.defaults.set("/w/app", "main");
  const app = createApp({
    token: TOKEN,
    port: 7317,
    hub: env.hub,
    health: () => ({}) as never,
    admin: { backup: () => ({ date: "", path: "" }) },
    ai: () => env.ai.deps,
  });
  const get = async (id: string) => {
    const r = await app.request(`http://${HOST}/api/work-items/${id}/last-reply`, {
      headers: { host: HOST, authorization: `Bearer ${TOKEN}` },
    });
    return { status: r.status, headers: r.headers, body: (await r.json()) as LastReplyResponse };
  };
  const idOf = (tool: string) =>
    env.sqlite
      .query<{ id: string }, [string]>(
        `SELECT DISTINCT t.work_item_id AS id FROM ai_turn t JOIN ai_session s ON s.id = t.session_id
         WHERE s.tool = ?`,
      )
      .get(tool)?.id ?? "none";
  const claude = () =>
    claudeTranscript(join(env.home, ".claude"), { sid: SID, cwd: "/w/app", branch: "feat/reply" });
  return { get, idOf, claude };
}

/** DB のすべての表に needle が無い */
function dbHasNot(needle: string): void {
  const tables = env.sqlite
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    )
    .all();
  expect(tables.length).toBeGreaterThan(10);
  for (const t of tables)
    expect(
      `${t.name} ${JSON.stringify(env.sqlite.query(`SELECT * FROM "${t.name}"`).all())}`,
    ).not.toContain(needle);
}

describe("GET /api/work-items/:id/last-reply（ADR 0019 の Decision 10）", () => {
  test("Claude Code の完了: 最後のツール呼び出しより後の文（伏せ字済み）。no-store。DB のどこにも書かない", async () => {
    const { get, idOf, claude } = setup();
    const tr = claude();
    tr.human(T0, { text: "列の幅を直して" });
    tr.assistantText(T0 + 10_000, "(narration before the tool)");
    const tu = tr.toolUse(T0 + 20_000, "Bash", { command: "bun test" });
    tr.toolResult(T0 + 30_000, tu);
    tr.assistantText(T0 + 40_000, `直しました。${SENTINEL}`);
    tr.assistantEnd(T0 + MIN, `鍵は export OPENAI_API_KEY=${FAKE_KEY} にしました。`);
    env.clock.set(T0 + 5 * MIN);
    await env.sync();
    const r = await get(idOf("claude_code"));
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.body).toMatchObject({
      state: "ok",
      truncated: false,
      masked: true,
      readAt: T0 + 5 * MIN,
    });
    expect(r.body.text).toBe(
      `直しました。${SENTINEL}\n\n鍵は export OPENAI_API_KEY=sk-p${MASK} にしました。`,
    );
    expect(r.body.text).not.toContain("narration");
    // 読んだ後に取り込み・判定をもう一度回しても、DB には返答の文が無い
    await env.sync();
    dbHasNot(SENTINEL);
    dbHasNot(FAKE_KEY);
  });

  test("Claude Code の動作中: その時点の最新の発言（ツールの結果を待っている間は、その前の文）", async () => {
    const { get, idOf, claude } = setup();
    const tr = claude();
    tr.human(T0, { text: "テストを直して" });
    tr.assistantText(T0 + 10_000, "テストを走らせます。");
    tr.toolUse(T0 + 20_000, "Bash", { command: "bun test" });
    env.clock.set(T0 + MIN);
    await env.sync();
    const r = await get(idOf("claude_code"));
    expect(r.body).toMatchObject({ state: "ok", text: "テストを走らせます。" });
  });

  test("2,000 字で切って truncated", async () => {
    const { get, idOf, claude } = setup();
    const tr = claude();
    tr.human(T0, { text: "まとめて" });
    tr.assistantEnd(T0 + MIN, "長".repeat(LAST_REPLY_MAX + 50));
    env.clock.set(T0 + 5 * MIN);
    await env.sync();
    const r = await get(idOf("claude_code"));
    expect(r.body.state).toBe("ok");
    expect(r.body.truncated).toBe(true);
    expect(r.body.text?.length).toBe(LAST_REPLY_MAX);
  });

  test("記録が消えている: gone。設定「行に中身を出す」がオフ: off（記録を読まない）。知らない項目は 404", async () => {
    const { get, idOf, claude } = setup();
    const tr = claude();
    tr.human(T0, { text: "直して" });
    tr.assistantEnd(T0 + MIN, `直しました。${SENTINEL}`);
    env.clock.set(T0 + 5 * MIN);
    await env.sync();
    const id = idOf("claude_code");
    putSetting(env.mutate, "turn.show_detail", false);
    const off = await get(id);
    expect(off.body).toEqual({
      workItemId: id,
      state: "off",
      readAt: T0 + 5 * MIN,
      // 次の指示の判定は文を読まないので付く（プロセスが動いていない）
      instruct: { ok: false, reason: "session_ended", terminal: null },
    });
    putSetting(env.mutate, "turn.show_detail", true);
    rmSync(tr.path);
    const gone = await get(id);
    expect(gone.status).toBe(200);
    expect(gone.headers.get("cache-control")).toBe("no-store");
    expect(gone.body).toMatchObject({ workItemId: id, state: "gone", readAt: T0 + 5 * MIN });
    expect(gone.body.text).toBeUndefined();
    expect((await get("no-such-item")).status).toBe(404);
  });

  test("Codex: 最後のツール呼び出しより後の AgentMessage。rollout が消えていれば gone", async () => {
    const { get, idOf } = setup();
    const c = codexRollout(join(env.home, ".codex"), { sid: SID, cwd: "/w/app", at: T0 });
    const end = c.begin(T0 + MIN);
    c.agentMessage(T0 + MIN + 1000, "(looking around)");
    c.toolItem(T0 + MIN + 2000);
    c.agentMessage(T0 + MIN + 3000, `Here are the changes. ${SENTINEL}`);
    end(T0 + 2 * MIN, `Here are the changes. ${SENTINEL}`);
    env.clock.set(T0 + 5 * MIN);
    await env.sync();
    const id = idOf("codex");
    const r = await get(id);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.body).toMatchObject({ state: "ok", text: `Here are the changes. ${SENTINEL}` });
    dbHasNot(SENTINEL);
    rmSync(c.path);
    expect((await get(id)).body.state).toBe("gone");
  });
});
