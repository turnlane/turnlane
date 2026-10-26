import { describe, expect, test } from "bun:test";
import { OpError } from "../src/derive/ops.ts";
import { parsePrView } from "../src/github/pr-poller.ts";
import type { AiDeps } from "../src/http/ai-routes.ts";
import { createApp } from "../src/http/app.ts";
import { cookieValue } from "../src/http/auth.ts";
import { SseHub } from "../src/http/sse.ts";

const TOKEN = "b".repeat(64);
const PORT = 7317;
const HOST = `127.0.0.1:${PORT}`;
const ORIGIN = `http://${HOST}`;

function app(record: (at: number) => void) {
  return createApp({
    token: TOKEN,
    port: PORT,
    hub: new SseHub(),
    health: () => ({}) as never,
    admin: { backup: () => ({ date: "x", path: "y" }) },
    recordUserOp: record,
  });
}

describe("勤務時間の「操作」（user_op）の記録（phase0-plan 3.3.1、W22）", () => {
  test("ブラウザ（クッキー）と turnlane CLI（x-turnlane-client: cli）の状態を変える呼び出しだけを数える", async () => {
    const ops: number[] = [];
    const a = app((at) => ops.push(at));
    const call = (path: string, init: RequestInit & { headers: Record<string, string> }) =>
      a.request(`http://${HOST}${path}`, { ...init, headers: { host: HOST, ...init.headers } });
    // ブラウザ（クッキー + Origin）の POST は数える
    await call("/api/admin/backup", {
      method: "POST",
      headers: { cookie: `turnlane_session=${cookieValue(TOKEN)}`, origin: ORIGIN },
    });
    expect(ops).toHaveLength(1);
    // MCP（Bearer、クライアントの印なし）は数えない
    await call("/api/admin/backup", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(ops).toHaveLength(1);
    // turnlane CLI は数える
    await call("/api/admin/backup", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "x-turnlane-client": "cli" },
    });
    expect(ops).toHaveLength(2);
    // 読み取り（GET）・失敗した呼び出しは数えない
    await call("/api/health", {
      method: "GET",
      headers: { authorization: `Bearer ${TOKEN}`, "x-turnlane-client": "cli" },
    });
    await call("/api/queue", {
      method: "GET",
      headers: { authorization: `Bearer ${TOKEN}`, "x-turnlane-client": "cli" },
    });
    await call("/api/follow-ups/x/dismiss", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "x-turnlane-client": "cli" },
    });
    expect(ops).toHaveLength(2);
  });
});

describe("gh pr view の解釈（M1-11）", () => {
  test("レビューの本文は捨て、作者と時刻だけを残す。draft と merged", () => {
    const pr = parsePrView(
      JSON.stringify({
        state: "MERGED",
        isDraft: false,
        reviewDecision: "APPROVED",
        title: "Add login",
        url: "https://github.com/o/r/pull/1",
        headRefName: "feat/login",
        mergedAt: "2026-09-14T03:00:00Z",
        closedAt: "2026-09-14T03:00:00Z",
        reviews: [
          {
            author: { login: "me" },
            body: "SENTINEL_BODY_review",
            submittedAt: "2026-09-14T02:00:00Z",
          },
        ],
      }),
    );
    expect(pr).toEqual({
      state: "merged",
      reviewDecision: "APPROVED",
      title: "Add login",
      url: "https://github.com/o/r/pull/1",
      headRefName: "feat/login",
      mergedAt: Date.parse("2026-09-14T03:00:00Z"),
      closedAt: Date.parse("2026-09-14T03:00:00Z"),
      reviews: [{ author: "me", at: Date.parse("2026-09-14T02:00:00Z") }],
    });
    expect(JSON.stringify(pr)).not.toContain("SENTINEL");
    expect(parsePrView(JSON.stringify({ state: "OPEN", isDraft: true }))?.state).toBe("draft");
    expect(parsePrView("not json")).toBeNull();
  });
});

describe("メニューバーの件数とデスクトップの通知の切り替え（desktop-shell.md 3.4・4.1）", () => {
  const fu = (id: string, status: "open" | "snoozed") => ({ id, status });
  const items = [
    { workItemId: "a", status: "needs_input", followUps: [fu("1", "open")] },
    { workItemId: "b", status: "your_turn", followUps: [fu("2", "open")] },
    { workItemId: "c", status: "error", followUps: [fu("3", "snoozed")] },
  ];
  const ai = {
    queue: () => items,
    meta: () => ({ rev: 7, today: "2026-10-05", displayToday: "2026-10-05", now: 0, tz: "UTC" }),
    queueExtras: () => ({ notifyPausedUntil: null }),
  } as unknown as AiDeps;
  const hub = new SseHub();
  const a = createApp({
    token: TOKEN,
    port: PORT,
    hub,
    health: () => ({}) as never,
    admin: { backup: () => ({ date: "x", path: "y" }) },
    ai: () => ai,
  });
  const get = async (path: string) =>
    (
      await a.request(`http://${HOST}${path}`, {
        headers: { host: HOST, authorization: `Bearer ${TOKEN}` },
      })
    ).json();
  test("GET /api/queue/summary はスヌーズ中だけのカードを数えない", async () => {
    expect(await get("/api/queue/summary")).toEqual({
      count: 2,
      needsInput: 1,
      error: 0,
      yourTurn: 1,
      rev: 7,
    });
  });
  test("QueueResponse.desktopNotifier はデスクトップの購読者がいないと false", async () => {
    expect(((await get("/api/queue")) as { desktopNotifier: boolean }).desktopNotifier).toBe(false);
  });
});

describe("POST /api/work-items/:id/reply-task（AI カードの y。D-066 (2)）", () => {
  const row = {
    id: "f1",
    work_item_id: "w1",
    kind: "reply",
    status: "open",
    trigger_at: 5,
    snooze_until: null,
    engaged_at: null,
    closed_at: null,
    close_reason: null,
    task_id: "t1",
  };
  let created = true;
  const ai = {
    meta: () => ({ rev: 3 }),
    ops: {
      createReplyTask: (id: string) => {
        if (id !== "w1") throw new OpError(404, "work_item not found");
        const r = { row, created, taskId: "t1" };
        created = false;
        return r;
      },
    },
  } as unknown as AiDeps;
  const a = createApp({
    token: TOKEN,
    port: PORT,
    hub: new SseHub(),
    health: () => ({}) as never,
    admin: { backup: () => ({ date: "x", path: "y" }) },
    ai: () => ai,
  });
  const post = (id: string) =>
    a.request(`http://${HOST}/api/work-items/${id}/reply-task`, {
      method: "POST",
      headers: { host: HOST, authorization: `Bearer ${TOKEN}` },
    });
  test("作れば 201、既にあれば 200 で created: false、無いカードは 404", async () => {
    const r1 = await post("w1");
    expect(r1.status).toBe(201);
    expect(await r1.json()).toEqual({
      rev: 3,
      created: true,
      taskId: "t1",
      followUp: {
        id: "f1",
        workItemId: "w1",
        kind: "reply",
        status: "open",
        triggerAt: 5,
        snoozeUntil: null,
        engagedAt: null,
        closedAt: null,
        closeReason: null,
        taskId: "t1",
      },
    });
    const r2 = await post("w1");
    expect(r2.status).toBe(200);
    expect(((await r2.json()) as { created: boolean }).created).toBe(false);
    expect((await post("nope")).status).toBe(404);
  });
});
