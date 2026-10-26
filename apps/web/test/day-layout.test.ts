/**
 * デイビューの配置（M2-19。ux-mvp 4.5、D1・D2・D3）: ひと続きの作業のブロック（D-065）、3列＋`+N`、待ちの線を項目の列にブロックの下端から、
 * ラベル（放置はひと続きごと、集計外は理由ごとに1回、猶予で閉じた待ちは終わりに）、自分レーンの最小 16px と横並び。
 */
import { describe, expect, test } from "bun:test";
import type { AiRunDetail, DayDetail, DayWaitSegment } from "@turnlane/core/web";
import {
  AI_META_PX,
  connectorTarget,
  DAY_HOUR_PX,
  dayAiBlocks,
  layoutDayAi,
  layoutMe,
  ME_MIN_PX,
  waitLines,
} from "../src/day/layout.ts";

const MIN = 60_000;
const H = 60 * MIN;
const A0 = Date.UTC(2026, 9, 1, 15, 0); // 2026-10-02 0:00 JST
const at = (h: number, m = 0) => A0 + h * H + m * MIN;
const axis = { start: A0, end: A0 + 24 * H };

function run(id: string, start: number, end: number, open = false): AiRunDetail {
  return {
    turnId: id,
    start,
    end,
    open,
    toolCalls: 3,
    editedFiles: 1,
    inputTokens: null,
    outputTokens: null,
    endedWith: "end_turn",
    tool: "claude_code",
  };
}

function wait(
  key: string,
  kind: DayWaitSegment["kind"],
  start: number,
  end: number,
  p: Partial<DayWaitSegment> = {},
): DayWaitSegment {
  return {
    waitKey: key,
    start,
    end,
    idle: kind === "idle",
    open: false,
    tone: "your_turn",
    followUpId: null,
    kind,
    excludedBy: kind === "excluded" ? "away" : null,
    endReason: null,
    ...p,
  };
}

type Item = DayDetail["aiLane"][number];
function item(
  id: string,
  runs: AiRunDetail[],
  waits: DayWaitSegment[] = [],
  p: Partial<Item> = {},
): Item {
  return {
    id,
    title: id,
    titleSource: null,
    status: "done",
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
    ...p,
  };
}

const day = (aiLane: Item[]) => ({ aiLane, axis, phase: "past" as const, plannedHours: null });

describe("AI レーン（ひと続きの作業。D-065）", () => {
  test("同じ項目で間隔30分未満のターンは1ブロック、AI 時間はターンの和、最後のブロックだけ2行（メタ）", () => {
    const d = day([
      item("a", [
        run("t1", at(9), at(9, 12)),
        run("t2", at(9, 20), at(9, 21)),
        run("t3", at(9, 40), at(9, 41)),
        // 30分以上あいたら別のブロック
        run("t4", at(10, 20), at(10, 25)),
      ]),
    ]);
    const blocks = dayAiBlocks(d, at(13));
    expect(blocks.map((b) => [b.runs.map((r) => r.turnId), b.span?.aiMs, b.last])).toEqual([
      [["t1", "t2", "t3"], 14 * MIN, false],
      [["t4"], 5 * MIN, true],
    ]);
    expect(blocks[0]?.at).toEqual({ start: at(9), end: at(9, 41) });
    const { placed } = layoutDayAi(blocks, axis.start);
    const last = placed.find((p) => p.block.last);
    expect(last?.height).toBe(AI_META_PX);
    expect(last?.top).toBe((10 + 20 / 60) * DAY_HOUR_PX);
    // 1つ目のブロックは実時間の高さ（41分）
    expect(placed.find((p) => !p.block.last)?.height).toBeCloseTo((41 / 60) * DAY_HOUR_PX);
  });

  test("タスク通知の1分未満のターンの連続は列に積まず1ブロック（スクリーンショットの「Plan the Q4… <1m」×N）", () => {
    const runs = [run("t0", at(10, 2), at(10, 14))];
    for (let i = 0; i < 11; i++) {
      const s = at(10, 20 + i * 5);
      runs.push(run(`t${i + 1}`, s, s + 40_000));
    }
    const { placed, overflow } = layoutDayAi(
      dayAiBlocks(day([item("q4", runs)]), at(13)),
      axis.start,
    );
    expect(placed).toHaveLength(1);
    expect(overflow).toEqual([]);
    expect(placed[0]?.block.runs).toHaveLength(12);
  });

  test("稼働中のブロックは now まで、AI 時間も now まで数える", () => {
    const d = day([
      item("a", [run("t1", at(9), at(9, 10)), run("t2", at(9, 20), at(9, 21), true)]),
    ]);
    const [b] = dayAiBlocks(d, at(9, 50));
    expect(b?.at.end).toBe(at(9, 50));
    expect(b?.span?.aiMs).toBe(40 * MIN);
  });

  test("並列は6列まで、超えたら +N（D-117 で 4 → 6）", () => {
    const d = day(
      ["a", "b", "c", "d", "e", "f", "g"].map((id) => item(id, [run(`${id}1`, at(10), at(11))])),
    );
    const { placed, overflow } = layoutDayAi(dayAiBlocks(d, at(13)), axis.start);
    expect(placed.map((p) => p.columns)).toEqual([6, 6, 6, 6, 6, 6]);
    expect(overflow[0]?.hidden).toHaveLength(1);
  });

  test("needs_input で止まっている実行は待ちの始まりで切り、持ち越しは勤務開始に置く", () => {
    const d = {
      ...day([
        item(
          "a",
          [run("t1", at(9), at(13), true)],
          [wait("w", "grace", at(10), at(10, 15), { open: true })],
          {
            status: "needs_input",
          },
        ),
        item(
          "b",
          [],
          [wait("x", "excluded", at(0), at(8)), wait("x", "idle", at(8), at(13), { open: true })],
          {
            status: "your_turn",
            carriedFrom: "2026-10-01",
          },
        ),
      ]),
      phase: "past" as const,
      plannedHours: { start: at(8, 42), end: at(19) },
    };
    const blocks = dayAiBlocks(d, at(13));
    expect(blocks.find((b) => b.item.id === "a")?.at.end).toBe(at(10));
    expect(blocks.find((b) => b.item.id === "b")?.at.start).toBe(at(8, 42));
  });
});

describe("待ちの線（項目の列に、ブロックの下端から）", () => {
  test("3区分とラベル: 放置はひと続きで1回、集計外は理由ごとに1回、猶予で閉じた待ちは終わりに", () => {
    const it = item(
      "a",
      [run("t1", at(9), at(9, 30)), run("t2", at(11), at(11, 30))],
      [
        wait("w1", "grace", at(9, 30), at(9, 45)),
        wait("w1", "idle", at(9, 45), at(10)),
        wait("w1", "idle", at(10), at(10, 11)),
        wait("w2", "excluded", at(11, 30), at(12), { excludedBy: "event" }),
        wait("w2", "excluded", at(12), at(12, 20), { excludedBy: "event" }),
        wait("w2", "grace", at(12, 20), at(12, 28), { endReason: "human_input" }),
      ],
    );
    const d = day([it]);
    const { placed } = layoutDayAi(dayAiBlocks(d, at(13)), axis.start);
    const lines = waitLines(d, placed, at(13));
    expect(lines.map((l) => [l.seg.kind, l.label])).toEqual([
      ["grace", null],
      ["idle", { t: "idle", ms: 26 * MIN }],
      ["idle", null],
      ["excluded", { t: "excluded", by: "event" }],
      ["excluded", null],
      ["grace", { t: "grace", ms: 8 * MIN, end: "human_input" }],
    ]);
    // 2つ目の待ちは2つ目のターンのブロック（最後のブロック = 2行の高さ）の下端から
    const t2 = placed.find((p) => p.block.runs[0]?.turnId === "t2");
    expect(lines[3]?.top).toBe((t2?.top ?? 0) + AI_META_PX);
    // 1つ目の猶予は1つ目のブロックの下端から。1つ目のブロックは次のブロックまで 60分以上あいているので別の chain の
    // 最後（ラベルを付ける）で、2行の高さ（AI_META_PX）を取る（D-117）
    expect(lines[0]?.top).toBe(9 * DAY_HOUR_PX + AI_META_PX);
  });

  test("集計外のラベルは、短い区間や他の項目のブロックに隠れるときホバーでだけ出す（D-065）", () => {
    const d = day([
      // a: 10:00–10:30 の後、10:30–10:40 会議中（10分 = 10px < 14px）、11:00–12:00 会議中（他の項目 b のブロックが 11:00 に重なる）
      item(
        "a",
        [run("t1", at(10), at(10, 30)), run("t2", at(13), at(13, 30))],
        [
          wait("w1", "excluded", at(10, 30), at(10, 40), { excludedBy: "event" }),
          wait("w2", "excluded", at(11), at(12), { excludedBy: "event" }),
        ],
      ),
      item("b", [run("u1", at(9), at(11, 30))]),
    ]);
    const { placed } = layoutDayAi(dayAiBlocks(d, at(14)), axis.start);
    const lines = waitLines(d, placed, at(14));
    expect(lines.map((l) => [l.label?.t, l.labelHoverOnly])).toEqual([
      ["excluded", true],
      ["excluded", false],
    ]);
    // 別のまとまりのブロックが同じ列でラベルの位置に重なると隠れる
    const d2 = day([
      item("a", [run("t1", at(9), at(9, 30))], [wait("w", "excluded", at(9, 30), at(11))]),
      item("c", [run("u1", at(9, 40), at(10, 20))]),
    ]);
    const p2 = layoutDayAi(dayAiBlocks(d2, at(14)), axis.start).placed;
    expect(p2.map((p) => p.columns)).toEqual([1, 1]);
    expect(waitLines(d2, p2, at(14)).map((l) => l.labelHoverOnly)).toEqual([true]);
  });

  test("放置のラベルは線の中ほどから、AI のブロックに隠れない位置へずらす", () => {
    const d = day([
      item("a", [run("t1", at(9), at(9, 30))], [wait("w", "idle", at(9, 30), at(11, 30))]),
      // 線の中ほど（10:30）に別の項目のブロック（同じ列）
      item("c", [run("u1", at(10, 15), at(10, 50))]),
    ]);
    const { placed } = layoutDayAi(dayAiBlocks(d, at(14)), axis.start);
    const [l] = waitLines(d, placed, at(14));
    const c = placed.find((p) => p.block.item.id === "c");
    expect(l?.label?.t).toBe("idle");
    const y = l?.labelTop ?? 0;
    const hidden = c ? y < c.top + c.height && c.top < y + 16 : true;
    expect(hidden).toBe(false);
    expect(y).toBeGreaterThanOrEqual(l?.top ?? 0);
  });

  test("開いている待ちは now まで、持ち越しのブロックより前の夜間の待ちは描かない", () => {
    const d = {
      ...day([
        item(
          "b",
          [],
          [
            wait("x", "excluded", at(0), at(8, 42)),
            wait("x", "idle", at(8, 42), at(9), { open: true }),
          ],
          {
            status: "your_turn",
          },
        ),
      ]),
      phase: "past" as const,
      plannedHours: { start: at(8, 42), end: at(19) },
    };
    const { placed } = layoutDayAi(dayAiBlocks(d, at(13)), axis.start);
    const lines = waitLines(d, placed, at(13));
    expect(lines[0]?.height).toBe(0);
    expect(lines[1]?.at.end).toBe(at(13));
    expect(lines[1]?.top).toBe((8 + 42 / 60) * DAY_HOUR_PX + AI_META_PX);
  });

  test("コネクタの終点: 応答の開始に最も近い終点を持つ待ちの列", () => {
    const d = day([
      item("a", [run("t1", at(9), at(9, 30))], [wait("w1", "idle", at(9, 30), at(10))]),
      item("b", [run("u1", at(9), at(9, 40))], [wait("w2", "idle", at(9, 40), at(10, 5))]),
    ]);
    const { placed } = layoutDayAi(dayAiBlocks(d, at(13)), axis.start);
    const lines = waitLines(d, placed, at(13));
    // 同時に始まった2件は長い方（b）が左の列
    expect(connectorTarget("b", "w2", at(10, 5), lines, placed)).toEqual({ column: 0, columns: 2 });
    expect(connectorTarget("a", null, at(10), lines, placed)).toEqual({ column: 1, columns: 2 });
  });
});

describe("自分レーン（D2）", () => {
  test("15分未満は最小 16px、重なりは横に並べ、開始位置は実時刻", () => {
    const placed = layoutMe(
      [
        { id: "x", at: { start: at(8, 50), end: at(8, 58) } },
        { id: "y", at: { start: at(8, 55), end: at(9, 6) } },
        { id: "z", at: { start: at(14), end: at(15) } },
      ],
      axis,
    );
    const by = new Map(placed.map((p) => [p.id, p]));
    expect(by.get("x")?.height).toBe(ME_MIN_PX);
    expect([by.get("x")?.column, by.get("y")?.column, by.get("y")?.columns]).toEqual([0, 1, 2]);
    expect(by.get("y")?.top).toBe((8 + 55 / 60) * DAY_HOUR_PX);
    expect(by.get("z")).toMatchObject({ column: 0, columns: 1, height: DAY_HOUR_PX });
  });
});

describe("深夜（0:00〜日付区切り）の AI のブロック（D-054、ux-mvp 4.5）", () => {
  // 10/1 23:30 に始めたターンが 10/2 3:50 も続いている
  const prevAxis = { start: A0 - 24 * H, end: A0 };
  const night = item("n", [run("t1", at(-1, 30), at(3, 50), true)], [], { status: "running" });

  test("暦日の今日（10/2）のデイビューでは 0:00 から now まで描く（running）", () => {
    const [b] = dayAiBlocks(
      { aiLane: [night], axis, phase: "past" as const, plannedHours: null },
      at(3, 50),
    );
    expect(b?.at).toEqual({ start: A0, end: at(3, 50) });
    expect(b?.status).toBe("running");
    expect(layoutDayAi([b as NonNullable<typeof b>], axis.start).placed[0]?.top).toBe(0);
  });

  test("前の暦日（10/1）のデイビューでは 24:00 で切り、軸の外へはみ出さない", () => {
    const blocks = dayAiBlocks(
      { aiLane: [night], axis: prevAxis, phase: "past" as const, plannedHours: null },
      at(3, 50),
    );
    expect(blocks.map((b) => b.at)).toEqual([{ start: at(-1, 30), end: A0 }]);
  });

  test("0:00 より後のターンは前の暦日に描かない（同じ項目の 0:00 前のブロックだけ）", () => {
    const both = item("b", [run("t1", at(-1, 0), at(-1, 20)), run("t2", at(0, 10), at(0, 50))]);
    const blocks = dayAiBlocks(
      { aiLane: [both], axis: prevAxis, phase: "past" as const, plannedHours: null },
      at(3, 50),
    );
    expect(blocks.map((b) => b.at)).toEqual([{ start: at(-1, 0), end: at(-1, 20) }]);
  });
});
