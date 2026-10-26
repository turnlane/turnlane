// Usage: bun src/lab-copies.ts <scratchDir>
// Experiments on COPIES of the Codex SQLite files. The originals are only read (copied) and their state is checked before/after.
//
// Matrix: target × condition × dir mode × open method
//   condition: absent   = only the main file (what state_5 / thread_history_1 look like while Codex is not holding them)
//              residual = -wal / -shm left behind by a writer that died (WAL holds an un-checkpointed marker table)
//              live     = a writer process holds the DB open (simulates Codex writing right now)
//   dir mode:  rw       = directory writable (normal user process)
//              ro_dir   = directory chmod 555 (cannot create files next to the DB)
//              sandbox  = sandbox-exec denies file-write* under the directory (like running inside a Codex/agent sandbox)
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CODEX_HOME, METHODS, type Method, TARGETS, diff, probe, snapshot } from "./common";

const scratch = process.argv[2];
if (!scratch) {
  console.error("usage: lab-copies <scratchDir>");
  process.exit(2);
}
const lab = join(realpathSync(scratch), "dayline-s2-lab");
rmSync(lab, { recursive: true, force: true });
mkdirSync(lab, { recursive: true });
const resultsFile = join(import.meta.dir, "../results/lab-copies.jsonl");
writeFileSync(resultsFile, "");

const here = import.meta.dir;
const conditions = ["absent", "residual", "live"] as const;
const dirModes = ["rw", "ro_dir", "sandbox"] as const;

const origBefore = Object.fromEntries(TARGETS.map((t) => [t, snapshot(join(CODEX_HOME, `${t}.sqlite`))]));

function copyOriginal(target: string, dir: string): string {
  const src = join(CODEX_HOME, `${target}.sqlite`);
  const dst = join(dir, `${target}.sqlite`);
  copyFileSync(src, dst);
  // Copy -wal too if present so the copy is a consistent snapshot. -shm is never copied (it is rebuilt from -wal).
  if (existsSync(`${src}-wal`)) copyFileSync(`${src}-wal`, `${dst}-wal`);
  return dst;
}

async function startWriter(db: string): Promise<ReturnType<typeof spawn>> {
  const p = spawn("bun", [join(here, "hold-writer.ts"), db], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise<void>((res, rej) => {
    p.stdout!.on("data", (b: Buffer) => b.toString().includes("ready") && res());
    p.on("exit", (c) => rej(new Error(`writer exited ${c}`)));
  });
  return p;
}

function runProbe(db: string, m: Method, mode: (typeof dirModes)[number], dir: string) {
  const args = [join(here, "probe-one.ts"), db, m];
  const r =
    mode === "sandbox"
      ? spawnSync("sandbox-exec", ["-p", `(version 1)(allow default)(deny file-write* (subpath "${dir}"))`, "bun", ...args])
      : spawnSync("bun", args);
  const out = r.stdout.toString().trim();
  try {
    return JSON.parse(out) as { ok: boolean; tables?: number; err?: string };
  } catch {
    return { ok: false, err: `probe crashed: ${r.stderr.toString().slice(0, 200)}` };
  }
}

const rows: Record<string, unknown>[] = [];
for (const target of TARGETS) {
  // Baseline table count from an immutable open of a plain copy.
  const bdir = join(lab, `${target}-baseline`);
  mkdirSync(bdir);
  const baseTables = probe(copyOriginal(target, bdir), "uri_ro_immutable").tables;

  for (const cond of conditions) {
    for (const mode of dirModes) {
      for (const m of METHODS) {
        const dir = join(lab, `${target}-${cond}-${mode}-${m}`);
        mkdirSync(dir);
        const db = copyOriginal(target, dir);
        let writer: ReturnType<typeof spawn> | undefined;
        if (cond !== "absent") {
          writer = await startWriter(db);
          if (cond === "residual") {
            writer.kill("SIGKILL");
            await new Promise((r) => setTimeout(r, 100));
            writer = undefined;
          }
        }
        if (mode === "ro_dir") chmodSync(dir, 0o555);
        const before = snapshot(db, true);
        const res = runProbe(db, m, mode, dir);
        const after = snapshot(db, true);
        if (mode === "ro_dir") chmodSync(dir, 0o755);
        writer?.kill("SIGTERM");
        const row = {
          target,
          cond,
          mode,
          method: m,
          ok: res.ok,
          err: res.err,
          seesWalMarker: res.ok && cond !== "absent" ? res.tables === (baseTables ?? 0) + 1 : null,
          changes: diff(before, after),
        };
        rows.push(row);
        appendFileSync(resultsFile, `${JSON.stringify(row)}\n`);
      }
    }
  }
}

const origAfter = Object.fromEntries(TARGETS.map((t) => [t, snapshot(join(CODEX_HOME, `${t}.sqlite`))]));
const origChanges = Object.fromEntries(TARGETS.map((t) => [t, diff(origBefore[t]!, origAfter[t]!)]));
appendFileSync(resultsFile, `${JSON.stringify({ originals: origChanges })}\n`);

// Summary: one line per (cond, mode, method) aggregated over targets.
const key = (r: Record<string, unknown>) => `${r.cond}\t${r.mode}\t${r.method}`;
const agg = new Map<string, Record<string, unknown>[]>();
for (const r of rows) agg.set(key(r), [...(agg.get(key(r)) ?? []), r]);
console.log("cond\tmode\tmethod\tok\tseesWal\terr\tchanges");
for (const [k, rs] of agg) {
  const ok = rs.filter((r) => r.ok).length;
  const sees = rs.filter((r) => r.seesWalMarker === true).length;
  const errs = [...new Set(rs.map((r) => r.err).filter(Boolean))].join("|");
  const ch = [...new Set(rs.flatMap((r) => r.changes as string[]))].join(",");
  console.log(`${k}\t${ok}/${rs.length}\t${sees}\t${errs}\t${ch}`);
}
console.log("originals changed during lab:", JSON.stringify(origChanges));
rmSync(lab, { recursive: true, force: true });
