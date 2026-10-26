/**
 * 完了のときの片付け（POST /api/ai/launches/:id/finish・GET /api/ai/finish-plan）の結合テスト。端末・git・プロセスは偽物
 * （偽の ps・pgrep・tmux・Orca の出力を決めておき、送った引数を記録する）。実際の端末・AI・シェルには触れない。
 *
 * - 動いている AI に終了の指示（Claude Code は /exit、Codex は /quit）→ 終わるのを待つ → タブのシェルに exit → closed
 * - 終わらない → ai_still_running（exit は送らない。worktree の片付けは続ける）
 * - 送る口の無い端末 → not_closable（何も送らない）
 * - 居場所が 1 つに決まらない・タブのシェルが同じ tty にいない → failed（送らない）
 * - Turnlane が包んだ tmux のセッションは AI が終われば閉じる（exit は送らない）。Orca は同梱の CLI の terminal close
 * - 取り込まれていない worktree は force なしでは残し、force で消す
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { nullLogger } from "@turnlane/collectors";
import type {
  AiLaunchResult,
  LaunchFinishPlan,
  LaunchFinishResult,
  TaskView,
} from "@turnlane/core/api";
import { ITERM_WRITE } from "../src/answer/deliver.ts";
import { createApp } from "../src/http/app.ts";
import { exitCommand, pgrepArgv, psArgv } from "../src/launch/finish.ts";
import { LaunchService } from "../src/launch/service.ts";
import { LIST_PANES_FORMAT } from "../src/open/locate.ts";
import { orcaCli } from "../src/open/orca.ts";
import { createPlanner } from "../src/planner/index.ts";
import { type AiEnv, makeAiEnv } from "./helpers/env.ts";
import { FakeLaunchSystem } from "./helpers/launch-system.ts";
import { claudeTranscript } from "./helpers/transcript.ts";

const TOKEN = "d".repeat(64);
const HOST = "127.0.0.1:7317";
const T0 = Date.UTC(2026, 8, 14, 1, 0);
const OSA = "/usr/bin/osascript";
const CLI = "/u/.local/bin/turnlane";
const ITERM = "/Applications/iTerm.app";
const TTY = "/dev/ttys003";
const TMUX = "/opt/homebrew/bin/tmux";
const ORCA = { id: "orca", name: "Orca", path: "/Applications/Orca.app" };
const HANDLE = "term_abcdef123456";

let env: AiEnv;
afterEach(async () => {
  await env?.cleanup();
});

/** 偽のプロセス表（ps の 1 行と、pgrep の結果） */
function proc(pid: number, ppid: number, tty: string | null, comm: string): void {
  env.open.outputs.set(
    psArgv(pid).join(" "),
    `${ppid} ${tty ? tty.replace("/dev/", "") : "??"} ${comm}`,
  );
}
const gone = (pid: number) => env.open.outputs.delete(psArgv(pid).join(" "));
const pgrep = (id: string, ...pids: number[]) =>
  env.open.outputs.set(pgrepArgv(id).join(" "), pids.join("\n"));

/** 端末に送った文（osascript の最後の引数・tmux の send-keys -l の文・Orca の --text=） */
function sentTexts(): string[] {
  return env.open.runs.flatMap((a) => {
    if (a[0] === OSA) return [a.at(-1) as string];
    const l = a.indexOf("-l");
    if (a.includes("send-keys") && l >= 0) return [a[l + 2] as string];
    const t = a.find((x) => x.startsWith("--text="));
    return t ? [t.slice("--text=".length)] : [];
  });
}

async function setup(
  o: {
    tool?: "claude_code" | "codex";
    exitOn?: string | null;
    /** カードのセッションの待ち（runner の判定の代わり） */
    waiting?: "permission" | "ask" | "question";
  } = {},
) {
  env = makeAiEnv({ now: T0 });
  const repo = "/w/app";
  env.git.repos.set(repo, repo);
  const sys = new FakeLaunchSystem();
  sys.installed = ["claude_code", "codex"];
  sys.paths.add(repo);
  sys.reply((_c, a) => a[0] === "symbolic-ref", { ok: true, out: "origin/main" });
  const planner = createPlanner({
    sqlite: env.sqlite,
    mutate: env.mutate,
    clock: env.clock,
    hub: env.hub,
    ai: env.ai,
  });
  let sleeps = 0;
  const launch = new LaunchService({
    sqlite: env.sqlite,
    mutate: env.mutate,
    clock: env.clock,
    sys,
    open: env.open,
    cliPath: CLI,
    home: env.home,
    terminal: () => ({ id: "iterm", name: "iTerm2", path: ITERM }),
    locale: () => "ja",
    logger: nullLogger,
    onChanged: () => {},
    publish: () => {},
    finishWaitMs: 2000,
    sleep: async () => {
      sleeps++;
    },
    orcaApp: () => ORCA,
    ...(o.waiting
      ? {
          sessionWait: () => ({
            kind: o.waiting as "permission",
            turnId: "turn",
            sessionId: "session",
          }),
        }
      : {}),
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
  const t = await call<{ task: TaskView }>("POST", "/api/tasks", {
    title: "Fix the day view lanes",
    date: "2026-09-14",
  });
  const r = await call<AiLaunchResult>("POST", "/api/ai/launches", {
    taskId: t.body.task.id,
    repo,
    tool: o.tool ?? "claude_code",
    worktree: true,
  });
  const id = r.body.launchId;
  const wt = r.body.worktreePath as string;
  env.open.runs.length = 0;
  // 取り込み済み・未コミットなし（cleanup の既定。偽の git は merge-base が通る）
  // AI のプロセス: turnlane ai run（4242）← タブのシェル（4200）← login（4100）← iTerm2
  proc(4242, 4200, TTY, CLI);
  proc(4200, 4100, TTY, "-zsh");
  proc(4100, 4000, TTY, "/usr/bin/login");
  proc(4000, 1, null, `${ITERM}/Contents/MacOS/iTerm2`);
  pgrep(id, 4242);
  // 終了の指示が届いたら AI が終わる（turnlane ai run が終わりを知らせて居なくなる）
  const exitOn = o.exitOn === undefined ? exitCommand(o.tool ?? "claude_code") : o.exitOn;
  const run = env.open.run.bind(env.open);
  env.open.run = async (argv, opts) => {
    const ok = await run(argv, opts);
    const text = argv.at(-1) ?? "";
    if (exitOn && (text === exitOn || argv.includes(`--text=${exitOn}`))) {
      launch.exited(id, 0, 60_000);
      gone(4242);
      env.open.outputs.delete(pgrepArgv(id).join(" "));
    }
    return ok;
  };
  return { call, launch, sys, id, wt, taskId: t.body.task.id, sleeps: () => sleeps };
}

const finish = (
  s: Awaited<ReturnType<typeof setup>>,
  body: { closeTerminal: boolean; removeWorktree: boolean; force: boolean },
) => s.call<LaunchFinishResult>("POST", `/api/ai/launches/${s.id}/finish`, body);

const unmerged = (sys: FakeLaunchSystem) => {
  sys.reply((_c, a) => a[0] === "merge-base", { ok: false, out: "" });
  sys.reply((_c, a) => a[0] === "rev-list", { ok: true, out: "3" });
};

describe("AI を終了してタブを閉じる", () => {
  test("動いている Claude Code に /exit → 終わるのを待つ → タブのシェルに exit → closed。worktree も消す", async () => {
    const s = await setup();
    await s.call("POST", `/api/ai/launches/${s.id}/claim`);
    const r = await finish(s, { closeTerminal: true, removeWorktree: true, force: false });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      terminal: "closed",
      reason: null,
      app: "iTerm2",
      worktree: { removed: true, reason: null, uncommitted: 0 },
    });
    // iTerm2 は tty の一致するセッションにだけ書く（AppleScript に文を引数で渡す）
    expect(env.open.runs.filter((a) => a[0] === OSA)).toEqual([
      [OSA, "-e", ITERM_WRITE, TTY, "/exit"],
      [OSA, "-e", ITERM_WRITE, TTY, "exit"],
    ]);
  });

  test("Codex は /quit を送る", async () => {
    const s = await setup({ tool: "codex" });
    await s.call("POST", `/api/ai/launches/${s.id}/claim`);
    const r = await finish(s, { closeTerminal: true, removeWorktree: false, force: false });
    expect(r.body).toMatchObject({ terminal: "closed", worktree: null });
    expect(sentTexts()).toEqual(["/quit", "exit"]);
  });

  test("AI が終わらない → ai_still_running（exit は送らない）。worktree の片付けは続ける", async () => {
    const s = await setup({ exitOn: null });
    await s.call("POST", `/api/ai/launches/${s.id}/claim`);
    const r = await finish(s, { closeTerminal: true, removeWorktree: true, force: false });
    expect(r.body).toEqual({
      terminal: "ai_still_running",
      reason: "not_exited",
      app: "iTerm2",
      worktree: { removed: true, reason: null, uncommitted: 0 },
    });
    expect(sentTexts()).toEqual(["/exit"]);
    // 2 秒を 250ms ごとに待った
    expect(s.sleeps()).toBe(8);
  });

  test("AI が先に終わっていた: 受け取りのときに覚えたタブのシェルに exit だけを送る", async () => {
    const s = await setup();
    await s.call("POST", `/api/ai/launches/${s.id}/claim`);
    // 受け取りのときの居場所の調べが終わるのを待つ
    for (let i = 0; i < 50; i++) await Bun.sleep(1);
    s.launch.exited(s.id, 0, 60_000);
    gone(4242);
    env.open.outputs.delete(pgrepArgv(s.id).join(" "));
    const r = await finish(s, { closeTerminal: true, removeWorktree: false, force: false });
    expect(r.body.terminal).toBe("closed");
    expect(sentTexts()).toEqual(["exit"]);
  });

  test("許可・選択のダイアログで待っている AI には送らない（Enter が選択になる）→ failed（ai_waiting）。問いの返答待ちなら送る", async () => {
    for (const waiting of ["permission", "ask", "question"] as const) {
      const s = await setup({ waiting });
      await s.call("POST", `/api/ai/launches/${s.id}/claim`);
      // セッションと紐づける（AI 項目ができる）
      const uuid = env.sqlite
        .query<{ u: string }, []>("SELECT session_uuid AS u FROM ai_launch")
        .get()?.u as string;
      env.git.repos.set(s.wt, "/w/app");
      const tr = claudeTranscript(join(env.home, ".claude"), { sid: uuid, cwd: s.wt, branch: "b" });
      tr.human(T0 + 60_000);
      env.clock.set(T0 + 120_000);
      await env.sync();
      s.launch.tick();
      const r = await finish(s, { closeTerminal: true, removeWorktree: false, force: false });
      if (waiting === "question") expect(r.body.terminal).toBe("closed");
      else {
        expect(r.body).toMatchObject({ terminal: "failed", reason: "ai_waiting" });
        expect(env.open.runs).toEqual([]);
      }
      await env.cleanup();
    }
  });

  test("送る口の無い端末（tmux で包んでいない Warp）→ not_closable。何も送らない", async () => {
    const s = await setup();
    proc(4000, 1, null, "/Applications/Warp.app/Contents/MacOS/stable");
    await s.call("POST", `/api/ai/launches/${s.id}/claim`);
    const r = await finish(s, { closeTerminal: true, removeWorktree: false, force: false });
    expect(r.body).toEqual({
      terminal: "not_closable",
      reason: "unsupported",
      app: "Warp",
      worktree: null,
    });
    expect(env.open.runs).toEqual([]);
  });

  test("その起動の端末と確かめられない: turnlane ai run が 2 つ見つかる → failed で送らない", async () => {
    const s = await setup();
    proc(5252, 5200, "/dev/ttys009", CLI);
    pgrep(s.id, 4242, 5252);
    const r = await finish(s, { closeTerminal: true, removeWorktree: false, force: false });
    expect(r.body).toMatchObject({ terminal: "failed", reason: "not_found" });
    expect(env.open.runs).toEqual([]);
  });

  test("AI が終わった後、タブのシェルがその tty にいない（別のタブに使い回された）→ exit を送らず failed", async () => {
    const s = await setup();
    await s.call("POST", `/api/ai/launches/${s.id}/claim`);
    const run = env.open.run.bind(env.open);
    env.open.run = async (argv, opts) => {
      const ok = await run(argv, opts);
      if (argv.at(-1) === "/exit") proc(4200, 4100, "/dev/ttys011", "-zsh");
      return ok;
    };
    const r = await finish(s, { closeTerminal: true, removeWorktree: false, force: false });
    expect(r.body).toMatchObject({ terminal: "failed", reason: "not_found" });
    expect(sentTexts()).toEqual(["/exit"]);
  });

  test("Turnlane が包んだ tmux のセッション: AI が終わればペインが閉じる（exit は送らない）", async () => {
    const s = await setup();
    // turnlane ai run（4242）の親は tmux のサーバ（4300）。外側は Warp
    proc(4242, 4300, TTY, CLI);
    proc(4300, 1, null, TMUX);
    env.open.outputs.set(`/bin/ps -o args= -p 4300`, `${TMUX} new-session -s turnlane-x`);
    const panes = [TMUX, "-u", "list-panes", "-a", "-F", LIST_PANES_FORMAT].join(" ");
    env.open.outputs.set(panes, `${TTY}\t%7\tturnlane-x\t0\t0`);
    const run = env.open.run.bind(env.open);
    env.open.run = async (argv, opts) => {
      const ok = await run(argv, opts);
      if (argv.at(-1) === "Enter") env.open.outputs.delete(panes);
      return ok;
    };
    await s.call("POST", `/api/ai/launches/${s.id}/claim`);
    const r = await finish(s, { closeTerminal: true, removeWorktree: false, force: false });
    expect(r.body).toMatchObject({ terminal: "closed", reason: null });
    expect(env.open.runs).toEqual([
      [TMUX, "-u", "send-keys", "-t", "%7", "-l", "--", "/exit"],
      [TMUX, "-u", "send-keys", "-t", "%7", "Enter"],
    ]);
  });

  test("Orca: /exit を CLI で送り、終わったら terminal close --tab でタブを閉じる", async () => {
    const s = await setup();
    proc(4000, 1, null, `${ORCA.path}/Contents/MacOS/Orca`);
    env.open.outputs.set(
      [...orcaCli(ORCA), "terminal", "list", "--json"].join(" "),
      JSON.stringify({
        result: {
          terminals: [
            { handle: HANDLE, worktreePath: s.wt, tabId: "t1", connected: true, writable: true },
          ],
        },
      }),
    );
    env.open.stdout = () => JSON.stringify({ result: { send: { accepted: true } } });
    await s.call("POST", `/api/ai/launches/${s.id}/claim`);
    const r = await finish(s, { closeTerminal: true, removeWorktree: false, force: false });
    expect(r.body).toMatchObject({ terminal: "closed", app: "Orca" });
    expect(sentTexts()).toEqual(["/exit"]);
    expect(env.open.runs.at(-1)).toEqual([
      ...orcaCli(ORCA),
      "terminal",
      "close",
      `--terminal=${HANDLE}`,
      "--tab",
      "--json",
    ]);
  });

  test("閉じない（closeTerminal: false）なら端末に触れない", async () => {
    const s = await setup();
    const r = await finish(s, { closeTerminal: false, removeWorktree: true, force: false });
    expect(r.body).toMatchObject({ terminal: null, worktree: { removed: true } });
    expect(env.open.runs).toEqual([]);
  });
});

describe("worktree を消す", () => {
  test("取り込まれていない worktree は force なしでは残し、force で消す（ブランチも -D）", async () => {
    const s = await setup();
    unmerged(s.sys);
    const soft = await finish(s, { closeTerminal: false, removeWorktree: true, force: false });
    expect(soft.body.worktree).toEqual({ removed: false, reason: "unmerged", uncommitted: 0 });
    expect(s.sys.gitCalls.some((c) => c.args[1] === "remove")).toBe(false);
    const hard = await finish(s, { closeTerminal: false, removeWorktree: true, force: true });
    expect(hard.body.worktree).toEqual({ removed: true, reason: null, uncommitted: 0 });
    expect(s.sys.gitCalls.slice(-2).map((c) => c.args)).toEqual([
      ["worktree", "remove", "--force", s.wt],
      ["branch", "-D", expect.any(String)],
    ]);
  });
});

describe("完了のシートを出すか（finish-plan）", () => {
  test("動いている AI と取り込まれていない worktree の依頼を返す。片付けた後・起動していないタスクは返さない", async () => {
    const s = await setup();
    await s.call("POST", `/api/ai/launches/${s.id}/claim`);
    unmerged(s.sys);
    const p = await s.call<LaunchFinishPlan>("GET", `/api/ai/finish-plan?taskIds=${s.taskId},x`);
    expect(p.body).toEqual({
      launches: [
        {
          launchId: s.id,
          taskId: s.taskId,
          tool: "claude_code",
          aiRunning: true,
          worktree: { path: s.wt, branch: expect.any(String), state: "unmerged" },
        },
      ],
    });
    // AI が終わり、worktree を消した後は出さない
    s.launch.exited(s.id, 0, 1000);
    gone(4242);
    await finish(s, { closeTerminal: false, removeWorktree: true, force: true });
    const after = await s.call<LaunchFinishPlan>("GET", `/api/ai/finish-plan?taskIds=${s.taskId}`);
    expect(after.body).toEqual({ launches: [] });
  });

  test("まだ受け取られていない（pending）依頼は出さない。入力の形が違えば 400", async () => {
    const s = await setup();
    const p = await s.call<LaunchFinishPlan>("GET", `/api/ai/finish-plan?taskIds=${s.taskId}`);
    expect(p.body).toEqual({ launches: [] });
    const bad = await s.call("POST", `/api/ai/launches/${s.id}/finish`, { closeTerminal: true });
    expect(bad.status).toBe(400);
  });
});
