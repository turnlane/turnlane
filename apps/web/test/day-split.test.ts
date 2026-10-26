/**
 * 表示の日付と集計の日付（D-054、ux-mvp 4.4.1）: 列への割り当て、0:00 をまたぐブロック、ホバーの文言、
 * 計画の目安の窓と AI レーンの上端（D-105・D-106）。TZ は Asia/Tokyo、日付区切り 04:00。
 */
import { describe, expect, test } from "bun:test";
import { clip, type DayColumn, fmtClock, type TaskView, wallToEpoch } from "@turnlane/core/web";
import { countedInDate, laneTopOf, placementsOf, planWindows } from "../src/board/day-split.ts";
import { overlaps } from "../src/data/invalidate.ts";
import { translate } from "../src/i18n/index.tsx";

const TZ = "Asia/Tokyo";
const MIN = 60_000;
/** 2026-10-<day> の hh:mm（JST） */
const at = (day: number, hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  return wallToEpoch(2026, 10, day, h * 60 + m, TZ);
};

function task(id: string, date: string, p: Partial<TaskView> = {}): TaskView {
  return {
    id,
    title: { t: "text", text: id },
    status: "todo",
    scheduledDate: date,
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

/** 暦日 10/<day> の列（axis = 0:00〜翌 0:00、logical = 4:00〜翌 4:00） */
function column(day: number, p: Partial<DayColumn> = {}): DayColumn {
  const date = `2026-10-${String(day).padStart(2, "0")}`;
  return {
    date,
    phase: "today",
    logicalPhase: "today",
    axis: { start: at(day, "00:00"), end: at(day + 1, "00:00") },
    logical: { start: at(day, "04:00"), end: at(day + 1, "04:00") },
    workday: true,
    plannedHours: null,
    allDayEvents: [],
    events: [],
    tasks: [],
    crossTasks: [],
    timeBlocks: [],
    timeEntries: [],
    totals: {
      freeMs: 0,
      eventsMs: 0,
      plannedMs: 0,
      plannedUnestimated: 0,
      doneCount: 0,
      taskCount: 0,
      aiMs: 0,
      idleMs: 0,
      expired: 0,
    },
    aiRibbon: [],
    aiLane: null,
    ...p,
  };
}

describe("0:00 をまたぐブロックは両日の列に分けて描く", () => {
  // 10/4 のタスクを 23:30–00:30 に置いた。サーバーは 10/4 の列に tasks、10/5 の列に crossTasks として返す
  const late = task("late", "2026-10-04");
  const block = {
    id: "b1",
    taskId: "late",
    title: null,
    start: at(4, "23:30"),
    end: at(5, "00:30"),
  };
  const d4 = column(4, { phase: "past", tasks: [late], timeBlocks: [block] });
  const d5 = column(5, { crossTasks: [late], timeBlocks: [block] });

  test("10/4 の列は 23:30〜24:00、10/5 の列は 0:00〜0:30", () => {
    const p4 = placementsOf(d4);
    const p5 = placementsOf(d5);
    expect(p4.placed.map((p) => [p.task.id, p.cross])).toEqual([["late", false]]);
    expect(p5.placed.map((p) => [p.task.id, p.cross])).toEqual([["late", true]]);
    const c4 = clip((p4.placed[0] as { at: { start: number; end: number } }).at, d4.axis);
    const c5 = clip((p5.placed[0] as { at: { start: number; end: number } }).at, d5.axis);
    expect([fmtClock(c4?.start ?? 0, TZ), (c4?.end ?? 0) - (c4?.start ?? 0)]).toEqual([
      "23:30",
      30 * MIN,
    ]);
    expect([fmtClock(c5?.start ?? 0, TZ), (c5?.end ?? 0) - (c5?.start ?? 0)]).toEqual([
      "0:00",
      30 * MIN,
    ]);
  });

  test("前日のタスクは Unscheduled に入れない（描くためだけに置く）", () => {
    const d = column(5, { crossTasks: [task("x", "2026-10-04")] });
    expect(placementsOf(d)).toEqual({ placed: [], unscheduled: [], replies: [] });
  });

  test("その日のタスクのブロックが翌日の 0:00 以降だけでも Unscheduled にしない", () => {
    const t = task("night", "2026-10-04");
    const b = { ...block, id: "b2", taskId: "night", start: at(5, "01:00"), end: at(5, "01:30") };
    const p = placementsOf(column(4, { tasks: [t], timeBlocks: [b] }));
    expect(p.unscheduled).toEqual([]);
    // 10/4 の列の時間軸の外なので描かれない（10/5 の列に描く）
    expect(clip((p.placed[0] as { at: { start: number; end: number } }).at, column(4).axis)).toBe(
      null,
    );
  });
});

describe("ホバーの `Counted in`（0:00〜日付区切りのブロックは前日に計上）", () => {
  const d5 = column(5);
  test.each<[string, string, string, string | null]>([
    ["深夜 1:00–1:30 は前日", "01:00", "01:30", "2026-10-04"],
    ["23:30–0:30 の 10/5 側（0:00 から）は前日", "-23:30", "00:30", "2026-10-04"],
    ["3:59 開始は前日", "03:59", "04:30", "2026-10-04"],
    ["4:00 開始はその日", "04:00", "05:00", null],
    ["昼はその日", "13:00", "14:00", null],
  ])("%s", (_name, s, e, want) => {
    const start = s.startsWith("-") ? at(4, s.slice(1)) : at(5, s);
    expect(countedInDate(d5, { start, end: at(5, e) })).toBe(want);
  });
  test("文言（英語・日本語）", () => {
    expect(translate("en", "board.countedIn", { day: "Sun 10/4" })).toBe("Counted in Sun 10/4");
    expect(translate("ja", "board.countedIn", { day: "日 10/4" })).toBe("日 10/4 に計上");
  });
});

describe("計画の目安の窓と AI レーンの上端（D-105・D-106）", () => {
  const planned = { start: at(5, "10:00"), end: at(5, "19:00") };
  test("計画の目安の窓は稼働日だけ（背景は一様で塗り分けない）", () => {
    expect(planWindows(column(5, { plannedHours: planned }))).toEqual([planned]);
    expect(planWindows(column(6, { workday: false }))).toEqual([]);
  });
  test("持ち越しのブロックの上端: 今日は計画の目安の開始と今の早い方、他の日は計画の目安の開始", () => {
    const d = column(5, { plannedHours: planned });
    expect(fmtClock(laneTopOf(d, at(5, "08:10")), TZ)).toBe("8:10");
    expect(fmtClock(laneTopOf(d, at(5, "13:00")), TZ)).toBe("10:00");
    expect(laneTopOf(column(5, { plannedHours: null }), at(5, "13:00"))).toBe(at(5, "13:00"));
    expect(laneTopOf(column(4, { phase: "past", plannedHours: null }), at(5, "13:00"))).toBe(
      at(4, "00:00"),
    );
    expect(
      fmtClock(
        laneTopOf(
          column(6, {
            phase: "future",
            plannedHours: { start: at(6, "09:00"), end: at(6, "18:00") },
          }),
          0,
        ),
        TZ,
      ),
    ).toBe("9:00");
  });
});

describe("SSE の無効化: board は前日の論理日のイベントでも取り直す", () => {
  test("10/5〜10/7 の週ボードは 10/4（深夜のターンの論理日）の変化で取り直す", () => {
    expect(overlaps(["board", "2026-10-05", "2026-10-07"], ["2026-10-04"])).toBe(true);
    expect(overlaps(["board", "2026-10-05", "2026-10-07"], ["2026-10-03"])).toBe(false);
  });
});

describe("タスクに時間ブロックが複数ある（他の日に残ったブロック）", () => {
  // MCP の schedule_task で日付と時刻を何度か変えたタスク。前の日付のブロックが消えずに残り、サーバーは
  // 「この列のタスクのブロック」として他の日のものも timeBlocks に入れて返す（start の昇順）
  const blk = (id: string, taskId: string, day: number, hhmm: string, min = 5) => ({
    id,
    taskId,
    title: null,
    start: at(day, hhmm),
    end: at(day, hhmm) + min * MIN,
  });

  test("この列の時間軸にかかるブロックで置く（先頭の別の日のブロックで置かない）", () => {
    const x = task("moved", "2026-10-13", { estimateMin: 5 });
    const d = column(13, {
      tasks: [x],
      timeBlocks: [
        blk("old1", "moved", 12, "20:00"),
        blk("old2", "moved", 12, "23:00"),
        blk("cur", "moved", 13, "20:00"),
      ],
    });
    const p = placementsOf(d);
    expect(p.unscheduled).toEqual([]);
    expect(p.placed).toHaveLength(1);
    expect(p.placed[0]?.at).toEqual({ start: at(13, "20:00"), end: at(13, "20:05") });
    expect(p.placed[0]?.block?.id).toBe("cur");
  });

  test("この列にかかるブロックが無ければ未定に出す（他の日のブロックだけでは消さない）", () => {
    const x = task("stale", "2026-10-17", { estimateMin: 5 });
    const shown = task("shown", "2026-10-17", { estimateMin: 30 });
    const d = column(17, {
      tasks: [shown, x],
      timeBlocks: [blk("old1", "stale", 14, "12:00"), blk("old2", "stale", 16, "23:00")],
    });
    const p = placementsOf(d);
    expect(p.placed).toEqual([]);
    expect(p.unscheduled.map((t) => t.id)).toEqual(["shown", "stale"]);
  });

  test("その日の論理日のうち翌日 0:00 以降に置いたブロックは、未定にしない（翌日の列に描く）", () => {
    const x = task("late", "2026-10-13");
    const d = column(13, {
      tasks: [x],
      timeBlocks: [blk("old", "late", 11, "10:00"), blk("night", "late", 14, "01:00", 30)],
    });
    const p = placementsOf(d);
    expect(p.unscheduled).toEqual([]);
    expect(p.placed[0]?.block?.id).toBe("night");
  });

  test("前日の日付のタスク（crossTasks）は、この列の時間軸にかかるブロックだけで置く", () => {
    const x = task("prev", "2026-10-12");
    const d = column(13, {
      crossTasks: [x],
      timeBlocks: [blk("old", "prev", 12, "08:00"), blk("cross", "prev", 13, "00:30", 30)],
    });
    const p = placementsOf(d);
    expect(p.placed.map((q) => q.block?.id)).toEqual(["cross"]);
    expect(p.placed[0]?.cross).toBe(true);
  });
});
