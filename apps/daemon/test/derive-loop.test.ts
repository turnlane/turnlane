/**
 * 判定（derive）が回り続けない・1 回が短いこと（台帳の形を件数だけ合わせた合成。本文はダミー）:
 * - 動いているかの確かめ（5 秒ごと）は、状態が変わらなければ確かめた時刻だけを書き直す。この書き込みで判定を打ち切らない
 *   （打ち切ると、5 秒より長い判定が毎回打ち切られ、打ち切り 3 回 → 譲らない実行 を繰り返していた）
 * - 判定の後に、判定の出力から自分で次の判定を起こさない
 * - セッション 550（終わっていない 197）・ターン約 2,900・在席 887・予定 55・hook 約 6,300 で 1 回 500 ms 未満
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AiEnv, makeAiEnv } from "./helpers/env.ts";

let env: AiEnv;
afterEach(async () => {
  await env?.cleanup();
});

const MIN = 60_000;
const H = 60 * MIN;
const NOW = Date.UTC(2026, 10, 1, 10, 0);

/** 実機の台帳の形の合成（件数だけ合わせる）。1 つの項目に 40 セッション、終わっていないセッション 197 */
function ledgerShape(e: AiEnv): { liveSid: string } {
  e.git.repos.set("/w/app", "/w/app");
  e.git.defaults.set("/w/app", "main");
  e.git.dirty.set("/w/app", true);
  const root = join(e.home, ".claude/projects");
  const spool = join(e.dataDir, "spool");
  mkdirSync(spool, { recursive: true });
  let n = 0;
  const hooks: string[] = [];
  const hook = (sid: string, at: number, name: string, cwd: string) =>
    hooks.push(
      JSON.stringify({
        v: 1,
        tool: "claude_code",
        received_at: at,
        config_root: join(e.home, ".claude"),
        hook_event_name: name,
        session_id: sid,
        cwd,
      }),
    );
  const rec = (sid: string, at: number, cwd: string, branch: string, body: object) =>
    `${JSON.stringify({
      timestamp: new Date(at).toISOString(),
      sessionId: sid,
      uuid: `u${n++}`,
      isSidechain: false,
      cwd,
      gitBranch: branch,
      version: "2.1.300",
      entrypoint: "cli",
      ...body,
    })}\n`;
  const SESS = 550;
  for (let i = 0; i < SESS; i++) {
    const sid = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
    const cwd = i < 40 || i % 2 === 0 ? "/w/app" : `/w/other${i % 9}`;
    const branch = i < 40 ? "feat/big" : i % 4 === 0 ? "main" : `feat/b${i % 30}`;
    const dir = join(root, `-w-app${i % 7}`);
    mkdirSync(dir, { recursive: true });
    const start = NOW - (i % 30) * 24 * H - (i % 10) * MIN - 2 * H;
    const turns = i === 0 ? 150 : 5;
    let text = "";
    for (let t = 0; t < turns; t++) {
      const at = start - (turns - t) * 15 * MIN;
      text += rec(sid, at, cwd, branch, {
        type: "user",
        promptId: `p${n}`,
        origin: { kind: "human" },
        promptSource: "typed",
        message: { role: "user", content: t % 3 === 0 ? "how do I check it?" : "fix the tests" },
      });
      hook(sid, at, "UserPromptSubmit", cwd);
      text += rec(sid, at + 30_000, cwd, branch, {
        type: "assistant",
        message: {
          id: `m${n}`,
          model: "claude-x",
          stop_reason: "tool_use",
          usage: { input_tokens: 1, output_tokens: 1 },
          content: [{ type: "tool_use", id: `e${n}`, name: "Edit", input: {} }],
        },
      });
      text += rec(sid, at + 60_000, cwd, branch, {
        type: "assistant",
        message: {
          id: `m${n}`,
          model: "claude-x",
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
          content: [{ type: "text", text: "Done. Shall I also update the docs?" }],
        },
      });
      text += rec(sid, at + 61_000, cwd, branch, {
        type: "system",
        subtype: "turn_duration",
        durationMs: 61_000,
      });
      hook(sid, at + 61_000, "Stop", cwd);
      if (t % 2 === 0) hook(sid, at + 62_000, "Notification", cwd);
    }
    // 197 は終わっていない（SessionEnd が無い）
    if (i >= 197) hook(sid, start + 3 * H, "SessionEnd", cwd);
    writeFileSync(join(dir, `${sid}.jsonl`), text);
  }
  writeFileSync(join(spool, "hooks-20261101.jsonl"), `${hooks.join("\n")}\n`);
  // 在席 887（約 21 日）と予定 55
  const ins = e.sqlite.query(
    "INSERT INTO presence_span (id, start_at, end_at, source, updated_at) VALUES (?, ?, ?, 'hid', ?)",
  );
  for (let k = 0; k < 887; k++) {
    const t = NOW - 21 * 24 * H + k * 34 * MIN;
    ins.run(`p${k}`, t, t + 20 * MIN, NOW);
  }
  e.sqlite.run(
    "INSERT INTO calendar (id, external_id, name, created_at, updated_at) VALUES ('c1', 'x', 'Work', ?, ?)",
    [NOW, NOW],
  );
  const ev = e.sqlite.query(
    "INSERT INTO calendar_event (id, calendar_id, external_id, occurrence_start, start_at, end_at, status, availability, fetched_at) VALUES (?, 'c1', ?, ?, ?, ?, 'confirmed', 'busy', ?)",
  );
  for (let k = 0; k < 55; k++) {
    const st = NOW - 20 * 24 * H + k * 9 * H;
    ev.run(`e${k}`, `x${k}`, st, st, st + H, NOW);
  }
  // 動いている Claude Code のセッション（このテストのプロセスの pid。5 秒ごとの確かめが、確かめた時刻だけを書き直す）
  const liveSid = "00000000-0000-4000-8000-000000000001";
  mkdirSync(join(e.home, ".claude/sessions"), { recursive: true });
  writeFileSync(
    join(e.home, ".claude/sessions", `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, sessionId: liveSid, status: "busy", updatedAt: NOW }),
  );
  return { liveSid };
}

describe("判定が回り続けない（台帳の形の合成）", () => {
  test("1 回 500 ms 未満。確かめた時刻だけの書き直しでは打ち切らず、判定の後に自分で次の判定を起こさない", async () => {
    env = makeAiEnv({ now: NOW });
    ledgerShape(env);
    await env.ai.supervisor.beginIngest();
    await env.sync();
    const counts = env.sqlite
      .query<{ s: number; open: number; t: number; h: number }, []>(
        "SELECT (SELECT count(*) FROM ai_session) s, (SELECT count(*) FROM hook_event) h, (SELECT count(*) FROM ai_turn) t, (SELECT count(*) FROM ai_session WHERE ended_at IS NULL) open",
      )
      .get();
    expect(counts?.s).toBe(550);
    expect(counts?.t).toBeGreaterThan(2800);
    expect(counts?.h).toBeGreaterThan(6000);
    expect(counts?.open).toBeGreaterThanOrEqual(197);
    const live = () =>
      env.sqlite
        .query<{ c: number | null }, []>(
          "SELECT live_checked_at AS c FROM ai_session WHERE live_status = 'busy' LIMIT 1",
        )
        .get()?.c ?? null;
    expect(live()).not.toBeNull();

    const r = env.ai.runner;
    // 1 回の時間（同期。区切りで譲らない）
    env.clock.set(NOW + MIN);
    const a = performance.now();
    r.runOnce();
    expect(performance.now() - a).toBeLessThan(500);

    // 非同期の実行の間、確かめを回し続ける（毎回、確かめた時刻だけを書き直す）
    const aborted0 = r.abortedRuns;
    const before = live();
    let probing = true;
    const probe = (async () => {
      while (probing) {
        env.clock.set(env.clock.now() + 5);
        await env.ai.supervisor.probeLive();
        await new Promise<void>((res) => setImmediate(res));
      }
    })();
    try {
      await r.runNow();
    } finally {
      probing = false;
      await probe;
    }
    expect(live()).not.toBe(before);
    expect(r.abortedRuns).toBe(aborted0);

    // 判定の後、何も起きなければ次の判定は来ない（判定の出力が判定を起こさない）
    const runs = r.completedRuns;
    await Bun.sleep(1500);
    await r.idle();
    expect(r.completedRuns).toBe(runs);
  }, 60_000);
});
