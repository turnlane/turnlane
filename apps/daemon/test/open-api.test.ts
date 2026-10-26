/**
 * タスクから開く（D-059。m2-api 13章、ux-mvp 4.11）の結合テスト。OS は偽物（起動した引数を記録する）。
 * 取り込みは合成のトランスクリプト、時計は偽物（2026-09-14 10:00 JST から）。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { putSetting } from "@turnlane/core";
import type { OpenAppsResponse, OpenOptions, OpenResult, QueueResponse } from "@turnlane/core/api";
import { createApp } from "../src/http/app.ts";
import { GHOSTTY_FOCUS_CWD, GHOSTTY_FOCUS_MARK, ITERM_FOCUS, osc7 } from "../src/open/focus.ts";
import { dedupeOptions, GHOSTTY_TYPE, OSA_TIMEOUT_MS, planOpen } from "../src/open/index.ts";
import { outerApp, parsePsLine } from "../src/open/system.ts";
import { resumeCommand, safeDir, safePrUrl } from "../src/open/target.ts";
import { createPlanner } from "../src/planner/index.ts";
import { type AiEnv, makeAiEnv } from "./helpers/env.ts";
import { FakeOpenSystem } from "./helpers/open-system.ts";
import { claudeTranscript } from "./helpers/transcript.ts";

const TOKEN = "c".repeat(64);
const HOST = "127.0.0.1:7317";
const MIN = 60_000;
const T0 = Date.UTC(2026, 8, 14, 1, 0);
const SID = "11111111-0000-4000-8000-000000000001";
const OPEN = "/usr/bin/open";
const OSA = "/usr/bin/osascript";

let env: AiEnv;
afterEach(async () => {
  await env?.cleanup();
});

const q = <T>(sql: string, ...args: (string | number)[]) =>
  env.sqlite.query<T, (string | number)[]>(sql).all(...args);

/** 返答タスク（reply）が1件ある状態。Zed・Ghostty・GitHub Desktop が入っている */
async function setup(opts: { apps?: string[] } = {}) {
  env = makeAiEnv({ now: T0 });
  env.git.repos.set("/w/app", "/w/app");
  env.git.defaults.set("/w/app", "main");
  env.open.dirs.add("/w/app");
  for (const a of opts.apps ?? [
    "/Applications/Zed.app",
    "/Applications/Ghostty.app",
    "/Applications/GitHub Desktop.app",
    "/System/Applications/Utilities/Terminal.app",
  ])
    env.open.files.add(a);
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
    sid: SID,
    cwd: "/w/app",
    branch: "feat/x",
  });
  tr.human(T0 - 2 * MIN);
  tr.prLink(T0 - MIN, "example/app", 7);
  tr.ask(T0);
  env.clock.set(T0 + 30_000);
  await env.sync();
  const [fu] = q<{ id: string; work_item_id: string }>("SELECT id, work_item_id FROM follow_up");
  if (!fu) throw new Error("no follow_up");
  return { call, fu: fu.id, wi: fu.work_item_id };
}

const setKind = (kind: string) => env.sqlite.run("UPDATE follow_up SET kind = ?", [kind]);

describe("既定の開き先（⏎）と o のメニュー", () => {
  test("返答: Ghostty に resume コマンドを入力済みにする（実行しない）。対応中の印が付く", async () => {
    const { call, fu } = await setup();
    const o = await call<OpenOptions>("GET", `/api/open/options?followUpId=${fu}`);
    expect(o.body).toEqual({
      default: "session",
      options: [
        { action: "session", app: "Ghostty" },
        { action: "editor", app: "Zed" },
        { action: "copy_resume", app: null },
      ],
    });
    const r = await call<OpenResult>("POST", "/api/open", { followUpId: fu });
    expect(r.body).toMatchObject({
      action: "session",
      outcome: "typed",
      app: "Ghostty",
      command: null,
    });
    expect(r.body.engagedAt).toBe(T0 + 30_000);
    expect(env.open.runs).toEqual([[OSA, "-e", GHOSTTY_TYPE, "/w/app", `claude --resume ${SID}`]]);
    // 入力するコマンドに改行は無い（実行しない）
    expect(env.open.runs[0]?.[4]).not.toMatch(/[\r\n]/);
    const qr = await call<QueueResponse>("GET", "/api/queue");
    expect(qr.body.items[0]?.followUps[0]?.engagedAt).toBe(T0 + 30_000);
  });

  test("Ghostty の AppleScript が使えない（許可なし・時間切れ）→ 開いてコピー。osascript は打ち切る。落ちた理由を返す（B-5）", async () => {
    const { call, fu } = await setup();
    env.open.fail = (a) => a[0] === OSA;
    env.open.failWhy = () => ({
      stderr: "execution error: Not authorized to send Apple events to Ghostty. (-1743)",
    });
    const r = await call<OpenResult>("POST", "/api/open", { followUpId: fu });
    expect(r.body).toMatchObject({
      outcome: "opened_copied",
      app: "Ghostty",
      command: `claude --resume ${SID}`,
      fallback: { reason: "automation_denied", app: "Ghostty" },
    });
    env.open.failWhy = () => ({ timedOut: true });
    const r2 = await call<OpenResult>("POST", "/api/open", { followUpId: fu });
    expect(r2.body.fallback).toEqual({ reason: "automation_timeout", app: "Ghostty" });
    env.open.failWhy = () => ({});
    expect(env.open.runs.at(-1)).toEqual([OPEN, "-a", "/Applications/Ghostty.app", "/w/app"]);
    expect(env.open.copies).toEqual([`claude --resume ${SID}`, `claude --resume ${SID}`]);
    const plan = planOpen(
      "session",
      {
        workItemId: "w",
        followUp: null,
        openKind: null,
        folder: "/w/app",
        worktree: null,
        prUrl: null,
        session: {
          tool: "claude_code",
          externalId: SID,
          cwd: "/w/app",
          rootPath: "/h/.claude",
          entrypoint: "cli",
          livePid: null,
        },
      },
      {
        editor: null,
        diff: null,
        terminal: { id: "ghostty", name: "Ghostty", path: "/Applications/Ghostty.app" },
      },
      { home: "/h", hostApp: () => null },
    );
    expect(plan?.[0]?.steps[0]?.timeoutMs).toBe(OSA_TIMEOUT_MS);
  });

  test("差分ツール（diff）は頼んだ AI の worktree があればそこを開く（無ければリポジトリ）", () => {
    const apps = {
      editor: null,
      diff: { id: "fork", name: "Fork", path: "/Applications/Fork.app" },
      terminal: null,
    };
    const info = {
      workItemId: "w",
      followUp: null,
      openKind: null,
      folder: "/w/app",
      worktree: "/w/app-wt/tl-fix-0001",
      prUrl: null,
      session: null,
    };
    const ctx = { home: "/h", hostApp: () => null };
    expect(planOpen("diff", info, apps, ctx)?.[0]?.steps[0]?.argv.at(-1)).toBe(
      "/w/app-wt/tl-fix-0001",
    );
    expect(
      planOpen("diff", { ...info, worktree: null }, apps, ctx)?.[0]?.steps[0]?.argv.at(-1),
    ).toBe("/w/app");
    // 差分ツール以外（エディタ・Finder・ターミナル）は今までどおりリポジトリ
    expect(planOpen("finder", info, apps, ctx)?.[0]?.steps[0]?.argv.at(-1)).toBe("/w/app");
  });

  test("ターミナルが Warp なら開いてコピー。何も開けなければコピーだけ（cd 付き）", async () => {
    const { call, fu } = await setup({
      apps: ["/Applications/Warp.app", "/System/Applications/Utilities/Terminal.app"],
    });
    putSetting(env.mutate, "open.terminal", "warp");
    const r = await call<OpenResult>("POST", "/api/open", { followUpId: fu });
    expect(r.body).toMatchObject({ outcome: "opened_copied", app: "Warp" });
    expect(env.open.runs).toEqual([[OPEN, "-a", "/Applications/Warp.app", "/w/app"]]);
    env.open.fail = () => true;
    const c = await call<OpenResult>("POST", "/api/open", { followUpId: fu });
    expect(c.body).toMatchObject({
      outcome: "copied",
      command: `cd /w/app && claude --resume ${SID}`,
    });
  });

  test("ターミナルが Orca（D-122）: orca terminal create でリポジトリのフォルダに端末を作り、cd 付きの resume を実行する", async () => {
    const { call, fu } = await setup({ apps: ["/Applications/Orca.app"] });
    putSetting(env.mutate, "open.terminal", "orca");
    const opts = await call<OpenOptions>("GET", `/api/open/options?followUpId=${fu}`);
    expect(opts.body.options[0]).toEqual({ action: "session", app: "Orca" });
    const r = await call<OpenResult>("POST", "/api/open", { followUpId: fu });
    expect(r.body).toMatchObject({ action: "session", outcome: "opened", app: "Orca" });
    const cli = [
      "/usr/bin/env",
      "ELECTRON_RUN_AS_NODE=1",
      "/Applications/Orca.app/Contents/MacOS/Orca",
      "/Applications/Orca.app/Contents/Resources/app.asar.unpacked/out/cli/index.js",
    ];
    expect(env.open.runs).toEqual([
      [...cli, "open", "--json"],
      [
        ...cli,
        "terminal",
        "create",
        "--worktree",
        "path:/w/app",
        "--command",
        `cd /w/app && claude --resume ${SID}`,
        "--focus",
        "--json",
      ],
    ]);
    // ターミナル（変更の確認）: コマンドなしで端末だけ
    setKind("check_changes");
    env.open.runs.length = 0;
    const t = await call<OpenResult>("POST", "/api/open", { followUpId: fu, action: "terminal" });
    expect(t.body).toMatchObject({ outcome: "opened", app: "Orca" });
    expect(env.open.runs[1]).toEqual([
      ...cli,
      "terminal",
      "create",
      "--worktree",
      "path:/w/app",
      "--focus",
      "--json",
    ]);
    // CLI が使えない → Orca を前面に出してコピー（フォルダは渡さない）
    setKind("reply");
    env.open.runs.length = 0;
    env.open.fail = (a) => a[0] === "/usr/bin/env";
    const c = await call<OpenResult>("POST", "/api/open", { followUpId: fu });
    expect(c.body).toMatchObject({ outcome: "opened_copied", app: "Orca" });
    expect(env.open.runs.at(-1)).toEqual([OPEN, "-a", "/Applications/Orca.app"]);
    // 設定画面の一覧に出る（入っているときだけ）
    const apps = await call<OpenAppsResponse>("GET", "/api/open/apps");
    expect(apps.body.terminal.installed).toEqual([{ id: "orca", name: "Orca" }]);
  });

  test("動いているセッション: 新しく再開せず、そのプロセスを持つアプリを前面に出す", async () => {
    const { call, fu } = await setup();
    env.sqlite.run(
      "UPDATE ai_session SET live_status = 'idle', live_pid = 4242, live_checked_at = ?",
      [T0 + 20_000],
    );
    env.open.hosts.set(4242, "/Applications/Ghostty.app");
    const r = await call<OpenResult>("POST", "/api/open", { followUpId: fu });
    expect(r.body).toMatchObject({ outcome: "focused", app: "Ghostty" });
    expect(env.open.runs).toEqual([[OSA, "-e", GHOSTTY_FOCUS_CWD, "/w/app"]]);
    // cwd の一致する端末が無ければ Ghostty を前面に出すだけ
    env.open.runs.length = 0;
    env.open.fail = (a) => a[0] === OSA;
    await call("POST", "/api/open", { followUpId: fu });
    expect(env.open.runs.at(-1)).toEqual([OPEN, "-a", "/Applications/Ghostty.app"]);
    // 他のアプリ（エディタ内のターミナルなど）ならそのアプリ
    env.open.runs.length = 0;
    env.open.hosts.set(4242, "/Applications/Other Term.app");
    const o = await call<OpenResult>("POST", "/api/open", { followUpId: fu });
    expect(o.body).toMatchObject({ outcome: "focused", app: "Other Term" });
    expect(env.open.runs).toEqual([[OPEN, "-a", "/Applications/Other Term.app"]]);
    // live_checked_at が古ければ live とみなさない（PID の再利用）
    env.open.fail = () => false;
    env.sqlite.run("UPDATE ai_session SET live_checked_at = ?", [T0 - 10 * MIN]);
    const s = await call<OpenResult>("POST", "/api/open", { followUpId: fu });
    expect(s.body.outcome).toBe("typed");
  });

  test("動いているセッション: tty でそのタブに着地し、着地を言葉で返す（D-214 (4)）", async () => {
    const { call, fu } = await setup({
      apps: ["/Applications/Ghostty.app", "/Applications/iTerm.app"],
    });
    env.sqlite.run(
      "UPDATE ai_session SET live_status = 'idle', live_pid = 4242, live_checked_at = ?",
      [T0 + 20_000],
    );
    const ps = (pid: number) => `/bin/ps -o ppid=,tty=,comm= -p ${pid}`;
    env.open.outputs.set(ps(4242), "4000 ttys007 claude");
    env.open.outputs.set(ps(4000), "3900 ttys007 -zsh");
    env.open.outputs.set(ps(3900), "1 ?? /Applications/iTerm.app/Contents/MacOS/iTerm2");
    env.open.stdout = (a) => (a[0] === OSA ? "3\n" : "");
    const r = await call<OpenResult>("POST", "/api/open", { followUpId: fu });
    expect(r.body).toMatchObject({
      outcome: "focused",
      app: "iTerm2",
      landing: { level: "tab", by: "tty", tab: 3, pane: null, miss: null },
      message: "Brought iTerm2 tab 3 to the front.",
    });
    expect(env.open.runs).toEqual([[OSA, "-e", ITERM_FOCUS, "/dev/ttys007"]]);
    // タブが見つからなければアプリを前に出し、そう言う
    env.open.runs.length = 0;
    env.open.fail = (a) => a[0] === OSA;
    const miss = await call<OpenResult>("POST", "/api/open", { followUpId: fu });
    expect(miss.body).toMatchObject({
      app: "iTerm2",
      landing: { level: "app", miss: "not_found" },
      message: "Brought iTerm2 to the front — couldn't find the tab.",
    });
    expect(env.open.runs.at(-1)).toEqual([OPEN, "-a", "/Applications/iTerm.app"]);
    // Ghostty: 目印を書いて探し、成功しても失敗しても元に戻す。目印で見つからなければ cwd（同じ cwd が3つ）
    env.open.outputs.set(ps(3900), "1 ?? /Applications/Ghostty.app/Contents/MacOS/ghostty");
    env.open.runs.length = 0;
    env.open.fail = (a) => a[2] === GHOSTTY_FOCUS_MARK;
    env.open.stdout = (a) => (a[2] === GHOSTTY_FOCUS_CWD ? "2 3" : "");
    putSetting(env.mutate, "ui.language", "ja");
    const g = await call<OpenResult>("POST", "/api/open", { followUpId: fu });
    expect(g.body).toMatchObject({
      app: "Ghostty",
      landing: { level: "tab", by: "cwd", tab: 2, miss: "ambiguous", candidates: 3 },
      message: "Ghostty で同じフォルダのタブが 3 個あり、タブ 2 を前に出しました。",
    });
    expect(env.open.runs.map((a) => a[2])).toEqual([GHOSTTY_FOCUS_MARK, GHOSTTY_FOCUS_CWD]);
    const marker = env.open.runs[0]?.[3] as string;
    expect(marker).toMatch(/turnlane-focus-[0-9a-f]{12}$/);
    expect(env.open.madeDirs).toEqual([marker]);
    expect(env.open.removedDirs).toEqual([marker]);
    expect(env.open.ttyWrites).toEqual([
      { tty: "/dev/ttys007", data: osc7(marker) },
      { tty: "/dev/ttys007", data: osc7("/w/app") },
    ]);
  });

  test("Codex app で始めたセッションは codex://threads/<id> で開く", async () => {
    const { call, fu } = await setup();
    env.sqlite.run("UPDATE ai_session SET tool = 'codex', entrypoint = 'Codex Desktop'");
    const r = await call<OpenResult>("POST", "/api/open", { followUpId: fu });
    expect(r.body).toMatchObject({ outcome: "opened", app: "Codex" });
    expect(env.open.runs).toEqual([[OPEN, `codex://threads/${SID}`]]);
  });

  test("Codex で開く（D-135）: Codex のセッションでアプリが入っているときだけ。開けなければ再開コマンドをコピー", async () => {
    const first = await setup();
    const opts = async () =>
      (
        await first.call<OpenOptions>("GET", `/api/open/options?workItemId=${first.wi}`)
      ).body.options.map((x) => x.action);
    // Claude Code のセッションには出さない
    expect(await opts()).not.toContain("codex_app");
    env.sqlite.run("UPDATE ai_session SET tool = 'codex', entrypoint = 'codex_cli_rs'");
    // アプリが入っていなければ出さない（名前だけ同じで bundle ID が違うアプリも数えない）
    env.open.files.add("/Applications/ChatGPT.app");
    env.open.bundles.set("/Applications/ChatGPT.app", "com.openai.chat");
    expect(await opts()).not.toContain("codex_app");
    // 今の版の Codex のアプリは ChatGPT.app の名前で入る（bundle ID com.openai.codex）
    await env.cleanup();
    const { call, wi } = await setup();
    env.sqlite.run("UPDATE ai_session SET tool = 'codex', entrypoint = 'codex_cli_rs'");
    env.open.files.add("/Applications/ChatGPT.app");
    env.open.bundles.set("/Applications/ChatGPT.app", "com.openai.codex");
    const o = await call<OpenOptions>("GET", `/api/open/options?workItemId=${wi}`);
    expect(o.body.options).toContainEqual({ action: "codex_app", app: "Codex" });
    const r = await call<OpenResult>("POST", "/api/open", { workItemId: wi, action: "codex_app" });
    expect(r.body).toMatchObject({ action: "codex_app", outcome: "opened", app: "Codex" });
    expect(env.open.runs).toEqual([[OPEN, `codex://threads/${SID}`]]);
    // 開けなければ（URL を受け付けない版など）再開コマンドのコピー
    env.open.runs.length = 0;
    env.open.fail = (a) => a[0] === OPEN;
    const c = await call<OpenResult>("POST", "/api/open", { workItemId: wi, action: "codex_app" });
    expect(c.body.outcome).toBe("copied");
    expect(c.body.command).toEndWith(`codex resume ${SID}`);
    expect(env.open.copies.at(-1)).toBe(c.body.command ?? "");
    // Codex のアプリで始めた会話は「Codex で再開」が同じ所を開くので重ねない
    env.sqlite.run("UPDATE ai_session SET entrypoint = 'Codex Desktop'");
    const d = await call<OpenOptions>("GET", `/api/open/options?workItemId=${wi}`);
    expect(d.body.options.filter((x) => x.app === "Codex").map((x) => x.action)).toEqual([
      "session",
    ]);
  });

  test("リポジトリの無いカード（壁打ち・git 管理外）: エディタ・差分ツールが無くても Finder の項目は1つだけ（D-135 のレビュー）", async () => {
    const { call, wi } = await setup({ apps: ["/Applications/Ghostty.app"] });
    env.sqlite.run("UPDATE work_item SET repo_root = NULL");
    const o = await call<OpenOptions>("GET", `/api/open/options?workItemId=${wi}`);
    const actions = o.body.options.map((x) => x.action);
    expect(actions.filter((a) => a === "finder")).toEqual(["finder"]);
    expect(o.body.options.filter((x) => x.app === "Finder")).toEqual([
      { action: "finder", app: "Finder" },
    ]);
    expect(actions).not.toContain("editor");
    expect(actions).not.toContain("diff");
    // 項目（開き方とアプリの組）は重ならない
    const keys = o.body.options.map((x) => `${x.action}:${x.app}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("dedupeOptions: 同じアプリを開く項目は Finder で表示 > エディタ > 差分ツール > ターミナル の1つだけ", () => {
    expect(
      dedupeOptions([
        { action: "session", app: "Ghostty" },
        { action: "diff", app: "Zed" },
        { action: "editor", app: "Zed" },
        { action: "finder", app: "Finder" },
        { action: "terminal", app: "Ghostty" },
        { action: "copy_resume", app: null },
      ]),
    ).toEqual([
      { action: "session", app: "Ghostty" },
      { action: "editor", app: "Zed" },
      { action: "finder", app: "Finder" },
      { action: "terminal", app: "Ghostty" },
      { action: "copy_resume", app: null },
    ]);
    expect(
      dedupeOptions([
        { action: "diff", app: "Finder" },
        { action: "editor", app: "Finder" },
        { action: "finder", app: "Finder" },
      ]),
    ).toEqual([{ action: "finder", app: "Finder" }]);
  });

  test("PR のレビュー: PR のページ / Files changed / エディタ。Zed が無ければ次のエディタ、無ければ Finder", async () => {
    const { call, fu } = await setup({ apps: ["/Applications/Cursor.app"] });
    setKind("review_pr");
    const o = await call<OpenOptions>("GET", `/api/open/options?followUpId=${fu}`);
    expect(o.body.options).toEqual([
      { action: "pr", app: null },
      { action: "pr_files", app: null },
      { action: "editor", app: "Cursor" },
    ]);
    await call("POST", "/api/open", { followUpId: fu });
    await call("POST", "/api/open", { followUpId: fu, action: "pr_files" });
    await call("POST", "/api/open", { followUpId: fu, action: "editor" });
    expect(env.open.runs).toEqual([
      [OPEN, "https://github.com/example/app/pull/7"],
      [OPEN, "https://github.com/example/app/pull/7/files"],
      [OPEN, "-a", "/Applications/Cursor.app", "/w/app"],
    ]);
  });

  test("変更の確認: 差分ツール（GitHub Desktop は --cli-open）/ エディタ・Finder・ターミナル。差分ツールが無ければエディタ", async () => {
    const { call, fu } = await setup();
    setKind("check_changes");
    const o = await call<OpenOptions>("GET", `/api/open/options?followUpId=${fu}`);
    expect(o.body.options).toEqual([
      { action: "diff", app: "GitHub Desktop" },
      { action: "editor", app: "Zed" },
      { action: "finder", app: "Finder" },
      { action: "terminal", app: "Ghostty" },
    ]);
    await call("POST", "/api/open", { followUpId: fu });
    expect(env.open.runs).toEqual([
      [OPEN, "-n", "/Applications/GitHub Desktop.app", "--args", "--cli-open=/w/app"],
    ]);
    env.open.fail = (a) => a.includes("/Applications/GitHub Desktop.app");
    const r = await call<OpenResult>("POST", "/api/open", { followUpId: fu });
    expect(r.body).toMatchObject({ outcome: "opened", app: "Zed" });
  });

  test("カードだけ（AI 詳細パネル）: open なタスクの既定を先頭に、開けるもの全部", async () => {
    const { call, wi } = await setup();
    const o = await call<OpenOptions>("GET", `/api/open/options?workItemId=${wi}`);
    expect(o.body.default).toBe("session");
    expect(o.body.options.map((x) => x.action)).toEqual([
      "session",
      "pr",
      "pr_files",
      "diff",
      "editor",
      "finder",
      "terminal",
      "copy_resume",
    ]);
    // カードから開いても対応中の印は付けない
    const r = await call<OpenResult>("POST", "/api/open", { workItemId: wi, action: "pr" });
    expect(r.body.engagedAt).toBeNull();
    expect(q("SELECT engaged_at FROM follow_up")).toEqual([{ engaged_at: null }]);
  });

  test("アプリの一覧（設定画面）: 設定・実際に使うもの・インストール済み", async () => {
    const { call } = await setup({ apps: ["/Applications/Cursor.app", "/Applications/Warp.app"] });
    const r = await call<OpenAppsResponse>("GET", "/api/open/apps");
    expect(r.body).toEqual({
      editor: {
        selected: "zed",
        effective: "cursor",
        installed: [{ id: "cursor", name: "Cursor" }],
      },
      terminal: {
        selected: "ghostty",
        effective: "warp",
        installed: [{ id: "warp", name: "Warp" }],
      },
      diff: { selected: "github_desktop", effective: null, installed: [] },
    });
  });
});

describe("安全（任意のパス・URL・コマンドを受け付けない）", () => {
  test("入力は ID と開き方の種類だけ。パス・URL・コマンドを送ると 400", async () => {
    const { call, fu, wi } = await setup();
    for (const body of [
      { followUpId: fu, path: "/etc" },
      { followUpId: fu, url: "https://evil.example/" },
      { followUpId: fu, command: "rm -rf ~" },
      { followUpId: fu, action: "shell" },
      { followUpId: fu, workItemId: wi },
      {},
      { workItemId: "/etc/passwd" },
    ]) {
      const r = await call<{ error: string }>("POST", "/api/open", body);
      expect([400, 404]).toContain(r.status);
    }
    expect((await call("GET", "/api/open/options?path=/etc")).status).toBe(400);
    expect(env.open.runs).toEqual([]);
  });

  test("DB の値も検証する: 実在しないフォルダ、github.com 以外の PR の URL、不正なセッション ID は開かない", async () => {
    const { call, fu, wi } = await setup();
    env.open.dirs.clear();
    expect((await call("POST", "/api/open", { followUpId: fu, action: "finder" })).status).toBe(
      409,
    );
    env.sqlite.run("UPDATE ai_artifact SET url = 'https://evil.example/x/pull/7', ref = 'x'");
    expect((await call("POST", "/api/open", { workItemId: wi, action: "pr" })).status).toBe(409);
    env.sqlite.run("UPDATE ai_session SET external_id = 'x; rm -rf ~'");
    expect((await call("POST", "/api/open", { followUpId: fu })).status).toBe(409);
    expect(env.open.runs).toEqual([]);
    expect((await call("POST", "/api/open", { followUpId: "nope" })).status).toBe(404);
  });

  test("検証の関数", () => {
    const sys = new FakeOpenSystem();
    sys.dirs.add("/w/app");
    expect(safeDir("/w/app", sys)).toBe("/w/app");
    expect(safeDir("/w/app/../app", sys)).toBeNull();
    expect(safeDir("w/app", sys)).toBeNull();
    expect(safeDir("/w/app\n", sys)).toBeNull();
    expect(safeDir("-a", sys)).toBeNull();
    expect(safePrUrl("https://github.com/o/r/pull/1")).toBe("https://github.com/o/r/pull/1");
    expect(safePrUrl("https://github.com.evil.example/o/r/pull/1")).toBeNull();
    expect(safePrUrl("http://github.com/o/r/pull/1")).toBeNull();
    expect(safePrUrl("javascript:alert(1)")).toBeNull();
    expect(
      resumeCommand(
        {
          tool: "claude_code",
          externalId: "abc",
          cwd: "/w/my app",
          rootPath: "/h/.claude-acme",
          entrypoint: null,
          livePid: null,
        },
        "/h",
        true,
      ),
    ).toBe("cd '/w/my app' && CLAUDE_CONFIG_DIR=/h/.claude-acme claude --resume abc");
    expect(
      outerApp("/Applications/T.app/Contents/Frameworks/T Helper.app/Contents/MacOS/T Helper"),
    ).toBe("/Applications/T.app");
    expect(outerApp("/bin/zsh")).toBeNull();
    expect(parsePsLine("  123 /usr/bin/login")).toEqual([123, "/usr/bin/login"]);
  });
});
