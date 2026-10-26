import { describe, expect, test } from "bun:test";
import type {
  BoardResponse,
  DayColumn,
  DayTotals,
  TaskView,
  TimeBlockView,
} from "../../src/api/board.ts";
import {
  findBlock,
  patchBlockInBoard,
  placeTaskInBoard,
  removeBlockFromBoard,
} from "../../src/api/optimistic.ts";
import { dayStartMs } from "../../src/dates.ts";
import {
  blockDurationMs,
  busyOverlapMs,
  dayDiff,
  dropRange,
  neighborsFor,
  plannedWith,
  resizeEnd,
  selectRange,
  shiftByDays,
  snapMs,
} from "../../src/plan/dnd.ts";

const H = 3_600_000;
const M = 60_000;
const axis = { start: 0, end: 24 * H };
const h = (x: number) => x * H;

describe("ドラッグの計算（M2-17・M2-18、ux-mvp 7章）", () => {
  test("ブロックの長さは見積、無いか 0 なら30分", () => {
    expect([blockDurationMs(45), blockDurationMs(null), blockDurationMs(0)]).toEqual([
      45 * M,
      30 * M,
      30 * M,
    ]);
  });

  test.each([
    { t: h(10) + 7 * M, step: 15, want: h(10) },
    { t: h(10) + 8 * M, step: 15, want: h(10) + 15 * M },
    { t: h(10) + 8 * M, step: 5, want: h(10) + 10 * M },
    { t: h(10) + 2 * M, step: 5, want: h(10) },
  ])("スナップ $t → $want（$step 分）", ({ t, step, want }) => {
    expect(snapMs(t, 0, step)).toBe(want);
  });

  test.each([
    {
      name: "Unscheduled から: ポインタの時刻が開始、長さは見積",
      i: { pointer: h(10) + 20 * M, grabOffsetMs: 0, durationMs: 45 * M, stepMin: 15 },
      want: { start: h(10) + 15 * M, end: h(11) },
    },
    {
      name: "ブロックの移動: つかんだ位置の分だけ上に置き、長さは保つ",
      i: { pointer: h(14) + 40 * M, grabOffsetMs: 25 * M, durationMs: H, stepMin: 15 },
      want: { start: h(14) + 15 * M, end: h(15) + 15 * M },
    },
    {
      name: "⌥ で5分",
      i: { pointer: h(9) + 7 * M, grabOffsetMs: 0, durationMs: 30 * M, stepMin: 5 },
      want: { start: h(9) + 5 * M, end: h(9) + 35 * M },
    },
    {
      name: "時間軸の下端からはみ出さない",
      i: { pointer: h(23) + 50 * M, grabOffsetMs: 0, durationMs: H, stepMin: 15 },
      want: { start: h(23), end: h(24) },
    },
    {
      name: "上端より上には置かない",
      i: { pointer: 5 * M, grabOffsetMs: 30 * M, durationMs: 30 * M, stepMin: 15 },
      want: { start: 0, end: 30 * M },
    },
  ])("$name", ({ i, want }) => {
    expect(dropRange({ ...i, axis })).toEqual(want);
  });

  test("伸縮: 終了をスナップし、最短は1単位、時間軸の終わりまで", () => {
    expect(resizeEnd({ pointer: h(11) + 20 * M, start: h(10), axis, stepMin: 15 })).toBe(
      h(11) + 15 * M,
    );
    expect(resizeEnd({ pointer: h(9), start: h(10), axis, stepMin: 15 })).toBe(h(10) + 15 * M);
    expect(resizeEnd({ pointer: h(25), start: h(23), axis, stepMin: 15 })).toBe(h(24));
  });

  test("範囲選択: 下向き・上向きのどちらでも、両端を近い15分へ（最短15分）", () => {
    expect(selectRange({ from: h(9) + 5 * M, to: h(10) + 3 * M, axis, stepMin: 15 })).toEqual({
      start: h(9),
      end: h(10),
    });
    expect(selectRange({ from: h(10) + 10 * M, to: h(9) + 5 * M, axis, stepMin: 15 })).toEqual({
      start: h(9),
      end: h(10) + 15 * M,
    });
    expect(selectRange({ from: h(23) + 55 * M, to: h(24), axis, stepMin: 15 })).toEqual({
      start: h(23) + 45 * M,
      end: h(24),
    });
    expect(selectRange({ from: h(9), to: h(9), axis, stepMin: 15 })).toEqual({
      start: h(9),
      end: h(9) + 15 * M,
    });
  });

  test("予定との重なり（重なる予定どうしは1回だけ数える）", () => {
    const busy = [
      { start: h(10), end: h(11) },
      { start: h(10.5), end: h(12) },
      { start: h(15), end: h(16) },
    ];
    expect(busyOverlapMs({ start: h(10.75), end: h(15.5) }, busy)).toBe(h(1.25) + h(0.5));
    expect(busyOverlapMs({ start: h(13), end: h(14) }, busy)).toBe(0);
  });

  test.each([
    { over: "b", place: "before" as const, want: { beforeId: "a", afterId: "b" } },
    { over: "b", place: "after" as const, want: { beforeId: "b", afterId: "c" } },
    { over: "a", place: "before" as const, want: { beforeId: null, afterId: "a" } },
    { over: "c", place: "after" as const, want: { beforeId: "c", afterId: null } },
    { over: null, place: "after" as const, want: { beforeId: "c", afterId: null } },
  ])("並べ替えの前後: $over の $place", ({ over, place, want }) => {
    expect(neighborsFor(["a", "x", "b", "c"], "x", over, place)).toEqual(want);
  });

  test("ドラッグ中のヘッダ: Planned を足し引きする（自分の番・やめたものは数えない）", () => {
    const totals = {
      freeMs: h(6),
      plannedMs: h(2),
      plannedUnestimated: 1,
    } as DayTotals;
    const t = { estimateMin: null, followUpId: null, status: "todo" } as const;
    expect(plannedWith(totals, t, 1)).toMatchObject({
      freeMs: h(6),
      plannedMs: h(2.5),
      plannedUnestimated: 2,
    });
    expect(plannedWith(totals, { ...t, estimateMin: 45 }, -1)).toMatchObject({
      plannedMs: h(2) - 45 * M,
      plannedUnestimated: 1,
    });
    expect(plannedWith(totals, { ...t, followUpId: "f" }, 1)).toBe(totals);
    expect(plannedWith(totals, { ...t, status: "canceled" }, 1)).toBe(totals);
  });

  test("日付をずらしても壁時計の時刻は同じ（夏時間の日も）", () => {
    expect(dayDiff("2026-10-05", "2026-10-08")).toBe(3);
    const tz = "America/New_York";
    // 2026-11-01 は夏時間の終わり（25時間の日）
    const at = dayStartMs("2026-10-31", tz, 0) + h(10);
    expect(shiftByDays(at, 1, tz)).toBe(dayStartMs("2026-11-01", tz, 0) + h(10) + H);
    expect(shiftByDays(at, 2, tz) - dayStartMs("2026-11-02", tz, 0)).toBe(h(10));
  });
});

describe("時間ブロックの楽観的更新（m2-api 4.4）", () => {
  const task = (id: string, date: string | null): TaskView =>
    ({ id, scheduledDate: date, laneOrder: "a0", title: { t: "text", text: id } }) as TaskView;
  const day = (date: string, tasks: TaskView[], timeBlocks: TimeBlockView[] = []) =>
    ({ date, tasks, crossTasks: [], timeBlocks }) as unknown as DayColumn;
  const block = (id: string, taskId: string, start: number, end: number): TimeBlockView => ({
    id,
    taskId,
    title: null,
    start,
    end,
  });
  const board = (days: DayColumn[]) => ({ days }) as BoardResponse;

  test("時間に置く: タスクを日付へ移し、ブロックを置き換える", () => {
    const x = task("x", "2026-10-05");
    const b0 = board([
      day("2026-10-05", [x], [block("b1", "x", h(9), h(10))]),
      day("2026-10-06", []),
    ]);
    const b1 = placeTaskInBoard(b0, x, "2026-10-06", block("b1", "x", h(33), h(34)));
    expect(b1.days.map((d) => d.tasks.map((t) => t.id))).toEqual([[], ["x"]]);
    expect(b1.days.map((d) => d.timeBlocks.map((b) => [b.id, b.start]))).toEqual([
      [],
      [["b1", h(33)]],
    ]);
    expect(findBlock(b1, "x")?.end).toBe(h(34));
  });

  test("Inbox から時間に置く（ボードに無かったタスク）", () => {
    const x = task("x", null);
    const b1 = placeTaskInBoard(
      board([day("2026-10-05", [])]),
      x,
      "2026-10-05",
      block("n", "x", h(9), h(9.5)),
    );
    expect(b1.days[0]?.tasks.map((t) => [t.id, t.scheduledDate])).toEqual([["x", "2026-10-05"]]);
    expect(b1.days[0]?.timeBlocks.map((b) => b.id)).toEqual(["n"]);
  });

  test("ブロックの時刻を変える・外す", () => {
    const b0 = board([
      day("2026-10-05", [task("x", "2026-10-05")], [block("b1", "x", h(9), h(10))]),
    ]);
    expect(
      patchBlockInBoard(b0, "b1", { start: h(9), end: h(11) }).days[0]?.timeBlocks[0]?.end,
    ).toBe(h(11));
    const r = removeBlockFromBoard(b0, "b1");
    expect([r.days[0]?.timeBlocks.length, r.days[0]?.tasks.length]).toEqual([0, 1]);
  });
});
