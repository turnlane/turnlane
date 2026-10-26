import { describe, expect, test } from "bun:test";
import { wallToEpoch } from "../../src/dates.ts";
import { clip, placeLanes } from "../../src/layout/lanes.ts";

const MIN = 60_000;
const H = 60 * MIN;
/** 1時間 44px（週ボードの既定） */
const PX = 44 / H;
const at = (hh: number, mm = 0) => hh * H + mm * MIN;
const opts = { axisStart: 0, pxPerMs: PX, maxColumns: Number.POSITIVE_INFINITY };

describe("placeLanes（m2-api.md 5章）", () => {
  test("8:50–8:58、8:58–9:06、9:06–9:31 は最小 16px で重なるので横に並べ、開始位置は実時刻（デイビューの D2。週ボードはまとめ表示 W4 で me-lane.ts）", () => {
    const r = placeLanes(
      [
        { id: "a", start: at(8, 50), end: at(8, 58), minPx: 16 },
        { id: "b", start: at(8, 58), end: at(9, 6), minPx: 16 },
        { id: "c", start: at(9, 6), end: at(9, 31), minPx: 16 },
      ],
      opts,
    );
    expect(r.placed.map((p) => [p.id, p.column, p.columns])).toEqual([
      ["a", 0, 3],
      ["b", 1, 3],
      ["c", 2, 3],
    ]);
    expect(r.placed[0]?.top).toBeCloseTo(at(8, 50) * PX);
    expect(r.placed[0]?.height).toBe(16);
    expect(r.placed[2]?.height).toBeCloseTo(25 * MIN * PX);
    expect(r.overflow).toEqual([]);
  });

  test("D2: 重なる2つは2列、後から空いた列を使い回す。重ならないものは1列", () => {
    const r = placeLanes(
      [
        { id: "a", start: at(10), end: at(11), minPx: 16 },
        { id: "b", start: at(10, 30), end: at(10, 45), minPx: 16 },
        { id: "c", start: at(10, 55), end: at(11, 10), minPx: 16 },
        { id: "d", start: at(12), end: at(13), minPx: 16 },
      ],
      opts,
    );
    expect(r.placed.map((p) => [p.id, p.column, p.columns])).toEqual([
      ["a", 0, 2],
      ["b", 1, 2],
      ["c", 1, 2],
      ["d", 0, 1],
    ]);
  });

  test("AI 4並列 → 3列と +1（maxColumns 3）", () => {
    const r = placeLanes(
      ["a", "b", "c", "d"].map((id, i) => ({
        id,
        start: at(9, i),
        end: at(10),
        minPx: 20,
      })),
      { ...opts, maxColumns: 3 },
    );
    expect(r.placed.map((p) => [p.id, p.column, p.columns])).toEqual([
      ["a", 0, 3],
      ["b", 1, 3],
      ["c", 2, 3],
    ]);
    expect(r.overflow).toHaveLength(1);
    expect(r.overflow[0]?.hidden).toEqual(["d"]);
  });

  test("短い AI 項目は最小 20px（1行）", () => {
    const r = placeLanes([{ id: "a", start: at(13), end: at(13, 4), minPx: 20 }], {
      ...opts,
      maxColumns: 3,
    });
    expect(r.placed[0]).toMatchObject({ height: 20, column: 0, columns: 1 });
  });

  test("日付区切りをまたぐ区間は時間軸の範囲で切り取る", () => {
    const axis = { start: at(4), end: at(28) };
    expect(clip({ start: at(2), end: at(5) }, axis)).toEqual({ start: at(4), end: at(5) });
    expect(clip({ start: at(27), end: at(30) }, axis)).toEqual({ start: at(27), end: at(28) });
    expect(clip({ start: at(1), end: at(3) }, axis)).toBeNull();
  });

  test("DST の日（23時間）でも位置は実時刻の差で決まる", () => {
    const tz = "America/New_York";
    const axisStart = wallToEpoch(2026, 3, 8, 4 * 60, tz);
    const nine = wallToEpoch(2026, 3, 8, 9 * 60, tz);
    const r = placeLanes([{ id: "a", start: nine, end: nine + H, minPx: 16 }], {
      ...opts,
      axisStart,
    });
    // 2:00 が飛ぶのは日付区切り（4:00）より前なので、4:00〜9:00 は 5時間
    expect(r.placed[0]?.top).toBeCloseTo(5 * 44);
  });
});
