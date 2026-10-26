/**
 * タスクから AI に頼む（D-107・D-109 の無料の部分。plan §B）の結合テスト。端末・git・CLI・gh は偽物（起動した引数を記録する）。
 * worktree の作成と片付けは、一時ディレクトリの本物の git でも確かめる。実際の claude / codex は起動しない。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nullLogger } from "@turnlane/collectors";
import {
  type ConfigKey,
  claudeConfigFile,
  folderTrust,
  putSetting,
  trustKeys,
  unlinkedReason,
  validateConfig,
} from "@turnlane/core";
import type {
  AiLaunchClaim,
  AiLaunchOptions,
  AiLaunchResult,
  BoardResponse,
  TaskView,
  WorkCheckView,
  WorktreeCleanupResult,
} from "@turnlane/core/api";
import { createApp } from "../src/http/app.ts";
import { LaunchService } from "../src/launch/service.ts";
import {
  gitRootsOf,
  SystemLaunch,
  screenLockedFromIoreg,
  trustFlagsFrom,
} from "../src/launch/system.ts";
import {
  GHOSTTY_RUN,
  planLaunch,
  runCommand,
  TERMINAL_RUN,
  unattendedWaitsWhileLocked,
  wrapsInTmux,
} from "../src/launch/terminal.ts";
import { orcaCli } from "../src/open/orca.ts";
import { loadTarget } from "../src/open/target.ts";
import { createPlanner } from "../src/planner/index.ts";
import { type AiEnv, makeAiEnv, present } from "./helpers/env.ts";
import { FakeLaunchSystem } from "./helpers/launch-system.ts";
import { claudeTranscript } from "./helpers/transcript.ts";

const TOKEN = "d".repeat(64);
const HOST = "127.0.0.1:7317";
const MIN = 60_000;
const T0 = Date.UTC(2026, 8, 14, 1, 0); // 10:00 JST
const OSA = "/usr/bin/osascript";
const CLI = "/u/.local/bin/turnlane";
/** Ghostty の版と設定を読むコマンド（open/ghostty.ts。偽の OS の capture のキー） */
const GHOSTTY_VERSION_CMD =
  "/usr/bin/plutil -extract CFBundleShortVersionString raw -o - /Applications/Ghostty.app/Contents/Info.plist";
const GHOSTTY_CONFIG_CMD = "/Applications/Ghostty.app/Contents/MacOS/ghostty +show-config";

let env: AiEnv;
let tmp: string | null = null;
afterEach(async () => {
  await env?.cleanup();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

const q = <T>(sql: string, ...args: (string | number)[]) =>
  env.sqlite.query<T, (string | number)[]>(sql).all(...args);

/** 非同期で走る片付け・テストの終わりを待つ */
async function until(f: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !f(); i++) await Bun.sleep(10);
}
const cleanedAt = () => q<{ c: number | null }>("SELECT cleaned_at AS c FROM ai_launch")[0]?.c;

async function setup(
  o: {
    sys?: FakeLaunchSystem;
    repo?: string;
    terminal?: { id: string; name: string; path: string };
  } = {},
) {
  env = makeAiEnv({ now: T0 });
  const repo = o.repo ?? "/w/app";
  env.git.repos.set(repo, repo);
  env.git.defaults.set(repo, "main");
  env.open.files.add("/Applications/Ghostty.app");
  const sys = o.sys ?? new FakeLaunchSystem();
  sys.paths.add(repo);
  sys.reply((_c, a) => a[0] === "symbolic-ref" && a.at(-1) === "refs/remotes/origin/HEAD", {
    ok: true,
    out: "origin/main",
  });
  const planner = createPlanner({
    sqlite: env.sqlite,
    mutate: env.mutate,
    clock: env.clock,
    hub: env.hub,
    ai: env.ai,
  });
  const launch = new LaunchService({
    sqlite: env.sqlite,
    mutate: env.mutate,
    clock: env.clock,
    sys,
    open: env.open,
    cliPath: CLI,
    home: env.home,
    terminal: () =>
      o.terminal ?? { id: "ghostty", name: "Ghostty", path: "/Applications/Ghostty.app" },
    locale: () => "ja",
    logger: nullLogger,
    onChanged: () => env.ai.runner.schedule(0),
    publish: (type, data) => env.hub.publish(type, data),
  });
  planner.tasks.onCompleted = (id) => void launch.onTaskCompleted(id);
  const app = createApp({
    token: TOKEN,
    port: 7317,
    hub: env.hub,
    health: () => ({}) as never,
    admin: { backup: () => ({ date: "", path: "" }) },
    ai: () => env.ai.deps,
    planner: () => planner,
    launch: () => launch,
  });
  const call = async <T>(
    method: string,
    path: string,
    body?: unknown,
    auth: "bearer" | "none" = "bearer",
  ) => {
    const r = await app.request(`http://${HOST}${path}`, {
      method,
      headers: {
        host: HOST,
        ...(auth === "bearer" ? { authorization: `Bearer ${TOKEN}` } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, body: (await r.json()) as T };
  };
  // プロジェクト（リポジトリとテストのコマンド）とタスク
  const p = await call<{ project: { id: string } }>("POST", "/api/projects", {
    name: "app",
    repoPaths: [repo],
  });
  env.sqlite.run("UPDATE project SET test_command = 'bun test' WHERE id = ?", [p.body.project.id]);
  const t = await call<{ task: TaskView }>("POST", "/api/tasks", {
    title: "Fix the day view lanes",
    date: "2026-09-14",
    projectId: p.body.project.id,
  });
  await call("PATCH", `/api/tasks/${t.body.task.id}`, { notes: "レーンの幅を直す" });
  return { call, sys, launch, planner, taskId: t.body.task.id, repo };
}

const taskOf = async (
  call: Awaited<ReturnType<typeof setup>>["call"],
  id: string,
): Promise<TaskView> => (await call<{ task: TaskView }>("GET", `/api/tasks/${id}`)).body.task;

describe("依頼のポップオーバーの選択肢", () => {
  test("リポジトリはタスクのプロジェクトのもの、ツールは入っているものだけ（Codex が無ければ出さない）、型は組み込みの4つ", async () => {
    const { call, taskId } = await setup();
    const r = await call<AiLaunchOptions>("GET", `/api/ai/launch-options?taskId=${taskId}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      repos: [{ path: "/w/app", name: "app", git: true, worktreeDefault: true }],
      defaultRepo: "/w/app",
      tools: ["claude_code"],
      defaultTool: "claude_code",
      defaultTemplateId: "builtin:implement",
      terminal: "Ghostty",
    });
    expect(r.body.templates.map((t) => t.name)).toEqual([
      "実装する",
      "調べてまとめる（読み取りのみ）",
      "テストを書く",
      "PR をレビューする（読み取りのみ）",
    ]);
  });

  test("前回選んだツールと型を既定にする（入っていなければ入っている最初のもの）", async () => {
    const { call, taskId, sys } = await setup();
    sys.installed = ["claude_code", "codex"];
    putSetting(env.mutate, "ai.last_launch", { tool: "codex", templateId: "builtin:tests" });
    const r = await call<AiLaunchOptions>("GET", `/api/ai/launch-options?taskId=${taskId}`);
    expect(r.body).toMatchObject({ defaultTool: "codex", defaultTemplateId: "builtin:tests" });
    sys.installed = ["claude_code"];
    const r2 = await call<AiLaunchOptions>("GET", `/api/ai/launch-options?taskId=${taskId}`);
    expect(r2.body.defaultTool).toBe("claude_code");
  });
});

describe("依頼 → 端末 → turnlane ai run", () => {
  test("worktree を作り、Ghostty の新しいタブで turnlane ai run <起動 ID> を実行させる。題名・メモは端末に渡さない", async () => {
    const { call, taskId, sys } = await setup();
    const r = await call<AiLaunchResult>("POST", "/api/ai/launches", {
      taskId,
      repo: "/w/app",
      tool: "claude_code",
      worktree: true,
      instruction: "テストも直して",
    });
    expect(r.status).toBe(200);
    const id = r.body.launchId;
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(r.body).toMatchObject({ outcome: "opened", app: "Ghostty", command: null });
    const branch = r.body.branch as string;
    expect(branch).toMatch(/^tl\/fix-the-day-view-lanes-\d{4}$/);
    const wt = `/w/app-wt/${branch.replace("/", "-")}`;
    expect(r.body.worktreePath).toBe(wt);
    expect(r.body.cwd).toBe(wt);
    expect(sys.gitCalls.find((c) => c.args[0] === "worktree")).toEqual({
      cwd: "/w/app",
      args: ["worktree", "add", wt, "-b", branch, "origin/main"],
    });
    expect(env.open.runs).toEqual([[OSA, "-e", GHOSTTY_RUN, wt, `${CLI} ai run ${id}`]]);
    const typed = env.open.runs.flat().join(" ");
    expect(typed).not.toContain("Fix the day view");
    expect(typed).not.toContain("レーン");
    // 入力するコマンドに改行は無い（実行の改行は AppleScript が足す）
    expect(env.open.runs[0]?.[4]).not.toMatch(/[\r\n]/);
    // ブラウザ（Bearer なし）からは受け取れない
    const denied = await call("POST", `/api/ai/launches/${id}/claim`, undefined, "none");
    expect(denied.status).toBe(401);
    const c = await call<AiLaunchClaim>("POST", `/api/ai/launches/${id}/claim`);
    expect(c.status).toBe(200);
    const uuid = q<{ session_uuid: string }>("SELECT session_uuid FROM ai_launch")[0]?.session_uuid;
    expect(uuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(c.body).toEqual({
      cwd: wt,
      argv: [
        "claude",
        "--session-id",
        uuid as string,
        "-n",
        "Fix the day view lanes",
        // Claude の利用枠の受け口（本体が起動するセッションにだけ。m2-api 28章）
        "--settings",
        JSON.stringify({ statusLine: { type: "command", command: `${CLI} statusline` } }),
        "タスク: Fix the day view lanes\n\nレーンの幅を直す\n\n終わったら変更点を3行でまとめてください。\n\nテストも直して",
      ],
      env: { TURNLANE_LAUNCH_ID: id },
    });
    // 1回だけ
    expect((await call("POST", `/api/ai/launches/${id}/claim`)).status).toBe(409);
    // プロンプト・指示は DB に残さない
    const dump = JSON.stringify(q("SELECT * FROM ai_launch"));
    expect(dump).not.toContain("テストも直して");
    expect(dump).not.toContain("レーンの幅");
    expect((await taskOf(call, taskId)).ai).toMatchObject({ state: "starting", launchId: id });
  });

  test("worktree なし・読み取りのみの型・Codex: リポジトリで起動し、-s read-only", async () => {
    const { call, taskId, sys } = await setup();
    sys.installed = ["claude_code", "codex"];
    sys.reply((_c, a) => a[0] === "rev-parse" && a[1] === "--abbrev-ref", {
      ok: true,
      out: "main",
    });
    const r = await call<AiLaunchResult>("POST", "/api/ai/launches", {
      taskId,
      repo: "/w/app",
      tool: "codex",
      templateId: "builtin:research",
      worktree: false,
    });
    expect(r.body).toMatchObject({ worktreePath: null, cwd: "/w/app", branch: "main" });
    expect(sys.gitCalls.some((c) => c.args[0] === "worktree")).toBe(false);
    const c = await call<AiLaunchClaim>("POST", `/api/ai/launches/${r.body.launchId}/claim`);
    expect(c.body.argv.slice(0, 5)).toEqual(["codex", "-C", "/w/app", "-s", "read-only"]);
  });

  test("送れない端末は tmux で包む（D-238）: AppleScript の使えない Ghostty・Warp・コピーは tmux の新しいセッション、iTerm2・Terminal（D-243）・Orca・Ghostty 1.3（D-244）は包まない", () => {
    const id = "b".repeat(32);
    const TM = "/opt/homebrew/bin/tmux";
    const wrapped = `env -u TMUX ${TM} new-session -s turnlane-bbbbbbbb -c /w/r ${CLI} ai run ${id}`;
    const g = planLaunch(
      { id: "ghostty", name: "Ghostty", path: "/Applications/Ghostty.app" },
      CLI,
      id,
      "/w/r",
      { tmux: TM, ghosttyScriptable: false },
    );
    expect(g[0]?.steps[0]?.argv).toEqual([OSA, "-e", GHOSTTY_RUN, "/w/r", wrapped]);
    expect(g[1]?.copy).toBe(`cd /w/r && ${wrapped}`);
    // Ghostty 1.3 以降で AppleScript が使える（答えられる）ときは包まない
    for (const ghosttyScriptable of [true]) {
      const g13 = planLaunch(
        { id: "ghostty", name: "Ghostty", path: "/Applications/Ghostty.app" },
        CLI,
        id,
        "/w/r",
        { tmux: TM, ghosttyScriptable },
      );
      expect(g13[0]?.steps[0]?.argv).toEqual([
        OSA,
        "-e",
        GHOSTTY_RUN,
        "/w/r",
        `${CLI} ai run ${id}`,
      ]);
    }
    const GH = { id: "ghostty", name: "Ghostty", path: "/x" };
    expect(wrapsInTmux(GH, false)).toBe(true);
    expect(wrapsInTmux(GH, true)).toBe(false);
    // 判定できなければ包む（D-244）
    expect(wrapsInTmux(GH, null)).toBe(true);
    expect(wrapsInTmux(GH)).toBe(true);
    expect(wrapsInTmux({ id: "warp", name: "Warp", path: "/x" }, true)).toBe(true);
    const t = planLaunch(
      { id: "terminal", name: "Terminal", path: "/System/Applications/Utilities/Terminal.app" },
      CLI,
      id,
      "/w/r",
      { tmux: TM },
    );
    expect(t[0]?.steps[0]?.argv.at(-1)).toBe(`cd /w/r && ${CLI} ai run ${id}`);
    const w = planLaunch(
      { id: "warp", name: "Warp", path: "/Applications/Warp.app" },
      CLI,
      id,
      "/w/r",
      { tmux: TM },
    );
    expect(w.flatMap((a) => (a.copy ? [a.copy] : []))).toContain(`cd /w/r && ${wrapped}`);
    expect(wrapsInTmux({ id: "terminal", name: "Terminal", path: "/x" })).toBe(false);
    expect(wrapsInTmux({ id: "kitty", name: "kitty", path: "/x" })).toBe(true);
    expect(wrapsInTmux(null)).toBe(true);
    expect(planLaunch(null, CLI, id, "/w/r", { tmux: TM })[0]?.copy).toBe(`cd /w/r && ${wrapped}`);
    const i = planLaunch(
      { id: "iterm", name: "iTerm2", path: "/Applications/iTerm.app" },
      CLI,
      id,
      "/w/r",
      { tmux: TM },
    );
    expect(i[0]?.steps[0]?.argv.at(-1)).toBe(`cd /w/r && ${CLI} ai run ${id}`);
    const orca = planLaunch(
      { id: "orca", name: "Orca", path: "/Applications/Orca.app" },
      CLI,
      id,
      "/w/r",
      { tmux: TM },
    );
    expect(orca.flatMap((a) => a.steps.flatMap((s) => s.argv)).join(" ")).not.toContain("tmux");
    // tmux の名前・フォルダはシェルを通るのでクォートする
    expect(runCommand(CLI, id, null, "/x y/tmux", "/w/my app")).toBe(
      `env -u TMUX '/x y/tmux' new-session -s turnlane-bbbbbbbb -c '/w/my app' ${CLI} ai run ${id}`,
    );
  });

  test("送れない端末を tmux で包む: tmux が入っていて設定がオンのときだけ（launch.tmux_wrap）。Ghostty は AppleScript が使えないと分かったときだけ（D-244）", async () => {
    const { call, taskId, sys } = await setup();
    sys.paths.add("/opt/homebrew/bin/tmux");
    // 設定の端末は Ghostty。1.3 より古い（AppleScript の口が無い）と分かれば包む
    env.open.outputs.set(GHOSTTY_VERSION_CMD, "1.2.3\n");
    const r = await call<AiLaunchResult>("POST", "/api/ai/launches", {
      taskId,
      repo: "/w/app",
      tool: "claude_code",
      worktree: false,
    });
    const id = r.body.launchId as string;
    expect(env.open.runs.at(-1)?.at(-1)).toBe(
      `env -u TMUX /opt/homebrew/bin/tmux new-session -s turnlane-${id.slice(0, 8)} -c /w/app ${CLI} ai run ${id}`,
    );
    putSetting(env.mutate, "launch.tmux_wrap", false);
    const r2 = await call<AiLaunchResult>("POST", "/api/ai/launches", {
      taskId,
      repo: "/w/app",
      tool: "claude_code",
      worktree: false,
    });
    expect(env.open.runs.at(-1)?.at(-1)).toBe(`${CLI} ai run ${r2.body.launchId}`);
    // 1.3 以降で AppleScript を切っていなければ包まない。macos-applescript = false なら包む（判定は 1 分覚える）
    putSetting(env.mutate, "launch.tmux_wrap", true);
    const launch = async () =>
      (
        await call<AiLaunchResult>("POST", "/api/ai/launches", {
          taskId,
          repo: "/w/app",
          tool: "claude_code",
          worktree: false,
        })
      ).body.launchId as string;
    env.open.outputs.set(GHOSTTY_VERSION_CMD, "1.3.1\n");
    env.open.outputs.set(GHOSTTY_CONFIG_CMD, "font-size = 13\n");
    env.clock.set(env.clock.now() + 2 * 60_000);
    const r3 = await launch();
    expect(env.open.runs.at(-1)?.at(-1)).toBe(`${CLI} ai run ${r3}`);
    env.open.outputs.set(GHOSTTY_CONFIG_CMD, "font-size = 13\nmacos-applescript = false\n");
    env.clock.set(env.clock.now() + 2 * 60_000);
    const r4 = await launch();
    expect(env.open.runs.at(-1)?.at(-1)).toContain(`new-session -s turnlane-${r4.slice(0, 8)}`);
    // 判定できない（版も設定も読めない）なら包む（D-244）
    env.open.outputs.delete(GHOSTTY_VERSION_CMD);
    env.open.outputs.delete(GHOSTTY_CONFIG_CMD);
    env.clock.set(env.clock.now() + 2 * 60_000);
    const r5 = await launch();
    expect(env.open.runs.at(-1)?.at(-1)).toContain(`new-session -s turnlane-${r5.slice(0, 8)}`);
  });

  test("Ghostty の AppleScript が拒否された → 開いてコピー。端末が無ければコピーだけ", () => {
    const id = "a".repeat(32);
    const plan = planLaunch(
      { id: "ghostty", name: "Ghostty", path: "/Applications/Ghostty.app" },
      CLI,
      id,
      "/w/my app",
    );
    expect(plan.map((p) => p.outcome)).toEqual(["typed", "opened_copied", "copied"]);
    expect(plan[1]?.copy).toBe(`cd '/w/my app' && ${CLI} ai run ${id}`);
    const term = planLaunch(
      { id: "terminal", name: "Terminal", path: "/System/Applications/Utilities/Terminal.app" },
      "/Users/a b/turnlane",
      id,
      "/w/r",
    );
    expect(term[0]?.steps[0]?.argv).toEqual([
      OSA,
      "-e",
      TERMINAL_RUN,
      `cd /w/r && '/Users/a b/turnlane' ai run ${id}`,
    ]);
    expect(planLaunch(null, CLI, id, "/w/r").map((p) => p.outcome)).toEqual(["copied"]);
    expect(() => runCommand(CLI, "x; rm -rf /", null)).toThrow();
  });

  test("ツールが入っていない・タスクが無い・リポジトリが相対パス → 409 / 404 / 400", async () => {
    const { call, taskId } = await setup();
    const base = { taskId, repo: "/w/app", worktree: false };
    expect((await call("POST", "/api/ai/launches", { ...base, tool: "codex" })).body).toEqual({
      error: "tool_missing",
    });
    expect(
      (await call("POST", "/api/ai/launches", { ...base, tool: "claude_code", taskId: "nope" }))
        .status,
    ).toBe(404);
    expect(
      (await call("POST", "/api/ai/launches", { ...base, tool: "claude_code", repo: "w/app" }))
        .status,
    ).toBe(400);
  });

  test("2分のうちに受け取られなければ failed（not_claimed）", async () => {
    const { call, taskId, launch } = await setup();
    const r = await call<AiLaunchResult>("POST", "/api/ai/launches", {
      taskId,
      repo: "/w/app",
      tool: "claude_code",
      worktree: false,
    });
    env.clock.set(T0 + 3 * MIN);
    expect(launch.tick()).toBe(1);
    expect((await taskOf(call, taskId)).ai).toMatchObject({
      state: "failed",
      failReason: "not_claimed",
    });
    expect((await call("POST", `/api/ai/launches/${r.body.launchId}/claim`)).status).toBe(409);
  });
});

describe("紐づけと状態（plan §B.2）", () => {
  async function launched() {
    const s = await setup();
    const r = await s.call<AiLaunchResult>("POST", "/api/ai/launches", {
      taskId: s.taskId,
      repo: "/w/app",
      tool: "claude_code",
      worktree: true,
    });
    await s.call("POST", `/api/ai/launches/${r.body.launchId}/claim`);
    const uuid = q<{ session_uuid: string }>("SELECT session_uuid FROM ai_launch")[0]
      ?.session_uuid as string;
    const wt = r.body.worktreePath as string;
    env.git.repos.set(wt, "/w/app");
    env.git.branches.set(wt, r.body.branch as string);
    const tr = claudeTranscript(join(env.home, ".claude"), {
      sid: uuid,
      cwd: wt,
      branch: r.body.branch as string,
    });
    return { ...s, r: r.body, tr, wt };
  }

  test("Claude Code は --session-id で紐づく。質問で止まった自分の番は新しいタスクを作らず、頼んだタスクに付く", async () => {
    const { call, launch, taskId, tr } = await launched();
    present(env.sqlite, T0 - 60 * MIN, T0 + 120 * MIN);
    tr.human(T0 + MIN);
    env.clock.set(T0 + 2 * MIN);
    await env.sync();
    expect(launch.tick()).toBe(1);
    env.ai.runner.runOnce();
    expect((await taskOf(call, taskId)).ai).toMatchObject({ state: "running" });
    tr.assistantEnd(T0 + 5 * MIN, "どちらにしますか？");
    env.clock.set(T0 + 25 * MIN);
    await env.sync();
    const fus = q<{ task_id: string; kind: string }>("SELECT task_id, kind FROM follow_up");
    expect(fus).toEqual([{ task_id: taskId, kind: "reply" }]);
    expect(q<{ n: number }>("SELECT count(*) AS n FROM task")[0]?.n).toBe(1);
    const t = await taskOf(call, taskId);
    expect(t.ai).toMatchObject({ state: "your_turn" });
    expect(t.followUpId).not.toBeNull();
    // ボードでは帯に出ている間、Unscheduled に2枚並ばない
    const b = await call<BoardResponse>("GET", "/api/board?from=2026-09-14&to=2026-09-14");
    expect(b.body.days[0]?.tasks.map((x) => x.id)).toEqual([]);
    // 自分の番を済ませても、頼んだタスクは閉じない
    const fuId = t.followUpId as string;
    await call("POST", `/api/follow-ups/${fuId}/complete`);
    const after = await taskOf(call, taskId);
    expect(after.status).toBe("todo");
    expect(after.followUpId).toBeNull();
  });

  test("質問・許可・エラーなしで終わった → AI 完了 · 確認（done_check）。そこから待ち（放置）を数える", async () => {
    const { call, launch, taskId, tr } = await launched();
    present(env.sqlite, T0 - 60 * MIN, T0 + 120 * MIN);
    tr.human(T0 + MIN);
    tr.assistantEnd(T0 + 5 * MIN, "終わりました。");
    env.clock.set(T0 + 50 * MIN);
    await env.sync();
    launch.tick();
    env.ai.runner.runOnce();
    expect((await taskOf(call, taskId)).ai).toMatchObject({ state: "done_check" });
    const segs = q<{ kind: string; ms: number }>(
      "SELECT kind, SUM(end_at - start_at) AS ms FROM ai_wait_segment GROUP BY kind ORDER BY kind",
    );
    expect(segs.map((x) => x.kind)).toEqual(["grace", "idle"]);
    expect(segs[0]?.ms).toBe(15 * MIN);
    // ターンの終わりは記録の最後の行（数百ミリ秒の差）
    expect(Math.round((segs[1]?.ms ?? 0) / MIN)).toBe(30);
  });

  test("タスクを完了 → 開いている自分の番も閉じ、clean で取り込み済みの worktree は片付ける", async () => {
    const { call, launch, taskId, tr, sys, wt, r } = await launched();
    tr.human(T0 + MIN);
    tr.assistantEnd(T0 + 5 * MIN, "終わりました。");
    env.clock.set(T0 + 10 * MIN);
    await env.sync();
    launch.tick();
    sys.reply((_c, a) => a[0] === "rev-list" && a[1] === "--count", { ok: true, out: "0" });
    await call("POST", `/api/tasks/${taskId}/complete`);
    await until(() => !!cleanedAt());
    expect(sys.gitCalls.filter((c) => c.args[0] === "worktree" && c.args[1] === "remove")).toEqual([
      { cwd: "/w/app", args: ["worktree", "remove", wt] },
    ]);
    expect(sys.gitCalls.at(-1)).toEqual({
      cwd: "/w/app",
      args: ["branch", "-d", r.branch as string],
    });
    expect(q<{ c: number | null }>("SELECT cleaned_at AS c FROM ai_launch")[0]?.c).not.toBeNull();
  });

  test("開く先: 紐づいた依頼の worktree（差分ツールで開く先）。片付けたら無し", async () => {
    const { launch, tr, wt, r } = await launched();
    tr.human(T0 + MIN);
    tr.assistantEnd(T0 + 5 * MIN, "終わりました。");
    env.clock.set(T0 + 10 * MIN);
    await env.sync();
    launch.tick();
    const wi = q<{ id: string }>("SELECT id FROM work_item")[0]?.id as string;
    env.open.dirs.add("/w/app");
    env.open.dirs.add(wt);
    expect(loadTarget(env.sqlite, env.open, { workItemId: wi }, T0 + 10 * MIN)).toMatchObject({
      folder: "/w/app",
      worktree: wt,
    });
    // 捨てる（拡張の launcher.discard と同じ強制の片付け）: worktree と手元のブランチだけ
    const res = await launch.cleanup(r.launchId, true);
    expect(res.removed).toBe(true);
    expect(loadTarget(env.sqlite, env.open, { workItemId: wi }, T0 + 10 * MIN).worktree).toBeNull();
  });

  test("未コミットの変更がある worktree は消さずに残し、確認の後で強制で消す", async () => {
    const { call, taskId, sys, wt, r } = await launched();
    sys.reply((c, a) => c === wt && a[0] === "status", { ok: true, out: " M a.ts\n?? b.ts" });
    await call("POST", `/api/tasks/${taskId}/complete`);
    await Bun.sleep(10);
    expect(sys.gitCalls.some((c) => c.args[1] === "remove")).toBe(false);
    const soft = await call<WorktreeCleanupResult>(
      "POST",
      `/api/ai/launches/${r.launchId}/cleanup`,
      { force: false },
    );
    expect(soft.body).toEqual({ removed: false, reason: "dirty", uncommitted: 2 });
    const hard = await call<WorktreeCleanupResult>(
      "POST",
      `/api/ai/launches/${r.launchId}/cleanup`,
      { force: true },
    );
    expect(hard.body).toEqual({ removed: true, reason: null, uncommitted: 2 });
    expect(sys.gitCalls.slice(-2).map((c) => c.args)).toEqual([
      ["worktree", "remove", "--force", wt],
      ["branch", "-D", r.branch as string],
    ]);
  });

  test("Codex は worktree（cwd）と時刻で紐づく。worktree なしで候補が複数なら unlinked にして選ばせる", async () => {
    const { call, taskId, launch, sys } = await setup();
    sys.installed = ["codex"];
    const src = "src-codex";
    env.sqlite.run(
      "INSERT INTO ai_source (id, tool, root_path, created_at, updated_at) VALUES (?, 'codex', '/h/.codex', 0, 0)",
      [src],
    );
    const sess = (id: string, cwd: string, at: number) =>
      env.sqlite.run(
        "INSERT INTO ai_session (id, source_id, tool, external_id, cwd, started_at, last_activity_at, created_at, updated_at) VALUES (?, ?, 'codex', ?, ?, ?, ?, 0, 0)",
        [id, src, `ext-${id}`, cwd, at, at],
      );
    const r = await call<AiLaunchResult>("POST", "/api/ai/launches", {
      taskId,
      repo: "/w/app",
      tool: "codex",
      worktree: false,
    });
    await call("POST", `/api/ai/launches/${r.body.launchId}/claim`);
    sess("s-a", "/w/app", T0 + 20_000);
    sess("s-b", "/w/app", T0 + 40_000);
    env.clock.set(T0 + MIN);
    launch.tick();
    expect((await taskOf(call, taskId)).ai?.state).toBe("unlinked");
    const cands = await call<{ sessionId: string }[]>(
      "GET",
      `/api/ai/launches/${r.body.launchId}/candidates`,
    );
    expect(cands.body.map((c) => c.sessionId)).toEqual(["s-b", "s-a"]);
    await call("POST", `/api/ai/launches/${r.body.launchId}/link`, { sessionId: "s-a" });
    expect(q<{ s: string }>("SELECT session_id AS s FROM ai_launch")[0]?.s).toBe("s-a");

    // worktree ありはその cwd の最初のセッション
    const t2 = await call<{ task: TaskView }>("POST", "/api/tasks", { title: "Second" });
    const r2 = await call<AiLaunchResult>("POST", "/api/ai/launches", {
      taskId: t2.body.task.id,
      repo: "/w/app",
      tool: "codex",
      worktree: true,
    });
    await call("POST", `/api/ai/launches/${r2.body.launchId}/claim`);
    sess("s-c", r2.body.worktreePath as string, T0 + MIN + 5_000);
    launch.tick();
    expect(
      q<{ s: string }>("SELECT session_id AS s FROM ai_launch WHERE id = ?", r2.body.launchId)[0]
        ?.s,
    ).toBe("s-c");
  });
});

describe("確認支援（plan §B.5）", () => {
  test("差分の量（作業ツリーまで）・未コミット・テスト（ボタン）・CI", async () => {
    const { call, taskId, sys } = await setup();
    const r = await call<AiLaunchResult>("POST", "/api/ai/launches", {
      taskId,
      repo: "/w/app",
      tool: "claude_code",
      worktree: true,
    });
    const wt = r.body.worktreePath as string;
    sys.reply((c, a) => c === wt && a[0] === "merge-base", { ok: true, out: "abc123" });
    sys.reply((c, a) => c === wt && a[0] === "diff", {
      ok: true,
      out: "10\t2\tapps/web/a.ts\n5\t1\tapps/web/b.ts\n1\t0\tREADME.md",
    });
    sys.reply((c, a) => c === wt && a[0] === "rev-list", { ok: true, out: "2" });
    sys.reply((c, a) => c === wt && a[0] === "status", { ok: true, out: " M x" });
    const c = await call<WorkCheckView>("GET", `/api/ai/check?launchId=${r.body.launchId}`);
    expect(c.body.diff).toEqual({
      base: "origin/main",
      files: 3,
      additions: 16,
      deletions: 3,
      commits: 2,
      uncommitted: 1,
      dirs: [
        { dir: "apps", files: 2 },
        { dir: ".", files: 1 },
      ],
    });
    expect(c.body.test).toMatchObject({ command: "bun test", state: "idle" });
    expect(c.body.worktree).toMatchObject({ path: wt, exists: true });
    const run = await call<{ state: string }>("POST", `/api/ai/launches/${r.body.launchId}/test`);
    expect(run.body.state).toBe("running");
    await until(() => q<{ t: number | null }>("SELECT test_ok AS t FROM ai_launch")[0]?.t != null);
    expect(sys.testCalls).toEqual([{ command: "bun test", cwd: wt }]);
    const after = await call<WorkCheckView>("GET", `/api/ai/check?launchId=${r.body.launchId}`);
    expect(after.body.test).toMatchObject({
      state: "passed",
      exitCode: 0,
      tail: ["12 pass", "0 fail"],
    });
    // DB には成否と時刻だけ
    expect(q("SELECT test_ok, test_at FROM ai_launch")).toEqual([{ test_ok: 1, test_at: T0 }]);
  });
});

describe("本物の git で worktree を作って片付ける", () => {
  test("worktree add → 変更なしでタスク完了 → worktree remove と branch -d", async () => {
    tmp = mkdtempSync(join(tmpdir(), "turnlane-wt-"));
    const repo = join(tmp, "app");
    mkdirSync(repo);
    const sh = (args: string[], cwd = repo) => {
      const p = Bun.spawnSync(["git", ...args], {
        cwd,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@example.invalid",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@example.invalid",
          GIT_CONFIG_GLOBAL: "/dev/null",
        },
      });
      if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
      return p.stdout.toString().trim();
    };
    sh(["init", "-q", "-b", "main"]);
    writeFileSync(join(repo, "a.txt"), "a\n");
    sh(["add", "a.txt"]);
    sh(["commit", "-q", "-m", "init"]);
    const real = new SystemLaunch({ home: tmp, shell: null, knownDirs: [] });
    const sys = new FakeLaunchSystem(real.git);
    sys.exists = (p) => real.exists(p);
    const { call, taskId } = await setup({ sys, repo });
    const r = await call<AiLaunchResult>("POST", "/api/ai/launches", {
      taskId,
      repo,
      tool: "claude_code",
      worktree: true,
    });
    expect(r.status).toBe(200);
    const wt = r.body.worktreePath as string;
    expect(wt).toBe(join(tmp, "app-wt", (r.body.branch as string).replace("/", "-")));
    expect(sh(["worktree", "list", "--porcelain"])).toContain(wt);
    expect(sh(["rev-parse", "--abbrev-ref", "HEAD"], wt)).toBe(r.body.branch as string);
    expect(q<{ b: string }>("SELECT base_ref AS b FROM ai_launch")[0]?.b).toBe("HEAD");
    await call("POST", `/api/tasks/${taskId}/complete`);
    // 片付けは完了の後に非同期で走る（branch -d の後に cleaned_at を入れる）
    await until(() => !!cleanedAt());
    expect(real.exists(wt)).toBe(false);
    expect(sh(["branch", "--list", r.body.branch as string])).toBe("");
  });
});

describe("差分の中身（拡張の review.diff）", () => {
  test("本物の git: ファイルごとの追加・削除（多い順）・未追跡のファイル名・抜粋（上限で切る）。範囲は check と同じ", async () => {
    tmp = mkdtempSync(join(tmpdir(), "turnlane-diff-"));
    const repo = join(tmp, "app");
    mkdirSync(repo);
    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
      GIT_CONFIG_GLOBAL: "/dev/null",
    };
    const sh = (args: string[], cwd = repo) => {
      const p = Bun.spawnSync(["git", ...args], { cwd, env: gitEnv });
      if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
      return p.stdout.toString().trim();
    };
    sh(["init", "-q", "-b", "main"]);
    writeFileSync(join(repo, "a.txt"), "one\ntwo\nthree\n");
    writeFileSync(join(repo, "big.txt"), "x\n");
    sh(["add", "."]);
    sh(["commit", "-q", "-m", "init"]);
    const real = new SystemLaunch({ home: tmp, shell: null, knownDirs: [] });
    const sys = new FakeLaunchSystem(real.git);
    sys.exists = (p) => real.exists(p);
    const { call, taskId, launch } = await setup({ sys, repo });
    const r = await call<AiLaunchResult>("POST", "/api/ai/launches", {
      taskId,
      repo,
      tool: "claude_code",
      worktree: true,
    });
    const wt = r.body.worktreePath as string;
    // コミット1つ（a.txt）と未コミットの変更（big.txt）と、まだ git に入れていない新しいファイル
    writeFileSync(join(wt, "a.txt"), "one\nTWO\nthree\nfour\n");
    sh(["commit", "-q", "-am", "edit a"], wt);
    writeFileSync(
      join(wt, "big.txt"),
      `${Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n")}\n`,
    );
    writeFileSync(join(wt, "new.txt"), "secret-free\n");
    const d = await launch.diff(r.body.launchId, { maxBytes: 2048 });
    expect(d).not.toBeNull();
    expect(d?.files).toEqual([
      { path: "big.txt", additions: 400, deletions: 1 },
      { path: "a.txt", additions: 2, deletions: 1 },
    ]);
    expect(d).toMatchObject({
      totalFiles: 3,
      additions: 402,
      deletions: 2,
      untracked: ["new.txt"],
    });
    expect(d?.excerpt).toContain("diff --git a/a.txt b/a.txt");
    expect(d?.excerpt).toContain("+TWO");
    expect(d?.excerpt).not.toContain("secret-free");
    expect(new TextEncoder().encode(d?.excerpt ?? "").length).toBeLessThanOrEqual(2048);
    expect(d?.truncated).toBe(true);
    // check の差分と同じ範囲（未コミットを含む）
    const c = await call<WorkCheckView>("GET", `/api/ai/check?launchId=${r.body.launchId}`);
    expect(c.body.diff).toMatchObject({ files: 2, additions: 402, deletions: 2, commits: 1 });
    // 捨てる: worktree と手元のブランチを消す（未コミットがあっても）
    const res = await launch.cleanup(r.body.launchId, true);
    expect(res.removed).toBe(true);
    expect(real.exists(wt)).toBe(false);
    expect(sh(["branch", "--list", r.body.branch as string])).toBe("");
    // 片付けた後は worktree が無く、ブランチも無いので分からない
    expect(await launch.diff(r.body.launchId)).toBeNull();
  });
});

describe("Claude のアカウント（D-122）", () => {
  /** 取り込みが ~/.claude と ~/.claude-acme を見つけた状態 */
  async function withAccounts(names = [".claude", ".claude-acme"]) {
    const s = await setup();
    for (const n of names) {
      mkdirSync(join(env.home, n, "projects"), { recursive: true });
      s.sys.paths.add(join(env.home, n));
    }
    await env.sync();
    const opts = async () =>
      (await s.call<AiLaunchOptions>("GET", `/api/ai/launch-options?taskId=${s.taskId}`)).body;
    const launchWith = async (body: Record<string, unknown>) =>
      s.call<AiLaunchResult | { error: string }>("POST", "/api/ai/launches", {
        taskId: s.taskId,
        repo: "/w/app",
        tool: "claude_code",
        worktree: false,
        ...body,
      });
    const claim = async (id: string) =>
      (await s.call<AiLaunchClaim>("POST", `/api/ai/launches/${id}/claim`)).body;
    return { ...s, opts, launchWith, claim };
  }

  test("選択肢は取り込みで見つけた設定ディレクトリ。名前はディレクトリ名から（~/.claude は null = 既定）", async () => {
    const { opts } = await withAccounts();
    const o = await opts();
    expect(o.claudeAccounts).toEqual([
      { path: join(env.home, ".claude"), name: null },
      { path: join(env.home, ".claude-acme"), name: "acme" },
    ]);
    expect(o.defaultClaudeAccount).toBe(join(env.home, ".claude"));
    expect(o.repos[0]?.claudeAccount).toBeNull();
  });

  test("~/.claude 以外を選ぶと turnlane ai run が受け取る環境に CLAUDE_CONFIG_DIR が付く。既定を選ぶと消す", async () => {
    const { launchWith, claim } = await withAccounts();
    const acme = join(env.home, ".claude-acme");
    const r = (await launchWith({ claudeAccount: acme })).body as AiLaunchResult;
    const c = await claim(r.launchId);
    expect(c.env).toEqual({ TURNLANE_LAUNCH_ID: r.launchId, CLAUDE_CONFIG_DIR: acme });
    expect(c.unsetEnv).toBeUndefined();
    // 端末に入力するコマンドには何も足さない（起動 ID だけ）
    expect(env.open.runs.at(-1)?.at(-1)).toBe(`${CLI} ai run ${r.launchId}`);
    const d = (await launchWith({ claudeAccount: join(env.home, ".claude") }))
      .body as AiLaunchResult;
    const cd = await claim(d.launchId);
    expect(cd.env).toEqual({ TURNLANE_LAUNCH_ID: d.launchId });
    expect(cd.unsetEnv).toEqual(["CLAUDE_CONFIG_DIR"]);
  });

  test("既定: プロジェクトの設定 → 前回選んだもの。外したものは選択肢に出さず、選べない", async () => {
    const { opts, launchWith, claim, call } = await withAccounts();
    const acme = join(env.home, ".claude-acme");
    const main = join(env.home, ".claude");
    // 前回選んだもの
    await launchWith({ claudeAccount: acme });
    expect((await opts()).defaultClaudeAccount).toBe(acme);
    // プロジェクトの既定が優先
    const pid = q<{ id: string }>("SELECT id FROM project")[0]?.id as string;
    // 設定画面は PUT /api/config/:key（カレンダーの経路）で書く。ここでは同じ検証を通して直接入れる
    const put = (key: ConfigKey, value: unknown) => {
      const v = validateConfig(key, value);
      if (!v.ok) throw new Error(v.error);
      putSetting(env.mutate, key, v.value);
    };
    put("ai.claude_account_by_project", { [pid]: main });
    const o = await opts();
    expect(o.defaultClaudeAccount).toBe(main);
    expect(o.repos[0]?.claudeAccount).toBe(main);
    // 省略して頼むと既定（プロジェクトの設定）で起動する
    const r = (await launchWith({})).body as AiLaunchResult;
    expect((await claim(r.launchId)).unsetEnv).toEqual(["CLAUDE_CONFIG_DIR"]);
    // 名前の変更と外す
    put("ai.claude_accounts", { [main]: { hidden: true }, [acme]: { name: "Acme" } });
    const h = await opts();
    expect(h.claudeAccounts).toEqual([{ path: acme, name: "Acme" }]);
    expect(h.defaultClaudeAccount).toBe(acme);
    expect((await launchWith({ claudeAccount: main })).body).toEqual({
      error: "account_missing",
    });
    const all = await call<{ path: string; hidden: boolean; customName: string | null }[]>(
      "GET",
      "/api/ai/claude-accounts",
    );
    expect(all.body.map((a) => (a as unknown as { displayPath: string }).displayPath)).toEqual([
      "~/.claude",
      "~/.claude-acme",
    ]);
    expect(all.body.map((a) => [a.path, a.hidden, a.customName])).toEqual([
      [main, true, null],
      [acme, false, "Acme"],
    ]);
    // 不正な値は保存できない
    expect(validateConfig("ai.claude_accounts", { "relative/path": { name: "x" } }).ok).toBe(false);
    expect(validateConfig("ai.claude_accounts", { [acme]: { name: "" } }).ok).toBe(false);
    expect(validateConfig("ai.claude_account_by_project", { p: "/a/../b" }).ok).toBe(false);
  });

  test("Codex には付けない。選択肢が1つ（~/.claude-acme だけ）なら選ばせず、それを付ける", async () => {
    const { launchWith, claim, sys, opts } = await withAccounts([".claude-acme"]);
    sys.installed = ["claude_code", "codex"];
    expect((await opts()).claudeAccounts).toHaveLength(1);
    const r = (await launchWith({})).body as AiLaunchResult;
    expect((await claim(r.launchId)).env.CLAUDE_CONFIG_DIR).toBe(join(env.home, ".claude-acme"));
    const x = (await launchWith({ tool: "codex" })).body as AiLaunchResult;
    expect((await claim(x.launchId)).env).toEqual({ TURNLANE_LAUNCH_ID: x.launchId });
  });

  test("選んだアカウントのディレクトリに書かれたトランスクリプトで --session-id が紐づく", async () => {
    const { launchWith, claim, launch } = await withAccounts();
    const acme = join(env.home, ".claude-acme");
    const r = (await launchWith({ claudeAccount: acme, worktree: true })).body as AiLaunchResult;
    const c = await claim(r.launchId);
    const uuid = c.argv[2] as string;
    const wt = r.worktreePath as string;
    env.git.repos.set(wt, "/w/app");
    env.git.branches.set(wt, r.branch as string);
    // claude は CLAUDE_CONFIG_DIR の projects/ に書く
    claudeTranscript(c.env.CLAUDE_CONFIG_DIR as string, {
      sid: uuid,
      cwd: wt,
      branch: r.branch as string,
    }).human(T0 + MIN);
    env.clock.set(T0 + 2 * MIN);
    await env.sync();
    expect(launch.tick()).toBe(1);
    const linked = q<{ status: string; root_path: string }>(
      `SELECT l.status, src.root_path FROM ai_launch l JOIN ai_session s ON s.id = l.session_id
       JOIN ai_source src ON src.id = s.source_id`,
    );
    expect(linked).toEqual([{ status: "linked", root_path: acme }]);
  });
});

describe("Orca（D-122）", () => {
  const ORCA = { id: "orca", name: "Orca", path: "/Applications/Orca.app" };
  const id = "b".repeat(32);

  test("orca terminal create --worktree path:<cwd> --command <dl ai run> --title --focus。登録していなければ repo add してから", () => {
    const plan = planLaunch(ORCA, CLI, id, "/w/app-wt/tl-x-0001", {
      title: "Fix\nthe lanes",
      repo: "/w/app",
    });
    const cli = orcaCli(ORCA);
    expect(cli).toEqual([
      "/usr/bin/env",
      "ELECTRON_RUN_AS_NODE=1",
      "/Applications/Orca.app/Contents/MacOS/Orca",
      "/Applications/Orca.app/Contents/Resources/app.asar.unpacked/out/cli/index.js",
    ]);
    const create = [
      ...cli,
      "terminal",
      "create",
      "--worktree",
      "path:/w/app-wt/tl-x-0001",
      "--command",
      `${CLI} ai run ${id}`,
      "--title",
      "Fix the lanes",
      "--focus",
      "--json",
    ];
    expect(plan.map((p) => p.steps.map((s) => s.argv))).toEqual([
      [[...cli, "open", "--json"], create],
      [[...cli, "repo", "add", "--path", "/w/app", "--json"], create],
      [["/usr/bin/open", "-a", "/Applications/Orca.app"]],
      [],
    ]);
    expect(plan.map((p) => p.outcome)).toEqual(["typed", "typed", "opened_copied", "copied"]);
    expect(plan[2]?.copy).toBe(`cd /w/app-wt/tl-x-0001 && ${CLI} ai run ${id}`);
  });

  test("--worktree path: と repo add --path にはシンボリックリンクを解いた実体のパスを渡す（Orca は git の返す実体のパスで比べる）", () => {
    // 一時ディレクトリ（macOS では /var/folders/… の実体が /private/var/folders/…）にシンボリックリンクを作る
    const base = mkdtempSync(join(tmpdir(), "turnlane-orca-real-"));
    try {
      const real = join(base, "repo");
      mkdirSync(real);
      const link = join(base, "link");
      symlinkSync(real, link);
      const resolved = realpathSync(real);
      const plan = planLaunch(ORCA, CLI, id, link, { repo: link, unattended: true });
      const argv = plan.flatMap((p) => p.steps.map((s) => s.argv.slice(4)));
      expect(argv).toContainEqual(["repo", "add", "--path", resolved, "--json"]);
      expect(argv).toContainEqual([
        "terminal",
        "create",
        "--worktree",
        `path:${resolved}`,
        "--command",
        `${CLI} ai run ${id}`,
        "--json",
      ]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("依頼: Orca で開けたら opened（題名はタブの名前に。端末へはシェルを通さない引数で渡す）。CLI が失敗したら開いてコピー", async () => {
    const { call, taskId } = await setup({ terminal: ORCA });
    const r = await call<AiLaunchResult>("POST", "/api/ai/launches", {
      taskId,
      repo: "/w/app",
      tool: "claude_code",
      worktree: true,
    });
    expect(r.body).toMatchObject({ outcome: "opened", app: "Orca", command: null });
    const wt = r.body.worktreePath as string;
    const runs = env.open.runs.map((a) => a.slice(4).join(" "));
    expect(runs).toEqual([
      "open --json",
      `terminal create --worktree path:${wt} --command ${CLI} ai run ${r.body.launchId} --title Fix the day view lanes --focus --json`,
    ]);
    // 登録していないリポジトリ（selector_not_found）→ repo add してから作り直す
    env.open.runs.length = 0;
    let created = 0;
    env.open.fail = (a) => a.includes("create") && created++ === 0;
    const r2 = await call<AiLaunchResult>("POST", "/api/ai/launches", {
      taskId,
      repo: "/w/app",
      tool: "claude_code",
      worktree: false,
    });
    expect(r2.body).toMatchObject({ outcome: "opened", app: "Orca" });
    expect(env.open.runs.map((a) => a.slice(4, 6).join(" "))).toEqual([
      "open --json",
      "terminal create",
      "repo add",
      "terminal create",
    ]);
    expect(env.open.runs[2]?.slice(4)).toEqual(["repo", "add", "--path", "/w/app", "--json"]);
    // Orca の CLI がどれも失敗 → Orca を前面に出してコピー
    env.open.fail = (a) => a[0] === "/usr/bin/env";
    const r3 = await call<AiLaunchResult>("POST", "/api/ai/launches", {
      taskId,
      repo: "/w/app",
      tool: "claude_code",
      worktree: false,
    });
    expect(r3.body).toMatchObject({
      outcome: "opened_copied",
      app: "Orca",
      command: `cd /w/app && ${CLI} ai run ${r3.body.launchId}`,
    });
  });
});

describe("人のいないときの起動（拡張の時刻・条件。launchUnattended）", () => {
  const ORCA = { id: "orca", name: "Orca", path: "/Applications/Orca.app" };
  const input = (taskId: string) => ({
    taskId,
    repo: "/w/app",
    tool: "claude_code" as const,
    worktree: true,
  });

  test("画面がロックされていれば何も作らずに locked（screen_locked）。外れたら同じ呼び出しで起動し、trigger が残る", async () => {
    const { launch, taskId, sys } = await setup();
    sys.locked = true;
    const r = await launch.launchUnattended(input(taskId), "schedule");
    expect(r).toEqual({ outcome: "locked", reason: "screen_locked" });
    expect(sys.gitCalls.some((c) => c.args[0] === "worktree")).toBe(false);
    expect(q("SELECT id FROM ai_launch")).toEqual([]);
    expect(env.open.runs).toEqual([]);
    sys.locked = false;
    const r2 = await launch.launchUnattended(input(taskId), "schedule");
    expect(r2).toMatchObject({ outcome: "opened", app: "Ghostty" });
    expect(q<{ trigger: string }>("SELECT trigger FROM ai_launch")).toEqual([
      { trigger: "schedule" },
    ]);
  });

  test("端末を開けなければコピーに落とさず locked（not_opened）。起動の行・worktree・ブランチを片付ける", async () => {
    const { launch, taskId, sys } = await setup();
    env.open.fail = () => true;
    const r = await launch.launchUnattended(input(taskId), "schedule");
    expect(r).toEqual({ outcome: "locked", reason: "not_opened" });
    // 端末を前面に出す・コピーする（open -a / pbcopy）は試さない
    expect(env.open.runs.map((a) => a[0])).toEqual([OSA]);
    expect(q("SELECT id FROM ai_launch")).toEqual([]);
    const add = sys.gitCalls.find((c) => c.args[0] === "worktree" && c.args[1] === "add");
    const wt = add?.args[2] as string;
    const branch = add?.args[4] as string;
    expect(sys.gitCalls.filter((c) => c.args[0] === "worktree" || c.args[0] === "branch")).toEqual([
      add as { cwd: string; args: string[] },
      { cwd: "/w/app", args: ["worktree", "remove", "--force", wt] },
      { cwd: "/w/app", args: ["branch", "-D", branch] },
    ]);
    // 画面からの依頼は今までどおりコピーに落とす
    const m = await launch.launch(input(taskId));
    expect(m.outcome).toBe("copied");
  });

  test("Orca は前面に出さない（--focus なし）。CLI が失敗しても Orca を開いてコピーはしない", async () => {
    const id = "c".repeat(32);
    const plan = planLaunch(ORCA, CLI, id, "/w/app", { unattended: true });
    const argvs = plan.flatMap((p) => p.steps.map((s) => s.argv));
    expect(argvs.some((a) => a.includes("--focus"))).toBe(false);
    expect(argvs.some((a) => a.includes("create"))).toBe(true);
    expect(plan.map((p) => p.outcome)).toEqual(["typed", "typed"]);
    expect(planLaunch(ORCA, CLI, id, "/w/app").map((p) => p.outcome)).toEqual([
      "typed",
      "typed",
      "opened_copied",
      "copied",
    ]);
    const { launch, taskId } = await setup({ terminal: ORCA });
    const r = await launch.launchUnattended(input(taskId), "schedule");
    expect(r).toMatchObject({ outcome: "opened", app: "Orca" });
    expect(env.open.runs.flat()).not.toContain("--focus");
  });

  test("Orca はロック中でも待たずに起動する（S8）。Ghostty・Terminal・それ以外はロック中は待つ", async () => {
    const { launch, taskId, sys } = await setup({ terminal: ORCA });
    sys.locked = true;
    expect(launch.unattendedWaitsWhileLocked()).toBe(false);
    const r = await launch.launchUnattended(input(taskId), "schedule");
    expect(r).toMatchObject({ outcome: "opened", app: "Orca" });
    expect(q<{ trigger: string }>("SELECT trigger FROM ai_launch")).toEqual([
      { trigger: "schedule" },
    ]);
    const term = (id: string) => ({ id, name: id, path: `/Applications/${id}.app` });
    expect(unattendedWaitsWhileLocked(ORCA)).toBe(false);
    for (const id of ["ghostty", "terminal", "iterm", "warp"])
      expect(unattendedWaitsWhileLocked(term(id))).toBe(true);
    expect(unattendedWaitsWhileLocked(null)).toBe(true);
  });

  test("Orca でも開けなければ locked（not_opened）。ロック中に試して片付ける", async () => {
    const { launch, taskId, sys } = await setup({ terminal: ORCA });
    sys.locked = true;
    env.open.fail = () => true;
    const r = await launch.launchUnattended(input(taskId), "schedule");
    expect(r).toEqual({ outcome: "locked", reason: "not_opened" });
    expect(q("SELECT id FROM ai_launch")).toEqual([]);
  });

  test("Ghostty はロック中は待つ（screen_locked）", async () => {
    const { launch, taskId, sys } = await setup();
    sys.locked = true;
    expect(launch.unattendedWaitsWhileLocked()).toBe(true);
    expect(await launch.launchUnattended(input(taskId), "schedule")).toEqual({
      outcome: "locked",
      reason: "screen_locked",
    });
    expect(env.open.runs).toEqual([]);
  });

  test("ioreg の plist からロックを読む（キーが無い・false はロックなし）", () => {
    const wrap = (inner: string) =>
      `<plist><dict><key>IOConsoleUsers</key><array><dict>${inner}</dict></array></dict></plist>`;
    expect(screenLockedFromIoreg(wrap("<key>CGSSessionScreenIsLocked</key>\n\t<true/>"))).toBe(
      true,
    );
    expect(screenLockedFromIoreg(wrap("<key>CGSSessionScreenIsLocked</key><false/>"))).toBe(false);
    expect(screenLockedFromIoreg(wrap("<key>kCGSSessionOnConsoleKey</key><true/>"))).toBe(false);
    expect(screenLockedFromIoreg("")).toBe(false);
  });
});

describe("セッションが見つからなかった理由（unlinked の理由）とフォルダの信頼", () => {
  async function claimed(o: { claudeAccount?: string } = {}) {
    const s = await setup();
    const r = await s.call<AiLaunchResult>("POST", "/api/ai/launches", {
      taskId: s.taskId,
      repo: "/w/app",
      tool: "claude_code",
      worktree: false,
      ...o,
    });
    await s.call("POST", `/api/ai/launches/${r.body.launchId}/claim`);
    return { ...s, id: r.body.launchId };
  }
  const reasonRow = () =>
    q<{ status: string; unlinked_reason: string | null }>(
      "SELECT status, unlinked_reason FROM ai_launch",
    )[0];

  test("claude がすぐ終わった → 1分待って unlinked（exited）。終了コードと時間が残る", async () => {
    const { call, launch, taskId, id } = await claimed();
    env.clock.set(T0 + 10_000);
    expect(
      (await call("POST", `/api/ai/launches/${id}/exit`, { code: 1, afterMs: 2400 })).status,
    ).toBe(200);
    env.clock.set(T0 + 50_000);
    expect(launch.tick()).toBe(0);
    env.clock.set(T0 + 75_000);
    expect(launch.tick()).toBe(1);
    expect(reasonRow()).toEqual({ status: "unlinked", unlinked_reason: "exited" });
    expect((await taskOf(call, taskId)).ai).toMatchObject({
      state: "unlinked",
      unlinkedReason: "exited",
      exit: { code: 1, afterMs: 2400 },
    });
    // クッキー（ブラウザ）からは知らせられない
    expect(
      (await call("POST", `/api/ai/launches/${id}/exit`, { code: 0, afterMs: 1 }, "none")).status,
    ).not.toBe(200);
  });

  test("動いたまま5分来ない: フォルダを信頼していなければ untrusted、信頼していれば no_session", async () => {
    const { launch, sys } = await claimed();
    env.clock.set(T0 + 4 * MIN);
    expect(launch.tick()).toBe(0);
    env.clock.set(T0 + 6 * MIN);
    expect(launch.tick()).toBe(1);
    expect(reasonRow()).toEqual({ status: "unlinked", unlinked_reason: "untrusted" });
    // アカウントが無いとき（既定）は ~/.claude.json を読む。読むのは信頼のキーだけ
    expect(sys.trustReads.at(-1)).toEqual({
      file: join(env.home, ".claude.json"),
      keys: ["/w/app"],
    });

    const s2 = await claimed();
    s2.sys.trust(join(env.home, ".claude.json"), "/w/app");
    env.clock.set(T0 + 6 * MIN);
    s2.launch.tick();
    expect(reasonRow()).toEqual({ status: "unlinked", unlinked_reason: "no_session" });
  });

  test("folderTrust: 選んだアカウントの .claude.json、worktree は元のリポジトリ、git の外の親は見ない。読めなければ unknown", async () => {
    const { launch, sys } = await setup();
    const acme = join(env.home, ".claude-acme");
    const file = join(acme, ".claude.json");
    sys.roots.set("/w/app/sub", { top: "/w/app", main: "/w/app" });
    sys.trust(file, "/w");
    expect(launch.folderTrust({ repo: "/w/app/sub", claudeAccount: acme })).toBe("untrusted");
    expect(sys.trustReads.at(-1)).toEqual({ file, keys: ["/w/app", "/w/app/sub"] });
    sys.trust(file, "/w/app");
    expect(launch.folderTrust({ repo: "/w/app/sub", claudeAccount: acme })).toBe("trusted");
    // worktree は元のリポジトリの信頼を引き継ぐ
    sys.roots.set("/wt/x", { top: "/wt/x", main: "/w/app" });
    expect(launch.folderTrust({ repo: "/wt/x", claudeAccount: acme })).toBe("trusted");
    // git でなければ親の信頼が効く
    sys.roots.set("/w/plain/a", { top: null, main: null });
    sys.trust(file, "/w/plain");
    expect(launch.folderTrust({ repo: "/w/plain/a", claudeAccount: acme })).toBe("trusted");
    sys.unreadable.add(file);
    expect(launch.folderTrust({ repo: "/w/app", claudeAccount: acme })).toBe("unknown");
    expect(launch.folderTrust({ repo: "/w/app", tool: "codex" })).toBe("unknown");
  });

  test("openForTrust: いつもの端末でそのフォルダの claude を開く（アカウントは CLAUDE_CONFIG_DIR）。信頼は書かない", async () => {
    const { launch, sys } = await setup();
    const acme = join(env.home, ".claude-acme");
    mkdirSync(join(acme, "projects"), { recursive: true });
    sys.paths.add(acme);
    await env.sync();
    const r = await launch.openForTrust({ repo: "/w/app", claudeAccount: acme });
    expect(r).toEqual({ outcome: "opened", app: "Ghostty", command: null });
    expect(env.open.runs.at(-1)).toEqual([
      OSA,
      "-e",
      GHOSTTY_RUN,
      "/w/app",
      `CLAUDE_CONFIG_DIR=${acme} claude`,
    ]);
    await expect(launch.openForTrust({ repo: "/w/app", claudeAccount: "/nope" })).rejects.toThrow(
      "account_missing",
    );
    expect(sys.trustReads).toEqual([]);
  });
});

describe("信頼の判定の部品", () => {
  test("trustKeys: 元のリポジトリ → フォルダから git のルートまで。git でなければ / まで", () => {
    expect(trustKeys("/a/repo/src/x", { top: "/a/repo", main: "/a/repo" })).toEqual([
      "/a/repo",
      "/a/repo/src/x",
      "/a/repo/src",
    ]);
    expect(trustKeys("/b/wt", { top: "/b/wt", main: "/a/repo" })).toEqual(["/a/repo", "/b/wt"]);
    expect(trustKeys("/a/b", { top: null, main: null })).toEqual(["/a/b", "/a", "/"]);
    expect(folderTrust(["/a"], null)).toBe("unknown");
    expect(folderTrust(["/a", "/b"], { "/a": false, "/b": true })).toBe("trusted");
    expect(folderTrust(["/a"], { "/a": false })).toBe("untrusted");
  });

  test("claudeConfigFile: 既定は ~/.claude.json、ほかは <dir>/.claude.json、古い .config.json があればそれ", () => {
    const ex = (s: Set<string>) => (p: string) => s.has(p);
    expect(claudeConfigFile(null, "/h", ex(new Set()))).toBe("/h/.claude.json");
    expect(claudeConfigFile("/h/.claude", "/h/", ex(new Set()))).toBe("/h/.claude.json");
    expect(claudeConfigFile("/h/.claude-p/", "/h", ex(new Set()))).toBe(
      "/h/.claude-p/.claude.json",
    );
    expect(claudeConfigFile("/h/.claude-p", "/h", ex(new Set(["/h/.claude-p/.config.json"])))).toBe(
      "/h/.claude-p/.config.json",
    );
  });

  test("unlinkedReason: 終わったら1分、動いていれば5分の後に、信頼で untrusted / no_session", () => {
    const base = { since: 0, windowMs: 5 * MIN, trust: "unknown" as const };
    expect(unlinkedReason({ ...base, now: 30_000, exitedAt: 10_000 })).toBeNull();
    expect(unlinkedReason({ ...base, now: 70_000, exitedAt: 10_000 })).toBe("exited");
    expect(unlinkedReason({ ...base, now: 4 * MIN, exitedAt: null })).toBeNull();
    expect(unlinkedReason({ ...base, now: 6 * MIN, exitedAt: null })).toBe("no_session");
    expect(unlinkedReason({ ...base, now: 6 * MIN, exitedAt: null, trust: "untrusted" })).toBe(
      "untrusted",
    );
  });

  test("本物のファイル: .claude.json から信頼の値だけを返す。git の worktree は元のリポジトリを指す", async () => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "turnlane-trust-")));
    const cfg = join(tmp, "c.json");
    writeFileSync(
      cfg,
      JSON.stringify({
        oauthAccount: { emailAddress: "x@example.invalid" },
        projects: { "/a": { hasTrustDialogAccepted: true, allowedTools: ["x"] }, "/b": {} },
      }),
    );
    expect(trustFlagsFrom(cfg, ["/a", "/b", "/c", "__proto__"])).toEqual({
      "/a": true,
      "/b": false,
      "/c": false,
      __proto__: false,
    });
    expect(trustFlagsFrom(join(tmp, "none.json"), ["/a"])).toBeNull();
    const repo = join(tmp, "repo");
    mkdirSync(join(repo, "src"), { recursive: true });
    const git = async (cwd: string, ...a: string[]) =>
      Bun.spawn(["git", "-C", cwd, ...a], { stdout: "ignore", stderr: "ignore" }).exited;
    await git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "README.md"), "x\n");
    await git(repo, "add", ".");
    await git(
      repo,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.invalid",
      "commit",
      "-qm",
      "i",
    );
    await git(repo, "worktree", "add", "-q", join(tmp, "wt"), "-b", "w");
    expect(gitRootsOf(join(repo, "src"))).toEqual({
      real: join(repo, "src"),
      top: repo,
      main: repo,
    });
    expect(gitRootsOf(join(tmp, "wt"))).toEqual({
      real: join(tmp, "wt"),
      top: join(tmp, "wt"),
      main: repo,
    });
    symlinkSync(repo, join(tmp, "link"));
    expect(gitRootsOf(join(tmp, "link")).real).toBe(repo);
  });
});
