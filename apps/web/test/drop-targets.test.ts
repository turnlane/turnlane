/** DnD の残り（M2-17・M2-18）と週ボードの仕上げ（M2-16）の純粋な部分 */
import { describe, expect, test } from "bun:test";
import { type DragItem, type DropData, forbiddenDrop } from "../src/board/dnd.tsx";
import { HOUR_PX } from "../src/board/geometry.ts";
import { offscreenAi } from "../src/board/overlays.tsx";

const H = 3_600_000;
const MIN = 60_000;

describe("落とせる所（ux-mvp 7章）", () => {
  const today = "2026-10-02";
  const ai: DragItem = { kind: "ai", workItemId: "w1", title: "x", grabOffsetMs: 0 };
  const turn: DragItem = {
    kind: "turn",
    followUpId: "f1",
    taskId: "t1",
    taskDate: today,
    title: "Reply",
    block: null,
    grabOffsetMs: 0,
  };
  const grid = (date: string): DropData => ({
    kind: "grid",
    date,
    axis: { start: 0, end: 24 * H },
    busy: [],
  });
  test.each<[string, DragItem, DropData | null, boolean]>([
    ["AI → 自分レーン", ai, grid(today), false],
    ["AI → 未来の自分レーン", ai, grid("2026-10-05"), false],
    ["AI → 日付カラム（禁止）", ai, { kind: "date", date: "2026-10-05" }, true],
    ["AI → Inbox（禁止）", ai, { kind: "inbox" }, true],
    ["AI → 別の AI カード（統合）", ai, { kind: "ai", workItemId: "w2", title: null }, false],
    ["AI → 自分自身", ai, { kind: "ai", workItemId: "w1", title: null }, true],
    ["自分の番 → 今日の時間軸", turn, grid(today), false],
    ["自分の番 → 昨日の時間軸（不可）", turn, grid("2026-10-01"), true],
    ["自分の番 → 未来の日付", turn, { kind: "date", date: "2026-10-05" }, false],
    ["自分の番 → 今日の日付（何もしない）", turn, { kind: "date", date: today }, true],
    ["自分の番 → Inbox（不可）", turn, { kind: "inbox" }, true],
    ["どこにも無い", ai, null, false],
  ])("%s", (_, a, over, want) => {
    expect(forbiddenDrop(a, over, today)).toBe(want);
  });
});

describe("範囲外のヒント（M2-16）", () => {
  const axisStart = 0;
  // 44px / 時間。見えている範囲は 8:00〜18:00
  const view = { top: 8 * 44, bottom: 18 * 44 };
  test("上と下を数える（B-9: 夜間かどうかは見ない）", () => {
    const r = offscreenAi(
      [
        { start: 1 * H, end: 1 * H + 20 * MIN },
        { start: 2 * H, end: 3 * H },
        { start: 10 * H, end: 11 * H },
        { start: 18 * H + 30 * MIN, end: 19 * H },
      ],
      axisStart,
      view,
    );
    expect(r.above).toMatchObject({ count: 2 });
    expect(r.above?.targetY).toBe(2 * HOUR_PX);
    expect(r.below).toMatchObject({ count: 1 });
  });
  test("最小 20px で一部でも見えていれば数えない", () => {
    const r = offscreenAi([{ start: 8 * H - 5 * MIN, end: 8 * H - 4 * MIN }], axisStart, view);
    expect(r.above).toBeNull();
  });
});
