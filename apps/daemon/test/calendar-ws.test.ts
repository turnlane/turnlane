/**
 * /internal/ek（ヘルパの WebSocket）の結合テスト: 実際に turnlaned を空いているポートで起動し、
 * ヘルパの代わりの WebSocket クライアントが JSON-RPC に応える。EventKit・TCC・launchd には触れない。
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nullLogger } from "@turnlane/collectors";
import { resolvePaths } from "@turnlane/core";
import type { CalendarView } from "../src/calendar/index.ts";
import type { HealthReport } from "../src/health.ts";
import { type RunningDaemon, startDaemon } from "../src/main.ts";

let home: string;
let daemon: RunningDaemon | null = null;
let sockets: WebSocket[] = [];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "turnlane-ek-"));
});
afterEach(async () => {
  for (const s of sockets) s.close();
  sockets = [];
  await daemon?.stop();
  daemon = null;
  rmSync(home, { recursive: true, force: true });
});

/** ヘルパの代わり: 要求に固定の結果で応える */
function fakeHelper(url: string, token: string): Promise<WebSocket> {
  const ws = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } } as never);
  sockets.push(ws);
  ws.onmessage = (m) => {
    const req = JSON.parse(String(m.data)) as { id: number; method: string };
    const result =
      req.method === "status"
        ? { authorization: "fullAccess", version: "test" }
        : req.method === "listCalendars"
          ? [
              {
                id: "ek-1",
                title: "Work",
                sourceTitle: null,
                sourceType: "local",
                colorHex: "#6b8cc7",
                allowsModify: true,
                type: "local",
              },
            ]
          : [
              {
                calendarId: "ek-1",
                externalId: "e1",
                occurrenceStart: Date.now(),
                title: "Sync",
                start: Date.now(),
                end: Date.now() + 1_800_000,
                allDay: false,
                status: "confirmed",
                availability: "busy",
              },
            ];
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result }));
  };
  return new Promise((resolve, reject) => {
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error("ws error"));
  });
}

async function until<T>(f: () => Promise<T | null>, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await f();
    if (v) return v;
    await Bun.sleep(50);
  }
  throw new Error("timeout");
}

test("ヘルパが接続すると同期し、health と /api/calendars に出る。切れたら未接続に戻る", async () => {
  const paths = resolvePaths({ HOME: home }, home);
  daemon = await startDaemon({ paths, logger: nullLogger, port: 0, ingest: false });
  const d = daemon;
  const api = async <T>(path: string) =>
    (await (
      await fetch(`${d.url}${path}`, { headers: { authorization: `Bearer ${d.token}` } })
    ).json()) as T;
  expect((await api<HealthReport>("/api/health")).calendarHelper.connected).toBe(false);

  const ws = await fakeHelper(`ws://127.0.0.1:${d.port}/internal/ek`, d.token);
  const cals = await until(async () => {
    const r = await api<{ calendars: CalendarView[] }>("/api/calendars");
    return r.calendars.length > 0 && r.calendars[0]?.events === 1 ? r.calendars : null;
  });
  expect(cals.map((c) => [c.name, c.role])).toEqual([["Work", "source"]]);
  const h = await api<HealthReport>("/api/health");
  expect(h.calendarHelper).toMatchObject({
    connected: true,
    authorization: "fullAccess",
    version: "test",
  });
  ws.close();
  await until(async () =>
    (await api<HealthReport>("/api/health")).calendarHelper.connected ? null : true,
  );
});

test("トークンが無い・違う、Origin 付き、Host が違う接続は upgrade しない", async () => {
  const paths = resolvePaths({ HOME: home }, home);
  daemon = await startDaemon({ paths, logger: nullLogger, port: 0, ingest: false });
  const url = `${daemon.url}/internal/ek`;
  const h = {
    upgrade: "websocket",
    connection: "Upgrade",
    "sec-websocket-version": "13",
    "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
  };
  expect((await fetch(url, { headers: h })).status).toBe(401);
  expect((await fetch(url, { headers: { ...h, authorization: "Bearer wrong" } })).status).toBe(401);
  expect(
    (
      await fetch(url, {
        headers: { ...h, authorization: `Bearer ${daemon.token}`, origin: "http://evil.example" },
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await fetch(url.replace("127.0.0.1", "localhost"), {
        headers: { ...h, authorization: `Bearer ${daemon.token}`, host: "evil.example" },
      })
    ).status,
  ).toBe(421);
});
