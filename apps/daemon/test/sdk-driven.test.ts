/**
 * プログラム経由のセッション（記録の entrypoint が `sdk-*`）の結合テスト: 取り込み → 判定で、問いで終わっても自分の番・
 * 返答タスクにならず、ボードの札（ソースの sdk）が付く。合成のトランスクリプト・偽の git
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { sourcesByWorkItem } from "../src/planner/common.ts";
import { type AiEnv, makeAiEnv, present } from "./helpers/env.ts";
import { claudeTranscript } from "./helpers/transcript.ts";

let env: AiEnv;
afterEach(async () => {
  await env?.cleanup();
});

const MIN = 60_000;
const T0 = Date.UTC(2026, 8, 14, 1, 0); // 2026-09-14 10:00 JST

async function run(entrypoint: string) {
  env = makeAiEnv({ now: T0 });
  present(env.sqlite, T0 - 60 * MIN, T0 + 14 * 60 * MIN);
  env.git.repos.set("/w/app", "/w/app");
  env.git.defaults.set("/w/app", "main");
  const tr = claudeTranscript(join(env.home, ".claude"), {
    sid: "33333333-0000-4000-8000-000000000001",
    cwd: "/w/app",
    branch: "feat/x",
    entrypoint,
  });
  tr.human(T0 - 2 * MIN);
  tr.assistantEnd(T0, "Which option do you prefer?");
  env.clock.set(T0 + 20 * MIN);
  await env.sync();
  const wi = env.sqlite
    .query<{ id: string; status: string }, []>("SELECT id, status FROM work_item")
    .get();
  const fus = env.sqlite.query<{ kind: string }, []>("SELECT kind FROM follow_up").all();
  return { status: wi?.status, fus, sources: sourcesByWorkItem(env.sqlite).get(wi?.id ?? "") };
}

describe("runner: プログラム経由のセッション", () => {
  test("sdk-cli: 問いで終わっても done、返答タスクを作らない。ソースに sdk の印", async () => {
    const r = await run("sdk-cli");
    expect(r.status).toBe("done");
    expect(r.fus).toEqual([]);
    expect(r.sources).toEqual([{ tool: "claude_code", profile: null, sdk: true }]);
  });

  test("cli: 今までどおり自分の番と返答タスク。印は無い", async () => {
    const r = await run("cli");
    expect(r.status).toBe("your_turn");
    expect(r.fus).toEqual([{ kind: "reply" }]);
    expect(r.sources).toEqual([{ tool: "claude_code", profile: null }]);
  });
});
