/**
 * Codex のセッションのプロセス（Issue #10）: hooks のハンドラの親の pid（spool の ppid）をセッションの live_pid に写し、
 * 「開く」「答える」「次の指示」を Claude Code と同じ経路（tty → tmux のペイン → cwd → アプリ）に乗せる。
 * hooks の来ていないセッションは今までどおり分からない（最後の動きから 6 時間の推定）。
 * OS は偽物（kill(0)・ps の名前・ps と tmux の一覧の出力）。本文はすべて合成のダミー
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { itemProcess } from "@turnlane/core";
import type { AnswerResult, WaitResponse } from "@turnlane/core/api";
import { createApp } from "../src/http/app.ts";
import { LIST_CLIENTS_FORMAT, LIST_PANES_FORMAT } from "../src/open/locate.ts";
import { type AiEnv, makeAiEnv } from "./helpers/env.ts";
import { codexRollout } from "./helpers/transcript.ts";

const TOKEN = "c".repeat(64);
const HOST = "127.0.0.1:7317";
const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 2, 0, 0);
const TMUX = "/opt/homebrew/bin/tmux";
const PID = 5151;
const SID = "019a0000-0000-7000-8000-00000000c0de";

let env: AiEnv;
afterEach(async () => {
  await env?.cleanup();
});

const ps = (pid: number) => `/bin/ps -o ppid=,tty=,comm= -p ${pid}`;

async function setup(
  o: { hooks?: boolean; alive?: () => boolean; name?: () => string | null } = {},
) {
  const proc: { alive: (pid: number) => boolean; name: (pid: number) => string | null } = {
    alive: o.alive ?? ((pid: number) => pid === PID),
    name: o.name ?? (() => "/opt/homebrew/bin/codex"),
  };
  env = makeAiEnv({
    now: T0,
    codexProcess: { alive: (p) => proc.alive(p), name: (p) => proc.name(p) },
  });
  env.git.repos.set("/w/app", "/w/app");
  env.git.defaults.set("/w/app", "main");
  env.open.dirs.add("/w/app");
  env.open.files.add("/Applications/Ghostty.app");
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
    return { status: r.status, body: (await r.json()) as T };
  };
  const root = join(env.home, ".codex");
  const w = codexRollout(root, { sid: SID, cwd: "/w/app", at: T0, originator: "codex_cli_rs" });
  w.turn(T0, T0 + MIN, "左の列は直しました。右の列はどうしますか？");
  const spool = join(env.dataDir, "spool");
  mkdirSync(spool, { recursive: true });
  const lines: string[] = [];
  const hook = (name: string, at: number, ppid: number | null = PID) => {
    lines.push(
      JSON.stringify({
        v: 1,
        tool: "codex",
        received_at: at,
        config_root: root,
        hook_event_name: name,
        session_id: SID,
        ...(ppid !== null ? { ppid } : {}),
      }),
    );
    writeFileSync(join(spool, "hooks-20261002.jsonl"), `${lines.join("\n")}\n`);
  };
  if (o.hooks !== false) {
    hook("UserPromptSubmit", T0);
    hook("Stop", T0 + MIN);
  }
  env.clock.set(T0 + 20 * MIN);
  // プロセスの確かめ（probeLive）は取り込みを始めてから
  await env.ai.supervisor.detect();
  await env.ai.supervisor.beginIngest();
  await env.sync();
  // 居場所: codex（ttys009）→ tmux のペイン → Ghostty
  env.open.outputs.set(ps(PID), `4000 ttys009 codex`);
  env.open.outputs.set(ps(4000), `3900 ttys009 ${TMUX}`);
  env.open.outputs.set(`/bin/ps -o args= -p 4000`, "tmux -L work new-session");
  env.open.outputs.set(
    [TMUX, "-u", "-L", "work", "list-panes", "-a", "-F", LIST_PANES_FORMAT].join(" "),
    "/dev/ttys009\t%5\tmain\t2\t0\n",
  );
  env.open.outputs.set(
    [TMUX, "-u", "-L", "work", "list-clients", "-F", LIST_CLIENTS_FORMAT].join(" "),
    "/dev/ttys002\t5000\tmain\t100\n",
  );
  env.open.outputs.set(ps(5000), "4900 ttys002 tmux");
  env.open.outputs.set(ps(4900), "1 ?? /Applications/Ghostty.app/Contents/MacOS/ghostty");
  const wi =
    env.sqlite.query<{ id: string }, []>("SELECT id FROM work_item WHERE deleted_at IS NULL").get()
      ?.id ?? "none";
  const live = () =>
    env.sqlite
      .query<{ live_status: string | null; live_pid: number | null }, []>(
        "SELECT live_status, live_pid FROM ai_session WHERE tool = 'codex'",
      )
      .get();
  return { call, wi, hook, live, proc };
}

describe("Codex のプロセス（hooks の親の pid）", () => {
  test("hooks の pid が生きている codex なら live（busy）。状態の判定には使わない", async () => {
    const s = await setup();
    expect(s.live()).toEqual({ live_status: "busy", live_pid: PID });
    expect(
      env.sqlite.query<{ status: string }, []>("SELECT status FROM work_item").get()?.status,
    ).toBe("your_turn");
  });

  test("hooks が来ていなければ今までどおり分からない（6 時間の推定）", async () => {
    const s = await setup({ hooks: false });
    expect(s.live()).toEqual({ live_status: null, live_pid: null });
    expect(
      itemProcess(
        [
          {
            tool: "codex",
            liveStatus: null,
            livePid: null,
            liveCheckedAt: null,
            lastActivityAt: T0,
          },
        ],
        T0,
      ).process,
    ).toBe("unknown");
  });

  test("プロセスが終わった・SessionEnd が来た・pid が別のプロセスに使い回された → gone", async () => {
    const s = await setup();
    s.proc.alive = () => false;
    await env.ai.supervisor.probeLive();
    expect(s.live()?.live_status).toBe("gone");
    s.proc.alive = () => true;
    s.hook("SessionEnd", T0 + 21 * MIN, null);
    await env.sync();
    expect(s.live()?.live_status).toBe("gone");
  });

  test("pid が codex でないプロセス（使い回し）なら gone", async () => {
    const s = await setup({ name: () => "/usr/bin/vim" });
    expect(s.live()?.live_status).toBe("gone");
  });
});

describe("Codex の開く・答える（既存の経路）", () => {
  test("開く: 動いているセッションのタブ（tmux のペイン）を前に出す", async () => {
    const s = await setup();
    const o = await s.call<{
      default: string | null;
      options: { action: string; app: string | null }[];
    }>("GET", `/api/open/options?workItemId=${s.wi}`);
    expect(o.body.options[0]).toEqual({ action: "session", app: null });
    const r = await s.call<{ outcome: string }>("POST", "/api/open", { workItemId: s.wi });
    expect(r.status).toBe(200);
    expect(r.body.outcome).toBe("focused");
    expect(
      env.open.runs.some((a) => a.includes("select-pane") || a.includes("switch-client")),
    ).toBe(true);
  });

  test("答える: 問いを読み、tmux のペインに 1 行で送る（Codex は改行を送らない）", async () => {
    const s = await setup();
    const w = await s.call<WaitResponse>("GET", `/api/work-items/${s.wi}/wait`);
    expect(w.body.kind).toBe("question");
    expect(w.body.question?.text).toContain("右の列はどうしますか？");
    expect(w.body.delivery).toMatchObject({ deliverable: true, via: "tmux", multiline: false });
    expect(w.body.canAllow).toBe(false);
    const r = await s.call<AnswerResult>("POST", `/api/work-items/${s.wi}/answer`, {
      text: "同じ幅に\nして",
    });
    expect(r.status).toBe(200);
    const sent = env.open.runs.find((a) => a.includes("send-keys") && a.includes("-l"));
    expect(sent?.at(-1)).toBe("同じ幅に して");
  });

  test("次の指示: プロセスが分かるので「確かめられない」ではなく、今の待ちを理由にする", async () => {
    const s = await setup();
    const r = await s.call<{ instruct?: { ok: boolean; reason?: string } }>(
      "GET",
      `/api/work-items/${s.wi}/last-reply`,
    );
    expect(r.body.instruct).toMatchObject({ ok: false, reason: "wait_open" });
    await env.cleanup();
    const n = await setup({ hooks: false });
    const r2 = await n.call<{ instruct?: { ok: boolean; reason?: string } }>(
      "GET",
      `/api/work-items/${n.wi}/last-reply`,
    );
    expect(r2.body.instruct).toMatchObject({ ok: false, reason: "process_unknown" });
  });
});
