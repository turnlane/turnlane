/** 祝日カレンダーの判定（M3-6。phase0-plan 4.5、D-044 (3)） */
import { describe, expect, test } from "bun:test";
import {
  detectHolidayCalendars,
  groupHolidaySources,
  type HolidayCalendarFact,
  type HolidayEventFact,
  holidayDates,
  resolveHolidayCalendars,
} from "../../src/calendar/holidays.ts";

const cal = (id: string, p: Partial<HolidayCalendarFact> = {}): HolidayCalendarFact => ({
  id,
  isWritable: false,
  type: "subscription",
  ...p,
});
const day = (calendarId: string, start: string, end: string, title = "Day"): HolidayEventFact => ({
  calendarId,
  allDay: true,
  startDate: start,
  endDate: end,
  title,
});
const timed = (calendarId: string): HolidayEventFact => ({
  calendarId,
  allDay: false,
  startDate: null,
  endDate: null,
  title: "Meeting",
});

describe("detectHolidayCalendars", () => {
  test.each<[string, HolidayCalendarFact[], HolidayEventFact[], string[]]>([
    [
      "書き込み不可・終日・1日だけ → 採用",
      [cal("h")],
      [day("h", "2026-10-12", "2026-10-13"), day("h", "2026-11-03", "2026-11-04")],
      ["h"],
    ],
    [
      "書き込み可は採用しない",
      [cal("w", { isWritable: true })],
      [day("w", "2026-10-12", "2026-10-13")],
      [],
    ],
    [
      "誕生日カレンダーは採用しない",
      [cal("b", { type: "birthday" })],
      [day("b", "2026-10-12", "2026-10-13")],
      [],
    ],
    [
      "種類が分からない（ヘルパ未接続）は採用しない",
      [cal("u", { type: null })],
      [day("u", "2026-10-12", "2026-10-13")],
      [],
    ],
    ["窓内に予定が無いと採用しない", [cal("h")], [], []],
    [
      "時刻付きの予定が混ざると採用しない",
      [cal("h")],
      [day("h", "2026-10-12", "2026-10-13"), timed("h")],
      [],
    ],
    [
      "複数日の予定が1割を超えると採用しない（共有の休暇カレンダーなど）",
      [cal("v")],
      [
        day("v", "2026-10-12", "2026-10-13"),
        day("v", "2026-10-14", "2026-10-18"),
        day("v", "2026-10-20", "2026-10-21"),
      ],
      [],
    ],
    [
      "9割以上が1日なら採用（10件中1件が2日）",
      [cal("h")],
      [
        ...Array.from({ length: 9 }, (_, i) =>
          day(
            "h",
            `2026-10-${String(10 + i).padStart(2, "0")}`,
            `2026-10-${String(11 + i).padStart(2, "0")}`,
          ),
        ),
        day("h", "2026-10-25", "2026-10-27"),
      ],
      ["h"],
    ],
    [
      "macOS と Google の祝日カレンダーが両方該当したら両方",
      [cal("mac"), cal("google", { type: "calDAV" })],
      [day("mac", "2026-10-12", "2026-10-13"), day("google", "2026-10-12", "2026-10-13")],
      ["google", "mac"],
    ],
  ])("%s", (_n, cals, events, want) => {
    expect(detectHolidayCalendars(cals, events)).toEqual(want);
  });
});

describe("resolveHolidayCalendars", () => {
  const cals = [cal("h")];
  const events = [day("h", "2026-10-12", "2026-10-13")];
  test("null は自動", () =>
    expect(resolveHolidayCalendars(null, cals, events)).toEqual({ mode: "auto", ids: ["h"] }));
  test("[] は祝日なし", () =>
    expect(resolveHolidayCalendars([], cals, events)).toEqual({ mode: "none", ids: [] }));
  test("配列は手動（自動判定しない）", () =>
    expect(resolveHolidayCalendars(["x"], cals, events)).toEqual({ mode: "manual", ids: ["x"] }));
});

test("holidayDates: 終日予定の start_date〜end_date（終わりを含まない）、時刻付きは無視", () => {
  const m = holidayDates(
    [
      day("h", "2026-10-12", "2026-10-13", "Sports Day"),
      day("h", "2026-12-29", "2027-01-01", "Year-end"),
      timed("h"),
      day("other", "2026-10-20", "2026-10-21"),
    ],
    ["h"],
  );
  expect([...m.entries()]).toEqual([
    ["2026-10-12", "Sports Day"],
    ["2026-12-29", "Year-end"],
    ["2026-12-30", "Year-end"],
    ["2026-12-31", "Year-end"],
  ]);
});

test("groupHolidaySources: 同じ名前は1つにまとめて件数を数える（D-057 (2)）。順序は最初に現れた順", () => {
  expect(
    groupHolidaySources([
      { name: "日本の祝日" },
      { name: "US Holidays" },
      { name: "日本の祝日" },
      { name: "日本の祝日" },
    ]),
  ).toEqual([
    { name: "日本の祝日", count: 3 },
    { name: "US Holidays", count: 1 },
  ]);
  expect(groupHolidaySources([])).toEqual([]);
});
