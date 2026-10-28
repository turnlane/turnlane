/**
 * Codex の問いを表示の瞬間に読む（glance と「答える」の問いの全文。ADR 0019 の Decision 4 の追記）。
 * 本文はすべて合成のダミー
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { putSetting } from "@turnlane/core";
import type { GlanceResponse, WaitResponse } from "@turnlane/core/api";
import { MASK } from "@turnlane/core/web";
import { createApp } from "../src/http/app.ts";
import { type AiEnv, makeAiEnv } from "./helpers/env.ts";
import { codexRollout } from "./helpers/transcript.ts";

const TOKEN = "c".repeat(64);
const HOST = "127.0.0.1:7317";
const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 2, 0, 0);
const SENTINEL = "SENTINEL_CODEXQ_4b9e";
/** 合成の鍵（本物ではない） */
const FAKE_KEY = `sk-proj${"Qq7Ww6Ee".repeat(4)}`;
const SID = "99999999-0000-4000-8000-000000000001";

let env: AiEnv;
afterEach(async () => {
  await env?.cleanup();
});

async function setup(question: string) {
  env = makeAiEnv({ now: T0 });
  putSetting(env.mutate, "ui.language", "ja");
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
  const c = codexRollout(join(env.home, ".codex"), { sid: SID, cwd: "/w/app", at: T0 });
  const end = c.begin(T0 + MIN);
  c.agentMessage(T0 + MIN + 1000, "(looking around)");
  c.toolItem(T0 + MIN + 2000);
  c.agentMessage(T0 + MIN + 3000, question);
  end(T0 + 2 * MIN, question);
  // 返答の猶予（15 分）の後
  env.clock.set(T0 + 30 * MIN);
  await env.sync();
  const id =
    env.sqlite
      .query<{ id: string }, []>(
        `SELECT DISTINCT t.work_item_id AS id FROM ai_turn t JOIN ai_session s ON s.id = t.session_id
         WHERE s.tool = 'codex'`,
      )
      .get()?.id ?? "none";
  const get = async <T>(path: string) => {
    const r = await app.request(`http://${HOST}/api/work-items/${id}/${path}`, {
      headers: { host: HOST, authorization: `Bearer ${TOKEN}` },
    });
    return { status: r.status, headers: r.headers, body: (await r.json()) as T };
  };
  return { id, c, get };
}

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

const Q = `左の列は直しました。鍵は TOKEN=${FAKE_KEY} です。${SENTINEL} 右の列はどうしますか？\n1. 同じ幅にする\n2. そのまま`;

describe("Codex の返答待ちの問い", () => {
  test("glance: 最後の発言から問いの行と詳細（伏せ字済み）。no-store", async () => {
    const { get } = await setup(Q);
    const g = await get<GlanceResponse>("glance");
    expect(g.status).toBe(200);
    expect(g.headers.get("cache-control")).toBe("no-store");
    expect(g.body.kind).toBe("question");
    expect(g.body.question?.row).toContain("右の列はどうしますか");
    expect(g.body.unavailable).toBeUndefined();
  });

  test("「答える」の問いの全文: 2,000 字まで・伏せ字・番号付きの選択肢。no-store。DB のどこにも書かない", async () => {
    const { get } = await setup(Q);
    const w = await get<WaitResponse>("wait");
    expect(w.headers.get("cache-control")).toBe("no-store");
    expect(w.body.kind).toBe("question");
    expect(w.body.question).toMatchObject({ truncated: false, masked: true });
    expect(w.body.question?.text).toContain(SENTINEL);
    expect(w.body.question?.text).toContain(`TOKEN=sk-p${MASK}`);
    expect(w.body.question?.text).not.toContain(FAKE_KEY);
    expect(w.body.question?.text).not.toContain("looking around");
    expect(w.body.options).toEqual([
      { n: 1, label: "同じ幅にする" },
      { n: 2, label: "そのまま" },
    ]);
    // 読んだ後に取り込み・判定（待ちの中身の保存も）をもう一度回しても、DB には問いの文が無い
    await get<GlanceResponse>("glance");
    await env.sync();
    dbHasNot(SENTINEL);
    dbHasNot(FAKE_KEY);
  });

  test("長い問いは 2,000 字で切る", async () => {
    const { get } = await setup(`${"長".repeat(2100)}どうしますか？`);
    const w = await get<WaitResponse>("wait");
    expect(w.body.question?.truncated).toBe(true);
    expect(w.body.question?.text.length).toBe(2000);
  });

  test("rollout が消えている: missing（答えは送れる）。設定「行に中身を出す」がオフ: off", async () => {
    const { get, c } = await setup(Q);
    putSetting(env.mutate, "turn.show_detail", false);
    expect((await get<GlanceResponse>("glance")).body.unavailable).toBe("off");
    expect((await get<WaitResponse>("wait")).body.unavailable).toBe("off");
    putSetting(env.mutate, "turn.show_detail", true);
    rmSync(c.path);
    const g = await get<GlanceResponse>("glance");
    expect(g.body).toMatchObject({ kind: "none", unavailable: "missing" });
    const w = await get<WaitResponse>("wait");
    expect(w.headers.get("cache-control")).toBe("no-store");
    expect(w.body).toMatchObject({ kind: "question", unavailable: "missing" });
    expect(w.body.question).toBeUndefined();
  });
});
