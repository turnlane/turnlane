/**
 * 問い返し（Issue #3。ADR 0020）と、手で自分の番に戻す（POST /api/work-items/:id/back-to-turn）。
 * 合成のトランスクリプト・偽の時計。本文はすべて合成のダミー
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { QueueResponse, WorkItemDetail } from "@turnlane/core/api";
import { visibleQueue } from "@turnlane/core/web";
import { createApp } from "../src/http/app.ts";
import { createPlanner } from "../src/planner/index.ts";
import { type AiEnv, makeAiEnv, present } from "./helpers/env.ts";
import { claudeTranscript } from "./helpers/transcript.ts";

const TOKEN = "f".repeat(64);
const HOST = "127.0.0.1:7317";
const MIN = 60_000;
const H = 60 * MIN;
// 2026-10-02（金）09:00 JST
const T0 = Date.UTC(2026, 9, 2, 0, 0);

let env: AiEnv;
afterEach(async () => {
  await env?.cleanup();
});

function setup() {
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
    return { status: r.status, body: (await r.json()) as T };
  };
  const sid = "77777777-0000-4000-8000-000000000001";
  const root = join(env.home, ".claude");
  const tr = claudeTranscript(root, { sid, cwd: "/w/app", branch: "feat/export" });
  const spool = join(env.dataDir, "spool");
  mkdirSync(spool, { recursive: true });
  const hooks: string[] = [];
  const hook = (name: string, at: number) => {
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
  const queue = async () => (await call<QueueResponse>("GET", "/api/queue")).body;
  const shown = async () => visibleQueue((await queue()).items);
  const fus = () =>
    env.sqlite
      .query<{ id: string; status: string; close_reason: string | null }, []>(
        "SELECT id, status, close_reason FROM follow_up ORDER BY trigger_at",
      )
      .all();
  const at = async (ms: number) => {
    env.clock.set(ms);
    await env.sync();
  };
  return { call, tr, hook, queue, shown, fus, at };
}

/** 9:00 に頼み、9:05 に問いで終わり、9:21 に返答タスク（猶予 15 分の後） */
async function askedQuestion(s: ReturnType<typeof setup>) {
  s.tr.human(T0, { text: "書き出しの機能を足して" });
  s.tr.assistantEnd(T0 + 5 * MIN, "CSV と JSON のどちらにしますか？");
  await s.at(T0 + 21 * MIN);
  const rows = await s.shown();
  expect(rows.map((x) => x.followUps.map((f) => [f.kind, f.status]))).toEqual([
    [["reply", "open"]],
  ]);
  return rows[0]?.workItemId ?? "";
}

describe("問い返し", () => {
  test("問いで返した間は自分の番に出さず、AI の答えが問いでなければ同じ行が戻る。次の答えで閉じる", async () => {
    const s = setup();
    const id = await askedQuestion(s);
    // 問いで返す: 返答タスクは閉じず、AI が答えている間は asked_back（帯・件数に出さない）
    s.tr.human(T0 + 25 * MIN, { text: "違いを教えてください" });
    await s.at(T0 + 26 * MIN);
    expect(s.fus().map((f) => f.status)).toEqual(["open"]);
    expect(await s.shown()).toEqual([]);
    const q = await s.queue();
    expect(q.items.flatMap((x) => x.followUps.map((f) => f.status))).toEqual(["asked_back"]);
    // 詳細: 返答タスクは asked_back、問い返したターンに印
    const d = (await s.call<WorkItemDetail>("GET", `/api/work-items/${id}`)).body;
    expect(d.followUps.map((f) => f.status)).toEqual(["asked_back"]);
    expect(d.turns.map((t) => t.askedBack ?? false)).toEqual([false, true]);
    // AI が答える（問いではない）: 元の返答タスクが自分の番に戻る
    s.tr.assistantEnd(T0 + 28 * MIN, "CSV は表計算向け、JSON はプログラム向けです。");
    await s.at(T0 + 29 * MIN);
    const back = await s.shown();
    expect(back.map((x) => x.followUps.map((f) => [f.kind, f.status]))).toEqual([
      [["reply", "open"]],
    ]);
    expect(s.fus()).toHaveLength(1);
    // 答える: いつもどおり閉じる
    s.tr.human(T0 + 40 * MIN, { text: "CSV で進めて" });
    await s.at(T0 + 41 * MIN);
    expect(s.fus()).toEqual([
      expect.objectContaining({ status: "done", close_reason: "auto:human_input" }),
    ]);
  });

  test("AI の答えが新しい問いなら、そちらが置き換える", async () => {
    const s = setup();
    await askedQuestion(s);
    s.tr.human(T0 + 25 * MIN, { text: "どこに保存されるの？" });
    s.tr.assistantEnd(T0 + 27 * MIN, "保存先は設定で変えられます。既定のままでいいですか？");
    await s.at(T0 + 28 * MIN);
    expect(s.fus()[0]).toMatchObject({
      status: "superseded",
      close_reason: "auto:asked_back_replaced",
    });
  });

  test("問い返したターンが記録に返答の無いまま Stop の hook で終わったら、返答なしで戻す", async () => {
    const s = setup();
    await askedQuestion(s);
    s.tr.human(T0 + 25 * MIN, { text: "なぜ 2 回書き出すの" });
    s.hook("UserPromptSubmit", T0 + 25 * MIN);
    await s.at(T0 + 26 * MIN);
    expect(await s.shown()).toEqual([]);
    s.hook("Stop", T0 + 27 * MIN);
    await s.at(T0 + 28 * MIN);
    expect((await s.shown()).map((x) => x.followUps.map((f) => f.status))).toEqual([["open"]]);
  });

  test("問いの形でない入力（依頼・答え）は今までどおり閉じる", async () => {
    const s = setup();
    await askedQuestion(s);
    s.tr.human(T0 + 25 * MIN, { text: "README も直してもらえますか？" });
    await s.at(T0 + 26 * MIN);
    expect(s.fus()[0]).toMatchObject({ status: "done", close_reason: "auto:human_input" });
  });
});

describe("自分の番に戻す", () => {
  test("閉じた行を戻すと、新しい記録が来るまで残る", async () => {
    const s = setup();
    const id = await askedQuestion(s);
    s.tr.human(T0 + 25 * MIN, { text: "CSV で" });
    s.tr.assistantEnd(T0 + 30 * MIN, "CSV で書き出せるようにしました。");
    await s.at(T0 + 31 * MIN);
    expect(s.fus()[0]?.status).toBe("done");
    const r = await s.call<{ followUp: { status: string }; changed: boolean }>(
      "POST",
      `/api/work-items/${id}/back-to-turn`,
      {},
    );
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ followUp: { status: "open" }, changed: true });
    // 時間が経っても、判定をやり直しても残る
    await s.at(T0 + 5 * H);
    expect((await s.shown()).map((x) => x.workItemId)).toEqual([id]);
    // もう一度押しても何も変わらない
    const again = await s.call<{ changed: boolean }>(
      "POST",
      `/api/work-items/${id}/back-to-turn`,
      {},
    );
    expect(again.body.changed).toBe(false);
    // 新しい記録（このカードの新しいターン）で閉じる
    s.tr.human(T0 + 5 * H + MIN, { text: "JSON も足して" });
    await s.at(T0 + 5 * H + 2 * MIN);
    expect(s.fus()[0]).toMatchObject({ status: "done", close_reason: "auto:new_record" });
  });

  test("問い返し中の行を戻すと、AI が答えている間も自分の番に出る", async () => {
    const s = setup();
    const id = await askedQuestion(s);
    s.tr.human(T0 + 25 * MIN, { text: "違いを教えて" });
    await s.at(T0 + 26 * MIN);
    expect(await s.shown()).toEqual([]);
    const fid = s.fus()[0]?.id;
    const r = await s.call<{ changed: boolean }>("POST", `/api/work-items/${id}/back-to-turn`, {
      followUpId: fid,
    });
    expect(r.body.changed).toBe(true);
    expect((await s.shown()).map((x) => x.followUps.map((f) => f.status))).toEqual([["open"]]);
  });

  test("自分の番の無い完了したカードは返答タスクを作って戻す。無いカードは 404", async () => {
    const s = setup();
    s.tr.human(T0, { text: "型の警告を消して" });
    s.tr.assistantEnd(T0 + 5 * MIN, "警告を消しました。");
    await s.at(T0 + 6 * MIN);
    expect(s.fus()).toEqual([]);
    const id = env.sqlite.query<{ id: string }, []>("SELECT id FROM work_item").get()?.id ?? "";
    const r = await s.call<{ followUp: { kind: string; status: string }; changed: boolean }>(
      "POST",
      `/api/work-items/${id}/back-to-turn`,
      {},
    );
    expect(r.body).toMatchObject({ followUp: { kind: "reply", status: "open" }, changed: true });
    await s.at(T0 + 3 * H);
    expect((await s.shown()).map((x) => x.workItemId)).toEqual([id]);
    expect((await s.call("POST", "/api/work-items/none/back-to-turn", {})).status).toBe(404);
  });
});
