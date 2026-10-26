/**
 * 自分の番の画面の「後で」の API（m2-api 2.3）:
 * - リセット前の上限待ちは GET /api/queue の `limitWaits` にだけ出る（items・件数には入れない）。明けたら items の「再開できる」
 * - POST /api/work-items/:id/dismiss-limit: 明けても「再開できる」を出さない
 * - POST /api/follow-ups/:id/wake（今やる）: スヌーズを外して帯に戻す。明日へ移したタスクは今日へ戻す
 * - スヌーズの時刻の指定（`{until}`）
 * - 時間に置いた自分の番: 開始までは `status: "scheduled"`（件数に入れない）、開始が来たら open。今やるで時間の割り当てを外す
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  DeferFollowUpResponse,
  QueueResponse,
  QueueSummaryResponse,
} from "@turnlane/core/api";
import { createApp } from "../src/http/app.ts";
import { createPlanner } from "../src/planner/index.ts";
import { type AiEnv, makeAiEnv, present } from "./helpers/env.ts";
import { claudeTranscript } from "./helpers/transcript.ts";

const TOKEN = "f".repeat(64);
const HOST = "127.0.0.1:7317";
const MIN = 60_000;
const H = 60 * MIN;
// 2026-10-02（金）09:00 JST
const T0 = Date.UTC(2026, 9, 2, 0, 0);
const FRI = "2026-10-02";
const MON = "2026-10-05";

let env: AiEnv;
afterEach(async () => {
  await env?.cleanup();
});

function setup() {
  env = makeAiEnv({ now: T0 });
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
    port: 7317,
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
    return { status: r.status, body: (await r.json()) as T };
  };
  const root = join(env.home, ".claude");
  const spool = join(env.dataDir, "spool");
  mkdirSync(spool, { recursive: true });
  const hooks: string[] = [];
  const hook = (sid: string, name: string, at: number, extra: Record<string, string> = {}) => {
    hooks.push(
      JSON.stringify({
        v: 1,
        tool: "claude_code",
        received_at: at,
        config_root: root,
        hook_event_name: name,
        session_id: sid,
        ...extra,
      }),
    );
    writeFileSync(join(spool, "hooks-20261002.jsonl"), `${hooks.join("\n")}\n`);
  };
  const queue = async () => (await call<QueueResponse>("GET", "/api/queue")).body;
  const summary = async () => (await call<QueueSummaryResponse>("GET", "/api/queue/summary")).body;
  return { call, root, hook, queue, summary };
}

/** 9:00 に始まり 9:20 に利用枠で止まったセッション（利用枠の記録が無いので、明けるのは停止から 5 時間） */
function limited(s: ReturnType<typeof setup>, branch = "docs/limit") {
  const sid = "66666666-0000-4000-8000-000000000001";
  const tr = claudeTranscript(s.root, { sid, cwd: "/w/app", branch });
  tr.human(T0);
  s.hook(sid, "UserPromptSubmit", T0);
  s.hook(sid, "StopFailure", T0 + 20 * MIN, { error: "rate_limit" });
}

describe("後で: リセット前の上限待ち", () => {
  test("limitWaits にだけ出る（items・件数に入れない）。明けたら items の「再開できる」に変わる", async () => {
    const s = setup();
    limited(s);
    env.clock.set(T0 + 30 * MIN);
    await env.sync();
    const q = await s.queue();
    expect(q.items).toEqual([]);
    expect(q.limitWaits).toHaveLength(1);
    expect(q.limitWaits?.[0]).toMatchObject({
      branch: "docs/limit",
      status: "done",
      reason: "rate_limit",
      followUps: [],
      limitWait: { since: T0 + 20 * MIN, until: T0 + 5 * H + 20 * MIN, untilKnown: false },
    });
    expect((await s.summary()).count).toBe(0);
    // 明けた
    env.clock.set(T0 + 5 * H + 21 * MIN);
    await env.sync();
    const after = await s.queue();
    expect(after.limitWaits).toEqual([]);
    expect(after.items).toHaveLength(1);
    expect(after.items[0]?.followUps[0]).toMatchObject({ kind: "resume_error", limit: true });
    expect(after.items[0]?.followUps[0]?.expiresAt).toBeNull();
    expect((await s.summary()).count).toBe(1);
  });

  test("対応不要: 後でから消え、明けても「再開できる」を出さない", async () => {
    const s = setup();
    limited(s);
    env.clock.set(T0 + 30 * MIN);
    await env.sync();
    const id = (await s.queue()).limitWaits?.[0]?.workItemId ?? "";
    const r = await s.call<{ followUp: { status: string } }>(
      "POST",
      `/api/work-items/${id}/dismiss-limit`,
    );
    expect(r.status).toBe(200);
    expect(r.body.followUp.status).toBe("dismissed");
    expect((await s.queue()).limitWaits).toEqual([]);
    env.clock.set(T0 + 6 * H);
    await env.sync();
    const after = await s.queue();
    expect(after.items).toEqual([]);
    expect(after.limitWaits).toEqual([]);
    // 上限待ちでなくなったカードは 409
    expect((await s.call("POST", `/api/work-items/${id}/dismiss-limit`)).status).toBe(409);
  });
});

describe("後で: 今やる（スヌーズ解除）", () => {
  /** 9:00〜9:30 の実行が質問で終わる → 9:45 に返答タスク */
  async function replyTask(s: ReturnType<typeof setup>) {
    const tr = claudeTranscript(s.root, {
      sid: "66666666-0000-4000-8000-000000000002",
      cwd: "/w/app",
      branch: "feat/login",
    });
    tr.human(T0);
    tr.assistantEnd(T0 + 30 * MIN, "Should the drop target snap to 15 minutes?", {
      durationMs: 30 * MIN,
    });
    for (let t = T0 + 30 * MIN; t <= T0 + H; t += 15 * MIN) {
      env.clock.set(t);
      await env.sync();
    }
    const fu = (await s.queue()).items[0]?.followUps[0];
    expect(fu).toMatchObject({ kind: "reply", status: "open", taskDate: FRI });
    return fu?.id ?? "";
  }

  test("スヌーズ中は items に snoozed のまま残り件数に入らない。今やるで open に戻る", async () => {
    const s = setup();
    const id = await replyTask(s);
    await s.call("POST", `/api/follow-ups/${id}/snooze`, { preset: "1h" });
    const q = await s.queue();
    expect(q.items[0]?.followUps[0]).toMatchObject({ status: "snoozed" });
    expect((await s.summary()).count).toBe(0);
    const r = await s.call<DeferFollowUpResponse>("POST", `/api/follow-ups/${id}/wake`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ followUpId: id, snoozeUntil: null, taskDate: FRI });
    expect((await s.queue()).items[0]?.followUps[0]).toMatchObject({
      status: "open",
      snoozeUntil: null,
    });
    expect((await s.summary()).count).toBe(1);
  });

  test("明日へ移したものは今日へ戻す", async () => {
    const s = setup();
    const id = await replyTask(s);
    const d = await s.call<DeferFollowUpResponse>("POST", `/api/follow-ups/${id}/defer`);
    expect(d.body.taskDate).toBe(MON);
    expect((await s.queue()).items[0]?.followUps[0]).toMatchObject({
      status: "snoozed",
      taskDate: MON,
    });
    const r = await s.call<DeferFollowUpResponse>("POST", `/api/follow-ups/${id}/wake`);
    expect(r.body.taskDate).toBe(FRI);
    expect((await s.queue()).items[0]?.followUps[0]).toMatchObject({
      status: "open",
      taskDate: FRI,
    });
    expect((await s.call("POST", "/api/follow-ups/nope/wake")).status).toBe(404);
  });
});

describe("後で: 時刻を指定したスヌーズ・時間に置いた自分の番", () => {
  async function replyTask(s: ReturnType<typeof setup>) {
    const tr = claudeTranscript(s.root, {
      sid: "66666666-0000-4000-8000-000000000003",
      cwd: "/w/app",
      branch: "feat/night",
    });
    tr.human(T0);
    tr.assistantEnd(T0 + 30 * MIN, "Should the drop target snap to 15 minutes?", {
      durationMs: 30 * MIN,
    });
    for (let t = T0 + 30 * MIN; t <= T0 + H; t += 15 * MIN) {
      env.clock.set(t);
      await env.sync();
    }
    const fu = (await s.queue()).items[0]?.followUps[0];
    expect(fu).toMatchObject({ kind: "reply", status: "open" });
    return { id: fu?.id ?? "", taskId: fu?.taskId ?? "" };
  }

  test("スヌーズは until（epoch ms）で時刻を指定できる。過去は 400", async () => {
    const s = setup();
    const { id } = await replyTask(s);
    const until = T0 + 5 * H;
    const r = await s.call("POST", `/api/follow-ups/${id}/snooze`, { until });
    expect(r.status).toBe(200);
    expect((await s.queue()).items[0]?.followUps[0]).toMatchObject({
      status: "snoozed",
      snoozeUntil: until,
    });
    expect((await s.call("POST", `/api/follow-ups/${id}/snooze`, { until: T0 })).status).toBe(400);
  });

  test("時間に置いた自分の番は開始まで scheduled（件数に入れない）。開始が来たら open", async () => {
    const s = setup();
    const { id, taskId } = await replyTask(s);
    const start = T0 + 3 * H;
    const b = await s.call("POST", "/api/time-blocks", {
      taskId,
      startAt: start,
      endAt: start + 30 * MIN,
    });
    expect(b.status).toBe(201);
    const q = await s.queue();
    expect(q.items[0]?.followUps[0]).toMatchObject({
      id,
      status: "scheduled",
      scheduledAt: start,
    });
    expect((await s.summary()).count).toBe(0);
    env.clock.set(start - MIN);
    expect((await s.queue()).items[0]?.followUps[0]?.status).toBe("scheduled");
    env.clock.set(start);
    const after = (await s.queue()).items[0]?.followUps[0];
    expect(after?.status).toBe("open");
    expect(after?.scheduledAt).toBeUndefined();
    expect((await s.summary()).count).toBe(1);
  });

  test("過去の時刻に置いたブロックでは scheduled にならない", async () => {
    const s = setup();
    const { taskId } = await replyTask(s);
    await s.call("POST", "/api/time-blocks", {
      taskId,
      startAt: T0,
      endAt: T0 + 30 * MIN,
    });
    expect((await s.queue()).items[0]?.followUps[0]?.status).toBe("open");
  });

  test("今やる: 開始の来ていない時間ブロックを消して帯に戻す。置いてから今までは集計外のまま残す", async () => {
    const s = setup();
    const { id, taskId } = await replyTask(s);
    const placedAt = env.clock.now();
    const start = T0 + 3 * H;
    await s.call("POST", "/api/time-blocks", { taskId, startAt: start, endAt: start + 30 * MIN });
    env.clock.set(placedAt + 20 * MIN);
    const r = await s.call<DeferFollowUpResponse>("POST", `/api/follow-ups/${id}/wake`);
    expect(r.status).toBe(200);
    expect((await s.queue()).items[0]?.followUps[0]).toMatchObject({ status: "open" });
    expect((await s.summary()).count).toBe(1);
    const left = env.sqlite
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM time_block WHERE task_id = ? AND deleted_at IS NULL",
      )
      .get(taskId);
    expect(left?.n).toBe(0);
    const row = env.sqlite
      .query<{ snoozes_json: string }, [string]>("SELECT snoozes_json FROM follow_up WHERE id = ?")
      .get(id);
    expect(JSON.parse(row?.snoozes_json ?? "[]")).toEqual([[placedAt, placedAt + 20 * MIN]]);
  });
});
