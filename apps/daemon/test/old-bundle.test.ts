/**
 * The previous bundle (.Turnlane.app.old) left by a replacement: kept while the old version's processes may still be
 * running (automatic update; the CLI when processes from the bundle are running), removed at once when nothing runs
 * from it, and removed by the new daemon after the restart (desktop connected or a timeout, and no old calendar helper)
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LogFields, MetaOnlyLogger } from "@turnlane/collectors";
import {
  defaultReplaceOps,
  processesRunningFrom,
  replaceBundle,
  sideNames,
} from "../src/install/bundle.ts";
import { InstallService } from "../src/install/index.ts";

let root = "";
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = "";
});

function app(dir: string, v: string): string {
  mkdirSync(join(dir, "Contents"), { recursive: true });
  writeFileSync(join(dir, "Contents", "Info.plist"), `<string>${v}</string>\n`);
  return dir;
}

function setup() {
  root = mkdtempSync(join(tmpdir(), "turnlane-old-"));
  const apps = join(root, "Applications");
  const dst = app(join(apps, "Turnlane.app"), "0.7.1");
  const src = app(join(root, "new", "Turnlane.app"), "0.7.2");
  return { apps, dst, src };
}

describe("replaceBundle and the previous bundle", () => {
  test("keepOld: the previous bundle stays next to the new one (never removed in the same run)", async () => {
    const { apps, dst, src } = setup();
    const removed: string[] = [];
    const ops = {
      ...defaultReplaceOps,
      remove: (p: string) => {
        removed.push(p);
        defaultReplaceOps.remove(p);
      },
    };
    expect(await replaceBundle(src, dst, ops, { keepOld: true })).toBeNull();
    expect(readdirSync(apps).sort()).toEqual([".Turnlane.app.old", "Turnlane.app"]);
    // the only removals are the leftovers of a previous run, before the copy
    expect(removed).toEqual([sideNames(dst).next, sideNames(dst).old]);
  });

  test("no processes from the bundle (CLI): the previous bundle is removed at once", async () => {
    const { apps, dst, src } = setup();
    expect(await replaceBundle(src, dst)).toBeNull();
    expect(readdirSync(apps)).toEqual(["Turnlane.app"]);
  });

  test("processesRunningFrom: pgrep on <app>/Contents/; 1 = none, anything else = running (keep)", () => {
    const calls: (readonly string[])[] = [];
    const run = (code: number) => (cmd: readonly string[]) => {
      calls.push(cmd);
      return { code, out: "" };
    };
    expect(processesRunningFrom("/A/Turnlane.app", run(1))).toBe(false);
    expect(processesRunningFrom("/A/Turnlane.app", run(0))).toBe(true);
    expect(processesRunningFrom("/A/Turnlane.app", run(2))).toBe(true);
    expect(calls[0]).toEqual(["/usr/bin/pgrep", "-f", "/A/Turnlane.app/Contents/"]);
  });
});

function logger() {
  const lines: [string, LogFields | undefined][] = [];
  const push = (e: string, f?: LogFields) => void lines.push([e, f]);
  const l: MetaOnlyLogger = { debug: push, info: push, warn: push, error: push };
  return { l, lines };
}

/** A controllable scheduler: callbacks run only when the fake time is advanced (no real waits) */
function fakeTimers() {
  let now = 0;
  let seq = 0;
  const due: { at: number; seq: number; fn: () => void; live: boolean }[] = [];
  const schedule = (fn: () => void, ms: number) => {
    const t = { at: now + ms, seq: seq++, fn, live: true };
    due.push(t);
    return () => {
      t.live = false;
    };
  };
  /** run everything due up to now + ms, in time order (callbacks may schedule more) */
  const advance = (ms: number) => {
    const until = now + ms;
    for (;;) {
      const next = due
        .filter((t) => t.live && t.at <= until)
        .sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
      if (!next) break;
      next.live = false;
      now = next.at;
      next.fn();
    }
    now = until;
  };
  const pending = () => due.filter((t) => t.live).length;
  return { schedule, advance, pending };
}

/** An InstallService with synthetic fs ops for the previous bundle and fake timers */
function service(o: {
  exists?: boolean;
  desktop?: () => boolean;
  helper?: () => string | null;
  bundledHelper?: string | null;
}) {
  const removed: string[] = [];
  const log = logger();
  const timers = fakeTimers();
  const s = new InstallService({
    mode: "app",
    appPath: "/Users/x/Applications/Turnlane.app",
    dataDir: "/nonexistent",
    home: "/Users/x",
    version: "0.7.2",
    logger: log.l,
    now: () => 0,
    pathVar: undefined,
    ...(o.desktop ? { desktopConnected: o.desktop } : {}),
    ...(o.helper ? { helperVersion: o.helper } : {}),
    readHelperVersion: () => o.bundledHelper ?? null,
    oldBundle: { exists: () => o.exists ?? true, remove: (p) => void removed.push(p) },
    oldBundleWaitMs: 60_000,
    oldBundlePollMs: 2_000,
    oldBundleMaxMs: 600_000,
    schedule: timers.schedule,
  });
  return { s, removed, lines: log.lines, timers };
}
const OLD = "/Users/x/Applications/.Turnlane.app.old";

describe("the new daemon removes the previous bundle after the restart", () => {
  test("as soon as the new desktop app is connected", () => {
    const { s, removed, lines, timers } = service({ desktop: () => true });
    s.cleanupOldBundle();
    expect(removed).toEqual([]);
    timers.advance(2_000);
    expect(removed).toEqual([OLD]);
    expect(lines as unknown[]).toContainEqual([
      "install.old_bundle_removed",
      { after: "desktop_connected" },
    ]);
    expect(timers.pending()).toBe(0);
  });

  test("after the timeout when the desktop app does not connect", () => {
    const { s, removed, lines, timers } = service({ desktop: () => false });
    s.cleanupOldBundle();
    timers.advance(59_000);
    expect(removed).toEqual([]);
    timers.advance(5_000);
    expect(removed).toEqual([OLD]);
    expect(lines as unknown[]).toContainEqual(["install.old_bundle_removed", { after: "timeout" }]);
  });

  test("not while the old calendar helper still runs; deferred after the maximum wait", () => {
    const { s, removed, lines, timers } = service({
      desktop: () => true,
      helper: () => "0.7.1+aaaaaaa",
      bundledHelper: "0.7.2+bbbbbbb",
    });
    s.cleanupOldBundle();
    timers.advance(599_000);
    expect(removed).toEqual([]);
    expect(lines).toEqual([]);
    timers.advance(10_000);
    expect(removed).toEqual([]);
    expect(lines as unknown[]).toContainEqual([
      "install.old_bundle_deferred",
      { reason: "old_helper_running" },
    ]);
    expect(timers.pending()).toBe(0);
  });

  test("once the helper is the bundled version it is removed", () => {
    let helper = "0.7.1+aaaaaaa";
    const { s, removed, timers } = service({
      desktop: () => true,
      helper: () => helper,
      bundledHelper: "0.7.2+bbbbbbb",
    });
    s.cleanupOldBundle();
    timers.advance(10_000);
    expect(removed).toEqual([]);
    helper = "0.7.2+bbbbbbb";
    timers.advance(2_000);
    expect(removed).toEqual([OLD]);
  });

  test("nothing to do without a previous bundle; stop() cancels the wait", () => {
    const a = service({ exists: false, desktop: () => true });
    a.s.cleanupOldBundle();
    a.timers.advance(10_000);
    expect(a.removed).toEqual([]);
    expect(a.timers.pending()).toBe(0);
    const b = service({ desktop: () => false });
    b.s.cleanupOldBundle();
    b.s.stop();
    b.timers.advance(700_000);
    expect(b.removed).toEqual([]);
  });
});
