import { describe, expect, test } from "bun:test";
import { validateConfig } from "../../src/config.ts";
import { dayStartMs } from "../../src/dates.ts";
import {
  parsePlannedTime,
  plannedHoursValue,
  plannedOn,
  readPlannedHours,
} from "../../src/plan/planned-hours.ts";
import { readSettings } from "../../src/settings.ts";

const H = 3_600_000;
const TZ = "Asia/Tokyo";

describe("計画上の勤務時間（D-062）", () => {
  test("既定は各曜日 10:00〜19:00、書いた曜日だけ上書き、壊れた値は既定", () => {
    const x = readPlannedHours({
      mon: { start: "09:30", end: "18:00" },
      tue: { start: "19:00", end: "10:00" },
      wed: "x",
    });
    expect(x[1]).toEqual({ startMin: 570, endMin: 1080 });
    expect([x[2], x[3], x[7]]).toEqual([
      { startMin: 600, endMin: 1140 },
      { startMin: 600, endMin: 1140 },
      { startMin: 600, endMin: 1140 },
    ]);
    expect(plannedHoursValue(x).mon).toEqual({ start: "09:30", end: "18:00" });
  });

  test.each([
    ["10:00", 600],
    ["9:05", 545],
    ["24:00", 1440],
    ["24:30", null],
    ["10:60", null],
    ["ab", null],
  ])("時刻 %s → %p", (s, want) => {
    expect(parsePlannedTime(s)).toBe(want);
  });

  test("日付に置く: 稼働日でない日は無し、24:00 は翌日の 0:00", () => {
    const hours = readPlannedHours({ fri: { start: "10:00", end: "24:00" } });
    const d = "2026-10-09"; // 金
    expect(plannedOn(d, hours, TZ, true)).toEqual({
      start: dayStartMs(d, TZ, 0) + 10 * H,
      end: dayStartMs("2026-10-10", TZ, 0),
    });
    expect(plannedOn("2026-10-10", hours, TZ, false)).toBeNull();
    // 判定できない（null）は稼働日として扱う
    expect(plannedOn("2026-10-08", hours, TZ, null)?.start).toBe(
      dayStartMs("2026-10-08", TZ, 0) + 10 * H,
    );
  });

  test("turnlane config の検証: 曜日のキーだけ、終了は開始より後", () => {
    expect(validateConfig("work_hours.planned", { mon: { start: "10:00", end: "19:00" } }).ok).toBe(
      true,
    );
    expect(validateConfig("work_hours.planned", { mon: { start: "19:00", end: "10:00" } }).ok).toBe(
      false,
    );
    expect(
      validateConfig("work_hours.planned", { monday: { start: "10:00", end: "19:00" } }).ok,
    ).toBe(false);
    expect(validateConfig("work_hours.planned", { sun: { start: "00:00", end: "24:00" } }).ok).toBe(
      true,
    );
  });

  test("設定に無ければ既定値", () => {
    const db = { select: () => ({}) } as never;
    expect(() => readSettings(db)).not.toThrow();
    expect(readSettings(db).plannedHours[1]).toEqual({ startMin: 600, endMin: 1140 });
  });
});
