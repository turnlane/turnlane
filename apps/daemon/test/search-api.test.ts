/**
 * ⌘K の検索（GET /api/search。m2-api.md 17章、M2-15）: タスクの題名、AI 項目の題名・リポジトリ・ブランチ・PR 番号、
 * 予定の題名。語はすべて含むもの（AND）。会話の本文・タスクのメモ・予定の場所は見ない。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { SearchResponse } from "@turnlane/core/api";
import { createApp } from "../src/http/app.ts";
import { createPlanner } from "../src/planner/index.ts";
import { type AiEnv, makeAiEnv } from "./helpers/env.ts";
import { claudeTranscript } from "./helpers/transcript.ts";

const TOKEN = "e".repeat(64);
const PORT = 7317;
const HOST = `127.0.0.1:${PORT}`;
const MIN = 60_000;
const T0 = Date.UTC(2026, 8, 14, 1, 0); // 2026-09-14 10:00 JST（月）
const jst = (hhmm: string, d = "2026-09-14") => Date.parse(`${d}T${hhmm}:00+09:00`);

let env: AiEnv;
afterEach(async () => {
  await env?.cleanup();
});

async function setup() {
  env = makeAiEnv({ now: T0 });
  env.git.repos.set("/w/billing-api", "/w/billing-api");
  env.git.defaults.set("/w/billing-api", "main");
  const planner = createPlanner({
    sqlite: env.sqlite,
    mutate: env.mutate,
    clock: env.clock,
    hub: env.hub,
    ai: env.ai,
  });
  const app = createApp({
    token: TOKEN,
    port: PORT,
    hub: env.hub,
    health: () => ({}) as never,
    admin: { backup: () => ({ date: "", path: "" }) },
    ai: () => env.ai.deps,
    planner: () => planner,
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
    return { status: r.status, body: (await r.json()) as T };
  };
  const search = async (q: string, limit?: number) =>
    (
      await call<SearchResponse>(
        "GET",
        `/api/search?q=${encodeURIComponent(q)}${limit ? `&limit=${limit}` : ""}`,
      )
    ).body;
  // AI 項目: billing-api の feat/invoice-retry。最後の発言は質問（本文は検索に使わない）
  const tr = claudeTranscript(join(env.home, ".claude"), {
    sid: "11111111-0000-4000-8000-000000000001",
    cwd: "/w/billing-api",
    branch: "feat/invoice-retry",
  });
  tr.human(T0 - 2 * MIN);
  tr.assistantEnd(T0, "Should the secret-word retry use exponential backoff?", {
    durationMs: 2 * MIN,
  });
  for (const m of [1, 16, 40]) {
    env.clock.set(T0 + m * MIN);
    await env.sync();
  }
  const wi = env.sqlite.query<{ id: string }, []>("SELECT id FROM work_item").get();
  if (!wi) throw new Error("no work item");
  env.sqlite.run("UPDATE work_item SET pr_ref = 'acme/billing-api#142' WHERE id = ?", [wi.id]);
  return { call, search, workItemId: wi.id };
}

function addEvent(
  id: string,
  start: number,
  title: string,
  extra: Partial<Record<string, unknown>> = {},
) {
  const now = env.clock.now();
  env.sqlite
    .query(
      `INSERT OR IGNORE INTO calendar (id, provider, external_id, name, role, is_writable, created_at, updated_at)
       VALUES ('cal1', 'eventkit', 'cal1', 'Work', 'source', 0, ?, ?)`,
    )
    .run(now, now);
  env.sqlite
    .query(
      `INSERT INTO calendar_event (id, calendar_id, external_id, occurrence_start, title, location, start_at, end_at, all_day, status, availability, is_own_timeblock, fetched_at)
       VALUES (?, 'cal1', ?, ?, ?, ?, ?, ?, 0, ?, 'busy', ?, ?)`,
    )
    .run(
      id,
      id,
      start,
      title,
      (extra.location as string | undefined) ?? null,
      start,
      start + 30 * MIN,
      (extra.status as string | undefined) ?? "confirmed",
      (extra.own as number | undefined) ?? 0,
      now,
    );
}

describe("GET /api/search（M2-15）", () => {
  test("AI 項目: 題名・リポジトリ・ブランチ・PR 番号で引ける", async () => {
    const { search, workItemId } = await setup();
    for (const q of [
      "billing",
      "invoice-retry",
      "142",
      "#142",
      "pr 142",
      "PR #142",
      "billing 142",
    ]) {
      const r = await search(q);
      expect(r.aiItems.map((x) => x.id)).toEqual([workItemId]);
    }
    const r = await search("142");
    expect(r.aiItems[0]).toMatchObject({
      repo: "billing-api",
      branch: "feat/invoice-retry",
      prs: [142],
      date: "2026-09-14",
    });
    expect(r.q).toBe("142");
    expect(typeof r.rev).toBe("number");
    // AND: 片方しか含まないものは出さない
    expect((await search("billing 143")).aiItems).toEqual([]);
  });

  test("本文は検索しない（最後の発言の語で引けない）", async () => {
    const { search } = await setup();
    const r = await search("secret-word");
    expect([r.aiItems, r.tasks, r.events]).toEqual([[], [], []]);
  });

  test("タスク: 題名だけ。メモ・削除・やめたものは出さない。自動生成の題名は元の AI 項目の値で引ける", async () => {
    const { call, search } = await setup();
    const a = await call<{ task: { id: string } }>("POST", "/api/tasks", {
      raw: "Write article outline",
      date: "2026-09-15",
      notes: "hidden-memo",
    });
    const b = await call<{ task: { id: string } }>("POST", "/api/tasks", {
      raw: "Outline for the talk",
    });
    const c = await call<{ task: { id: string } }>("POST", "/api/tasks", {
      raw: "Outline deleted",
      date: "2026-09-14",
    });
    await call("DELETE", `/api/tasks/${c.body.task.id}`);
    const d = await call<{ task: { id: string } }>("POST", "/api/tasks", {
      raw: "Outline canceled",
      date: "2026-09-14",
    });
    await call("PATCH", `/api/tasks/${d.body.task.id}`, { status: "canceled" });

    const r = await search("outline");
    // 日付のあるものが先（今日に近い順）、Inbox は最後
    expect(r.tasks.map((x) => x.task.id)).toEqual([a.body.task.id, b.body.task.id]);
    expect((await search("write outline")).tasks.map((x) => x.task.id)).toEqual([a.body.task.id]);
    expect((await search("hidden-memo")).tasks).toEqual([]);

    // 質問で止まった AI 項目の返答タスク（自動生成の題名）はリポジトリ名でも引ける
    const auto = (await search("billing")).tasks;
    expect(auto.length).toBeGreaterThan(0);
    expect(auto[0]?.task.title.t).toBe("auto");
  });

  test("予定: 題名だけ。キャンセル・自分の時間ブロックは出さない。今に近い順", async () => {
    const { search } = await setup();
    addEvent("e1", jst("15:00"), "Design review");
    addEvent("e2", jst("11:00"), "Design review prep", { location: "Room secret-place" });
    addEvent("e3", jst("16:00"), "Design review (moved)", { status: "cancelled" });
    addEvent("e4", jst("17:00"), "Design review block", { own: 1 });
    const r = await search("design review");
    expect(r.events.map((e) => e.id)).toEqual(["e2", "e1"]);
    expect(r.events[0]).toMatchObject({
      allDay: false,
      date: "2026-09-14",
      title: "Design review prep",
    });
    expect((await search("secret-place")).events).toEqual([]);
  });

  test("limit は種類ごとの上限。q が空なら 400", async () => {
    const { call, search } = await setup();
    for (const n of [1, 2, 3]) await call("POST", "/api/tasks", { raw: `Draft ${n}` });
    expect((await search("draft", 2)).tasks).toHaveLength(2);
    expect((await search("draft")).tasks).toHaveLength(3);
    expect((await call("GET", "/api/search?q=")).status).toBe(400);
    expect((await call("GET", "/api/search?q=x&limit=99")).status).toBe(400);
  });
});
