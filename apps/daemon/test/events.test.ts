/**
 * 予定の作成・編集と、時間ブロックの予定の削除（D-093、ADR 0012）の結合テスト: 偽のカレンダー（FakeCalendarProvider）→
 * HTTP（/api/calendar-events、/api/calendar/timeblock-events）→ ヘルパの createEvent / updateEvent / removeEvent /
 * listTimeblockEvents / deleteTimeblockEvent → calendar_event と週ボード。タスクの時間ブロックはカレンダーに書かない。
 * 時計は偽物（2026-09-14 10:00 JST、月曜）。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { nullLogger } from "@turnlane/collectors";
import type {
  BoardResponse,
  CalendarEventDetail,
  TaskWriteResponse,
  TimeBlockWriteResponse,
} from "@turnlane/core/api";
import { HelperRpcError } from "../src/calendar/bridge.ts";
import { errorCode, readOnlyReason, versionBelow } from "../src/calendar/events.ts";
import {
  type CalendarStatusView,
  type CalendarSystem,
  createCalendar,
} from "../src/calendar/index.ts";
import {
  editBlock,
  FakeCalendarProvider,
  type HelperCalendar,
  type HelperEvent,
} from "../src/calendar/provider.ts";
import { createApp } from "../src/http/app.ts";
import { createPlanner } from "../src/planner/index.ts";
import { type AiEnv, makeAiEnv } from "./helpers/env.ts";

const TOKEN = "e".repeat(64);
const HOST = "127.0.0.1:7317";
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 8, 14, 1, 0); // 2026-09-14 10:00 JST（月）
const D = "2026-09-14";
const jst = (s: string) => Date.parse(`${s}:00+09:00`);

let env: AiEnv;
let cal: CalendarSystem;
afterEach(async () => {
  cal?.stop();
  await env?.cleanup();
});

const calendars: HelperCalendar[] = [
  {
    id: "ek-work",
    title: "Work",
    sourceTitle: "Example",
    sourceType: "calDAV",
    colorHex: "#6b8cc7",
    allowsModify: true,
    type: "calDAV",
  },
  {
    id: "ek-personal",
    title: "Personal",
    sourceTitle: "Example",
    sourceType: "calDAV",
    colorHex: "#e08a5a",
    allowsModify: true,
    type: "calDAV",
  },
  {
    id: "ek-shared",
    title: "Team (read-only)",
    sourceTitle: "Example",
    sourceType: "calDAV",
    colorHex: "#888888",
    allowsModify: false,
    type: "calDAV",
  },
];

const ev = (
  p: Partial<HelperEvent> & { eventId: string; start: number; end: number },
): HelperEvent => ({
  calendarId: "ek-work",
  externalId: `uid-${p.eventId}`,
  occurrenceStart: p.start,
  title: p.eventId,
  allDay: false,
  status: "confirmed",
  availability: "busy",
  url: null,
  lastModified: T0 - DAY,
  hasAttendees: false,
  recurring: false,
  ...p,
});

/** 利用者の予定: 参加者のいる会議・参加者のいない予定・繰り返し・読み取り専用・時間ブロックの予定・Turnlane で作った予定 */
const fixtures = (): HelperEvent[] => [
  ev({
    eventId: "meeting",
    title: "Team meeting",
    start: jst(`${D}T13:00`),
    end: jst(`${D}T14:00`),
    hasAttendees: true,
  }),
  ev({ eventId: "dentist", title: "Dentist", start: jst(`${D}T16:00`), end: jst(`${D}T17:00`) }),
  ev({
    eventId: "standup",
    title: "Standup",
    start: jst(`${D}T09:30`),
    end: jst(`${D}T09:45`),
    recurring: true,
  }),
  ev({
    eventId: "shared",
    calendarId: "ek-shared",
    title: "Shared",
    start: jst(`${D}T18:00`),
    end: jst(`${D}T19:00`),
  }),
  ev({
    eventId: "old-tb-1",
    title: "Old block",
    start: jst(`${D}T11:00`),
    end: jst(`${D}T11:30`),
    url: "dayline://timeblock/b1",
  }),
  ev({
    eventId: "old-tb-2",
    calendarId: "ek-personal",
    title: "Older block",
    start: jst("2026-09-02T11:00"),
    end: jst("2026-09-02T12:00"),
    url: "dayline://timeblock/b2",
  }),
  ev({
    eventId: "made-1",
    title: "Made in turnlane",
    start: jst(`${D}T20:00`),
    end: jst(`${D}T20:30`),
    url: "turnlane://event/x1",
  }),
  // 名前を変える前の版が作った予定（ADR 0016。読み続ける）
  ev({
    eventId: "made-legacy",
    title: "Made before rename",
    start: jst(`${D}T22:00`),
    end: jst(`${D}T22:30`),
    url: "dayline://event/x0",
  }),
  // url の無い予定（目印なし。M3-3 の削除の対象にしない）
  ev({ eventId: "plain", title: "No url", start: jst(`${D}T21:00`), end: jst(`${D}T21:30`) }),
];

async function setup(o: { events?: HelperEvent[]; version?: string } = {}) {
  env = makeAiEnv({ now: T0 });
  const provider = new FakeCalendarProvider({
    calendars: structuredClone(calendars),
    events: structuredClone(o.events ?? fixtures()),
  });
  provider.defaultCalendarId = "ek-work";
  if (o.version) provider.version = o.version;
  cal = createCalendar({
    sqlite: env.sqlite,
    mutate: env.mutate,
    clock: env.clock,
    hub: env.hub,
    logger: nullLogger,
    provider,
    openSystem: env.open,
  });
  const planner = createPlanner({
    sqlite: env.sqlite,
    mutate: env.mutate,
    clock: env.clock,
    hub: env.hub,
    ai: env.ai,
    workdays: cal.deps.workdays,
  });
  const app = createApp({
    token: TOKEN,
    port: 7317,
    hub: env.hub,
    health: () => ({}) as never,
    admin: { backup: () => ({ date: "", path: "" }) },
    ai: () => env.ai.deps,
    planner: () => planner,
    calendar: () => cal.deps,
  });
  const call = async <T>(method: string, path: string, body?: unknown) => {
    const r = await app.request(`http://${HOST}${path}`, {
      method,
      headers: {
        host: HOST,
        authorization: `Bearer ${TOKEN}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, body: (await r.json()) as T };
  };
  await cal.deps.sync();
  const board = async () =>
    (await call<BoardResponse>("GET", `/api/board?from=${D}&to=${D}`)).body.days[0]?.events ?? [];
  const idOf = async (title: string) =>
    (await board()).find((e) => e.title === title)?.id as string;
  return { provider, call, board, idOf };
}

describe("タスクの時間ブロックはカレンダーに書かない（D-093）", () => {
  test("ブロックを置く・動かす・外す・タスクの題名を変える・消すでヘルパに何も書かない", async () => {
    const { provider, call } = await setup();
    const t = await call<TaskWriteResponse>("POST", "/api/tasks", { title: "Write", date: D });
    const id = t.body.task?.id as string;
    const b = await call<TimeBlockWriteResponse>("POST", "/api/time-blocks", {
      taskId: id,
      startAt: jst(`${D}T15:00`),
      endAt: jst(`${D}T15:30`),
    });
    const blockId = b.body.timeBlock?.id as string;
    expect(b.body.timeBlock).toEqual({
      id: blockId,
      taskId: id,
      title: null,
      start: jst(`${D}T15:00`),
      end: jst(`${D}T15:30`),
    });
    await call("PATCH", `/api/time-blocks/${blockId}`, { endAt: jst(`${D}T16:00`) });
    await call("PATCH", `/api/tasks/${id}`, { title: "Write more" });
    await call("DELETE", `/api/time-blocks/${blockId}`);
    await call("DELETE", `/api/tasks/${id}`);
    await cal.deps.sync();
    expect(provider.writes).toEqual([]);
  });

  test("設定の状態に書き戻しは無く、予定の書き先（デフォルトカレンダー）を返す", async () => {
    const { call } = await setup();
    const s = (await call<CalendarStatusView>("GET", "/api/calendar/status")).body;
    expect("writeback" in s).toBe(false);
    expect(s.events).toEqual({
      calendar: expect.objectContaining({ name: "Work", account: "Example", color: "#6b8cc7" }),
      defaultCalendar: "ok",
      helperOutdated: false,
    });
    expect((await call("PUT", "/api/calendar/writeback", { target: "off" })).status).toBe(404);
  });
});

describe("編集できる予定（D-093）", () => {
  test("参加者なし・書き込める・繰り返しでない・終日でないものだけ。時間ブロックの予定は出さない", async () => {
    const { board } = await setup();
    const evs = await board();
    const by = Object.fromEntries(evs.map((e) => [e.title, e.editable]));
    expect(by).toEqual({
      "Team meeting": false,
      Dentist: true,
      Standup: false,
      Shared: false,
      "Made in turnlane": true,
      "Made before rename": true,
      "No url": true,
    });
  });

  test("詳細パネルの理由: 参加者・カレンダー・繰り返し", async () => {
    const { call, idOf } = await setup();
    const d = async (title: string) =>
      (await call<CalendarEventDetail>("GET", `/api/calendar-events/${await idOf(title)}`)).body;
    expect(await d("Team meeting")).toMatchObject({ editable: false, readOnlyReason: "attendees" });
    expect(await d("Shared")).toMatchObject({ editable: false, readOnlyReason: "calendar" });
    expect(await d("Standup")).toMatchObject({ editable: false, readOnlyReason: "recurring" });
    expect(await d("Dentist")).toMatchObject({
      editable: true,
      readOnlyReason: null,
      createdByTurnlane: false,
    });
    expect(await d("Made in turnlane")).toMatchObject({ editable: true, createdByTurnlane: true });
    expect(await d("Made before rename")).toMatchObject({
      editable: true,
      createdByTurnlane: true,
    });
  });

  test("参加者のいる予定・読み取り専用のカレンダー・繰り返しは動かせず、ヘルパも呼ばない（409 not_editable）", async () => {
    const { provider, call, idOf } = await setup();
    for (const title of ["Team meeting", "Shared", "Standup"]) {
      const id = await idOf(title);
      const r = await call<{ error: string }>("PATCH", `/api/calendar-events/${id}`, {
        start: jst(`${D}T12:00`),
        end: jst(`${D}T12:30`),
      });
      expect([title, r.status, r.body.error]).toEqual([title, 409, "not_editable"]);
      expect((await call("DELETE", `/api/calendar-events/${id}`)).status).toBe(409);
    }
    expect(provider.writes).toEqual([]);
  });

  test("ヘルパが 0.4.0 より前: 参加者の有無が分からないので編集できず、作成は helper_outdated", async () => {
    const old = fixtures().map((e) => ({ ...e, hasAttendees: null, recurring: null }));
    const { call, board, idOf } = await setup({ events: old, version: "0.3.0" });
    expect((await board()).every((e) => !e.editable)).toBe(true);
    const d = await call<CalendarEventDetail>(
      "GET",
      `/api/calendar-events/${await idOf("Dentist")}`,
    );
    expect(d.body).toMatchObject({ editable: false, readOnlyReason: "helper" });
    const r = await call<{ error: string }>("POST", "/api/calendar-events", {
      title: "Lunch",
      start: jst(`${D}T12:00`),
      end: jst(`${D}T13:00`),
    });
    expect([r.status, r.body.error]).toEqual([409, "helper_outdated"]);
    const s = await call<CalendarStatusView>("GET", "/api/calendar/status");
    expect(s.body.events.helperOutdated).toBe(true);
  });
});

describe("予定の作成・編集・削除（D-093）", () => {
  test("作る: デフォルトカレンダーへ目印付きで書き、すぐ週ボードに出る（busy、編集できる）", async () => {
    const { provider, call, board } = await setup();
    const r = await call<{ event: CalendarEventDetail }>("POST", "/api/calendar-events", {
      title: "  Lunch with A  ",
      start: jst(`${D}T12:00`),
      end: jst(`${D}T13:00`),
    });
    expect(r.status).toBe(200);
    expect(r.body.event).toMatchObject({
      title: "Lunch with A",
      start: jst(`${D}T12:00`),
      end: jst(`${D}T13:00`),
      calendarName: "Work",
      editable: true,
      createdByTurnlane: true,
      busy: true,
    });
    const w = provider.writes[0] as { method: string; params: Record<string, unknown> };
    expect(w.method).toBe("createEvent");
    expect(w.params.calendarId).toBeUndefined();
    expect(String(w.params.url)).toMatch(/^turnlane:\/\/event\/[0-9a-f-]{36}$/);
    expect(w.params.tz).toBe("Asia/Tokyo");
    const e = (await board()).find((x) => x.title === "Lunch with A");
    expect(e).toMatchObject({ id: r.body.event.id, editable: true, busy: true });
    // 次の同期でも同じ行（id は変わらない）
    await cal.deps.sync();
    expect((await board()).find((x) => x.title === "Lunch with A")?.id).toBe(r.body.event.id);
  });

  test("動かす・伸ばす・題名を変える・カレンダーを変える: 同じ予定を更新し、id は変わらない", async () => {
    const { provider, call, idOf, board } = await setup();
    const id = await idOf("Dentist");
    const moved = await call<CalendarEventDetail>("PATCH", `/api/calendar-events/${id}`, {
      start: jst(`${D}T16:30`),
      end: jst(`${D}T17:30`),
    });
    expect(moved.body).toMatchObject({ id, start: jst(`${D}T16:30`), end: jst(`${D}T17:30`) });
    const resized = await call<CalendarEventDetail>("PATCH", `/api/calendar-events/${id}`, {
      end: jst(`${D}T18:00`),
    });
    expect(resized.body).toMatchObject({ start: jst(`${D}T16:30`), end: jst(`${D}T18:00`) });
    const renamed = await call<CalendarEventDetail>("PATCH", `/api/calendar-events/${id}`, {
      title: "Dentist (moved)",
    });
    expect(renamed.body.title).toBe("Dentist (moved)");
    const personal = env.sqlite
      .query<{ id: string }, []>("SELECT id FROM calendar WHERE name = 'Personal'")
      .get()?.id as string;
    const re = await call<CalendarEventDetail>("PATCH", `/api/calendar-events/${id}`, {
      calendarId: personal,
    });
    expect(re.body).toMatchObject({ id, calendarName: "Personal", calendarId: personal });
    expect(provider.writes.map((x) => x.method)).toEqual([
      "updateEvent",
      "updateEvent",
      "updateEvent",
      "updateEvent",
    ]);
    expect((provider.writes[3]?.params as { calendarId?: string } | undefined)?.calendarId).toBe(
      "ek-personal",
    );
    expect(provider.events.find((e) => e.eventId === "dentist")).toMatchObject({
      calendarId: "ek-personal",
      title: "Dentist (moved)",
      start: jst(`${D}T16:30`),
      end: jst(`${D}T18:00`),
    });
    await cal.deps.sync();
    expect((await board()).find((e) => e.title === "Dentist (moved)")?.id).toBe(id);
  });

  test("⌘Z の逆の書き込み（ifMatch。D-096）: 今の状態が一致すれば戻し、外部で変わっていれば書かずに 409 changed", async () => {
    const { provider, call, idOf } = await setup();
    const id = await idOf("Dentist");
    const after = { start: jst(`${D}T16:30`), end: jst(`${D}T17:30`), title: "Dentist" };
    await call("PATCH", `/api/calendar-events/${id}`, { start: after.start, end: after.end });
    // 一致: 元の時刻へ戻す
    const back = await call<CalendarEventDetail>("PATCH", `/api/calendar-events/${id}`, {
      start: jst(`${D}T16:00`),
      end: jst(`${D}T17:00`),
      ifMatch: after,
    });
    expect(back.status).toBe(200);
    expect(back.body).toMatchObject({ start: jst(`${D}T16:00`), end: jst(`${D}T17:00`) });
    // Calendar.app で動かされた（同期はまだ届いていない）: ヘルパから読み直して気づく
    provider.events = provider.events.map((e) =>
      e.eventId === "dentist" ? { ...e, start: jst(`${D}T16:15`), end: jst(`${D}T17:15`) } : e,
    );
    const writes = provider.writes.length;
    const r = await call<{ error: string }>("PATCH", `/api/calendar-events/${id}`, {
      start: jst(`${D}T15:00`),
      end: jst(`${D}T16:00`),
      ifMatch: { start: jst(`${D}T16:00`), end: jst(`${D}T17:00`) },
    });
    expect([r.status, r.body.error]).toEqual([409, "changed"]);
    expect(provider.writes.length).toBe(writes);
    expect(provider.events.find((e) => e.eventId === "dentist")?.start).toBe(jst(`${D}T16:15`));
    // 題名が外部で変わった
    await cal.deps.sync();
    provider.events = provider.events.map((e) =>
      e.eventId === "dentist" ? { ...e, title: "Dentist (Calendar.app)" } : e,
    );
    const t = await call<{ error: string }>("PATCH", `/api/calendar-events/${id}`, {
      title: "Dentist",
      ifMatch: { start: jst(`${D}T16:15`), end: jst(`${D}T17:15`), title: "Dentist" },
    });
    expect([t.status, t.body.error]).toEqual([409, "changed"]);
    // カレンダーが違う・消えた
    const personal = env.sqlite
      .query<{ id: string }, []>("SELECT id FROM calendar WHERE name = 'Personal'")
      .get()?.id as string;
    const c = await call<{ error: string }>("PATCH", `/api/calendar-events/${id}`, {
      start: jst(`${D}T15:00`),
      end: jst(`${D}T16:00`),
      ifMatch: { start: jst(`${D}T16:15`), end: jst(`${D}T17:15`), calendarId: personal },
    });
    expect([c.status, c.body.error]).toEqual([409, "changed"]);
    provider.events = provider.events.filter((e) => e.eventId !== "dentist");
    const g = await call<{ error: string }>("PATCH", `/api/calendar-events/${id}`, {
      start: jst(`${D}T15:00`),
      end: jst(`${D}T16:00`),
      ifMatch: { start: jst(`${D}T16:15`), end: jst(`${D}T17:15`) },
    });
    expect([g.status, g.body.error]).toEqual([409, "changed"]);
    expect(provider.writes.length).toBe(writes);
  });

  test("読み取り専用のカレンダーへは移せない（400 not_writable）", async () => {
    const { call, idOf } = await setup();
    const shared = env.sqlite
      .query<{ id: string }, []>("SELECT id FROM calendar WHERE name = 'Team (read-only)'")
      .get()?.id as string;
    const r = await call<{ error: string }>(
      "PATCH",
      `/api/calendar-events/${await idOf("Dentist")}`,
      { calendarId: shared },
    );
    expect([r.status, r.body.error]).toEqual([400, "not_writable"]);
  });

  const calId = (name: string) =>
    env.sqlite.query<{ id: string }, [string]>("SELECT id FROM calendar WHERE name = ?").get(name)
      ?.id as string;

  test("作る: calendarId を指定すればそのカレンダーへ書く（デフォルトの書き先は変えない）", async () => {
    const { provider, call, board } = await setup();
    const personal = calId("Personal");
    const r = await call<{ event: CalendarEventDetail }>("POST", "/api/calendar-events", {
      title: "Gym",
      start: jst(`${D}T07:00`),
      end: jst(`${D}T08:00`),
      calendarId: personal,
    });
    expect(r.status).toBe(200);
    expect(r.body.event).toMatchObject({
      title: "Gym",
      calendarId: personal,
      calendarName: "Personal",
      createdByTurnlane: true,
      editable: true,
    });
    const w = provider.writes[0] as { method: string; params: Record<string, unknown> };
    expect([w.method, w.params.calendarId]).toEqual(["createEvent", "ek-personal"]);
    expect(provider.events.find((e) => e.title === "Gym")?.calendarId).toBe("ek-personal");
    expect((await board()).find((e) => e.title === "Gym")?.id).toBe(r.body.event.id);
    // 設定の書き先（Calendar.app のデフォルト）はそのまま
    expect(provider.defaultCalendarId).toBe("ek-work");
    const st = await call<CalendarStatusView>("GET", "/api/calendar/status");
    expect(st.body.events.calendar?.name).toBe("Work");
  });

  test("作る: 無い・読み取り専用・無視しているカレンダーは書かずにエラー", async () => {
    const { provider, call } = await setup();
    const body = { title: "X", start: jst(`${D}T12:00`), end: jst(`${D}T12:30`) };
    const missing = await call<{ error: string }>("POST", "/api/calendar-events", {
      ...body,
      calendarId: "no-such-calendar",
    });
    expect([missing.status, missing.body.error]).toEqual([404, "calendar_not_found"]);
    const ro = await call<{ error: string }>("POST", "/api/calendar-events", {
      ...body,
      calendarId: calId("Team (read-only)"),
    });
    expect([ro.status, ro.body.error]).toEqual([400, "not_writable"]);
    const personal = calId("Personal");
    expect((await call("PATCH", `/api/calendars/${personal}`, { role: "ignored" })).status).toBe(
      200,
    );
    const ignored = await call<{ error: string }>("POST", "/api/calendar-events", {
      ...body,
      calendarId: personal,
    });
    expect([ignored.status, ignored.body.error]).toEqual([400, "calendar_ignored"]);
    const empty = await call<{ error: string }>("POST", "/api/calendar-events", {
      ...body,
      calendarId: "",
    });
    expect([empty.status, empty.body.error]).toEqual([400, "invalid_input"]);
    expect(provider.writes).toEqual([]);
  });

  test("無視しているカレンダーへは移せない（400 calendar_ignored）", async () => {
    const { provider, call, idOf } = await setup();
    const personal = calId("Personal");
    await call("PATCH", `/api/calendars/${personal}`, { role: "ignored" });
    const r = await call<{ error: string }>(
      "PATCH",
      `/api/calendar-events/${await idOf("Made in turnlane")}`,
      { calendarId: personal },
    );
    expect([r.status, r.body.error]).toEqual([400, "calendar_ignored"]);
    expect(provider.writes).toEqual([]);
  });

  test("移す: ヘルパが移した後の新しい識別子を返しても、同じ予定（id）のまま追従する", async () => {
    const { provider, call, idOf, board } = await setup();
    provider.reidentifyOnMove = true;
    const id = await idOf("Made in turnlane");
    const personal = calId("Personal");
    const r = await call<CalendarEventDetail>("PATCH", `/api/calendar-events/${id}`, {
      calendarId: personal,
    });
    expect(r.body).toMatchObject({ id, calendarId: personal, editable: true });
    const moved = provider.events.find((e) => e.title === "Made in turnlane");
    expect(moved?.eventId).not.toBe("made-1");
    expect(moved?.calendarId).toBe("ek-personal");
    // 次の同期でも同じ行で、もう一度動かせる（新しい eventId でヘルパを呼ぶ）
    await cal.deps.sync();
    expect((await board()).filter((e) => e.title === "Made in turnlane").map((e) => e.id)).toEqual([
      id,
    ]);
    const again = await call<CalendarEventDetail>("PATCH", `/api/calendar-events/${id}`, {
      start: jst(`${D}T20:30`),
      end: jst(`${D}T21:00`),
    });
    expect(again.status).toBe(200);
    const last = provider.writes.at(-1) as { params: { eventId: string } };
    expect(last.params.eventId).toBe(moved?.eventId as string);
  });

  test("消す: ヘルパの removeEvent で消え、週ボードからも消える", async () => {
    const { provider, call, idOf, board } = await setup();
    const id = await idOf("Made in turnlane");
    expect((await call("DELETE", `/api/calendar-events/${id}`)).status).toBe(200);
    expect(provider.events.some((e) => e.eventId === "made-1")).toBe(false);
    expect((await board()).some((e) => e.id === id)).toBe(false);
    expect((await call("GET", `/api/calendar-events/${id}`)).status).toBe(404);
  });

  test("失敗: デフォルトカレンダーが無い・ヘルパ未接続・ストアの失敗は 409 とコード（行は変えない）", async () => {
    const { provider, call, idOf } = await setup();
    const body = { title: "X", start: jst(`${D}T12:00`), end: jst(`${D}T12:30`) };
    provider.defaultCalendarId = null;
    let r = await call<{ error: string }>("POST", "/api/calendar-events", body);
    expect([r.status, r.body.error]).toEqual([409, "no_default_calendar"]);
    provider.defaultCalendarId = "ek-work";
    provider.failWrite = (m) => (m === "updateEvent" ? new HelperRpcError(4, "save_failed") : null);
    const id = await idOf("Dentist");
    r = await call<{ error: string }>("PATCH", `/api/calendar-events/${id}`, { title: "Y" });
    expect([r.status, r.body.error]).toEqual([409, "save_failed"]);
    const d = await call<CalendarEventDetail>("GET", `/api/calendar-events/${id}`);
    expect(d.body.title).toBe("Dentist");
    provider.setConnected(false);
    r = await call<{ error: string }>("POST", "/api/calendar-events", body);
    expect([r.status, r.body.error]).toEqual([409, "helper_not_connected"]);
  });

  test("入力の検証: 題名が空・終わりが開始より前は 400", async () => {
    const { call } = await setup();
    expect(
      (
        await call("POST", "/api/calendar-events", {
          title: " ",
          start: jst(`${D}T12:00`),
          end: jst(`${D}T13:00`),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call("POST", "/api/calendar-events", {
          title: "A",
          start: jst(`${D}T13:00`),
          end: jst(`${D}T12:00`),
        })
      ).status,
    ).toBe(400);
  });

  test("書いたら SSE calendar でその日を知らせる", async () => {
    const { call } = await setup();
    env.hub.flush();
    const seen: unknown[] = [];
    const off = env.hub.subscribe((e) => {
      if (e.type === "calendar") seen.push(e.data);
    });
    await call("POST", "/api/calendar-events", {
      title: "Lunch",
      start: jst(`${D}T12:00`),
      end: jst(`${D}T13:00`),
    });
    env.hub.flush();
    off();
    expect(seen).toContainEqual(expect.objectContaining({ dates: [D] }));
  });
});

describe("M3-3 で書いた時間ブロックの予定の削除（D-093）", () => {
  test("件数・期間・カレンダーごとの件数。目印が dayline://timeblock/ のものだけを数える", async () => {
    const { call } = await setup();
    const s = await call<{
      count: number;
      from: number;
      to: number;
      calendars: { name: string; account: string | null; count: number }[];
    }>("GET", "/api/calendar/timeblock-events");
    expect(s.body).toEqual({
      count: 2,
      from: jst("2026-09-02T11:00"),
      to: jst(`${D}T11:30`),
      calendars: [
        { name: "Personal", account: "Example", count: 1 },
        { name: "Work", account: "Example", count: 1 },
      ],
    });
  });

  test("消すのは時間ブロックの予定だけ。turnlane で作った予定・目印の無い予定・会議には触れない", async () => {
    const { provider, call } = await setup();
    const before = provider.events.map((e) => e.eventId).sort();
    const r = await call<{ deleted: number; failed: number }>(
      "POST",
      "/api/calendar/timeblock-events/cleanup",
      { expected: 2 },
    );
    expect(r.body).toEqual({ deleted: 2, failed: 0 });
    expect(
      provider.writes.map((w) => [w.method, (w.params as { eventId: string }).eventId]),
    ).toEqual(
      [
        ["deleteTimeblockEvent", "old-tb-2"],
        ["deleteTimeblockEvent", "old-tb-1"],
      ].sort((a, b) => String(a[1]).localeCompare(String(b[1]))),
    );
    expect(provider.events.map((e) => e.eventId).sort()).toEqual(
      before.filter((x) => !x?.startsWith("old-tb-")),
    );
    const s = await call<{ count: number }>("GET", "/api/calendar/timeblock-events");
    expect(s.body.count).toBe(0);
  });

  test("確認の後に件数が変わっていたら消さない（409 changed）", async () => {
    const { provider, call } = await setup();
    const r = await call<{ error: string }>("POST", "/api/calendar/timeblock-events/cleanup", {
      expected: 3,
    });
    expect([r.status, r.body.error]).toEqual([409, "changed"]);
    expect(provider.writes).toEqual([]);
  });

  test("偽のヘルパも目印の無い予定・turnlane で作った予定の削除を拒む（deleteTimeblockEvent）", async () => {
    const { provider } = await setup();
    await expect(provider.deleteTimeblockEvent({ eventId: "made-1" })).rejects.toThrow(
      "not_timeblock_event",
    );
    await expect(provider.deleteTimeblockEvent({ eventId: "plain" })).rejects.toThrow(
      "not_timeblock_event",
    );
    await expect(provider.deleteTimeblockEvent({ eventId: "meeting" })).rejects.toThrow(
      "not_timeblock_event",
    );
    expect(provider.events.some((e) => e.eventId === "made-1")).toBe(true);
  });

  test("ヘルパが古ければ数えずに helper_outdated", async () => {
    const { call } = await setup({ version: "0.3.0" });
    const r = await call<{ error: string }>("GET", "/api/calendar/timeblock-events");
    expect([r.status, r.body.error]).toEqual([409, "helper_outdated"]);
  });
});

describe("判定の関数", () => {
  test("editBlock（ヘルパと同じ条件）", () => {
    const base = {
      calendarWritable: true,
      hasAttendees: false,
      recurring: false,
      allDay: false,
      url: null,
    };
    expect(editBlock(base)).toBeNull();
    expect(editBlock({ ...base, url: "turnlane://event/x" })).toBeNull();
    expect(editBlock({ ...base, url: "dayline://event/x" })).toBeNull();
    expect(editBlock({ ...base, url: "dayline://timeblock/x" })).toBe("timeblock");
    expect(editBlock({ ...base, calendarWritable: false })).toBe("not_writable");
    expect(editBlock({ ...base, hasAttendees: true })).toBe("has_attendees");
    expect(editBlock({ ...base, hasAttendees: null })).toBe("has_attendees");
    expect(editBlock({ ...base, recurring: true })).toBe("recurring");
    expect(editBlock({ ...base, allDay: true })).toBe("all_day");
  });

  test("readOnlyReason", () => {
    const r = {
      is_writable: 1,
      has_attendees: 0,
      recurring: 0,
      all_day: 0,
      is_own_timeblock: 0,
      event_id: "x",
    };
    expect(readOnlyReason(r, false)).toBeNull();
    expect(readOnlyReason(r, true)).toBe("helper");
    expect(readOnlyReason({ ...r, has_attendees: null }, false)).toBe("helper");
    expect(readOnlyReason({ ...r, has_attendees: 1 }, false)).toBe("attendees");
    expect(readOnlyReason({ ...r, is_writable: 0 }, false)).toBe("calendar");
    expect(readOnlyReason({ ...r, all_day: 1 }, false)).toBe("all_day");
  });

  test("errorCode と versionBelow", () => {
    expect(errorCode(new HelperRpcError(-32601, "method not found"))).toBe("helper_outdated");
    expect(errorCode(new HelperRpcError(9, "not_editable"))).toBe("not_editable");
    expect(errorCode(new Error("helper_not_connected"))).toBe("helper_not_connected");
    expect(versionBelow("0.3.0", "0.4.0")).toBe(true);
    expect(versionBelow("0.4.0", "0.4.0")).toBe(false);
    expect(versionBelow("fake", "0.4.0")).toBe(false);
  });
});
