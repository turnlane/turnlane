/**
 * 更新の知らせ（onboarding.md 2.5 の更新確認の行、M6-17）: GET /api/update の releasesUrl・dismissed、
 * POST /api/update/dismiss、メニューバーの 1 項目（/api/queue/summary の update）、SSE update で available が切り替わること
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nullLogger } from "@turnlane/collectors";
import {
  FakeClock,
  RELEASES_LATEST_PAGE_URL,
  resolvePaths,
  type UpdateDownload,
} from "@turnlane/core";
import type { UpdateStatus } from "@turnlane/core/api";
import { updateMenuItem } from "@turnlane/core/web";
import type { AiDeps } from "../src/http/ai-routes.ts";
import { createApp } from "../src/http/app.ts";
import { SseHub } from "../src/http/sse.ts";
import { type RunningDaemon, startDaemon } from "../src/main.ts";
import { UpdateChecker, type UpdateState } from "../src/update/checker.ts";

function checker(channel: "homebrew" | "download" | "dev", latest: string | null) {
  let state: UpdateState | null = latest
    ? {
        checkedAt: 1,
        latest: { version: latest, url: "https://github.com/o/r", sha256: null },
        error: null,
      }
    : null;
  let published = 0;
  const c = new UpdateChecker({
    feedUrl: null,
    version: "0.7.0",
    clock: new FakeClock(0),
    logger: nullLogger,
    enabled: () => true,
    load: () => state,
    save: (s) => {
      state = s;
    },
    publish: () => {
      published++;
    },
    channel: () => channel,
  });
  return { c, published: () => published };
}

describe("GET /api/update の案内の形", () => {
  test("download は最新リリースのページ、homebrew はコマンド、dev はどちらも無い", () => {
    expect(checker("download", "0.7.1").c.status()).toMatchObject({
      available: true,
      channel: "download",
      upgradeCommand: null,
      releasesUrl: RELEASES_LATEST_PAGE_URL,
      dismissed: null,
    });
    expect(RELEASES_LATEST_PAGE_URL).toBe("https://github.com/turnlane/turnlane/releases/latest");
    expect(checker("homebrew", "0.7.1").c.status()).toMatchObject({
      upgradeCommand: "brew upgrade --cask turnlane",
      releasesUrl: null,
    });
    expect(checker("dev", "0.7.1").c.status()).toMatchObject({
      upgradeCommand: null,
      releasesUrl: null,
    });
  });

  test("閉じた版はプロセスの中だけ覚え、変わったときだけ SSE update を送る", () => {
    const e = checker("homebrew", "0.7.1");
    expect(e.c.dismiss("0.7.1").dismissed).toBe("0.7.1");
    expect(e.published()).toBe(1);
    e.c.dismiss("0.7.1");
    expect(e.published()).toBe(1);
    // 同じ設定（load）を読む次の起動（新しい UpdateChecker）は覚えていない
    expect(checker("homebrew", "0.7.1").c.status().dismissed).toBeNull();
  });
});

describe("メニューバーの 1 項目（updateMenuItem）", () => {
  const st = (o: Partial<UpdateStatus>) => ({
    available: true,
    latest: { version: "0.7.1" },
    channel: "homebrew" as const,
    upgradeCommand: "brew upgrade --cask turnlane",
    releasesUrl: null,
    ...o,
  });

  test("homebrew はコマンドを写す、download はリリースのページを開く", () => {
    expect(updateMenuItem(st({}), "en")).toEqual({
      label: "Turnlane 0.7.1 is available · Copy brew upgrade --cask turnlane",
      action: "copy",
      value: "brew upgrade --cask turnlane",
      copied: "Copied",
    });
    expect(updateMenuItem(st({}), "ja")?.label).toBe(
      "Turnlane 0.7.1 に更新できます · brew upgrade --cask turnlane をコピー",
    );
    expect(
      updateMenuItem(
        st({ channel: "download", upgradeCommand: null, releasesUrl: RELEASES_LATEST_PAGE_URL }),
        "en",
      ),
    ).toMatchObject({
      label: "Turnlane 0.7.1 is available · Open Releases",
      action: "open",
      value: RELEASES_LATEST_PAGE_URL,
    });
  });

  test("自動更新の段階: Downloading…（押せない）、ready は Restart to update（install）、入れている間は押せない", () => {
    const dl = (state: UpdateDownload["state"], error: UpdateDownload["error"] = null) => ({
      download: { state, version: "0.7.1", path: null, error, attempts: 1, at: 1 },
    });
    expect(updateMenuItem(st(dl("downloading")), "en")).toEqual({
      label: "Turnlane 0.7.1 is available · Downloading…",
      action: "none",
      value: "",
      copied: "Copied",
    });
    expect(updateMenuItem(st(dl("verifying")), "en")?.action).toBe("none");
    expect(updateMenuItem(st(dl("ready")), "en")).toMatchObject({
      label: "Turnlane 0.7.1 is ready · Restart to update",
      action: "install",
      value: "",
    });
    expect(updateMenuItem(st(dl("ready")), "ja")?.label).toBe(
      "Turnlane 0.7.1 の準備ができました · 再起動して更新",
    );
    expect(updateMenuItem(st(dl("installing")), "en")).toMatchObject({
      label: "Turnlane 0.7.1 is ready · Restarting…",
      action: "none",
    });
    // 失敗・download オフは手動の案内
    expect(updateMenuItem(st(dl("failed", "team_id")), "en")?.action).toBe("copy");
    expect(updateMenuItem(st({ ...dl("ready"), downloadEnabled: false }), "en")?.action).toBe(
      "copy",
    );
  });

  test("新しい版が無い・dev なら出さない", () => {
    expect(updateMenuItem(st({ available: false }), "en")).toBeNull();
    expect(updateMenuItem(st({ latest: null }), "en")).toBeNull();
    expect(updateMenuItem(st({ channel: "dev", upgradeCommand: null }), "en")).toBeNull();
  });

  test("/api/queue/summary は項目があるときだけ update を付ける", async () => {
    const TOKEN = "c".repeat(64);
    const HOST = "127.0.0.1:7317";
    const ai = {
      queue: () => [],
      meta: () => ({ rev: 1, today: "2026-10-27", displayToday: "2026-10-27", now: 0, tz: "UTC" }),
      queueExtras: () => ({ notifyPausedUntil: null }),
    } as unknown as AiDeps;
    let item = updateMenuItem(st({}), "en");
    const a = createApp({
      token: TOKEN,
      port: 7317,
      hub: new SseHub(),
      health: () => ({}) as never,
      admin: { backup: () => ({ date: "x", path: "y" }) },
      ai: () => ai,
      updateMenu: () => item,
    });
    const get = async () =>
      (await (
        await a.request(`http://${HOST}/api/queue/summary`, {
          headers: { host: HOST, authorization: `Bearer ${TOKEN}` },
        })
      ).json()) as { update?: unknown };
    expect((await get()).update).toMatchObject({ action: "copy" });
    item = null;
    expect("update" in (await get())).toBe(false);
  });
});

describe("デーモンの SSE update", () => {
  let home = "";
  let daemon: RunningDaemon | null = null;
  let feed: ReturnType<typeof Bun.serve> | null = null;
  afterEach(async () => {
    await daemon?.stop();
    daemon = null;
    feed?.stop(true);
    feed = null;
    rmSync(home, { recursive: true, force: true });
  });

  test("確認で新しい版が見つかると update が届き、GET /api/update の available が true になる。閉じると dismissed", async () => {
    let version = "0.0.0-dev";
    feed = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => Response.json({ version, url: "https://github.com/o/r" }),
    });
    home = mkdtempSync(join(tmpdir(), "turnlane-upd-notice-"));
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
        feedOverridden: true,
        firstDelayMs: 60_000,
      },
    });
    const d = daemon;
    const call = async (method: string, path: string, body?: unknown) =>
      (await (
        await fetch(`${d.url}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${d.token}`,
            ...(body ? { "content-type": "application/json" } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        })
      ).json()) as UpdateStatus;
    const events: string[] = [];
    const res = await fetch(`${d.url}/api/events`, {
      headers: { authorization: `Bearer ${d.token}` },
    });
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    void (async () => {
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
        if (done) return;
        buf += new TextDecoder().decode(value);
        for (const m of buf.matchAll(/^event: (\w+)$/gm)) events.push(m[1] as string);
        buf = buf.slice(buf.lastIndexOf("\n\n") + 2);
      }
    })();
    const waitFor = async (n: number) => {
      for (let i = 0; i < 200 && events.filter((e) => e === "update").length < n; i++)
        await Bun.sleep(10);
    };

    await call("POST", "/api/update/check");
    await waitFor(1);
    expect(events.filter((e) => e === "update")).toHaveLength(1);
    expect((await call("GET", "/api/update")).available).toBe(false);

    version = "99.0.0";
    await call("POST", "/api/update/check");
    await waitFor(2);
    expect(events.filter((e) => e === "update")).toHaveLength(2);
    const st = await call("GET", "/api/update");
    expect(st).toMatchObject({ available: true, latest: { version: "99.0.0" }, dismissed: null });

    expect((await call("POST", "/api/update/dismiss", { version: "99.0.0" })).dismissed).toBe(
      "99.0.0",
    );
    await waitFor(3);
    expect(events.filter((e) => e === "update")).toHaveLength(3);
    await reader.cancel();
  });
});
