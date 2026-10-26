/**
 * ボード系 API（M2-2。m2-api.md）の結合テスト: app.request で /api/board・/api/queue・/api/inbox・タスクの操作を通す。
 * 取り込みは合成のトランスクリプト、時計は偽物（2026-09-14 10:00 JST から）。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { putSetting } from "@turnlane/core";
import type {
  BoardResponse,
  InboxResponse,
  QueueResponse,
  TaskDetailResponse,
  TaskWriteResponse,
  WorkItemDetail,
} from "@turnlane/core/api";
import { createApp } from "../src/http/app.ts";
import { createPlanner } from "../src/planner/index.ts";
import { type AiEnv, makeAiEnv, present } from "./helpers/env.ts";
import { claudeTranscript } from "./helpers/transcript.ts";

const TOKEN = "c".repeat(64);
const PORT = 7317;
const HOST = `127.0.0.1:${PORT}`;
const MIN = 60_000;
const H = 60 * MIN;
const T0 = Date.UTC(2026, 8, 14, 1, 0); // 2026-09-14 10:00 JST
const D = "2026-09-14";

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

const q = <T>(sql: string, ...args: (string | number)[]) =>
  env.sqlite.query<T, (string | number)[]>(sql).all(...args);

describe("YOUR TURN（D-048 (4)・D-049 (1)）", () => {
  test("W36: hooks なしの AskUserQuestion は待ちの開始ですぐ返答タスクになり、キューに出る。答えたら閉じる", async () => {
    const { call, tr } = setup();
    tr.human(T0 - 2 * MIN);
    const ask = tr.ask(T0);
    env.clock.set(T0 + 30_000);
    await env.sync();
    const r1 = await call<QueueResponse>("GET", "/api/queue");
    expect(r1.body.items.map((x) => [x.status, x.followUps.map((f) => f.kind)])).toEqual([
      ["needs_input", ["reply"]],
    ]);
    expect(r1.body.items[0]?.followUps[0]?.title).toMatchObject({
      t: "auto",
      key: "followup.reply",
      params: { repo: "app", branch: "feat/login" },
    });
    // 自分の番のタスクは今日の Unscheduled に入れない（帯に出る）
    const b1 = await call<BoardResponse>("GET", `/api/board?from=${D}&to=${D}`);
    expect(b1.body.days[0]?.tasks).toEqual([]);
    // 10分後に答える（ターンは続く）
    tr.answer(T0 + 10 * MIN, ask);
    env.clock.set(T0 + 10 * MIN + 5000);
    await env.sync();
    const r2 = await call<QueueResponse>("GET", "/api/queue");
    expect(r2.body.items).toEqual([]);
    expect(q("SELECT status, close_reason FROM follow_up")).toEqual([
      { status: "done", close_reason: "auto:answered" },
    ]);
    expect(r2.body.closedToday.replied).toBe(1);
  });

  test("W33: タスクのない your_turn（編集ありだけ）はキューに出ず、72時間で done（no_task_expired）", async () => {
    const { call, tr } = setup();
    tr.human(T0 - 5 * MIN);
    tr.assistantEnd(T0, "Implemented the change.", { edits: 2 });
    env.clock.set(T0 + 20 * MIN);
    await env.sync();
    expect(q("SELECT status, status_reason FROM work_item")).toEqual([
      { status: "your_turn", status_reason: "edits" },
    ]);
    expect((await call<QueueResponse>("GET", "/api/queue")).body.items).toEqual([]);
    env.clock.set(T0 + 72 * H + MIN);
    env.ai.runner.runOnce();
    expect(q("SELECT status, status_reason FROM work_item")).toEqual([
      { status: "done", status_reason: "no_task_expired" },
    ]);
  });

  test("題名は読み取り時に AI 項目の現在のタイトルで組み立てる（D-047 (3)）", async () => {
    const { call, tr } = setup();
    tr.human(T0 - 2 * MIN);
    tr.assistantEnd(T0, "Which option do you prefer?");
    env.clock.set(T0 + 16 * MIN);
    await env.sync();
    const [wi] = q<{ id: string }>("SELECT id FROM work_item");
    await call("PATCH", `/api/work-items/${wi?.id}`, { titleUser: "Login flow" });
    const r = await call<QueueResponse>("GET", "/api/queue");
    expect(r.body.items[0]?.followUps[0]?.title).toMatchObject({
      t: "auto",
      params: { title: "Login flow" },
    });
    // 保存値は作成時点のまま（参照として保存。D-047 (3)）
    const [t] = q<{ title_params: string }>("SELECT title_params FROM task");
    expect(JSON.parse(t?.title_params ?? "{}").title).not.toBe("Login flow");
  });

  test("スヌーズの「明日朝」はサーバーが決める（計画上の勤務開始。既定 10:00。D-064）", async () => {
    const { call, tr } = setup();
    tr.human(T0 - 2 * MIN);
    tr.assistantEnd(T0, "Which option do you prefer?");
    env.clock.set(T0 + 16 * MIN);
    await env.sync();
    const [fu] = q<{ id: string }>("SELECT id FROM follow_up");
    const r = await call<{ snoozeUntil: number; status: string }>(
      "POST",
      `/api/follow-ups/${fu?.id}/snooze`,
      { preset: "tomorrow_morning" },
    );
    expect(r.body).toMatchObject({ status: "snoozed", snoozeUntil: Date.UTC(2026, 8, 15, 1, 0) });
    // スヌーズ中のタスクしか無いカードも応答には入る（UI が明けるまで隠す）
    const qr = await call<QueueResponse>("GET", "/api/queue");
    expect(qr.body.items[0]?.followUps[0]?.status).toBe("snoozed");
  });

  test("「明日朝」はその曜日の計画の目安の開始（D-064・D-106）", async () => {
    const { call, tr } = setup();
    putSetting(env.mutate, "work_hours.planned", { tue: { start: "09:30", end: "18:00" } });
    tr.human(T0 - 2 * MIN);
    tr.assistantEnd(T0, "Which option do you prefer?");
    env.clock.set(T0 + 16 * MIN);
    await env.sync();
    const [fu] = q<{ id: string }>("SELECT id FROM follow_up");
    const r = await call<{ snoozeUntil: number }>("POST", `/api/follow-ups/${fu?.id}/snooze`, {
      preset: "tomorrow_morning",
    });
    // 月曜 → 火曜 9:30（JST）
    expect(r.body.snoozeUntil).toBe(Date.UTC(2026, 8, 15, 0, 30));
  });
});

describe("AI 詳細パネル（M2-5）", () => {
  test("時間内訳と再開導線（resume はコマンドを返し、pr / folder はデーモンが open する。本文は返さない）", async () => {
    const { call, tr } = setup();
    tr.human(T0 - 10 * MIN);
    tr.prLink(T0 - MIN, "example/app", 7);
    tr.assistantEnd(T0, "Which option do you prefer?", { durationMs: 10 * MIN });
    env.clock.set(T0 + 40 * MIN);
    await env.sync();
    const [wi] = q<{ id: string }>("SELECT id FROM work_item");
    const d = await call<WorkItemDetail>("GET", `/api/work-items/${wi?.id}`);
    expect(d.body.workItem).toMatchObject({ status: "your_turn", turns: 1 });
    expect(d.body.breakdown.graceMs).toBe(15 * MIN);
    expect(d.body.open).toMatchObject({ resume: true, folder: true });
    // AI の発言の本文は返さない。問いの文は保存した待ちの中身（followUps[].wait。ADR 0018）にだけ出る
    const { followUps, ...rest } = d.body as { followUps: { wait?: { text?: string } }[] };
    expect(JSON.stringify(rest)).not.toContain("Which option");
    expect(followUps.map((f) => f.wait?.text ?? null)).toContain("Which option do you prefer?");
    // 再開導線はタスクから開く（D-059）の API。詳しくは open-api.test.ts
    env.open.dirs.add("/w/app");
    const r = await call<{ command: string; outcome: string }>("POST", "/api/open", {
      workItemId: wi?.id,
      action: "copy_resume",
    });
    expect(r.body).toMatchObject({
      outcome: "copied",
      command: "cd /w/app && claude --resume 11111111-0000-4000-8000-000000000001",
    });
    await call("POST", "/api/open", { workItemId: wi?.id, action: "pr" });
    await call("POST", "/api/open", { workItemId: wi?.id, action: "finder" });
    expect(env.open.runs).toEqual([
      ["/usr/bin/open", "https://github.com/example/app/pull/7"],
      ["/usr/bin/open", "-a", "Finder", "/w/app"],
    ]);
    expect((await call("POST", "/api/open", { workItemId: wi?.id, action: "x" })).status).toBe(400);
  });
});

describe("タスクの操作と週ボード", () => {
  test("作成・NL パーサ・clientId の再送・Inbox・日付移動（carry だけ持ち越し回数を数える）", async () => {
    const { call } = setup();
    const a = await call<TaskWriteResponse>("POST", "/api/tasks", {
      title: "Write outline",
      date: D,
      estimateMin: 45,
    });
    expect(a.status).toBe(201);
    expect(a.body.task?.title).toEqual({ t: "text", text: "Write outline" });
    // 自然言語（明日 30分 #blog）
    const b = await call<TaskWriteResponse>("POST", "/api/tasks", {
      raw: "Blog draft tomorrow 30m #blog",
    });
    expect(b.body.task).toMatchObject({
      title: { t: "text", text: "Blog draft" },
      scheduledDate: "2026-09-15",
      estimateMin: 30,
    });
    expect(q("SELECT name FROM project")).toEqual([{ name: "blog" }]);
    // clientId は ID になり、再送しても1件
    const id = "01920000-0000-7000-8000-000000000001";
    const c1 = await call<TaskWriteResponse>("POST", "/api/tasks", {
      title: "Inbox item",
      clientId: id,
    });
    const c2 = await call<TaskWriteResponse>("POST", "/api/tasks", {
      title: "Inbox item",
      clientId: id,
    });
    expect([c1.status, c2.status, c1.body.task?.id]).toEqual([201, 200, id]);
    const inbox = await call<InboxResponse>("GET", "/api/inbox");
    expect(inbox.body.tasks.map((t) => t.id)).toEqual([id]);
    // 手での移動は数えない。carry: true（朝の Step 2 の t・自動持ち越し）だけ数える
    await call("POST", `/api/tasks/${id}/move`, { date: D });
    await call("POST", `/api/tasks/${id}/move`, { date: "2026-09-15", carry: true });
    expect(q("SELECT rollover_count FROM task WHERE id = ?", id)).toEqual([{ rollover_count: 1 }]);
    // 並べ替え: a の前へ
    await call("POST", `/api/tasks/${id}/move`, { date: D, afterId: a.body.task?.id });
    const board = await call<BoardResponse>("GET", `/api/board?from=${D}&to=2026-09-15`);
    expect(board.body.days[0]?.tasks.map((t) => t.id)).toEqual([id, a.body.task?.id ?? ""]);
    // 範囲の検証
    expect((await call("GET", "/api/board?from=2026-09-01&to=2026-10-15")).status).toBe(400);
    expect((await call("GET", "/api/board?from=x&to=y")).status).toBe(400);
  });

  test("ヘッダの集計: Planned は見積なしを30分とみなして件数を返し、今日の完了済みを含める（D-047 (1)・D-049 (3)）", async () => {
    const { call } = setup();
    const x = await call<TaskWriteResponse>("POST", "/api/tasks", {
      title: "A",
      date: D,
      estimateMin: 60,
    });
    await call("POST", "/api/tasks", { title: "B", date: D });
    await call("POST", `/api/tasks/${x.body.task?.id}/complete`);
    const b = await call<BoardResponse>("GET", `/api/board?from=2026-09-13&to=2026-09-15`);
    const [past, today, future] = b.body.days;
    expect([past?.phase, today?.phase, future?.phase]).toEqual(["past", "today", "future"]);
    expect(today?.totals).toMatchObject({ plannedMs: 90 * MIN, plannedUnestimated: 1 });
    // 今日の Free: 計画の目安 ∩ [今 10:00, 19:00]（D-106）
    expect(today?.totals.freeMs).toBe(9 * H);
    // 未来: 計画の目安（既定 10:00〜19:00。D-062）
    expect(future?.totals.freeMs).toBe(9 * H);
    expect(future?.plannedHours).toEqual({
      start: Date.UTC(2026, 8, 15, 1, 0),
      end: Date.UTC(2026, 8, 15, 10, 0),
    });
    expect(past?.totals.freeMs).toBe(0);
    expect(today?.aiLane).toEqual([]);
    expect(past?.aiLane).toBeNull();
  });

  test("空き時間は計画の目安から出す（D-062・D-106）。今日は今より後だけ", async () => {
    const { call } = setup();
    // 水曜だけ 9:30〜18:00
    putSetting(env.mutate, "work_hours.planned", { wed: { start: "09:30", end: "18:00" } });
    const b = await call<BoardResponse>("GET", "/api/board?from=2026-09-15&to=2026-09-19");
    const [tue, wed, , , sat] = b.body.days;
    expect(tue?.totals.freeMs).toBe(9 * H);
    expect(wed?.totals.freeMs).toBe(8.5 * H);
    expect(wed?.plannedHours?.start).toBe(Date.UTC(2026, 8, 16, 0, 30));
    // 稼働日でない日（土）は計画が無く、Free を出さない
    expect([sat?.plannedHours, sat?.totals.freeMs]).toEqual([null, 0]);
    // 今日の 15:00 なら 15:00〜19:00 の 4 時間（作業の有無によらない）
    env.clock.set(T0 + 5 * H);
    const t = await call<BoardResponse>("GET", `/api/board?from=${D}&to=${D}`);
    expect(t.body.days[0]?.totals.freeMs).toBe(4 * H);
    // 計画の終わりを過ぎたら 0
    env.clock.set(T0 + 10 * H);
    const late = await call<BoardResponse>("GET", `/api/board?from=${D}&to=${D}`);
    expect(late.body.days[0]?.totals.freeMs).toBe(0);
  });

  test("外部取り込みの冪等性: 2回で1件、削除後に再送しても作らない、同時に2回でも1件", async () => {
    const { call } = setup();
    const body = { title: "Fix login bug", external: { source: "github", id: "issue-42" } };
    const r1 = await call<TaskWriteResponse>("POST", "/api/tasks", body);
    const r2 = await call<TaskWriteResponse>("POST", "/api/tasks", { ...body, title: "renamed" });
    expect([r1.status, r1.body.created, r2.status, r2.body.created]).toEqual([
      201,
      true,
      200,
      false,
    ]);
    expect(r2.body.task?.title).toEqual({ t: "text", text: "Fix login bug" });
    const both = await Promise.all([
      call<TaskWriteResponse>("POST", "/api/tasks", {
        title: "X",
        external: { source: "linear", id: "L-1" },
      }),
      call<TaskWriteResponse>("POST", "/api/tasks", {
        title: "X",
        external: { source: "linear", id: "L-1" },
      }),
    ]);
    expect(both.map((r) => r.body.created).sort()).toEqual([false, true]);
    await call("DELETE", `/api/tasks/${r1.body.task?.id}`);
    const r3 = await call<TaskWriteResponse>("POST", "/api/tasks", body);
    expect(r3.body).toMatchObject({ task: null, created: false, skipped: "deleted" });
    expect(q("SELECT count(*) AS n FROM task")).toEqual([{ n: 2 }]);
    // 不正な source は 400
    expect(
      (await call("POST", "/api/tasks", { title: "x", external: { source: "Bad Name", id: "1" } }))
        .status,
    ).toBe(400);
    // 削除の取り消し
    const back = await call<TaskWriteResponse>("POST", `/api/tasks/${r1.body.task?.id}/restore`);
    expect(back.body.task?.deletedAt).toBeNull();
  });

  test("自分の番のタスクの完了はフォローアップの complete に委ねる。題名を変えたら人が書いた題名になる", async () => {
    const { call, tr } = setup();
    tr.human(T0 - 2 * MIN);
    tr.assistantEnd(T0, "Which option do you prefer?");
    env.clock.set(T0 + 16 * MIN);
    await env.sync();
    const [t] = q<{ id: string }>("SELECT id FROM task");
    await call("PATCH", `/api/tasks/${t?.id}`, { title: "Answer the option question" });
    expect(q("SELECT title, title_key FROM task")).toEqual([
      { title: "Answer the option question", title_key: null },
    ]);
    await call("POST", `/api/tasks/${t?.id}/complete`);
    expect(q("SELECT status, close_reason FROM follow_up")).toEqual([
      { status: "done", close_reason: "manual" },
    ]);
  });

  test("完了の取り消し（D-139 (3)）: 完了で閉じた自分の番を開き直し、前の状態に戻す。応答の実績も消す", async () => {
    const { call, tr } = setup();
    tr.human(T0 - 2 * MIN);
    tr.assistantEnd(T0, "Which option do you prefer?");
    env.clock.set(T0 + 16 * MIN);
    await env.sync();
    const [t] = q<{ id: string }>("SELECT id FROM task");
    const id = t?.id as string;
    const [before] = q<{ scheduled_date: string | null; lane_order: string }>(
      "SELECT scheduled_date, lane_order FROM task WHERE id = ?",
      id,
    );
    const done = await call<TaskWriteResponse>("POST", `/api/tasks/${id}/complete`);
    const [fu] = q<{ id: string }>("SELECT id FROM follow_up");
    expect(done.body.closedFollowUps).toEqual([fu?.id as string]);
    expect(
      q(
        "SELECT count(*) AS n FROM task_time_entry WHERE source = 'followup_estimate' AND deleted_at IS NULL",
      ),
    ).toEqual([{ n: 1 }]);
    const back = await call<TaskWriteResponse>("POST", `/api/tasks/${id}/uncomplete`, {
      status: "todo",
      reopenFollowUps: done.body.closedFollowUps,
    });
    expect(back.status).toBe(200);
    expect(q("SELECT status, closed_at, close_reason FROM follow_up")).toEqual([
      { status: "open", closed_at: null, close_reason: null },
    ]);
    expect(
      q("SELECT status, completed_at, scheduled_date, lane_order FROM task WHERE id = ?", id),
    ).toEqual([{ status: "todo", completed_at: null, ...before }]);
    expect(
      q(
        "SELECT count(*) AS n FROM task_time_entry WHERE source = 'followup_estimate' AND deleted_at IS NULL",
      ),
    ).toEqual([{ n: 0 }]);
    // 自分の番に戻る
    const queue = await call<QueueResponse>("GET", "/api/queue");
    expect(JSON.stringify(queue.body)).toContain(fu?.id as string);
  });

  test("自分の番の「完了」の取り消し: POST /follow-ups/:id/reopen。2回目はそのまま、手での完了でなければ 409", async () => {
    const { call, tr } = setup();
    tr.human(T0 - 2 * MIN);
    tr.assistantEnd(T0, "Which option do you prefer?");
    env.clock.set(T0 + 16 * MIN);
    await env.sync();
    const [fu] = q<{ id: string }>("SELECT id FROM follow_up");
    const fid = fu?.id as string;
    await call("POST", `/api/follow-ups/${fid}/complete`);
    expect(q("SELECT status FROM task")).toEqual([{ status: "done" }]);
    const r = await call<{ status: string }>("POST", `/api/follow-ups/${fid}/reopen`);
    expect(r.status).toBe(200);
    expect(q("SELECT status FROM follow_up")).toEqual([{ status: "open" }]);
    expect(q("SELECT status, completed_at FROM task")).toEqual([
      { status: "todo", completed_at: null },
    ]);
    expect(
      q(
        "SELECT count(*) AS n FROM task_time_entry WHERE source = 'followup_estimate' AND deleted_at IS NULL",
      ),
    ).toEqual([{ n: 0 }]);
    expect((await call("POST", `/api/follow-ups/${fid}/reopen`)).status).toBe(200);
    await call("POST", `/api/follow-ups/${fid}/dismiss`);
    expect((await call("POST", `/api/follow-ups/${fid}/reopen`)).status).toBe(409);
  });

  test("GET /api/inbox の closed: 今日完了にした Inbox のタスク（「今日閉じた n」。D-139 (4)）", async () => {
    const { call } = setup();
    const a = await call<TaskWriteResponse>("POST", "/api/tasks", { title: "Inbox A" });
    const b = await call<TaskWriteResponse>("POST", "/api/tasks", { title: "Inbox B" });
    await call("POST", `/api/tasks/${a.body.task?.id}/complete`);
    const r = await call<InboxResponse>("GET", "/api/inbox");
    expect(r.body.tasks.map((x) => x.id)).toEqual([b.body.task?.id as string]);
    expect(r.body.closed.map((x) => `${x.id} ${x.status}`)).toEqual([`${a.body.task?.id} done`]);
    // 翌日（論理日）には出さない
    env.clock.set(T0 + 24 * H);
    expect((await call<InboxResponse>("GET", "/api/inbox")).body.closed).toEqual([]);
  });

  test("スヌーズ中に完了した自分の番は、取り消すと同じ時刻までのスヌーズに戻る（D-139 (3)）", async () => {
    const { call, tr } = setup();
    tr.human(T0 - 2 * MIN);
    tr.assistantEnd(T0, "Which option do you prefer?");
    env.clock.set(T0 + 16 * MIN);
    await env.sync();
    const [fu] = q<{ id: string }>("SELECT id FROM follow_up");
    const fid = fu?.id as string;
    const until = T0 + 3 * H;
    await call("POST", `/api/follow-ups/${fid}/snooze`, { until });
    env.clock.set(T0 + 30 * MIN);
    await call("POST", `/api/follow-ups/${fid}/complete`);
    await call("POST", `/api/follow-ups/${fid}/reopen`);
    const [r] = q<{ status: string; snooze_until: number; snoozes_json: string }>(
      "SELECT status, snooze_until, snoozes_json FROM follow_up",
    );
    expect(r?.status).toBe("snoozed");
    expect(r?.snooze_until).toBe(until);
    expect((JSON.parse(r?.snoozes_json ?? "[]") as number[][]).at(-1)?.[1]).toBe(until);
    // スヌーズの時刻が過ぎた後なら open に戻す
    await call("POST", `/api/follow-ups/${fid}/complete`);
    env.clock.set(until + MIN);
    await call("POST", `/api/follow-ups/${fid}/reopen`);
    expect(q("SELECT status FROM follow_up")).toEqual([{ status: "open" }]);
  });

  test("未完了に戻す: 本文なしは todo、doing を渡せば計測中の状態に戻す。不正な本文は 400", async () => {
    const { call } = setup();
    const c = await call<TaskWriteResponse>("POST", "/api/tasks", { title: "Plain task" });
    const id = c.body.task?.id as string;
    await call("POST", `/api/tasks/${id}/start`);
    expect(q("SELECT status FROM task WHERE id = ?", id)).toEqual([{ status: "doing" }]);
    const done = await call<TaskWriteResponse>("POST", `/api/tasks/${id}/complete`);
    expect(done.body.closedFollowUps).toEqual([]);
    await call("POST", `/api/tasks/${id}/uncomplete`, { status: "doing" });
    expect(q("SELECT status FROM task WHERE id = ?", id)).toEqual([{ status: "doing" }]);
    await call("POST", `/api/tasks/${id}/complete`);
    await call("POST", `/api/tasks/${id}/uncomplete`);
    expect(q("SELECT status, completed_at FROM task WHERE id = ?", id)).toEqual([
      { status: "todo", completed_at: null },
    ]);
    expect((await call("POST", `/api/tasks/${id}/uncomplete`, { status: "done" })).status).toBe(
      400,
    );
  });

  test("GET /api/tasks/:id: タスクの詳細パネル（メモ・時間ブロック・プロジェクト・経由。D-070）", async () => {
    const { call } = setup();
    const c = await call<TaskWriteResponse>("POST", "/api/tasks", {
      raw: "Write outline tomorrow 30m",
      source: "mcp",
      client: "claude-code",
      projectName: "Docs",
      external: {
        source: "github",
        id: "issue-12",
        url: "https://github.com/example/app/issues/12",
      },
    });
    const id = c.body.task?.id as string;
    await call("PATCH", `/api/tasks/${id}`, { notes: "Use the template." });
    await call("POST", "/api/time-blocks", {
      taskId: id,
      startAt: T0 + 24 * H + 2 * H,
      endAt: T0 + 24 * H + 2 * H + 30 * MIN,
    });
    const d = await call<TaskDetailResponse>("GET", `/api/tasks/${id}`);
    expect(d.status).toBe(200);
    expect(d.body.notes).toBe("Use the template.");
    expect(d.body.task.estimateMin).toBe(30);
    expect(d.body.task.scheduledDate).toBe("2026-09-15");
    expect(d.body.task.origin).toMatchObject({ externalSource: "github" });
    expect(d.body.blocks.map((b) => b.start)).toEqual([T0 + 26 * H]);
    expect(d.body.projectName).toBe("Docs");
    await call("DELETE", `/api/tasks/${id}`);
    expect((await call("GET", `/api/tasks/${id}`)).status).toBe(404);
  });

  test("Inbox のタスクはメモがあれば hasNotes（本文は詳細だけ。Inbox のレビュー v1）", async () => {
    const { call } = setup();
    const a = await call<TaskWriteResponse>("POST", "/api/tasks", { title: "With notes" });
    const b = await call<TaskWriteResponse>("POST", "/api/tasks", { title: "Blank notes" });
    await call<TaskWriteResponse>("POST", "/api/tasks", { title: "No notes" });
    await call("PATCH", `/api/tasks/${a.body.task?.id}`, { notes: "Use the template." });
    await call("PATCH", `/api/tasks/${b.body.task?.id}`, { notes: "   " });
    const inbox = await call<InboxResponse>("GET", "/api/inbox");
    const by = Object.fromEntries(
      inbox.body.tasks.map((t) => [t.title.t === "text" ? t.title.text : "", t.hasNotes ?? false]),
    );
    expect(by).toEqual({ "With notes": true, "Blank notes": false, "No notes": false });
    expect(JSON.stringify(inbox.body)).not.toContain("Use the template.");
  });

  test("SSE: タスクの変化は日付と ID 付きの task イベントで、rev が増える", async () => {
    const { call } = setup();
    const seen: { type: string; data: Record<string, unknown> }[] = [];
    env.hub.subscribe((m) => seen.push(m));
    await call("POST", "/api/tasks", { title: "A", date: D });
    await call("POST", "/api/tasks", { title: "B" });
    env.hub.flush();
    const ev = seen.find((m) => m.type === "task");
    expect(ev?.data).toMatchObject({ dates: [D], inbox: true });
    expect(ev?.data.ids).toHaveLength(2);
    expect(env.hub.rev).toBeGreaterThan(0);
  });

  test("画面の設定（テーマ・言語）", async () => {
    const { call } = setup();
    expect((await call("GET", "/api/settings/ui")).body).toEqual({
      theme: "system",
      language: "system",
      keybindings: {},
      focusPrompt: true,
      focusTarget: "meetings",
      focusLeadMin: 5,
      focusAuto: false,
      focusAllowNeedsInput: false,
      focusNotifyEnd: true,
      panelWidth: null,
    });
    await call("PUT", "/api/settings/ui", { theme: "dark", language: "ja" });
    expect((await call("GET", "/api/settings/ui")).body).toEqual({
      theme: "dark",
      language: "ja",
      keybindings: {},
      focusPrompt: true,
      focusTarget: "meetings",
      focusLeadMin: 5,
      focusAuto: false,
      focusAllowNeedsInput: false,
      focusNotifyEnd: true,
      panelWidth: null,
    });
    expect((await call("PUT", "/api/settings/ui", { theme: "blue" })).status).toBe(400);
  });

  test("集中モードの設定（D-097）: 端末ごとに保存する。何分前は 1〜30", async () => {
    const { call } = setup();
    const put = await call<Record<string, unknown>>("PUT", "/api/settings/ui", {
      focusPrompt: false,
      focusTarget: "busy",
      focusLeadMin: 10,
      focusAuto: true,
      focusAllowNeedsInput: true,
      focusNotifyEnd: false,
    });
    expect(put.body).toMatchObject({
      focusPrompt: false,
      focusTarget: "busy",
      focusLeadMin: 10,
      focusAuto: true,
      focusAllowNeedsInput: true,
      focusNotifyEnd: false,
    });
    const rows = q<{ key: string; sync_scope: string }>(
      "SELECT key, sync_scope FROM setting WHERE key LIKE 'focus.%' ORDER BY key",
    );
    expect(rows.every((r) => r.sync_scope === "local_only")).toBe(true);
    expect(rows).toHaveLength(6);
    for (const bad of [{ focusLeadMin: 0 }, { focusLeadMin: 31 }, { focusTarget: "all" }])
      expect((await call("PUT", "/api/settings/ui", bad)).status).toBe(400);
  });

  test("右の詳細パネルの幅（ux-mvp 4.12.1）: この Mac に1つ保存する。null で既定に戻す。範囲外は 400", async () => {
    const { call } = setup();
    const put = await call<{ panelWidth: number | null }>("PUT", "/api/settings/ui", {
      panelWidth: 512,
    });
    expect(put.status).toBe(200);
    expect(put.body.panelWidth).toBe(512);
    expect(
      (await call<{ panelWidth: number | null }>("GET", "/api/settings/ui")).body.panelWidth,
    ).toBe(512);
    expect(
      q<{ sync_scope: string }>("SELECT sync_scope FROM setting WHERE key = 'ui.panel_width'"),
    ).toEqual([{ sync_scope: "local_only" }]);
    await call("PUT", "/api/settings/ui", { panelWidth: null });
    expect(
      (await call<{ panelWidth: number | null }>("GET", "/api/settings/ui")).body.panelWidth,
    ).toBeNull();
    for (const bad of [319, 1601, 400.5, "wide"])
      expect((await call("PUT", "/api/settings/ui", { panelWidth: bad })).status).toBe(400);
  });

  test("キーの割り当ての上書き（D-077）: 端末ごとに保存する。書式の違うものは 400", async () => {
    const { call } = setup();
    const kb = { viewThree: ["mod+4"], goBoard: ["g x"], toggleWeek: [] };
    const put = await call<{ keybindings: Record<string, string[]> }>("PUT", "/api/settings/ui", {
      keybindings: kb,
    });
    expect(put.status).toBe(200);
    expect(put.body.keybindings).toEqual(kb);
    const row = q<{ sync_scope: string }>(
      "SELECT sync_scope FROM setting WHERE key = 'ui.keybindings'",
    );
    expect(row).toEqual([{ sync_scope: "local_only" }]);
    // 読み戻し: GET でも同じ値。ほかの項目だけの保存（テーマ・パネルの幅）では消えない
    expect(
      (await call<{ keybindings: Record<string, string[]> }>("GET", "/api/settings/ui")).body
        .keybindings,
    ).toEqual(kb);
    await call("PUT", "/api/settings/ui", { theme: "dark" });
    await call("PUT", "/api/settings/ui", { panelWidth: 420 });
    expect(
      (await call<{ keybindings: Record<string, string[]> }>("GET", "/api/settings/ui")).body
        .keybindings,
    ).toEqual(kb);
    for (const bad of [
      { "bad id": ["x"] },
      { help: ["a b c"] },
      { help: ["x", "y", "z", "w", "v"] },
    ])
      expect((await call("PUT", "/api/settings/ui", { keybindings: bad })).status).toBe(400);
  });
});

describe("表示の日付と集計の日付（D-054、ux-mvp 4.4.1）", () => {
  // 9/14 10:00 に始めて、0:00 を越えて 9/15 0:10〜0:50 に AI を動かし、9/15 1:40 に週ボードを開く
  const D2 = "2026-09-15";
  const jst = (day: number, h: number, m = 0) => Date.UTC(2026, 8, day, h - 9, m);
  const NOW = jst(15, 1, 40);

  async function night() {
    const { call, tr } = setup();
    tr.human(T0);
    tr.assistantEnd(T0 + 5 * MIN, "Done.", { durationMs: 5 * MIN });
    tr.human(jst(15, 0, 10));
    tr.assistantEnd(jst(15, 0, 50), "Done.", { durationMs: 40 * MIN });
    env.clock.set(NOW);
    await env.sync();
    const t = await call<TaskWriteResponse>("POST", "/api/tasks", { title: "Late fix", date: D });
    const id = t.body.task?.id ?? "";
    await call("POST", "/api/time-blocks", {
      taskId: id,
      startAt: jst(14, 23, 30),
      endAt: jst(15, 0, 30),
    });
    env.ai.runner.runOnce();
    const b = await call<BoardResponse>("GET", `/api/board?from=${D}&to=${D2}`);
    return { call, id, b: b.body };
  }

  test("列と縦軸は暦日、今日の列は暦日の今日", async () => {
    const { b } = await night();
    expect([b.today, b.displayToday]).toEqual([D, D2]);
    const [d14, d15] = b.days;
    expect([d14?.phase, d14?.logicalPhase, d15?.phase, d15?.logicalPhase]).toEqual([
      "past",
      "today",
      "today",
      "future",
    ]);
    expect(d15?.axis).toEqual({ start: jst(15, 0), end: jst(16, 0) });
    expect(d15?.logical).toEqual({ start: jst(15, 4), end: jst(16, 4) });
  });

  test("0:00 をまたぐブロックは両日の列に入る（9/14 は tasks、9/15 は crossTasks）", async () => {
    const { b, id } = await night();
    const [d14, d15] = b.days;
    expect(d14?.tasks.map((t) => t.id)).toEqual([id]);
    expect(d15?.tasks).toEqual([]);
    expect(d15?.crossTasks.map((t) => t.id)).toEqual([id]);
    expect(d14?.timeBlocks.map((x) => x.taskId)).toEqual([id]);
    expect(d15?.timeBlocks.map((x) => x.taskId)).toEqual([id]);
  });

  test("ブロックが複数あるタスク（前の時刻のブロックが残った）も、0:00 をまたぐものがあれば crossTasks に入る", async () => {
    const { call, id } = await night();
    // 同じタスクに 9/14 9:00 の古いブロックが残っている（先頭のブロックは時間軸にかからない）
    await call("POST", "/api/time-blocks", {
      taskId: id,
      startAt: jst(14, 9),
      endAt: jst(14, 9, 30),
    });
    const b = (await call<BoardResponse>("GET", `/api/board?from=${D}&to=${D2}`)).body;
    const d15 = b.days[1];
    expect(d15?.crossTasks.map((t) => t.id)).toEqual([id]);
  });

  test("深夜の AI は今日（9/15）の列の AI レーンに描き、集計は 9/14 に入る", async () => {
    const { b } = await night();
    const [d14, d15] = b.days;
    const m = (x: number) => Math.round(x / MIN) * MIN;
    expect(d15?.aiLane?.map((x) => x.runs.map((r) => [m(r.start), m(r.end)]))).toEqual([
      [[jst(15, 0, 10), jst(15, 0, 50)]],
    ]);
    // 項目の AI 時間は今の論理日（9/14）の値
    expect(m(d15?.aiLane?.[0]?.aiMs ?? 0)).toBe(45 * MIN);
    expect(d14?.aiRibbon.map((r) => [m(r.start), m(r.end)])).toEqual([[T0, T0 + 5 * MIN]]);
    expect([m(d14?.totals.aiMs ?? 0), d15?.totals.aiMs]).toEqual([45 * MIN, 0]);
  });
});

describe("3日ボード GET /api/board?around（D-074、m2-api 20章）", () => {
  test("前の稼働日・その日・次の稼働日の3日を返す（土日を飛ばす）。稼働日でない日を基準にしてもよい", async () => {
    const { call } = setup();
    // 2026-09-14 は月曜: 前は金曜 9/11、次は火曜 9/15
    const mon = await call<BoardResponse>("GET", `/api/board?around=${D}`);
    expect(mon.status).toBe(200);
    expect(mon.body.days.map((d) => [d.date, d.phase])).toEqual([
      ["2026-09-11", "past"],
      ["2026-09-14", "today"],
      ["2026-09-15", "future"],
    ]);
    // 金曜 9/18: 次は月曜 9/21
    const fri = await call<BoardResponse>("GET", "/api/board?around=2026-09-18");
    expect(fri.body.days.map((d) => d.date)).toEqual(["2026-09-17", "2026-09-18", "2026-09-21"]);
    // 土曜 9/19: 前は金曜、次は月曜
    const sat = await call<BoardResponse>("GET", "/api/board?around=2026-09-19");
    expect(sat.body.days.map((d) => d.date)).toEqual(["2026-09-18", "2026-09-19", "2026-09-21"]);
  });

  test("D-076: 左の列は前の稼働日と実際に作業した直近の日（本人の操作があった論理日）の新しい方", async () => {
    const { call } = setup();
    const days = async (around: string) =>
      (await call<BoardResponse>("GET", `/api/board?around=${around}`)).body.days.map(
        (d) => d.date,
      );
    // 作業日なし → 月曜 9/14 の左は金曜 9/11
    expect(await days(D)).toEqual(["2026-09-11", D, "2026-09-15"]);
    // 日曜 9/13 に作業 → 左は日曜
    // Turnlane の操作（user_op）をその日の正午に入れる
    const ins = (date: string) =>
      env.sqlite.run("INSERT INTO usage_event (id, at, kind) VALUES (?, ?, 'user_op')", [
        `u-${date}`,
        Date.parse(`${date}T12:00:00+09:00`),
      ]);
    ins("2026-09-13");
    expect(await days(D)).toEqual(["2026-09-13", D, "2026-09-15"]);
    // 火曜 9/15 を基準にすると左は前の稼働日の月曜（日曜より新しい）
    expect(await days("2026-09-15")).toEqual([D, "2026-09-15", "2026-09-16"]);
    // 基準日より後の作業日は数えない（土曜 9/19 の作業は 9/14 の左に出ない）
    ins("2026-09-19");
    expect(await days(D)).toEqual(["2026-09-13", D, "2026-09-15"]);
    // 日曜 9/20 を基準: 土曜 9/19 に作業 → 左は土曜
    expect(await days("2026-09-20")).toEqual(["2026-09-19", "2026-09-20", "2026-09-21"]);
  });

  test("from / to と同時、どれも無いときは 400 bad_range", async () => {
    const { call } = setup();
    const both = await call<{ error: string }>("GET", `/api/board?around=${D}&from=${D}&to=${D}`);
    expect(both).toEqual({ status: 400, body: { error: "bad_range" } });
    const none = await call<{ error: string }>("GET", "/api/board");
    expect(none).toEqual({ status: 400, body: { error: "bad_range" } });
  });
});
