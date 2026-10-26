/**
 * Stop の hook をトランスクリプトが追いつくまでの終わりに使う（ai-session-ingestion「hooks が補う終わり」）。
 * Stop の hook が届いた時点で実行中を切って自分の番（hook:stop）にし、60 秒遅れてトランスクリプトの終わり（問い）が
 * 取り込まれたら同じ待ちのまま問いに置き換える。返答タスク（通知の元）は 1 件だけ。Codex と Claude Code の両方
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkItemDetail } from "@turnlane/core/api";
import { type AiEnv, makeAiEnv, present } from "./helpers/env.ts";
import { claudeTranscript, codexRollout } from "./helpers/transcript.ts";

const MIN = 60_000;
const SEC = 1000;
const T0 = Date.UTC(2026, 9, 2, 1, 0);

let env: AiEnv;
afterEach(async () => {
  await env?.cleanup();
});

type Tool = "codex" | "claude_code";

function setup(tool: Tool) {
  env = makeAiEnv({ now: T0 });
  present(env.sqlite, T0 - 60 * MIN, T0 + 3 * 60 * MIN);
  env.git.repos.set("/w/app", "/w/app");
  env.git.defaults.set("/w/app", "main");
  env.git.branches.set("/w/app", "feat/stop");
  const spool = join(env.dataDir, "spool");
  mkdirSync(spool, { recursive: true });
  const lines: string[] = [];
  const configRoot = join(env.home, tool === "codex" ? ".codex" : ".claude");
  const hook = (sid: string, name: string, at: number, extra: Record<string, string> = {}) => {
    lines.push(
      JSON.stringify({
        v: 1,
        tool,
        received_at: at,
        config_root: configRoot,
        hook_event_name: name,
        session_id: sid,
        ...extra,
      }),
    );
    writeFileSync(join(spool, "hooks-20261002.jsonl"), `${lines.join("\n")}\n`);
  };
  const card = () =>
    env.sqlite
      .query<{ id: string; status: string; status_reason: string }, []>(
        "SELECT id, status, status_reason FROM work_item WHERE deleted_at IS NULL",
      )
      .all();
  const replies = () =>
    env.sqlite
      .query<{ kind: string; status: string; trigger_at: number }, []>(
        "SELECT kind, status, trigger_at FROM follow_up WHERE kind = 'reply'",
      )
      .all();
  return { configRoot, hook, card, replies };
}

/** ターンの始まりだけを書き、終わり（問い）を後から書く関数を返す */
function beginTurn(tool: Tool, root: string, sid: string, start: number): (end: number) => void {
  if (tool === "codex") {
    const r = codexRollout(root, { sid, cwd: "/w/app", at: start - 5 * SEC });
    const finish = r.begin(start);
    return (end) => finish(end, "Which option should we take?");
  }
  const tr = claudeTranscript(root, { sid, cwd: "/w/app", branch: "feat/stop" });
  tr.human(start);
  return (end) => tr.assistantEnd(end, "Which option should we take?", { durationMs: end - start });
}

for (const tool of ["codex", "claude_code"] as const) {
  describe(`Stop の hook の後にトランスクリプトが 60 秒遅れて来る（${tool}）`, () => {
    const sid =
      tool === "codex"
        ? "66666666-0000-4000-8000-000000000001"
        : "66666666-0000-4000-8000-000000000002";
    const start = T0;
    const stopAt = start + 10 * SEC;

    test("Stop で実行中が切れて自分の番、追いついたら問い。返答タスクは 1 件", async () => {
      const { configRoot, hook, card, replies } = setup(tool);
      const finish = beginTurn(tool, configRoot, sid, start);
      hook(sid, "UserPromptSubmit", start);
      env.clock.set(start + 5 * SEC);
      await env.sync();
      expect(card()[0]?.status).toBe("running");

      // Stop の hook が届いた（トランスクリプトの終わりはまだ）
      hook(sid, "Stop", stopAt);
      env.clock.set(stopAt + 2 * SEC);
      await env.sync();
      expect(card()[0]).toMatchObject({ status: "your_turn", status_reason: "hook:stop" });
      // 詳細パネルの流れは Stop の時刻で終わる（「今」まで伸ばさない）
      const d = env.ai.deps.detail(card()[0]?.id as string) as WorkItemDetail;
      expect(d.turns.at(-1)).toMatchObject({ open: false, end: stopAt });
      // 猶予中の行（自分の番の画面）は Stop の時刻から数える
      const grace = env.ai.deps.graceQueue?.() ?? [];
      expect(grace.map((x) => [x.waitingSince, x.grace?.until])).toEqual([
        [stopAt, stopAt + 15 * MIN],
      ]);
      expect(replies()).toEqual([]);

      // 60 秒遅れてトランスクリプトの終わり（問い）が取り込まれる
      finish(stopAt - SEC);
      env.clock.set(stopAt + 60 * SEC);
      await env.sync();
      expect(card()[0]).toMatchObject({ status: "your_turn", status_reason: "question" });

      // 猶予（15 分）の後に返答タスクが 1 件。その後の判定でも増えない
      for (const m of [14, 15, 16, 20, 30]) {
        env.clock.set(stopAt + m * MIN);
        await env.sync();
      }
      // 終わりの時刻はトランスクリプトのもの（Stop の hook の少し前）
      expect(replies()).toHaveLength(1);
      expect(replies()[0]).toMatchObject({ kind: "reply", status: "open" });
      expect(Math.abs((replies()[0]?.trigger_at ?? 0) - (stopAt - SEC))).toBeLessThan(SEC);
    });

    test("追いつくのが猶予より遅くても、Stop で作った返答タスクがそのまま問いのものになる", async () => {
      const { configRoot, hook, card, replies } = setup(tool);
      const finish = beginTurn(tool, configRoot, sid, start);
      hook(sid, "UserPromptSubmit", start);
      hook(sid, "Stop", stopAt);
      env.clock.set(stopAt + 16 * MIN);
      await env.sync();
      expect(card()[0]?.status_reason).toBe("hook:stop");
      expect(replies()).toEqual([{ kind: "reply", status: "open", trigger_at: stopAt }]);
      finish(stopAt - SEC);
      env.clock.set(stopAt + 17 * MIN);
      await env.sync();
      expect(card()[0]?.status_reason).toBe("question");
      expect(replies()).toEqual([{ kind: "reply", status: "open", trigger_at: stopAt }]);
    });

    test("サブエージェントの Stop（agent_id 付き）は親の終わりにしない", async () => {
      const { configRoot, hook, card } = setup(tool);
      beginTurn(tool, configRoot, sid, start);
      hook(sid, "UserPromptSubmit", start);
      hook(sid, "Stop", stopAt, { agent_id: "agent-1" });
      // サブエージェントの会話の Stop（別のセッションの ID）も親を終えない
      hook("66666666-0000-4000-8000-0000000000ff", "Stop", stopAt + SEC);
      env.clock.set(stopAt + 2 * SEC);
      await env.sync();
      expect(card()[0]?.status).toBe("running");
    });
  });
}
