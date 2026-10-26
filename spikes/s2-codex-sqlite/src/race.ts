// Usage: bun src/race.ts <scratchDir> [readerLoops=400]
// SYNTHETIC DB ONLY (no real data). Mimics how Codex touches state_5 / thread_history_1: a writer process repeatedly
// opens the DB, writes a batch, and closes (the last close checkpoints and deletes -wal/-shm).
// Meanwhile the reader tries the non-writing methods and checks whether a "verified" read can be torn.
//   immutable+verify : stat(main, -wal) before → open immutable, quick_check + count → stat after; accept only if
//                      -wal was absent before and after and main (size, mtime, ino) did not change
//   copy+verify      : stat before → copy main (+ -wal) → stat after; accept only if unchanged; open copy, quick_check
import { Database, constants } from "bun:sqlite";
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { diff, snapshot } from "./common";

const SQLITE_FCNTL_PERSIST_WAL = 10;

if (process.argv[2] === "--writer") {
  const path = process.argv[3]!;
  const blob = "x".repeat(2000);
  for (;;) {
    const db = new Database(path);
    db.fileControl(SQLITE_FCNTL_PERSIST_WAL, 0); // like a non-Apple SQLite: delete -wal/-shm on last close
    db.exec("PRAGMA journal_mode=WAL");
    const ins = db.prepare("insert into t(v) values (?)");
    db.transaction(() => {
      for (let i = 0; i < 50; i++) ins.run(blob);
    })();
    db.exec("delete from t where id <= (select max(id) from t) - 300"); // keep the DB around 1MB like state_5
    ins.finalize(); // an unfinalized statement keeps the connection alive and the -wal would never be removed
    db.close();
    Bun.sleepSync(5 + Math.floor(Math.random() * 30));
  }
}

const scratch = process.argv[2];
const loops = Number(process.argv[3] ?? 400);
if (!scratch) {
  console.error("usage: race <scratchDir> [loops]");
  process.exit(2);
}
const dir = join(realpathSync(scratch), "dayline-s2-race");
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir);
const path = join(dir, "syn.sqlite");
{
  const db = new Database(path);
  db.fileControl(SQLITE_FCNTL_PERSIST_WAL, 0);
  db.exec("PRAGMA journal_mode=WAL; create table t(id integer primary key, v text);");
  db.close();
}
void constants;
const w = spawn("bun", [import.meta.path, "--writer", path], { stdio: "inherit" });
process.on("exit", () => w.kill("SIGKILL"));
await Bun.sleep(300);

type Tally = { accepted: number; rejected: number; acceptedButCorrupt: number; errors: number; sawWal: number };
const imm: Tally = { accepted: 0, rejected: 0, acceptedButCorrupt: 0, errors: 0, sawWal: 0 };
const cpy: Tally = { accepted: 0, rejected: 0, acceptedButCorrupt: 0, errors: 0, sawWal: 0 };
let immNoVerifyCorrupt = 0;

for (let i = 0; i < loops; i++) {
  // immutable + verify
  {
    const b = snapshot(path);
    if (b["-wal"]!.exists) imm.sawWal++;
    let ok = false;
    let err = false;
    try {
      const db = new Database(`file:${path}?mode=ro&immutable=1`, { readonly: true });
      try {
        ok = (db.query("pragma quick_check").get() as { quick_check: string }).quick_check === "ok";
        db.query("select count(*) from t").get();
      } finally {
        db.close();
      }
    } catch {
      err = true;
    }
    const a = snapshot(path);
    const stable = !b["-wal"]!.exists && !a["-wal"]!.exists && diff(b, a).length === 0;
    if (!ok || err) immNoVerifyCorrupt++;
    if (!stable) imm.rejected++;
    else if (err) imm.errors++;
    else {
      imm.accepted++;
      if (!ok) imm.acceptedButCorrupt++;
    }
  }
  // copy + verify
  {
    const dst = join(dir, "copy.sqlite");
    for (const s of ["", "-wal", "-shm"]) rmSync(dst + s, { force: true });
    const b = snapshot(path);
    if (b["-wal"]!.exists) cpy.sawWal++;
    try {
      copyFileSync(path, dst);
      if (existsSync(`${path}-wal`)) copyFileSync(`${path}-wal`, `${dst}-wal`);
    } catch {
      cpy.errors++;
      continue;
    }
    const a = snapshot(path);
    if (diff(b, a).length) {
      cpy.rejected++;
      continue;
    }
    try {
      const db = new Database(dst);
      const ok = (db.query("pragma quick_check").get() as { quick_check: string }).quick_check === "ok";
      db.close();
      cpy.accepted++;
      if (!ok) cpy.acceptedButCorrupt++;
    } catch {
      cpy.errors++;
    }
  }
}
w.kill("SIGKILL");
const out = { loops, immutableVerify: imm, immutableWithoutVerifyBadReads: immNoVerifyCorrupt, copyVerify: cpy };
console.log(JSON.stringify(out, null, 2));
writeFileSync(join(import.meta.dir, "../results/race.json"), `${JSON.stringify(out, null, 2)}\n`);
rmSync(dir, { recursive: true, force: true });
