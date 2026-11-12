/** 予定を取り込む範囲の外の日の 1 行（0.8.2）: つながっているときだけ、範囲の外の日だけ */
import { describe, expect, test } from "bun:test";
import type { CalendarStatusView } from "@turnlane/daemon";
import { outsideSyncWindow, syncWindowOf } from "../src/components/SyncRangeNote.tsx";
import { translate } from "../src/i18n/index.tsx";

const status = (p: { connected: boolean; total: number }): CalendarStatusView =>
  ({
    connected: p.connected,
    calendars: { total: p.total, source: p.total, ignored: 0 },
    window: { from: "2026-11-05", to: "2027-02-10", pastDays: 7, futureDays: 90 },
  }) as unknown as CalendarStatusView;

describe("取り込む範囲の外の日", () => {
  test("つながっていて 1 つ以上のカレンダーがあるときだけ範囲を返す", () => {
    expect(syncWindowOf(status({ connected: true, total: 2 }))).toEqual({
      from: "2026-11-05",
      to: "2027-02-10",
      pastDays: 7,
      futureDays: 90,
    });
    expect(syncWindowOf(status({ connected: false, total: 2 }))).toBeNull();
    expect(syncWindowOf(status({ connected: true, total: 0 }))).toBeNull();
    expect(syncWindowOf(undefined)).toBeNull();
  });

  test("範囲の外（from より前・to より後）だけ。端の日は範囲の中", () => {
    const w = syncWindowOf(status({ connected: true, total: 1 }));
    expect(outsideSyncWindow("2026-11-04", w)).toBe(true);
    expect(outsideSyncWindow("2026-11-05", w)).toBe(false);
    expect(outsideSyncWindow("2027-02-10", w)).toBe(false);
    expect(outsideSyncWindow("2027-02-11", w)).toBe(true);
    expect(outsideSyncWindow("2027-02-11", null)).toBe(false);
  });

  test("文言は日数から組む（ja / en）", () => {
    expect(translate("ja", "calendar.outsideWindow", { past: 7, future: 90 })).toBe(
      "予定はまだ取り込んでいません（取り込む範囲は 7 日前から 90 日後まで）",
    );
    expect(translate("en", "calendar.outsideWindow", { past: 7, future: 90 })).toBe(
      "Events aren't synced for this day (synced range: 7 days back to 90 days ahead)",
    );
  });
});
