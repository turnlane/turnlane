/**
 * デイビューの API（GET /api/day/:date。m2-api.md 2.3・2.4、M2-19）: ターンごとの実行と3区分の待ち、
 * 日の集計（自分・会議）、Closed today、空き枠、リポジトリ別の放置。本文は返さない。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { DayResponse } from "@turnlane/core/api";
import { createApp } from "../src/http/app.ts";
import { createPlanner } from "../src/planner/index.ts";
import { type AiEnv, makeAiEnv, present } from "./helpers/env.ts";
import { claudeTranscript } from "./helpers/transcript.ts";

const TOKEN = "e".repeat(64);
const PORT = 7317;
const HOST = `127.0.0.1:${PORT}`;
const MIN = 60_000;
const H = 60 * MIN;
const T0 = Date.UTC(2026, 8, 14, 1, 0); // 2026-09-14 10:00 JST（月）
const D = "2026-09-14";
const jst = (hhmm: string, d = D) => Date.parse(`${d}T${hhmm}:00+09:00`);

let env: AiEnv;
afterEach(async () => {
  await env?.cleanup();
});

function setup() {
  env = makeAiEnv({ now: T0 });
  // この日は T0 の1時間前から Mac を使い続けている（D-105。放置は在席の間だけ数える）
  present(env.sqlite, T0 - 60 * 60_000, T0 + 14 * 60 * 60_000);
  env.git.repos.set("/w/app", "/w/app");
  env.git.defaults.set("/w/app", "main");
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
  const tr = claudeTranscript(join(env.home, ".claude"), {
    sid: "11111111-0000-4000-8000-000000000001",
    cwd: "/w/app",
    branch: "feat/login",
  });
  return { call, tr };
}

function addEvent(start: number, end: number, title = "Weekly sync") {
  const now = env.clock.now();
  env.sqlite
    .query(
      `INSERT OR IGNORE INTO calendar (id, provider, external_id, name, role, is_writable, created_at, updated_at)
       VALUES ('cal1', 'eventkit', 'cal1', 'Work', 'source', 0, ?, ?)`,
    )
    .run(now, now);
  env.sqlite
    .query(
      `INSERT INTO calendar_event (id, calendar_id, external_id, occurrence_start, title, start_at, end_at, all_day, status, availability, is_own_timeblock, fetched_at)
       VALUES (?, 'cal1', ?, ?, ?, ?, ?, 0, 'confirmed', 'busy', 0, ?)`,
    )
    .run(`ev-${start}`, `ev-${start}`, start, title, start, end, now);
}

describe("GET /api/day/:date（M2-19）", () => {
  test("今日: ターンごとの実行と3区分の待ち、自分・会議、空き枠、リポジトリ別の放置", async () => {
    const { call, tr } = setup();
    tr.human(T0 - 2 * MIN);
    tr.assistantEnd(T0, "Which option do you prefer?", { durationMs: 2 * MIN });
    for (const m of [1, 16, 40]) {
      env.clock.set(T0 + m * MIN);
      await env.sync();
    }
    addEvent(jst("09:30"), jst("10:30"));
    // 14:00〜15:00 に置いたタスク
    const t = await call<{ task: { id: string } }>("POST", "/api/tasks", {
      raw: "Write article outline",
      date: D,
    });
    await call("POST", "/api/time-blocks", {
      taskId: t.body.task.id,
      startAt: jst("14:00"),
      endAt: jst("15:00"),
    });

    const r = await call<DayResponse>("GET", `/api/day/${D}`);
    expect(r.status).toBe(200);
    const day = r.body.day;
    expect([day.date, day.phase, day.logicalPhase]).toEqual([D, "today", "today"]);
    expect(day.aiLane).toHaveLength(1);
    const item = day.aiLane[0];
    expect(item?.status).toBe("your_turn");
    // ターンはまとめずに返し、ポップオーバー用の件数を持つ（本文は持たない）
    expect(item?.runs).toHaveLength(1);
    expect(item?.runs[0]).toMatchObject({ open: false, tool: "claude_code" });
    expect(typeof item?.runs[0]?.toolCalls).toBe("number");
    // 待ちは 猶予15分 → タスクが出るまでの集計外（no_task）→ 放置（開いている）
    expect(item?.waits.map((w) => [w.kind, w.excludedBy, w.idle])).toEqual([
      ["grace", null, false],
      ["excluded", "no_task", false],
      ["idle", null, true],
    ]);
    expect(item?.waits[0] && item.waits[0].end - item.waits[0].start).toBe(15 * MIN);
    expect(item?.waits[2]?.open).toBe(true);
    const idle = (item?.waits[2]?.end ?? 0) - (item?.waits[2]?.start ?? 0);
    expect(idle).toBe(24 * MIN);
    expect(day.totals.idleMs).toBe(idle);
    expect(day.idleByRepo).toEqual([{ repoRoot: "/w/app", ms: idle }]);
    // 会議 = 論理日の busy な時刻付き予定（D-105 で勤務時間で切るのをやめた）
    expect(day.totals.meetingsMs).toBe(60 * MIN);
    expect(day.totals.youMs).toBe(0);
    // 空き枠: 今（10:40）より後、時間ブロック（14:00〜15:00）を除き、計画の終了（19:00）まで。15分単位
    expect(day.freeSlots).toEqual([
      { start: jst("10:45"), end: jst("14:00") },
      { start: jst("15:00"), end: jst("19:00") },
    ]);
    expect(day.closedToday).toEqual([]);
    expect(JSON.stringify(r.body)).not.toContain("Which option");

    // 答えると Closed today に replied で入る
    tr.human(T0 + 45 * MIN);
    env.clock.set(T0 + 46 * MIN);
    await env.sync();
    const r2 = await call<DayResponse>("GET", `/api/day/${D}`);
    expect(r2.body.day.closedToday.map((x) => x.kind)).toEqual(["replied"]);
  });

  test("過去日も AI レーンを返し（持ち越しは今日だけ）、未来日は空。日付の形が違えば 400", async () => {
    const { call, tr } = setup();
    tr.human(T0 - 2 * MIN);
    tr.assistantEnd(T0, "Which option do you prefer?", { durationMs: 2 * MIN });
    env.clock.set(T0 + 30 * MIN);
    await env.sync();
    env.clock.set(T0 + 24 * H);
    await env.sync();
    const past = await call<DayResponse>("GET", `/api/day/${D}`);
    expect(past.body.day.phase).toBe("past");
    expect(past.body.day.aiLane.map((x) => [x.runs.length, x.carriedFrom])).toEqual([[1, null]]);
    expect(past.body.day.freeSlots).toEqual([]);
    // 翌日（今日）は前日の未完了を持ち越す（実行なし）
    const today = await call<DayResponse>("GET", "/api/day/2026-09-15");
    expect(today.body.day.aiLane.map((x) => [x.runs.length, x.carriedFrom])).toEqual([[0, D]]);
    const future = await call<DayResponse>("GET", "/api/day/2026-09-20");
    expect(future.body.day.aiLane).toEqual([]);
    expect((await call("GET", "/api/day/2026-9-1")).status).toBe(400);
  });
});

describe("深夜のデイビュー（暦日の時間軸、集計は論理日。D-054、ux-mvp 4.5）", () => {
  // 9/14 10:00 に始め、23:30 に始めたターンが 9/15 3:50（日付区切り 4:00 の前）も続いている。別の作業を 0:10〜0:50 に動かした
  const D2 = "2026-09-15";
  const at = (day: number, h: number, m = 0) => Date.UTC(2026, 8, day, h - 9, m);
  const NOW = at(15, 3, 50);
  const m = (x: number) => Math.round(x / MIN) * MIN;

  async function night() {
    const { call, tr } = setup();
    tr.human(T0);
    tr.assistantEnd(T0 + 5 * MIN, "Done.", { durationMs: 5 * MIN });
    const tr2 = claudeTranscript(join(env.home, ".claude"), {
      sid: "11111111-0000-4000-8000-000000000002",
      cwd: "/w/app",
      branch: "fix/night",
    });
    tr2.human(at(15, 0, 10));
    tr2.assistantEnd(at(15, 0, 50), "Done.", { durationMs: 40 * MIN });
    tr.human(at(14, 23, 30));
    for (const t of [at(14, 23, 31), at(15, 0, 51), NOW]) {
      env.clock.set(t);
      await env.sync();
    }
    const day = async (d: string) => (await call<DayResponse>("GET", `/api/day/${d}`)).body;
    return { call, day };
  }

  test("暦日の今日（9/15）: 0:00〜日付区切りの実行を返し、続いているターンは now まで。集計は今の論理日（9/14）", async () => {
    const { day } = await night();
    const r = await day(D2);
    expect([r.today, r.displayToday]).toEqual([D, D2]);
    const d = r.day;
    expect([d.phase, d.logicalPhase]).toEqual(["today", "future"]);
    const runs = d.aiLane
      .flatMap((x) => x.runs.map((run) => [x.branch, m(run.start), m(run.end), run.open]))
      .sort((a, b) => Number(a[1]) - Number(b[1]));
    // 23:30 に始めたターンは日をまたいで返す（切り取りはクライアント）。開いているので end = now
    expect(runs).toEqual([
      ["feat/login", at(14, 23, 30), NOW, true],
      ["fix/night", at(15, 0, 10), at(15, 0, 50), false],
    ]);
    // 上部の集計・Closed today・放置の内訳は今の論理日（9/14）
    expect(d.summary.date).toBe(D);
    expect(d.summary.phase).toBe("today");
    // AI 時間は論理日 9/14 の値（前の暦日のデイビューと同じ）。0:10〜0:50 の 40m も 9/14 に入る
    const prev = (await day(D)).day;
    expect(d.totals).toEqual(prev.totals);
    expect(d.closedToday).toEqual(prev.closedToday);
    expect(d.idleByRepo).toEqual(prev.idleByRepo);
    expect(m(d.totals.aiMs)).toBeGreaterThanOrEqual(45 * MIN);
  });

  test("前の暦日（9/14）: 0:00 以降に始めた実行は返さない（軸の外に描かない）。日をまたぐ実行は両日に入る", async () => {
    const { day } = await night();
    const d = (await day(D)).day;
    expect([d.phase, d.logicalPhase, d.summary.date]).toEqual(["past", "today", D]);
    const starts = d.aiLane.flatMap((x) => x.runs.map((run) => m(run.start))).sort();
    expect(starts).toEqual([T0, at(14, 23, 30)]);
  });

  test("日付区切り（4:00）を過ぎると、今日のデイビューの集計はその日付の論理日に戻る", async () => {
    const { day } = await night();
    env.clock.set(at(15, 4, 30));
    await env.sync();
    const d = (await day(D2)).day;
    expect([d.phase, d.logicalPhase, d.summary.date]).toEqual(["today", "today", D2]);
  });
});
