// S4 spike: bun:sqlite (WAL) + Drizzle inside a compiled binary.
// Not production code.
import { Database } from "bun:sqlite";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
// Migration SQL embedded into the binary as text (no files needed at runtime).
import migration0000 from "../drizzle/0000_init.sql" with { type: "text" };

export const events = sqliteTable("events", {
  id: text("id").primaryKey(),
  source: text("source").notNull(),
  ts: integer("ts").notNull(),
  kind: text("kind").notNull(),
});

export const cursors = sqliteTable("cursors", {
  path: text("path").primaryKey(),
  offset: integer("offset").notNull(),
});

function openDb(path: string) {
  const sqlite = new Database(path, { create: true, strict: true });
  sqlite.run("PRAGMA journal_mode = WAL;");
  sqlite.run("PRAGMA synchronous = NORMAL;");
  sqlite.run("PRAGMA busy_timeout = 5000;");
  sqlite.run("PRAGMA foreign_keys = ON;");
  return { sqlite, db: drizzle({ client: sqlite }) };
}

/** Apply embedded migrations by hand (no filesystem access). */
function applyEmbedded(sqlite: Database) {
  sqlite.run(
    "CREATE TABLE IF NOT EXISTS __migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)",
  );
  const done = sqlite.query("SELECT 1 FROM __migrations WHERE id = ?").get("0000_init");
  if (done) return false;
  sqlite.transaction(() => {
    for (const stmt of migration0000.split("--> statement-breakpoint")) {
      if (stmt.trim()) sqlite.run(stmt);
    }
    sqlite.run("INSERT INTO __migrations VALUES (?, ?)", ["0000_init", Date.now()]);
  })();
  return true;
}

export async function runDbCheck(args: string[]) {
  const path = args[0] ?? "./spike.db";
  const mode = args[1] ?? "embedded"; // embedded | folder:<dir>
  const { sqlite, db } = openDb(path);
  const journal = sqlite.query("PRAGMA journal_mode").get() as { journal_mode: string };

  if (mode === "embedded") {
    console.log("migrate(embedded) applied:", applyEmbedded(sqlite));
  } else if (mode.startsWith("folder:")) {
    // Drizzle's migrator reads <dir>/meta/_journal.json from disk.
    migrate(db, { migrationsFolder: mode.slice("folder:".length) });
    console.log("migrate(folder) ok");
  }

  const t0 = performance.now();
  const N = 10_000;
  db.transaction((tx) => {
    for (let i = 0; i < N; i++) {
      tx.insert(events)
        .values({ id: Bun.randomUUIDv7(), source: `s${i % 8}`, ts: Date.now(), kind: "append" })
        .run();
    }
    tx.insert(cursors)
      .values({ path: "/tmp/x.jsonl", offset: N })
      .onConflictDoUpdate({ target: cursors.path, set: { offset: N } })
      .run();
  });
  const t1 = performance.now();

  const [{ count }] = db
    .select({ count: sql<number>`count(*)` })
    .from(events)
    .where(eq(events.source, "s3"))
    .all();
  const cur = db.select().from(cursors).where(eq(cursors.path, "/tmp/x.jsonl")).get();
  console.log(
    JSON.stringify({
      journal_mode: journal.journal_mode,
      inserted: N,
      insert_ms: Math.round(t1 - t0),
      s3_count: count,
      cursor: cur,
      sqlite_version: (sqlite.query("select sqlite_version() v").get() as { v: string }).v,
    }),
  );
  sqlite.close();
}

/** Writer loop for multi-process WAL check. */
export async function runDbWriter(args: string[]) {
  const path = args[0] ?? "./spike.db";
  const seconds = Number(args[1] ?? 3);
  const { sqlite, db } = openDb(path);
  applyEmbedded(sqlite);
  const end = Date.now() + seconds * 1000;
  let n = 0;
  while (Date.now() < end) {
    db.transaction((tx) => {
      for (let i = 0; i < 50; i++) {
        tx.insert(events)
          .values({ id: Bun.randomUUIDv7(), source: "w", ts: Date.now(), kind: "w" })
          .run();
        n++;
      }
    });
    await Bun.sleep(1);
  }
  console.log(JSON.stringify({ writer_rows: n }));
  sqlite.close();
}

/** Reader loop (readonly) for multi-process WAL check. */
export async function runDbReader(args: string[]) {
  const path = args[0] ?? "./spike.db";
  const seconds = Number(args[1] ?? 3);
  const sqlite = new Database(path, { readonly: true });
  sqlite.run("PRAGMA busy_timeout = 5000;");
  const db = drizzle({ client: sqlite });
  const end = Date.now() + seconds * 1000;
  let reads = 0;
  let errors = 0;
  let last = 0;
  while (Date.now() < end) {
    try {
      const [{ c }] = db.select({ c: sql<number>`count(*)` }).from(events).all();
      if (c < last) errors++;
      last = c;
      reads++;
    } catch (e) {
      errors++;
      console.error(String(e));
    }
    await Bun.sleep(2);
  }
  console.log(JSON.stringify({ reader_reads: reads, reader_errors: errors, last_count: last }));
  sqlite.close();
}
