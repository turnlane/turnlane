import { describe, expect, test } from "bun:test";
import {
  type AiLaneBlockInput,
  type AiRunLike,
  layoutAiLane,
  spansOf,
} from "../../src/layout/ai-lane.ts";

const SEC = 1000;
const MIN = 60 * SEC;
const H = 60 * MIN;
/** 1時間 44px（週ボードの既定） */
const PX = 44 / H;
const at = (hh: number, mm = 0, ss = 0) => hh * H + mm * MIN + ss * SEC;
const run = (turnId: string, s: number, e: number, open = false): AiRunLike => ({
  turnId,
  start: s,
  end: e,
  open,
});
const opts = { axisStart: 0, pxPerMs: PX, maxColumns: 3, minPx: 20, gapPx: 4 };

describe("spansOf（ひと続きの作業。D-061）", () => {
  test("タスク通知で始まる1分未満のターンの連続（間隔30分未満）は1つにまとまり、AI 時間はターンの和", () => {
    // 9:00 から 4〜12分おきに 40 秒のターンが 12 回
    const runs: AiRunLike[] = [];
    let t = at(9);
    for (let i = 0; i < 12; i++) {
      runs.push(run(`t${i}`, t, t + 40 * SEC));
      t += (4 + (i % 3) * 4) * MIN;
    }
    const spans = spansOf(runs, { now: at(12) });
    expect(spans).toHaveLength(1);
    expect(spans[0]?.turnIds).toHaveLength(12);
    expect(spans[0]?.start).toBe(at(9));
    expect(spans[0]?.aiMs).toBe(12 * 40 * SEC);
    expect(spans[0]?.open).toBe(false);
  });

  test("前の終わりから次の始まりまでが30分ちょうど以上なら分ける（29分59秒はつなぐ）", () => {
    const spans = spansOf(
      [
        run("a", at(9), at(9, 10)),
        run("b", at(9, 39, 59), at(9, 45)),
        run("c", at(10, 15), at(10, 20)),
      ],
      { now: at(12) },
    );
    expect(spans.map((s) => s.turnIds)).toEqual([["a", "b"], ["c"]]);
    expect(spans[0]?.aiMs).toBe(10 * MIN + 5 * MIN + SEC);
  });

  test("稼働中のターンは now まで AI 時間に数え、ブロックも稼働中", () => {
    const spans = spansOf([run("a", at(9), at(9, 5)), run("b", at(9, 10), at(9, 12), true)], {
      now: at(9, 20),
    });
    expect(spans).toHaveLength(1);
    expect(spans[0]?.open).toBe(true);
    expect(spans[0]?.aiMs).toBe(5 * MIN + 10 * MIN);
  });

  test("順不同の入力でも開始順に並べる", () => {
    const spans = spansOf([run("b", at(11), at(11, 1)), run("a", at(9), at(9, 1))], {
      now: at(12),
    });
    expect(spans.map((s) => s.id)).toEqual(["a", "b"]);
  });
});

const blk = (
  id: string,
  s: number,
  e: number,
  collapsible: boolean,
  aiMs = e - s,
): AiLaneBlockInput => ({ id, start: s, end: e, minPx: 20, collapsible, aiMs });

describe("layoutAiLane（W7。短い完了ブロックのまとめ）", () => {
  test("5分未満の完了ブロックが最小高さで重なって並ぶなら、AI 項目をまたいで1つのまとめ（件数と AI 時間の和）", () => {
    const { placed, overflow } = layoutAiLane(
      [
        blk("x:1", at(10), at(10, 1), true, 40 * SEC),
        blk("y:1", at(10, 3), at(10, 4), true, 50 * SEC),
        blk("x:2", at(10, 20), at(10, 22), true, 90 * SEC),
      ],
      opts,
    );
    expect(overflow).toEqual([]);
    expect(placed).toHaveLength(1);
    const s = placed[0];
    expect(s?.kind).toBe("summary");
    if (s?.kind !== "summary") return;
    expect(s.ids).toEqual(["x:1", "y:1", "x:2"]);
    expect(s.aiMs).toBe(180 * SEC);
    expect([s.column, s.columns]).toEqual([0, 1]);
    expect(s.top).toBeCloseTo(at(10) * PX);
    expect(s.height).toBeGreaterThanOrEqual(20);
  });

  test("離れた短い完了ブロックは単独のまま（まとめるのは2件以上）", () => {
    const { placed } = layoutAiLane(
      [blk("a", at(9), at(9, 1), true), blk("b", at(11), at(11, 1), true)],
      opts,
    );
    expect(placed.map((p) => [p.kind, p.id])).toEqual([
      ["block", "a"],
      ["block", "b"],
    ]);
  });

  test("短くない・完了でないブロック（collapsible でない）はまとめず、まとめと列に分ける", () => {
    const { placed } = layoutAiLane(
      [
        blk("long", at(10), at(11), false),
        blk("s1", at(10, 10), at(10, 11), true),
        blk("s2", at(10, 12), at(10, 13), true),
        blk("run", at(10, 12), at(10, 14), false),
      ],
      opts,
    );
    const byId = new Map(placed.map((p) => [p.id, p]));
    expect(byId.get("summary:s1")?.kind).toBe("summary");
    expect(byId.get("long")?.columns).toBe(3);
    expect(byId.has("s1")).toBe(false);
    expect(new Set(placed.map((p) => p.column)).size).toBe(3);
  });

  test("まとめた後も3列を超えたら overflow（+N）", () => {
    const { placed, overflow } = layoutAiLane(
      [
        blk("a", at(10), at(11), false),
        blk("b", at(10), at(11), false),
        blk("c", at(10), at(11), false),
        blk("d", at(10, 30), at(11), false),
      ],
      opts,
    );
    expect(placed).toHaveLength(3);
    expect(overflow.map((o) => o.hidden)).toEqual([["d"]]);
  });
});
