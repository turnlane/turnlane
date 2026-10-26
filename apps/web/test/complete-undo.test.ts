/**
 * D-139 (3)（完了に「元に戻す」）: 完了は「完了にしました · 元に戻す」の知らせを出し、⌘Z で前の状態（todo / doing）と
 * 元の場所（Inbox の位置・ボードの日付）へ戻す。完了と一緒に閉じた自分の番も開き直す。自分の番の「完了」も同じ。
 * fetch を差し替えて、送った要求で確かめる。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { BoardResponse, InboxResponse, TaskView } from "@turnlane/core/web";
import { queryClient } from "../src/data/client.ts";
import { completeFollowUp, completeItems, setComplete, undoLast } from "../src/data/mutations.ts";
import { getUi, setUi } from "../src/lib/store.ts";

const D = "2026-10-02";

const task = (id: string, p: Partial<TaskView> = {}): TaskView =>
  ({
    id,
    title: { t: "text", text: id },
    status: "todo",
    scheduledDate: null,
    laneOrder: "a",
    createdAt: 1000,
    completedAt: null,
    followUpId: null,
    ...p,
  }) as unknown as TaskView;

let sent: { method: string; path: string; body: Record<string, unknown> }[] = [];
let fail = false;
let closed: string[] = [];
const realFetch = globalThis.fetch;

const inbox = () => queryClient.getQueryData<InboxResponse>(["inbox"])?.tasks.map((t) => t.id);
const boardTask = (id: string) =>
  queryClient.getQueryData<BoardResponse>(["board", D, D])?.days[0]?.tasks.find((t) => t.id === id);
const toasts = () => getUi().toasts.map((t) => `${t.text} · ${t.action?.label ?? ""}`);

beforeEach(async () => {
  // 前のテストの ⌘Z を空にする
  for (let i = 0; i < 30; i++) await undoLast();
  sent = [];
  fail = false;
  closed = [];
  setUi({ toasts: [] });
  queryClient.clear();
  queryClient.setQueryData(["inbox"], {
    tasks: [task("new", { createdAt: 3000 }), task("mid", { createdAt: 2000 }), task("old")],
  } as unknown as InboxResponse);
  queryClient.setQueryData(["board", D, D], {
    days: [
      {
        date: D,
        tasks: [task("b1", { scheduledDate: D, status: "doing" })],
        crossTasks: [],
        timeBlocks: [],
      },
    ],
  } as unknown as BoardResponse);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input), "http://x");
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    if (method === "GET") return Response.json({});
    const raw = init?.body ?? (input instanceof Request ? await input.text() : null);
    const body = raw ? (JSON.parse(String(raw)) as Record<string, unknown>) : {};
    sent.push({ method, path: url.pathname, body });
    if (fail) return Response.json({ error: "x" }, { status: 500 });
    if (url.pathname.endsWith("/complete") && url.pathname.startsWith("/api/tasks/"))
      return Response.json({ rev: 1, task: null, closedFollowUps: closed });
    return Response.json({ rev: 1, task: null });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("完了の取り消し（D-139 (3)）", () => {
  test("Inbox で完了 → 知らせ「Completed. · Undo」、⌘Z で元の位置に戻し todo で未完了にする", async () => {
    await setComplete(task("mid", { createdAt: 2000 }), true);
    expect(inbox()).toEqual(["new", "old"]);
    expect(toasts()).toEqual(["Completed. · Undo"]);
    await undoLast();
    expect(inbox()).toEqual(["new", "mid", "old"]);
    expect(sent.at(-1)).toEqual({
      method: "POST",
      path: "/api/tasks/mid/uncomplete",
      body: { status: "todo" },
    });
  });

  test("知らせの「元に戻す」でも戻す", async () => {
    await setComplete(task("old"), true);
    getUi().toasts[0]?.action?.run();
    await new Promise((r) => setTimeout(r, 20));
    expect(sent.at(-1)?.path).toBe("/api/tasks/old/uncomplete");
    expect(inbox()).toEqual(["new", "mid", "old"]);
  });

  test("計測中（doing）のタスクは doing に戻す。ボードの状態も戻す", async () => {
    await setComplete(task("b1", { scheduledDate: D, status: "doing" }), true);
    expect(boardTask("b1")?.status).toBe("done");
    await undoLast();
    expect(boardTask("b1")?.status).toBe("doing");
    expect(sent.at(-1)?.body).toEqual({ status: "doing" });
  });

  test("完了と一緒に閉じた自分の番を開き直す", async () => {
    closed = ["f1", "f2"];
    await setComplete(task("mid", { createdAt: 2000, followUpId: "f1" }), true);
    await undoLast();
    expect(sent.at(-1)?.body).toEqual({ status: "todo", reopenFollowUps: ["f1", "f2"] });
  });

  test("未完了に戻す操作・失敗した完了は知らせも ⌘Z も積まない", async () => {
    await setComplete(task("b1", { scheduledDate: D, status: "done" }), false);
    fail = true;
    await setComplete(task("old"), true);
    expect(toasts().filter((t) => t.startsWith("Completed"))).toEqual([]);
    const n = sent.length;
    await undoLast();
    expect(sent.length).toBe(n);
  });

  test("自分の番の「完了」も知らせと ⌘Z で開き直す（POST /follow-ups/:id/reopen）", async () => {
    await completeFollowUp("f9");
    expect(toasts()).toEqual(["Completed. · Undo"]);
    await undoLast();
    expect(sent.at(-1)).toEqual({ method: "POST", path: "/api/follow-ups/f9/reopen", body: {} });
  });

  test("まとめて完了は知らせ1つ・⌘Z 1回で全部戻す", async () => {
    await completeItems([task("new", { createdAt: 3000 }), task("old")], ["f3"]);
    expect(toasts()).toEqual(["Completed 3 items. · Undo"]);
    sent = [];
    await undoLast();
    expect(sent.map((s) => s.path).sort()).toEqual([
      "/api/follow-ups/f3/reopen",
      "/api/tasks/new/uncomplete",
      "/api/tasks/old/uncomplete",
    ]);
    expect(inbox()).toEqual(["new", "mid", "old"]);
    sent = [];
    await undoLast();
    expect(sent).toEqual([]);
  });
});
