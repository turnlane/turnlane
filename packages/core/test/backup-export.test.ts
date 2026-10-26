import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock } from "../src/clock.ts";
import { addDays } from "../src/dates.ts";
import { backupNow, backupPath, listBackups, pruneBackups } from "../src/db/backup.ts";
import { createDb } from "../src/db/client.ts";
import { ensureSelfDevice } from "../src/db/device.ts";
import { exportJsonl } from "../src/db/export.ts";
import { migrate } from "../src/db/migrate.ts";
import { migrations, SCHEMA_VERSION } from "../src/db/migrations/index.ts";
import { insertRow } from "../src/db/mutate.ts";
import { openDatabase } from "../src/db/open.ts";
import { task } from "../src/db/schema.ts";
import { HlcClock } from "../src/hlc.ts";

let dir: string;
let db: Database;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "turnlane-backup-"));
  db = openDatabase(join(dir, "turnlane.db"));
  migrate(db, migrations);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const backups = () => join(dir, "backups");

describe("backupNow", () => {
  test("turnlane-YYYYMMDD.db を 600 で作り、中身は元の DB と同じスキーマ", () => {
    const r = backupNow(db, backups(), "2026-10-02");
    expect(r).toEqual({ path: join(backups(), "turnlane-20261002.db"), created: true });
    expect(statSync(r.path).mode & 0o777).toBe(0o600);
    const bk = new Database(r.path, { readonly: true });
    expect(bk.query("PRAGMA user_version").get()).toEqual({ user_version: SCHEMA_VERSION });
    bk.close();
    expect(readdirSync(backups()).filter((f) => f.includes(".tmp-"))).toEqual([]);
  });

  test("同じ日の2回目は replace=false なら何もしない、replace=true なら作り直す", () => {
    backupNow(db, backups(), "2026-10-02");
    const before = statSync(backupPath(backups(), "2026-10-02")).mtimeMs;
    expect(backupNow(db, backups(), "2026-10-02").created).toBe(false);
    Bun.sleepSync(5);
    expect(backupNow(db, backups(), "2026-10-02", { replace: true }).created).toBe(true);
    expect(statSync(backupPath(backups(), "2026-10-02")).mtimeMs).toBeGreaterThan(before);
  });
});

describe("pruneBackups / listBackups", () => {
  test("新しい順に 14 世代を残す。pre-migrate や他のファイルは消さない", () => {
    for (let i = 0; i < 20; i++) backupNow(db, backups(), addDays("2026-09-01", i));
    writeFileSync(join(backups(), "pre-migrate-0001-20260901T000000Z.db"), "");
    writeFileSync(join(backups(), "note.txt"), "");
    const removed = pruneBackups(backups(), 14);
    expect(removed).toHaveLength(6);
    const list = listBackups(backups());
    expect(list).toHaveLength(14);
    expect(list[0]?.date).toBe("2026-09-20");
    expect(list.at(-1)?.date).toBe("2026-09-07");
    expect(existsSync(join(backups(), "pre-migrate-0001-20260901T000000Z.db"))).toBe(true);
    expect(existsSync(join(backups(), "note.txt"))).toBe(true);
  });
  test("ディレクトリが無ければ空", () => {
    expect(listBackups(join(dir, "nope"))).toEqual([]);
  });
});

describe("exportJsonl", () => {
  test("ヘッダの後に全テーブルの行を JSON Lines で出す", () => {
    const clock = new FakeClock("2026-10-02T00:00:00Z");
    const d = createDb(db);
    const deviceId = ensureSelfDevice(d, clock);
    const ctx = { db: d, clock, deviceId, hlc: new HlcClock(deviceId, clock) };
    insertRow(ctx, task, { title: "書く", laneOrder: "a0", source: "manual" });
    const lines: string[] = [];
    const counts = exportJsonl(db, (l) => lines.push(l), { appVersion: "t", exportedAt: 1 });
    expect(lines.every((l) => l.endsWith("\n"))).toBe(true);
    const [header, ...rows] = lines.map((l) => JSON.parse(l));
    expect(header).toMatchObject({
      type: "header",
      format: "turnlane-export",
      formatVersion: 1,
      schemaVersion: SCHEMA_VERSION,
      appVersion: "t",
      exportedAt: 1,
    });
    expect(counts.task).toBe(1);
    expect(counts.change_log).toBe(1);
    expect(counts.device).toBe(1);
    expect(Object.keys(counts)).not.toContain("__migrations");
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.table === "task")?.row.title).toBe("書く");
  });

  test("読み取り専用の接続でも、別の接続が書き込み中でも出せる", () => {
    const ro = openDatabase(join(dir, "turnlane.db"), { readonly: true });
    const lines: string[] = [];
    exportJsonl(ro, (l) => lines.push(l), { appVersion: "t", exportedAt: 1 });
    expect(JSON.parse(lines[0] as string).type).toBe("header");
    ro.close();
  });
});
