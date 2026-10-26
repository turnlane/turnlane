/**
 * AI の画面の API（GET /api/ai/live。m2-api 33章）:
 * - running の項目（ターンが開いている）は今のひと続きの作業の始まりつきで出る
 * - Claude Code はプロセスで決める（sessions/<pid>.json の確かめが新しい間だけ。終われば出ない）。生きているセッションの数
 * - Codex はプロセスが分からないので、最後の動きから 6 時間だけ unknown で出る
 * - サブエージェントは行にせず、親の項目に今も動いている数
 * - 隠した項目は出さない
 * - 頼んだ起動の片付けが残っている（worktree が残る）項目は launch つきで出る。タスクの完了も分かる
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nullLogger } from "@turnlane/collectors";
import type { AiLaunchResult, AiLiveResponse, LiveItem, TaskView } from "@turnlane/core/api";
import { createApp } from "../src/http/app.ts";
import { LaunchService } from "../src/launch/service.ts";
import { createPlanner } from "../src/planner/index.ts";
import { type AiEnv, makeAiEnv, present } from "./helpers/env.ts";
import { FakeLaunchSystem } from "./helpers/launch-system.ts";
import { claudeSubagent, claudeTranscript, codexRollout } from "./helpers/transcript.ts";

const TOKEN = "e".repeat(64);
const HOST = "127.0.0.1:7317";
const MIN = 60_000;
const H = 60 * MIN;
// 2026-10-02（金）09:00 JST
const T0 = Date.UTC(2026, 9, 2, 0, 0);
const SID = "77777777-0000-4000-8000-000000000001";
const SID2 = "77777777-0000-4000-8000-000000000002";

let env: AiEnv;
afterEach(async () => {
  await env?.cleanup();
});

function setup(o: { launch?: boolean } = {}) {
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
  const sys = new FakeLaunchSystem();
  sys.installed = ["claude_code", "codex"];
  sys.paths.add("/w/app");
  sys.reply((_c, a) => a[0] === "symbolic-ref", { ok: true, out: "origin/main" });
  const launch = o.launch
    ? new LaunchService({
        sqlite: env.sqlite,
        mutate: env.mutate,
        clock: env.clock,
        sys,
        open: env.open,
        cliPath: "/u/.local/bin/turnlane",
        home: env.home,
        terminal: () => ({ id: "iterm", name: "iTerm2", path: "/Applications/iTerm.app" }),
        locale: () => "ja",
        logger: nullLogger,
        onChanged: () => {},
        publish: () => {},
      })
    : null;
  if (launch) env.ai.setLiveLaunches(() => launch.liveLaunches());
  const app = createApp({
    token: TOKEN,
    port: 7317,
    hub: env.hub,
    health: () => ({}) as never,
    admin: { backup: () => ({ date: "", path: "" }) },
    ai: () => env.ai.deps,
    planner: () => planner,
    ...(launch ? { launch: () => launch } : {}),
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
  const live = async () => (await call<AiLiveResponse>("GET", "/api/ai/live")).body;
  const root = join(env.home, ".claude");
  const spool = join(env.dataDir, "spool");
  mkdirSync(spool, { recursive: true });
  const hooks: string[] = [];
  const hook = (sid: string, name: string, at: number) => {
    hooks.push(
      JSON.stringify({
        v: 1,
        tool: "claude_code",
        received_at: at,
        config_root: root,
        hook_event_name: name,
        session_id: sid,
      }),
    );
    writeFileSync(join(spool, "hooks-20261002.jsonl"), `${hooks.join("\n")}\n`);
  };
  return { call, live, root, launch, sys, hook };
}

/** Claude Code のプロセスの確かめ（probeLive の結果の代わり） */
function probed(status: "idle" | "busy" | "gone", at: number, sid = SID): void {
  env.sqlite.run(
    "UPDATE ai_session SET live_status = ?, live_pid = 4242, live_checked_at = ? WHERE external_id = ?",
    [status, at, sid],
  );
}

const byBranch = (r: AiLiveResponse, branch: string): LiveItem | undefined =>
  r.items.find((x) => x.branch === branch);

describe("GET /api/ai/live", () => {
  test("running の項目は今のひと続きの作業の始まりつき（30 分未満の間はつなぐ）", async () => {
    const s = setup();
    const tr = claudeTranscript(s.root, { sid: SID, cwd: "/w/app", branch: "feat/run" });
    tr.human(T0);
    s.hook(SID, "UserPromptSubmit", T0);
    tr.assistantEnd(T0 + 20 * MIN, "Done.", { durationMs: 20 * MIN });
    s.hook(SID, "Stop", T0 + 20 * MIN + 100);
    tr.human(T0 + 35 * MIN);
    s.hook(SID, "UserPromptSubmit", T0 + 35 * MIN);
    env.clock.set(T0 + 45 * MIN);
    await env.sync();
    const r = await s.live();
    expect(r.today).toBe("2026-10-02");
    const x = byBranch(r, "feat/run");
    expect(x).toMatchObject({ status: "running", runStartedAt: T0, launch: null });
    expect(x?.sources).toEqual([{ tool: "claude_code", profile: null }]);
  });

  test("Claude Code: プロセスが動いている間だけ出る（確かめが古い・終わったら出ない）。数も返す", async () => {
    const s = setup();
    const a = claudeTranscript(s.root, { sid: SID, cwd: "/w/app", branch: "feat/live" });
    a.human(T0);
    a.assistantEnd(T0 + 10 * MIN, "Done.", { durationMs: 10 * MIN });
    env.clock.set(T0 + 3 * H);
    await env.sync();
    // 終わっていてプロセスも分からない（probe の結果が無い）→ 出ない
    expect(byBranch(await s.live(), "feat/live")).toBeUndefined();
    probed("idle", T0 + 3 * H - 5_000);
    expect(byBranch(await s.live(), "feat/live")).toMatchObject({
      status: "done",
      process: "alive",
      liveSessions: 1,
    });
    // 確かめが 2 分より古い
    env.clock.set(T0 + 3 * H + 3 * MIN);
    expect(byBranch(await s.live(), "feat/live")).toBeUndefined();
    // 終わった
    probed("gone", T0 + 3 * H + 3 * MIN);
    expect(byBranch(await s.live(), "feat/live")).toBeUndefined();
  });

  test("同じブランチに生きたセッションが 2 つ → liveSessions 2（行は 1 つ）", async () => {
    const s = setup();
    for (const sid of [SID, SID2]) {
      const w = claudeTranscript(s.root, { sid, cwd: "/w/app", branch: "feat/two" });
      w.human(T0);
      w.assistantEnd(T0 + 5 * MIN, "Done.", { durationMs: 5 * MIN });
    }
    env.clock.set(T0 + 30 * MIN);
    await env.sync();
    probed("idle", T0 + 30 * MIN, SID);
    probed("busy", T0 + 30 * MIN, SID2);
    const xs = (await s.live()).items.filter((x) => x.branch === "feat/two");
    expect(xs).toHaveLength(1);
    expect(xs[0]).toMatchObject({ process: "alive", liveSessions: 2 });
  });

  test("Codex: プロセスが分からないので最後の動きから 6 時間だけ unknown で出る", async () => {
    const s = setup();
    const c = codexRollout(join(env.home, ".codex"), {
      sid: SID,
      cwd: "/w/app",
      at: T0,
      originator: "codex_cli_rs",
    });
    c.turn(T0 + MIN, T0 + 20 * MIN, "Here are the changes.");
    env.clock.set(T0 + 2 * H);
    await env.sync();
    const x = (await s.live()).items.find((i) => i.sources.some((b) => b.tool === "codex"));
    expect(x).toMatchObject({ process: "unknown", liveSessions: 0, status: "done" });
    expect(x?.lastActivityAt).toBeLessThanOrEqual(T0 + 20 * MIN + 1000);
    env.clock.set((x?.lastActivityAt ?? 0) + 6 * H + 1);
    expect(
      (await s.live()).items.find((i) => i.sources.some((b) => b.tool === "codex")),
    ).toBeUndefined();
  });

  test("サブエージェントは行にせず、親の項目に今も動いている数（最後の活動から 5 分）", async () => {
    const s = setup();
    const opts = { sid: SID, cwd: "/w/app", branch: "feat/agents" };
    const parent = claudeTranscript(s.root, opts);
    parent.human(T0);
    const sub1 = claudeSubagent(parent.path, { ...opts, agentId: "a1", start: T0 + MIN });
    const sub2 = claudeSubagent(parent.path, { ...opts, agentId: "a2", start: T0 + 2 * MIN });
    sub1.activity(T0 + 8 * MIN);
    sub2.activity(T0 + 3 * MIN);
    env.clock.set(T0 + 9 * MIN);
    await env.sync();
    const xs = (await s.live()).items;
    expect(xs.filter((x) => x.branch === "feat/agents")).toHaveLength(1);
    // a2 は 6 分前が最後なので数えない
    expect(byBranch({ items: xs } as AiLiveResponse, "feat/agents")).toMatchObject({
      status: "running",
      subagentsRunning: 1,
    });
  });

  test("隠した項目は出さない", async () => {
    const s = setup();
    const tr = claudeTranscript(s.root, { sid: SID, cwd: "/w/app", branch: "feat/hide" });
    tr.human(T0);
    s.hook(SID, "UserPromptSubmit", T0);
    env.clock.set(T0 + 5 * MIN);
    await env.sync();
    const id = byBranch(await s.live(), "feat/hide")?.id ?? "";
    expect(id).not.toBe("");
    const p = await s.call("PATCH", `/api/work-items/${id}`, { hidden: true });
    expect(p.status).toBe(200);
    expect(byBranch(await s.live(), "feat/hide")).toBeUndefined();
  });

  test("片付けが残っている起動: AI が終わっても worktree が残れば launch つきで出る。タスクの完了も返す", async () => {
    const s = setup({ launch: true });
    const t = await s.call<{ task: TaskView }>("POST", "/api/tasks", {
      title: "Fix the lanes",
      date: "2026-10-02",
    });
    const r = await s.call<AiLaunchResult>("POST", "/api/ai/launches", {
      taskId: t.body.task.id,
      repo: "/w/app",
      tool: "claude_code",
      worktree: true,
    });
    const wt = r.body.worktreePath as string;
    await s.call("POST", `/api/ai/launches/${r.body.launchId}/claim`);
    const uuid = env.sqlite
      .query<{ u: string }, []>("SELECT session_uuid AS u FROM ai_launch")
      .get()?.u as string;
    env.git.repos.set(wt, "/w/app");
    const tr = claudeTranscript(s.root, { sid: uuid, cwd: wt, branch: r.body.branch ?? "b" });
    tr.human(T0 + MIN);
    tr.assistantEnd(T0 + 10 * MIN, "Done.", { durationMs: 9 * MIN });
    env.clock.set(T0 + 7 * H);
    await env.sync();
    s.launch?.tick();
    const x = (await s.live()).items.find((i) => i.launch !== null);
    expect(x).toMatchObject({
      status: "done",
      process: "gone",
      launch: {
        launchId: r.body.launchId,
        taskId: t.body.task.id,
        taskDone: false,
        aiRunning: false,
        worktree: { path: wt, state: "clean" },
      },
    });
    // 片付けずに完了（タスクだけ完了）→ 起動は残り、taskDone が true（15 秒の覚えを越えてから読む）
    const done = await s.call("POST", `/api/tasks/${t.body.task.id}/complete`);
    expect(done.status).toBe(200);
    env.clock.set(T0 + 7 * H + 20_000);
    expect((await s.live()).items.find((i) => i.launch !== null)?.launch?.taskDone).toBe(true);
  });
});
