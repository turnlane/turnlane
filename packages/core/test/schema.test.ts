import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { migrate } from "../src/db/migrate.ts";
import { migrations, SCHEMA_VERSION } from "../src/db/migrations/index.ts";
import { openDatabase } from "../src/db/open.ts";

const PLAN = join(import.meta.dir, "../../../docs/spec/phase0-plan.md");

/** phase0-plan.md の「2.3 DDL」の SQL ブロック（DDL の正） */
function specDdl(): string {
  const md = readFileSync(PLAN, "utf8");
  const start = md.indexOf("### 2.3 DDL");
  const block = /```sql\n([\s\S]*?)```/.exec(md.slice(start));
  if (start < 0 || !block?.[1]) throw new Error("DDL block not found in phase0-plan.md");
  return block[1];
}

const norm = (s: string | null) =>
  (s ?? "")
    .replace(/[`"]/g, "")
    .replace(/\s+/g, " ")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")")
    .replace(/\s*,\s*/g, ",")
    .trim()
    .toLowerCase();

/** CREATE TABLE 文から CHECK(...) の式を取り出す（列制約・表制約の区別はしない） */
function checks(createSql: string): string[] {
  const out: string[] = [];
  const re = /\bCHECK\s*\(/gi;
  for (let m = re.exec(createSql); m; m = re.exec(createSql)) {
    let depth = 1;
    let i = m.index + m[0].length;
    const begin = i;
    while (i < createSql.length && depth > 0) {
      if (createSql[i] === "(") depth++;
      else if (createSql[i] === ")") depth--;
      i++;
    }
    out.push(norm(createSql.slice(begin, i - 1)));
  }
  return out.sort();
}

/** 列・インデックス・外部キー・CHECK・ビューを比較できる形にする */
function describeSchema(db: Database) {
  const objs = db
    .query<{ type: string; name: string; tbl_name: string; sql: string | null }, []>(
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name <> '__migrations' ORDER BY type, name",
    )
    .all();
  const tables: Record<string, unknown> = {};
  for (const o of objs.filter((x) => x.type === "table")) {
    const cols = db
      .query<
        { name: string; type: string; notnull: number; dflt_value: string | null; pk: number },
        []
      >(`PRAGMA table_xinfo(${o.name})`)
      .all()
      // drizzle-kit は主キー列に NOT NULL を付ける（DDL の `TEXT PRIMARY KEY` は SQLite の仕様上
      // NULL を許してしまう）。意図は同じなので、主キー列の NOT NULL の有無は比較しない
      .map((c) => [c.name, c.type.toUpperCase(), c.pk > 0 ? 1 : c.notnull, c.dflt_value, c.pk]);
    const fks = db
      .query<{ table: string; from: string; to: string; on_delete: string }, []>(
        `PRAGMA foreign_key_list(${o.name})`,
      )
      .all()
      .map((f) => `${f.from}->${f.table}.${f.to} on delete ${f.on_delete}`)
      .sort();
    tables[o.name] = {
      cols,
      fks,
      checks: checks(o.sql ?? ""),
      autoincrement: /AUTOINCREMENT/i.test(o.sql ?? ""),
    };
  }
  const indexes: Record<string, unknown> = {};
  for (const o of objs.filter((x) => x.type === "index")) {
    const where = /\bWHERE\b([\s\S]*)$/i.exec(o.sql ?? "")?.[1] ?? null;
    const cols = db
      .query<{ name: string }, []>(`PRAGMA index_info(${o.name})`)
      .all()
      .map((c) => c.name);
    indexes[o.name] = {
      table: o.tbl_name,
      unique: /CREATE UNIQUE INDEX/i.test(o.sql ?? ""),
      cols,
      where: where === null ? null : norm(where.replace(/;\s*$/, "")),
    };
  }
  const views = Object.fromEntries(
    objs.filter((x) => x.type === "view").map((v) => [v.name, norm(v.sql)]),
  );
  return { tables, indexes, views };
}

function migratedDb(): Database {
  const db = openDatabase(":memory:");
  migrate(db, migrations);
  return db;
}

describe("スキーマ", () => {
  test("Drizzle のマイグレーションの結果が phase0-plan 2.3 の DDL と一致する", () => {
    const spec = openDatabase(":memory:");
    spec.exec(specDdl());
    const actual = describeSchema(migratedDb());
    const expected = describeSchema(spec);
    expect(Object.keys(actual.tables).sort()).toEqual(Object.keys(expected.tables).sort());
    for (const name of Object.keys(expected.tables)) {
      expect({ name, ...(actual.tables[name] as object) }).toEqual({
        name,
        ...(expected.tables[name] as object),
      });
    }
    expect(actual.indexes).toEqual(expected.indexes);
    expect(actual.views).toEqual(expected.views);
  });

  test("スナップショット（sqlite_master）", () => {
    const db = migratedDb();
    const rows = db
      .query<{ type: string; name: string; sql: string | null }, []>(
        "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
      )
      .all();
    expect(rows).toMatchSnapshot();
  });

  test("user_version は埋め込んだマイグレーションの本数", () => {
    const db = migratedDb();
    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: SCHEMA_VERSION });
  });

  test("migrations/index.ts の一覧が drizzle-kit の _journal.json と一致する", () => {
    const journal = JSON.parse(
      readFileSync(join(import.meta.dir, "../src/db/migrations/meta/_journal.json"), "utf8"),
    ) as { entries: { idx: number; tag: string }[] };
    expect(migrations.map((m) => m.id)).toEqual(journal.entries.map((e) => e.tag));
  });

  test("外部キーが有効（存在しない project への参照は拒否）", () => {
    const db = migratedDb();
    expect(() =>
      db.run(
        "INSERT INTO task (id, title, lane_order, source, project_id, created_at, updated_at, hlc, device_id) VALUES ('t', 'x', 'a0', 'manual', 'nope', 0, 0, 'h', 'd')",
      ),
    ).toThrow(/FOREIGN KEY/);
  });

  test("CHECK: external_source と external_id は両方あるか両方ないか", () => {
    const db = migratedDb();
    const ins = (src: string | null, id: string | null) =>
      db.run(
        "INSERT INTO task (id, title, lane_order, source, external_source, external_id, created_at, updated_at, hlc, device_id) VALUES (?, 'x', 'a0', 'mcp', ?, ?, 0, 0, 'h', 'd')",
        [crypto.randomUUID(), src, id],
      );
    expect(() => ins("github", null)).toThrow(/CHECK/);
    expect(() => ins("GitHub", "1")).toThrow(/CHECK/);
    ins("github", "1");
    expect(() => ins("github", "1")).toThrow(/UNIQUE/);
  });
});
