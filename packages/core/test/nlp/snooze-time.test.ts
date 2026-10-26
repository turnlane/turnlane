/** スヌーズの「時刻を指定…」の入力（ux-mvp 4.6 の `s`） */
import { describe, expect, test } from "bun:test";
import { parseSnoozeTime } from "../../src/nlp/snooze-time.ts";

const TZ = "Asia/Tokyo";
const at = (iso: string) => Date.parse(`${iso}+09:00`);
// 2026-10-26（月）14:10 JST
const NOW = at("2026-10-26T14:10:00");
const ctx = { now: NOW, tz: TZ, dayBoundary: 240 };
const until = (raw: string, c = ctx) => {
  const r = parseSnoozeTime(raw, c);
  return r.ok ? r.until : r.error;
};

describe("parseSnoozeTime", () => {
  test.each([
    ["21:30", "2026-10-26T21:30:00"],
    ["9:00", "2026-10-27T09:00:00"], // 今日の 9:00 は過ぎているので明日
    ["14:10", "2026-10-27T14:10:00"], // 今と同じ時刻も明日
    ["14:11", "2026-10-26T14:11:00"],
    ["09:05", "2026-10-27T09:05:00"],
    ["明日 9:00", "2026-10-27T09:00:00"],
    ["明日9:00", "2026-10-27T09:00:00"],
    ["あした 23:59", "2026-10-27T23:59:00"],
    ["tomorrow 9:00", "2026-10-27T09:00:00"],
    ["Tomorrow  9:00", "2026-10-27T09:00:00"],
    ["今日 18:00", "2026-10-26T18:00:00"],
    ["today 18:00", "2026-10-26T18:00:00"],
    ["10/28 14:00", "2026-10-28T14:00:00"],
    ["12/1 0:00", "2026-12-01T00:00:00"],
    ["１０／２８　１４：００", "2026-10-28T14:00:00"], // 全角
  ])("%s → %s", (raw, iso) => {
    expect(until(raw)).toBe(at(iso));
  });

  test.each([
    ["今日 9:00"],
    ["today 14:10"],
    ["10/26 9:00"],
    ["10/25 18:00"],
    ["1/5 9:00"], // 来年には送らない
  ])("過去: %s", (raw) => {
    expect(until(raw)).toBe("past");
  });

  test.each([
    [""],
    ["  "],
    ["9"],
    ["9時"],
    ["24:00"],
    ["9:60"],
    ["2/30 9:00"],
    ["13/1 9:00"],
    ["明後日 9:00"],
    ["9:00 tomorrow"],
    ["abc"],
  ])("読めない: %j", (raw) => {
    expect(until(raw)).toBe("invalid");
  });

  test("深夜（日付区切りの前）の「明日」は論理日の次の日 = 同じ暦日。時刻だけはその日のその時刻", () => {
    // 2026-10-27（火）01:30 JST。論理日は 10/26
    const night = { now: at("2026-10-27T01:30:00"), tz: TZ, dayBoundary: 240 };
    expect(until("明日 9:00", night)).toBe(at("2026-10-27T09:00:00"));
    expect(until("9:00", night)).toBe(at("2026-10-27T09:00:00"));
    expect(until("1:00", night)).toBe(at("2026-10-28T01:00:00"));
    expect(until("今日 9:00", night)).toBe(at("2026-10-27T09:00:00"));
  });

  test("例外を投げない", () => {
    expect(parseSnoozeTime(undefined as unknown as string, ctx)).toEqual({
      ok: false,
      error: "invalid",
    });
  });
});
