import { describe, expect, test } from "bun:test";
import {
  addDays,
  compactDate,
  isLocalDate,
  parseDayBoundary,
  toLocalDate,
  wallClock,
} from "../src/dates.ts";

const TOKYO = "Asia/Tokyo";
const NY = "America/New_York";

describe("toLocalDate", () => {
  // [説明, ISO 時刻, tz, 区切り(分), 期待する論理日付]
  const cases: [string, string, string, number, string][] = [
    ["東京 区切り前 03:59 は前日", "2026-01-01T18:59:00Z", TOKYO, 240, "2026-01-01"],
    ["東京 区切りちょうど 04:00 は当日", "2026-01-01T19:00:00Z", TOKYO, 240, "2026-01-02"],
    ["東京 正午", "2026-01-02T03:00:00Z", TOKYO, 240, "2026-01-02"],
    ["東京 23:59 は当日", "2026-01-02T14:59:00Z", TOKYO, 240, "2026-01-02"],
    ["東京 0:30 は前日", "2026-01-02T15:30:00Z", TOKYO, 240, "2026-01-02"],
    ["区切り 0:00 なら暦どおり", "2026-01-02T15:30:00Z", TOKYO, 0, "2026-01-03"],
    ["年をまたぐ前日", "2026-12-31T18:00:00Z", TOKYO, 240, "2026-12-31"],
    ["年をまたいだ当日", "2026-12-31T19:00:00Z", TOKYO, 240, "2027-01-01"],
    ["うるう日の正午", "2028-02-29T03:00:00Z", TOKYO, 240, "2028-02-29"],
    ["3/1 の 03:00 は 2/29", "2028-02-29T18:00:00Z", TOKYO, 240, "2028-02-29"],
    // 夏時間の開始日（2026-03-08 02:00 → 03:00）。壁時計 03:30 は区切り前
    ["NY 夏時間開始日 03:30", "2026-03-08T07:30:00Z", NY, 240, "2026-03-07"],
    ["NY 夏時間開始日 04:00", "2026-03-08T08:00:00Z", NY, 240, "2026-03-08"],
    // 夏時間の終了日（2026-11-01 02:00 → 01:00）。壁時計 03:59 は区切り前
    ["NY 夏時間終了日 03:59", "2026-11-01T08:59:00Z", NY, 240, "2026-10-31"],
    ["NY 夏時間終了日 04:00", "2026-11-01T09:00:00Z", NY, 240, "2026-11-01"],
  ];
  for (const [name, iso, tz, boundary, expected] of cases) {
    test(name, () => {
      expect(toLocalDate(Date.parse(iso), tz, boundary)).toBe(expected);
    });
  }

  test("区切りを省略すると 04:00", () => {
    expect(toLocalDate(Date.parse("2026-01-01T18:59:00Z"), TOKYO)).toBe("2026-01-01");
  });
});

describe("wallClock", () => {
  test("東京の壁時計", () => {
    expect(wallClock(Date.parse("2026-05-01T15:05:00Z"), TOKYO)).toEqual({
      year: 2026,
      month: 5,
      day: 2,
      hour: 0,
      minute: 5,
    });
  });
});

describe("parseDayBoundary", () => {
  test.each([
    ["04:00", 240],
    ["0:00", 0],
    ["23:59", 1439],
    ["5:30", 330],
  ])("%s → %d", (s, m) => {
    expect(parseDayBoundary(s)).toBe(m);
  });
  test.each(["24:00", "4", "04:60", "aa:bb", ""])("不正な値 %p は例外", (s) => {
    expect(() => parseDayBoundary(s)).toThrow();
  });
});

describe("addDays / isLocalDate / compactDate", () => {
  test.each([
    ["2026-01-31", 1, "2026-02-01"],
    ["2026-03-01", -1, "2026-02-28"],
    ["2028-03-01", -1, "2028-02-29"],
    ["2026-12-31", 1, "2027-01-01"],
    ["2026-01-10", -14, "2025-12-27"],
    ["2026-01-10", 0, "2026-01-10"],
  ])("%s %+d → %s", (d, n, e) => {
    expect(addDays(d, n)).toBe(e);
  });
  test("isLocalDate", () => {
    expect(isLocalDate("2026-02-28")).toBe(true);
    expect(isLocalDate("2026-02-29")).toBe(false);
    expect(isLocalDate("2026-2-1")).toBe(false);
    expect(isLocalDate("2026-13-01")).toBe(false);
  });
  test("compactDate", () => {
    expect(compactDate("2026-10-02")).toBe("20261002");
    expect(() => compactDate("2026/10/02")).toThrow();
  });
});
