/** カレンダーの一時的な表示・非表示（Issue #5）: 設定の値の読み方、予定の外し方、ポップオーバーの並び */
import { describe, expect, test } from "bun:test";
import { hiddenOf, withoutCalendar } from "../src/data/calendar-visibility.ts";
import { groupByAccount } from "../src/layout/CalendarsButton.tsx";

describe("calendar.hidden", () => {
  test("文字列の配列だけを読む", () => {
    expect(hiddenOf({ "calendar.hidden": ["a", 1, "b"] })).toEqual(["a", "b"]);
    expect(hiddenOf({})).toEqual([]);
    expect(hiddenOf(undefined)).toEqual([]);
  });
  test("そのカレンダーの予定だけを外す", () => {
    const xs = [
      { id: "1", calendarId: "a" },
      { id: "2", calendarId: "b" },
    ];
    expect(withoutCalendar(xs, "a").map((x) => x.id)).toEqual(["2"]);
  });
  test("ポップオーバーはアカウントごと（最初に出た順。中の並びはそのまま）", () => {
    const g = groupByAccount([
      { id: "w", account: "work@example.com" },
      { id: "h", account: null },
      { id: "t", account: "work@example.com" },
    ]);
    expect(g.map((x) => [x.account, x.items.map((i) => i.id)])).toEqual([
      ["work@example.com", ["w", "t"]],
      [null, ["h"]],
    ]);
  });
});
