/**
 * D-096（予定の操作を取り消せるようにする）: 予定の移動・伸縮・題名・カレンダーの変更を ⌘Z で戻す。戻すときは
 * 変えた後の状態を ifMatch に付けて書く（デーモンが外部の変更を確かめる）。戻した書き込みは ⌘Z に積まない。
 * fetch を差し替えて、送った PATCH の中身で確かめる。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { BoardResponse, CalendarEventDetail, CalendarEventView } from "@turnlane/core/web";
import { queryClient } from "../src/data/client.ts";
import { keys } from "../src/data/invalidate.ts";
import { patchEvent, undoLast } from "../src/data/mutations.ts";

const jst = (s: string) => Date.parse(`${s}:00+09:00`);
const D = "2026-10-02";

const view: CalendarEventView = {
  id: "e1",
  title: "Dentist",
  start: jst(`${D}T16:00`),
  end: jst(`${D}T17:00`),
  allDay: false,
  startDate: null,
  endDate: null,
  calendarColor: "#111111",
  calendarColorKey: null,
  calendarId: "cal-work",
  busy: true,
  editable: true,
};
const detail = (p: Partial<CalendarEventDetail> = {}): CalendarEventDetail => ({
  id: "e1",
  title: "Dentist",
  start: view.start,
  end: view.end,
  allDay: false,
  startDate: null,
  endDate: null,
  tz: "Asia/Tokyo",
  calendarName: "Work",
  calendarAccount: null,
  calendarColor: "#111111",
  calendarColorKey: null,
  location: null,
  conferenceUrl: null,
  busy: true,
  status: "confirmed",
  hasMeetingLink: false,
  ownTimeBlock: null,
  calendarId: "cal-work",
  editable: true,
  readOnlyReason: null,
  createdByTurnlane: false,
  ...p,
});

let sent: { method: string; url: string; body: Record<string, unknown> }[] = [];
let reply: (body: Record<string, unknown>) => Response;
const realFetch = globalThis.fetch;

beforeEach(() => {
  sent = [];
  queryClient.clear();
  const board = {
    days: [{ date: D, axis: { start: jst(`${D}T00:00`), end: jst(`${D}T24:00`) }, events: [view] }],
  } as unknown as BoardResponse;
  queryClient.setQueryData(["board", D, D], board);
  queryClient.setQueryData(keys.calendarEvent("e1"), detail());
  reply = (b) => Response.json(detail(b as Partial<CalendarEventDetail>));
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const raw = init?.body ?? (input instanceof Request ? await input.text() : null);
    const body = raw ? (JSON.parse(String(raw)) as Record<string, unknown>) : {};
    if (method === "PATCH") {
      sent.push({ method, url, body });
      return reply(body);
    }
    return Response.json({});
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("予定の ⌘Z（D-096）", () => {
  test("移動を戻す: 元の時刻へ、変えた後の状態を ifMatch に付けて書く。戻した書き込みは積まない", async () => {
    const s = jst(`${D}T18:00`);
    const e = jst(`${D}T19:00`);
    expect(await patchEvent("e1", { start: s, end: e })).toBe(true);
    expect(sent[0]?.body).toEqual({ start: s, end: e });
    await undoLast();
    expect(sent[1]?.body).toEqual({
      start: view.start,
      end: view.end,
      ifMatch: { start: s, end: e, title: "Dentist", calendarId: "cal-work" },
    });
    await undoLast();
    expect(sent.length).toBe(2);
  });

  test("伸縮・題名は変えた項目だけを戻す", async () => {
    await patchEvent("e1", { end: jst(`${D}T17:30`) });
    await undoLast();
    expect(sent[1]?.body).toMatchObject({ end: view.end });
    expect(sent[1]?.body.start).toBeUndefined();
    await patchEvent("e1", { title: "Dentist (moved)" });
    await undoLast();
    expect(sent[3]?.body).toMatchObject({
      title: "Dentist",
      ifMatch: { title: "Dentist (moved)" },
    });
  });

  test("カレンダーの移動は元のカレンダーへ戻す", async () => {
    await patchEvent("e1", { calendarId: "cal-home" }, { calendarColor: "#222222" });
    await undoLast();
    expect(sent[1]?.body).toMatchObject({
      calendarId: "cal-work",
      ifMatch: { calendarId: "cal-home" },
    });
  });

  test("失敗した変更は ⌘Z に積まない", async () => {
    reply = () => Response.json({ error: "save_failed" }, { status: 409 });
    expect(await patchEvent("e1", { start: jst(`${D}T18:00`), end: jst(`${D}T19:00`) })).toBe(
      false,
    );
    await undoLast();
    expect(sent.length).toBe(1);
  });
});
