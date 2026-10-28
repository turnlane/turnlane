/**
 * 次の指示（Issue #9、ADR 0019 の Decision 11。m2-api 35章）の結合テスト: GET /last-reply の instruct と
 * POST /api/work-items/:id/instruct。OS は偽物（起動した引数を記録する）。本文はすべて合成のダミー
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { LogFields, MetaOnlyLogger } from "@turnlane/collectors";
import { putSetting } from "@turnlane/core";
import type { InstructResult, LastReplyResponse } from "@turnlane/core/api";
import { Answerer } from "../src/answer/index.ts";
import { OpError } from "../src/derive/ops.ts";
import { createApp } from "../src/http/app.ts";
import { LIST_CLIENTS_FORMAT, LIST_PANES_FORMAT } from "../src/open/locate.ts";
import { type AiEnv, makeAiEnv } from "./helpers/env.ts";
import { type ClaudeWriter, claudeTranscript, codexRollout } from "./helpers/transcript.ts";

const TOKEN = "d".repeat(64);
const HOST = "127.0.0.1:7317";
const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 2, 0, 0);
const TMUX = "/opt/homebrew/bin/tmux";
const SENTINEL = "SENTINEL_INSTRUCT_3f8d";
const SID = "aaaaaaaa-0000-4000-8000-000000000001";

let env: AiEnv;
afterEach(async () => {
  await env?.cleanup();
});

const ps = (pid: number) => `/bin/ps -o ppid=,tty=,comm= -p ${pid}`;

type Turn = "ended" | "running" | "question";
type Proc = "alive" | "gone" | "stale";
type Tab = "tmux" | "warp" | "none";

/** 最後のターンの形・プロセス・端末のタブの居場所を作る */
async function setup(o: { turn?: Turn; proc?: Proc; tab?: Tab } = {}) {
  const turn = o.turn ?? "ended";
  const proc = o.proc ?? "alive";
  const tab = o.tab ?? "tmux";
  env = makeAiEnv({ now: T0 });
  putSetting(env.mutate, "ui.language", "ja");
  env.git.repos.set("/w/app", "/w/app");
  env.git.defaults.set("/w/app", "main");
  env.open.dirs.add("/w/app");
  for (const a of ["/Applications/Ghostty.app", "/Applications/Warp.app"]) env.open.files.add(a);
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
  const tr = claudeTranscript(join(env.home, ".claude"), {
    sid: SID,
    cwd: "/w/app",
    branch: "feat/next",
  });
  tr.human(T0, { text: "列の幅を直して" });
  if (turn === "ended") tr.assistantEnd(T0 + MIN, "直しました。テストも通っています。");
  else if (turn === "question") tr.assistantEnd(T0 + MIN, "右の列はどうしますか？");
  else {
    tr.assistantText(T0 + MIN - 1000, "テストを走らせます。");
    tr.toolUse(T0 + MIN, "Bash", { command: "bun test" });
  }
  const now = T0 + 20 * MIN;
  env.clock.set(now);
  await env.sync();
  env.sqlite.run(
    "UPDATE ai_session SET live_status = ?, live_pid = 4242, live_checked_at = ?",
    proc === "gone"
      ? ["gone", now]
      : proc === "stale"
        ? ["idle", now - 10 * MIN]
        : [turn === "running" ? "busy" : "idle", now],
  );
  if (tab !== "none") {
    env.open.outputs.set(ps(4242), "4000 ttys007 claude");
    if (tab === "tmux") {
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
      env.open.outputs.set(ps(3900), "1 ?? /Applications/Warp.app/Contents/MacOS/stable");
    }
  }
  // 端末を探しに行ったか（ps・tmux の呼び出し）を数える
  const captures: string[] = [];
  const capture = env.open.capture.bind(env.open);
  env.open.capture = async (argv) => {
    captures.push(argv.join(" "));
    return capture(argv);
  };
  const wi =
    env.sqlite.query<{ id: string }, []>("SELECT id FROM work_item WHERE deleted_at IS NULL").get()
      ?.id ?? "none";
  return { call, tr, wi, captures };
}

/** 端末に Enter が届いたら、Claude が自分の指示を記録に書いた形にする */
function claudeReactsTo(tr: ClaudeWriter) {
  const run = env.open.run.bind(env.open);
  env.open.run = async (argv, opts) => {
    const ok = await run(argv, opts);
    if (argv.at(-1) === "Enter") tr.human(T0 + 21 * MIN, { text: "(next)" });
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

async function refused(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof OpError) return `${e.status} ${e.message}`;
    throw e;
  }
  return "sent";
}

describe("次の指示を送る前の条件（Issue #9）", () => {
  test("プロセスが終わっている: ターン・待ち・タブがどうでも送らない。端末を探しにも行かない（ps・tmux を 1 度も呼ばない）", async () => {
    for (const turn of ["ended", "running", "question"] as const)
      for (const proc of ["gone", "stale"] as const)
        for (const tab of ["tmux", "none"] as const) {
          const { wi, captures } = await setup({ turn, proc, tab });
          const a = answerer();
          expect(await a.instructCheck(wi)).toEqual({
            ok: false,
            reason: "session_ended",
            terminal: null,
          });
          expect(await refused(a.instruct(wi, { text: "次はこれ" }))).toBe("409 session_ended");
          expect(env.open.runs).toEqual([]);
          expect(captures).toEqual([]);
          await env.cleanup();
        }
  });

  test.each([
    [{ turn: "running" }, "turn_in_progress"],
    [{ turn: "question" }, "wait_open"],
    [{ tab: "warp" }, "unsupported"],
    [{ tab: "none" }, "not_found"],
  ] as const)("%o: %s で送らない（文を打たない）", async (o, reason) => {
    const { wi } = await setup(o);
    const a = answerer();
    expect(await a.instructCheck(wi)).toMatchObject({ ok: false, reason });
    expect(await refused(a.instruct(wi, { text: "次はこれ" }))).toBe(`409 ${reason}`);
    expect(env.open.runs.some((x) => x.includes("send-keys"))).toBe(false);
  });

  test("Codex: プロセスが確かめられないので送らない（process_unknown）", async () => {
    env = makeAiEnv({ now: T0 });
    env.git.repos.set("/w/app", "/w/app");
    const c = codexRollout(join(env.home, ".codex"), { sid: SID, cwd: "/w/app", at: T0 });
    c.turn(T0 + MIN, T0 + 2 * MIN, "Here are the changes.");
    env.clock.set(T0 + 10 * MIN);
    await env.sync();
    const wi = env.sqlite.query<{ id: string }, []>("SELECT id FROM work_item").get()?.id ?? "none";
    expect(await answerer().instructCheck(wi)).toMatchObject({
      ok: false,
      reason: "process_unknown",
    });
    expect(env.open.runs).toEqual([]);
  });

  test("設定「Turnlane から答える」がオフ: off", async () => {
    const { wi } = await setup();
    expect(await answerer({ enabled: () => false }).instructCheck(wi)).toMatchObject({
      ok: false,
      reason: "off",
    });
  });
});

describe("POST /api/work-items/:id/instruct（Issue #9）", () => {
  test("送れる: last-reply に届け先。送ると文と Enter、記録に新しい指示が出たら confirmed（タブは前に出さない）。保存しない", async () => {
    const { call, wi, tr } = await setup();
    const lr = await call<LastReplyResponse>("GET", `/api/work-items/${wi}/last-reply`);
    expect(lr.headers.get("cache-control")).toBe("no-store");
    expect(lr.body.instruct).toEqual({
      ok: true,
      via: "tmux",
      terminal: "Ghostty",
      landing: "Ghostty · main:1.0",
      multiline: true,
    });
    claudeReactsTo(tr);
    const log = captureLogger();
    const r = await answerer({ logger: log.logger }).instruct(wi, {
      text: `右の列も同じ幅に。${SENTINEL}`,
    });
    expect(r).toMatchObject({
      delivered: true,
      confirmed: true,
      via: "tmux",
      focus: null,
      message: "送りました · Ghostty · main:1.0",
    });
    const base = [TMUX, "-u", "-L", "work", "send-keys", "-t", "%3"];
    expect(env.open.runs).toEqual([
      [...base, "-l", "--", `右の列も同じ幅に。${SENTINEL}`],
      [...base, "Enter"],
    ]);
    expect(log.lines as unknown[]).toEqual([
      [
        "instruction.sent",
        { chars: SENTINEL.length + 9, via: "tmux", confirmed: true, folded: false },
      ],
    ]);
    expect(JSON.stringify(log.lines)).not.toContain(SENTINEL);
    for (const t of env.sqlite
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      )
      .all())
      expect(JSON.stringify(env.sqlite.query(`SELECT * FROM "${t.name}"`).all())).not.toContain(
        SENTINEL,
      );
  });

  test("記録に新しい指示が出なければ confirmed: false。このときだけタブを前に出す", async () => {
    const { wi } = await setup();
    const r = await answerer().instruct(wi, { text: "続けて" });
    expect(r.confirmed).toBe(false);
    expect(r.message).toBe("送りましたが進んだか確認できません · Ghostty · main:1.0");
    expect(env.open.runs.some((a) => a.includes("select-pane"))).toBe(true);
  });

  test("HTTP: 送れなければ 409 と理由の言葉。入力の検証", async () => {
    const { call, wi } = await setup({ turn: "running" });
    const r = await call<{ error: string }>("POST", `/api/work-items/${wi}/instruct`, {
      text: "次",
    });
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: "turn_in_progress" });
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect((await call("POST", `/api/work-items/${wi}/instruct`, { text: "" })).status).toBe(400);
    expect(
      (await call("POST", `/api/work-items/${wi}/instruct`, { text: "x", allow: true })).status,
    ).toBe(400);
    const ok = await setup();
    const sent = await ok.call<InstructResult>("POST", `/api/work-items/${ok.wi}/instruct`, {
      text: "次はこれ",
    });
    expect(sent.status).toBe(200);
    expect(sent.body.delivered).toBe(true);
  });
});
