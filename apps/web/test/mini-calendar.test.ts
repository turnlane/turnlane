/** 日付の見出しの小さなカレンダー（D-113 で後にした分。D-138）: 月の表・月の移動・稼働日でない日 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  addMonths,
  isOffDay,
  isoDow,
  monthGrid,
  shiftMonth,
} from "../src/components/MiniCalendar.tsx";

describe("月の表", () => {
  test("月曜はじまりで前後の月の日で埋める（2026年10月は木曜はじまり・5週）", () => {
    const g = monthGrid("2026-10");
    expect(g.length).toBe(5);
    expect(g[0]?.[0]).toBe("2026-09-28");
    expect(g[0]?.[3]).toBe("2026-10-01");
    expect(g.at(-1)?.at(-1)).toBe("2026-11-01");
    for (const w of g) expect(w.length).toBe(7);
  });
  test("月曜の1日で始まる月は前の月の日を入れない（2027年2月）", () => {
    const g = monthGrid("2027-02");
    expect(g[0]?.[0]).toBe("2027-02-01");
    expect(g.length).toBe(4);
  });
  test("6週になる月（2026年8月は土曜はじまり・31日）", () => {
    expect(monthGrid("2026-08").length).toBe(6);
  });
});

describe("月の移動", () => {
  test("年をまたぐ", () => {
    expect(addMonths("2026-12", 1)).toBe("2027-01");
    expect(addMonths("2026-01", -1)).toBe("2025-12");
  });
  test("月末は丸める（1/31 → 2/28、3/31 → 4/30）", () => {
    expect(shiftMonth("2027-01-31", 1)).toBe("2027-02-28");
    expect(shiftMonth("2026-03-31", 1)).toBe("2026-04-30");
    expect(shiftMonth("2026-10-09", -1)).toBe("2026-09-09");
  });
});

describe("稼働日でない日", () => {
  test("稼働曜日の外と祝日", () => {
    const wd = [1, 2, 3, 4, 5];
    const hol = new Set(["2026-10-12"]);
    expect(isoDow("2026-10-10")).toBe(6);
    expect(isOffDay("2026-10-10", wd, hol)).toBe(true);
    expect(isOffDay("2026-10-11", wd, hol)).toBe(true);
    expect(isOffDay("2026-10-12", wd, hol)).toBe(true);
    expect(isOffDay("2026-10-13", wd, hol)).toBe(false);
    // 土曜も働く設定
    expect(isOffDay("2026-10-10", [1, 2, 3, 4, 5, 6], hol)).toBe(false);
  });
});

test("日付の見出しは OS の日付の入力でなく小さなカレンダーを開く", () => {
  const shell = readFileSync(join(import.meta.dir, "../src/layout/AppShell.tsx"), "utf8");
  expect(shell).not.toContain('type="date"');
  expect(shell).toContain("<MiniCalendar");
});
