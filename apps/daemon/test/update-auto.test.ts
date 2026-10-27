/**
 * 自動更新の流れ（ADR 0008 の追記 4）: 確認の後の取得・検証・ready、Restart to update、アプリが動いていない間の自動の
 * インストール、失敗と回数、SSE update。取得・検証・置き換えは偽の関数（本物は update-download / verify / install の各テスト）
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LogFields, nullLogger } from "@turnlane/collectors";
import {
  FakeClock,
  type LatestRelease,
  putSetting,
  resolvePaths,
  type UpdateDownload,
  type UpdateDownloadError,
} from "@turnlane/core";
import type { UpdateStatus } from "@turnlane/core/api";
import { type RunningDaemon, startDaemon } from "../src/main.ts";
import { AutoUpdater, type AutoUpdaterOptions } from "../src/update/auto.ts";

const LATEST: LatestRelease = {
  version: "0.7.2",
  url: "https://github.com/o/r/releases/download/v0.7.2/Turnlane-0.7.2.zip",
  sha256: "a".repeat(64),
};

function harness(o: Partial<AutoUpdaterOptions> & { verifyError?: UpdateDownloadError } = {}) {
  let state: UpdateDownload | null = null;
  const published: Parameters<AutoUpdaterOptions["publish"]>[0][] = [];
  const calls = {
    download: 0,
    verify: 0,
    install: [] as [string, string][],
    after: [] as string[],
  };
  const logs: { event: string; fields: LogFields | undefined }[] = [];
  const clock = new FakeClock(1_800_000_000_000);
  const log = (event: string, fields?: LogFields) => logs.push({ event, fields });
  const a = new AutoUpdater({
    dataDir: mkdtempSync(join(tmpdir(), "turnlane-auto-")),
    version: "0.7.1",
    clock,
    logger: { debug: log, info: log, warn: log, error: log },
    enabled: () => true,
    appPath: () => "/Applications/Turnlane.app",
    latest: () => LATEST,
    load: () => state,
    save: (d) => {
      state = d;
    },
    publish: (d) => published.push(d),
    download: async () => {
      calls.download++;
      return { ok: true, app: "/data/updates/0.7.2/app/Turnlane.app" };
    },
    verify: async () => {
      calls.verify++;
      return o.verifyError ?? null;
    },
    install: async (src, dst) => {
      calls.install.push([src, dst]);
      return null;
    },
    afterInstall: (r) => calls.after.push(r),
    desktopConnected: () => false,
    appRunning: async () => false,
    idleGraceMs: 5,
    ...o,
  });
  return { a, state: () => state, published, calls, logs, clock };
}

describe("取得と検証", () => {
  test("確認の後に取得 → 検証 → ready。状態の変化ごとに SSE を送る", async () => {
    const h = harness({ desktopConnected: () => true });
    await h.a.maybeStart("check");
    expect(h.calls).toMatchObject({ download: 1, verify: 1 });
    expect(h.state()).toMatchObject({
      state: "ready",
      version: "0.7.2",
      path: "/data/updates/0.7.2/app/Turnlane.app",
      attempts: 0,
    });
    // downloading → verifying → ready
    expect(h.published).toHaveLength(3);
    // 二度目は始めない
    await h.a.maybeStart("check");
    expect(h.calls.download).toBe(1);
    h.a.stop();
  });

  test("検証に落ちたら failed（入れない）。同じ版で 3 回落ちたら次の確認でも始めない", async () => {
    const h = harness({ verifyError: "team_id" });
    for (let i = 0; i < 5; i++) await h.a.maybeStart("check");
    expect(h.calls.download).toBe(3);
    expect(h.calls.install).toHaveLength(0);
    expect(h.state()).toMatchObject({ state: "failed", error: "team_id", attempts: 3 });
    expect(h.logs.filter((l) => l.event === "update.download_failed")).toHaveLength(3);
  });

  test("起動時（start）は失敗をやり直さない", async () => {
    const h = harness({ verifyError: "signature" });
    await h.a.maybeStart("check");
    await h.a.maybeStart("start");
    expect(h.calls.download).toBe(1);
  });

  test("update.download がオフ・配置先が無い（開発時の配置）なら取得しない", async () => {
    const off = harness({ enabled: () => false });
    await off.a.maybeStart("check");
    const dev = harness({ appPath: () => null });
    await dev.a.maybeStart("check");
    expect(off.calls.download + dev.calls.download).toBe(0);
    expect(off.state()).toBeNull();
  });

  test("新しい版でなければ取得しない", async () => {
    const h = harness({ latest: () => ({ ...LATEST, version: "0.7.1" }) });
    await h.a.maybeStart("check");
    expect(h.calls.download).toBe(0);
  });
});

describe("入れる", () => {
  test("ready で install(user) → 置き換え → installed を SSE に流し、後始末を呼ぶ", async () => {
    const h = harness({ desktopConnected: () => true });
    await h.a.maybeStart("check");
    h.published.length = 0;
    const d = await h.a.install("user");
    expect(d.state).toBe("installed");
    expect(h.calls.install).toEqual([
      ["/data/updates/0.7.2/app/Turnlane.app", "/Applications/Turnlane.app"],
    ]);
    expect(h.published).toEqual([
      { download: "installing", version: "0.7.2" },
      { download: "installed", version: "0.7.2", installed: true },
    ]);
    expect(h.calls.after).toEqual(["user"]);
    h.a.stop();
  });

  test("ready でなければ 409", async () => {
    const h = harness();
    expect(() => h.a.install("user")).toThrow("update_not_ready");
  });

  test("書けなければ failed:not_writable（ログ update.install_failed）。後始末は呼ばない", async () => {
    const h = harness({ desktopConnected: () => true, install: async () => "not_writable" });
    await h.a.maybeStart("check");
    const d = await h.a.install("user");
    expect(d).toMatchObject({ state: "failed", error: "not_writable", attempts: 1 });
    expect(h.logs.some((l) => l.event === "update.install_failed")).toBe(true);
    expect(h.calls.after).toEqual([]);
    h.a.stop();
  });
});

describe("アプリが動いていない間の自動のインストール", () => {
  test("アプリが切れて待ちの間つながらず、プロセスも無ければ入れる（app_quit）", async () => {
    let connected = true;
    const h = harness({ desktopConnected: () => connected });
    await h.a.maybeStart("check");
    await Bun.sleep(20);
    // つながっている間は入れない
    expect(h.calls.install).toHaveLength(0);
    connected = false;
    h.a.onDesktopGone();
    for (let i = 0; i < 50 && h.calls.after.length === 0; i++) await Bun.sleep(5);
    expect(h.calls.install).toHaveLength(1);
    expect(h.calls.after).toEqual(["app_quit"]);
  });

  test("待ちの間につなぎ直した・プロセスが動いているなら入れない", async () => {
    let connected = false;
    const h = harness({ desktopConnected: () => connected, idleGraceMs: 30 });
    await h.a.maybeStart("check");
    connected = true;
    await Bun.sleep(60);
    expect(h.calls.install).toHaveLength(0);
    h.a.stop();
    const running = harness({ appRunning: async () => true });
    await running.a.maybeStart("check");
    expect(await running.a.installIfIdle()).toBe(false);
    expect(running.calls.install).toHaveLength(0);
    running.a.stop();
  });

  test("update.download をオフにしたら自動では入れない", async () => {
    let on = true;
    const h = harness({ enabled: () => on, desktopConnected: () => true });
    await h.a.maybeStart("check");
    on = false;
    expect(await h.a.installIfIdle()).toBe(false);
    h.a.stop();
  });
});

describe("デーモンの結線（POST /api/update/install、SSE update、アプリの切断）", () => {
  let daemon: RunningDaemon | null = null;
  let home: string | null = null;
  let feed: ReturnType<typeof Bun.serve> | null = null;
  afterEach(async () => {
    await daemon?.stop();
    daemon = null;
    feed?.stop(true);
    feed = null;
    if (home) rmSync(home, { recursive: true, force: true });
    home = null;
  });

  test("確認 → 取得・検証 → ready が SSE に流れ、アプリが切れたら入れて installed を流す", async () => {
    feed = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => Response.json({ ...LATEST, version: "99.0.0" }),
    });
    home = mkdtempSync(join(tmpdir(), "turnlane-auto-d-"));
    const app = join(home, "Applications", "Turnlane.app");
    mkdirSync(join(app, "Contents"), { recursive: true });
    writeFileSync(join(app, "Contents", "Info.plist"), "<plist/>");
    const installs: [string, string][] = [];
    let exited = 0;
    daemon = await startDaemon({
      paths: resolvePaths({ HOME: home }, home),
      logger: nullLogger,
      port: 0,
      clock: new FakeClock(Date.now()),
      ingest: false,
      calendar: false,
      summary: false,
      onboarding: { assumeDone: true },
      update: {
        feedUrl: `http://127.0.0.1:${feed.port}/latest.json`,
        firstDelayMs: 600_000,
        auto: {
          download: async () => ({ ok: true, app: join(home as string, "new", "Turnlane.app") }),
          verify: async () => null,
          install: async (src, dst) => {
            installs.push([src, dst]);
            return null;
          },
          appRunning: async () => false,
          idleGraceMs: 20,
          afterInstallMs: 10,
        },
      },
      install: {
        mode: "app",
        appPath: app,
        pathVar: "",
        homebrewCandidates: [],
        readBuild: () => (installs.length > 0 ? "new" : "old"),
        exit: () => {
          exited++;
        },
      },
    });
    const d = daemon;
    const auth = { authorization: `Bearer ${d.token}` };
    const call = async (method: string, path: string) => {
      const r = await fetch(`${d.url}${path}`, { method, headers: auth });
      return { status: r.status, data: (await r.json()) as UpdateStatus & { error?: string } };
    };
    expect((await call("POST", "/api/update/install")).status).toBe(409);

    // デスクトップアプリとしてつなぐ（SSE を読む）
    const ac = new AbortController();
    const res = await fetch(`${d.url}/api/events?client=desktop&lang=en`, {
      headers: auth,
      signal: ac.signal,
    });
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    let text = "";
    const dec = new TextDecoder();
    const pump = (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          text += dec.decode(value);
        }
      } catch {}
    })();

    const checked = await call("POST", "/api/update/check");
    expect(checked.status).toBe(200);
    for (
      let i = 0;
      i < 100 && (await call("GET", "/api/update")).data.download?.state !== "ready";
      i++
    )
      await Bun.sleep(10);
    const st = (await call("GET", "/api/update")).data;
    expect(st.download).toMatchObject({ state: "ready", version: "99.0.0" });
    expect(st.downloadEnabled).toBe(true);
    // つながっている間は入れない
    await Bun.sleep(60);
    expect(installs).toHaveLength(0);
    for (let i = 0; i < 50 && !text.includes("event: update"); i++) await Bun.sleep(10);
    expect(text).toContain("event: update");
    expect(text).toContain('"download":"ready"');

    // アプリが切れる → 待ちの後に入れる → バンドルの版の変化で終わる
    ac.abort();
    await pump;
    for (let i = 0; i < 100 && exited === 0; i++) await Bun.sleep(10);
    expect(installs).toEqual([[join(home, "new", "Turnlane.app"), app]]);
    expect((await call("GET", "/api/update")).data.download?.state).toBe("installed");
    expect(exited).toBe(1);
    // アプリが動いていない間に入れたので、起こし直しの印は書かない
    expect(existsSync(join(resolvePaths({ HOME: home }, home).dataDir, "relaunch-desktop"))).toBe(
      false,
    );
  });

  test("update.download=false なら取得しない（確認だけ）", async () => {
    feed = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => Response.json({ ...LATEST, version: "99.0.0" }),
    });
    home = mkdtempSync(join(tmpdir(), "turnlane-auto-d-"));
    let downloads = 0;
    daemon = await startDaemon({
      paths: resolvePaths({ HOME: home }, home),
      logger: nullLogger,
      port: 0,
      clock: new FakeClock(Date.now()),
      ingest: false,
      calendar: false,
      summary: false,
      onboarding: { assumeDone: true },
      update: {
        feedUrl: `http://127.0.0.1:${feed.port}/latest.json`,
        firstDelayMs: 600_000,
        auto: {
          download: async () => {
            downloads++;
            return { ok: false, error: "io" };
          },
        },
      },
      install: {
        mode: "app",
        appPath: join(home, "Turnlane.app"),
        pathVar: "",
        homebrewCandidates: [],
        readBuild: () => null,
      },
    });
    putSetting(daemon.mutateCtx, "update.download", false);
    const r = await fetch(`${daemon.url}/api/update/check`, {
      method: "POST",
      headers: { authorization: `Bearer ${daemon.token}` },
    });
    const st = (await r.json()) as UpdateStatus;
    expect(st.available).toBe(true);
    expect(st.downloadEnabled).toBe(false);
    await Bun.sleep(30);
    expect(downloads).toBe(0);
  });
});
