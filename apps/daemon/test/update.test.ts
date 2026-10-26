import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nullLogger } from "@turnlane/collectors";
import { FakeClock, putSetting, resolvePaths, VERSION } from "@turnlane/core";
import type { UpdateStatus } from "@turnlane/core/api";
import { type RunningDaemon, startDaemon } from "../src/main.ts";
import { UpdateChecker, type UpdateState } from "../src/update/checker.ts";
import fixture from "./ext-fixture/daemon.ts";

/** 偽の確認先（GitHub Releases の latest.json の代わり）。受けたリクエストを記録する */
function fakeFeed(body: () => { status: number; json: unknown }) {
  const seen: { path: string; headers: Record<string, string> }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      seen.push({
        path: new URL(req.url).pathname + new URL(req.url).search,
        headers: Object.fromEntries(req.headers),
      });
      const b = body();
      return Response.json(b.json, { status: b.status });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/releases/latest/download/latest.json`,
    seen,
    stop: () => server.stop(true),
  };
}

function checker(feedUrl: string | null, o: { enabled?: () => boolean; clock?: FakeClock } = {}) {
  let state: UpdateState | null = null;
  let published = 0;
  const clock = o.clock ?? new FakeClock(1_000_000);
  const c = new UpdateChecker({
    feedUrl,
    version: "0.6.0",
    clock,
    logger: nullLogger,
    enabled: o.enabled ?? (() => true),
    load: () => state,
    save: (s) => {
      state = s;
    },
    publish: () => {
      published++;
    },
  });
  return { c, clock, state: () => state, published: () => published };
}

let feed: ReturnType<typeof fakeFeed> | null = null;
afterEach(() => {
  feed?.stop();
  feed = null;
});

describe("更新確認（M6-12、ADR 0008 の追記 2）", () => {
  test("GET だけを送り、User-Agent は turnlane/<version>。Cookie・識別子・クエリを付けない。新しい版を知らせる", async () => {
    feed = fakeFeed(() => ({
      status: 200,
      json: {
        version: "0.7.0",
        url: "https://github.com/o/r/releases/tag/v0.7.0",
        sha256: "a".repeat(64),
      },
    }));
    const e = checker(feed.url);
    const st = await e.c.checkNow();
    expect(feed.seen).toHaveLength(1);
    const req = feed.seen[0] as (typeof feed.seen)[number];
    expect(req.path).toBe("/releases/latest/download/latest.json");
    expect(req.headers["user-agent"]).toBe("turnlane/0.6.0");
    expect(req.headers.cookie).toBeUndefined();
    expect(req.headers.authorization).toBeUndefined();
    expect(st).toMatchObject({
      available: true,
      current: "0.6.0",
      error: null,
      enabled: true,
      configured: true,
    });
    expect(st.latest?.version).toBe("0.7.0");
    expect(e.published()).toBe(1);
    // 同じ結果なら知らせない
    await e.c.checkNow();
    expect(e.published()).toBe(1);
  });

  test("1日1回: 間隔が過ぎるまで tick は接続しない", async () => {
    feed = fakeFeed(() => ({
      status: 200,
      json: { version: "0.6.0", url: "https://github.com/o/r" },
    }));
    const e = checker(feed.url);
    await e.c.tick();
    expect(feed.seen).toHaveLength(1);
    expect(e.c.status().available).toBe(false);
    e.clock.advance(23 * 3_600_000);
    await e.c.tick();
    expect(feed.seen).toHaveLength(1);
    e.clock.advance(3_600_000);
    await e.c.tick();
    expect(feed.seen).toHaveLength(2);
  });

  test("update.check がオフなら接続が0回（tick・check・checkNow）", async () => {
    feed = fakeFeed(() => ({
      status: 200,
      json: { version: "9.0.0", url: "https://github.com/o/r" },
    }));
    const e = checker(feed.url, { enabled: () => false });
    await e.c.tick();
    await e.c.check();
    await expect(e.c.checkNow()).rejects.toThrow("update_check_off");
    expect(feed.seen).toHaveLength(0);
    expect(e.state()).toBeNull();
    expect(e.c.status()).toMatchObject({ enabled: false, available: false, checkedAt: null });
  });

  test("確認先の無いビルドは何もしない", async () => {
    const e = checker(null);
    e.c.start();
    await e.c.tick();
    e.c.stop();
    await expect(e.c.checkNow()).rejects.toThrow("update_not_configured");
    expect(e.c.status().configured).toBe(false);
  });

  test("失敗（HTTP エラー・壊れた JSON・確認先の外を指す URL）は前回の結果を保ち、理由を残す", async () => {
    let n = 0;
    feed = fakeFeed(() => {
      n++;
      if (n === 1)
        return { status: 200, json: { version: "0.7.0", url: "https://github.com/o/r" } };
      if (n === 2) return { status: 404, json: {} };
      return { status: 200, json: { version: "0.8.0", url: "https://evil.example/dl" } };
    });
    const e = checker(feed.url);
    await e.c.checkNow();
    expect((await e.c.checkNow()).error).toBe("http_404");
    const st = await e.c.checkNow();
    expect(st.error).toBe("invalid_latest_json");
    expect(st.latest?.version).toBe("0.7.0");
  });
});

describe("デーモンに組み込んだ更新確認（M6-12）", () => {
  let home = "";
  let daemon: RunningDaemon | null = null;
  afterEach(async () => {
    await daemon?.stop();
    daemon = null;
    rmSync(home, { recursive: true, force: true });
  });

  test("起動時の確認は update.check=false なら0回。/api/update と /api/update/check", async () => {
    feed = fakeFeed(() => ({
      status: 200,
      json: { version: "99.0.0", url: "https://github.com/o/r" },
    }));
    home = mkdtempSync(join(tmpdir(), "turnlane-upd-"));
    const paths = resolvePaths({ HOME: home }, home);
    const clock = new FakeClock(Date.now());
    daemon = await startDaemon({
      paths,
      logger: nullLogger,
      port: 0,
      clock,
      ingest: false,
      calendar: false,
      summary: false,
      update: { feedUrl: feed.url, firstDelayMs: 20 },
    });
    putSetting(daemon.mutateCtx, "update.check", false);
    await Bun.sleep(150);
    expect(feed.seen).toHaveLength(0);
    const call = async (method: string, path: string) => {
      const r = await fetch(`${daemon?.url}${path}`, {
        method,
        headers: { authorization: `Bearer ${daemon?.token}` },
      });
      return { status: r.status, data: (await r.json()) as UpdateStatus & { error?: string } };
    };
    expect((await call("GET", "/api/update")).data).toMatchObject({
      enabled: false,
      configured: true,
      current: VERSION,
    });
    expect((await call("POST", "/api/update/check")).status).toBe(409);
    expect(feed.seen).toHaveLength(0);
    putSetting(daemon.mutateCtx, "update.check", true);
    const r = await call("POST", "/api/update/check");
    expect(r.status).toBe(200);
    expect(r.data.available).toBe(true);
    expect(feed.seen).toHaveLength(1);
  });

  test.each([
    {
      name: "拡張を組み込んだビルド",
      ext: true,
      install: null,
      off: "custom_build",
    },
    {
      name: "開発時の配置（mode が dev）",
      ext: false,
      install: { mode: "dev" as const, appPath: null },
      off: "dev_install",
    },
    {
      name: "拡張入りで開発時の配置",
      ext: true,
      install: { mode: "dev" as const, appPath: null },
      off: "custom_build",
    },
  ])("$name なら接続が0回（起動時・tick・/api/update/check）。理由を off に出す", async (c) => {
    feed = fakeFeed(() => ({
      status: 200,
      json: { version: "99.0.0", url: "https://github.com/o/r" },
    }));
    home = mkdtempSync(join(tmpdir(), "turnlane-upd-"));
    const paths = resolvePaths({ HOME: home }, home);
    daemon = await startDaemon({
      paths,
      logger: nullLogger,
      port: 0,
      clock: new FakeClock(Date.now()),
      ingest: false,
      calendar: false,
      summary: false,
      onboarding: { assumeDone: true },
      update: { feedUrl: feed.url, firstDelayMs: 10 },
      ...(c.ext ? { extensions: [fixture] } : {}),
      ...(c.install ? { install: { ...c.install, pathVar: "", homebrewCandidates: [] } } : {}),
    });
    await Bun.sleep(100);
    await daemon.update.tick();
    await daemon.update.check();
    const r = await fetch(`${daemon.url}/api/update/check`, {
      method: "POST",
      headers: { authorization: `Bearer ${daemon.token}` },
    });
    expect(r.status).toBe(409);
    expect(feed.seen).toHaveLength(0);
    // 設定 update.check はオンのまま（理由は設定ではない）
    expect(daemon.update.status()).toMatchObject({
      enabled: true,
      configured: true,
      off: c.off,
      checkedAt: null,
    });
  });

  test("確認先を TURNLANE_UPDATE_FEED_URL に差し替えたとき（スモーク）は開発時の配置でも確かめる", async () => {
    feed = fakeFeed(() => ({
      status: 200,
      json: { version: "99.0.0", url: "https://github.com/o/r" },
    }));
    home = mkdtempSync(join(tmpdir(), "turnlane-upd-"));
    const paths = resolvePaths({ HOME: home }, home);
    daemon = await startDaemon({
      paths,
      logger: nullLogger,
      port: 0,
      ingest: false,
      calendar: false,
      summary: false,
      onboarding: { assumeDone: true },
      update: { feedUrl: feed.url, feedOverridden: true, firstDelayMs: 60_000 },
      install: { mode: "dev", appPath: null, pathVar: "", homebrewCandidates: [] },
    });
    const st = await daemon.update.checkNow();
    expect(st).toMatchObject({ off: null, available: true });
    expect(feed.seen).toHaveLength(1);
  });

  test("確認先を渡さない startDaemon（テスト・公開前のビルド）は接続しない", async () => {
    home = mkdtempSync(join(tmpdir(), "turnlane-upd-"));
    const paths = resolvePaths({ HOME: home }, home);
    daemon = await startDaemon({
      paths,
      logger: nullLogger,
      port: 0,
      ingest: false,
      calendar: false,
    });
    expect(daemon.update.status()).toMatchObject({ configured: false, enabled: true });
  });
});

describe("入れ方ごとの案内（M6-17）", () => {
  test("cask で入れていれば brew upgrade を案内し、それ以外はリリースのページ", async () => {
    const { updateChannel } = await import("@turnlane/core");
    expect(updateChannel("app", (p) => p === "/opt/homebrew/Caskroom/turnlane")).toBe("homebrew");
    expect(updateChannel("app", () => false)).toBe("download");
    expect(updateChannel("dev", () => true)).toBe("dev");
    let state: UpdateState | null = null;
    const mk = (channel: "homebrew" | "download") =>
      new UpdateChecker({
        feedUrl: null,
        version: "0.6.0",
        clock: new FakeClock(0),
        logger: nullLogger,
        enabled: () => true,
        load: () => state,
        save: (s) => {
          state = s;
        },
        publish: () => {},
        channel: () => channel,
      });
    expect(mk("homebrew").status()).toMatchObject({
      channel: "homebrew",
      upgradeCommand: "brew upgrade --cask turnlane",
    });
    expect(mk("download").status()).toMatchObject({ channel: "download", upgradeCommand: null });
  });
});

describe("確認しない理由（updateBuildOff）", () => {
  test.each([
    { extensions: 0, mode: "app" as const, feedOverridden: false, want: null },
    { extensions: 1, mode: "app" as const, feedOverridden: false, want: "custom_build" },
    { extensions: 0, mode: "dev" as const, feedOverridden: false, want: "dev_install" },
    { extensions: 2, mode: "dev" as const, feedOverridden: false, want: "custom_build" },
    { extensions: 0, mode: null, feedOverridden: false, want: null },
    { extensions: 1, mode: "dev" as const, feedOverridden: true, want: null },
  ])("拡張 $extensions・配置 $mode・差し替え $feedOverridden → $want", async (c) => {
    const { updateBuildOff } = await import("@turnlane/core");
    expect(updateBuildOff(c)).toBe(c.want);
  });

  test("確認先は公開リポジトリの最新リリースの latest.json", async () => {
    const { UPDATE_FEED_URL, releaseZipUrl, parseLatest } = await import("@turnlane/core");
    expect(UPDATE_FEED_URL).toBe(
      "https://github.com/turnlane/turnlane/releases/latest/download/latest.json",
    );
    expect(releaseZipUrl("0.7.0")).toBe(
      "https://github.com/turnlane/turnlane/releases/download/v0.7.0/Turnlane-0.7.0.zip",
    );
    // 添付の latest.json の url（Releases の zip）は確認先から読める
    expect(
      parseLatest(
        { version: "0.7.0", url: releaseZipUrl("0.7.0"), sha256: "b".repeat(64) },
        UPDATE_FEED_URL as string,
      ),
    ).toMatchObject({ version: "0.7.0", sha256: "b".repeat(64) });
  });
});
