/**
 * 更新の後のアプリの起こし直し（onboarding.md 2.5 の 1 行目、M6-17）: 印の書き込み・読み取り・期限、終わるときの印、
 * 起動時の分岐（open は偽の関数）、デスクトップアプリが直前までつながっていたかの判定
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nullLogger } from "@turnlane/collectors";
import { createApp } from "../src/http/app.ts";
import { SseHub } from "../src/http/sse.ts";
import { InstallService } from "../src/install/index.ts";
import {
  DESKTOP_RECENT_MS,
  RELAUNCH_MARK_MAX_AGE_MS,
  relaunchMarkPath,
  takeRelaunchMark,
  writeRelaunchMark,
} from "../src/install/relaunch.ts";

let home: string;
let dataDir: string;
let app: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "turnlane-relaunch-"));
  dataDir = join(home, "data");
  app = join(home, "Applications", "Turnlane.app");
  mkdirSync(dataDir, { recursive: true });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const T0 = 1_800_000_000_000;

describe("印（<データ>/relaunch-desktop）", () => {
  test("書いて読むと消える。10 分以内は fresh、それより古いと stale", () => {
    expect(takeRelaunchMark(dataDir, T0)).toBe("none");
    writeRelaunchMark(dataDir, T0);
    expect(existsSync(relaunchMarkPath(dataDir))).toBe(true);
    expect(takeRelaunchMark(dataDir, T0 + RELAUNCH_MARK_MAX_AGE_MS)).toBe("fresh");
    expect(existsSync(relaunchMarkPath(dataDir))).toBe(false);
    expect(takeRelaunchMark(dataDir, T0)).toBe("none");
    writeRelaunchMark(dataDir, T0);
    expect(takeRelaunchMark(dataDir, T0 + RELAUNCH_MARK_MAX_AGE_MS + 1)).toBe("stale");
    expect(existsSync(relaunchMarkPath(dataDir))).toBe(false);
  });

  test("壊れた印・未来の時刻の印は stale（起こさない）で、消す", () => {
    writeFileSync(relaunchMarkPath(dataDir), "not json");
    expect(takeRelaunchMark(dataDir, T0)).toBe("stale");
    writeFileSync(relaunchMarkPath(dataDir), JSON.stringify({ at: "x" }));
    expect(takeRelaunchMark(dataDir, T0)).toBe("stale");
    writeRelaunchMark(dataDir, T0 + 3_600_000);
    expect(takeRelaunchMark(dataDir, T0)).toBe("stale");
    expect(existsSync(relaunchMarkPath(dataDir))).toBe(false);
  });
});

function svc(o: Partial<ConstructorParameters<typeof InstallService>[0]> = {}) {
  return new InstallService({
    mode: "app",
    appPath: app,
    dataDir,
    home,
    version: "0.7.0",
    logger: nullLogger,
    now: () => T0,
    pathVar: "/usr/bin",
    homebrewCandidates: [],
    ...o,
  });
}

describe("終わるとき（バンドルの版が変わった）", () => {
  test("アプリがつながっていた（直前まで）なら印を残してから終わる", () => {
    let exited = 0;
    const asked: number[] = [];
    const s = svc({
      readBuild: () => "0.7.1+new",
      exit: () => exited++,
      desktopSeenWithin: (ms) => {
        asked.push(ms);
        return true;
      },
    });
    expect(s.checkBundle("0.7.0+old")).toBe(true);
    expect(exited).toBe(1);
    expect(asked).toEqual([DESKTOP_RECENT_MS]);
    expect(takeRelaunchMark(dataDir, T0)).toBe("fresh");
  });

  test("アプリがつながっていなければ印を残さない。版が同じなら何もしない", () => {
    let exited = 0;
    const s = svc({
      readBuild: () => "0.7.1+new",
      exit: () => exited++,
      desktopSeenWithin: () => false,
    });
    expect(s.checkBundle("0.7.0+old")).toBe(true);
    expect(exited).toBe(1);
    expect(existsSync(relaunchMarkPath(dataDir))).toBe(false);
    const same = svc({
      readBuild: () => "0.7.0+old",
      exit: () => exited++,
      desktopSeenWithin: () => true,
    });
    expect(same.checkBundle("0.7.0+old")).toBe(false);
    expect(existsSync(relaunchMarkPath(dataDir))).toBe(false);
  });
});

describe("自動更新で入れ替えた直後（bundleReplaced）", () => {
  async function replaced(relaunchDesktop: boolean) {
    let build = "0.7.1+old";
    let exited = 0;
    const s = svc({
      readBuild: () => build,
      exit: () => exited++,
      desktopSeenWithin: () => true,
      watchMs: 600_000,
      reregisterHelper: async () => false,
    });
    s.start();
    // 起動時の起こし直しの確かめ（印なし）を済ませる
    await Bun.sleep(5);
    build = "0.7.2+new";
    s.bundleReplaced({ relaunchDesktop, afterMs: 5 });
    for (let i = 0; i < 50 && exited === 0; i++) await Bun.sleep(5);
    s.stop();
    return exited;
  }

  test("Restart to update（user）: 印を書いてから、待ちの後にバンドルの変化で終わる", async () => {
    expect(await replaced(true)).toBe(1);
    expect(takeRelaunchMark(dataDir, T0)).toBe("fresh");
  });

  test("アプリが動いていない間に入れた: アプリがさっきまでつながっていても印を書かない", async () => {
    expect(await replaced(false)).toBe(1);
    expect(existsSync(relaunchMarkPath(dataDir))).toBe(false);
  });
});

describe("起動時の起こし直し（open は偽の関数）", () => {
  const opener = (ok: boolean | "throw" = true) => {
    const calls = { n: 0 };
    const fn = async () => {
      calls.n++;
      if (ok === "throw") throw new Error("spawn failed");
      return ok;
    };
    return { calls, fn };
  };

  test("10 分以内の印があれば 1 回起こし、印を消す", async () => {
    writeRelaunchMark(dataDir, T0 - 60_000);
    const o = opener();
    expect(await svc({ openDesktop: o.fn }).relaunchDesktop()).toBe(true);
    expect(o.calls.n).toBe(1);
    expect(existsSync(relaunchMarkPath(dataDir))).toBe(false);
    // もう一度起動しても起こさない
    expect(await svc({ openDesktop: o.fn }).relaunchDesktop()).toBe(false);
    expect(o.calls.n).toBe(1);
  });

  test("印が無い・古い印なら起こさない（古い印は消す）", async () => {
    const o = opener();
    expect(await svc({ openDesktop: o.fn }).relaunchDesktop()).toBe(false);
    writeRelaunchMark(dataDir, T0 - RELAUNCH_MARK_MAX_AGE_MS - 1);
    expect(await svc({ openDesktop: o.fn }).relaunchDesktop()).toBe(false);
    expect(o.calls.n).toBe(0);
    expect(existsSync(relaunchMarkPath(dataDir))).toBe(false);
  });

  test("開発時の配置（mode が dev）では何もしない（印にも触らない）", async () => {
    writeRelaunchMark(dataDir, T0);
    const o = opener();
    expect(await svc({ mode: "dev", appPath: null, openDesktop: o.fn }).relaunchDesktop()).toBe(
      false,
    );
    expect(o.calls.n).toBe(0);
    expect(existsSync(relaunchMarkPath(dataDir))).toBe(true);
  });

  test("open の失敗は false を返して続ける（投げない）。印は消える", async () => {
    for (const r of [false, "throw"] as const) {
      writeRelaunchMark(dataDir, T0);
      const o = opener(r);
      expect(await svc({ openDesktop: o.fn }).relaunchDesktop()).toBe(false);
      expect(o.calls.n).toBe(1);
      expect(existsSync(relaunchMarkPath(dataDir))).toBe(false);
    }
  });

  test("起こす口を渡さない起動（テスト・開発）は起こさないが、印は消す", async () => {
    writeRelaunchMark(dataDir, T0);
    expect(await svc().relaunchDesktop()).toBe(false);
    expect(existsSync(relaunchMarkPath(dataDir))).toBe(false);
  });

  test("start() で起動時に確かめる", async () => {
    writeRelaunchMark(dataDir, T0);
    const o = opener();
    const s = svc({ openDesktop: o.fn, readBuild: () => null });
    s.start();
    for (let i = 0; i < 50 && o.calls.n === 0; i++) await Bun.sleep(5);
    s.stop();
    expect(o.calls.n).toBe(1);
  });
});

describe("デスクトップアプリが直前までつながっていたか（SseHub）", () => {
  test("つながっている間は true、切れてから ms 以内は true、過ぎたら false。一度もつながっていなければ false", async () => {
    let now = T0;
    const hub = new SseHub({ bundleMs: 0, now: () => now });
    expect(hub.desktopSeenWithin(DESKTOP_RECENT_MS)).toBe(false);
    const TOKEN = "d".repeat(64);
    const HOST = "127.0.0.1:7317";
    const a = createApp({
      token: TOKEN,
      port: 7317,
      hub,
      health: () => ({}) as never,
      admin: { backup: () => ({ date: "x", path: "y" }) },
    });
    const ac = new AbortController();
    const r = await a.request(`http://${HOST}/api/events?client=desktop`, {
      headers: { host: HOST, authorization: `Bearer ${TOKEN}` },
      signal: ac.signal,
    });
    const reader = (r.body as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    now += 3_600_000;
    expect(hub.desktopSeenWithin(DESKTOP_RECENT_MS)).toBe(true);
    ac.abort();
    await reader.cancel();
    await Bun.sleep(10);
    expect(hub.desktopClients).toBe(0);
    now += DESKTOP_RECENT_MS;
    expect(hub.desktopSeenWithin(DESKTOP_RECENT_MS)).toBe(true);
    now += 1;
    expect(hub.desktopSeenWithin(DESKTOP_RECENT_MS)).toBe(false);
  });
});
