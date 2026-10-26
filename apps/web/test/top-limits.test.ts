/** 今日の列の上部に出す件数（B-2。D-193）: 時間軸に 240px を残す分だけ出し、未定 → 帯の順に減らす */
import { describe, expect, test } from "bun:test";
import { topLimits } from "../src/board/top-limits.ts";

describe("上部の件数（B-2）", () => {
  test("高さが十分なら帯 3 件・未定 3 件（それより少なければ件数どおり）", () => {
    expect(topLimits(900, { band: 5, unscheduled: 6 })).toEqual({ band: 3, unscheduled: 3 });
    expect(topLimits(900, { band: 1, unscheduled: 2 })).toEqual({ band: 1, unscheduled: 2 });
    expect(topLimits(900, { band: 0, unscheduled: 0 })).toEqual({ band: 0, unscheduled: 0 });
  });

  test("足りなければ未定を 3 → 2 → 1 に減らし、それでも足りなければ帯を 3 → 2 → 1 に。1 件は必ず見せる", () => {
    // 600px: 上部の予算 240px。帯 3 件 + 未定 3 件（172 + 164 = 336）は入らない → 未定を 1 件まで減らし、
    // 帯 3 件 + 未定 1 件（172 + 92 = 264）も入らない → 帯を 2 件に（帯の行は 2 行の高さで見積もる。D-207）
    expect(topLimits(600, { band: 5, unscheduled: 6 })).toEqual({ band: 2, unscheduled: 1 });
    // 480px: 予算 120px → 未定 1 件（92）に帯は入らない → 帯も減らすが 1 件は残す
    expect(topLimits(480, { band: 5, unscheduled: 6 })).toEqual({ band: 1, unscheduled: 1 });
    expect(topLimits(100, { band: 5, unscheduled: 6 })).toEqual({ band: 1, unscheduled: 1 });
  });
});
