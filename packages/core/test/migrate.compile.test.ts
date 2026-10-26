import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// S4 の C5: compile したバイナリで、埋め込んだマイグレーションが適用され、2回目は再適用されない。
// バイナリはソースの SQL が無い別の cwd から起動する。

let dir: string;
let bin: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "turnlane-migrate-bin-"));
  bin = join(dir, "migrate-bin");
  const build = Bun.spawnSync(
    [
      process.execPath,
      "build",
      "--compile",
      "--minify",
      "--bytecode",
      "--format=esm",
      join(import.meta.dir, "fixtures/migrate-bin/main.ts"),
      "--outfile",
      bin,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (build.exitCode !== 0) throw new Error(build.stderr.toString());
}, 60_000);

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function run(): { applied: string[]; userVersion: number; backupPath: string | null } {
  const p = Bun.spawnSync([bin, join(dir, "data", "d.db"), join(dir, "data", "backups")], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (p.exitCode !== 0) throw new Error(p.stderr.toString());
  return JSON.parse(p.stdout.toString());
}

test("compile 後のバイナリで2回起動しても再適用されない", () => {
  expect(run()).toEqual({ applied: ["0000_test"], userVersion: 1, backupPath: null });
  expect(run()).toEqual({ applied: [], userVersion: 1, backupPath: null });
}, 30_000);
