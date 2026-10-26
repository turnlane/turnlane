import type { Database } from "bun:sqlite";
import { type BunSQLiteDatabase, drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "./schema.ts";

export type Schema = typeof schema;
/** Drizzle の DB ハンドル（bun-sqlite ドライバ） */
export type DB = BunSQLiteDatabase<Schema> & { $client: Database };

export function createDb(sqlite: Database): DB {
  return drizzle({ client: sqlite, schema });
}
