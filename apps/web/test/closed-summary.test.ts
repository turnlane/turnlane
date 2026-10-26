import { describe, expect, test } from "bun:test";
import type { ClosedTodayRow } from "@turnlane/core/web";
import { closedInOrder, closedSummary, median } from "../src/day/closed-summary.ts";

type Row = Pick<ClosedTodayRow, "kind" | "via" | "responseMs">;
const MIN = 60_000;

describe("closedSummary（デイビューの今日閉じたものの要約の行）", () => {
  test("種類ごとの件数（返答済みは閉じ方ごと）。0 の種類は出さず、並びは 返答済み → 解決 → 対応不要 → 期限切れ", () => {
    const rows: Row[] = [
      { kind: "expired", via: null, responseMs: null },
      { kind: "replied", via: "approve", responseMs: 2 * MIN },
      { kind: "not_needed", via: null, responseMs: null },
      { kind: "replied", via: "reply", responseMs: 8 * MIN },
      { kind: "replied", via: "approve", responseMs: 4 * MIN },
      { kind: "not_needed", via: null, responseMs: null },
    ];
    const s = closedSummary(rows);
    expect(s.total).toBe(6);
    expect(s.parts).toEqual([
      { key: "turn.closedVia.reply", count: 1 },
      { key: "turn.closedVia.approve", count: 2 },
      { key: "day.closed.not_needed", count: 2 },
      { key: "day.closed.expired", count: 1 },
    ]);
    // 中央値は人が応えた行だけ（2m・4m・8m → 4m）
    expect(s.medianMs).toBe(4 * MIN);
  });

  test("閉じ方の無い返答済みは「完了」、応答時間が無ければ中央値は null", () => {
    const s = closedSummary([
      { kind: "replied", via: null, responseMs: null },
      { kind: "resolved", via: null },
    ]);
    expect(s.parts).toEqual([
      { key: "day.closed.replied", count: 1 },
      { key: "day.closed.resolved", count: 1 },
    ]);
    expect(s.medianMs).toBeNull();
  });

  test("median は偶数件なら真ん中の 2 つの平均", () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(3);
  });

  test("一覧の行は種類の順（同じ種類の中は閉じた順のまま）", () => {
    const rows = [
      { kind: "expired" as const, id: "a" },
      { kind: "replied" as const, id: "b" },
      { kind: "resolved" as const, id: "c" },
      { kind: "replied" as const, id: "d" },
    ];
    expect(closedInOrder(rows).map((r) => r.id)).toEqual(["b", "d", "c", "a"]);
  });
});
