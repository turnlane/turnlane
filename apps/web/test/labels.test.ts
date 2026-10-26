/**
 * 待ちの線のラベルの置き場所（board/labels.ts。3日ボードの AI レーンとデイビューで共通）:
 * 他のラベル・AI のブロックと重ねない。塞がっていれば下へずらし、置けなければ短い区間のラベルを省く（ホバーに任せる）。
 * あわせて、週表示の狭い列の YOUR TURN 帯の行（TurnRow）が repo 名と待ちを省いて題名を2行まで出すこと。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AiRunDetail, DayDetail, DayWaitSegment } from "@turnlane/core/web";
import { LABEL_PX, placeLabels } from "../src/board/labels.ts";
import { dayAiBlocks, layoutDayAi, waitLines } from "../src/day/layout.ts";

const one = { column: 0, columns: 1 };
const overlaps = (a: number, b: number) => a < b + LABEL_PX && b < a + LABEL_PX;

describe("placeLabels", () => {
  test("望む位置がブロックに塞がれていれば、下へずらす（ブロックの題名に重ねない）", () => {
    const tops = placeLabels(
      [{ id: "a", ...one, want: 10, lo: 0, hi: 200, weight: 1 }],
      [{ top: 0, height: 20, ...one }],
    );
    expect(tops.get("a")).toBe(20);
  });

  test("近接するラベルは長い区間の方が先に場所を取り、短い方を下へずらす", () => {
    const tops = placeLabels(
      [
        { id: "short", ...one, want: 100, lo: 90, hi: 140, weight: 45 },
        { id: "long", ...one, want: 100, lo: 40, hi: 160, weight: 60 },
      ],
      [],
    );
    const l = tops.get("long") ?? -1;
    const s = tops.get("short") ?? -1;
    expect(l).toBe(100);
    expect(overlaps(l, s)).toBe(false);
    expect(s).toBeGreaterThan(l);
  });

  test("線の範囲に空きが無ければ短い区間のラベルを省く（null）", () => {
    const tops = placeLabels(
      [
        { id: "long", ...one, want: 100, lo: 100, hi: 104, weight: 60 },
        { id: "short", ...one, want: 100, lo: 100, hi: 104, weight: 45 },
      ],
      [],
    );
    expect(tops.get("long")).toBe(100);
    expect(tops.get("short")).toBeNull();
  });

  test("別の列のものとは衝突しない", () => {
    const tops = placeLabels(
      [{ id: "a", column: 1, columns: 2, want: 10, lo: 0, hi: 200, weight: 1 }],
      [{ top: 0, height: 40, column: 0, columns: 2 }],
    );
    expect(tops.get("a")).toBe(10);
  });
});

// ---- デイビュー: 近接する放置の区間のラベル（`放置 1h` と `放置 45m`）が重ならない ----
const MIN = 60_000;
const H = 60 * MIN;
const A0 = Date.UTC(2026, 9, 1, 15, 0);
const at = (h: number, m = 0) => A0 + h * H + m * MIN;
const axis = { start: A0, end: A0 + 24 * H };
const run = (id: string, start: number, end: number): AiRunDetail => ({
  turnId: id,
  start,
  end,
  open: false,
  toolCalls: 1,
  editedFiles: 0,
  inputTokens: null,
  outputTokens: null,
  endedWith: "end_turn",
  tool: "claude_code",
});
const wait = (
  key: string,
  kind: DayWaitSegment["kind"],
  start: number,
  end: number,
): DayWaitSegment => ({
  waitKey: key,
  start,
  end,
  idle: kind === "idle",
  open: true,
  tone: "your_turn",
  followUpId: null,
  kind,
  excludedBy: kind === "excluded" ? "event" : null,
  endReason: null,
});
type Item = DayDetail["aiLane"][number];
const item = (id: string, runs: AiRunDetail[], waits: DayWaitSegment[]): Item => ({
  id,
  title: id,
  titleSource: null,
  status: "your_turn",
  reason: null,
  estimated: false,
  sources: [],
  repoRoot: null,
  branch: null,
  prRef: null,
  aiMs: 0,
  youMs: 0,
  idleMs: 0,
  turns: runs.length,
  carriedFrom: null,
  runs,
  waits,
});

describe("デイビューの放置のラベル", () => {
  test("同じ列で近接する放置の区間のラベルは重ならない（ブロックにも重ならない）", () => {
    const d = {
      aiLane: [
        // 同じ列に2本の長い放置（a: 10:00〜16:00、b: 10:20〜16:00）。どちらの中ほども c のブロックに塞がれ、
        // 以前はどちらのラベルも c の下端（14:00）に置かれて重なった
        item("a", [run("t1", at(9), at(10))], [wait("w1", "idle", at(10), at(16))]),
        item("b", [run("u1", at(10, 5), at(10, 10))], [wait("w2", "idle", at(10, 20), at(16))]),
        item("c", [run("v1", at(11), at(14))], []),
      ],
      axis,
      phase: "past" as const,
      plannedHours: null,
    };
    const { placed } = layoutDayAi(dayAiBlocks(d, at(16)), axis.start);
    expect(new Set(placed.map((p) => p.columns))).toEqual(new Set([1]));
    const lines = waitLines(d, placed, at(16));
    const shown = lines
      .filter((l) => l.label && !l.labelHoverOnly && l.height > 0)
      .map((l) => ({ ...l, y: l.labelTop }));
    for (const [i, a] of shown.entries())
      for (const b of shown.slice(i + 1))
        if (a.column / a.columns === b.column / b.columns) expect(overlaps(a.y, b.y)).toBe(false);
    for (const l of shown)
      expect(placed.some((p) => p.top < l.y + LABEL_PX && l.y < p.top + p.height)).toBe(false);
    // 省いたラベルは無い（範囲に空きがある）
    expect(lines.filter((l) => l.label?.t === "idle").every((l) => !l.labelHoverOnly)).toBe(true);
  });
});

describe("デイビューの待ちの線の段（同じ列で重なる別の待ちを横にずらす）", () => {
  test("同じ列で上下に重なる別の項目の待ちは別の段、同じ待ちの続きは同じ段、重ならなければ段 0", () => {
    const d = {
      aiLane: [
        // a と b は同じ列（ブロックが重ならない）で、待ちが 10:20〜16:00 で重なる
        item(
          "a",
          [run("t1", at(9), at(10))],
          [wait("w1", "idle", at(10), at(12)), wait("w1", "excluded", at(12), at(16))],
        ),
        item("b", [run("u1", at(10, 5), at(10, 10))], [wait("w2", "idle", at(10, 20), at(16))]),
        // c の待ちは a・b と重ならない（17:00〜18:00）
        item("c", [run("v1", at(16, 30), at(17))], [wait("w3", "idle", at(17), at(18))]),
      ],
      axis,
      phase: "past" as const,
      plannedHours: null,
    };
    const { placed } = layoutDayAi(dayAiBlocks(d, at(18)), axis.start);
    expect(new Set(placed.map((p) => p.columns))).toEqual(new Set([1]));
    const lines = waitLines(d, placed, at(16)).filter((l) => l.height > 0);
    const tracks = (id: string) => [
      ...new Set(lines.filter((l) => l.itemId === id).map((l) => l.track)),
    ];
    expect(tracks("a")).toEqual([0]);
    expect(tracks("b")).toEqual([1]);
    expect(tracks("c")).toEqual([0]);
    expect([...new Set(lines.filter((l) => l.itemId !== "c").map((l) => l.trackMax))]).toEqual([1]);
  });
});

describe("週表示の YOUR TURN 帯（TurnRow）", () => {
  const src = readFileSync(join(import.meta.dir, "../src/components/TurnRow.tsx"), "utf8");
  test("狭い行（300px 未満）では待ち・期限を省き、件名 1 行・理由 1 行にする。ホバーで中身とリポジトリ・待ちを出す（spec-glance §3.3）", () => {
    expect(src).toContain('NARROW_HIDE = "@max-[299px]/turn:hidden"');
    expect(src).toMatch(/data-kind="turn-wait"[\s\S]*?NARROW_HIDE/);
    expect(src).toContain('mode="narrow"');
    // 560px 以上は 1 行（件名 ｜ 理由 ｜ 待ち）
    expect(src).toContain('WIDE_ONLY = "hidden @min-[560px]/turn:flex"');
    expect(src).toContain("title={hover}");
  });
});
