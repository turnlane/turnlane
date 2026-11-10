/** 「過去から N 件」（0.8.2）の件数と、過去の日付のタスクの変化で今日のボード・デイビューを読み直すこと */
import { describe, expect, test } from "bun:test";
import { pastCount } from "../src/board/PastRemaining.tsx";
import { shouldInvalidate } from "../src/data/invalidate.ts";

const TODAY = "2026-11-11";

describe("過去から N 件", () => {
  test("件数は日付ごとのタスクの和。無ければ 0", () => {
    expect(pastCount(undefined)).toBe(0);
    expect(pastCount([])).toBe(0);
    const t = { id: "x" } as never;
    expect(
      pastCount([
        { date: "2026-11-10", tasks: [t, t] },
        { date: "2026-10-01", tasks: [t] },
      ]),
    ).toBe(3);
  });

  test("今日より前の日付のタスクが変われば、今日を含むボード・デイビューを読み直す（含まないものは読み直さない）", () => {
    const old = { dates: ["2026-09-01"] };
    expect(shouldInvalidate(["day", TODAY], "task", old, TODAY)).toBe(true);
    expect(shouldInvalidate(["board", "2026-11-10", "2026-11-12"], "task", old, TODAY)).toBe(true);
    expect(shouldInvalidate(["day", "2026-11-20"], "task", old, TODAY)).toBe(false);
    expect(shouldInvalidate(["board", "2026-11-16", "2026-11-22"], "task", old, TODAY)).toBe(false);
  });
});
