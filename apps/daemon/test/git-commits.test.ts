/**
 * SystemGit.firstCommitAfter: リポジトリ・ブランチごとに 1 回の git log で、違う since の問いに答える（判定は待ちの
 * セッションごとに違う since で問う）。一時ディレクトリの合成のリポジトリだけを使う。git が無ければ飛ばす
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SystemGit } from "../src/ingest/git.ts";

const hasGit = Bun.spawnSync(["git", "--version"], { stdout: "ignore", stderr: "ignore" }).success;
let dir = "";
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

const T = 1_790_000_000; // 秒

function repo(): string {
  dir = mkdtempSync(join(tmpdir(), "turnlane-git-"));
  const git = (args: string[], at?: number) =>
    Bun.spawnSync(["git", ...args], {
      cwd: dir,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "a",
        GIT_AUTHOR_EMAIL: "a@example.com",
        GIT_COMMITTER_NAME: "a",
        GIT_COMMITTER_EMAIL: "a@example.com",
        ...(at ? { GIT_AUTHOR_DATE: `@${at} +0000`, GIT_COMMITTER_DATE: `@${at} +0000` } : {}),
      },
      stdout: "ignore",
      stderr: "ignore",
    });
  git(["init", "-q", "-b", "main"]);
  for (const [i, at] of [T, T + 100, T + 200].entries()) {
    writeFileSync(join(dir, "f.txt"), String(i));
    git(["add", "."]);
    git(["commit", "-qm", `c${i}`], at);
  }
  return dir;
}

describe("SystemGit.firstCommitAfter", () => {
  test.skipIf(!hasGit)(
    "違う since の問いに 1 回の git log で答え、結果は since ごとに正しい",
    () => {
      const r = repo();
      let spawns = 0;
      const spawn0 = Bun.spawnSync;
      (Bun as unknown as { spawnSync: unknown }).spawnSync = (...a: unknown[]) => {
        spawns++;
        return (spawn0 as (...x: unknown[]) => unknown)(...a);
      };
      try {
        const g = new SystemGit({ now: () => 0 });
        // 古い since から問えば、あとの新しい since は覚えたものから答える
        expect(g.firstCommitAfter(r, "main", (T - 10) * 1000)).toBe(T * 1000);
        expect(g.firstCommitAfter(r, "main", T * 1000)).toBe((T + 100) * 1000);
        expect(g.firstCommitAfter(r, "main", (T + 150) * 1000)).toBe((T + 200) * 1000);
        expect(g.firstCommitAfter(r, "main", (T + 200) * 1000)).toBeNull();
        expect(spawns).toBe(1);
        // より古い since を問われたら、そこから読み直す（1 回だけ）
        expect(g.firstCommitAfter(r, "main", (T - 1000) * 1000)).toBe(T * 1000);
        expect(g.firstCommitAfter(r, "main", (T + 50) * 1000)).toBe((T + 100) * 1000);
        expect(spawns).toBe(2);
      } finally {
        (Bun as unknown as { spawnSync: unknown }).spawnSync = spawn0;
      }
    },
  );
});
