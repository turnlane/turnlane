/**
 * turnlane statusline（Claude の利用枠の受け口）を、本物の CLI のプロセスと一時のデーモンで通しで確かめる:
 * - 包む: 利用者の statusLine に同じ入力を渡し、出力をそのまま返す。利用枠はデーモンに記録される
 * - 包まない: 利用者の statusLine が無ければ何も出さない。利用枠は記録される
 * - デーモンが落ちている: 送らずに素通し（利用者の出力は返す）
 * - 入れ子（利用者の statusLine が turnlane statusline 自身）でも止まる
 * - 記録のファイル（TURNLANE_STATUSLINE_TRACE）には中身を書かない
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { nullLogger } from "@turnlane/collectors";
import { resolvePaths } from "@turnlane/core";
import type { ClaudeLimits } from "@turnlane/core/api";
import { type RunningDaemon, startDaemon } from "../../daemon/src/main.ts";
import fixture from "../../daemon/test/ext-fixture/daemon.ts";

const MAIN = resolve(import.meta.dir, "../src/main.ts");
const RESETS = Math.floor(Date.now() / 1000) + 3600;
const INPUT = JSON.stringify({
  session_id: "s",
  model: { display_name: "Opus" },
  workspace: { current_dir: "/nowhere", project_dir: "/nowhere" },
  rate_limits: {
    five_hour: { used_percentage: 42.5, resets_at: RESETS },
    seven_day: { used_percentage: 7, resets_at: RESETS + 86400 },
  },
});

let home: string;
let daemon: RunningDaemon;
let port: string;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "turnlane-sl-"));
  daemon = await startDaemon({
    paths: resolvePaths({ HOME: home }, home),
    logger: nullLogger,
    port: 0,
    ingest: false,
    extensions: [fixture],
  });
  port = new URL(daemon.url).port;
});
afterAll(async () => {
  await daemon.stop();
  rmSync(home, { recursive: true, force: true });
});

function account(name: string, statusLine?: unknown): string {
  const dir = join(home, `.claude-${name}`);
  mkdirSync(dir, { recursive: true });
  if (statusLine) writeFileSync(join(dir, "settings.json"), JSON.stringify({ statusLine }));
  return dir;
}

async function run(
  env: Record<string, string>,
  input = INPUT,
): Promise<{ out: string; code: number; ms: number }> {
  const t0 = Date.now();
  const p = Bun.spawn([process.execPath, MAIN, "statusline"], {
    env: { PATH: process.env.PATH ?? "", HOME: home, TURNLANE_PORT: port, ...env },
    stdin: new Blob([input]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(p.stdout).text();
  const code = await p.exited;
  return { out, code, ms: Date.now() - t0 };
}

const limitsOf = async (acct: string) =>
  (
    (await (
      await fetch(`${daemon.url}/api/ext/test/limits?account=${encodeURIComponent(acct)}`, {
        headers: { authorization: `Bearer ${daemon.token}` },
      })
    ).json()) as { limits: ClaudeLimits | null }
  ).limits;

describe("turnlane statusline", () => {
  test("包む: 利用者の statusLine に同じ入力を渡し、出力と終了コードをそのまま返す。利用枠を記録する", async () => {
    const dir = account("wrap", {
      type: "command",
      // 入力の model.display_name を読んで返す（入力がそのまま渡ること）。色の制御文字もそのまま
      command: `printf '\\033[2m%s\\033[0m ctx' "$(sed -e 's/.*"display_name":"\\([^"]*\\)".*/\\1/')"; exit 3`,
    });
    const r = await run({ CLAUDE_CONFIG_DIR: dir });
    expect(r.out).toBe("\u001b[2mOpus\u001b[0m ctx");
    expect(r.code).toBe(3);
    expect(await limitsOf(dir)).toMatchObject({
      fiveHour: { usedPercentage: 42.5, resetsAt: RESETS * 1000 },
      sevenDay: { usedPercentage: 7, resetsAt: (RESETS + 86400) * 1000 },
    });
  });

  test("包まない: 利用者の statusLine が無ければ何も出さない。利用枠は記録する", async () => {
    const dir = account("plain");
    const r = await run({ CLAUDE_CONFIG_DIR: dir });
    expect(r.out).toBe("");
    expect(r.code).toBe(0);
    expect((await limitsOf(dir))?.fiveHour?.usedPercentage).toBe(42.5);
  });

  test("rate_limits が無い入力（Pro・Max でない・最初の応答の前）: 素通しし、何も記録しない", async () => {
    const dir = account("nolimits", { type: "command", command: "echo hi" });
    const r = await run({ CLAUDE_CONFIG_DIR: dir }, JSON.stringify({ session_id: "s" }));
    expect(r.out).toBe("hi\n");
    expect(await limitsOf(dir)).toBeNull();
  });

  test("デーモンが落ちている（ポートに誰もいない）: 送らずに利用者の出力を返す", async () => {
    const dir = account("down", { type: "command", command: "echo still" });
    const trace = join(home, "trace-down.jsonl");
    const r = await run({
      CLAUDE_CONFIG_DIR: dir,
      TURNLANE_PORT: "1",
      TURNLANE_STATUSLINE_TRACE: trace,
    });
    expect(r.out).toBe("still\n");
    const rec = JSON.parse(readFileSync(trace, "utf8").trim()) as Record<string, unknown>;
    expect(rec).toMatchObject({ sent: "failed", userStatusLine: true, userExit: 0 });
  });

  test("入れ子（利用者の statusLine が turnlane statusline 自身）でも1段で止まる", async () => {
    const dir = account("loop", {
      type: "command",
      command: `${process.execPath} ${MAIN} statusline; echo end`,
    });
    const r = await run({ CLAUDE_CONFIG_DIR: dir });
    expect(r.out).toBe("end\n");
  });

  test("記録のファイルには中身（モデル・パス・使用率）を書かない", async () => {
    const dir = account("trace", { type: "command", command: "cat >/dev/null; echo x" });
    const trace = join(home, "trace.jsonl");
    await run({ CLAUDE_CONFIG_DIR: dir, TURNLANE_STATUSLINE_TRACE: trace });
    const text = readFileSync(trace, "utf8");
    const rec = JSON.parse(text.trim()) as Record<string, unknown>;
    expect(rec).toMatchObject({
      account: ".claude-trace",
      fiveHour: true,
      sevenDay: true,
      userStatusLine: true,
      userExit: 0,
      sent: "ok",
    });
    expect(text).not.toContain("Opus");
    expect(text).not.toContain(home);
    expect(text).not.toContain("42.5");
  });
});
