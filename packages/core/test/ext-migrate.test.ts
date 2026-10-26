/** 拡張のマイグレーションと設定のキー（ADR 0015） */
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  checkExtStatement,
  configKeys,
  isKnownConfigKey,
  MigrationError,
  migrate,
  migrateExtension,
  migrations,
  readUserVersion,
  validateConfig,
} from "../src/index.ts";

describe("checkExtStatement", () => {
  test.each([
    ["CREATE TABLE ext_xyz_a (id TEXT PRIMARY KEY)", null],
    ["CREATE TABLE IF NOT EXISTS `ext_xyz_a` (id TEXT)", null],
    ["CREATE INDEX ext_xyz_a_idx ON ext_xyz_a (id)", null],
    ["CREATE UNIQUE INDEX IF NOT EXISTS ext_xyz_b ON ext_xyz_a (id)", null],
    ["ALTER TABLE ext_xyz_a ADD COLUMN x INTEGER", null],
    ["DROP TABLE IF EXISTS ext_xyz_a", null],
    ["INSERT INTO ext_xyz_a (id) VALUES ('x')", null],
    ["UPDATE ext_xyz_a SET id = 'y'", null],
    ["CREATE TRIGGER ext_xyz_t AFTER INSERT ON ext_xyz_a BEGIN SELECT 1; END", null],
  ])("通す: %s", (sql, want) => {
    expect(checkExtStatement("xyz", sql)).toBe(want);
  });
  test.each([
    "CREATE TABLE task2 (id TEXT)",
    "CREATE TABLE ext_other_a (id TEXT)",
    "CREATE INDEX ext_xyz_i ON task (id)",
    "DROP TABLE task",
    "ALTER TABLE task ADD COLUMN x INTEGER",
    "INSERT INTO setting (key, value) VALUES ('a', 'b')",
    "DELETE FROM task",
    "CREATE TRIGGER ext_xyz_t AFTER INSERT ON task BEGIN SELECT 1; END",
    "PRAGMA foreign_keys = OFF",
    "ATTACH DATABASE 'x' AS y",
  ])("拒む: %s", (sql) => {
    expect(checkExtStatement("xyz", sql)).not.toBeNull();
  });
});

describe("migrateExtension", () => {
  test("拡張ごとに1回だけ適用し、本体の user_version を変えない。知らない適用済みがあれば例外", () => {
    const db = new Database(":memory:");
    migrate(db, migrations);
    const v = readUserVersion(db);
    const ms = [{ id: "0001_init", sql: "CREATE TABLE ext_xyz_a (id TEXT PRIMARY KEY)" }];
    expect(migrateExtension(db, "xyz", ms).applied).toEqual(["0001_init"]);
    expect(migrateExtension(db, "xyz", ms).applied).toEqual([]);
    expect(readUserVersion(db)).toBe(v);
    const more = [
      ...ms,
      {
        id: "0002_b",
        sql: "ALTER TABLE ext_xyz_a ADD COLUMN b INTEGER;\n--> statement-breakpoint\nCREATE INDEX ext_xyz_a_b ON ext_xyz_a (b)",
      },
    ];
    expect(migrateExtension(db, "xyz", more).applied).toEqual(["0002_b"]);
    expect(() => migrateExtension(db, "xyz", [])).toThrow(MigrationError);
    expect(() => migrateExtension(db, "xyz", [{ id: "0001_x", sql: "DROP TABLE task" }])).toThrow(
      /ext_xyz_/,
    );
    expect(() => migrateExtension(db, "Bad", ms)).toThrow(/invalid extension id/);
  });

  test("失敗した文があれば巻き戻す", () => {
    const db = new Database(":memory:");
    const ms = [
      {
        id: "0001_init",
        sql: "CREATE TABLE ext_xyz_a (id TEXT);\n--> statement-breakpoint\nINSERT INTO ext_xyz_a (nope) VALUES (1)",
      },
    ];
    expect(() => migrateExtension(db, "xyz", ms)).toThrow(MigrationError);
    expect(db.query("SELECT name FROM sqlite_master WHERE name = 'ext_xyz_a'").all()).toHaveLength(
      0,
    );
  });
});

describe("拡張の設定のキー", () => {
  const extra = { "ext.xyz.level": z.number().int().min(1).max(3) };
  test("本体のキーに足して扱い、値を検証する", () => {
    expect(configKeys(extra)).toContain("ext.xyz.level");
    expect(configKeys()).not.toContain("ext.xyz.level");
    expect(isKnownConfigKey("ext.xyz.level", extra)).toBe(true);
    expect(isKnownConfigKey("ext.xyz.level")).toBe(false);
    expect(validateConfig("ext.xyz.level", 2, extra)).toEqual({ ok: true, value: 2 });
    expect(validateConfig("ext.xyz.level", 9, extra).ok).toBe(false);
    expect(validateConfig("ext.xyz.level", 2).ok).toBe(false);
    expect(validateConfig("tz", "Asia/Tokyo", extra).ok).toBe(true);
  });
});
