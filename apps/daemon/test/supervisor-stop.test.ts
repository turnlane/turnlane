/**
 * Supervisor を始めている途中（検出を待っている間）に止めても、止めた後にタイマーを作らず、閉じた DB に触らない。
 * 以前は start() が検出を待ったあとに reconcile・probe のタイマーを作っていたので、その間に stop() されると誰も消さない
 * タイマーが残り、DB を閉じた後の reconcile が「Cannot use a closed database」になっていた（遅い CI で別のテストの最中に出る）
 */
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtinAdapters, nullLogger } from "@turnlane/collectors";
import { FakeClock, migrate, migrations, openDatabase } from "@turnlane/core";
import { FakeGit } from "../src/ingest/git.ts";
import { Supervisor } from "../src/ingest/supervisor.ts";

test("検出を待っている間に止めたら、タイマーを作らず、止めた後に DB を読まない", async () => {
  const home = mkdtempSync(join(tmpdir(), "turnlane-stop-"));
  mkdirSync(join(home, "data"), { recursive: true });
  const sqlite = openDatabase(join(home, "data", "turnlane.db"));
  migrate(sqlite, migrations);
  let afterStop = 0;
  let stopped = false;
  const sup = new Supervisor({
    sqlite,
    clock: new FakeClock(Date.UTC(2026, 10, 1)),
    logger: nullLogger,
    adapters: builtinAdapters,
    git: new FakeGit(),
    env: { home, vars: { TURNLANE_DATA_DIR: join(home, "data") } },
    settings: () => ({ tz: "Asia/Tokyo", dayBoundary: 240, storeTitles: true }),
    onChanged: () => {},
    noWatch: true,
    debounceMs: 0,
    reconcileMs: 5,
    liveMs: 5,
    // 検出のたびに呼ばれる（デーモンでは設定を DB から読む）
    extraRoots: () => {
      if (stopped) afterStop++;
      return [];
    },
  });
  const starting = sup.start();
  stopped = true;
  await sup.stop();
  await starting;
  sqlite.close();
  await Bun.sleep(60);
  expect(afterStop).toBe(0);
  rmSync(home, { recursive: true, force: true });
});

test("止めずに DB を閉じた後にタイマーが動いても、未処理のエラーにせずログに残す（止めた後は何もしない）", async () => {
  const home = mkdtempSync(join(tmpdir(), "turnlane-stop-"));
  mkdirSync(join(home, "data"), { recursive: true });
  const sqlite = openDatabase(join(home, "data", "turnlane.db"));
  migrate(sqlite, migrations);
  const warns: string[] = [];
  const push = (event: string) => warns.push(event);
  const sup = new Supervisor({
    sqlite,
    clock: new FakeClock(Date.UTC(2026, 10, 1)),
    logger: { debug: () => {}, info: () => {}, warn: push, error: push },
    adapters: builtinAdapters,
    git: new FakeGit(),
    env: { home, vars: { TURNLANE_DATA_DIR: join(home, "data") } },
    settings: () => ({ tz: "Asia/Tokyo", dayBoundary: 240, storeTitles: true }),
    onChanged: () => {},
    noWatch: true,
    debounceMs: 0,
    reconcileMs: 5,
    liveMs: 5,
    // デーモンでは設定を DB から読む（閉じた DB なら投げる）
    extraRoots: () => {
      sqlite.query("SELECT 1").get();
      return [];
    },
  });
  await sup.start();
  // 始めたまま DB を閉じる（後始末の漏れ）。タイマーが動いて reconcile が失敗する
  sqlite.close();
  await Bun.sleep(40);
  expect(warns).toContain("ingest.reconcile_failed");
  await sup.stop();
  const n = warns.length;
  await Bun.sleep(30);
  expect(warns.length).toBe(n);
  rmSync(home, { recursive: true, force: true });
});
