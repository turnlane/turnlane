/**
 * 待ちの中身の限定した保存（ADR 0018、D-218）: 自分の指示の 1 行目（ターンごと）と待ちの中身（フォローアップごと）を
 * 伏せ字の後に持ち、件名はその日の最初の指示で固定する。記録が消えても残る。設定がオフなら持たない。消す操作で消える。
 * 本文はすべて合成のダミー
 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { putSetting } from "@turnlane/core";
import { MASK } from "@turnlane/core/web";
import { type AiEnv, makeAiEnv } from "./helpers/env.ts";
import { claudeTranscript } from "./helpers/transcript.ts";

const MIN = 60_000;
const H = 60 * MIN;
const T0 = Date.UTC(2026, 9, 2, 0, 0);

let env: AiEnv;
afterEach(async () => {
  await env?.cleanup();
});

function setup() {
  env = makeAiEnv({ now: T0 });
  env.git.repos.set("/w/web-app", "/w/web-app");
  const root = join(env.home, ".claude");
  const spool = join(env.dataDir, "spool");
  mkdirSync(spool, { recursive: true });
  const hooks: string[] = [];
  const hook = (sid: string, name: string, at: number, extra: Record<string, string> = {}) => {
    hooks.push(
      JSON.stringify({
        v: 1,
        tool: "claude_code",
        received_at: at,
        config_root: root,
        hook_event_name: name,
        session_id: sid,
        ...extra,
      }),
    );
    writeFileSync(join(spool, "hooks-20261002.jsonl"), `${hooks.join("\n")}\n`);
  };
  const idOf = (branch: string) =>
    env.sqlite
      .query<{ id: string }, [string]>("SELECT id FROM work_item WHERE branch = ?")
      .get(branch)?.id ?? "none";
  const rows = <T>(sql: string) => env.sqlite.query<T, []>(sql).all();
  return { root, hook, idOf, rows };
}

test("指示の 1 行目と許可待ちの中身を伏せ字の後に保存し、件名はその日の最初の指示で固定。記録が消えても残る", async () => {
  const { root, hook, idOf, rows } = setup();
  const sid = "99999999-0000-4000-8000-000000000001";
  const tr = claudeTranscript(root, { sid, cwd: "/w/web-app", branch: "fix/tax" });
  tr.aiTitle(T0, "Tax rounding");
  tr.human(T0, { text: "税率の計算を直して API_TOKEN=abc123def456" });
  tr.assistantEnd(T0 + 5 * MIN, "直しました。");
  tr.human(T0 + 10 * MIN, { text: "はい" });
  tr.assistantEnd(T0 + 11 * MIN, "了解です。");
  tr.human(T0 + 20 * MIN, { text: "テストも足して" });
  tr.toolUse(T0 + 21 * MIN, "Bash", { command: "bun test", description: "Run the tests" });
  hook(sid, "PermissionRequest", T0 + 21 * MIN, { tool_name: "Bash" });
  env.clock.set(T0 + 22 * MIN);
  await env.sync();
  // 短い返事（はい）は持たない。伏せ字の後の文だけ
  const ins = rows<{ text: string; masked: number }>(
    "SELECT text, masked FROM ai_instruction ORDER BY at",
  );
  expect(ins.map((r) => r.text)).toEqual([
    `税率の計算を直して API_TOKEN=${MASK}`,
    "テストも足して",
  ]);
  expect(ins[0]?.masked).toBe(1);
  const w = rows<{ kind: string; tool: string; label: string; command: string }>(
    "SELECT kind, tool, label, command FROM wait_detail",
  );
  expect(w).toEqual([
    { kind: "permission", tool: "Bash", label: "Run the tests", command: "bun test" },
  ]);
  // AI の発言の本文は持たない
  const all =
    JSON.stringify(rows("SELECT * FROM ai_instruction")) +
    JSON.stringify(rows("SELECT * FROM wait_detail"));
  expect(all).not.toContain("直しました");
  expect(all).not.toContain("abc123def456");

  const id = idOf("fix/tax");
  const g = env.ai.deps.glance(id);
  expect(g?.prompt?.text).toBe(`税率の計算を直して API_TOKEN=${MASK}`);
  expect(g?.permission).toMatchObject({ tool: "Bash", label: "Run the tests", detail: "bun test" });

  // 記録が消えても件名と待ちの中身は出る（Claude Code は記録を 30 日で消す）
  rmSync(tr.path);
  const kept = env.ai.deps.glance(id);
  expect(kept?.kind).toBe("permission");
  expect(kept?.prompt?.text).toBe(`税率の計算を直して API_TOKEN=${MASK}`);

  // 詳細の流れ: ターンごとの指示
  const day = env.ai.deps.detail(id) as { turns: { instruction?: string }[] };
  expect(day.turns.map((t) => t.instruction ?? null)).toContain("テストも足して");

  // 消す操作
  expect(env.ai.deps.storedDetail()).toEqual({ instructions: 2, waits: 1 });
  expect(env.ai.deps.clearStoredDetail()).toEqual({ instructions: 2, waits: 1 });
  expect(env.ai.deps.storedDetail()).toEqual({ instructions: 0, waits: 0 });
});

test("翌日はその日の最初の指示が件名。保存がオフなら新しい指示も待ちも持たない", async () => {
  const { root, idOf, rows } = setup();
  const sid = "99999999-0000-4000-8000-000000000002";
  const tr = claudeTranscript(root, { sid, cwd: "/w/web-app", branch: "fix/board" });
  tr.human(T0, { text: "3日ボードの列幅を直して" });
  tr.assistantEnd(T0 + 5 * MIN, "右の列も同じ幅にしますか？");
  tr.human(T0 + 30 * MIN, { text: "右の列の幅をそろえる" });
  tr.assistantEnd(T0 + 35 * MIN, "そろえました。");
  env.clock.set(T0 + 40 * MIN);
  await env.sync();
  const id = idOf("fix/board");
  expect(env.ai.deps.glance(id)?.prompt?.text).toBe("3日ボードの列幅を直して");
  tr.human(T0 + 25 * H, { text: "列幅の E2E を足して" });
  tr.assistantEnd(T0 + 25 * H + 5 * MIN, "足しました。");
  env.clock.set(T0 + 25 * H + 10 * MIN);
  await env.sync();
  expect(env.ai.deps.glance(id)?.prompt?.text).toBe("列幅の E2E を足して");

  putSetting(env.mutate, "turn.store_detail", false);
  tr.human(T0 + 26 * H, { text: "README も直して" });
  tr.assistantEnd(T0 + 26 * H + MIN, "どこを直しますか？");
  env.clock.set(T0 + 26 * H + 30 * MIN);
  await env.sync();
  expect(
    rows<{ text: string }>("SELECT text FROM ai_instruction").map((r) => r.text),
  ).not.toContain("README も直して");
  expect(rows("SELECT * FROM wait_detail")).toEqual([]);
});
