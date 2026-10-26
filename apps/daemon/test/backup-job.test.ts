import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nullLogger } from "@turnlane/collectors";
import { FakeClock, listBackups, migrate, migrations, openDatabase } from "@turnlane/core";
import { BackupJob } from "../src/jobs/backup.ts";

let dir: string;
let db: Database;
let clock: FakeClock;
let created: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "turnlane-bjob-"));
  db = openDatabase(join(dir, "d.db"));
  migrate(db, migrations);
  clock = new FakeClock();
  created = [];
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const job = (keep = 14) =>
  new BackupJob({
    db,
    dir: join(dir, "backups"),
    clock,
    tz: "Asia/Tokyo",
    boundary: 240,
    logger: nullLogger,
    keep,
    onCreated: (i) => created.push(i.date),
  });

describe("BackupJob", () => {
  test("論理日付ごとに1回だけ作る（日付区切り 04:00）", () => {
    const j = job();
    clock.set("2026-10-02T01:00:00Z"); // 東京 10:00 → 10/2
    expect(j.runIfDue()).toBe(true);
    clock.set("2026-10-02T14:00:00Z"); // 東京 23:00 → 10/2（作らない）
    expect(j.runIfDue()).toBe(false);
    clock.set("2026-10-02T18:30:00Z"); // 東京 10/3 03:30 → まだ 10/2
    expect(j.runIfDue()).toBe(false);
    clock.set("2026-10-02T19:00:00Z"); // 東京 10/3 04:00 → 10/3
    expect(j.runIfDue()).toBe(true);
    expect(created).toEqual(["2026-10-02", "2026-10-03"]);
    expect(j.status()).toMatchObject({ lastDate: "2026-10-03", count: 2 });
  });

  test("runNow は今日の分を作り直す", () => {
    const j = job();
    clock.set("2026-10-02T01:00:00Z");
    j.runIfDue();
    expect(j.runNow().date).toBe("2026-10-02");
    expect(created).toEqual(["2026-10-02", "2026-10-02"]);
  });

  test("世代数を超えたら古いものを消す", () => {
    const j = job(3);
    for (let i = 0; i < 5; i++) {
      clock.set(Date.parse("2026-10-01T03:00:00Z") + i * 86_400_000);
      j.runIfDue();
    }
    expect(listBackups(join(dir, "backups")).map((b) => b.date)).toEqual([
      "2026-10-05",
      "2026-10-04",
      "2026-10-03",
    ]);
  });
});
