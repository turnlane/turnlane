/**
 * 命令の前の稼働確認（daemonHealth）。launchd に登録されていれば、起動の直後で応答が遅いデーモンを待ってから判定する。
 * 登録が無ければすぐに「動いていません」。デーモンの代わりに一時 HOME と偽の health を返す小さなサーバーを使う
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DAEMON_LABEL, ensureToken, resolvePaths, type TurnlanePaths } from "@turnlane/core";
import { daemonHealth } from "../src/client.ts";
import { openCommand } from "../src/commands/open.ts";
import type { CliEnv } from "../src/env.ts";
import { FakeLaunchctl } from "../src/launchctl.ts";

let home: string;
let server: ReturnType<typeof Bun.serve> | null = null;
let out: string[] = [];

afterEach(() => {
  server?.stop(true);
  server = null;
  rmSync(home, { recursive: true, force: true });
});

/** 空いているポート（一度開いて閉じる） */
function freePort(): number {
  const s = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = s.port as number;
  s.stop(true);
  return port;
}

function setup(registered: boolean): { env: CliEnv; paths: TurnlanePaths } {
  home = mkdtempSync(join(tmpdir(), "turnlane-cli-health-"));
  const paths = { ...resolvePaths({ HOME: home }, home), port: freePort() };
  mkdirSync(dirname(paths.tokenPath), { recursive: true });
  ensureToken(paths.tokenPath);
  const launchctl = new FakeLaunchctl(() => DAEMON_LABEL);
  if (registered) launchctl.loaded.set(DAEMON_LABEL, { loaded: true, state: "running", pid: 4242 });
  out = [];
  const env: CliEnv = {
    paths,
    launchctl,
    out: (s) => out.push(s),
    err: (s) => out.push(`ERR ${s}`),
    execPath: "/usr/local/bin/bun",
    vars: { HOME: home },
  };
  return { env, paths };
}

/** delayMs 後に health を返し始める（起動直後で応答できないデーモンの代わり） */
function serveLater(paths: TurnlanePaths, delayMs: number): void {
  setTimeout(() => {
    server = Bun.serve({
      port: paths.port,
      hostname: "127.0.0.1",
      fetch: (req) =>
        new URL(req.url).pathname === "/api/health"
          ? Response.json({ ok: true, pid: 1, port: paths.port })
          : new Response("not found", { status: 404 }),
    });
  }, delayMs);
}

describe("daemonHealth（命令の前の稼働確認）", () => {
  test("launchd に登録が無ければ待たずに null", async () => {
    const { env } = setup(false);
    const t = Date.now();
    expect(await daemonHealth(env)).toBeNull();
    expect(Date.now() - t).toBeLessThan(1000);
  });

  test("登録されていれば、遅れて応答し始めたデーモンを待つ", async () => {
    const { env, paths } = setup(true);
    serveLater(paths, 800);
    const h = await daemonHealth(env);
    expect(h?.ok).toBe(true);
  });

  test("登録されていても、待つ長さを過ぎて応答が無ければ null", async () => {
    const { env } = setup(true);
    const t = Date.now();
    expect(await daemonHealth(env, 600)).toBeNull();
    expect(Date.now() - t).toBeLessThan(2000);
  });

  test("turnlane open: 起動直後で応答が遅くても「動いていません」を出さない", async () => {
    const { env, paths } = setup(true);
    serveLater(paths, 800);
    expect(await openCommand(env, "board", { print: true })).toBe(0);
    expect(out.some((l) => l.startsWith("ERR"))).toBe(false);
    expect(out[0]).toContain("/auth?t=");
  });

  test("turnlane open: 登録が無く動いていなければ、すぐに案内を出す", async () => {
    const { env } = setup(false);
    expect(await openCommand(env, undefined, { print: true })).toBe(1);
    expect(out.join("\n")).toContain("turnlaned");
  });
});
