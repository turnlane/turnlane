/**
 * カレンダーの読み取り（M3 の段階 A）の結合テスト: 偽のカレンダー（FakeCalendarProvider）→ 同期 → calendar_event →
 * 週ボード・待ち区間の再計算・稼働日と祝日・API。時計は偽物（2026-09-14 10:00 JST、月曜）。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { nullLogger } from "@turnlane/collectors";
import type { BoardResponse, CalendarEventDetail } from "@turnlane/core/api";
import { HelperBridge } from "../src/calendar/bridge.ts";
import { type CalendarSystem, createCalendar } from "../src/calendar/index.ts";
import {
  FakeCalendarProvider,
  type HelperCalendar,
  type HelperEvent,
} from "../src/calendar/provider.ts";
import { createApp } from "../src/http/app.ts";
import type { SseMessage } from "../src/http/sse.ts";
import { createPlanner } from "../src/planner/index.ts";
import { type AiEnv, makeAiEnv, present } from "./helpers/env.ts";
import { claudeTranscript } from "./helpers/transcript.ts";

const TOKEN = "d".repeat(64);
const PORT = 7317;
const HOST = `127.0.0.1:${PORT}`;
const MIN = 60_000;
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 8, 14, 1, 0); // 2026-09-14 10:00 JST（月）
const D = "2026-09-14";
/** JST の "2026-09-14T10:30" → epoch ms */
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
    id: "ek-holidays",
    title: "Holidays",
    sourceTitle: "Other",
    sourceType: "subscribed",
    colorHex: "#4fb3a9",
    allowsModify: false,
    type: "subscription",
  },
  {
    id: "ek-birthdays",
    title: "Birthdays",
    sourceTitle: "Other",
    sourceType: "birthdays",
    colorHex: null,
    allowsModify: false,
    type: "birthday",
  },
];

function ev(p: Partial<HelperEvent> & { calendarId: string; externalId: string }): HelperEvent {
  const start = p.start ?? T0;
  return {
    eventId: p.externalId,
    occurrenceStart: start,
    title: "Event",
    location: null,
    start,
    end: start + 30 * MIN,
    tz: "Asia/Tokyo",
    allDay: false,
    startDate: null,
    endDate: null,
    status: "confirmed",
    availability: "busy",
    selfResponse: "accepted",
    url: null,
    conferenceUrl: null,
    lastModified: T0 - DAY,
    ...p,
  };
}

function allDay(calendarId: string, externalId: string, date: string, title: string): HelperEvent {
  const start = jst(`${date}T00:00`);
  return ev({
    calendarId,
    externalId,
    title,
    start,
    end: start + DAY - 1000,
    allDay: true,
    startDate: date,
    endDate: new Date(Date.parse(`${date}T00:00:00Z`) + DAY).toISOString().slice(0, 10),
    availability: "free",
    selfResponse: null,
  });
}

function setup(events: HelperEvent[] = [], o: { connected?: boolean } = {}) {
  env = makeAiEnv({ now: T0 });
  // この日は T0 の1時間前から Mac を使い続けている（D-105。放置は在席の間だけ数える）
  present(env.sqlite, T0 - 60 * 60_000, T0 + 14 * 60 * 60_000);
  env.git.repos.set("/w/app", "/w/app");
  env.git.defaults.set("/w/app", "main");
  const provider = new FakeCalendarProvider({
    calendars: structuredClone(calendars),
    events,
    connected: o.connected ?? true,
  });
  cal = createCalendar({
    sqlite: env.sqlite,
    mutate: env.mutate,
    clock: env.clock,
    hub: env.hub,
    logger: nullLogger,
    provider,
    openSystem: env.open,
    home: env.home,
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
    port: PORT,
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
  const sse: SseMessage[] = [];
  env.hub.subscribe((m) => sse.push(m));
  const calendarEvents = () => {
    env.hub.flush();
    const out = sse.filter((m) => m.type === "calendar").map((m) => m.data.dates as string[]);
    sse.length = 0;
    return out;
  };
  return { provider, call, calendarEvents };
}

const q = <T>(sql: string, ...args: (string | number)[]) =>
  env.sqlite.query<T, (string | number)[]>(sql).all(...args);

describe("同期（M3-2）", () => {
  test("窓（7日前〜21日後）のスナップショットを代入で入れ、変わった日付だけ SSE calendar で知らせる", async () => {
    const meeting = ev({
      calendarId: "ek-work",
      externalId: "m1",
      title: "Weekly sync",
      start: jst("2026-09-14T11:00"),
      end: jst("2026-09-14T11:45"),
    });
    const old = ev({ calendarId: "ek-work", externalId: "old", start: jst("2026-09-01T10:00") });
    const far = ev({ calendarId: "ek-work", externalId: "far", start: jst("2026-10-20T10:00") });
    const own = ev({
      calendarId: "ek-work",
      externalId: "tb",
      start: jst("2026-09-15T10:00"),
      url: "dayline://timeblock/abc",
    });
    const bday = allDay("ek-birthdays", "b1", "2026-09-16", "Someone's birthday");
    const { provider, calendarEvents } = setup([meeting, old, far, own, bday]);
    const r = await cal.deps.sync();
    expect(r).toMatchObject({ ok: true, calendars: 3 });
    // 新しいカレンダーは role = source（誕生日カレンダーも source。表示はするが祝日にはしない）
    expect(q("SELECT name, role, is_writable FROM calendar ORDER BY name")).toEqual([
      { name: "Birthdays", role: "source", is_writable: 0 },
      { name: "Holidays", role: "source", is_writable: 0 },
      { name: "Work", role: "source", is_writable: 1 },
    ]);
    // 窓の外（9/1・10/20）は入らない。自分の時間ブロックは目印付き
    expect(
      q("SELECT external_id, title, is_own_timeblock FROM calendar_event ORDER BY start_at"),
    ).toEqual([
      { external_id: "m1", title: "Weekly sync", is_own_timeblock: 0 },
      { external_id: "tb", title: "Event", is_own_timeblock: 1 },
      { external_id: "b1", title: "Someone's birthday", is_own_timeblock: 0 },
    ]);
    expect(provider.fetches.at(-1)).toEqual({
      calendarIds: ["ek-birthdays", "ek-holidays", "ek-work"],
      from: jst("2026-09-07T04:00"),
      to: jst("2026-10-06T04:00"),
    });
    // 初回は種類（誕生日など）が分かったので、稼働日が変わりうる窓の全日付
    expect(calendarEvents()[0]).toHaveLength(29);

    // 変化が無ければ知らせない
    const r2 = await cal.deps.sync();
    expect(r2.changedDates).toEqual([]);
    expect(calendarEvents()).toEqual([]);

    // 会議が 15:00 に動き、時間ブロックの予定が消えた → その日付だけ
    provider.events = [
      { ...meeting, start: jst("2026-09-14T15:00"), end: jst("2026-09-14T16:00") },
      bday,
    ];
    const r3 = await cal.deps.sync();
    expect(r3.changedDates).toEqual(["2026-09-14", "2026-09-15"]);
    expect(calendarEvents()).toEqual([["2026-09-14", "2026-09-15"]]);
    expect(
      q(
        "SELECT external_id, start_at FROM calendar_event WHERE calendar_id IN (SELECT id FROM calendar WHERE name = 'Work')",
      ),
    ).toEqual([{ external_id: "m1", start_at: jst("2026-09-14T15:00") }]);
  });

  test("ignored にしたカレンダーは取得せず予定を消す。Mac から消えたカレンダーは行も消す", async () => {
    const meeting = ev({ calendarId: "ek-work", externalId: "m1", start: jst("2026-09-14T11:00") });
    const { provider, call } = setup([meeting]);
    await cal.deps.sync();
    const work = q<{ id: string }>("SELECT id FROM calendar WHERE name = 'Work'")[0]?.id as string;
    const r = await call<{ calendar: { role: string } }>("PATCH", `/api/calendars/${work}`, {
      role: "ignored",
    });
    expect(r.body.calendar.role).toBe("ignored");
    // 役割は source / ignored だけ（D-093 で writeback をやめた）
    const hol = q<{ id: string }>("SELECT id FROM calendar WHERE name = 'Holidays'")[0]
      ?.id as string;
    expect((await call("PATCH", `/api/calendars/${hol}`, { role: "writeback" })).status).toBe(400);
    expect((await call("PATCH", "/api/calendars/nope", { role: "source" })).status).toBe(404);
    await cal.deps.sync();
    expect(provider.fetches.at(-1)?.calendarIds).toEqual(["ek-birthdays", "ek-holidays"]);
    expect(q("SELECT count(*) AS n FROM calendar_event")).toEqual([{ n: 0 }]);
    provider.calendars = provider.calendars.filter((c) => c.id !== "ek-holidays");
    await cal.deps.sync();
    expect(q("SELECT name FROM calendar ORDER BY name")).toEqual([
      { name: "Birthdays" },
      { name: "Work" },
    ]);
  });

  test("ヘルパ未接続なら何もしない（キャッシュは残し、他の API は動く）。接続したら同期する", async () => {
    const meeting = ev({ calendarId: "ek-work", externalId: "m1", start: jst("2026-09-14T11:00") });
    const { provider, call } = setup([meeting], { connected: false });
    expect(await cal.deps.sync()).toMatchObject({ ok: false, reason: "not_connected" });
    const st = await call<{ connected: boolean; authorization: string | null }>(
      "GET",
      "/api/calendar/status",
    );
    expect(st.body).toMatchObject({ connected: false, authorization: null });
    const b = await call<BoardResponse>("GET", `/api/board?from=${D}&to=${D}`);
    expect(b.status).toBe(200);
    expect(b.body.days[0]?.events).toEqual([]);
    cal.start();
    provider.setConnected(true);
    await cal.service.whenIdle();
    expect(q("SELECT count(*) AS n FROM calendar_event")).toEqual([{ n: 1 }]);
    // 権限が無くなったら取得しない（キャッシュは残す）
    provider.setAuthorization("denied");
    await cal.service.whenIdle();
    expect(cal.service.status()).toMatchObject({ authorization: "denied", lastError: "no_access" });
    expect(q("SELECT count(*) AS n FROM calendar_event")).toEqual([{ n: 1 }]);
  });

  test("予定を取れていないことの知らせ（D-130）: 権限なし・未接続（2分）・同期の失敗（15分）", async () => {
    const { provider } = setup([ev({ calendarId: "ek-work", externalId: "m1" })]);
    cal.start();
    await cal.service.whenIdle();
    expect(cal.service.status().problem).toBeNull();
    // 権限が無い: すぐ知らせる
    provider.setAuthorization("notDetermined");
    await cal.service.whenIdle();
    expect(cal.service.status().problem).toBe("no_access");
    provider.setAuthorization("fullAccess");
    await cal.service.whenIdle();
    expect(cal.service.status().problem).toBeNull();
    // 同期が失敗し続ける（つながっていて権限もある）: 15分たってから
    const fetch = provider.fetchEvents.bind(provider);
    provider.fetchEvents = async () => {
      throw new Error("boom");
    };
    await cal.service.syncNow();
    expect(cal.service.status().problem).toBeNull();
    env.clock.set(T0 + 15 * MIN);
    await cal.service.syncNow();
    expect(cal.service.status().problem).toBe("sync_failing");
    provider.fetchEvents = fetch;
    await cal.service.syncNow();
    expect(cal.service.status().problem).toBeNull();
    // 未接続: 一度つながったことがあれば、2分たってから
    provider.setConnected(false);
    expect(cal.service.status().problem).toBeNull();
    env.clock.set(T0 + 17 * MIN);
    expect(cal.service.status().problem).toBe("not_connected");
    provider.setConnected(true);
    await cal.service.whenIdle();
    expect(cal.service.status().problem).toBeNull();
  });

  test("知らせ（D-130）: 一度もつながったことが無ければ（カレンダーを使っていない）未接続を知らせない", async () => {
    setup([], { connected: false });
    cal.start();
    env.clock.set(T0 + 60 * MIN);
    expect(cal.service.status().problem).toBeNull();
  });

  test("storeChanged で取り直す（束ねて1回）", async () => {
    const { provider } = setup([]);
    cal.start();
    await cal.service.whenIdle();
    const n = provider.fetches.length;
    provider.events = [
      ev({ calendarId: "ek-work", externalId: "new", start: jst("2026-09-14T13:00") }),
    ];
    provider.storeChanged();
    provider.storeChanged();
    await cal.service.whenIdle();
    expect(provider.fetches.length).toBe(n + 1);
    expect(q("SELECT external_id FROM calendar_event")).toEqual([{ external_id: "new" }]);
  });
});

describe("カレンダーの色（D-125）", () => {
  test("PATCH colorKey は Turnlane の中だけに保存し、週ボード・詳細・一覧・書き先に出す。同期で消えず、null で戻す", async () => {
    const meeting = ev({ calendarId: "ek-work", externalId: "m1", start: jst("2026-09-14T11:00") });
    const { provider, call } = setup([meeting]);
    await cal.deps.sync();
    const work = q<{ id: string }>("SELECT id FROM calendar WHERE name = 'Work'")[0]?.id as string;
    const sse: { calendars?: unknown }[] = [];
    env.hub.subscribe((m) => {
      if (m.type === "calendar") sse.push(m.data as { calendars?: unknown });
    });
    const r = await call<{ calendar: { color: string; colorKey: string | null; role: string } }>(
      "PATCH",
      `/api/calendars/${work}`,
      { colorKey: "green" },
    );
    expect(r.status).toBe(200);
    // カレンダーアプリの色はそのまま、役割も変えない
    expect(r.body.calendar).toMatchObject({ color: "#6b8cc7", colorKey: "green", role: "source" });
    env.hub.flush();
    expect(sse.at(-1)?.calendars).toBe(true);
    // 書き換えはヘルパに送らない（カレンダー側の色は変えない）。同期し直しても消えない
    provider.calendars = provider.calendars.map((c) =>
      c.id === "ek-work" ? { ...c, colorHex: "#ff0000" } : c,
    );
    await cal.deps.sync();
    const board = await call<BoardResponse>("GET", `/api/board?from=${D}&to=${D}`);
    const e = board.body.days[0]?.events[0];
    expect(e).toMatchObject({
      calendarColor: "#ff0000",
      calendarColorKey: "green",
      calendarId: work,
    });
    const d = await call<CalendarEventDetail>("GET", `/api/calendar-events/${e?.id}`);
    expect(d.body).toMatchObject({ calendarColor: "#ff0000", calendarColorKey: "green" });
    const list = await call<{ calendars: { id: string; colorKey: string | null }[] }>(
      "GET",
      "/api/calendars",
    );
    expect(list.body.calendars.find((c) => c.id === work)?.colorKey).toBe("green");
    // 役割と一緒にも変えられる。null でカレンダーアプリの色に戻す
    const back = await call<{ calendar: { colorKey: string | null } }>(
      "PATCH",
      `/api/calendars/${work}`,
      { colorKey: null },
    );
    expect(back.body.calendar.colorKey).toBeNull();
    expect(q("SELECT color_key FROM calendar WHERE id = ?", work)).toEqual([{ color_key: null }]);
    // パレットに無いキー・空の変更は 400、無いカレンダーは 404
    expect((await call("PATCH", `/api/calendars/${work}`, { colorKey: "teal" })).status).toBe(400);
    expect((await call("PATCH", `/api/calendars/${work}`, {})).status).toBe(400);
    expect((await call("PATCH", "/api/calendars/nope", { colorKey: "red" })).status).toBe(404);
  });
});

describe("予定の詳細パネル（D-070）", () => {
  test("GET /api/calendar-events/:id は読み取り専用の詳細を返し、open は Calendar.app で出す（だめなら開くだけ）", async () => {
    const { call } = setup([
      ev({
        calendarId: "ek-work",
        externalId: "uid-1",
        title: "Design review",
        location: "Room 4",
        conferenceUrl: "https://meet.example.com/abc",
        start: jst("2026-09-14T11:00"),
        end: jst("2026-09-14T12:00"),
      }),
      ev({
        calendarId: "ek-work",
        externalId: "uid-2",
        title: "Focus",
        availability: "free",
        start: jst("2026-09-14T13:00"),
      }),
    ]);
    await cal.deps.sync();
    const id = (title: string) =>
      q<{ id: string }>("SELECT id FROM calendar_event WHERE title = ?", title)[0]?.id ?? "";
    const r = await call<CalendarEventDetail>("GET", `/api/calendar-events/${id("Design review")}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      title: "Design review",
      calendarName: "Work",
      calendarAccount: "Example",
      location: "Room 4",
      conferenceUrl: "https://meet.example.com/abc",
      busy: true,
      ownTimeBlock: null,
    });
    expect(
      (await call<CalendarEventDetail>("GET", `/api/calendar-events/${id("Focus")}`)).body.busy,
    ).toBe(false);
    expect((await call("GET", "/api/calendar-events/nope")).status).toBe(404);

    const o1 = await call<{ outcome: string }>(
      "POST",
      `/api/calendar-events/${id("Design review")}/open`,
    );
    expect(o1.body.outcome).toBe("shown");
    expect(env.open.runs.at(-1)?.slice(0, 2)).toEqual(["/usr/bin/osascript", "-e"]);
    expect(env.open.runs.at(-1)?.slice(-2)).toEqual(["Work", "uid-1"]);
    env.open.fail = (a) => a[0] === "/usr/bin/osascript";
    const o2 = await call<{ outcome: string }>(
      "POST",
      `/api/calendar-events/${id("Design review")}/open`,
    );
    expect(o2.body.outcome).toBe("opened");
    expect(env.open.runs.at(-1)).toEqual(["/usr/bin/open", "-a", "Calendar"]);
  });

  test("turnlane が書き戻した予定（url の目印）は own_timeblock_id を持ち、詳細から元のブロックとタスクが分かる", async () => {
    const { call, provider } = setup();
    const task = await call<{ task: { id: string } }>("POST", "/api/tasks", { title: "Write" });
    const block = await call<{ timeBlock: { id: string } }>("POST", "/api/time-blocks", {
      taskId: task.body.task.id,
      startAt: jst("2026-09-14T15:00"),
      endAt: jst("2026-09-14T15:30"),
    });
    const bid = block.body.timeBlock.id;
    provider.events = [
      ev({
        calendarId: "ek-work",
        externalId: "uid-own",
        title: "Write",
        start: jst("2026-09-14T15:00"),
        url: `dayline://timeblock/${bid}`,
      }),
    ];
    await cal.deps.sync();
    const row = q<{ id: string; is_own_timeblock: number; own_timeblock_id: string }>(
      "SELECT id, is_own_timeblock, own_timeblock_id FROM calendar_event WHERE external_id = 'uid-own'",
    )[0];
    expect(row).toMatchObject({ is_own_timeblock: 1, own_timeblock_id: bid });
    const d = await call<CalendarEventDetail>("GET", `/api/calendar-events/${row?.id}`);
    expect(d.body.ownTimeBlock).toEqual({ blockId: bid, taskId: task.body.task.id });
    expect(d.body.busy).toBe(false);
  });
});

describe("会議中の待ちは放置に入れない（M3-2、phase0-plan 3.3.1）", () => {
  test("会議と重なる待ちは集計外 event になり、Idle から外れる。辞退した会議・free の予定は外さない", async () => {
    const { provider, call } = setup([]);
    const tr = claudeTranscript(join(env.home, ".claude"), {
      sid: "11111111-0000-4000-8000-000000000001",
      cwd: "/w/app",
      branch: "feat/login",
    });
    tr.human(T0 - 2 * MIN);
    tr.assistantEnd(T0, "Which option do you prefer?");
    env.clock.set(T0 + 16 * MIN);
    await env.sync();
    env.clock.set(T0 + 90 * MIN);
    env.ai.runner.runOnce();
    const idle = () => env.ai.deps.days(D, 1).days[0]?.idleMs;
    expect(idle()).toBe(74 * MIN);

    // 10:30〜11:00 の会議（busy・承諾）、11:00〜11:15 の辞退した会議、11:15〜11:20 の free
    provider.events = [
      ev({ calendarId: "ek-work", externalId: "m", start: T0 + 30 * MIN, end: T0 + 60 * MIN }),
      ev({
        calendarId: "ek-work",
        externalId: "declined",
        start: T0 + 60 * MIN,
        end: T0 + 75 * MIN,
        selfResponse: "declined",
      }),
      ev({
        calendarId: "ek-work",
        externalId: "free",
        start: T0 + 75 * MIN,
        end: T0 + 80 * MIN,
        availability: "free",
      }),
    ];
    const r = await cal.deps.sync();
    expect(r.changedDates).toContain(D);
    env.ai.runner.runOnce();
    const segs = q<{ kind: string; excluded_by: string | null; ms: number }>(
      "SELECT kind, excluded_by, SUM(end_at - start_at) AS ms FROM ai_wait_segment GROUP BY kind, excluded_by ORDER BY kind, excluded_by",
    );
    expect(segs).toEqual([
      { kind: "excluded", excluded_by: "event", ms: 30 * MIN },
      { kind: "excluded", excluded_by: "no_task", ms: 1 * MIN - 100 },
      { kind: "grace", excluded_by: null, ms: 15 * MIN },
      { kind: "idle", excluded_by: null, ms: 44 * MIN },
    ]);
    expect(idle()).toBe(44 * MIN);
    // 週ボード: 予定は出る（辞退は busy でない）。Events は busy の和集合
    const b = await call<BoardResponse>("GET", `/api/board?from=${D}&to=${D}`);
    expect(b.body.days[0]?.events.map((e) => [e.id.length > 0, e.busy])).toEqual([
      [true, true],
      [true, false],
      [true, false],
    ]);
    expect(b.body.days[0]?.totals.eventsMs).toBe(30 * MIN);
    expect(b.body.days[0]?.totals.idleMs).toBe(44 * MIN);

    // 会議のカレンダーを ignored にすると、次の再計算で放置に戻る
    const work = q<{ id: string }>("SELECT id FROM calendar WHERE name = 'Work'")[0]?.id as string;
    await call("PATCH", `/api/calendars/${work}`, { role: "ignored" });
    await cal.service.whenIdle();
    env.ai.runner.runOnce();
    expect(idle()).toBe(74 * MIN);
  });
});

describe("稼働日と祝日（M3-6）", () => {
  // 2026-09-21（月）〜23（水）が祝日の連休
  const holidays = [
    allDay("ek-holidays", "h1", "2026-09-21", "Respect for the Aged Day"),
    allDay("ek-holidays", "h2", "2026-09-22", "Citizens' Holiday"),
    allDay("ek-holidays", "h3", "2026-09-23", "Autumnal Equinox Day"),
  ];
  const bday = allDay("ek-birthdays", "b1", "2026-09-24", "Someone's birthday");

  test("祝日カレンダーを自動で採用し、週ボードの稼働日・Free と turnlane calendar status に効く", async () => {
    const { call } = setup([...holidays, bday]);
    await cal.deps.sync();
    const st = await call<{
      holidays: { mode: string; calendars: { name: string }[]; upcoming: { date: string }[] };
      workdays: { today: string; isWorkday: boolean; nextWorkday: string };
    }>("GET", "/api/calendar/status");
    expect(st.body.holidays.mode).toBe("auto");
    expect(st.body.holidays.calendars.map((c) => c.name)).toEqual(["Holidays"]);
    expect(st.body.holidays.upcoming.map((h) => h.date)).toEqual([
      "2026-09-21",
      "2026-09-22",
      "2026-09-23",
    ]);
    expect(st.body.workdays).toMatchObject({
      today: D,
      isWorkday: true,
      nextWorkday: "2026-09-15",
    });
    // 金曜の次の稼働日は連休明けの木曜
    const rule = cal.deps.workdayRule();
    const { nextWorkday } = await import("@turnlane/core");
    expect(nextWorkday("2026-09-18", rule)).toBe("2026-09-24");

    const b = await call<BoardResponse>("GET", "/api/board?from=2026-09-18&to=2026-09-24");
    expect(b.body.days.map((d) => [d.date, d.workday, d.totals.freeMs > 0])).toEqual([
      ["2026-09-18", true, true],
      ["2026-09-19", false, false],
      ["2026-09-20", false, false],
      ["2026-09-21", false, false],
      ["2026-09-22", false, false],
      ["2026-09-23", false, false],
      ["2026-09-24", true, true],
    ]);
    // 祝日カレンダーの役割が source なら、他の終日予定と同じく出る
    expect(b.body.days[3]?.allDayEvents.map((e) => e.title)).toEqual(["Respect for the Aged Day"]);
  });

  test("祝日カレンダーを ignored にしても同期の対象（終日の行には出ないが、稼働日には効く）", async () => {
    const { call, provider } = setup([...holidays]);
    await cal.deps.sync();
    const h = q<{ id: string }>("SELECT id FROM calendar WHERE name = 'Holidays'")[0]?.id as string;
    await call("PATCH", `/api/calendars/${h}`, { role: "ignored" });
    await cal.service.whenIdle();
    expect(provider.fetches.at(-1)?.calendarIds).toContain("ek-holidays");
    const b = await call<BoardResponse>("GET", "/api/board?from=2026-09-21&to=2026-09-21");
    expect(b.body.days[0]).toMatchObject({ workday: false, allDayEvents: [] });
  });

  test("turnlane calendar holidays --set / --none / --auto（workdays.holiday_calendars）と turnlane config", async () => {
    const { call, calendarEvents } = setup([...holidays]);
    await cal.deps.sync();
    calendarEvents();
    const h = q<{ id: string }>("SELECT id FROM calendar WHERE name = 'Holidays'")[0]?.id as string;
    // --none
    const none = await call("PUT", "/api/config/workdays.holiday_calendars", { value: [] });
    expect(none.status).toBe(200);
    expect(calendarEvents()[0]).toHaveLength(29);
    let st = await call<{ holidays: { mode: string }; workdays: { nextWorkday: string } }>(
      "GET",
      "/api/calendar/status",
    );
    expect(st.body.holidays.mode).toBe("none");
    expect(cal.deps.workdayRule().holidays.size).toBe(0);
    // --set <id>
    await call("PUT", "/api/config/workdays.holiday_calendars", { value: [h] });
    st = await call("GET", "/api/calendar/status");
    expect(st.body.holidays.mode).toBe("manual");
    expect(cal.deps.workdayRule().holidays.has("2026-09-22")).toBe(true);
    // --auto
    await call("PUT", "/api/config/workdays.holiday_calendars", { value: null });
    st = await call("GET", "/api/calendar/status");
    expect(st.body.holidays.mode).toBe("auto");
    // 稼働曜日（土曜も稼働）
    await call("PUT", "/api/config/workdays.weekdays", { value: [6, 1, 2, 3, 4, 5] });
    expect(
      (await call<{ value: unknown }>("GET", "/api/config/workdays.weekdays")).body.value,
    ).toEqual([1, 2, 3, 4, 5, 6]);
    const b = await call<BoardResponse>("GET", "/api/board?from=2026-09-19&to=2026-09-20");
    expect(b.body.days.map((d) => d.workday)).toEqual([true, false]);
    // 検証
    const bad = await call<{ error: string }>("PUT", "/api/config/workdays.weekdays", {
      value: [],
    });
    expect(bad).toMatchObject({ status: 400, body: { error: "invalid_value" } });
    const unknown = await call<{ error: string }>("PUT", "/api/config/nope", { value: 1 });
    expect(unknown).toMatchObject({ status: 404, body: { error: "unknown_key" } });
    // 壁打ちのフォルダ（D-135）: `~/` を展開する。ルート・浅すぎるフォルダは拒む
    const sd = await call("PUT", "/api/config/ai.scratch_dirs", { value: ["~/scratch/"] });
    expect(sd.status).toBe(200);
    expect(
      (await call<{ value: unknown }>("GET", "/api/config/ai.scratch_dirs")).body.value,
    ).toEqual([`${env.home}/scratch`]);
    for (const value of [["/"], ["/Users"], ["relative/dir"], ["/a/b/c", "/a/b/c"]])
      expect((await call("PUT", "/api/config/ai.scratch_dirs", { value })).status).toBe(400);
    const all = await call<{ values: Record<string, unknown> }>("GET", "/api/config");
    expect(all.body.values["workdays.holiday_calendars"]).toBeNull();
    expect(all.body.values["workdays.weekdays"]).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe("ヘルパとの接続（HelperBridge）", () => {
  function fakeSocket() {
    const sent: { id: number; method: string; params?: unknown }[] = [];
    let closed: number | null = null;
    return {
      sent,
      closed: () => closed,
      send(d: string) {
        sent.push(JSON.parse(d));
      },
      close(code?: number) {
        closed = code ?? 1000;
      },
    };
  }

  test("JSON-RPC の要求と応答、通知、壊れた要素の除外、切断で待ちを失敗させる", async () => {
    const b = new HelperBridge({ timeoutMs: 1000 });
    const events: string[] = [];
    b.subscribe((e) => events.push(e.type));
    expect(b.connected()).toBe(false);
    await expect(b.status()).rejects.toThrow("helper_not_connected");
    const ws = fakeSocket();
    b.attach(ws);
    expect(events).toEqual(["connected"]);
    const p = b.listCalendars();
    const req = ws.sent[0];
    expect(req).toMatchObject({ method: "listCalendars" });
    b.message(
      ws,
      JSON.stringify({
        jsonrpc: "2.0",
        id: req?.id,
        result: [calendars[0], { broken: true }],
      }),
    );
    expect((await p).map((c) => c.id)).toEqual(["ek-work"]);
    // エラー応答
    const p2 = b.fetchEvents({ calendarIds: ["x"], from: 0, to: 1 });
    b.message(
      ws,
      JSON.stringify({
        jsonrpc: "2.0",
        id: ws.sent[1]?.id,
        error: { code: 1, message: "no full access" },
      }),
    );
    await expect(p2).rejects.toThrow("no full access");
    // 通知
    b.message(ws, JSON.stringify({ jsonrpc: "2.0", method: "storeChanged" }));
    b.message(
      ws,
      JSON.stringify({
        jsonrpc: "2.0",
        method: "authorizationChanged",
        params: { authorization: "denied" },
      }),
    );
    // 新しい接続が来たら古い接続を閉じる。古い接続のメッセージは無視する
    const p3 = b.status();
    const ws2 = fakeSocket();
    b.attach(ws2);
    await expect(p3).rejects.toThrow("helper_replaced");
    expect(ws.closed()).toBe(4000);
    b.detach(ws); // 古い接続の close は無視
    expect(b.connected()).toBe(true);
    const p4 = b.status();
    b.detach(ws2);
    await expect(p4).rejects.toThrow("helper_disconnected");
    expect(events).toEqual([
      "connected",
      "storeChanged",
      "authorizationChanged",
      "connected",
      "disconnected",
    ]);
  });
});
