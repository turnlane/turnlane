/**
 * mutate 層（phase0-plan 2.4、ADR 0002）。同期対象テーブルへの書き込みは必ずここを通す。
 *
 * どの関数も 1 トランザクション内で
 * - id（UUIDv7）/ created_at / updated_at / hlc / device_id を付与し
 * - 行の sync_scope が 'synced' なら change_log に (tbl, row_id, op, hlc, patch_json) を追記する。
 * patch_json は変更したフィールドだけを DB の列名（snake_case）で持つ。
 *
 * 同期対象テーブルを他の場所から直接 insert / update / delete することは
 * Biome のプラグイン（biome-plugins/no-direct-synced-write.grit）で禁止している。
 */
import { and, eq, getTableColumns, getTableName, type SQL, sql } from "drizzle-orm";
import type { BaseSQLiteDatabase, SQLiteColumn } from "drizzle-orm/sqlite-core";
import type { Clock } from "../clock.ts";
import type { HlcClock } from "../hlc.ts";
import { newId } from "../ids.ts";
import type { DB, Schema } from "./client.ts";
import {
  changeLog,
  dailyNote,
  followUp,
  project,
  setting,
  task,
  taskTimeEntry,
  timeBlock,
  workItem,
} from "./schema.ts";

export interface MutateCtx {
  db: DB;
  clock: Clock;
  hlc: HlcClock;
  deviceId: string;
}

/** 同期用カラム（id, created_at, updated_at, hlc, device_id, deleted_at, sync_scope）を持つテーブル */
export const SYNCED_TABLES = {
  project,
  task,
  task_time_entry: taskTimeEntry,
  time_block: timeBlock,
  work_item: workItem,
  follow_up: followUp,
  daily_note: dailyNote,
} as const;

export type SyncedTable = (typeof SYNCED_TABLES)[keyof typeof SYNCED_TABLES];
export type RowOf<T extends SyncedTable> = T["$inferSelect"];
type AutoKeys = "id" | "createdAt" | "updatedAt" | "hlc" | "deviceId";
export type InsertOf<T extends SyncedTable> = Omit<T["$inferInsert"], AutoKeys> & {
  /** 通常は省略（UUIDv7 を振る）。取り込み元の ID を引き継ぐ場合だけ渡す */
  id?: string;
};
export type PatchOf<T extends SyncedTable> = Partial<Omit<T["$inferInsert"], AutoKeys>>;

export class RowNotFoundError extends Error {
  constructor(table: string, id: string) {
    super(`${table} row not found: ${id}`);
    this.name = "RowNotFoundError";
  }
}

type AnyRow = Record<string, unknown>;
/** DB とトランザクションの共通の型 */
type Tx = BaseSQLiteDatabase<"sync", unknown, Schema>;
/**
 * ジェネリックなテーブルに対する .set() の引数。drizzle の型はテーブルが具体的でないと
 * 解決できないため、呼び出し側で値を組み立てた後にこの型へ寄せる。
 */
type UpdateSet<T extends SyncedTable> = Parameters<ReturnType<Tx["update"]>["set"]>[0] &
  Partial<T["$inferInsert"]>;

/** drizzle のプロパティ名 → DB の列名で patch を作る */
function toColumnPatch(table: SyncedTable, values: AnyRow): Record<string, unknown> {
  const cols = getTableColumns(table) as Record<string, SQLiteColumn>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) {
    const col = cols[k];
    if (col && v !== undefined) out[col.name] = v;
  }
  return out;
}

function logChange(
  ctx: MutateCtx,
  tx: Tx,
  table: SyncedTable,
  rowId: string,
  op: "insert" | "update" | "delete",
  hlc: string,
  patch: AnyRow,
): void {
  // biome-ignore lint/plugin: change_log は mutate 層だけが書く
  tx.insert(changeLog)
    .values({
      tbl: getTableName(table),
      rowId,
      op,
      hlc,
      deviceId: ctx.deviceId,
      patchJson: JSON.stringify(toColumnPatch(table, patch)),
      createdAt: ctx.clock.now(),
    })
    .run();
}

function stamp(ctx: MutateCtx) {
  const now = ctx.clock.now();
  return { now, hlc: ctx.hlc.now() };
}

export function insertRow<T extends SyncedTable>(
  ctx: MutateCtx,
  table: T,
  values: InsertOf<T>,
): RowOf<T> {
  return ctx.db.transaction((tx) => {
    const { now, hlc } = stamp(ctx);
    const full = {
      ...values,
      id: values.id ?? newId(ctx.clock),
      createdAt: now,
      updatedAt: now,
      hlc,
      deviceId: ctx.deviceId,
    } as T["$inferInsert"];
    const row = tx.insert(table).values(full).returning().get() as RowOf<T>;
    if (row.syncScope === "synced") logChange(ctx, tx, table, row.id, "insert", hlc, row);
    return row;
  });
}

export function updateRow<T extends SyncedTable>(
  ctx: MutateCtx,
  table: T,
  id: string,
  patch: PatchOf<T>,
): RowOf<T> {
  return ctx.db.transaction((tx) => {
    const { now, hlc } = stamp(ctx);
    const set = { ...patch, updatedAt: now, hlc, deviceId: ctx.deviceId } as UpdateSet<T>;
    const rows = tx.update(table).set(set).where(eq(table.id, id)).returning().all() as RowOf<T>[];
    const row = rows[0];
    if (!row) throw new RowNotFoundError(getTableName(table), id);
    if (row.syncScope === "synced") logChange(ctx, tx, table, id, "update", hlc, patch);
    return row;
  });
}

/** 論理削除（deleted_at を入れる）。すでに削除済みなら何もしない。 */
export function softDelete<T extends SyncedTable>(ctx: MutateCtx, table: T, id: string): void {
  ctx.db.transaction((tx) => {
    const current = tx
      .select({ deletedAt: table.deletedAt })
      .from(table)
      .where(eq(table.id, id))
      .get();
    if (!current) throw new RowNotFoundError(getTableName(table), id);
    if (current.deletedAt !== null) return;
    const { now, hlc } = stamp(ctx);
    const row = tx
      .update(table)
      .set({ deletedAt: now, updatedAt: now, hlc, deviceId: ctx.deviceId } as UpdateSet<T>)
      .where(eq(table.id, id))
      .returning()
      .get() as RowOf<T>;
    if (row.syncScope === "synced")
      logChange(ctx, tx, table, id, "delete", hlc, { deletedAt: now });
  });
}

/**
 * `ON CONFLICT (a, b) WHERE <cond> DO NOTHING` の (…) WHERE 部分を作る。
 * drizzle-orm 0.45.3 の onConflictDoNothing({ where }) は WHERE を DO NOTHING の後ろに出してしまい
 * SQLite の構文エラーになる。部分インデックスを衝突対象にするため、target を SQL で組み立てる
 * （drizzle は target を `(…)` で囲んで出力する）。
 */
function conflictTargetSql(cols: SQLiteColumn[], where: SQL | undefined): SQL {
  const names = sql.raw(cols.map((c) => `"${c.name}"`).join(", "));
  return where ? sql`${names}) WHERE (${where}` : names;
}

/**
 * 外部取り込み用: UNIQUE 制約（例 task_external_uq）に当たったら挿入せず既存行を返す。
 * 部分インデックスの場合は targetWhere（例 `external_source IS NOT NULL`）を渡す。
 * 挿入した場合だけ change_log を書く。論理削除済みの行も既存として返す（作り直さない）。
 */
export function insertRowIfAbsent<T extends SyncedTable>(
  ctx: MutateCtx,
  table: T,
  values: InsertOf<T>,
  conflictTarget: readonly (keyof RowOf<T> & string)[],
  targetWhere?: SQL,
): { row: RowOf<T>; created: boolean } {
  return ctx.db.transaction((tx) => {
    const cols = getTableColumns(table) as Record<string, SQLiteColumn>;
    const targetCols = conflictTarget.map((k) => {
      const c = cols[k];
      if (!c) throw new Error(`unknown column ${k}`);
      return c;
    });
    const { now, hlc } = stamp(ctx);
    const full = {
      ...values,
      id: values.id ?? newId(ctx.clock),
      createdAt: now,
      updatedAt: now,
      hlc,
      deviceId: ctx.deviceId,
    } as T["$inferInsert"];
    const inserted = tx
      .insert(table)
      .values(full)
      .onConflictDoNothing({ target: conflictTargetSql(targetCols, targetWhere) })
      .returning()
      .all() as RowOf<T>[];
    const row = inserted[0];
    if (row) {
      if (row.syncScope === "synced") logChange(ctx, tx, table, row.id, "insert", hlc, row);
      return { row, created: true };
    }
    const conds = targetCols.map((c, i) => {
      const v = (values as AnyRow)[conflictTarget[i] as string];
      return v === null || v === undefined ? sql`${c} IS NULL` : eq(c, v);
    });
    const existing = tx
      .select()
      .from(table)
      .where(and(...conds))
      .get() as RowOf<T> | undefined;
    if (!existing) throw new Error("conflict reported but existing row not found");
    return { row: existing, created: false };
  });
}

/** setting（主キーは key、論理削除なし）の upsert。sync_scope が 'synced' の行だけ change_log を書く */
export function putSetting(
  ctx: MutateCtx,
  key: string,
  value: unknown,
  syncScope: "synced" | "local_only" = "local_only",
): void {
  ctx.db.transaction((tx) => {
    const { now, hlc } = stamp(ctx);
    const valueJson = JSON.stringify(value);
    // biome-ignore lint/plugin: mutate 層の本体
    tx.insert(setting)
      .values({ key, valueJson, updatedAt: now, hlc, deviceId: ctx.deviceId, syncScope })
      .onConflictDoUpdate({
        target: setting.key,
        set: { valueJson, updatedAt: now, hlc, deviceId: ctx.deviceId, syncScope },
      })
      .run();
    if (syncScope === "synced") {
      // biome-ignore lint/plugin: change_log は mutate 層だけが書く
      tx.insert(changeLog)
        .values({
          tbl: "setting",
          rowId: key,
          op: "update",
          hlc,
          deviceId: ctx.deviceId,
          patchJson: JSON.stringify({ value_json: valueJson }),
          createdAt: now,
        })
        .run();
    }
  });
}

export function getSetting<V>(db: DB, key: string): V | undefined {
  const row = db
    .select({ valueJson: setting.valueJson })
    .from(setting)
    .where(eq(setting.key, key))
    .get();
  return row ? (JSON.parse(row.valueJson) as V) : undefined;
}

/** HLC の復元用: change_log の最大 hlc（phase0-plan 2.4） */
export function maxChangeLogHlc(db: DB): string | null {
  const row = db
    .select({ hlc: sql<string | null>`max(${changeLog.hlc})` })
    .from(changeLog)
    .get();
  return row?.hlc ?? null;
}
