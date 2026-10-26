import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * DB を開き、接続ごとの PRAGMA を設定する（phase0-plan 2.2）。
 * journal_mode=WAL、synchronous=NORMAL、foreign_keys=ON、busy_timeout=5000、temp_store=MEMORY。
 * 新規作成時はディレクトリを 700、DB を 600 にする。
 */
export function openDatabase(path: string, opts: { readonly?: boolean } = {}): Database {
  if (opts.readonly) {
    const db = new Database(path, { readonly: true, strict: true });
    db.run("PRAGMA busy_timeout = 5000");
    db.run("PRAGMA foreign_keys = ON");
    return db;
  }
  if (path !== ":memory:") {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const isNew = path === ":memory:" || !existsSync(path);
  const db = new Database(path, { create: true, strict: true });
  if (isNew && path !== ":memory:") chmodSync(path, 0o600);
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA synchronous = NORMAL");
  db.run("PRAGMA foreign_keys = ON");
  db.run("PRAGMA busy_timeout = 5000");
  db.run("PRAGMA temp_store = MEMORY");
  return db;
}
