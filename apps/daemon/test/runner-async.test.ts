/**
 * 判定の非同期の実行（取り込みの後・tick）。区切りごとにイベントループに譲っても同期の実行と同じ結果になり、
 * 譲っている間に DB が書き換わったら打ち切って実行し直す（打ち切りが続いたら譲らずに終える）
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { nullLogger } from "@turnlane/collectors";
import { newId } from "@turnlane/core";
import { DeriveRunner } from "../src/derive/runner.ts";
import { type AiEnv, makeAiEnv, present } from "./helpers/env.ts";
import { claudeTranscript } from "./helpers/transcript.ts";

let env: AiEnv;
let runner: DeriveRunner | null = null;
afterEach(async () => {
  runner?.stop();
  await runner?.idle();
  runner = null;
  await env?.cleanup();
});

const MIN = 60_000;
const T0 = Date.UTC(2026, 8, 14, 1, 0); // 2026-09-14 10:00 JST

/** 3 枚のカード（ブランチごと）。質問で終わったターンと編集して終わったターンを交互に */
async function setup(): Promise<void> {
  env = makeAiEnv({ now: T0 });
  // 組の runner は止める（取り込みの後の実行がこのテストの runner と並ばないように）
  env.ai.runner.stop();
  present(env.sqlite, T0 - 6 * 60 * MIN, T0 + 60 * MIN);
  env.git.repos.set("/w/app", "/w/app");
  env.git.defaults.set("/w/app", "main");
  for (const [i, branch] of ["feat/a", "feat/b", "feat/c"].entries()) {
    const tr = claudeTranscript(join(env.home, ".claude"), {
      sid: `11111111-0000-4000-8000-00000000000${i}`,
      cwd: "/w/app",
      branch,
    });
    for (let k = 0; k < 6; k++) {
      const at = T0 - (5 * 60 - k * 40 - i * 7) * MIN;
      tr.human(at);
      tr.assistantEnd(at + 2 * MIN, k % 2 ? "Which option do you prefer?" : "done", {
        edits: k % 2 ? 0 : 1,
      });
    }
  }
  await env.ai.supervisor.detect();
  await env.ai.supervisor.scanAll();
  await env.ai.supervisor.whenIdle();
}

const snapshot = () => ({
  workItems: env.sqlite
    .query("SELECT group_key, status, status_reason FROM work_item ORDER BY group_key")
    .all(),
  followUps: env.sqlite.query("SELECT kind, status FROM follow_up ORDER BY kind, status").all(),
  waits: env.sqlite
    .query(
      "SELECT w.group_key, s.wait_key, s.local_date, s.kind, s.start_at, s.end_at, s.is_open FROM ai_wait_segment s JOIN work_item w ON w.id = s.work_item_id ORDER BY 1, 2, 3, 5",
    )
    .all(),
});

function makeRunner(): DeriveRunner {
  runner = new DeriveRunner({
    sqlite: env.sqlite,
    mutate: env.mutate,
    git: env.git,
    clock: env.clock,
    logger: nullLogger,
    runningStaleMs: { claude_code: 10 * MIN },
    debounceMs: 0,
    tickMs: 3_600_000,
    sliceMs: 0,
  });
  return runner;
}

describe("runner: 非同期の実行", () => {
  test("区切りごとに譲っても、同期の実行と同じ結果になる", async () => {
    await setup();
    const r = makeRunner();
    await r.runNow();
    expect(r.abortedRuns).toBe(0);
    const viaAsync = snapshot();
    expect(viaAsync.workItems).toHaveLength(3);
    expect(viaAsync.waits.length).toBeGreaterThan(0);
    // 同じ事実で同期に回し直しても何も変わらない
    const stats = r.runOnce();
    expect(stats.statusChanged).toBe(0);
    expect(stats.followUpsCreated).toBe(0);
    expect(snapshot()).toEqual(viaAsync);
  });

  test("譲っている間に DB が書き換わったら打ち切り、続いたら譲らずに終える", async () => {
    await setup();
    const r = makeRunner();
    // 譲るたびに他の書き込みが入る（取り込み・操作の代わり）
    const writer = setInterval(() => {
      env.sqlite.run("INSERT INTO usage_event (id, at, kind) VALUES (?, ?, 'user_op')", [
        newId(env.clock),
        env.clock.now(),
      ]);
    }, 0);
    try {
      r.schedule(0);
      const until = Date.now() + 5_000;
      while (r.lastRun === null && Date.now() < until) await Bun.sleep(5);
    } finally {
      clearInterval(writer);
    }
    expect(r.abortedRuns).toBeGreaterThan(0);
    expect(r.lastRun?.workItems).toBe(3);
    await r.idle();
    // 打ち切りの後に終えた結果は、書き込みが無いときに同期で回した結果と同じ
    const after = snapshot();
    r.runOnce();
    expect(snapshot()).toEqual(after);
  });
});
