/**
 * 3日ボードと見た目の改善（D-074。ux-mvp 4.4.0・4.5、m2-api 20章）: 列の幅、前後の移動、ヘッダの AI 時間、
 * 今日の稼働リボン、自分の番への対応の分け方と印の位置、3日ボードのキャッシュキーの無効化。TZ は Asia/Tokyo。
 */
import { describe, expect, test } from "bun:test";
import { type DayColumn, type TaskView, wallToEpoch } from "@turnlane/core/web";
import { isReply, placementsOf } from "../src/board/day-split.ts";
import {
  GAP_PX,
  GUTTER_PX,
  gapsOf,
  gridTemplate,
  provisionalThree,
  visibleDates,
} from "../src/board/geometry.ts";
import { ribbonOf } from "../src/board/ribbon.ts";
import { totalsParts } from "../src/board/totals.ts";
import { keys, overlaps } from "../src/data/invalidate.ts";
import { boardNav } from "../src/lib/board-nav.ts";
import { getUi, setUi } from "../src/lib/store.ts";

const TZ = "Asia/Tokyo";
const MIN = 60_000;
const at = (day: number, hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  return wallToEpoch(2026, 10, day, h * 60 + m, TZ);
};

function task(id: string, p: Partial<TaskView> = {}): TaskView {
  return {
    id,
    title: { t: "text", text: id },
    status: "done",
    scheduledDate: "2026-10-02",
    laneOrder: "a",
    estimateMin: null,
    projectId: null,
    rolloverCount: 0,
    isHighlight: false,
    completedAt: null,
    autoCompleted: false,
    origin: { source: "manual", client: null, externalSource: null, externalUrl: null },
    followUpId: null,
    workItemId: null,
    createdAt: 0,
    deletedAt: null,
    ...p,
  };
}

function column(p: Partial<DayColumn> = {}): DayColumn {
  return {
    date: "2026-10-02",
    phase: "today",
    logicalPhase: "today",
    axis: { start: at(2, "00:00"), end: at(3, "00:00") },
    logical: { start: at(2, "04:00"), end: at(3, "04:00") },
    workday: true,
    plannedHours: null,
    allDayEvents: [],
    events: [],
    tasks: [],
    crossTasks: [],
    timeBlocks: [],
    timeEntries: [],
    totals: {
      freeMs: 3 * 3_600_000,
      eventsMs: 0,
      plannedMs: 0,
      plannedUnestimated: 0,
      doneCount: 0,
      taskCount: 0,
      aiMs: 2 * 3_600_000 + 5 * MIN,
      idleMs: 0,
      expired: 0,
    },
    aiRibbon: [],
    aiLane: null,
    ...p,
  };
}

describe("D-074: 列の幅（ux-mvp 4.4.0）", () => {
  test("3日ボードは 3.6 : 12 : 5.4（今日は D-114 の 12 / 21 のまま、前 : 次 = 2 : 3）", () => {
    expect(gridTemplate(["2026-10-01", "2026-10-02", "2026-10-05"], "three")).toBe(
      `${GUTTER_PX}px minmax(0, 3.6fr) minmax(0, 12fr) minmax(0, 5.4fr)`,
    );
  });
  test("稼働日の間の休みは細い区切りの列を挟む（確定デザイン「土日」）", () => {
    const dates = ["2026-10-01", "2026-10-02", "2026-10-05"];
    const gaps = gapsOf(dates);
    expect([...gaps]).toEqual([["2026-10-05", ["2026-10-03", "2026-10-04"]]]);
    expect(gridTemplate(dates, "three", new Set(gaps.keys()))).toBe(
      `${GUTTER_PX}px minmax(0, 3.6fr) minmax(0, 12fr) ${GAP_PX}px minmax(0, 5.4fr)`,
    );
  });
  test("週表示は平日 1・週末 0.6（今日も 1）", () => {
    expect(gridTemplate(["2026-10-02", "2026-10-03"], "week")).toBe(
      `${GUTTER_PX}px minmax(0, 1fr) minmax(0, 0.6fr)`,
    );
  });
  test("週表示は最大7日（昨日・今日・以降5日）", () => {
    expect(visibleDates("2026-10-02", 5000)).toEqual([
      "2026-10-01",
      "2026-10-02",
      "2026-10-03",
      "2026-10-04",
      "2026-10-05",
      "2026-10-06",
      "2026-10-07",
    ]);
  });
  test("応答が来るまでの仮の列は前日・基準日・翌日", () => {
    expect(provisionalThree("2026-10-02")).toEqual(["2026-10-01", "2026-10-02", "2026-10-03"]);
  });
});

describe("D-074: 前後の移動（`[` / `]`。ux-mvp 4.4.0）", () => {
  test("3日ボードは前・次の稼働日へ、週表示は1週", () => {
    setUi({
      boardMode: "three",
      boardAnchor: "2026-10-02",
      boardNeighbors: { around: "2026-10-02", prev: "2026-10-01", next: "2026-10-05" },
    });
    boardNav.step(1);
    expect(boardNav.anchor()).toBe("2026-10-05");
    // 前後の稼働日がまだ分からない日は1日
    boardNav.step(-1);
    expect(boardNav.anchor()).toBe("2026-10-04");
    setUi({ boardMode: "week", boardAnchor: "2026-10-02" });
    boardNav.step(1);
    expect(boardNav.anchor()).toBe("2026-10-09");
    setUi({ boardMode: "three", boardAnchor: null, boardNeighbors: null });
    expect(getUi().boardMode).toBe("three");
  });
});

describe("D-074: ヘッダの AI 時間（AI レーンを持たない今日の列）", () => {
  const t = (k: string) => k.replace("totals.", "");
  test("withAi のときだけ今日・未来の集計に AI を足し、Free の次に省く", () => {
    const d = column();
    expect(totalsParts(d, t).map((p) => p.text)).toEqual(["free 3h"]);
    expect(totalsParts(d, t, true).map(({ text, drop }) => ({ text, drop }))).toEqual([
      { text: "free 3h", drop: 2 },
      { text: "ai 2h5m", drop: 3 },
    ]);
  });
});

describe("D-074: 今日の稼働リボン", () => {
  test("過去日はデーモンの aiRibbon、今日は AI レーンの実行の和集合（稼働中は now まで）", () => {
    const past = column({ phase: "past", aiRibbon: [{ start: 1, end: 2 }] });
    expect(ribbonOf(past, 0)).toEqual([{ start: 1, end: 2 }]);
    const run = (start: number, end: number, open = false) => ({
      turnId: `t${start}`,
      start,
      end,
      open,
    });
    const item = (runs: ReturnType<typeof run>[]) =>
      ({ id: "w", runs, waits: [] }) as unknown as NonNullable<DayColumn["aiLane"]>[number];
    const today = column({
      aiLane: [
        item([run(at(2, "10:00"), at(2, "10:30"))]),
        item([run(at(2, "10:20"), at(2, "10:50")), run(at(2, "13:00"), at(2, "13:05"), true)]),
      ],
    });
    expect(ribbonOf(today, at(2, "13:20"))).toEqual([
      { start: at(2, "10:00"), end: at(2, "10:50") },
      { start: at(2, "13:00"), end: at(2, "13:20") },
    ]);
    expect(ribbonOf(column({ phase: "future" }), 0)).toEqual([]);
  });
});

describe("自分の番への対応（ux-mvp 4.5、D-074）", () => {
  const reply = task("reply", { followUpId: "f1", workItemId: "w1" });
  const placed = task("placed-reply", { followUpId: "f2", workItemId: "w1" });
  const mine = task("mine");
  const check = task("check", { status: "todo", workItemId: "w1" });
  const entry = (taskId: string, s: string, e: string) => ({
    id: `e-${taskId}`,
    taskId,
    start: at(2, s),
    end: at(2, e),
    source: "followup_estimate" as const,
    respondsTo: { workItemId: "w1", waitKey: null },
  });
  const block = (taskId: string, s: string, e: string) => ({
    id: `b-${taskId}`,
    taskId,
    title: null,
    start: at(2, s),
    end: at(2, e),
  });
  const d = column({
    tasks: [reply, placed, mine, check],
    timeEntries: [
      entry("reply", "10:12", "10:20"),
      { ...entry("mine", "09:00", "09:30"), respondsTo: null },
    ],
    timeBlocks: [block("placed-reply", "15:00", "15:30"), block("check", "16:00", "16:30")],
  });
  test("時間ブロック無しで完了した自分の番のタスクだけを replies に分ける", () => {
    const p = placementsOf(d);
    expect(p.replies.map((x) => x.task.id)).toEqual(["reply"]);
    expect(p.placed.map((x) => x.task.id).sort()).toEqual(["check", "mine", "placed-reply"]);
    expect(p.placed.every((x) => !isReply(x))).toBe(true);
  });
});

describe("D-074: 3日ボードのキャッシュキー（m2-api 20章）", () => {
  test("前後10日の範囲のイベントで無効化する", () => {
    const k = keys.boardAround("2026-10-02");
    expect(overlaps(k, ["2026-10-05"])).toBe(true);
    expect(overlaps(k, ["2026-09-23"])).toBe(true);
    expect(overlaps(k, ["2026-10-13"])).toBe(false);
  });
});
