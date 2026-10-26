import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nullLogger } from "@turnlane/collectors";
import { resolvePaths, SCHEMA_VERSION } from "@turnlane/core";
import type { HealthReport } from "../src/health.ts";
import { type RunningDaemon, startDaemon } from "../src/main.ts";

let home: string;
let daemon: RunningDaemon | null = null;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "turnlane-home-"));
});
afterEach(async () => {
  await daemon?.stop();
  daemon = null;
  rmSync(home, { recursive: true, force: true });
});

describe("startDaemon", () => {
  test("一時 HOME で起動し、health が返る。データディレクトリ・DB・トークンの権限", async () => {
    const paths = resolvePaths({ HOME: home }, home);
    daemon = await startDaemon({ paths, logger: nullLogger, port: 0 });
    const r = await fetch(`${daemon.url}/api/health`, {
      headers: { authorization: `Bearer ${daemon.token}` },
    });
    expect(r.status).toBe(200);
    const h = (await r.json()) as HealthReport;
    expect(h.ok).toBe(true);
    expect(h.port).toBe(daemon.port);
    expect(h.db.userVersion).toBe(SCHEMA_VERSION);
    expect(h.db.journalMode).toBe("wal");
    expect(statSync(paths.dataDir).mode & 0o777).toBe(0o700);
    expect(statSync(paths.dbPath).mode & 0o777).toBe(0o600);
    expect(statSync(paths.tokenPath).mode & 0o777).toBe(0o600);
    // 実データの場所ではなく一時 HOME の下にある
    expect(paths.dbPath.startsWith(home)).toBe(true);
  });

  test("2回目の起動ではマイグレーションを再適用せず、同じトークンと device を使う", async () => {
    const paths = resolvePaths({ HOME: home }, home);
    const a = await startDaemon({ paths, logger: nullLogger, port: 0 });
    const tokenA = a.token;
    const deviceA = a.mutateCtx.deviceId;
    await a.stop();
    daemon = await startDaemon({ paths, logger: nullLogger, port: 0 });
    expect(daemon.token).toBe(tokenA);
    expect(daemon.mutateCtx.deviceId).toBe(deviceA);
  });

  test("Host が違うリクエストは 421", async () => {
    const paths = resolvePaths({ HOME: home }, home);
    daemon = await startDaemon({ paths, logger: nullLogger, port: 0 });
    const r = await fetch(`${daemon.url}/api/health`, {
      headers: { host: "evil.example", authorization: `Bearer ${daemon.token}` },
    });
    expect(r.status).toBe(421);
  });
});
