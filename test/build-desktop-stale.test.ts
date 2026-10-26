import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { desktopAppStale, desktopAppTimes } from "../scripts/build.ts";

// bun run build は Turnlane.app を作らない。out の .app が apps/desktop の最後のコミットより古ければ警告する
test("out の Turnlane.app が apps/desktop の最後のコミットより古ければ古いとみなす", () => {
  const day = 86_400_000;
  expect(desktopAppStale(10 * day, 11 * day)).toBe(true);
  expect(desktopAppStale(11 * day, 10 * day)).toBe(false);
  expect(desktopAppStale(10 * day, 10 * day)).toBe(false);
  // .app が無い・git が無い: 警告しない
  expect(desktopAppStale(null, 10 * day)).toBe(false);
  expect(desktopAppStale(10 * day, null)).toBe(false);
});

test("out の .app の実行ファイルの時刻と、apps/desktop の最後のコミットの時刻を読む", () => {
  const dir = mkdtempSync(join(tmpdir(), "turnlane-stale-"));
  try {
    expect(desktopAppTimes(dir).app).toBeNull();
    const exe = join(dir, "Turnlane.app", "Contents", "MacOS");
    mkdirSync(exe, { recursive: true });
    writeFileSync(join(exe, "turnlane"), "");
    const at = new Date("2026-10-01T00:00:00Z");
    utimesSync(join(exe, "turnlane"), at, at);
    const t = desktopAppTimes(dir);
    expect(t.app).toBe(at.getTime());
    // このリポジトリの apps/desktop には 10/1 より後のコミットがある
    expect(typeof t.commit).toBe("number");
    expect(desktopAppStale(t.app, t.commit)).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
