import { describe, expect, test } from "bun:test";
import { placeCandidates } from "../../src/plan/place-candidates.ts";

const H = 3_600_000;
const M = 60_000;
const at = (h: number, m = 0) => Date.UTC(2026, 9, 5, h, m);

describe("placeCandidates", () => {
  test("枠の先頭と1時間ずつ後ろ。入らない枠は飛ばす", () => {
    const slots = [
      { start: at(10), end: at(10, 20) }, // 20分: 30分は入らない
      { start: at(11), end: at(13) },
      { start: at(15), end: at(15, 30) },
    ];
    expect(placeCandidates(slots, 30 * M, null)).toEqual([
      { start: at(11), end: at(11, 30) },
      { start: at(12), end: at(12, 30) },
      { start: at(15), end: at(15, 30) },
    ]);
  });

  test("今日は now より後を15分単位に切り上げる", () => {
    const slots = [{ start: at(10), end: at(12) }];
    expect(placeCandidates(slots, H, at(10, 7))).toEqual([{ start: at(10, 15), end: at(11, 15) }]);
  });

  test("最大件数と1枠あたりの件数", () => {
    const slots = [{ start: at(0), end: at(23) }];
    expect(placeCandidates(slots, 30 * M, null)).toHaveLength(3);
    const many = Array.from({ length: 6 }, (_, i) => ({ start: at(i * 2), end: at(i * 2 + 2) }));
    expect(placeCandidates(many, 30 * M, null)).toHaveLength(9);
  });

  test("空き枠が無ければ空", () => {
    expect(placeCandidates([], 30 * M, null)).toEqual([]);
  });
});
