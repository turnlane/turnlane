/**
 * AI の詳細パネルの作り直し（D-115・D-116）で GET /api/work-items/:id に足したもの:
 * - 許可を求めているツールの種類（PermissionRequest の hook の tool_name を種類に丸めたもの。コマンドの中身は持たない）
 * - エラーの種類（StopFailure の hook の error。古い spool の行は error_type）
 * - PR のレビューの判定（pr-poller の reviewDecision）と merged / closed になった時刻
 * - 猶予の長さ（設定）
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readSettings } from "@turnlane/core";
import {
  errorKindOf,
  permissionKindOf,
  reviewDecisionOf,
  type WorkItemDetail,
} from "@turnlane/core/api";
import type { GhClient } from "../src/github/pr-poller.ts";
import { createApp } from "../src/http/app.ts";
import { aiByTask } from "../src/launch/views.ts";
import { buildBoard } from "../src/planner/board.ts";
import { type AiEnv, makeAiEnv } from "./helpers/env.ts";
import { claudeTranscript } from "./helpers/transcript.ts";

const TOKEN = "e".repeat(64);
const HOST = "127.0.0.1:7317";
const MIN = 60_000;
const H = 60 * MIN;
const T0 = Date.UTC(2026, 9, 2, 0, 0);

let env: AiEnv;
afterEach(async () => {
  await env?.cleanup();
});

function setup(gh: GhClient | null = null) {
  env = makeAiEnv({ now: T0, gh });
  env.git.repos.set("/w/app", "/w/app");
  env.git.defaults.set("/w/app", "main");
  const app = createApp({
    token: TOKEN,
    port: 7317,
    hub: env.hub,
    health: () => ({}) as never,
    admin: { backup: () => ({ date: "", path: "" }) },
    ai: () => env.ai.deps,
    recordUserOp: env.ai.recordUserOp,
  });
  const get = async <T>(path: string) => {
    const r = await app.request(`http://${HOST}${path}`, {
      headers: { host: HOST, authorization: `Bearer ${TOKEN}` },
    });
    return (await r.json()) as T;
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
  const detailOf = async (branch: string) => {
    const id = env.sqlite
      .query<{ id: string }, [string]>("SELECT id FROM work_item WHERE branch = ?")
      .get(branch)?.id;
    return get<WorkItemDetail>(`/api/work-items/${id}`);
  };
  return { root, hook, detailOf };
}

describe("種類への丸め（D-116）", () => {
  test("ツール名 → 許可の種類。MCP のサーバー名などは返さない", () => {
    expect(permissionKindOf("Bash")).toBe("command");
    expect(permissionKindOf("Write")).toBe("file");
    expect(permissionKindOf("Edit")).toBe("file");
    expect(permissionKindOf("WebFetch")).toBe("web");
    expect(permissionKindOf("mcp__private-server__do_thing")).toBe("mcp");
    expect(permissionKindOf("Task")).toBe("other");
    expect(permissionKindOf(null)).toBeNull();
  });
  test("error_type → エラーの種類、reviewDecision → API の値", () => {
    expect(errorKindOf("rate_limit")).toBe("rate_limit");
    expect(errorKindOf("server_error")).toBe("server_error");
    expect(errorKindOf("authentication_failed")).toBe("authentication");
    expect(errorKindOf("something_new")).toBe("other");
    expect(reviewDecisionOf("APPROVED")).toBe("approved");
    expect(reviewDecisionOf("CHANGES_REQUESTED")).toBe("changes_requested");
    expect(reviewDecisionOf("REVIEW_REQUIRED")).toBe("review_required");
    expect(reviewDecisionOf(null)).toBeNull();
  });
});

describe("GET /api/work-items/:id（D-116）", () => {
  test("許可待ち: 許可を求めているツールの種類（hook の tool_name から）。猶予の長さ", async () => {
    const { root, hook, detailOf } = setup();
    const sid = "55555555-0000-4000-8000-000000000001";
    const tr = claudeTranscript(root, { sid, cwd: "/w/app", branch: "fix/migrate" });
    tr.human(T0);
    hook(sid, "UserPromptSubmit", T0);
    hook(sid, "PermissionRequest", T0 + 5 * MIN, { tool_name: "Bash" });
    env.clock.set(T0 + 10 * MIN);
    await env.sync();
    const d = await detailOf("fix/migrate");
    expect(d.workItem.status).toBe("needs_input");
    expect(d.permissionKind).toBe("command");
    expect(d.errorKind).toBeNull();
    expect(d.graceMs).toBe(15 * MIN);
  });

  test("エラー: StopFailure の error（公式の項目名）の種類。許可の種類は出さない", async () => {
    const { root, hook, detailOf } = setup();
    const sid = "55555555-0000-4000-8000-000000000002";
    const tr = claudeTranscript(root, { sid, cwd: "/w/app", branch: "docs/api" });
    tr.human(T0);
    hook(sid, "UserPromptSubmit", T0);
    hook(sid, "StopFailure", T0 + 20 * MIN, { error: "server_error" });
    env.clock.set(T0 + 30 * MIN);
    await env.sync();
    const d = await detailOf("docs/api");
    expect(d.workItem.status).toBe("error");
    expect(d.errorKind).toBe("server_error");
    expect(d.permissionKind).toBeNull();
  });

  test("利用枠（rate_limit）は上限待ち: エラーにせず、利用枠のリセットで明け、再開できるを期限なしで出す", async () => {
    const { root, hook, detailOf } = setup();
    const sid = "55555555-0000-4000-8000-000000000004";
    const tr = claudeTranscript(root, { sid, cwd: "/w/app", branch: "docs/limit" });
    tr.human(T0);
    hook(sid, "UserPromptSubmit", T0);
    hook(sid, "StopFailure", T0 + 20 * MIN, { error: "rate_limit" });
    // statusLine の受け口が記録した利用枠（アカウント = hook の設定ディレクトリ）。5 時間の枠を使い切り、T0+2h に戻る
    env.sqlite.run(
      `INSERT INTO claude_limit (account, five_hour_pct, five_hour_resets_at, seven_day_pct, seven_day_resets_at, at)
       VALUES (?, 100, ?, 30, ?, ?)`,
      [root, T0 + 2 * H, T0 + 3 * 24 * H, T0 + 19 * MIN],
    );
    env.clock.set(T0 + 30 * MIN);
    await env.sync();
    const d = await detailOf("docs/limit");
    expect(d.workItem).toMatchObject({ status: "done", reason: "rate_limit" });
    expect(d.errorKind).toBe("rate_limit");
    const id = d.workItem.id;
    const day = (now: number) =>
      buildBoard(
        env.sqlite,
        readSettings(env.mutate.db, "Asia/Tokyo"),
        now,
        0,
        "2026-10-02",
        "2026-10-02",
      ).days[0];
    const lane = day(T0 + 30 * MIN)?.aiLane?.find((x) => x.id === id);
    expect(lane?.limit).toEqual({ since: T0 + 20 * MIN, until: T0 + 2 * H, untilKnown: true });
    expect(lane?.waits.every((w) => w.tone === "needs_input")).toBe(true);
    const fus = () =>
      env.sqlite
        .query<
          { kind: string; artifact_ref: string; status: string; trigger_at: number },
          [string]
        >("SELECT kind, artifact_ref, status, trigger_at FROM follow_up WHERE work_item_id = ?")
        .all(id);
    expect(fus()).toEqual([]);
    // 明けた: 状態は止まっているだけ、再開できる（resume_error `<turn>:limit`）が 1 件
    env.clock.set(T0 + 2 * H + MIN);
    await env.sync();
    expect(fus()).toMatchObject([{ kind: "resume_error", status: "open", trigger_at: T0 + 2 * H }]);
    expect(fus()[0]?.artifact_ref.endsWith(":limit")).toBe(true);
    const after = await detailOf("docs/limit");
    expect(after.workItem).toMatchObject({ status: "your_turn", reason: "resume_limit" });
    expect(day(T0 + 2 * H + MIN)?.aiLane?.find((x) => x.id === id)?.limit).toBeUndefined();
    // 期限なし: 明けて 3 時間後も、翌日も残る
    for (const now of [T0 + 5 * H + MIN, T0 + 26 * H]) {
      env.clock.set(now);
      await env.sync();
      expect(fus()).toMatchObject([{ kind: "resume_error", status: "open" }]);
      expect((await detailOf("docs/limit")).workItem).toMatchObject({
        status: "your_turn",
        reason: "resume_limit",
      });
    }
  });

  test("古い記録（種類の無い StopFailure の嵐 ＋ quota_auto_resume_disabled）: 上限待ちにし、エラーにしない。再開できるは 1 件", async () => {
    const { root, hook, detailOf } = setup();
    const sid = "55555555-0000-4000-8000-000000000005";
    const tr = claudeTranscript(root, { sid, cwd: "/w/app", branch: "docs/old-limit" });
    tr.human(T0);
    hook(sid, "UserPromptSubmit", T0);
    // error も error_type も無い StopFailure（古い記録）が再試行で 200 件
    for (let i = 0; i < 200; i++) hook(sid, "StopFailure", T0 + 20 * MIN + i * 30_000);
    hook(sid, "Notification", T0 + 2 * H, { notification_type: "quota_auto_resume_disabled" });
    env.clock.set(T0 + 2 * H + MIN);
    await env.sync();
    const d = await detailOf("docs/old-limit");
    expect(d.workItem).toMatchObject({ status: "done", reason: "rate_limit" });
    expect(d.errorKind).toBe("rate_limit");
    const fus = () =>
      env.sqlite
        .query<{ kind: string; artifact_ref: string; trigger_at: number }, [string]>(
          "SELECT kind, artifact_ref, trigger_at FROM follow_up WHERE work_item_id = ?",
        )
        .all(d.workItem.id);
    expect(fus()).toEqual([]);
    // 停止（最初の StopFailure）から 5 時間で明ける。再開できるが 1 件だけ
    for (const at of [T0 + 5 * H + 21 * MIN, T0 + 5 * H + 30 * MIN, T0 + 5 * H + 50 * MIN]) {
      env.clock.set(at);
      await env.sync();
    }
    expect(fus()).toHaveLength(1);
    expect(fus()[0]).toMatchObject({ kind: "resume_error", trigger_at: T0 + 5 * H + 20 * MIN });
    expect(fus()[0]?.artifact_ref.endsWith(":limit")).toBe(true);
  });

  test("StopFailure の後に活動の無い終わっていないターンは、その時刻で終わる（流れ・AI の時間・レーンのブロックを伸ばさない）", async () => {
    const { root, hook, detailOf } = setup();
    const sid = "55555555-0000-4000-8000-000000000006";
    const tr = claudeTranscript(root, { sid, cwd: "/w/app", branch: "docs/stuck" });
    tr.human(T0);
    tr.assistantEnd(T0 + 10 * MIN, "Done.", { durationMs: 10 * MIN });
    // タスクの通知で始まったターン。同じ秒に StopFailure（公式の項目名 error）、AI の記録は無い
    tr.human(T0 + 20 * MIN, { origin: "task-notification" });
    hook(sid, "StopFailure", T0 + 20 * MIN, { error: "server_error" });
    hook(sid, "Notification", T0 + 21 * MIN, { notification_type: "idle_prompt" });
    env.clock.set(T0 + 18 * H);
    await env.sync();
    const d = await detailOf("docs/stuck");
    const last = d.turns.at(-1);
    expect(last).toMatchObject({ start: T0 + 20 * MIN, end: T0 + 20 * MIN, open: false });
    // 前のターンの 10 分だけ（18 時間伸びない）
    expect(d.workItem.aiMs).toBeLessThan(11 * MIN);
    // その日の時間軸（3 時間後の時点で見る。止まったターンのブロックは止まった時刻で終わる）
    const lane = buildBoard(
      env.sqlite,
      readSettings(env.mutate.db, "Asia/Tokyo"),
      T0 + 3 * H,
      0,
      "2026-10-02",
      "2026-10-02",
    ).days[0]?.aiLane?.find((x) => x.id === d.workItem.id);
    expect(lane?.runs.every((r) => !r.open && r.end <= T0 + 20 * MIN)).toBe(true);
    expect(lane?.aiMs).toBeLessThan(11 * MIN);
  });

  test("頼んだ AI（TaskAiView）にもエラーの種類が付く（拡張が利用枠で止まったことを知る）", async () => {
    const { root, hook } = setup();
    const sid = "55555555-0000-4000-8000-000000000003";
    const tr = claudeTranscript(root, { sid, cwd: "/w/app", branch: "docs/limits" });
    tr.human(T0);
    hook(sid, "UserPromptSubmit", T0);
    hook(sid, "StopFailure", T0 + 20 * MIN, { error: "rate_limit" });
    env.clock.set(T0 + 30 * MIN);
    await env.sync();
    const session = env.sqlite
      .query<{ id: string }, [string]>("SELECT id FROM ai_session WHERE external_id = ?")
      .get(sid)?.id as string;
    // タスクの行は要らない（aiByTask は ai_launch だけを読む）ので外部キーを外して入れる
    env.sqlite.run("PRAGMA foreign_keys = OFF");
    const launch = (id: string, taskId: string, sessionId: string | null, status: string) =>
      env.sqlite.run(
        `INSERT INTO ai_launch (id, task_id, tool, repo_root, cwd, status, session_id, created_at, updated_at, linked_at)
         VALUES (?, ?, 'claude_code', '/w/app', '/w/app', ?, ?, ?, ?, ?)`,
        [id, taskId, status, sessionId, T0, T0, sessionId ? T0 : null],
      );
    launch("a".repeat(32), "t-limit", session, "linked");
    launch("b".repeat(32), "t-pending", null, "pending");
    const views = aiByTask(env.sqlite, ["t-limit", "t-pending"]);
    // 利用枠の上限待ちはエラーにしない（state は limit）。エラーの種類は今までどおり rate_limit
    expect(views.get("t-limit")).toMatchObject({ state: "limit", errorKind: "rate_limit" });
    expect(views.get("t-pending")).toMatchObject({ state: "starting", errorKind: null });
  });

  test("PR: レビューの判定と merged の時刻", async () => {
    const gh: GhClient = {
      viewer: () => "me",
      prView: () => ({
        state: "merged",
        reviewDecision: "APPROVED",
        title: "Add login",
        url: "https://example.invalid/pull/7",
        headRefName: "feat/login",
        mergedAt: T0 + 2 * H,
        closedAt: T0 + 2 * H,
        reviews: [],
      }),
    };
    const { root, detailOf } = setup(gh);
    const sid = "55555555-0000-4000-8000-000000000003";
    const tr = claudeTranscript(root, { sid, cwd: "/w/app", branch: "feat/login" });
    tr.human(T0);
    tr.prLink(T0 + 20 * MIN, "example/app", 7);
    tr.assistantEnd(T0 + 21 * MIN, "Opened the PR.", { durationMs: 21 * MIN });
    env.clock.set(T0 + 3 * H);
    await env.sync();
    env.ai.poller?.pollOnce();
    await env.sync();
    const d = await detailOf("feat/login");
    const pr = d.artifacts.find((a) => a.kind === "pr");
    expect(pr?.state).toBe("merged");
    expect(pr?.reviewDecision).toBe("approved");
    expect(pr?.stateChangedAt).toBe(T0 + 2 * H);
  });
});
