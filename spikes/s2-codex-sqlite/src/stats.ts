// Usage: bun src/stats.ts <scratchDir>
// Schema and aggregate statistics of the Codex SQLite files, computed on a verified temporary COPY.
// Output contains only table/column names, declared types, counts, typeof distributions and NULL rates.
// Exception: for columns named `status` the value distribution is printed, but only values matching /^[a-z_]{1,32}$/ (enum tokens).
import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CODEX_HOME, TARGETS, diff, snapshot } from "./common";

const scratch = process.argv[2];
if (!scratch) {
  console.error("usage: stats <scratchDir>");
  process.exit(2);
}
const work = join(realpathSync(scratch), "dayline-s2-stats");
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

function verifiedCopy(target: string): string {
  const src = join(CODEX_HOME, `${target}.sqlite`);
  const dst = join(work, `${target}.sqlite`);
  for (let i = 0; i < 5; i++) {
    for (const s of ["", "-wal", "-shm"]) rmSync(dst + s, { force: true });
    const b = snapshot(src);
    copyFileSync(src, dst);
    if (existsSync(`${src}-wal`)) copyFileSync(`${src}-wal`, `${dst}-wal`);
    if (diff(b, snapshot(src)).length === 0) return dst;
  }
  throw new Error(`${target}: original kept changing`);
}

const q = (s: string) => `"${s.replaceAll('"', '""')}"`;
const report: Record<string, unknown> = {};
const now = Date.now();

for (const target of TARGETS) {
  const db = new Database(verifiedCopy(target));
  const meta = {
    user_version: (db.query("pragma user_version").get() as { user_version: number }).user_version,
    page_size: (db.query("pragma page_size").get() as { page_size: number }).page_size,
    page_count: (db.query("pragma page_count").get() as { page_count: number }).page_count,
    quick_check: (db.query("pragma quick_check").get() as { quick_check: string }).quick_check,
  };
  const tables = (db.query("select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name").all() as { name: string }[]).map((r) => r.name);
  const tstats: Record<string, unknown> = {};
  for (const t of tables) {
    const rows = (db.query(`select count(*) as n from ${q(t)}`).get() as { n: number }).n;
    const cols = db.query(`pragma table_info(${q(t)})`).all() as { name: string; type: string; notnull: number; pk: number }[];
    const cstats: Record<string, unknown> = {};
    for (const c of cols) {
      const types = db.query(`select typeof(${q(c.name)}) as ty, count(*) as n from ${q(t)} group by 1`).all() as { ty: string; n: number }[];
      const nulls = types.find((x) => x.ty === "null")?.n ?? 0;
      const entry: Record<string, unknown> = {
        decl: c.type,
        typeof: Object.fromEntries(types.map((x) => [x.ty, x.n])),
        nullRate: rows ? +(nulls / rows).toFixed(3) : null,
      };
      if (c.name === "status" && rows) {
        const dist = db.query(`select ${q(c.name)} as v, count(*) as n from ${q(t)} group by 1`).all() as { v: unknown; n: number }[];
        entry.values = Object.fromEntries(dist.map((d) => [typeof d.v === "string" && /^[a-z_]{1,32}$/.test(d.v) ? d.v : "<other>", d.n]));
      }
      cstats[c.name] = entry;
    }
    tstats[t] = { rows, columns: cstats };
  }
  const extra: Record<string, unknown> = {};
  // Coverage figures used by the S2 conclusion (counts only).
  if (target === "state_5" && tables.includes("threads")) {
    const cols = (db.query("pragma table_info(threads)").all() as { name: string }[]).map((c) => c.name);
    const upd = cols.includes("updated_at_ms") ? "updated_at_ms" : cols.includes("updated_at") ? "updated_at" : null;
    if (upd) {
      const mx = (db.query(`select max(${upd}) as m from threads`).get() as { m: number }).m;
      const unitMs = mx > 1e12;
      const since = unitMs ? now - 7 * 864e5 : Math.floor(now / 1000) - 7 * 86400;
      extra.threadsUpdatedLast7d = (db.query(`select count(*) as n from threads where ${upd} >= ?`).get(since) as { n: number }).n;
      extra.updatedAtUnit = unitMs ? "ms" : "s";
    }
  }
  report[target] = { meta, tables: tstats, extra };
  db.close();
}

// Cross-DB coverage: how many threads have rows in thread_turns (ids are compared inside SQLite; none are printed).
{
  const st = new Database(join(work, "state_5.sqlite"));
  st.exec(`attach database '${join(work, "thread_history_1.sqlite")}' as th`);
  try {
    const r = st
      .query(
        `select (select count(*) from threads) as threads,
                (select count(distinct thread_id) from th.thread_turns) as threadsInTurns,
                (select count(*) from threads where id in (select thread_id from th.thread_turns)) as threadsWithTurns,
                (select count(*) from threads where archived = 0 or archived is null) as notArchived`,
      )
      .get();
    report.coverage = r;
  } catch (e) {
    report.coverage = { error: String((e as Error).message) };
  }
  st.close();
}

const out = join(import.meta.dir, "../results/stats.json");
writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
rmSync(work, { recursive: true, force: true });
console.log(`wrote ${out}`);
