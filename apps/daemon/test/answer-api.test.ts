/**
 * Turnlane から答える（D-238、ADR 0019。m2-api 22章）の結合テスト: GET /api/work-items/:id/wait と
 * POST /api/work-items/:id/answer。OS は偽物（起動した引数を記録する）。本文はすべて合成のダミー。
 * 居場所はプロセスの一覧（ps）・tmux の一覧の偽の出力で作る
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LogFields, MetaOnlyLogger } from "@turnlane/collectors";
import { putSetting } from "@turnlane/core";
import type { AnswerResult, QueueResponse, WaitResponse } from "@turnlane/core/api";
import { GHOSTTY_WRITE, ITERM_WRITE, TERMINAL_WRITE } from "../src/answer/deliver.ts";
import { Answerer } from "../src/answer/index.ts";
import { createApp } from "../src/http/app.ts";
import { osc7 } from "../src/open/focus.ts";
import { LIST_CLIENTS_FORMAT, LIST_PANES_FORMAT } from "../src/open/locate.ts";
import { orcaCli } from "../src/open/orca.ts";
import { type AiEnv, makeAiEnv } from "./helpers/env.ts";
import { type ClaudeWriter, claudeTranscript } from "./helpers/transcript.ts";

const TOKEN = "a".repeat(64);
const HOST = "127.0.0.1:7317";
const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 2, 0, 0);
const TMUX = "/opt/homebrew/bin/tmux";
const OSA = "/usr/bin/osascript";
const SENTINEL = "SENTINEL_ANSWER_5d1e";
const HANDLE = "term_0a1b2c3d-4e5f-6789-abcd-ef0123456789";
const ORCA_APP = { id: "orca", name: "Orca", path: "/Applications/Orca.app" };
/** Ghostty の版と設定を読むコマンド（open/ghostty.ts。偽の OS の capture のキー） */
const GHOSTTY_VERSION_CMD =
  "/usr/bin/plutil -extract CFBundleShortVersionString raw -o - /Applications/Ghostty.app/Contents/Info.plist";
const GHOSTTY_CONFIG_CMD = "/Applications/Ghostty.app/Contents/MacOS/ghostty +show-config";

let env: AiEnv;
afterEach(async () => {
  await env?.cleanup();
});

const ps = (pid: number) => `/bin/ps -o ppid=,tty=,comm= -p ${pid}`;

type Where = "tmux" | "iterm" | "terminal" | "ghostty" | "warp" | "orca";

/** 返答待ち（AI の問い）・許可待ち・回答待ちのどれか 1 件と、その端末の居場所 */
async function setup(o: {
  /** ask_dialog: AskUserQuestion のダイアログに Claude Code が出す PermissionRequest（tool_use はまだ記録に無い） */
  wait: "question" | "permission" | "ask" | "ask_dialog";
  where: Where;
  /** 今の時刻（止まってからの分。既定 19 分 = 猶予の後） */
  afterMin?: number;
}) {
  env = makeAiEnv({ now: T0 });
  putSetting(env.mutate, "ui.language", "ja");
  env.git.repos.set("/w/app", "/w/app");
  env.git.defaults.set("/w/app", "main");
  env.open.dirs.add("/w/app");
  for (const a of [
    "/Applications/Ghostty.app",
    "/Applications/iTerm.app",
    "/Applications/Orca.app",
    "/System/Applications/Utilities/Terminal.app",
    "/Applications/Warp.app",
  ])
    env.open.files.add(a);
  const app = createApp({
    token: TOKEN,
    port: 7317,
    hub: env.hub,
    health: () => ({}) as never,
    admin: { backup: () => ({ date: "", path: "" }) },
    ai: () => env.ai.deps,
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
    return { status: r.status, headers: r.headers, body: (await r.json()) as T };
  };
  const root = join(env.home, ".claude");
  const sid = "77777777-0000-4000-8000-000000000001";
  const spool = join(env.dataDir, "spool");
  mkdirSync(spool, { recursive: true });
  const hooks: string[] = [];
  const hook = (name: string, at: number, extra: Record<string, string> = {}) => {
    hooks.push(
      JSON.stringify({
        v: 1,
        tool: "claude_code",
        received_at: at,
        config_root: root,
        hook_event_name: name,
        session_id: sid,
        ...(o.where === "orca" ? { term: HANDLE } : {}),
        ...extra,
      }),
    );
    writeFileSync(join(spool, "hooks-20261002.jsonl"), `${hooks.join("\n")}\n`);
  };
  const tr = claudeTranscript(root, { sid, cwd: "/w/app", branch: "feat/answer" });
  tr.human(T0, { text: "列の幅を直して" });
  hook("UserPromptSubmit", T0);
  if (o.wait === "question") {
    tr.assistantEnd(
      T0 + MIN,
      `左の列は直しました。${SENTINEL} 右の列はどうしますか？\n1. 同じ幅にする\n2. そのまま`,
    );
    hook("Stop", T0 + MIN);
  } else if (o.wait === "permission") {
    tr.toolUse(T0 + MIN, "Bash", { command: "bun test", description: "Run tests" });
    hook("PermissionRequest", T0 + MIN, { tool_name: "Bash" });
  } else if (o.wait === "ask_dialog") {
    hook("PermissionRequest", T0 + MIN, { tool_name: "AskUserQuestion" });
  } else {
    tr.ask(T0 + MIN, [{ question: "デプロイ先は?", options: ["staging", "production"] }]);
  }
  const now = T0 + MIN + (o.afterMin ?? 19) * MIN;
  env.clock.set(now);
  await env.sync();
  env.sqlite.run(
    "UPDATE ai_session SET live_status = 'idle', live_pid = 4242, live_checked_at = ?",
    [now],
  );
  // 居場所: claude（ttys007）→ シェル → 端末のアプリ（tmux の中ならクライアントの端末）
  env.open.outputs.set(ps(4242), "4000 ttys007 claude");
  if (o.where === "tmux") {
    env.open.outputs.set(ps(4000), `3900 ttys007 ${TMUX}`);
    env.open.outputs.set(`/bin/ps -o args= -p 4000`, "tmux -L work new-session");
    env.open.outputs.set(
      [TMUX, "-u", "-L", "work", "list-panes", "-a", "-F", LIST_PANES_FORMAT].join(" "),
      "/dev/ttys007\t%3\tmain\t1\t0\n",
    );
    env.open.outputs.set(
      [TMUX, "-u", "-L", "work", "list-clients", "-F", LIST_CLIENTS_FORMAT].join(" "),
      "/dev/ttys002\t5000\tmain\t100\n",
    );
    env.open.outputs.set(ps(5000), "4900 ttys002 tmux");
    env.open.outputs.set(ps(4900), "1 ?? /Applications/Ghostty.app/Contents/MacOS/ghostty");
  } else {
    env.open.outputs.set(ps(4000), "3900 ttys007 -zsh");
    env.open.outputs.set(
      ps(3900),
      o.where === "iterm"
        ? "1 ?? /Applications/iTerm.app/Contents/MacOS/iTerm2"
        : o.where === "terminal"
          ? "1 ?? /System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal"
          : o.where === "orca"
            ? "1 ?? /Applications/Orca.app/Contents/MacOS/Orca"
            : o.where === "warp"
              ? "1 ?? /Applications/Warp.app/Contents/MacOS/stable"
              : "1 ?? /Applications/Ghostty.app/Contents/MacOS/ghostty",
    );
  }
  if (o.where === "orca")
    env.open.outputs.set(
      [...orcaCli(ORCA_APP), "terminal", "list", "--json"].join(" "),
      JSON.stringify({
        ok: true,
        result: {
          terminals: [
            {
              handle: HANDLE,
              worktreePath: "/w/app",
              tabId: "tab-1",
              title: SENTINEL,
              preview: SENTINEL,
              connected: true,
              writable: true,
            },
          ],
        },
      }),
    );
  // 猶予の間はフォローアップが無いので、カードから取る
  const wi =
    env.sqlite.query<{ id: string }, []>("SELECT work_item_id AS id FROM follow_up").get()?.id ??
    env.sqlite.query<{ id: string }, []>("SELECT id FROM work_item WHERE deleted_at IS NULL").get()
      ?.id ??
    "none";
  return { call, tr, wi, hook };
}

/** 端末に送ったとき（Enter・write text・send）に、Claude が自分の指示を記録に書いた形にする */
function claudeReactsTo(tr: ClaudeWriter, react: (argv: readonly string[]) => boolean) {
  const run = env.open.run.bind(env.open);
  env.open.run = async (argv, opts) => {
    const ok = await run(argv, opts);
    if (react(argv)) tr.human(T0 + 21 * MIN, { text: "(answer)" });
    return ok;
  };
}

function captureLogger(): { logger: MetaOnlyLogger; lines: [string, LogFields | undefined][] } {
  const lines: [string, LogFields | undefined][] = [];
  const push = (e: string, f?: LogFields) => void lines.push([e, f]);
  return { lines, logger: { debug: push, info: push, warn: push, error: push } };
}

function answerer(over: Partial<ConstructorParameters<typeof Answerer>[0]> = {}) {
  return new Answerer({
    sqlite: env.sqlite,
    sys: env.open,
    opener: env.ai.deps.opener,
    logger: captureLogger().logger,
    home: env.home,
    now: () => env.clock.now(),
    locale: () => "ja",
    enabled: () => true,
    showDetail: () => true,
    sleep: async () => {},
    sessionWait: (id) => env.ai.runner.sessionWait(id),
    ...over,
  });
}

describe("GET /api/work-items/:id/wait（D-238）", () => {
  test("AI の問い: 全文（伏せ字済み）と番号付きの選択肢、届け先（tmux のペイン）。no-store", async () => {
    const { call, wi } = await setup({ wait: "question", where: "tmux" });
    const r = await call<WaitResponse>("GET", `/api/work-items/${wi}/wait`);
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.body).toMatchObject({
      kind: "question",
      canAllow: false,
      options: [
        { n: 1, label: "同じ幅にする" },
        { n: 2, label: "そのまま" },
      ],
      delivery: {
        deliverable: true,
        via: "tmux",
        terminal: "Ghostty",
        landing: "Ghostty · main:1.0",
        multiline: true,
      },
    });
    expect(r.body.question?.text).toContain("右の列はどうしますか？");
    expect(r.body.question?.truncated).toBe(false);
    // 読むだけ（何も起動しない）
    expect(env.open.runs).toEqual([]);
  });

  test("問いの全文は 2,000 字で切って truncated", async () => {
    const { wi, tr } = await setup({ wait: "question", where: "tmux" });
    tr.assistantEnd(T0 + 2 * MIN, `${"あ".repeat(2500)}どうしますか？`);
    await env.sync();
    const w = await answerer().wait(wi);
    expect(w?.question?.text.length).toBe(2000);
    expect(w?.question?.truncated).toBe(true);
  });

  test("許可待ち: ツールと中身、許可する（canAllow）。回答待ち: 問いと選択肢", async () => {
    const p = await setup({ wait: "permission", where: "iterm" });
    const w = await p.call<WaitResponse>("GET", `/api/work-items/${p.wi}/wait`);
    expect(w.body).toMatchObject({
      kind: "permission",
      canAllow: true,
      permission: { tool: "Bash", label: "Run tests", detail: "bun test" },
      delivery: { deliverable: true, via: "iterm", terminal: "iTerm2", landing: "iTerm2 · タブ" },
    });
    await env.cleanup();
    const a = await setup({ wait: "ask", where: "tmux" });
    const k = await a.call<WaitResponse>("GET", `/api/work-items/${a.wi}/wait`);
    expect(k.body).toMatchObject({
      kind: "ask",
      question: { text: "デプロイ先は?" },
      options: [
        { n: 1, label: "staging" },
        { n: 2, label: "production" },
      ],
    });
  });

  test("送れない端末（tmux の外の Warp）: deliverable false と理由。設定がオフなら off", async () => {
    const { call, wi } = await setup({ wait: "question", where: "warp" });
    const w = await call<WaitResponse>("GET", `/api/work-items/${wi}/wait`);
    expect(w.body.delivery).toEqual({
      deliverable: false,
      via: null,
      terminal: "Warp",
      landing: null,
      multiline: false,
      reason: "unsupported",
    });
    putSetting(env.mutate, "turn.answer", false);
    const off = await call<WaitResponse>("GET", `/api/work-items/${wi}/wait`);
    expect(off.body.delivery).toMatchObject({ deliverable: false, reason: "off" });
    // 動いていないセッションは not_live
    putSetting(env.mutate, "turn.answer", true);
    env.sqlite.run("UPDATE ai_session SET live_checked_at = ?", [T0 - 10 * MIN]);
    const gone = await call<WaitResponse>("GET", `/api/work-items/${wi}/wait`);
    expect(gone.body.delivery).toMatchObject({ deliverable: false, reason: "not_live" });
  });

  test("Orca: hooks が記録したハンドルの端末。list の画面の中身・題名は応答に出さない", async () => {
    const { call, wi } = await setup({ wait: "question", where: "orca" });
    const w = await call<WaitResponse>("GET", `/api/work-items/${wi}/wait`);
    expect(w.body.delivery).toMatchObject({
      deliverable: true,
      via: "orca",
      terminal: "Orca",
      landing: "Orca · タブ",
      multiline: false,
    });
    // 問いの本文は応答に入る（表示の瞬間）が、Orca の画面の中身（preview・title）は入らない
    const raw = JSON.stringify({ ...w.body, question: undefined });
    expect(raw).not.toContain(SENTINEL);
  });
});

describe("POST /api/work-items/:id/answer（D-238）", () => {
  test("tmux: 文字のまま送って Enter、記録が進めば confirmed。確かめられたらタブは前に出さない（D-241）。ログは文字数と届け先だけ", async () => {
    const { wi, tr } = await setup({ wait: "question", where: "tmux" });
    claudeReactsTo(tr, (a) => a.at(-1) === "Enter");
    const log = captureLogger();
    const r = await answerer({ logger: log.logger }).answer(wi, { text: `同じ幅に\n${SENTINEL}` });
    expect(r).toMatchObject({
      delivered: true,
      confirmed: true,
      via: "tmux",
      app: "Ghostty",
      landing: "Ghostty · main:1.0",
      message: "送りました · Ghostty · main:1.0",
      folded: false,
    });
    const base = [TMUX, "-u", "-L", "work", "send-keys", "-t", "%3"];
    expect(env.open.runs.slice(0, 2)).toEqual([
      [...base, "-l", "--", `同じ幅に\n${SENTINEL}`],
      [...base, "Enter"],
    ]);
    // 確かめられたので「開く」は呼ばない（Turnlane に留まり、知らせが見える。D-241）
    expect(env.open.runs).toHaveLength(2);
    expect(r.focus).toBeNull();
    expect(log.lines as unknown[]).toEqual([
      [
        "answer.sent",
        { chars: SENTINEL.length + 5, via: "tmux", allow: false, confirmed: true, folded: false },
      ],
    ]);
    expect(JSON.stringify(log.lines)).not.toContain(SENTINEL);
    // 答えは保存しない（DB のどこにも入らない）
    for (const t of ["follow_up", "wait_detail", "ai_instruction", "setting", "hook_event"])
      expect(JSON.stringify(env.sqlite.query(`SELECT * FROM ${t}`).all())).not.toContain(SENTINEL);
    // 開いていないので対応中の印も付かない
    expect(
      env.sqlite.query<{ e: number | null }, []>("SELECT engaged_at AS e FROM follow_up").get()?.e,
    ).toBeNull();
  });

  test("記録が進まなければ confirmed: false。このときだけタブを前に出す（D-241）", async () => {
    const { wi } = await setup({ wait: "question", where: "tmux" });
    const r = await answerer().answer(wi, { text: "そのまま" });
    expect(r.confirmed).toBe(false);
    expect(r.message).toBe("送りましたが進んだか確認できません · Ghostty · main:1.0");
    expect(env.open.runs.some((a) => a.includes("select-pane"))).toBe(true);
    // 対応中の印（開くと同じ）
    expect(
      env.sqlite.query<{ e: number | null }, []>("SELECT engaged_at AS e FROM follow_up").get()?.e,
    ).not.toBeNull();
  });

  test("待ちが閉じていれば 409 wait_closed で送らない", async () => {
    const { call, wi, tr } = await setup({ wait: "question", where: "tmux" });
    tr.human(T0 + 21 * MIN, { text: "もう答えた" });
    const r = await call<{ error: string }>("POST", `/api/work-items/${wi}/answer`, { text: "x" });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("wait_closed");
    expect(env.open.runs).toEqual([]);
  });

  test("iTerm2: 複数行は 1 行に畳んで write text", async () => {
    const { wi, tr } = await setup({ wait: "question", where: "iterm" });
    claudeReactsTo(tr, (a) => a[0] === OSA && a[2] === ITERM_WRITE);
    const r = await answerer().answer(wi, { text: "同じ幅に\n\nしてください" });
    expect(r).toMatchObject({ via: "iterm", app: "iTerm2", confirmed: true, folded: true });
    expect(env.open.runs[0]).toEqual([
      OSA,
      "-e",
      ITERM_WRITE,
      "/dev/ttys007",
      "同じ幅に してください",
    ]);
  });

  test("Terminal（ターミナル.app。D-243）: 届け先は tty のタブ。複数行は 1 行に畳んで do script。許可するは 1", async () => {
    const p = await setup({ wait: "question", where: "terminal" });
    const w = await p.call<WaitResponse>("GET", `/api/work-items/${p.wi}/wait`);
    expect(w.body.delivery).toEqual({
      deliverable: true,
      via: "terminal",
      terminal: "Terminal",
      landing: "ターミナル · タブ",
      multiline: false,
    });
    claudeReactsTo(p.tr, (a) => a[0] === OSA && a[2] === TERMINAL_WRITE);
    const r = await answerer().answer(p.wi, { text: '右も "同じ" 幅に;\n\nして \\ ください' });
    expect(r).toMatchObject({
      via: "terminal",
      app: "Terminal",
      confirmed: true,
      folded: true,
      landing: "ターミナル · タブ",
      focus: null,
    });
    expect(env.open.runs[0]).toEqual([
      OSA,
      "-e",
      TERMINAL_WRITE,
      "/dev/ttys007",
      '右も "同じ" 幅に; して \\ ください',
    ]);
    await env.cleanup();
    const a = await setup({ wait: "permission", where: "terminal" });
    const aw = await a.call<WaitResponse>("GET", `/api/work-items/${a.wi}/wait`);
    expect(aw.body.canAllow).toBe(true);
    claudeReactsTo(a.tr, (x) => x[0] === OSA && x[2] === TERMINAL_WRITE);
    await answerer().answer(a.wi, { allow: true });
    expect(env.open.runs[0]).toEqual([OSA, "-e", TERMINAL_WRITE, "/dev/ttys007", "1"]);
  });

  test("Ghostty（tmux の外。D-244）: 「開く」と同じ目印で選んだ端末に input text と send key。目印は送った後に戻す。1 つに決まらなければ送らない。AppleScript を切っていれば送れない端末", async () => {
    const p = await setup({ wait: "question", where: "ghostty" });
    env.open.outputs.set(GHOSTTY_VERSION_CMD, "1.3.1\n");
    env.open.outputs.set(GHOSTTY_CONFIG_CMD, "font-size = 13\n");
    const w = await p.call<WaitResponse>("GET", `/api/work-items/${p.wi}/wait`);
    expect(w.body.delivery).toEqual({
      deliverable: true,
      via: "ghostty",
      terminal: "Ghostty",
      landing: "Ghostty · タブ",
      multiline: false,
    });
    // 表示するだけでは目印を書かない
    expect(env.open.ttyWrites).toEqual([]);
    claudeReactsTo(p.tr, (a) => a[0] === OSA && a[2] === GHOSTTY_WRITE);
    const r = await answerer().answer(p.wi, { text: '右も "同じ" 幅に;\n\nして \\ ください' });
    expect(r).toMatchObject({
      via: "ghostty",
      app: "Ghostty",
      confirmed: true,
      folded: true,
      landing: "Ghostty · タブ",
      focus: null,
    });
    const marker = env.open.runs[0]?.[3] as string;
    expect(marker).toMatch(/turnlane-focus-[0-9a-f]{12}$/);
    expect(env.open.runs).toEqual([
      [OSA, "-e", GHOSTTY_WRITE, marker, '右も "同じ" 幅に; して \\ ください'],
    ]);
    // 目印: 作る → tty に書く → 送る → 元の cwd に戻す → 消す
    expect(env.open.madeDirs).toEqual([marker]);
    expect(env.open.ttyWrites).toEqual([
      { tty: "/dev/ttys007", data: osc7(marker) },
      { tty: "/dev/ttys007", data: osc7("/w/app") },
    ]);
    expect(env.open.removedDirs).toEqual([marker]);

    // 目印の端末が 1 つに決まらない（複数・無し）: 409 undeliverable（送っていない）。目印は戻す。確かめのために前に出さない
    await env.cleanup();
    const m = await setup({ wait: "question", where: "ghostty" });
    env.open.outputs.set(GHOSTTY_VERSION_CMD, "1.3.1\n");
    env.open.outputs.set(GHOSTTY_CONFIG_CMD, "");
    env.open.fail = (a) => a[2] === GHOSTTY_WRITE;
    env.open.failWhy = () => ({ stderr: "0:40: execution error: ambiguous (2)" });
    const amb = await m.call<{ error: string }>("POST", `/api/work-items/${m.wi}/answer`, {
      text: "x",
    });
    expect([amb.status, amb.body.error]).toEqual([409, "undeliverable"]);
    expect(env.open.runs.map((a) => a[2])).toEqual([GHOSTTY_WRITE]);
    expect(env.open.ttyWrites.at(-1)).toEqual({ tty: "/dev/ttys007", data: osc7("/w/app") });
    expect(env.open.removedDirs).toHaveLength(1);
    // 応答しない（AppleScript を切っている等）: 409 undeliverable、しばらく送れない端末として出す
    env.open.failWhy = () => ({ stderr: "execution error: AppleEvent handler failed. (-10000)" });
    const off = await m.call<{ error: string }>("POST", `/api/work-items/${m.wi}/answer`, {
      text: "x",
    });
    expect([off.status, off.body.error]).toEqual([409, "undeliverable"]);
    const after = await m.call<WaitResponse>("GET", `/api/work-items/${m.wi}/wait`);
    expect(after.body.delivery).toMatchObject({ deliverable: false, reason: "unsupported" });

    // 許可する: 1 と Enter（同じ経路）
    await env.cleanup();
    const a = await setup({ wait: "permission", where: "ghostty" });
    env.open.outputs.set(GHOSTTY_VERSION_CMD, "1.3.1\n");
    env.open.outputs.set(GHOSTTY_CONFIG_CMD, "");
    const aw = await a.call<WaitResponse>("GET", `/api/work-items/${a.wi}/wait`);
    expect(aw.body.canAllow).toBe(true);
    claudeReactsTo(a.tr, (x) => x[0] === OSA && x[2] === GHOSTTY_WRITE);
    await answerer().answer(a.wi, { allow: true });
    expect(env.open.runs[0]?.slice(0, 3)).toEqual([OSA, "-e", GHOSTTY_WRITE]);
    expect(env.open.runs[0]?.[4]).toBe("1");

    // macos-applescript = false（設定で切っている）: 送れない端末。「開く」は今までどおり目印でタブを前に出す
    await env.cleanup();
    const c = await setup({ wait: "question", where: "ghostty" });
    env.open.outputs.set(GHOSTTY_VERSION_CMD, "1.3.1\n");
    env.open.outputs.set(GHOSTTY_CONFIG_CMD, "macos-applescript = false\n");
    const cw = await c.call<WaitResponse>("GET", `/api/work-items/${c.wi}/wait`);
    expect(cw.body.delivery).toEqual({
      deliverable: false,
      via: null,
      terminal: "Ghostty",
      landing: null,
      multiline: false,
      reason: "unsupported",
    });
  });

  test("Orca: terminal send（受理と送信の観測）。観測できれば confirmed で留まる。確かめられなければ orca terminal switch でそのタブ", async () => {
    const { wi } = await setup({ wait: "question", where: "orca" });
    const cli = orcaCli(ORCA_APP);
    env.open.stdout = (a) =>
      a.includes("send")
        ? JSON.stringify({
            ok: true,
            result: {
              send: { accepted: true, prompt: { stages: ["input_accepted", "turn_started"] } },
            },
          })
        : "{}";
    const r = await answerer().answer(wi, { text: "同じ幅に" });
    expect(r).toMatchObject({ via: "orca", app: "Orca", confirmed: true, landing: "Orca · タブ" });
    expect(env.open.runs[0]).toEqual([
      ...cli,
      "terminal",
      "send",
      `--terminal=${HANDLE}`,
      "--text=同じ幅に",
      "--enter",
      "--wait-submit",
      "5",
      "--json",
    ]);
    // 確かめられたので Orca のタブには切り替えない（Turnlane に留まる。D-241）
    const sw = [...cli, "terminal", "switch", `--terminal=${HANDLE}`, "--json"];
    expect(env.open.runs).not.toContainEqual(sw);
    expect(r.focus).toBeNull();
    // 受理されたが送信を観測できず、記録も進まなければ confirmed: false。このときは orca terminal switch でそのタブへ
    env.open.runs.length = 0;
    env.open.stdout = (a) =>
      a.includes("send")
        ? JSON.stringify({
            ok: true,
            result: { send: { accepted: true, prompt: { stages: ["input_accepted"] } } },
          })
        : "{}";
    const u = await answerer().answer(wi, { text: "同じ幅に" });
    expect(u.confirmed).toBe(false);
    expect(env.open.runs).toContainEqual(sw);
    expect(u.focus).toMatchObject({ level: "tab", by: "handle" });
    // 受理されなければ 409 send_failed
    env.open.stdout = () =>
      JSON.stringify({ ok: true, result: { send: { accepted: false, refusedReason: "x" } } });
    await expect(answerer().answer(wi, { text: "x" })).rejects.toMatchObject({
      status: 409,
      message: "send_failed",
    });
  });

  test("許可待ち: 許可する = 1 と Enter（今後も許可は送らない）。問いには allow を受け付けない", async () => {
    const { call, wi } = await setup({ wait: "permission", where: "tmux" });
    const r = await call<AnswerResult>("POST", `/api/work-items/${wi}/answer`, { allow: true });
    expect(r.status).toBe(200);
    const base = [TMUX, "-u", "-L", "work", "send-keys", "-t", "%3"];
    expect(env.open.runs.slice(0, 2)).toEqual([
      [...base, "-l", "--", "1"],
      [...base, "Enter"],
    ]);
    expect(env.open.runs.flat()).not.toContain("2");
    await env.cleanup();
    const q = await setup({ wait: "question", where: "tmux" });
    const bad = await q.call<{ error: string }>("POST", `/api/work-items/${q.wi}/answer`, {
      allow: true,
    });
    expect(bad.status).toBe(400);
  });

  test("AskUserQuestion のダイアログの PermissionRequest（tool_use は記録にまだ無い）: 問いとして扱い、許可するは出さない。閉じたと言わずに送る", async () => {
    const { call, wi } = await setup({ wait: "ask_dialog", where: "tmux" });
    const fu = env.sqlite.query<{ kind: string }, []>("SELECT kind FROM follow_up").get();
    expect(fu?.kind).toBe("approve");
    const w = await call<WaitResponse>("GET", `/api/work-items/${wi}/wait`);
    expect(w.status).toBe(200);
    expect(w.body).toMatchObject({
      kind: "ask",
      unavailable: "unreadable",
      canAllow: false,
      delivery: { deliverable: true, via: "tmux", terminal: "Ghostty" },
    });
    const bad = await call<{ error: string }>("POST", `/api/work-items/${wi}/answer`, {
      allow: true,
    });
    expect(bad.status).toBe(400);
    const r = await call<AnswerResult>("POST", `/api/work-items/${wi}/answer`, { text: "2" });
    expect(r.status).toBe(200);
    // 記録で確かめられない（tool_use が無い）ので confirmed にはしない
    expect(r.body).toMatchObject({ delivered: true, via: "tmux", confirmed: false });
    const base = [TMUX, "-u", "-L", "work", "send-keys", "-t", "%3"];
    expect(env.open.runs.slice(0, 2)).toEqual([
      [...base, "-l", "--", "2"],
      [...base, "Enter"],
    ]);
  });

  test("送れない端末は 409 undeliverable。設定がオフは 409 answer_off。入力の検証（空・長すぎ・余計なキー）は 400", async () => {
    const { call, wi } = await setup({ wait: "question", where: "warp" });
    const u = await call<{ error: string }>("POST", `/api/work-items/${wi}/answer`, { text: "x" });
    expect([u.status, u.body.error]).toEqual([409, "undeliverable"]);
    for (const body of [{ text: "" }, { text: "a".repeat(4001) }, { text: "x", path: "/tmp" }, {}])
      expect((await call("POST", `/api/work-items/${wi}/answer`, body)).status).toBe(400);
    putSetting(env.mutate, "turn.answer", false);
    const off = await call<{ error: string }>("POST", `/api/work-items/${wi}/answer`, {
      text: "x",
    });
    expect([off.status, off.body.error]).toEqual([409, "answer_off"]);
    expect(env.open.runs).toEqual([]);
  });
});

describe("猶予の間の問い（D-240）: 答えるの対象は待ちそのもの", () => {
  test("在席中に問いで止まって 3 分: 返答タスクはまだ無いが、wait は question を返し、queue には出ない", async () => {
    const { call, wi } = await setup({ wait: "question", where: "tmux", afterMin: 3 });
    expect(env.sqlite.query("SELECT id FROM follow_up").all()).toEqual([]);
    const r = await call<WaitResponse>("GET", `/api/work-items/${wi}/wait`);
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.body).toMatchObject({
      followUpId: null,
      kind: "question",
      options: [
        { n: 1, label: "同じ幅にする" },
        { n: 2, label: "そのまま" },
      ],
      delivery: { deliverable: true, via: "tmux", landing: "Ghostty · main:1.0" },
    });
    expect(r.body.question?.text).toContain("右の列はどうしますか？");
    // 詳細には答える対象が付く。自分の番の行（queue）は猶予の後のまま
    const d = await call<{ openWait?: unknown }>("GET", `/api/work-items/${wi}`);
    expect(d.body.openWait).toMatchObject({ kind: "question", followUpId: null });
    const q = await call<{ items: unknown[] }>("GET", "/api/queue");
    expect(q.body.items).toEqual([]);
  });

  test("猶予の間の問いは GET /api/queue の grace に出る（D-245）: followUps は空、wait は question、until は止まった時刻 + 15 分。items と件数には入れない", async () => {
    const { call, wi } = await setup({ wait: "question", where: "tmux", afterMin: 3 });
    const q = await call<QueueResponse>("GET", "/api/queue");
    expect(q.body.items).toEqual([]);
    expect(q.body.grace).toHaveLength(1);
    expect(q.body.grace?.[0]).toMatchObject({
      workItemId: wi,
      followUps: [],
      status: "your_turn",
      wait: { kind: "question", followUpId: null },
    });
    // 止まった時刻（ターンの終わり）から猶予 15 分
    const g0 = q.body.grace?.[0];
    expect(Math.abs((g0?.waitingSince ?? 0) - (T0 + MIN))).toBeLessThan(1000);
    expect(g0?.grace?.until).toBe((g0?.waitingSince ?? 0) + 15 * MIN);
    const sum = await call<{ count: number }>("GET", "/api/queue/summary");
    expect(sum.body.count).toBe(0);
    // 行の理由（問いの 1 行）は普通の行と同じく glance で読む
    const g = await call<{ kind: string; question?: { row: string } }>(
      "GET",
      `/api/work-items/${wi}/glance`,
    );
    expect(g.body.kind).toBe("question");
    expect(g.body.question?.row).toContain("右の列はどうしますか？");
  });

  test("猶予が過ぎて返答タスクができたら、同じ workItemId のまま items の普通の行になり grace から消える（D-245）", async () => {
    const { call, wi } = await setup({ wait: "question", where: "tmux", afterMin: 3 });
    expect((await call<QueueResponse>("GET", "/api/queue")).body.grace?.[0]?.workItemId).toBe(wi);
    env.clock.set(T0 + MIN + 16 * MIN);
    await env.sync();
    const q = await call<QueueResponse>("GET", "/api/queue");
    expect(q.body.grace).toEqual([]);
    expect(q.body.items.map((x) => x.workItemId)).toEqual([wi]);
    expect(q.body.items[0]?.followUps[0]?.kind).toBe("reply");
  });

  test("猶予の間でも、そのターンの返答タスクが閉じている（対応不要など）・返答タスクを作らない設定なら grace に出さない", async () => {
    const a = await setup({ wait: "question", where: "tmux", afterMin: 16 });
    const fu = env.sqlite.query<{ id: string }, []>("SELECT id FROM follow_up").get()?.id ?? "";
    env.sqlite.run("UPDATE follow_up SET status = 'done', closed_at = ? WHERE id = ?", [
      env.clock.now(),
      fu,
    ]);
    expect((await a.call<QueueResponse>("GET", "/api/queue")).body.grace).toEqual([]);
    await env.cleanup();
    const b = await setup({ wait: "question", where: "tmux", afterMin: 3 });
    putSetting(env.mutate, "followup.kinds", { reply: false });
    expect((await b.call<QueueResponse>("GET", "/api/queue")).body.grace).toEqual([]);
  });

  test("猶予の間に答える: 409 にならずに送る（フォローアップ前提の対応中の印は付けない）", async () => {
    const { call, wi, tr } = await setup({ wait: "question", where: "tmux", afterMin: 3 });
    claudeReactsTo(tr, (a) => a.at(-1) === "Enter");
    const r = await call<AnswerResult>("POST", `/api/work-items/${wi}/answer`, {
      text: "同じ幅に",
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ delivered: true, confirmed: true, via: "tmux" });
    const base = [TMUX, "-u", "-L", "work", "send-keys", "-t", "%3"];
    expect(env.open.runs.slice(0, 2)).toEqual([
      [...base, "-l", "--", "同じ幅に"],
      [...base, "Enter"],
    ]);
    // 確かめられたのでタブは前に出さない（D-241）
    expect(env.open.runs).toHaveLength(2);
    expect(env.sqlite.query("SELECT id FROM follow_up").all()).toEqual([]);
  });

  test("猶予の後は返答タスクに付く（followUpId）。待ちの種類は同じ", async () => {
    const { call, wi } = await setup({ wait: "question", where: "tmux", afterMin: 16 });
    const fu = env.sqlite.query<{ id: string }, []>("SELECT id FROM follow_up").get()?.id;
    expect(fu).toBeString();
    const r = await call<WaitResponse>("GET", `/api/work-items/${wi}/wait`);
    expect(r.body).toMatchObject({ kind: "question", followUpId: fu });
    const q = await call<{ items: { wait?: unknown }[] }>("GET", "/api/queue");
    expect(q.body.items[0]?.wait).toMatchObject({ kind: "question", followUpId: fu });
  });

  test("猶予の間に閉じたら 409 wait_closed で送らない（記録の末尾・判定の両方）", async () => {
    const a = await setup({ wait: "question", where: "tmux", afterMin: 3 });
    // 端末で答えた（記録に自分の指示）。判定はまだ回っていない → 記録の末尾で閉じたと分かる
    a.tr.human(T0 + 4 * MIN, { text: "もう答えた" });
    const r = await a.call<{ error: string }>("POST", `/api/work-items/${a.wi}/answer`, {
      text: "x",
    });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("wait_closed");
    // 判定が回った後は待ち自体が無い（wait は none、answer は 409）。Claude は答えを受けて動いている
    env.sqlite.run("UPDATE ai_session SET live_status = 'busy'");
    await env.sync();
    const w = await a.call<WaitResponse>("GET", `/api/work-items/${a.wi}/wait`);
    expect(w.body.kind).toBe("none");
    const r2 = await a.call<{ error: string }>("POST", `/api/work-items/${a.wi}/answer`, {
      text: "x",
    });
    expect(r2.status).toBe(409);
    expect(env.open.runs).toEqual([]);
  });

  test("設定「Turnlane から答える」がオフ: wait の届け先は off、answer は 409 answer_off", async () => {
    const { call, wi } = await setup({ wait: "question", where: "tmux", afterMin: 3 });
    putSetting(env.mutate, "turn.answer", false);
    const w = await call<WaitResponse>("GET", `/api/work-items/${wi}/wait`);
    expect(w.body.delivery).toMatchObject({ deliverable: false, reason: "off" });
    const r = await call<{ error: string }>("POST", `/api/work-items/${wi}/answer`, { text: "x" });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("answer_off");
  });
});
