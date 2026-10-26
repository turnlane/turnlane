/**
 * turnlane hook の起動〜終了時間のベンチ（M0-10、S4 の C1）。p95 が 50ms を超えたら失敗する。
 *
 *   bun scripts/bench-hook.ts [--bin out/turnlane] [--runs 300] [--limit-ms 50] [--json]
 *
 * spool は一時ディレクトリに書く（TURNLANE_DATA_DIR）。実データの場所には書かない。
 * 入力には本文に相当する大きなフィールドと番兵を入れ、spool に漏れないことも確認する。
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");

function arg(name: string, dflt: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? (process.argv[i + 1] as string) : dflt;
}

const bin = resolve(arg("--bin", join(ROOT, "out/turnlane")));
const runs = Number(arg("--runs", "300"));
const limitMs = Number(arg("--limit-ms", "50"));
const SENTINEL = `SENTINEL_BODY_${crypto.randomUUID()}`;

const payload = new TextEncoder().encode(
  JSON.stringify({
    session_id: "11111111-2222-4333-8444-555555555555",
    transcript_path: "/fixture/home/.claude/projects/-fixture-repo-a/s.jsonl",
    cwd: "/fixture/repo-a",
    hook_event_name: "UserPromptSubmit",
    permission_mode: "default",
    prompt: `${SENTINEL} ${"x".repeat(24 * 1024)}`,
    tool_input: { command: SENTINEL, content: "y".repeat(8 * 1024) },
    last_assistant_message: SENTINEL,
  }),
);

function percentile(sorted: number[], p: number): number {
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, i)] as number;
}

function measure(cmd: string[], env: Record<string, string>, n: number): number[] {
  const times: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = Bun.nanoseconds();
    const p = Bun.spawnSync(cmd, { env, stdin: payload, stdout: "ignore", stderr: "ignore" });
    const t1 = Bun.nanoseconds();
    if (p.exitCode !== 0) throw new Error(`exit ${p.exitCode}`);
    times.push((t1 - t0) / 1e6);
  }
  return times.sort((a, b) => a - b);
}

const dataDir = mkdtempSync(join(tmpdir(), "turnlane-bench-"));
try {
  const env = { HOME: dataDir, TURNLANE_DATA_DIR: dataDir, PATH: process.env.PATH ?? "" };
  const cmd = [bin, "hook", "--tool", "claude_code", "--managed-by", "turnlane"];
  measure(cmd, env, 10); // ウォームアップ（新しいバイナリの初回のコード検査を済ませる）
  const t = measure(cmd, env, runs);
  const viaSh = measure(
    ["/bin/sh", "-c", `'${bin}' hook --tool claude_code --managed-by turnlane`],
    env,
    Math.min(runs, 100),
  );

  const spoolDir = join(dataDir, "spool");
  const files = readdirSync(spoolDir);
  const text = files.map((f) => readFileSync(join(spoolDir, f), "utf8")).join("");
  const lines = text.trim().split("\n");
  const expectedLines = 10 + runs + Math.min(runs, 100);
  const leaked = text.includes(SENTINEL);
  const parsedOk = lines.every((l) => {
    try {
      const o = JSON.parse(l) as Record<string, unknown>;
      return o.hook_event_name === "UserPromptSubmit" && !("prompt" in o);
    } catch {
      return false;
    }
  });

  const result = {
    bin,
    runs,
    p50: percentile(t, 50),
    p95: percentile(t, 95),
    p99: percentile(t, 99),
    max: t[t.length - 1],
    sh_p50: percentile(viaSh, 50),
    sh_p95: percentile(viaSh, 95),
    spoolLines: lines.length,
    expectedLines,
    leaked,
    parsedOk,
    limitMs,
  };
  if (process.argv.includes("--json")) console.log(JSON.stringify(result));
  else {
    const f = (x: number | undefined) => `${(x ?? 0).toFixed(1)}ms`;
    console.log(
      `turnlane hook: p50 ${f(result.p50)} / p95 ${f(result.p95)} / p99 ${f(result.p99)} / max ${f(result.max)} (n=${runs})`,
    );
    console.log(`sh -c 'turnlane hook': p50 ${f(result.sh_p50)} / p95 ${f(result.sh_p95)}`);
    console.log(
      `spool: ${lines.length}/${expectedLines} lines, parsed=${parsedOk}, leaked=${leaked}`,
    );
  }
  const failures: string[] = [];
  if (result.p95 > limitMs) failures.push(`p95 ${result.p95.toFixed(1)}ms > ${limitMs}ms`);
  if (lines.length !== expectedLines) failures.push("spool line count mismatch");
  if (leaked) failures.push("sentinel leaked into spool");
  if (!parsedOk) failures.push("spool contains invalid lines");
  if (failures.length > 0) {
    console.error(`FAIL: ${failures.join(", ")}`);
    process.exitCode = 1;
  }
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
