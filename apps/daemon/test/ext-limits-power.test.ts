/**
 * 拡張点 `power.state()` と `limits.claude(account)`、利用枠の受け口（POST /api/limits/claude）。
 * テスト用の拡張（ext-fixture/daemon.ts）のルートから読む
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nullLogger } from "@turnlane/collectors";
import { FakeClock, resolvePaths } from "@turnlane/core";
import type { ClaudeLimits } from "@turnlane/core/api";
import { FakePower, parseClamshell, parsePmsetBatt } from "../src/ext/power.ts";
import { type RunningDaemon, startDaemon } from "../src/main.ts";
import fixture from "./ext-fixture/daemon.ts";

let home: string;
let daemon: RunningDaemon | null = null;
const T0 = Date.UTC(2026, 9, 2, 12, 0);
const H = 3_600_000;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "turnlane-limits-"));
});
afterEach(async () => {
  await daemon?.stop();
  daemon = null;
  rmSync(home, { recursive: true, force: true });
});

const call = (d: RunningDaemon, method: string, path: string, body?: unknown, auth = true) =>
  fetch(`${d.url}/api${path}`, {
    method,
    headers: {
      ...(auth ? { authorization: `Bearer ${d.token}` } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

async function start(o: { power?: FakePower; clock?: FakeClock } = {}) {
  daemon = await startDaemon({
    paths: resolvePaths({ HOME: home }, home),
    logger: nullLogger,
    port: 0,
    ingest: false,
    extensions: [fixture],
    ...(o.power ? { power: o.power } : {}),
    ...(o.clock ? { clock: o.clock } : {}),
  });
  return daemon;
}

const limitsOf = async (d: RunningDaemon, account?: string) =>
  (
    (await (
      await call(
        d,
        "GET",
        `/ext/test/limits${account ? `?account=${encodeURIComponent(account)}` : ""}`,
      )
    ).json()) as { limits: ClaudeLimits | null }
  ).limits;

describe("power.state()", () => {
  test("電源とふたの状態を読む。読む部品が無ければ null", async () => {
    const power = new FakePower();
    power.state = { ac: false, lidClosed: false };
    const d = await start({ power });
    expect(await (await call(d, "GET", "/ext/test/power")).json()).toEqual({
      ac: false,
      lidClosed: false,
    });
    await d.stop();
    daemon = null;
    const d2 = await start();
    expect(await (await call(d2, "GET", "/ext/test/power")).json()).toEqual({
      ac: null,
      lidClosed: null,
    });
  });

  test("pmset・ioreg の出力の読み方", () => {
    expect(parsePmsetBatt("Now drawing from 'AC Power'\n -InternalBattery-0 80%")).toBe(true);
    expect(parsePmsetBatt("Now drawing from 'Battery Power'\n")).toBe(false);
    expect(parsePmsetBatt("Now drawing from 'UPS Power'")).toBeNull();
    expect(parsePmsetBatt("")).toBeNull();
    expect(parseClamshell('  "AppleClamshellState" = Yes\n')).toBe(true);
    expect(parseClamshell('  "AppleClamshellState" = No\n')).toBe(false);
    expect(parseClamshell("")).toBeNull();
  });
});

describe("limits.claude(account) と受け口", () => {
  test("届いた値をアカウントごとに返す。省略は ~/.claude。リセットを過ぎた枠は落とす。起動し直しても残る", async () => {
    const clock = new FakeClock(T0);
    const d = await start({ clock });
    expect(await limitsOf(d)).toBeNull();
    const dflt = `${home}/.claude`;
    const acme = `${home}/.claude-acme`;
    expect(
      (
        await call(d, "POST", "/limits/claude", {
          account: `${dflt}/`,
          fiveHour: { usedPercentage: 96, resetsAt: T0 + 2 * H },
          sevenDay: { usedPercentage: 40, resetsAt: T0 + 72 * H },
        })
      ).status,
    ).toBe(200);
    await call(d, "POST", "/limits/claude", {
      account: acme,
      fiveHour: { usedPercentage: 10, resetsAt: T0 + 4 * H },
    });
    expect(await limitsOf(d)).toEqual({
      fiveHour: { usedPercentage: 96, resetsAt: T0 + 2 * H },
      sevenDay: { usedPercentage: 40, resetsAt: T0 + 72 * H },
      at: T0,
    });
    expect(await limitsOf(d, acme)).toEqual({
      fiveHour: { usedPercentage: 10, resetsAt: T0 + 4 * H },
      at: T0,
    });
    expect(await limitsOf(d, `${home}/.claude-other`)).toBeNull();
    // 5時間の枠のリセットを過ぎたら、その枠は無い
    clock.set(T0 + 3 * H);
    expect(await limitsOf(d)).toEqual({
      sevenDay: { usedPercentage: 40, resetsAt: T0 + 72 * H },
      at: T0,
    });
    expect(await limitsOf(d, acme)).toEqual({
      fiveHour: { usedPercentage: 10, resetsAt: T0 + 4 * H },
      at: T0,
    });
    await d.stop();
    daemon = null;
    const d2 = await start({ clock });
    expect((await limitsOf(d2))?.sevenDay?.usedPercentage).toBe(40);
  });

  test("受け口: 認証なしは 401、形の違う値は 400", async () => {
    const d = await start();
    const ok = { account: "/u/.claude", fiveHour: { usedPercentage: 1, resetsAt: T0 } };
    expect((await call(d, "POST", "/limits/claude", ok, false)).status).toBe(401);
    expect((await call(d, "POST", "/limits/claude", { ...ok, account: "rel" })).status).toBe(400);
    expect((await call(d, "POST", "/limits/claude", { ...ok, model: "opus" })).status).toBe(400);
    expect(
      (
        await call(d, "POST", "/limits/claude", {
          account: "/u/.claude",
          fiveHour: { usedPercentage: -1, resetsAt: T0 },
        })
      ).status,
    ).toBe(400);
  });
});
