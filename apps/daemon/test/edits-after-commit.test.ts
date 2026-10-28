/**
 * 既定ブランチの session カードの編集: コミットで解決した後、同じリポジトリが別の作業で汚れても your_turn（edits）へ
 * 戻らない（行き来しない）。合成のトランスクリプト・偽の git
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { type AiEnv, makeAiEnv, present } from "./helpers/env.ts";
import { claudeTranscript } from "./helpers/transcript.ts";

let env: AiEnv;
afterEach(async () => {
  await env?.cleanup();
});

const MIN = 60_000;
const T0 = Date.UTC(2026, 8, 14, 1, 0); // 2026-09-14 10:00 JST

const status = () =>
  env.sqlite
    .query<{ status: string; status_reason: string | null }, []>(
      "SELECT status, status_reason FROM work_item",
    )
    .all();

describe("runner: コミットで解決した既定ブランチの編集", () => {
  test("コミット後に dirty になっても done のまま。コミット前の dirty は edits", async () => {
    env = makeAiEnv({ now: T0 });
    present(env.sqlite, T0 - 60 * MIN, T0 + 14 * 60 * MIN);
    env.git.repos.set("/w/app", "/w/app");
    env.git.defaults.set("/w/app", "main");
    const tr = claudeTranscript(join(env.home, ".claude"), {
      sid: "22222222-0000-4000-8000-000000000001",
      cwd: "/w/app",
      branch: "main",
    });
    tr.human(T0 - 5 * MIN);
    tr.assistantEnd(T0, "Updated the config.", { edits: 2 });
    env.git.dirty.set("/w/app", true);
    env.clock.set(T0 + 2 * MIN);
    await env.sync();
    expect(status()).toEqual([{ status: "your_turn", status_reason: "edits" }]);
    // コミットして汚れが消える
    env.git.commits.set("/w/app#main", [T0 + 5 * MIN]);
    env.git.dirty.set("/w/app", false);
    env.clock.set(T0 + 6 * MIN);
    env.ai.runner.runOnce();
    expect(status()).toEqual([{ status: "done", status_reason: "ended" }]);
    // 別の作業で同じリポジトリが汚れる（何度か）: 行き来しない
    for (const [m, d] of [
      [20, true],
      [25, false],
      [30, true],
    ] as const) {
      env.git.dirty.set("/w/app", d);
      env.clock.set(T0 + m * MIN);
      env.ai.runner.runOnce();
      expect(status()).toEqual([{ status: "done", status_reason: "ended" }]);
    }
  });
});
