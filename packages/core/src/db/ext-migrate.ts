/**
 * 拡張のマイグレーション（ADR 0015）。本体の連番（`__migrations`・`PRAGMA user_version`）とは別に、拡張ごとの適用済みを
 * `__ext_migrations` で管理する。拡張を組み込んだビルドで使った DB を、拡張なしのビルドで開いても本体のマイグレーションは
 * 影響を受けない（拡張のテーブルは使われずに残る）。
 *
 * - 拡張のオブジェクト（テーブル・インデックス・ビュー・トリガ）の名前は `ext_<id>_` で始める。文の種類と名前を検査し、
 *   本体のテーブルを作り替える文は受け付けない（取り違えを防ぐための検査で、安全の境界ではない。拡張はビルドで組み込む）
 * - 拡張の中では前進のみ。適用済みの並びが拡張の先頭と一致しなければ例外（別の版の拡張）
 * - 未適用分は拡張ごとに1トランザクション。既存の DB なら適用前に VACUUM INTO でバックアップを取る
 */
import type { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { MigrationError, splitStatements } from "./migrate.ts";

export interface ExtMigration {
  /** 拡張の中で一意（例 `0001_init`）。並びの順に適用する */
  id: string;
  sql: string;
}

export const EXT_ID_RE = /^[a-z][a-z0-9]{1,23}$/;
const MIG_ID_RE = /^[0-9]{4}_[a-z0-9_]+$/;

function ensureTable(db: Database): void {
  db.run(
    "CREATE TABLE IF NOT EXISTS __ext_migrations (ext TEXT NOT NULL, id TEXT NOT NULL, seq INTEGER NOT NULL, applied_at INTEGER NOT NULL, PRIMARY KEY (ext, id))",
  );
}

/** 1つの文が拡張の名前の範囲に収まっているか。収まらなければ理由 */
export function checkExtStatement(extId: string, stmt: string): string | null {
  const prefix = `ext_${extId}_`;
  // コメントを外して1行に
  const s = stmt
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const name = String.raw`[\`"\[]?([A-Za-z0-9_]+)[\`"\]]?`;
  const ok = (n: string | undefined) => !!n && n.startsWith(prefix);
  let m = new RegExp(`^CREATE (?:UNIQUE )?INDEX (?:IF NOT EXISTS )?${name} ON ${name}`, "i").exec(
    s,
  );
  if (m) return ok(m[1]) && ok(m[2]) ? null : `index names and tables must start with ${prefix}`;
  m = new RegExp(
    `^CREATE (?:TEMP |TEMPORARY )?(TABLE|VIEW|TRIGGER) (?:IF NOT EXISTS )?${name}`,
    "i",
  ).exec(s);
  if (m) {
    if (!ok(m[2])) return `${m[1]?.toLowerCase()} names must start with ${prefix}`;
    if (/^TRIGGER$/i.test(m[1] ?? "")) {
      const on = new RegExp(` ON ${name}`, "i").exec(s);
      if (!ok(on?.[1])) return `triggers must be on ${prefix} tables`;
    }
    return null;
  }
  m = new RegExp(
    `^(?:ALTER TABLE|DROP (?:TABLE|INDEX|VIEW|TRIGGER)(?: IF EXISTS)?) ${name}`,
    "i",
  ).exec(s);
  if (m) return ok(m[1]) ? null : `objects must start with ${prefix}`;
  m = new RegExp(
    `^(?:INSERT(?: OR [A-Z]+)? INTO|UPDATE(?: OR [A-Z]+)?|DELETE FROM) ${name}`,
    "i",
  ).exec(s);
  if (m) return ok(m[1]) ? null : `rows may only be written to ${prefix} tables`;
  return "unsupported statement";
}

export function appliedExtMigrations(db: Database, extId: string): string[] {
  ensureTable(db);
  return db
    .query<{ id: string }, [string]>("SELECT id FROM __ext_migrations WHERE ext = ? ORDER BY seq")
    .all(extId)
    .map((r) => r.id);
}

function timestamp(ms: number): string {
  return new Date(ms)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

/** 拡張のマイグレーションを適用する。適用した id を返す */
export function migrateExtension(
  db: Database,
  extId: string,
  migrations: readonly ExtMigration[],
  opts: { backupDir?: string; now?: () => number } = {},
): { applied: string[]; backupPath: string | null } {
  if (!EXT_ID_RE.test(extId))
    throw new MigrationError(`invalid extension id: ${extId}`, null, null);
  const now = opts.now ?? Date.now;
  const seen = new Set<string>();
  for (const m of migrations) {
    if (!MIG_ID_RE.test(m.id) || seen.has(m.id))
      throw new MigrationError(`invalid extension migration id: ${extId}/${m.id}`, m.id, null);
    seen.add(m.id);
    splitStatements(m.sql).forEach((stmt, i) => {
      const why = checkExtStatement(extId, stmt);
      if (why) throw new MigrationError(`extension ${extId}/${m.id}: ${why}`, m.id, i);
    });
  }
  const applied = appliedExtMigrations(db, extId);
  applied.forEach((id, i) => {
    if (migrations[i]?.id !== id)
      throw new MigrationError(
        `database has extension migration ${extId}/${id} that this build does not know`,
        id,
        null,
      );
  });
  const pending = migrations.slice(applied.length);
  if (pending.length === 0) return { applied: [], backupPath: null };
  let backupPath: string | null = null;
  if (opts.backupDir) {
    mkdirSync(opts.backupDir, { recursive: true, mode: 0o700 });
    backupPath = join(opts.backupDir, `pre-migrate-ext-${extId}-${timestamp(now())}.db`);
    db.run("VACUUM INTO ?", [backupPath]);
  }
  let current: ExtMigration | null = null;
  let stmtIndex: number | null = null;
  try {
    db.transaction(() => {
      for (const m of pending) {
        current = m;
        splitStatements(m.sql).forEach((stmt, i) => {
          stmtIndex = i;
          db.run(stmt);
        });
        stmtIndex = null;
        db.run("INSERT INTO __ext_migrations (ext, id, seq, applied_at) VALUES (?, ?, ?, ?)", [
          extId,
          m.id,
          migrations.indexOf(m),
          now(),
        ]);
      }
    }).immediate();
  } catch (e) {
    const id = (current as ExtMigration | null)?.id ?? null;
    throw new MigrationError(
      `extension migration ${extId}/${id ?? "?"} failed at statement ${stmtIndex ?? "-"}: ${(e as Error).message}`,
      id,
      stmtIndex,
      { cause: e },
    );
  }
  return { applied: pending.map((m) => m.id), backupPath };
}
