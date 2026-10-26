/**
 * 記録（日報）・持ち越し・日付区切り・利用計測（M4-3・M4-4・M5-1、D-192）の結合テスト。
 * app.request で API を通す。取り込みは合成のトランスクリプト、時計は偽物（2026-10-02 金曜 JST）。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { insertRow, newId, schema } from "@turnlane/core";
import type {
  BoardResponse,
  CarryDayResponse,
  DailyReportResponse,
  DeferFollowUpResponse,
  QueueResponse,
  UndoCarryResponse,
  UsageStats,
} from "@turnlane/core/api";
import { createApp } from "../src/http/app.ts";
import { createPlanner } from "../src/planner/index.ts";
import { type AiEnv, makeAiEnv, present } from "./helpers/env.ts";
import { claudeTranscript } from "./helpers/transcript.ts";

const TOKEN = "d".repeat(64);
const PORT = 7317;
const HOST = `127.0.0.1:${PORT}`;
const MIN = 60_000;
const H = 60 * MIN;
// 2026-10-02（金）09:00 JST
const T0 = Date.UTC(2026, 9, 2, 0, 0);
const THU = "2026-10-01";
const FRI = "2026-10-02";
const MON = "2026-10-05";

let env: AiEnv;
afterEach(async () => {
  await env?.cleanup();
});

function setup() {
  env = makeAiEnv({ now: T0 });
  // 金曜は 8:00〜23:00 に Mac を使っていた（D-105。放置は在席の間だけ数える）
  present(env.sqlite, T0 - H, T0 + 14 * H);
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
    recordUserOp: env.ai.recordUserOp,
  });
  const call = async <T>(method: string, path: string, body?: unknown) => {
    const r = await app.request(`http://${HOST}${path}`, {
      method,
      headers: {
        host: HOST,
        authorization: `Bearer ${TOKEN}`,
        "x-turnlane-client": "cli",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await r.text();
    let json: unknown = text;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: r.status, body: json as T };
  };
  const tr = claudeTranscript(join(env.home, ".claude"), {
    sid: "22222222-0000-4000-8000-000000000001",
    cwd: "/w/app",
    branch: "feat/login",
  });
  return { call, tr, planner };
}

const q = <T>(sql: string, ...args: (string | number)[]) =>
  env.sqlite.query<T, (string | number)[]>(sql).all(...args);

function task(title: string, date: string | null, extra: Record<string, unknown> = {}) {
  return insertRow(env.mutate, schema.task, {
    title,
    status: "todo",
    scheduledDate: date,
    laneOrder: `a${title.length}`,
    source: "manual",
    ...extra,
  });
}

describe("記録（M4-3）", () => {
  test("今日の記録は今の事実から組み立てる。持ち越しは自動では出ない（D-192）", async () => {
    const { call, tr } = setup();
    // 9:00 から AI が 30 分動いて終わる。自分は 9:10〜9:35 に1件やり、もう1件は残す
    tr.human(T0);
    tr.assistantEnd(T0 + 30 * MIN, "Done.", { durationMs: 30 * MIN });
    const done = task("Morning email", FRI, { status: "done", completedAt: T0 + 35 * MIN });
    insertRow(env.mutate, schema.taskTimeEntry, {
      taskId: done.id,
      startAt: T0 + 10 * MIN,
      endAt: T0 + 35 * MIN,
      source: "tap",
    });
    task("Invoice template fix", FRI);
    env.clock.set(T0 + 9 * H);
    await env.sync();

    const r = await call<DailyReportResponse>("GET", `/api/reports/daily/${FRI}?lang=en`);
    expect(r.status).toBe(200);
    expect(r.body.saved).toBe(false);
    expect(r.body.report.did.map((d) => [d.title, d.ms])).toEqual([
      [{ t: "text", text: "Morning email" }, 25 * MIN],
    ]);
    expect(r.body.report.carried).toEqual([]);
    expect(r.body.report.runs).toBe(1);
    expect(r.body.report.aiMs).toBe(30 * MIN);
    expect(r.body.report.aiDid.map((x) => [x.repo, x.status])).toEqual([["app", "done"]]);
    expect(r.body.markdown).toContain("Time: You 25m · AI 30m (1 run)");
    expect(r.body.markdown).not.toContain("Carried over");
  });

  test("Note は PUT /api/daily-notes/:date で保存し、記録の Note に入る。未来の日付は 400", async () => {
    const { call } = setup();
    env.clock.set(T0 + 8 * H);
    expect((await call("PUT", `/api/daily-notes/${FRI}`, { note: " one line " })).status).toBe(200);
    const r = await call<DailyReportResponse>("GET", `/api/reports/daily/${FRI}?lang=en`);
    expect(r.body.saved).toBe(false);
    expect(r.body.report.note).toBe("one line");
    expect(r.body.markdown).toEndWith("### Note\none line\n");
    expect((await call("GET", `/api/reports/daily/${MON}`)).status).toBe(400);
  });

  test("期限切れになった返答タスクの名前が記録に出る（S3）", async () => {
    const { call, tr } = setup();
    // 前日 8:00 の質問 → 15分で返答タスク → 72時間で期限切れ（10/2 の 8:15 に閉じる）
    const start = T0 - 3 * 24 * H - H;
    tr.human(start - 5 * MIN);
    tr.assistantEnd(start, "Should I rename the env var?", { durationMs: 5 * MIN });
    for (let t = start; t <= T0 + 30 * MIN; t += 30 * MIN) {
      env.clock.set(t);
      await env.sync();
    }
    const r = await call<DailyReportResponse>("GET", `/api/reports/daily/${FRI}?lang=en`);
    expect(r.body.report.expired).toBe(1);
    expect(r.body.markdown).toMatch(/Expired: Reply: .+/);
  });

  test("実行中・待ち中のカードの AI 時間が 0m にならない。質問は回答待ち、許可待ちだけ許可待ちと書く（D-052 (3)(4)）", async () => {
    const { call, tr } = setup();
    const root = join(env.home, ".claude");
    // 9:00 に始めて 9:04 に AskUserQuestion で止まる（hooks なし）
    tr.human(T0);
    tr.ask(T0 + 4 * MIN);
    // 10:00 に始めて 10:05 に許可待ち（hooks）
    const permSid = "22222222-0000-4000-8000-000000000002";
    const perm = claudeTranscript(root, { sid: permSid, cwd: "/w/app", branch: "fix/perm" });
    perm.human(T0 + H);
    const spool = join(env.dataDir, "spool");
    mkdirSync(spool, { recursive: true });
    const hook = (name: string, at: number) =>
      `${JSON.stringify({ v: 1, tool: "claude_code", received_at: at, config_root: root, hook_event_name: name, session_id: permSid })}\n`;
    writeFileSync(
      join(spool, "hooks-20261002.jsonl"),
      hook("UserPromptSubmit", T0 + H) + hook("PermissionRequest", T0 + H + 5 * MIN),
    );
    // 14:58 に始めて今（15:00）も実行中
    const run = claudeTranscript(root, {
      sid: "22222222-0000-4000-8000-000000000003",
      cwd: "/w/app",
      branch: "feat/run",
    });
    run.human(T0 + 6 * H - 2 * MIN);
    env.clock.set(T0 + 6 * H);
    await env.sync();

    const s = await call<DailyReportResponse>("GET", `/api/reports/daily/${FRI}?lang=en`);
    const by = new Map(s.body.report.aiDid.map((x) => [x.branch, x]));
    expect(by.get("feat/login")).toMatchObject({
      status: "needs_input",
      aiMs: 4 * MIN,
      result: { kind: "status", waitingFor: "answer" },
    });
    expect(by.get("fix/perm")).toMatchObject({
      status: "needs_input",
      aiMs: 5 * MIN,
      result: { kind: "status", waitingFor: "approval" },
    });
    expect(by.get("feat/run")).toMatchObject({ status: "running", aiMs: 2 * MIN });
    expect(s.body.report.aiMs).toBe(11 * MIN);
    expect(s.body.markdown).toContain("waiting for your answer, carried over (AI 4m)");
    expect(s.body.markdown).toContain("waiting for approval, carried over (AI 5m)");
    expect(s.body.markdown).toContain("still running, carried over (AI 2m)");
    const ja = await call<DailyReportResponse>("GET", `/api/reports/daily/${FRI}?lang=ja`);
    expect(ja.body.markdown).toContain("回答待ち、持ち越し (AI 4m)");
  });

  test("m 明日: タスクを次の稼働日へ移し、その日の勤務開始までスヌーズする。帯から消え、放置に数えない（D-052 (1)）", async () => {
    const { call, tr } = setup();
    // 9:00〜9:30 の実行が質問で終わる → 9:45 に返答タスク
    tr.human(T0);
    tr.assistantEnd(T0 + 30 * MIN, "Should the drop target snap to 15 minutes?", {
      durationMs: 30 * MIN,
    });
    for (let t = T0 + 30 * MIN; t <= T0 + 9 * H; t += 30 * MIN) {
      env.clock.set(t);
      await env.sync();
    }
    const before = await call<QueueResponse>("GET", "/api/queue");
    const fu = before.body.items[0]?.followUps[0];
    expect(fu).toMatchObject({ kind: "reply", status: "open", taskDate: FRI });
    const idle0 = (await call<DailyReportResponse>("GET", `/api/reports/daily/${FRI}`)).body.report
      .idleMs;

    const r = await call<DeferFollowUpResponse>("POST", `/api/follow-ups/${fu?.id}/defer`);
    expect(r.status).toBe(200);
    // 金曜 → 月曜。計画上の勤務開始（既定 10:00。D-064）
    const monStart = Date.UTC(2026, 9, 5, 1, 0);
    expect(r.body).toMatchObject({ taskDate: MON, snoozeUntil: monStart });
    expect(
      q("SELECT scheduled_date, rollover_count FROM task WHERE id = ?", fu?.taskId ?? ""),
    ).toEqual([{ scheduled_date: MON, rollover_count: 0 }]);
    const after = await call<QueueResponse>("GET", "/api/queue");
    expect(after.body.items[0]?.followUps[0]).toMatchObject({
      status: "snoozed",
      snoozeUntil: monStart,
      taskDate: MON,
    });
    // その後の待ちは放置に数えない
    env.clock.set(T0 + 11 * H);
    await env.sync();
    const s = await call<DailyReportResponse>("GET", `/api/reports/daily/${FRI}`);
    expect(s.body.report.idleMs).toBe(idle0);
    // 無いフォローアップは 404
    expect((await call("POST", "/api/follow-ups/nope/defer")).status).toBe(404);
  });
});

describe("残り N 件を今日へ（D-192）", () => {
  test("昨日に残った自分のタスクを今日の未定へ移す。時間ブロックは外し、持ち越し回数を +1。元に戻せる", async () => {
    const { call } = setup();
    const left = task("Invoice template fix", THU);
    const blocked = task("Write the outline", THU, { laneOrder: "b" });
    const block = insertRow(env.mutate, schema.timeBlock, {
      id: newId(env.clock),
      taskId: blocked.id,
      startAt: T0 - 14 * H,
      endAt: T0 - 13 * H,
      tz: "Asia/Tokyo",
      writebackState: "pending",
    });
    const stale = task("Old errand", "2026-09-25");
    task("Ancient errand", "2026-09-01");
    const done = task("Done thing", THU, { status: "done", completedAt: T0 - 10 * H });
    task("Someday idea", THU, { status: "someday" });
    const todayTask = task("Today thing", FRI);

    // ボードの昨日の列に残りの件数が出る（それより前の日付の残りは最初の過去の列にだけ）
    const b = await call<BoardResponse>("GET", `/api/board?around=${FRI}`);
    const yesterday = b.body.days.find((d) => d.date === THU);
    expect(yesterday?.carry).toEqual({ count: 2, older: 1 });
    expect(b.body.days.find((d) => d.date === FRI)?.carry).toBeUndefined();

    // 今日・未来は 400
    expect((await call("POST", `/api/days/${FRI}/carry`, {})).status).toBe(400);
    expect((await call("POST", `/api/days/${MON}/carry`, {})).status).toBe(400);

    const c = await call<CarryDayResponse>("POST", `/api/days/${THU}/carry`, { older: true });
    expect(c.status).toBe(200);
    expect(c.body.to).toBe(FRI);
    expect(c.body.moved.map((m) => [m.taskId, m.from, m.blocks.length])).toEqual([
      [stale.id, "2026-09-25", 0],
      [left.id, THU, 0],
      [blocked.id, THU, 1],
    ]);
    expect(
      q(
        "SELECT id, scheduled_date, rollover_count FROM task WHERE id IN (?, ?, ?) ORDER BY title",
        left.id,
        blocked.id,
        stale.id,
      ),
    ).toEqual([
      { id: left.id, scheduled_date: FRI, rollover_count: 1 },
      { id: stale.id, scheduled_date: FRI, rollover_count: 1 },
      { id: blocked.id, scheduled_date: FRI, rollover_count: 1 },
    ]);
    expect(
      q("SELECT deleted_at IS NOT NULL AS gone FROM time_block WHERE id = ?", block.id),
    ).toEqual([{ gone: 1 }]);
    // 完了・someday・今日のタスクは動かない
    expect(q("SELECT scheduled_date FROM task WHERE id = ?", done.id)).toEqual([
      { scheduled_date: THU },
    ]);
    expect(q("SELECT scheduled_date FROM task WHERE id = ?", todayTask.id)).toEqual([
      { scheduled_date: FRI },
    ]);
    // 移した事実は昨日の記録の「持ち越し」に出る（元の日ごと）
    const r = await call<DailyReportResponse>("GET", `/api/reports/daily/${THU}?lang=en`);
    expect(r.body.report.carried.map((x) => [x.taskId, x.to])).toEqual([
      [left.id, FRI],
      [blocked.id, FRI],
    ]);
    expect(r.body.markdown).toContain("### Carried over\n- Invoice template fix → Fri 10/2");
    const after = await call<BoardResponse>("GET", `/api/board?around=${FRI}`);
    expect(after.body.days.find((d) => d.date === THU)?.carry).toEqual({ count: 0, older: 0 });

    // 元に戻す: 日付・時間ブロック・持ち越し回数・記録が戻る
    const u = await call<UndoCarryResponse>("POST", "/api/days/carry/undo", {
      moved: c.body.moved,
    });
    expect(u.status).toBe(200);
    expect(u.body.restored).toHaveLength(3);
    expect(
      q(
        "SELECT id, scheduled_date, rollover_count FROM task WHERE id IN (?, ?, ?) ORDER BY title",
        left.id,
        blocked.id,
        stale.id,
      ),
    ).toEqual([
      { id: left.id, scheduled_date: THU, rollover_count: 0 },
      { id: stale.id, scheduled_date: "2026-09-25", rollover_count: 0 },
      { id: blocked.id, scheduled_date: THU, rollover_count: 0 },
    ]);
    expect(q("SELECT deleted_at FROM time_block WHERE id = ?", block.id)).toEqual([
      { deleted_at: null },
    ]);
    expect(
      (await call<DailyReportResponse>("GET", `/api/reports/daily/${THU}`)).body.report.carried,
    ).toEqual([]);
    expect(q("SELECT COUNT(*) AS n FROM usage_event WHERE kind = 'carry'")).toEqual([{ n: 0 }]);
  });

  test("自分の番のタスクは残りに数えない。older を省くとその日の分だけ", async () => {
    const { call, tr } = setup();
    // 木曜 18:00 の質問で返答タスク（自分の番）が木曜の日付で残る
    tr.human(T0 - 15 * H - 30 * MIN);
    tr.assistantEnd(T0 - 15 * H, "Which option?", { durationMs: 30 * MIN });
    for (let t = T0 - 15 * H; t <= T0 - 14 * H; t += 15 * MIN) {
      env.clock.set(t);
      await env.sync();
    }
    env.clock.set(T0);
    await env.sync();
    const fu = (await call<QueueResponse>("GET", "/api/queue")).body.items[0]?.followUps[0];
    expect(fu?.taskDate).toBe(THU);
    const mine = task("Mine", THU);
    task("Older", "2026-09-28");
    const b = await call<BoardResponse>("GET", `/api/board?around=${FRI}`);
    expect(b.body.days.find((d) => d.date === THU)?.carry).toEqual({ count: 1, older: 1 });
    const c = await call<CarryDayResponse>("POST", `/api/days/${THU}/carry`, {});
    expect(c.body.moved.map((m) => m.taskId)).toEqual([mine.id]);
    expect(q("SELECT scheduled_date FROM task WHERE id = ?", fu?.taskId ?? "")).toEqual([
      { scheduled_date: THU },
    ]);
  });

  test("確定した記録にも、後から移した持ち越しの節を足して返す", async () => {
    const { call, planner } = setup();
    const left = task("Left over", THU);
    task("Done thing", THU, { status: "done", completedAt: T0 - 10 * H });
    present(env.sqlite, T0 - 14 * H, T0 - 10 * H);
    expect(planner.dailyNote.finalizeDay(THU)).toBe(true);
    const saved = q<{ report_md: string }>(
      "SELECT report_md FROM daily_note WHERE date = ?",
      THU,
    )[0]?.report_md;
    expect(saved).not.toContain("Carried over");
    await call("POST", `/api/days/${THU}/carry`, {});
    const r = await call<DailyReportResponse>("GET", `/api/reports/daily/${THU}?lang=en`);
    expect(r.body.saved).toBe(true);
    expect(r.body.markdown).toContain(
      `${(saved ?? "").trimEnd()}\n\n### Carried over\n- Left over → Fri 10/2\n`,
    );
    expect(r.body.report.carried.map((x) => x.taskId)).toEqual([left.id]);
    // 保存した本文は変えない
    expect(q("SELECT report_md FROM daily_note WHERE date = ?", THU)).toEqual([
      { report_md: saved },
    ]);
  });
});

describe("日付区切りでの日の確定（M4-4）", () => {
  test("その時点の記録を report_md に残す（持ち越しはしない）。何も無い日は残さない", async () => {
    const { planner } = setup();
    const left = task("Left over", FRI);
    task("Done thing", FRI, { status: "done", completedAt: T0 + H });
    env.clock.set(T0 + 24 * H); // 土曜 9:00
    expect(planner.dailyNote.finalizeDay(FRI)).toBe(true);
    const md = q<{ report_md: string }>("SELECT report_md FROM daily_note WHERE date = ?", FRI)[0];
    expect(md?.report_md).toContain("- Done thing");
    expect(md?.report_md).not.toContain("Carried over");
    expect(q("SELECT scheduled_date FROM task WHERE id = ?", left.id)).toEqual([
      { scheduled_date: FRI },
    ]);
    // 2回目は何もしない。今日・何も無い日も残さない
    expect(planner.dailyNote.finalizeDay(FRI)).toBe(false);
    expect(planner.dailyNote.finalizeDay("2026-10-03")).toBe(false);
    expect(planner.dailyNote.finalizeDay("2026-09-30")).toBe(false);
  });
});

describe("利用計測（M5-1）", () => {
  test("UI を開いた日を数える。ui_open は本人の操作に数えない", async () => {
    const { call } = setup();
    env.clock.set(T0 + 8 * H);
    let st = await call<UsageStats>("GET", "/api/stats?days=14");
    expect(st.body.countedDays).toBe(0);
    expect(st.body.days.at(-1)).toMatchObject({ date: FRI, opened: false, counted: false });
    expect((await call("POST", "/api/usage", { kind: "ui_open" })).status).toBe(200);
    st = await call<UsageStats>("GET", "/api/stats?days=14");
    expect(st.body.days.at(-1)).toMatchObject({ date: FRI, opened: true, counted: true });
    expect(st.body.countedDays).toBe(1);
    expect(st.body.streak).toBe(1);
    expect(st.body.days).toHaveLength(14);
    expect(q("SELECT kind FROM usage_event ORDER BY kind")).toEqual([{ kind: "ui_open" }]);
    expect((await call("POST", "/api/usage", { kind: "other" })).status).toBe(400);
  });

  test("平均応答時間は夜をまたいでも Mac を使っていた間の猶予と放置だけで数える（D-057・D-105）。処理の件数は直近7日", async () => {
    const { call, tr } = setup();
    // 金は 9:00〜12:00、土は 10:00 に Mac を使った
    env.sqlite.run("DELETE FROM presence_span");
    present(env.sqlite, T0, T0 + 3 * H);
    present(env.sqlite, T0 + 25 * H, T0 + 25 * H + MIN);
    // 金 9:00 入力、9:30 に質問で終わる。土 10:00 に答える（壁時計 24h30m）
    tr.human(T0);
    tr.assistantEnd(T0 + 30 * MIN, "Should the drop target snap to 15 minutes?", {
      durationMs: 30 * MIN,
    });
    for (let t = T0 + 30 * MIN; t <= T0 + 3 * H; t += 30 * MIN) {
      env.clock.set(t);
      await env.sync();
    }
    env.ai.recordUserOp(T0 + 3 * H);
    const sat = T0 + 25 * H;
    for (let t = T0 + 4 * H; t < sat; t += H) {
      env.clock.set(t);
      await env.sync();
    }
    tr.human(sat);
    env.clock.set(sat + 5000);
    await env.sync();
    expect(
      q<{ status: string; close_reason: string }>(
        "SELECT status, close_reason FROM follow_up WHERE kind = 'reply'",
      ),
    ).toEqual([{ status: "done", close_reason: "auto:human_input" }]);
    // 猶予 9:30〜9:45 と、金の放置（タスクを作った 10:00 の tick から Mac を離れた 12:00 まで）= 2h15m。
    // 金の夜と土に Mac を使い始める（10:00 の入力）までは数えない。Idle と同じ物差しなので、金の Idle + 猶予に一致する
    const idleFri = (await call<DailyReportResponse>("GET", `/api/reports/daily/${FRI}`)).body
      .report.idleMs;
    expect(idleFri).toBe(2 * H);
    const queue = await call<QueueResponse>("GET", "/api/queue");
    expect(queue.body.avgResponseMs).toBe(15 * MIN + idleFri);
    expect(queue.body.handled7d).toBe(1);
    const st = await call<UsageStats>("GET", "/api/stats?days=14");
    expect(st.body.avgResponseMs).toBe(15 * MIN + idleFri);
    expect(st.body.followUps.processed).toBe(1);
    // 8 日前に処理したものは「処理 N 件（7日）」に入らない
    env.clock.set(sat + 8 * 24 * H);
    expect((await call<QueueResponse>("GET", "/api/queue")).body.handled7d).toBe(0);
  });
});
