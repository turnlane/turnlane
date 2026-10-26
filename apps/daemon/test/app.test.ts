import { describe, expect, test } from "bun:test";
import type { HealthReport } from "../src/health.ts";
import { createApp } from "../src/http/app.ts";
import { cookieValue } from "../src/http/auth.ts";
import type { DesktopStatusStore } from "../src/http/desktop-routes.ts";
import { SseHub } from "../src/http/sse.ts";

const TOKEN = "a".repeat(64);
const PORT = 7317;
const HOST = `127.0.0.1:${PORT}`;
const ORIGIN = `http://${HOST}`;

const health = (): HealthReport => ({
  ok: true,
  version: "test",
  pid: 1,
  startedAt: 0,
  uptimeMs: 0,
  port: PORT,
  db: { userVersion: 2, schemaVersion: 2, journalMode: "wal", sqliteVersion: "3", sizeBytes: 0 },
  backup: { lastDate: null, lastAt: null, count: 0 },
  sources: [],
  calendarHelper: { connected: false },
  sseClients: 0,
  extensions: [],
});

const admin = { backup: () => ({ date: "2026-10-02", path: "/backups/turnlane-20261002.db" }) };

function makeApp(hub = new SseHub()) {
  return createApp({ token: TOKEN, port: PORT, hub, health, admin });
}

const req = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
  makeApp().request(`http://${HOST}${path}`, {
    ...init,
    headers: { host: HOST, ...init.headers },
  });

describe("Host 検証（DNS rebinding 対策）", () => {
  test.each([["evil.example:7317"], ["127.0.0.1:9999"], ["localhost"], [""]])(
    "Host=%p は 421",
    async (host) => {
      const r = await req("/api/health", {
        headers: { host, authorization: `Bearer ${TOKEN}` },
      });
      expect(r.status).toBe(421);
    },
  );
  test("localhost:<port> は許可", async () => {
    const r = await req("/api/health", {
      headers: { host: `localhost:${PORT}`, authorization: `Bearer ${TOKEN}` },
    });
    expect(r.status).toBe(200);
  });
});

describe("/api の認証", () => {
  test("認証なしは 401", async () => {
    expect((await req("/api/health")).status).toBe(401);
    expect((await req("/api/nope")).status).toBe(401);
  });
  test("Bearer トークンで health が返る", async () => {
    const r = await req("/api/health", { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(((await r.json()) as HealthReport).db.journalMode).toBe("wal");
  });
  test("間違ったトークンは 401", async () => {
    const r = await req("/api/health", { headers: { authorization: `Bearer ${"b".repeat(64)}` } });
    expect(r.status).toBe(401);
  });
  test("未定義の /api パスは認証後に JSON の 404（SPA にフォールバックしない）", async () => {
    const r = await req("/api/nope", { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: "not_found" });
  });
});

describe("ブラウザ認証（/auth とクッキー）", () => {
  test("正しいトークンで HttpOnly・SameSite=Strict のクッキーを発行し、next へ 303", async () => {
    const r = await req(`/auth?t=${TOKEN}&next=/board`);
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("/board");
    const cookie = r.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`turnlane_session=${cookieValue(TOKEN)}`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).not.toContain(TOKEN);
  });
  test.each(["//evil.example", "https://evil.example", "\\\\evil", "board"])(
    "next=%p は / にする（オープンリダイレクト対策）",
    async (next) => {
      const r = await req(`/auth?t=${TOKEN}&next=${encodeURIComponent(next)}`);
      expect(r.headers.get("location")).toBe("/");
    },
  );
  test("間違ったトークンは 401 でクッキーを出さない", async () => {
    const r = await req("/auth?t=wrong");
    expect(r.status).toBe(401);
    expect(r.headers.get("set-cookie")).toBeNull();
  });
  test("クッキーで GET できる", async () => {
    const r = await req("/api/health", {
      headers: { cookie: `turnlane_session=${cookieValue(TOKEN)}` },
    });
    expect(r.status).toBe(200);
  });
});

describe("状態を変えるリクエストの Origin 検証", () => {
  const cookie = `turnlane_session=${cookieValue(TOKEN)}`;
  test("クッキー認証で Origin が無ければ 403", async () => {
    const r = await req("/api/health", { method: "POST", headers: { cookie } });
    expect(r.status).toBe(403);
  });
  test("他サイトの Origin は Bearer でも 403", async () => {
    const r = await req("/api/health", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, origin: "https://evil.example" },
    });
    expect(r.status).toBe(403);
  });
  test("自分自身の Origin なら通過する（ルートが無いので 404）", async () => {
    const r = await req("/api/health", { method: "POST", headers: { cookie, origin: ORIGIN } });
    expect(r.status).toBe(404);
  });
  test("Bearer で Origin なし（CLI）は通過する", async () => {
    const r = await req("/api/health", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(r.status).toBe(404);
  });
});

describe("POST /api/admin/backup", () => {
  test("Bearer で即時バックアップを呼べる。GET は 404", async () => {
    const r = await req("/api/admin/backup", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ date: "2026-10-02", path: "/backups/turnlane-20261002.db" });
    const g = await req("/api/admin/backup", { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(g.status).toBe(404);
  });
});

describe("静的配信", () => {
  test("Web UI が無ければ案内の HTML を返し、セキュリティヘッダを付ける", async () => {
    const r = await req("/");
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("turnlane");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("x-frame-options")).toBe("DENY");
  });
});

describe("SSE", () => {
  test("hello の後に publish したイベントが届く", async () => {
    const hub = new SseHub();
    const app = makeApp(hub);
    const ac = new AbortController();
    const r = await app.request(`http://${HOST}/api/events`, {
      headers: { host: HOST, authorization: `Bearer ${TOKEN}` },
      signal: ac.signal,
    });
    expect(r.headers.get("content-type")).toContain("text/event-stream");
    const reader = (r.body as ReadableStream<Uint8Array>).getReader();
    const dec = new TextDecoder();
    let buf = "";
    const readUntil = async (s: string) => {
      while (!buf.includes(s)) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value);
      }
    };
    await readUntil("event: hello");
    expect(hub.size).toBe(1);
    hub.publish("task", { ids: ["t1"], dates: ["2026-10-02"] });
    hub.publish("task", { ids: ["t2"], dates: ["2026-10-02"], inbox: true });
    hub.flush();
    // 同じ種類は束ねて1回（ids・dates は和集合）。rev は送るたびに +1
    await readUntil('"rev":1}');
    expect(buf).toContain("event: task");
    expect(buf).toContain('data: {"ids":["t1","t2"],"dates":["2026-10-02"],"inbox":true,"rev":1}');
    expect(hub.rev).toBe(1);
    ac.abort();
    await reader.cancel();
  });
});

describe("SSE の束ね（D-125）", () => {
  test("calendar の calendars: true は束ねても残る（カレンダーの一覧を取り直させる）", () => {
    const hub = new SseHub({ bundleMs: 1000 });
    const seen: unknown[] = [];
    hub.subscribe((m) => seen.push(m.data));
    hub.publish("calendar", { dates: ["2026-10-02"], calendars: true });
    hub.publish("calendar", { dates: ["2026-10-03"] });
    hub.flush();
    expect(seen).toEqual([{ dates: ["2026-10-02", "2026-10-03"], calendars: true, rev: 1 }]);
  });
});

describe("デスクトップアプリ（desktop-shell.md 3.4・4.3）", () => {
  const bearer = { authorization: `Bearer ${TOKEN}` };
  test("client=desktop の購読を数え、言語を覚える。切れたら 0 に戻る。増減で follow_up を送る", async () => {
    const hub = new SseHub({ bundleMs: 0 });
    const app = makeApp(hub);
    const seen: string[] = [];
    hub.subscribe((m) => seen.push(m.type));
    const ac = new AbortController();
    const r = await app.request(`http://${HOST}/api/events?client=desktop&lang=ja-JP`, {
      headers: { host: HOST, ...bearer },
      signal: ac.signal,
    });
    const reader = (r.body as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    expect(hub.desktopClients).toBe(1);
    expect(hub.desktopLang()).toBe("ja-JP");
    // つながっていれば turnlane open の指示を SSE で渡す
    const o = await app.request(`http://${HOST}/api/desktop/open`, {
      method: "POST",
      headers: { host: HOST, ...bearer, "content-type": "application/json" },
      body: JSON.stringify({ path: "/queue" }),
    });
    expect(await o.json()).toEqual({ delivered: true });
    expect(seen).toContain("desktop_open");
    ac.abort();
    await reader.cancel();
    await Bun.sleep(10);
    expect(hub.desktopClients).toBe(0);
    expect(seen.filter((t) => t === "follow_up")).toHaveLength(2);
  });
  test("つながっていなければ delivered: false。外へのパスは / に直す", async () => {
    const hub = new SseHub({ bundleMs: 0 });
    const seen: unknown[] = [];
    hub.subscribe((m) => seen.push(m.data));
    const post = (path: string) =>
      makeApp(hub).request(`http://${HOST}/api/desktop/open`, {
        method: "POST",
        headers: { host: HOST, ...bearer, "content-type": "application/json" },
        body: JSON.stringify({ path }),
      });
    expect(await (await post("/board")).json()).toEqual({ delivered: false });
    expect(seen).toEqual([]);
  });
  test("アプリの状態を受け取り、つながっている間だけ返す", async () => {
    const hub = new SseHub();
    const store: DesktopStatusStore = { status: null };
    const app = createApp({ token: TOKEN, port: PORT, hub, health, admin, desktop: store });
    const report = {
      version: "0.1.0",
      notifications: "granted" as const,
      shortcut: { accelerator: "Alt+Shift+Space", registered: true },
    };
    const p = await app.request(`http://${HOST}/api/desktop/status`, {
      method: "POST",
      headers: { host: HOST, ...bearer, "content-type": "application/json" },
      body: JSON.stringify(report),
    });
    expect(p.status).toBe(200);
    const g = await app.request(`http://${HOST}/api/desktop/status`, {
      headers: { host: HOST, ...bearer },
    });
    expect(await g.json()).toEqual({ connected: false, app: null });
    expect(store.status).toEqual(report);
  });
  test("D-080: 通知の許可の操作をアプリへ渡す（つながっていなければ delivered: false）。状態の変化で desktop_status", async () => {
    const hub = new SseHub({ bundleMs: 0 });
    const store: DesktopStatusStore = { status: null };
    const app = createApp({ token: TOKEN, port: PORT, hub, health, admin, desktop: store });
    const seen: { type: string; data: unknown }[] = [];
    hub.subscribe((m) => seen.push(m));
    const post = (path: string, body: unknown) =>
      app.request(`http://${HOST}${path}`, {
        method: "POST",
        headers: { host: HOST, ...bearer, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    expect(await (await post("/api/desktop/notifications", { action: "request" })).json()).toEqual({
      delivered: false,
    });
    expect((await post("/api/desktop/notifications", { action: "open_url" })).status).toBe(400);
    const ac = new AbortController();
    const r = await app.request(`http://${HOST}/api/events?client=desktop`, {
      headers: { host: HOST, ...bearer },
      signal: ac.signal,
    });
    const reader = (r.body as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    for (const action of ["request", "open_settings"])
      expect(await (await post("/api/desktop/notifications", { action })).json()).toEqual({
        delivered: true,
      });
    expect(seen.filter((m) => m.type === "desktop_notifications").map((m) => m.data)).toEqual([
      { action: "request", rev: expect.any(Number) },
      { action: "open_settings", rev: expect.any(Number) },
    ]);
    const report = {
      version: "0.1.0",
      notifications: "not_determined",
      shortcut: { accelerator: "Alt+Shift+Space", registered: true },
    };
    expect((await post("/api/desktop/status", report)).status).toBe(200);
    expect((await post("/api/desktop/status", report)).status).toBe(200);
    expect(
      (await post("/api/desktop/status", { ...report, notifications: "granted" })).status,
    ).toBe(200);
    // 同じ状態の送り直しでは送らない
    expect(seen.filter((m) => m.type === "desktop_status")).toHaveLength(2);
    ac.abort();
    await reader.cancel();
  });
  test("notify は束ねずにすぐ送る", () => {
    const hub = new SseHub({ bundleMs: 1000 });
    const got: unknown[] = [];
    hub.subscribe((m) => got.push(m));
    hub.publish("notify", { notices: [{ id: "turn" }] });
    expect(got).toEqual([{ type: "notify", data: { notices: [{ id: "turn" }], rev: 1 } }]);
  });
});
