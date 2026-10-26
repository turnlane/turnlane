/** turnlane report / turnlane stats と MCP の get_daily_report（M4-3・M5-1）。一時 HOME でデーモンを起動して通す */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nullLogger } from "@turnlane/collectors";
import { FakeClock, putSetting, resolvePaths, type TurnlanePaths } from "@turnlane/core";
import { type RunningDaemon, startDaemon } from "../../daemon/src/main.ts";
import { handleMessage } from "../src/commands/mcp.ts";
import { reportCommand, statsCommand } from "../src/commands/report.ts";
import { addCommand } from "../src/commands/tasks.ts";
import type { CliEnv } from "../src/env.ts";
import { FakeLaunchctl } from "../src/launchctl.ts";

let home: string;
let daemon: RunningDaemon | null = null;
let out: string[] = [];

afterEach(async () => {
  await daemon?.stop();
  daemon = null;
  rmSync(home, { recursive: true, force: true });
});

// 2026-10-02（金）18:00 JST
const NOW = Date.UTC(2026, 9, 2, 9, 0);

async function setup(): Promise<{ env: CliEnv; paths: TurnlanePaths }> {
  home = mkdtempSync(join(tmpdir(), "turnlane-cli-report-"));
  const paths0 = resolvePaths({ HOME: home }, home);
  out = [];
  daemon = await startDaemon({
    paths: paths0,
    logger: nullLogger,
    port: 0,
    ingest: false,
    clock: new FakeClock(NOW),
  });
  putSetting(daemon.mutateCtx, "tz", "Asia/Tokyo");
  const paths = { ...paths0, port: daemon.port };
  const env: CliEnv = {
    paths,
    launchctl: new FakeLaunchctl(() => "x"),
    out: (s) => out.push(s),
    err: (s) => out.push(`ERR ${s}`),
    execPath: "/usr/local/bin/bun",
    vars: { HOME: home },
  };
  return { env, paths };
}

/** デーモンの API を Bearer で呼ぶ（CLI に無い操作の準備に使う） */
const call = (method: string, path: string, body?: unknown) =>
  fetch(`${(daemon as RunningDaemon).url}/api${path}`, {
    method,
    headers: {
      authorization: `Bearer ${(daemon as RunningDaemon).token}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

describe("turnlane report / turnlane stats / get_daily_report", () => {
  test("今日の日報を Markdown で出し、--copy でクリップボードへ渡す", async () => {
    const { env } = await setup();
    // 昨日（10/1）の残りを「今日へ」で移す（D-192）と、昨日の記録の持ち越しの節に出る。今日の記録には出ない
    await addCommand(env, { text: "Invoice template fix", date: "2026-10-01", json: true });
    await call("POST", "/days/2026-10-01/carry", {});
    out = [];
    expect(await reportCommand(env, { date: "2026-10-01", copy: false, lang: "en" })).toBe(0);
    expect(out[0]).toContain("- Invoice template fix → Fri 10/2");
    out = [];
    let copied = "";
    expect(
      await reportCommand(env, {
        copy: true,
        lang: "en",
        copier: async (t) => {
          copied = t;
          return true;
        },
      }),
    ).toBe(0);
    expect(out[0]).toStartWith("## Fri 2026-10-02");
    expect(out[0]).not.toContain("Carried over");
    expect(copied).toBe(`${out[0]}\n`);
    expect(out.at(-1)).toBe("ERR Copied to the clipboard.");
    out = [];
    expect(await reportCommand(env, { date: "2026-10-02", copy: false, lang: "ja" })).toBe(0);
    expect(out[0]).toStartWith("## 2026-10-02（金）");
    expect(await reportCommand(env, { date: "10/2", copy: false })).toBe(2);
    expect(await reportCommand(env, { copy: false, lang: "fr" })).toBe(2);
  });

  test("turnlane stats は14日分の表と自分の番の処理数を出す", async () => {
    const { env } = await setup();
    expect(await statsCommand(env, { json: true })).toBe(0);
    const s = JSON.parse(out[0] as string);
    expect(s.days).toHaveLength(14);
    expect(s.countedDays).toBe(0);
    out = [];
    expect(await statsCommand(env, { days: "7", json: false })).toBe(0);
    // 利用日は「アプリを開いた日」（D-195）
    expect(out[0]).toBe("Days used (opened the app): 0 / 7, streak 0");
    expect(out.filter((l) => /^\d{4}-\d{2}-\d{2}/.test(l))).toHaveLength(7);
    expect(await statsCommand(env, { days: "0", json: false })).toBe(2);
  });

  test("MCP の get_daily_report は日報の Markdown を返す", async () => {
    const { paths } = await setup();
    const state = { ctx: { paths, client: "claude-code", cwd: "/w/app" } };
    const r = (await handleMessage(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "get_daily_report", arguments: {} },
      },
      state,
    )) as {
      result: { isError?: boolean; structuredContent?: { markdown: string; saved: boolean } };
    };
    expect(r.result.isError).toBeUndefined();
    expect(r.result.structuredContent?.saved).toBe(false);
    expect(r.result.structuredContent?.markdown).toContain("Idle 0m");
  });
});
