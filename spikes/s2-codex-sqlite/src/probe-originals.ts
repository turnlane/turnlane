// Usage: bun src/probe-originals.ts <scratchDir> [iterations=30] [intervalMs=2000]
// Probes the REAL Codex SQLite files with methods that cannot write:
//   - immutable : file:...?mode=ro&immutable=1 (main file opened O_RDONLY, no locks, no -wal/-shm)
//   - ro_shm    : file:...?mode=ro&readonly_shm=1, only when both -wal and -shm already exist (all fds read-only)
//   - copy      : copy main (+ -wal if present) into scratch, verify the original's stat did not change during the copy,
//                 open the copy read-write (SQLite replays the WAL into the copy), run quick_check
// readonly / mode=ro without readonly_shm are NOT used on originals (they may create or write -shm; see lab-copies).
// Output: per-iteration JSON lines with table counts, row count of one main table, timings and stat diffs. No values.
import { Database } from "bun:sqlite";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CODEX_HOME, TARGETS, diff, openWith, sanitize, snapshot } from "./common";

const [scratchArg, itArg, ivArg] = process.argv.slice(2);
if (!scratchArg) {
  console.error("usage: probe-originals <scratchDir> [iterations] [intervalMs]");
  process.exit(2);
}
const iterations = Number(itArg ?? 30);
const intervalMs = Number(ivArg ?? 2000);
const work = join(realpathSync(scratchArg), "dayline-s2-copies");
mkdirSync(work, { recursive: true });
const resultsFile = join(import.meta.dir, "../results/probe-originals.jsonl");
writeFileSync(resultsFile, "");

// One representative table per DB to show freshness differences between methods (row count only).
const mainTable: Record<string, string> = { state_5: "threads", thread_history_1: "thread_turns", goals_1: "thread_goals" };

function count(db: Database, table: string): number | null {
  try {
    return (db.query(`select count(*) as n from "${table}"`).get() as { n: number }).n;
  } catch {
    return null;
  }
}

function viaUri(path: string, m: "uri_ro_immutable" | "uri_ro_readonly_shm", table: string) {
  const t0 = performance.now();
  let db: Database | undefined;
  try {
    db = openWith(path, m);
    const n = count(db, table);
    return { ok: true, rows: n, ms: +(performance.now() - t0).toFixed(1) };
  } catch (e) {
    return { ok: false, err: sanitize(String((e as Error).message)) };
  } finally {
    db?.close();
  }
}

function viaCopy(src: string, target: string, table: string) {
  const t0 = performance.now();
  for (let attempt = 1; attempt <= 3; attempt++) {
    const dst = join(work, `${target}.sqlite`);
    for (const s of ["", "-wal", "-shm"]) rmSync(dst + s, { force: true });
    const before = snapshot(src);
    copyFileSync(src, dst);
    if (existsSync(`${src}-wal`)) copyFileSync(`${src}-wal`, `${dst}-wal`);
    const after = snapshot(src);
    const d = diff(before, after);
    if (d.length) continue; // Codex wrote during the copy; retry.
    const db = new Database(dst);
    try {
      const qc = (db.query("pragma quick_check").get() as Record<string, string>)?.quick_check;
      const n = count(db, table);
      return { ok: qc === "ok", quickCheck: qc, rows: n, attempt, bytes: (before.main?.size ?? 0) + (before["-wal"]?.size ?? 0), ms: +(performance.now() - t0).toFixed(1) };
    } finally {
      db.close();
      for (const s of ["", "-wal", "-shm"]) rmSync(dst + s, { force: true });
    }
  }
  return { ok: false, err: "original kept changing during copy (3 attempts)" };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < iterations; i++) {
  for (const target of TARGETS) {
    const src = join(CODEX_HOME, `${target}.sqlite`);
    const table = mainTable[target]!;
    const before = snapshot(src);
    const sidecars = { wal: before["-wal"]!.exists, shm: before["-shm"]!.exists, walBytes: before["-wal"]!.size ?? 0 };
    const immutable = viaUri(src, "uri_ro_immutable", table);
    const roShm = sidecars.wal && sidecars.shm ? viaUri(src, "uri_ro_readonly_shm", table) : { skipped: true };
    const copy = viaCopy(src, target, table);
    const after = snapshot(src);
    const row = { i, at: new Date().toISOString(), target, sidecars, immutable, roShm, copy, statDiff: diff(before, after) };
    appendFileSync(resultsFile, `${JSON.stringify(row)}\n`);
  }
  if (i < iterations - 1) await sleep(intervalMs);
}
rmSync(work, { recursive: true, force: true });
console.log(`wrote ${resultsFile}`);
