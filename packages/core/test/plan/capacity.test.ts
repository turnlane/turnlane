import { describe, expect, test } from "bun:test";
import { type CapacityInput, capacity, freeSlots, planWindow } from "../../src/plan/capacity.ts";

const H = 3_600_000;
const M = 60_000;
/** その日の 0:00 を 0 とした時刻 */
const h = (x: number) => x * H;

const base: CapacityInput = {
  phase: "future",
  now: h(10),
  planned: { start: h(10), end: h(19) },
  workday: null,
  busy: [],
  estimates: [],
};

describe("容量（m2-api.md 9.1、D-047 (1)・D-049・D-062・D-106）", () => {
  test.each([
    {
      name: "未来: 計画の目安 − busy な予定（重なりは1回）",
      i: {
        busy: [
          { start: h(10), end: h(11) },
          { start: h(10.5), end: h(12) },
        ],
      },
      want: { freeMs: h(7), plannedMs: 0, plannedUnestimated: 0 },
    },
    {
      name: "未来: 計画の目安の外の予定は引かない",
      i: {
        busy: [
          { start: h(7), end: h(10.5) },
          { start: h(20), end: h(21) },
        ],
      },
      want: { freeMs: h(8.5), plannedMs: 0, plannedUnestimated: 0 },
    },
    {
      name: "Free は15分単位に切り捨てる（D-062）",
      i: { busy: [{ start: h(12), end: h(12) + 7 * M }] },
      want: { freeMs: h(8.75), plannedMs: 0, plannedUnestimated: 0 },
    },
    {
      name: "未来の稼働日でない日は Free を出さない（D-049 (2)）",
      i: { workday: false },
      want: { freeMs: 0, plannedMs: 0, plannedUnestimated: 0 },
    },
    {
      name: "未来: 計画の無い日（稼働日でない）は 0",
      i: { planned: null },
      want: { freeMs: 0, plannedMs: 0, plannedUnestimated: 0 },
    },
    {
      name: "見積なしは30分とみなし件数を返す（D-047 (1)）",
      i: { estimates: [45, null, 15, null] },
      want: { freeMs: h(9), plannedMs: 2 * H, plannedUnestimated: 2 },
    },
    {
      name: "今日: 計画の目安と [今, 終わり] の重なり（D-106）",
      i: { phase: "today" as const, now: h(13) },
      want: { freeMs: h(6), plannedMs: 0, plannedUnestimated: 0 },
    },
    {
      name: "今日: 計画の開始より前なら計画の開始から",
      i: { phase: "today" as const, now: h(8) },
      want: { freeMs: h(9), plannedMs: 0, plannedUnestimated: 0 },
    },
    {
      name: "今日: 計画の終わりを過ぎたら 0（作業を続けていても延ばさない）",
      i: { phase: "today" as const, now: h(20) },
      want: { freeMs: 0, plannedMs: 0, plannedUnestimated: 0 },
    },
    {
      name: "今日: 今より前の予定は引かない",
      i: { phase: "today" as const, now: h(13), busy: [{ start: h(11), end: h(14) }] },
      want: { freeMs: h(5), plannedMs: 0, plannedUnestimated: 0 },
    },
    {
      name: "今日が稼働日でない（計画なし）は 0",
      i: { phase: "today" as const, workday: false, planned: null, now: h(12) },
      want: { freeMs: 0, plannedMs: 0, plannedUnestimated: 0 },
    },
    {
      name: "過去は 0（UI は出さない）",
      i: { phase: "past" as const, estimates: [30] },
      want: { freeMs: 0, plannedMs: 0, plannedUnestimated: 0 },
    },
    {
      name: "予定が窓より長くても 0 未満にしない",
      i: { busy: [{ start: h(0), end: h(24) }] },
      want: { freeMs: 0, plannedMs: 0, plannedUnestimated: 0 },
    },
  ])("$name", ({ i, want }) => {
    expect(capacity({ ...base, ...i })).toEqual(want);
  });

  test("計画の窓（D-106）", () => {
    expect(planWindow({ ...base, phase: "today", now: h(13) })).toEqual({
      start: h(13),
      end: h(19),
    });
    expect(planWindow({ ...base, phase: "today", now: h(7) })).toEqual({
      start: h(10),
      end: h(19),
    });
    expect(planWindow({ ...base, phase: "today", now: h(19) })).toBeNull();
    expect(planWindow({ ...base, phase: "future" })).toEqual({ start: h(10), end: h(19) });
    expect(planWindow({ ...base, phase: "past" })).toBeNull();
  });
});

describe("freeSlots（デイビューの空き枠）", () => {
  const H = 3_600_000;
  const M = 60_000;
  const base = Date.UTC(2026, 9, 2, 0, 0);
  const w = { start: base + 9 * H, end: base + 18 * H };
  test("予定と時間ブロックを引き、15分単位（始まりは切り上げ・終わりは切り捨て）", () => {
    const taken = [
      { start: base + 10 * H, end: base + 10 * H + 30 * M },
      { start: base + 10 * H + 20 * M, end: base + 12 * H + 5 * M },
      { start: base + 14 * H, end: base + 15 * H + 45 * M },
    ];
    expect(freeSlots(w, taken)).toEqual([
      { start: base + 9 * H, end: base + 10 * H },
      { start: base + 12 * H + 15 * M, end: base + 14 * H },
      { start: base + 15 * H + 45 * M, end: base + 18 * H },
    ]);
  });
  test("from より前は出さず、15分未満は出さない。窓が無ければ空", () => {
    const taken = [{ start: base + 13 * H + 30 * M, end: base + 17 * H + 50 * M }];
    expect(freeSlots(w, taken, base + 13 * H + 20 * M)).toEqual([]);
    expect(freeSlots(w, [], base + 13 * H + 20 * M)).toEqual([
      { start: base + 13 * H + 30 * M, end: base + 18 * H },
    ]);
    expect(freeSlots(null, [])).toEqual([]);
  });
});
