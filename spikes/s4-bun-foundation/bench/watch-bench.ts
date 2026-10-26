// Drives watcher (separate process) + writer (separate process) per scenario
// and checks that the purely event-driven watcher reads every line.
// Usage: bun bench/watch-bench.ts <scratchDir> [reps] [runner]
//   runner: "bin" (out/dl-bc watch) | "bun" (bun src/dl.ts watch)
import { mkdtempSync } from "node:fs";
import { join } from "node:path";

const scratch = process.argv[2];
const reps = Number(process.argv[3] ?? 3);
const runner = process.argv[4] ?? "bin";
const backends = (process.argv[5] ?? "fs,parcel").split(",");
const scenarios = (process.argv[6] ?? "burst,burst-fd,parallel,newfiles,rotate,biglines,trickle").split(",");
if (!scratch) throw new Error("usage");
const here = join(import.meta.dir, "..");

type Status = { lines: number; rawEvents: number; reads: number; files: number; lagP50: number | null; lagP95: number | null; lagMax: number | null };

async function once(backend: string, scenario: string) {
  const root = mkdtempSync(join(scratch, `dayline-s4-watch-${scenario}-`));
  const cmd =
    runner === "bin"
      ? [join(here, "out/dl-bc"), "watch", root, backend]
      : [process.execPath, join(here, "src/dl.ts"), "watch", root, backend];
  const w = Bun.spawn(cmd, { stdout: "pipe", stderr: "inherit" });
  let last: Status | null = null;
  let ready = false;
  let errors = "";
  (async () => {
    const dec = new TextDecoder();
    let carry = "";
    for await (const chunk of w.stdout) {
      carry += dec.decode(chunk);
      const parts = carry.split("\n");
      carry = parts.pop() ?? "";
      for (const p of parts) {
        try {
          const j = JSON.parse(p);
          if (j.ready) ready = true;
          else last = j;
        } catch {
          errors += p;
        }
      }
    }
  })();
  while (!ready) await Bun.sleep(5);
  await Bun.sleep(200); // let the watch stream settle
  const tw0 = performance.now();
  const wr = Bun.spawn([process.execPath, join(here, "bench/writer.ts"), scenario, root], { stdout: "pipe" });
  const wout = await new Response(wr.stdout).text();
  await wr.exited;
  const writeMs = performance.now() - tw0;
  const expected = JSON.parse(wout.trim().split("\n").pop() as string).expected as number;
  const t0 = performance.now();
  let caughtUpMs: number | null = null;
  while (performance.now() - t0 < 5000) {
    if (last && last.lines >= expected) {
      caughtUpMs = performance.now() - t0;
      break;
    }
    await Bun.sleep(10);
  }
  await Bun.sleep(150);
  w.kill();
  const s = last as Status | null;
  return {
    backend,
    scenario,
    expected,
    got: s?.lines ?? 0,
    ok: (s?.lines ?? 0) === expected,
    writeMs: Math.round(writeMs),
    catchUpAfterWriterExitMs: caughtUpMs === null ? null : Math.round(caughtUpMs),
    rawEvents: s?.rawEvents,
    reads: s?.reads,
    files: s?.files,
    lagP50: s?.lagP50,
    lagP95: s?.lagP95,
    lagMax: s?.lagMax,
    errors: errors || undefined,
  };
}

for (const backend of backends) {
  for (const scenario of scenarios) {
    for (let r = 0; r < reps; r++) {
      try {
        console.log(JSON.stringify(await once(backend, scenario)));
      } catch (e) {
        console.log(JSON.stringify({ backend, scenario, error: String(e) }));
      }
    }
  }
}
