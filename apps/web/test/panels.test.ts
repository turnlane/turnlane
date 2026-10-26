/** 詳細パネル（D-070）: パネルは1つだけ、Esc で閉じる、SSE で取り直すキー、時間ブロックの入力 */
import { describe, expect, test } from "bun:test";
import { shouldInvalidate } from "../src/data/invalidate.ts";
import { anyPanelOpen, getUi, setUi } from "../src/lib/store.ts";
import { atLocal, parseClock } from "../src/panel/TaskPanel.tsx";

describe("パネルは同時に1つ", () => {
  test("どれかを開くと他は閉じる", () => {
    setUi({ panelWorkItemId: "w1" });
    setUi({ panelTaskId: "t1" });
    expect(getUi()).toMatchObject({ panelWorkItemId: null, panelTaskId: "t1", panelEventId: null });
    setUi({ panelEventId: "e1" });
    expect(getUi()).toMatchObject({ panelWorkItemId: null, panelTaskId: null, panelEventId: "e1" });
    expect(anyPanelOpen(getUi())).toBe(true);
    // 閉じる（null）は他に触れない
    setUi({ panelTaskId: null });
    expect(getUi().panelEventId).toBe("e1");
    setUi({ panelEventId: null });
    expect(anyPanelOpen(getUi())).toBe(false);
  });
});

describe("SSE で取り直すキー", () => {
  const today = "2026-10-05";
  test("task はそのタスクの ID が入っていれば詳細を取り直す", () => {
    expect(shouldInvalidate(["task", "t1"], "task", { ids: ["t1"], dates: [] }, today)).toBe(true);
    expect(shouldInvalidate(["task", "t1"], "task", { ids: ["t2"], dates: [] }, today)).toBe(false);
  });
  test("calendar は予定の詳細を取り直す", () => {
    expect(shouldInvalidate(["calendarEvent", "e1"], "calendar", { dates: [] }, today)).toBe(true);
  });
});

describe("時間ブロックの入力", () => {
  test("時刻の読み取り", () => {
    expect(parseClock("9:30")).toBe(570);
    expect(parseClock("0930")).toBe(570);
    expect(parseClock("24:00")).toBeNull();
    expect(parseClock("abc")).toBeNull();
  });
  test("その日の壁時計 → epoch ms（タイムゾーンつき）", () => {
    expect(atLocal("2026-10-05", 10 * 60, "Asia/Tokyo")).toBe(
      Date.parse("2026-10-05T10:00:00+09:00"),
    );
  });
});
