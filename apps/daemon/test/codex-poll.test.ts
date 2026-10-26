/**
 * Codex の rollout の軽い走査（WatchSpec.pollEveryMs）。Codex は rollout を開いたまま追記し、macOS の fs.watch は
 * 閉じるまで知らせないので、最近の rollout の mtime だけを 10 秒ごとに見て、変わったものを読む
 */
import { afterEach, describe, expect, test } from "bun:test";
import { utimesSync } from "node:fs";
import { join } from "node:path";
import { type AiEnv, makeAiEnv } from "./helpers/env.ts";
import { codexRollout } from "./helpers/transcript.ts";

const SEC = 1000;
const MIN = 60 * SEC;
const SID = "77777777-0000-4000-8000-000000000001";

let env: AiEnv;
afterEach(async () => {
  await env?.cleanup();
});

/** mtime を決まった値にする（同じミリ秒の追記で mtime が変わらないことがないように） */
function touch(path: string, atMs: number): void {
  const t = new Date(atMs);
  utimesSync(path, t, t);
}

describe("Codex の rollout の軽い走査", () => {
  test("開いたまま追記された rollout を、10 秒ごとの mtime の比較で読む（中身の変化は監視に来ない）", async () => {
    const now = Date.now();
    env = makeAiEnv({ now });
    env.git.repos.set("/w/app", "/w/app");
    const r = codexRollout(join(env.home, ".codex"), { sid: SID, cwd: "/w/app", at: now - MIN });
    const finish = r.begin(now - 30 * SEC);
    touch(r.path, now - 20 * SEC);
    await env.sync();
    const status = () =>
      env.sqlite.query<{ status: string }, []>("SELECT status FROM ai_turn").all();
    expect(status()).toEqual([{ status: "running" }]);

    // 変わっていなければ何もしない
    env.clock.set(now + 10 * SEC);
    expect(env.ai.supervisor.pollChanged()).toBe(0);

    // 追記（監視の通知は来ない）。10 秒たつ前は見ない
    finish(now + 11 * SEC, "Done.");
    touch(r.path, now + 11 * SEC);
    env.clock.set(now + 12 * SEC);
    expect(env.ai.supervisor.pollChanged()).toBe(0);
    env.clock.set(now + 20 * SEC);
    expect(env.ai.supervisor.pollChanged()).toBe(1);
    await env.ai.supervisor.whenIdle();
    expect(status()).toEqual([{ status: "completed" }]);
  });

  test("長く更新の無い rollout（backfill）は軽い走査に入れない（60 秒ごとの再走査に任せる）", async () => {
    const now = Date.now();
    env = makeAiEnv({ now });
    env.git.repos.set("/w/app", "/w/app");
    const r = codexRollout(join(env.home, ".codex"), {
      sid: SID,
      cwd: "/w/app",
      at: now - 10 * 86_400_000,
    });
    const finish = r.begin(now - 10 * 86_400_000 + MIN);
    touch(r.path, now - 10 * 86_400_000 + MIN);
    await env.sync();
    finish(now, "Done.");
    touch(r.path, now);
    env.clock.set(now + 20 * SEC);
    expect(env.ai.supervisor.pollChanged()).toBe(0);
  });
});
