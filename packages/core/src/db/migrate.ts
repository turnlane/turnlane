import type { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * 埋め込みマイグレーションの適用（phase0-plan 2.5、M0-8、ADR 0007）。
 * Drizzle の migrate() はディスク上のフォルダを読むため単一バイナリでは使えない。
 * drizzle-kit が生成した SQL を `with { type: "text" }` で埋め込み、ここで適用する。
 *
 * - 適用済みは `__migrations` で管理し、`PRAGMA user_version` に適用済みの本数を入れる
 * - 未適用があれば、既存の DB なら適用前に `VACUUM INTO backups/pre-migrate-<n>-<ts>.db` を取る
 * - 未適用分は 1 トランザクションで適用する。失敗したらすべて巻き戻して例外を投げる
 * - 前進のみ（down は無い）
 */

export interface Migration {
  /** ファイル名の拡張子なし（例 `0000_init`）。先頭 4 桁が連番 */
  id: string;
  sql: string;
}

export interface MigrateOptions {
  /** 既存 DB に未適用分があるとき、適用前のバックアップを置くディレクトリ。省略時は取らない */
  backupDir?: string;
  now?: () => number;
}

export interface MigrateResult {
  applied: string[];
  userVersion: number;
  backupPath: string | null;
}

export class MigrationError extends Error {
  constructor(
    message: string,
    readonly migrationId: string | null,
    readonly statementIndex: number | null,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "MigrationError";
  }
}

const BREAKPOINT = "--> statement-breakpoint";
const ID_RE = /^(\d{4})_[a-z0-9_]+$/;

export function splitStatements(sql: string): string[] {
  return sql
    .split(BREAKPOINT)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function ensureTable(db: Database): void {
  db.run(
    "CREATE TABLE IF NOT EXISTS __migrations (id TEXT PRIMARY KEY, seq INTEGER NOT NULL UNIQUE, applied_at INTEGER NOT NULL)",
  );
}

function validate(migrations: readonly Migration[]): void {
  migrations.forEach((m, i) => {
    const match = ID_RE.exec(m.id);
    if (!match) throw new MigrationError(`invalid migration id: ${m.id}`, m.id, null);
    if (Number(match[1]) !== i) {
      throw new MigrationError(`migration ${m.id} is out of sequence (expected ${i})`, m.id, null);
    }
  });
}

export function appliedMigrations(db: Database): string[] {
  ensureTable(db);
  return db
    .query<{ id: string }, []>("SELECT id FROM __migrations ORDER BY seq")
    .all()
    .map((r) => r.id);
}

/** 未適用のマイグレーション。適用済みの並びが埋め込み側の先頭と一致しなければ例外（別の版の DB）。 */
export function pendingMigrations(db: Database, migrations: readonly Migration[]): Migration[] {
  validate(migrations);
  const applied = appliedMigrations(db);
  applied.forEach((id, i) => {
    if (migrations[i]?.id !== id) {
      throw new MigrationError(
        `database has migration ${id} that this build does not know (newer version of turnlane?)`,
        id,
        null,
      );
    }
  });
  return migrations.slice(applied.length);
}

function hasUserTables(db: Database): boolean {
  const row = db
    .query<{ n: number }, []>(
      "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> '__migrations'",
    )
    .get();
  return (row?.n ?? 0) > 0;
}

function timestamp(ms: number): string {
  return new Date(ms)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

export function migrate(
  db: Database,
  migrations: readonly Migration[],
  opts: MigrateOptions = {},
): MigrateResult {
  const now = opts.now ?? Date.now;
  const pending = pendingMigrations(db, migrations);
  const total = migrations.length;
  if (pending.length === 0) {
    return { applied: [], userVersion: readUserVersion(db), backupPath: null };
  }

  let backupPath: string | null = null;
  if (opts.backupDir && hasUserTables(db)) {
    mkdirSync(opts.backupDir, { recursive: true, mode: 0o700 });
    const first = pending[0] as Migration;
    backupPath = join(opts.backupDir, `pre-migrate-${first.id.slice(0, 4)}-${timestamp(now())}.db`);
    db.run("VACUUM INTO ?", [backupPath]);
  }

  // PRAGMA foreign_keys はトランザクション内では変えられない。drizzle-kit がテーブルの作り直しで
  // 出す `PRAGMA foreign_keys=OFF/ON` は、ここでは効かない（必要になったら手書き SQL で扱う）。
  let current: Migration | null = null;
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
        db.run("INSERT INTO __migrations (id, seq, applied_at) VALUES (?, ?, ?)", [
          m.id,
          Number(m.id.slice(0, 4)),
          now(),
        ]);
      }
      db.run(`PRAGMA user_version = ${total}`);
    }).immediate();
  } catch (e) {
    const id = (current as Migration | null)?.id ?? null;
    throw new MigrationError(
      `migration ${id ?? "?"} failed at statement ${stmtIndex ?? "-"}: ${(e as Error).message}`,
      id,
      stmtIndex,
      { cause: e },
    );
  }

  return { applied: pending.map((m) => m.id), userVersion: total, backupPath };
}

export function readUserVersion(db: Database): number {
  return db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
}
