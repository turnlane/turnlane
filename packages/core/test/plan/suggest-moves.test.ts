import { describe, expect, test } from "bun:test";
import { type DayRoom, type MoveTaskInput, suggestMoves } from "../../src/plan/suggest-moves.ts";

const M = 60_000;
const H = 60 * M;

const task = (id: string, laneOrder: string, p: Partial<MoveTaskInput> = {}): MoveTaskInput => ({
  id,
  status: "todo",
  estimateMin: 30,
  isHighlight: false,
  laneOrder,
  hasBlock: false,
  ...p,
});
const day = (
  date: string,
  freeH: number,
  plannedH = 0,
  workday: boolean | null = true,
): DayRoom => ({
  date,
  workday,
  freeMs: freeH * H,
  plannedMs: plannedH * H,
});

interface Case {
  name: string;
  tasks: MoveTaskInput[];
  over: number;
  days: DayRoom[];
  want: [string, number, string | null][];
}

describe("朝の計画 Step 3 の移動候補（M4-7）", () => {
  test.each<Case>([
    {
      name: "超過なしなら候補なし",
      tasks: [task("a", "a1")],
      over: 0,
      days: [day("10-05", 8)],
      want: [],
    },
    {
      name: "並びの下から、超過分が収まるまで（50分 → 1件目 40分では足りず2件）",
      tasks: [
        task("a", "a1", { estimateMin: 60 }),
        task("b", "a2", { estimateMin: 30 }),
        task("c", "a3", { estimateMin: 40 }),
      ],
      over: 50 * M,
      days: [day("10-05", 8)],
      want: [
        ["c", 40 * M, "10-05"],
        ["b", 30 * M, "10-05"],
      ],
    },
    {
      name: "* の付いたもの・時間ブロックのあるもの・着手済みは後回し・対象外",
      tasks: [
        task("star", "a9", { isHighlight: true }),
        task("blk", "a8", { hasBlock: true }),
        task("doing", "a7", { status: "doing" }),
        task("plain", "a1"),
      ],
      over: 45 * M,
      days: [day("10-05", 8)],
      want: [
        ["plain", 30 * M, "10-05"],
        ["star", 30 * M, "10-05"],
      ],
    },
    {
      name: "見積なしは30分",
      tasks: [task("a", "a1", { estimateMin: null })],
      over: 10 * M,
      days: [day("10-05", 8)],
      want: [["a", 30 * M, "10-05"]],
    },
    {
      name: "行き先は空きの足りる最初の稼働日（休日・空きなしを飛ばし、先に割り当てた分を引く）",
      tasks: [task("a", "a1", { estimateMin: 60 }), task("b", "a2", { estimateMin: 60 })],
      over: 2 * H,
      days: [day("10-03", 8, 0, false), day("10-04", 0), day("10-05", 3, 1.5), day("10-06", 8)],
      want: [
        ["b", H, "10-05"],
        ["a", H, "10-06"],
      ],
    },
    {
      name: "空きの足りる日が無ければ最初の稼働日",
      tasks: [task("a", "a1", { estimateMin: 600 })],
      over: H,
      days: [day("10-05", 2), day("10-06", 3)],
      want: [["a", 10 * H, "10-05"]],
    },
    {
      name: "稼働日が無ければ行き先は null",
      tasks: [task("a", "a1")],
      over: H,
      days: [],
      want: [["a", 30 * M, null]],
    },
  ])("$name", ({ tasks, over, days, want }) => {
    expect(suggestMoves(tasks, over, days).map((s) => [s.taskId, s.ms, s.to])).toEqual(want);
  });
});
