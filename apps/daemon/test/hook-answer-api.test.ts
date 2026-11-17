/**
 * hook で答える（ADR 0023。m2-api 42 章）の結合テスト: POST /api/hook-waits・GET /api/hook-waits/:id/result と、
 * 「答える」の届け先（hook が待っていれば hook、いなければ今までどおり端末）。hook は API を呼ぶテストのコードで真似る。
 * OS は偽物。本文はすべて合成のダミー
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LogFields, MetaOnlyLogger } from "@turnlane/collectors";
import { HOOK_WAIT_STALE_MS, HOOK_WAIT_UNSEEN_MS, putSetting } from "@turnlane/core";
import type { HookWaitOpenResponse, HookWaitResult, WaitResponse } from "@turnlane/core/api";
import { Answerer } from "../src/answer/index.ts";
import { createApp } from "../src/http/app.ts";
import { type AiEnv, makeAiEnv } from "./helpers/env.ts";
import { claudeTranscript } from "./helpers/transcript.ts";

const TOKEN = "b".repeat(64);
const HOST = "127.0.0.1:7317";
const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 2, 0, 0);
const SENTINEL = "SENTINEL_HOOK_ANSWER_9c2f";
const SID = "88888888-0000-4000-8000-000000000001";

let env: AiEnv;
afterEach(async () => {
  await env?.cleanup();
});

const ps = (pid: number) => `/bin/ps -o ppid=,tty=,comm= -p ${pid}`;

function captureLogger(): { logger: MetaOnlyLogger; lines: [string, LogFields | undefined][] } {
  const lines: [string, LogFields | undefined][] = [];
  const push = (e: string, f?: LogFields) => void lines.push([e, f]);
  return { lines, logger: { debug: push, info: push, warn: push, error: push } };
}

/**
 * 許可待ち（Bash）・AskUserQuestion（単一選択・複数選択）の 1 件。端末は tmux の外の Warp（文字を送る口が無い）か、
 * 端末の無いセッション（Agent SDK のアプリの形。プロセスが分からない）
 */
async function setup(o: {
  wait: "permission" | "ask" | "ask_multi";
  where: "warp" | "none";
  entrypoint?: string;
}) {
  env = makeAiEnv({ now: T0 });
  putSetting(env.mutate, "ui.language", "ja");
  env.git.repos.set("/w/app", "/w/app");
  env.git.defaults.set("/w/app", "main");
  env.open.dirs.add("/w/app");
  env.open.files.add("/Applications/Warp.app");
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
        session_id: SID,
        ...extra,
      }),
    );
    writeFileSync(join(spool, "hooks-20261002.jsonl"), `${hooks.join("\n")}\n`);
  };
  const tr = claudeTranscript(root, {
    sid: SID,
    cwd: "/w/app",
    branch: "feat/hook",
    ...(o.entrypoint ? { entrypoint: o.entrypoint } : {}),
  });
  tr.human(T0, { text: "テストを直して" });
  hook("UserPromptSubmit", T0);
  let toolUseId: string;
  if (o.wait === "permission") {
    toolUseId = tr.toolUse(T0 + MIN, "Bash", { command: "bun test", description: "Run tests" });
    hook("PermissionRequest", T0 + MIN, { tool_name: "Bash" });
  } else {
    toolUseId = tr.toolUse(T0 + MIN, "AskUserQuestion", {
      questions: [
        {
          question: "デプロイ先は?",
          header: "Deploy",
          multiSelect: false,
          options: [{ label: "staging" }, { label: "production" }],
        },
        ...(o.wait === "ask_multi"
          ? [
              {
                question: "どの確認を回す?",
                header: "Checks",
                multiSelect: true,
                options: [{ label: "lint" }, { label: "test" }, { label: "e2e" }],
              },
            ]
          : []),
      ],
    });
    hook("PermissionRequest", T0 + MIN, { tool_name: "AskUserQuestion" });
  }
  const now = T0 + MIN + 2 * MIN;
  env.clock.set(now);
  await env.sync();
  if (o.where === "warp") {
    env.sqlite.run(
      "UPDATE ai_session SET live_status = 'idle', live_pid = 4242, live_checked_at = ?",
      [now],
    );
    env.open.outputs.set(ps(4242), "4000 ttys007 claude");
    env.open.outputs.set(ps(4000), "3900 ttys007 -zsh");
    env.open.outputs.set(ps(3900), "1 ?? /Applications/Warp.app/Contents/MacOS/stable");
  }
  const wi =
    env.sqlite.query<{ id: string }, []>("SELECT work_item_id AS id FROM follow_up").get()?.id ??
    env.sqlite.query<{ id: string }, []>("SELECT id FROM work_item WHERE deleted_at IS NULL").get()
      ?.id ??
    "none";
  /** hook の真似: 待ちを開く */
  const open = (body: Record<string, unknown>) =>
    call<HookWaitOpenResponse>("POST", "/api/hook-waits", body);
  /** hook の真似: 答えを待つ */
  const result = (id: string, wait = 0) =>
    call<HookWaitResult>("GET", `/api/hook-waits/${id}/result?wait=${wait}`);
  return { call, tr, wi, hook, open, result, toolUseId };
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
    hookWaits: env.ai.deps.hookWaits,
    ...over,
  });
}

const waitId = (r: { body: HookWaitOpenResponse }) => {
  if (!r.body.wait) throw new Error(`not waiting: ${r.body.reason}`);
  return r.body.id;
};

describe("POST /api/hook-waits（待つか）", () => {
  test("待つときは id。no-store。設定がオフ・プログラム経由（sdk-*・委任の子・取り込んだ記録が sdk-*）は待たない", async () => {
    const s = await setup({ wait: "permission", where: "warp" });
    const r = await s.open({ session: SID, tool: "Bash" });
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.body.wait).toBe(true);
    expect((await s.open({ session: SID, tool: "Bash", entrypoint: "sdk-ts" })).body).toEqual({
      wait: false,
      reason: "program",
    });
    expect((await s.open({ session: SID, tool: "Bash", delegated: true })).body).toEqual({
      wait: false,
      reason: "program",
    });
    expect((await s.open({ session: "bad id!", tool: "Bash" })).body).toEqual({
      wait: false,
      reason: "unsupported",
    });
    putSetting(env.mutate, "turn.answer", false);
    expect((await s.open({ session: SID, tool: "Bash" })).body).toEqual({
      wait: false,
      reason: "off",
    });
    await env.cleanup();
    const p = await setup({ wait: "permission", where: "warp", entrypoint: "sdk-cli" });
    expect((await p.open({ session: SID, tool: "Bash", entrypoint: "cli" })).body).toEqual({
      wait: false,
      reason: "program",
    });
  });

  test("同じセッション・同じエージェントの次の待ちが開くと、前の待ちは withdrawn（続けて 2 つの確認）", async () => {
    const s = await setup({ wait: "permission", where: "warp" });
    const a = waitId(await s.open({ session: SID, tool: "Bash" }));
    const pending = s.result(a, 5_000);
    const b = waitId(await s.open({ session: SID, tool: "Bash" }));
    expect((await pending).body).toEqual({ state: "withdrawn" });
    expect((await s.result(b)).body).toEqual({ state: "open" });
    // サブエージェントの待ちは別（並んで開く）
    const sub = waitId(await s.open({ session: SID, tool: "Bash", agentId: "a1b2c3" }));
    expect((await s.result(b)).body).toEqual({ state: "open" });
    expect((await s.result(sub)).body).toEqual({ state: "open" });
    // 取り消し。知らない待ちは 404
    expect((await s.call("POST", `/api/hook-waits/${sub}/cancel`)).status).toBe(200);
    expect((await s.result(sub)).body).toEqual({ state: "withdrawn" });
    expect((await s.result("nope")).status).toBe(404);
  });
});

describe("答える: hook が待っていれば hook に返す", () => {
  test("許可待ち（Warp。文字を送る口が無い）: hook が待つと届け先は hook、「許可する」はこの 1 回の allow を hook に返す", async () => {
    const s = await setup({ wait: "permission", where: "warp" });
    const before = await s.call<WaitResponse>("GET", `/api/work-items/${s.wi}/wait`);
    expect(before.body.delivery).toMatchObject({ deliverable: false, reason: "unsupported" });
    expect(before.body.canAllow).toBe(false);
    const id = waitId(await s.open({ session: SID, tool: "Bash" }));
    const w = await s.call<WaitResponse>("GET", `/api/work-items/${s.wi}/wait`);
    expect(w.body).toMatchObject({
      kind: "permission",
      canAllow: true,
      delivery: { deliverable: true, via: "hook", terminal: null, landing: "Claude Code · hook" },
    });
    // hook は long-poll で待つ。答えが届いたら Claude Code が実行し、記録が進む
    const polled = s.result(id, 10_000).then((r) => {
      s.tr.toolResult(T0 + 4 * MIN, s.toolUseId);
      return r;
    });
    const log = captureLogger();
    const r = await answerer({ logger: log.logger }).answer(s.wi, { allow: true });
    expect((await polled).body).toEqual({ state: "allow" });
    expect(r).toMatchObject({
      delivered: true,
      confirmed: true,
      via: "hook",
      landing: "Claude Code · hook",
      message: "送りました · Claude Code · hook",
      focus: null,
    });
    // 端末には何も送らない
    expect(env.open.runs.some((a) => a.includes("osascript"))).toBe(false);
    expect(log.lines.find(([e]) => e === "answer.sent")?.[1]).toMatchObject({ allow: true });
    // 渡した後は withdrawn（2 回目に答えは出ない）
    expect((await s.result(id)).body).toEqual({ state: "withdrawn" });
  });

  test("hook が待っていない・同じツールの待ちが 2 つ（並んだサブエージェント）なら今までどおり端末（ここでは送れない）", async () => {
    const s = await setup({ wait: "permission", where: "warp" });
    waitId(await s.open({ session: SID, tool: "Bash", agentId: "aaa111" }));
    waitId(await s.open({ session: SID, tool: "Bash", agentId: "bbb222" }));
    const w = await s.call<WaitResponse>("GET", `/api/work-items/${s.wi}/wait`);
    expect(w.body.delivery).toMatchObject({ deliverable: false, via: null, reason: "unsupported" });
    const r = await s.call("POST", `/api/work-items/${s.wi}/answer`, { allow: true });
    expect(r).toMatchObject({ status: 409, body: { error: "undeliverable" } });
    // 違うツールの hook は対応させない
    await env.cleanup();
    const t = await setup({ wait: "permission", where: "warp" });
    waitId(await t.open({ session: SID, tool: "Write" }));
    const w2 = await t.call<WaitResponse>("GET", `/api/work-items/${t.wi}/wait`);
    expect(w2.body.delivery.via).toBe(null);
  });

  test("AskUserQuestion（端末の無いセッション）: 問いごとの形を出し、選んだ番号を hook に返す。複数選択と自由な文", async () => {
    const s = await setup({ wait: "ask_multi", where: "none" });
    const id = waitId(await s.open({ session: SID, tool: "AskUserQuestion" }));
    const w = await s.call<WaitResponse>("GET", `/api/work-items/${s.wi}/wait`);
    expect(w.body).toMatchObject({
      kind: "ask",
      canAllow: false,
      delivery: { via: "hook", deliverable: true },
      questions: [
        {
          text: "デプロイ先は?",
          multiSelect: false,
          options: [
            { n: 1, label: "staging" },
            { n: 2, label: "production" },
          ],
        },
        { text: "どの確認を回す?", multiSelect: true },
      ],
    });
    // 形が合わない答えは 400（単一選択に 2 つ・範囲外・問いの数が違う）
    for (const choices of [
      [{ options: [0, 1] }, { options: [0] }],
      [{ options: [2] }, { options: [0] }],
      [{ options: [0] }],
    ]) {
      const bad = await s.call("POST", `/api/work-items/${s.wi}/answer`, { choices });
      expect(bad.status).toBe(400);
    }
    const polled = s.result(id, 10_000).then((r) => {
      s.tr.answer(T0 + 4 * MIN, s.toolUseId);
      return r;
    });
    const r = await answerer().answer(s.wi, {
      choices: [{ options: [1] }, { options: [2, 0] }],
    });
    expect((await polled).body).toEqual({
      state: "answer",
      count: 2,
      answers: [{ options: [1] }, { options: [0, 2] }],
    });
    expect(r).toMatchObject({ via: "hook", confirmed: true });
    // 自由な文
    await env.cleanup();
    const t = await setup({ wait: "ask", where: "none" });
    const id2 = waitId(await t.open({ session: SID, tool: "AskUserQuestion" }));
    const p2 = t.result(id2, 10_000);
    await answerer().answer(t.wi, { choices: [{ text: `  canary\n${SENTINEL}  ` }] });
    expect((await p2).body).toEqual({
      state: "answer",
      count: 1,
      answers: [{ text: `canary ${SENTINEL}` }],
    });
  });

  test("hook が待っていない AskUserQuestion に選んだ答え（choices）は送れない（409 undeliverable）", async () => {
    const s = await setup({ wait: "ask", where: "none" });
    const r = await s.call("POST", `/api/work-items/${s.wi}/answer`, {
      choices: [{ options: [0] }],
    });
    expect(r).toMatchObject({ status: 409, body: { error: "undeliverable" } });
  });
});

describe("取り下げ（別の形で待ちが閉じた）", () => {
  test("本体のターンが進んだ（Stop の hook）・セッションが終わった（SessionEnd）: hook は withdrawn", async () => {
    const s = await setup({ wait: "permission", where: "warp" });
    const id = waitId(await s.open({ session: SID, tool: "Bash" }));
    const pending = s.result(id, 10_000);
    s.tr.toolResult(T0 + 4 * MIN, s.toolUseId);
    s.hook("Stop", env.clock.now() + 1_000);
    env.clock.set(env.clock.now() + 2_000);
    await env.sync();
    expect((await pending).body).toEqual({ state: "withdrawn" });
    // サブエージェントの待ちは本体の Stop では取り下げない。SessionEnd では取り下げる
    const sub = waitId(await s.open({ session: SID, tool: "Bash", agentId: "c0ffee" }));
    s.hook("Stop", env.clock.now() + 1_000);
    env.clock.set(env.clock.now() + 2_000);
    await env.sync();
    expect((await s.result(sub)).body).toEqual({ state: "open" });
    s.hook("SessionEnd", env.clock.now() + 1_000);
    env.clock.set(env.clock.now() + 2_000);
    await env.sync();
    expect((await s.result(sub)).body).toEqual({ state: "withdrawn" });
  });

  test("カードの待ちとして見えた後に待ちが閉じた（端末・アプリで答えて記録が進んだ）: withdrawn。一度も見えない待ち・聞かれなくなった待ちも", async () => {
    const s = await setup({ wait: "permission", where: "warp" });
    const id = waitId(await s.open({ session: SID, tool: "Bash" }));
    env.ai.runner.runOnce();
    expect((await s.result(id)).body).toEqual({ state: "open" });
    // 人が端末で許可した: 記録に結果と次の発言
    s.tr.toolResult(T0 + 4 * MIN, s.toolUseId);
    s.tr.assistantText(T0 + 4 * MIN + 1_000, "テストを回しました");
    env.clock.set(T0 + 5 * MIN);
    await env.sync();
    expect((await s.result(id)).body).toEqual({ state: "withdrawn" });
    // 別のセッションの待ち（カードに一度も出ない）は 60 秒で取り下げる
    const other = waitId(
      await s.open({ session: "99999999-0000-4000-8000-000000000009", tool: "Bash" }),
    );
    env.clock.set(env.clock.now() + HOOK_WAIT_UNSEEN_MS + 1_000);
    env.ai.runner.runOnce();
    expect((await s.result(other)).body).toEqual({ state: "withdrawn" });
    // 聞かれなくなった待ち（hook が終わった）
    const quiet = waitId(await s.open({ session: SID, tool: "Bash" }));
    env.clock.set(env.clock.now() + HOOK_WAIT_STALE_MS + 1_000);
    env.ai.runner.runOnce();
    expect((await s.result(quiet)).body).toEqual({ state: "withdrawn" });
  });
});

describe("保存しない（ADR 0005・0018・0023）", () => {
  test("自由な文の答え・hook の入力の番兵は DB・ログ・spool に出ない", async () => {
    const s = await setup({ wait: "ask", where: "none" });
    const log = captureLogger();
    // hook は入力（問いの文など）を送らないが、余計なキーを付けても受け取って捨てる
    const id = waitId(
      await s.open({ session: SID, tool: "AskUserQuestion", tool_input: { x: SENTINEL } }),
    );
    const p = s.result(id, 10_000);
    await answerer({ logger: log.logger }).answer(s.wi, { choices: [{ text: SENTINEL }] });
    await p;
    env.ai.runner.runOnce();
    const dump = env.sqlite
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map(({ name }) => JSON.stringify(env.sqlite.query(`SELECT * FROM "${name}"`).all()))
      .join("\n");
    expect(dump).not.toContain(SENTINEL);
    expect(JSON.stringify(log.lines)).not.toContain(SENTINEL);
    const spool = join(env.dataDir, "spool");
    for (const f of readdirSync(spool))
      expect(readFileSync(join(spool, f), "utf8")).not.toContain(SENTINEL);
  });
});
