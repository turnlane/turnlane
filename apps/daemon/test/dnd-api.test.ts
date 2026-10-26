/**
 * DnD の残り（M2-17・M2-18）と設定のプロジェクト（M2-9）で足した API の結合テスト（m2-api.md 19章）:
 * 自分の番の時間ブロックを時間軸に描く、未来の日への defer、AI カードからの確認タスク、統合、プロジェクトとリポジトリの対応。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type {
  BoardResponse,
  DeferFollowUpResponse,
  ProjectView,
  QueueResponse,
  TaskWriteResponse,
} from "@turnlane/core/api";
import { createApp } from "../src/http/app.ts";
import { createPlanner } from "../src/planner/index.ts";
import { type AiEnv, makeAiEnv } from "./helpers/env.ts";
import { claudeTranscript } from "./helpers/transcript.ts";

const TOKEN = "d".repeat(64);
const HOST = "127.0.0.1:7317";
const MIN = 60_000;
const H = 60 * MIN;
// 2026-10-02（金）09:00 JST
const T0 = Date.UTC(2026, 9, 2, 0, 0);
const FRI = "2026-10-02";

let env: AiEnv;
afterEach(async () => {
  await env?.cleanup();
});

function setup() {
  env = makeAiEnv({ now: T0 });
  for (const r of ["/w/app", "/w/web"]) {
    env.git.repos.set(r, r);
    env.git.defaults.set(r, "main");
  }
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
    const text = await r.text();
    let json: unknown = text;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: r.status, body: json as T };
  };
  return { call };
}

/** 9:00〜9:30 の実行が質問で終わり、9:45 に返答タスクができる */
async function question(cwd: string, branch: string, sid: string) {
  const tr = claudeTranscript(join(env.home, ".claude"), { sid, cwd, branch });
  tr.human(T0);
  tr.assistantEnd(T0 + 30 * MIN, "Should the drop target snap to 15 minutes?", {
    durationMs: 30 * MIN,
  });
  return tr;
}

async function until(t: number) {
  for (let x = env.clock.now(); x <= t; x += 30 * MIN) {
    env.clock.set(x);
    await env.sync();
  }
  env.clock.set(t);
  await env.sync();
}

describe("自分の番のドラッグ（ux-mvp 7章、m2-api 19章）", () => {
  test("時間ブロックを置いた自分の番はその日の tasks に入り（時間軸に描く）、開始までは帯から外れて後でに出る", async () => {
    const { call } = setup();
    await question("/w/app", "feat/login", "44444444-0000-4000-8000-000000000001");
    await until(T0 + H);
    const fu = (await call<QueueResponse>("GET", "/api/queue")).body.items[0]?.followUps[0];
    expect(fu?.taskId).toBeTruthy();
    const b0 = await call<BoardResponse>("GET", `/api/board?from=${FRI}&to=${FRI}`);
    expect(b0.body.days[0]?.tasks.some((t) => t.id === fu?.taskId)).toBe(false);
    const r = await call("POST", "/api/time-blocks", {
      taskId: fu?.taskId,
      startAt: T0 + 6 * H,
      endAt: T0 + 6 * H + 30 * MIN,
    });
    expect(r.status).toBe(201);
    const b1 = await call<BoardResponse>("GET", `/api/board?from=${FRI}&to=${FRI}`);
    const t = b1.body.days[0]?.tasks.find((x) => x.id === fu?.taskId);
    expect(t?.followUpId).toBe(fu?.id ?? "");
    // 容量（Planned）には数えない
    expect(b1.body.days[0]?.totals.plannedMs).toBe(b0.body.days[0]?.totals.plannedMs);
    // 開始までは scheduled（帯・件数に入れず、自分の番の画面の「後で」に出す。ux-mvp 4.6）
    const q = await call<QueueResponse>("GET", "/api/queue");
    expect(q.body.items[0]?.followUps[0]).toMatchObject({
      status: "scheduled",
      scheduledAt: T0 + 6 * H,
    });
  });

  test("未来の日付へ落とすと、その日へ移してその日の勤務開始までスヌーズする。今日以前は 400", async () => {
    const { call } = setup();
    await question("/w/app", "feat/login", "44444444-0000-4000-8000-000000000002");
    await until(T0 + H);
    const fu = (await call<QueueResponse>("GET", "/api/queue")).body.items[0]?.followUps[0];
    const tue = "2026-10-06";
    const r = await call<DeferFollowUpResponse>("POST", `/api/follow-ups/${fu?.id}/defer`, {
      date: tue,
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ taskDate: tue, snoozeUntil: Date.UTC(2026, 9, 6, 1, 0) });
    expect((await call("POST", `/api/follow-ups/${fu?.id}/defer`, { date: FRI })).status).toBe(400);
  });
});

describe("AI カードのドラッグ", () => {
  test("自分レーンへ: 確認タスクと時間ブロック。source = ai、元の AI 項目、プロジェクトはリポジトリから", async () => {
    const { call } = setup();
    const p = await call<{ project: ProjectView }>("POST", "/api/projects", {
      name: "app",
      repoPaths: ["/w/app/"],
    });
    expect(p.status).toBe(201);
    expect(p.body.project.repoPaths).toEqual(["/w/app"]);
    await question("/w/app", "feat/login", "44444444-0000-4000-8000-000000000003");
    await until(T0 + H);
    const wi = (await call<BoardResponse>("GET", `/api/board?from=${FRI}&to=${FRI}`)).body.days[0]
      ?.aiLane?.[0];
    expect(wi).toBeTruthy();
    const r = await call<TaskWriteResponse>("POST", `/api/work-items/${wi?.id}/check-task`, {
      title: "Check: login",
      date: FRI,
      startAt: T0 + 7 * H,
      endAt: T0 + 7 * H + 30 * MIN,
    });
    expect(r.status).toBe(201);
    expect(r.body.task).toMatchObject({
      title: { t: "text", text: "Check: login" },
      scheduledDate: FRI,
      estimateMin: 30,
      projectId: p.body.project.id,
      workItemId: wi?.id,
      origin: { source: "ai" },
    });
    const b = await call<BoardResponse>("GET", `/api/board?from=${FRI}&to=${FRI}`);
    expect(b.body.days[0]?.timeBlocks.find((x) => x.taskId === r.body.task?.id)?.start).toBe(
      T0 + 7 * H,
    );
    // 自動の返答タスクにもプロジェクトが付いている
    const q = await call<QueueResponse>("GET", "/api/queue");
    const fuTask = q.body.items[0]?.followUps[0]?.taskId ?? "";
    expect(
      env.sqlite
        .query<{ project_id: string | null }, [string]>("SELECT project_id FROM task WHERE id = ?")
        .get(fuTask)?.project_id,
    ).toBe(p.body.project.id);
    expect(
      (
        await call("POST", "/api/work-items/nope/check-task", {
          title: "x",
          date: FRI,
          startAt: 1,
          endAt: 2,
        })
      ).status,
    ).toBe(404);
  });

  test("別の AI カードへ: 統合すると元のカードは消え、ターンと自分の番は統合先へ移る", async () => {
    const { call } = setup();
    await question("/w/app", "feat/login", "44444444-0000-4000-8000-000000000004");
    const other = claudeTranscript(join(env.home, ".claude"), {
      sid: "44444444-0000-4000-8000-000000000005",
      cwd: "/w/web",
      branch: "feat/signup",
    });
    // 統合先は朝のうちに終わった作業（統合元の質問より前）
    other.human(T0 - 2 * H);
    other.assistantEnd(T0 - 2 * H + 10 * MIN, "Done.", { durationMs: 10 * MIN });
    await until(T0 + H);
    const lane = (await call<BoardResponse>("GET", `/api/board?from=${FRI}&to=${FRI}`)).body.days[0]
      ?.aiLane;
    expect(lane?.length).toBe(2);
    const from = lane?.find((x) => x.branch === "feat/login");
    const into = lane?.find((x) => x.branch === "feat/signup");
    expect(
      (await call("POST", `/api/work-items/${from?.id}/merge`, { intoId: from?.id })).status,
    ).toBe(409);
    const r = await call("POST", `/api/work-items/${from?.id}/merge`, { intoId: into?.id });
    expect(r.status).toBe(200);
    await until(T0 + H + 30 * MIN);
    const after = (await call<BoardResponse>("GET", `/api/board?from=${FRI}&to=${FRI}`)).body
      .days[0]?.aiLane;
    expect(after?.map((x) => x.id)).toEqual([into?.id ?? ""]);
    expect(after?.[0]?.turns).toBe(2);
    // 自分の番（返答タスク）も統合先のものになる
    const q = await call<QueueResponse>("GET", "/api/queue");
    expect(q.body.items.map((x) => x.workItemId)).toEqual([into?.id ?? ""]);
    expect(q.body.items[0]?.followUps.map((f) => f.kind)).toEqual(["reply"]);
    // 2回目は 409
    expect(
      (await call("POST", `/api/work-items/${from?.id}/merge`, { intoId: into?.id })).status,
    ).toBe(409);
  });
});

describe("プロジェクト（設定画面。M2-9）", () => {
  test("作成・名前の重なり・編集・アーカイブ・候補のリポジトリ", async () => {
    const { call } = setup();
    const a = await call<{ project: ProjectView }>("POST", "/api/projects", { name: "blog" });
    expect(a.status).toBe(201);
    expect((await call("POST", "/api/projects", { name: "blog" })).status).toBe(409);
    expect((await call("POST", "/api/projects", { name: "x", repoPaths: ["rel"] })).status).toBe(
      400,
    );
    const e = await call<{ project: ProjectView }>("PATCH", `/api/projects/${a.body.project.id}`, {
      name: "Blog",
      color: "#4fb3a9",
      repoPaths: ["/w/blog", "/w/blog/"],
    });
    expect(e.body.project).toMatchObject({
      name: "Blog",
      color: "#4fb3a9",
      repoPaths: ["/w/blog"],
    });
    await call("PATCH", `/api/projects/${a.body.project.id}`, { archived: true });
    expect((await call<{ projects: ProjectView[] }>("GET", "/api/projects")).body.projects).toEqual(
      [],
    );
    const all = await call<{ projects: ProjectView[] }>("GET", "/api/projects?all=1");
    expect(all.body.projects[0]?.archivedAt).not.toBeNull();
    await question("/w/app", "feat/login", "44444444-0000-4000-8000-000000000006");
    await until(T0 + H);
    const repos = await call<{ repos: { path: string }[] }>("GET", "/api/projects/repos");
    expect(repos.body.repos.map((r) => r.path)).toEqual(["/w/app"]);
  });
});
