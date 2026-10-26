/** 稼働日（M3-6。phase0-plan 4.5、D-040）の表駆動テスト */
import { describe, expect, test } from "bun:test";
import {
  boardPrevDay,
  carryTarget,
  DEFAULT_WORKDAYS,
  isoWeekday,
  isWorkday,
  nextWorkday,
  prevWorkday,
  skippedDays,
  type WorkdayRule,
} from "../../src/date/workdays.ts";

const rule = (holidays: string[] = [], weekdays = DEFAULT_WORKDAYS): WorkdayRule => ({
  weekdays,
  holidays: new Set(holidays),
});

describe("isoWeekday", () => {
  test.each([
    ["2026-10-05", 1], // 月
    ["2026-10-09", 5], // 金
    ["2026-10-10", 6], // 土
    ["2026-10-11", 7], // 日
  ])("%s → %d", (d, w) => expect(isoWeekday(d)).toBe(w));

  test("不正な日付は例外", () => expect(() => isoWeekday("2026-02-30")).toThrow());
});

describe("nextWorkday", () => {
  test.each<[string, string, WorkdayRule, string | null]>([
    ["金曜 → 月曜", "2026-10-09", rule(), "2026-10-12"],
    ["木曜 → 金曜", "2026-10-08", rule(), "2026-10-09"],
    ["土曜 → 月曜", "2026-10-10", rule(), "2026-10-12"],
    ["祝日の月曜 → 火曜", "2026-10-09", rule(["2026-10-12"]), "2026-10-13"],
    [
      "連休（月〜水が祝日）→ 木曜",
      "2026-10-09",
      rule(["2026-10-12", "2026-10-13", "2026-10-14"]),
      "2026-10-15",
    ],
    ["祝日の前日（水曜。木曜が祝日）→ 金曜", "2026-10-07", rule(["2026-10-08"]), "2026-10-09"],
    ["祝日カレンダーなし: 金曜 → 月曜", "2026-10-09", rule([]), "2026-10-12"],
    [
      "稼働曜日の変更（日〜木）: 木曜 → 日曜",
      "2026-10-08",
      rule([], [7, 1, 2, 3, 4]),
      "2026-10-11",
    ],
    [
      "稼働曜日の変更（土曜も稼働）: 金曜 → 土曜",
      "2026-10-09",
      rule([], [1, 2, 3, 4, 5, 6]),
      "2026-10-10",
    ],
    ["週末の祝日は影響しない", "2026-10-09", rule(["2026-10-10"]), "2026-10-12"],
    // 窓（7日前〜21日後）の外は祝日の集合に入らない = 祝日なしとして扱う
    ["窓の外: 集合に無い日は稼働日", "2027-01-08", rule(["2026-10-12"]), "2027-01-11"],
    ["稼働曜日が空なら null", "2026-10-09", rule([], []), null],
    ["年またぎ", "2026-12-31", rule(["2027-01-01"]), "2027-01-04"],
  ])("%s", (_name, date, r, want) => {
    expect(nextWorkday(date, r)).toBe(want);
  });
});

describe("prevWorkday（D-074）", () => {
  test.each<[string, string, WorkdayRule, string | null]>([
    ["月曜 → 金曜", "2026-10-12", rule(), "2026-10-09"],
    ["火曜 → 月曜", "2026-10-13", rule(), "2026-10-12"],
    ["日曜 → 金曜", "2026-10-11", rule(), "2026-10-09"],
    ["祝日の月曜の翌日（火曜）→ 金曜", "2026-10-13", rule(["2026-10-12"]), "2026-10-09"],
    ["稼働曜日が空なら null", "2026-10-09", rule([], []), null],
    ["年またぎ", "2027-01-04", rule(["2027-01-01"]), "2026-12-31"],
  ])("%s", (_name, date, r, want) => {
    expect(prevWorkday(date, r)).toBe(want);
  });
});

describe("isWorkday", () => {
  test.each<[string, WorkdayRule, boolean]>([
    ["2026-10-09", rule(), true],
    ["2026-10-10", rule(), false],
    ["2026-10-12", rule(["2026-10-12"]), false],
    ["2026-10-10", rule([], [6]), true],
  ])("%s", (d, r, want) => expect(isWorkday(d, r)).toBe(want));
});

test("skippedDays は飛ばした日と理由を返す（持ち越しの理由を日報に出すため）", () => {
  expect(skippedDays("2026-10-10", "2026-10-12", rule(["2026-10-12"]))).toEqual([
    { date: "2026-10-10", reason: "weekday" },
    { date: "2026-10-11", reason: "weekday" },
    { date: "2026-10-12", reason: "holiday" },
  ]);
});

test("carryTarget: 次の稼働日と、その間で飛ばした祝日（週末は理由に入れない）", () => {
  const names = new Map([["2026-10-12", "Sports Day"]]);
  expect(carryTarget("2026-10-09", rule(["2026-10-12"]), names)).toEqual({
    to: "2026-10-13",
    skippedHolidays: [{ date: "2026-10-12", name: "Sports Day" }],
  });
  expect(carryTarget("2026-10-08", rule())).toEqual({ to: "2026-10-09", skippedHolidays: [] });
  expect(carryTarget("2026-10-09", rule([], []))).toEqual({
    to: "2026-10-10",
    skippedHolidays: [],
  });
});

describe("boardPrevDay（3日ボードの左の列。D-076）", () => {
  // 2026-10-05 は月曜。2026-10-12 は月曜（体育の日として祝日にする）
  test.each<[string, string, string[], string | null, string]>([
    ["月曜に日曜の作業あり → 日曜", "2026-10-05", [], "2026-10-04", "2026-10-04"],
    ["月曜に土曜の作業あり → 土曜", "2026-10-05", [], "2026-10-03", "2026-10-03"],
    ["月曜に作業日なし → 金曜", "2026-10-05", [], null, "2026-10-02"],
    [
      "月曜、直近の作業が木曜（金曜は休んだ）→ 金曜（前の稼働日の方が新しい）",
      "2026-10-05",
      [],
      "2026-10-01",
      "2026-10-02",
    ],
    ["月曜、直近の作業が金曜 → 金曜", "2026-10-05", [], "2026-10-02", "2026-10-02"],
    [
      "祝日明けの火曜、祝日の作業なし → 金曜",
      "2026-10-13",
      ["2026-10-12"],
      "2026-10-09",
      "2026-10-09",
    ],
    [
      "祝日明けの火曜、祝日に作業 → 祝日の月曜",
      "2026-10-13",
      ["2026-10-12"],
      "2026-10-12",
      "2026-10-12",
    ],
    ["祝日明けの火曜、日曜に作業 → 日曜", "2026-10-13", ["2026-10-12"], "2026-10-11", "2026-10-11"],
    ["土曜（非稼働日）を基準、金曜の作業 → 金曜", "2026-10-10", [], "2026-10-09", "2026-10-09"],
    ["基準日以降の作業は数えない", "2026-10-05", [], "2026-10-05", "2026-10-02"],
  ])("%s", (_, around, hol, worked, want) =>
    expect(boardPrevDay(around, rule(hol), worked)).toBe(want),
  );

  test("稼働曜日が空なら前日と作業日の新しい方", () => {
    expect(boardPrevDay("2026-10-05", rule([], []), null)).toBe("2026-10-04");
    expect(boardPrevDay("2026-10-05", rule([], []), "2026-10-01")).toBe("2026-10-04");
  });
});
