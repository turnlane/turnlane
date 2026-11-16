/**
 * 図つきの問い（MCP の ask_user。ADR 0022。m2-api 41 章）の結合テスト: POST /api/asks → カードが回答待ち → 画面で返す →
 * MCP のプロセスの long-poll に答えが戻る。閉じる・打ち切り・居なくなった・デーモンの再起動の流れと、中身をどこにも残さない
 * ことの番兵。本文はすべて合成のダミー（一時 HOME。オーナーのデーモン・データには触れない）
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { type LogFields, type MetaOnlyLogger, nullLogger } from "@turnlane/collectors";
import { putSetting } from "@turnlane/core";
import type {
  AskCreateResponse,
  AskResultResponse,
  AskView,
  GlanceResponse,
  QueueResponse,
} from "@turnlane/core/api";
import { createAiSystem } from "../src/ai.ts";
import { ABANDON_MS } from "../src/ask/store.ts";
import { createApp } from "../src/http/app.ts";
import { type AiEnv, makeAiEnv, present } from "./helpers/env.ts";
import { claudeTranscript } from "./helpers/transcript.ts";

const TOKEN = "e".repeat(64);
const HOST = "127.0.0.1:7317";
const MIN = 60_000;
const H = 60 * MIN;
const T0 = Date.UTC(2026, 9, 2, 0, 0);
/** 問い・背景・案・図・メモに入れる目印（どこにも残っていないことを確かめる） */
const Q = "SENTINEL_ASKQ_7c1f where should the save button go?";
const CTX = "SENTINEL_ASKCTX_2b9e fourteen fields";
const OPT = "SENTINEL_ASKOPT_0a4d";
const FIG = "SENTINEL_ASKFIG_93e2";
const NOTE = "SENTINEL_ASKNOTE_51aa keep it sticky";
const MARKS = ["SENTINEL_ASKQ_7c1f", "SENTINEL_ASKCTX_2b9e", OPT, FIG, "SENTINEL_ASKNOTE_51aa"];

let env: AiEnv;
afterEach(async () => {
  await env?.cleanup();
});

const logs: string[] = [];
const capture: MetaOnlyLogger = {
  debug: (e: string, f?: LogFields) => logs.push(`${e} ${JSON.stringify(f ?? {})}`),
  info: (e: string, f?: LogFields) => logs.push(`${e} ${JSON.stringify(f ?? {})}`),
  warn: (e: string, f?: LogFields) => logs.push(`${e} ${JSON.stringify(f ?? {})}`),
  error: (e: string, f?: LogFields) => logs.push(`${e} ${JSON.stringify(f ?? {})}`),
};

const askBody = (p: Record<string, unknown> = {}) => ({
  question: Q,
  context: CTX,
  options: [
    {
      label: "Bottom, full width",
      description: `${OPT} always reachable`,
      recommended: true,
      figure: { html: `<svg><text>${FIG}</text></svg>` },
    },
    { label: "Top right", description: "as it is now" },
    { label: "Floating", description: "covers the last field", figure: { error: "too_large" } },
  ],
  explain: { html: `<h1>${FIG}</h1>` },
  ...p,
});

async function setup(o: { session?: boolean } = {}) {
  logs.length = 0;
  env = makeAiEnv({ now: T0, logger: capture });
  putSetting(env.mutate, "turn.store_detail", true);
  present(env.sqlite, T0 - H, T0 + 14 * H);
  const events: string[] = [];
  env.hub.subscribe((m) => events.push(JSON.stringify(m)));
  if (o.session !== false) {
    env.git.repos.set("/w/app", "/w/app");
    env.git.defaults.set("/w/app", "main");
    const root = join(env.home, ".claude");
    const tr = claudeTranscript(root, {
      sid: "77777777-0000-4000-8000-0000000000a1",
      cwd: "/w/app",
      branch: "feat/settings",
    });
    tr.human(T0, { text: "settings form" });
    // AI は ask_user を呼んで、結果を待っている（記録には結果の無いツールの呼び出し。入力に問いの文が入っている）
    tr.toolUse(T0 + MIN, "mcp__turnlane__ask_user", { question: Q, context: CTX });
  }
  env.clock.set(T0 + 2 * MIN);
  await env.ai.supervisor.detect();
  await env.ai.supervisor.beginIngest();
  await env.sync();
  if (o.session !== false)
    env.sqlite.run(
      "UPDATE ai_session SET live_status = 'busy', live_pid = 4242, live_checked_at = ?",
      [env.clock.now()],
    );
  const app = createApp({
    token: TOKEN,
    port: 7317,
    hub: env.hub,
    health: () => ({}) as never,
    admin: { backup: () => ({ date: "", path: "" }) },
    ai: () => env.ai.deps,
    recordUserOp: env.ai.recordUserOp,
  });
  const call = async <T>(method: string, path: string, body?: unknown) => {
    const r = await app.request(`http://${HOST}${path}`, {
      method,
      headers: {
        host: HOST,
        authorization: `Bearer ${TOKEN}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, headers: r.headers, body: (await r.json()) as T };
  };
  const queue = async () => (await call<QueueResponse>("GET", "/api/queue")).body.items;
  const followUp = (askId: string) =>
    env.sqlite
      .query<{ id: string; status: string; close_reason: string | null }, [string]>(
        "SELECT id, status, close_reason FROM follow_up WHERE artifact_ref = ?",
      )
      .get(`ask_user:${askId}:ask`);
  return { call, queue, followUp, events };
}

/** データディレクトリの全ファイル（DB・WAL・spool・ログ・バックアップ）と、DB の全テーブルの行に目印が無いか */
function leaks(events: string[]): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const n of readdirSync(dir)) {
      const p = join(dir, n);
      if (statSync(p).isDirectory()) walk(p);
      else {
        const s = readFileSync(p).toString("latin1");
        for (const m of MARKS) if (s.includes(m)) found.push(`${p}: ${m}`);
      }
    }
  };
  walk(env.dataDir);
  const tables = env.sqlite
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all();
  for (const t of tables) {
    const rows = JSON.stringify(env.sqlite.query(`SELECT * FROM "${t.name}"`).all());
    for (const m of MARKS) if (rows.includes(m)) found.push(`table ${t.name}: ${m}`);
  }
  for (const e of events) for (const m of MARKS) if (e.includes(m)) found.push(`sse: ${m}`);
  for (const l of logs) for (const m of MARKS) if (l.includes(m)) found.push(`log: ${m}`);
  return found;
}

describe("ask → 選ぶ → 返す → 結果", () => {
  test("AI のプロセス（pid）のセッションのカードに付き、回答待ちになり、返した答えが long-poll に戻る", async () => {
    const { call, queue, followUp, events } = await setup();
    const c = await call<AskCreateResponse>(
      "POST",
      "/api/asks",
      askBody({ pid: 4242, cwd: "/w/app" }),
    );
    expect(c.status).toBe(201);
    expect(c.body.ownCard).toBe(false);
    const id = c.body.id;
    const items = await queue();
    const item = items.find((x) => x.workItemId === c.body.workItemId);
    expect(item?.status).toBe("needs_input");
    expect(item?.reason).toBe("ask_user");
    expect(item?.followUps).toHaveLength(1);
    expect(item?.followUps[0]).toMatchObject({
      kind: "reply",
      ask: true,
      askUser: id,
      expiresAt: null,
    });
    // 一覧には中身が入らない
    expect(JSON.stringify(items)).not.toContain("SENTINEL");
    // 行の「待っている理由」は表示の瞬間にメモリから（問いと案の名前）
    const g = await call<GlanceResponse>("GET", `/api/work-items/${c.body.workItemId}/glance`);
    expect(g.body.kind).toBe("ask");
    expect(g.body.ask?.question).toBe(Q);
    expect(g.body.ask?.options).toEqual(["Bottom, full width", "Top right", "Floating"]);
    // 画面が中身を読む（no-store）
    const v = await call<AskView>("GET", `/api/asks/${id}`);
    expect(v.headers.get("cache-control")).toBe("no-store");
    expect(v.body.state).toBe("open");
    expect(v.body.question).toBe(Q);
    expect(v.body.context).toBe(CTX);
    expect(v.body.options?.map((o) => [o.n, o.label, o.recommended])).toEqual([
      [1, "Bottom, full width", true],
      [2, "Top right", false],
      [3, "Floating", false],
    ]);
    expect(v.body.options?.[0]?.figure).toEqual({ html: `<svg><text>${FIG}</text></svg>` });
    expect(v.body.options?.[2]?.figure).toEqual({ error: "too_large" });
    // まだ答えが無い: long-poll は open
    const r0 = await call<AskResultResponse>("GET", `/api/asks/${id}/result?wait=0`);
    expect(r0.body).toEqual({ state: "open" });
    // 待っている間に返す
    const waiting = call<AskResultResponse>("GET", `/api/asks/${id}/result?wait=5000`);
    env.clock.set(T0 + 5 * MIN);
    const a = await call<{ state: string; answeredAt: number }>("POST", `/api/asks/${id}/answer`, {
      choice: "Top right",
      note: NOTE,
    });
    expect(a.body).toEqual({ state: "answered", answeredAt: T0 + 5 * MIN });
    expect((await waiting).body).toEqual({ state: "answered", choice: "Top right", note: NOTE });
    await env.ai.runner.runNow();
    // 返答タスクは返答済み、カードは回答待ちから外れる。中身は捨てた
    expect(followUp(id)).toMatchObject({ status: "done", close_reason: "auto:answered" });
    expect((await queue()).some((x) => x.workItemId === c.body.workItemId)).toBe(false);
    const after = await call<AskView>("GET", `/api/asks/${id}`);
    expect(after.body.state).toBe("answered");
    expect(after.body.closedAt).toBe(T0 + 5 * MIN);
    expect(after.body.question).toBeUndefined();
    // 2 回目は答えを持っていない（受け取ったら捨てる）
    expect((await call<AskResultResponse>("GET", `/api/asks/${id}/result`)).body).toEqual({
      state: "answered",
    });
    expect(leaks(events)).toEqual([]);
  });

  test("pid が分からなければ作業ディレクトリ（その下を含む）で最近動いたカード", async () => {
    const { call } = await setup();
    const card = env.sqlite
      .query<{ w: string }, []>("SELECT work_item_id AS w FROM ai_turn LIMIT 1")
      .get()?.w;
    const c = await call<AskCreateResponse>("POST", "/api/asks", askBody({ cwd: "/w/app/" }));
    expect(c.body).toMatchObject({ workItemId: card, ownCard: false });
  });

  test("メモだけでも返せる。知らない案・空の答えは 400", async () => {
    const { call } = await setup();
    const c = await call<AskCreateResponse>("POST", "/api/asks", askBody({ pid: 4242 }));
    const id = c.body.id;
    expect((await call("POST", `/api/asks/${id}/answer`, { choice: "Nope" })).status).toBe(400);
    expect((await call("POST", `/api/asks/${id}/answer`, {})).status).toBe(400);
    expect((await call("POST", `/api/asks/${id}/answer`, { note: "why not both?" })).status).toBe(
      200,
    );
    expect((await call<AskResultResponse>("GET", `/api/asks/${id}/result`)).body).toEqual({
      state: "answered",
      note: "why not both?",
    });
    expect((await call("POST", `/api/asks/${id}/answer`, { note: "again" })).status).toBe(409);
  });

  test("上限を超えた問いは項目の名前で 400（切らない）", async () => {
    const { call } = await setup();
    const r = await call<{ error: string; field: string }>(
      "POST",
      "/api/asks",
      askBody({ question: "q".repeat(121) }),
    );
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: "invalid_input", field: "question" });
  });
});

describe("閉じ方", () => {
  test("自分の番の「対応不要」で閉じたら、AI には dismissed", async () => {
    const { call, followUp } = await setup();
    const id = (await call<AskCreateResponse>("POST", "/api/asks", askBody({ pid: 4242 }))).body.id;
    const fu = followUp(id);
    expect(fu?.status).toBe("open");
    env.ai.deps.ops.dismiss(fu?.id ?? "");
    expect((await call<AskResultResponse>("GET", `/api/asks/${id}/result`)).body).toEqual({
      state: "dismissed",
    });
    await env.ai.runner.runNow();
    expect(followUp(id)?.status).toBe("dismissed");
  });

  test("POST /dismiss（画面）も同じ", async () => {
    const { call, followUp } = await setup();
    const id = (await call<AskCreateResponse>("POST", "/api/asks", askBody({ pid: 4242 }))).body.id;
    expect((await call("POST", `/api/asks/${id}/dismiss`)).status).toBe(200);
    expect((await call<AskResultResponse>("GET", `/api/asks/${id}/result`)).body.state).toBe(
      "dismissed",
    );
    expect(followUp(id)?.status).toBe("dismissed");
  });

  test("AI 側で打ち切られた（MCP の取り消し）→ 返答タスクは置き換え（auto:ask_cancelled）、画面は「もう進んでいます」", async () => {
    const { call, followUp, queue } = await setup();
    const c = await call<AskCreateResponse>("POST", "/api/asks", askBody({ pid: 4242 }));
    expect((await call("POST", `/api/asks/${c.body.id}/cancel`)).status).toBe(200);
    await env.ai.runner.runNow();
    expect(followUp(c.body.id)).toMatchObject({
      status: "superseded",
      close_reason: "auto:ask_cancelled",
    });
    expect((await queue()).some((x) => x.workItemId === c.body.workItemId)).toBe(false);
    expect((await call<AskView>("GET", `/api/asks/${c.body.id}`)).body.state).toBe("cancelled");
    expect(
      (await call("POST", `/api/asks/${c.body.id}/answer`, { choice: "Top right" })).status,
    ).toBe(409);
  });

  test("MCP のプロセスが 90 秒待ちに来なければ取り消す（AI が居なくなった）", async () => {
    const { call, followUp } = await setup();
    const id = (await call<AskCreateResponse>("POST", "/api/asks", askBody({ pid: 4242 }))).body.id;
    env.clock.set(env.clock.now() + ABANDON_MS - 1);
    env.ai.deps.asks.sweep();
    expect(env.ai.deps.asks.store.get(id)?.state).toBe("open");
    env.clock.set(env.clock.now() + 1);
    env.ai.deps.asks.sweep();
    await env.ai.runner.runNow();
    expect(env.ai.deps.asks.store.get(id)?.state).toBe("cancelled");
    expect(followUp(id)?.close_reason).toBe("auto:ask_cancelled");
  });

  test("デーモンが再起動すると開いていた問いは消える: 結果は 404、返答タスクは auto:ask_lost", async () => {
    const { call, followUp, events } = await setup();
    const id = (await call<AskCreateResponse>("POST", "/api/asks", askBody({ pid: 4242 }))).body.id;
    expect(followUp(id)?.status).toBe("open");
    // 同じ DB で新しいデーモン（メモリは空）
    const again = createAiSystem({
      sqlite: env.sqlite,
      mutate: env.mutate,
      clock: env.clock,
      logger: nullLogger,
      hub: env.hub,
      git: env.git,
      home: env.home,
      dataDir: env.dataDir,
      vars: {},
      gh: null,
      noWatch: true,
      openSystem: env.open,
    });
    again.runner.runOnce();
    expect(followUp(id)).toMatchObject({ status: "superseded", close_reason: "auto:ask_lost" });
    const app2 = createApp({
      token: TOKEN,
      port: 7317,
      hub: env.hub,
      health: () => ({}) as never,
      admin: { backup: () => ({ date: "", path: "" }) },
      ai: () => again.deps,
    });
    const r = await app2.request(`http://${HOST}/api/asks/${id}/result`, {
      headers: { host: HOST, authorization: `Bearer ${TOKEN}` },
    });
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: "ask_not_found" });
    await again.stop();
    expect(leaks(events)).toEqual([]);
  });
});

describe("自分のカード", () => {
  test("AI のセッションのカードが無ければ、報告の作業のカード（題名はフォルダの名前）。閉じたら done", async () => {
    const { call, queue, events } = await setup({ session: false });
    const c = await call<AskCreateResponse>(
      "POST",
      "/api/asks",
      askBody({ cwd: "/w/elsewhere/proj", pid: 999 }),
    );
    expect(c.body.ownCard).toBe(true);
    expect(c.body.workItemId).not.toBeNull();
    const item = (await queue()).find((x) => x.workItemId === c.body.workItemId);
    expect(item?.status).toBe("needs_input");
    expect(item?.title).toBe("proj");
    expect(item?.sources.some((s) => s.tool === "agent" && s.report)).toBe(true);
    await call("POST", `/api/asks/${c.body.id}/answer`, { choice: "Floating" });
    await call("GET", `/api/asks/${c.body.id}/result`);
    await env.ai.runner.runNow();
    // 報告の作業は done（状態と題名だけを報告した。spool に中身は無い）
    for (let i = 0; i < 20 && (await queue()).length > 0; i++) await Bun.sleep(20);
    const st = env.sqlite
      .query<{ status: string }, [string]>("SELECT status FROM work_item WHERE id = ?")
      .get(c.body.workItemId ?? "");
    expect(st?.status).toBe("done");
    expect(leaks(events)).toEqual([]);
  });
});

describe("カードにできない", () => {
  test("AI の取り込みがオフで自分のカードも作れなければ 409 no_card（問いは開いておかない）", async () => {
    const { call } = await setup({ session: false });
    for (const src of env.ai.deps.sources()) env.ai.deps.patchSource(src.id, { enabled: false });
    await env.ai.deps.rescan();
    const r = await call<{ error: string }>("POST", "/api/asks", askBody({ cwd: "/w/x" }));
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: "no_card" });
    expect(env.ai.deps.asks.store.live()).toEqual([]);
  });
});

describe("中身を残さない（ADR 0005・0022 の番兵）", () => {
  test("記録の結果の無い ask_user の呼び出し（入力に問い）を取り込んでも、待ちの中身として保存しない", async () => {
    const { call, events } = await setup();
    await call<AskCreateResponse>("POST", "/api/asks", askBody({ pid: 4242 }));
    await env.ai.runner.runNow();
    expect(
      env.sqlite.query<{ n: number }, []>("SELECT count(*) AS n FROM wait_detail").get()?.n,
    ).toBe(0);
    expect(leaks(events)).toEqual([]);
  });

  test("番兵そのものが目印を見つけられる（DB の行・SSE・ログ）", async () => {
    const events: string[] = [];
    await setup();
    putSetting(env.mutate, "test.sentinel", OPT);
    events.push(`{"x":"${FIG}"}`);
    logs.push(`ask.opened ${NOTE}`);
    const found = leaks(events);
    expect(found.some((x) => x.startsWith("table "))).toBe(true);
    expect(found).toContain(`sse: ${FIG}`);
    expect(found).toContain("log: SENTINEL_ASKNOTE_51aa");
  });
});
