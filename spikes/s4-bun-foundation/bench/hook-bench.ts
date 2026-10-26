// Measures wall time from spawn to exit of `dl hook`-equivalent binaries.
// Usage: bun bench/hook-bench.ts <scratchDir> [runs]
import { copyFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const scratch = process.argv[2];
const runs = Number(process.argv[3] ?? 200);
if (!scratch) throw new Error("usage: hook-bench.ts <scratchDir> [runs]");
const here = join(import.meta.dir, "..");
const out = join(here, "out");

// Realistic-looking hook payload with a large body field that must be dropped.
const SECRET = "BODY-SENTINEL-must-not-reach-spool";
const payload = JSON.stringify({
  session_id: "0199a1b2-0000-7000-8000-000000000000",
  transcript_path: "/Users/someone/.claude/projects/-x/0199.jsonl",
  cwd: "/Users/someone/src/repo",
  hook_event_name: "UserPromptSubmit",
  permission_mode: "default",
  prompt: `${SECRET} ${"lorem ipsum ".repeat(2000)}`,
  tool_input: { command: SECRET },
});
const stdin = new TextEncoder().encode(payload);

type Case = { name: string; cmd: string[] };
const cases: Case[] = [
  { name: "baseline /usr/bin/true", cmd: ["/usr/bin/true"] },
  { name: "hook-min (compile)", cmd: [join(out, "hook-min"), "--tool", "claude"] },
  { name: "hook-min-bc (compile+minify+bytecode)", cmd: [join(out, "hook-min-bc"), "--tool", "claude"] },
  { name: "dl hook (dynamic import)", cmd: [join(out, "dl"), "hook", "--tool", "claude"] },
  { name: "dl-bc hook (dynamic import, bytecode)", cmd: [join(out, "dl-bc"), "hook", "--tool", "claude"] },
  { name: "dl-static hook (static imports)", cmd: [join(out, "dl-static"), "hook", "--tool", "claude"] },
  { name: "dl-static-bc hook (static, bytecode)", cmd: [join(out, "dl-static-bc"), "hook", "--tool", "claude"] },
  { name: "sh -c 'dl-bc hook' (as hooks invoke)", cmd: ["/bin/sh", "-c", `${join(out, "dl-bc")} hook --tool claude`] },
  { name: "bun run src/hook-main.ts (no compile)", cmd: [process.execPath, join(here, "src/hook-main.ts"), "--tool", "claude"] },
];

function pct(xs: number[], p: number) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
}

const results: Record<string, unknown>[] = [];
for (const c of cases) {
  const spoolDir = join(scratch, `spool-${results.length}`);
  rmSync(spoolDir, { recursive: true, force: true });
  const env = { ...process.env, DL_SPOOL_DIR: spoolDir };
  for (let i = 0; i < 10; i++) Bun.spawnSync(c.cmd, { stdin, env }); // warmup
  const ts: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    const r = Bun.spawnSync(c.cmd, { stdin, env, stdout: "ignore", stderr: "ignore" });
    ts.push(performance.now() - t0);
    if (r.exitCode !== 0) throw new Error(`${c.name} exit ${r.exitCode}`);
  }
  let spoolLines: number | null = null;
  let leaked: boolean | null = null;
  if (c.name !== "baseline /usr/bin/true") {
    const txt = readFileSync(join(spoolDir, "hooks.jsonl"), "utf8");
    spoolLines = txt.split("\n").filter(Boolean).length;
    leaked = txt.includes(SECRET);
  }
  const row = {
    case: c.name,
    p50: +pct(ts, 50).toFixed(1),
    p95: +pct(ts, 95).toFixed(1),
    p99: +pct(ts, 99).toFixed(1),
    max: +Math.max(...ts).toFixed(1),
    spoolLines,
    leaked,
  };
  results.push(row);
  console.log(JSON.stringify(row));
}

// Cold first run of a freshly copied binary (simulates first exec after install/update).
const cold: number[] = [];
for (let i = 0; i < 5; i++) {
  const p = join(scratch, `dl-cold-${i}`);
  copyFileSync(join(out, "dl-bc"), p);
  const t0 = performance.now();
  Bun.spawnSync([p, "hook", "--tool", "claude"], {
    stdin,
    env: { ...process.env, DL_SPOOL_DIR: join(scratch, "spool-cold") },
  });
  cold.push(+(performance.now() - t0).toFixed(1));
  rmSync(p);
}
console.log(JSON.stringify({ case: "cold first exec of fresh copy (dl-bc)", runs_ms: cold }));
