import { describe, expect, test } from "bun:test";
import {
  deferFollowUpInQueue,
  type QueueItem,
  type QueueResponse,
  type SseEventType,
} from "@turnlane/core/web";
import {
  HOUR_PX,
  SCROLL_PAD_PX,
  snapScroll,
  visibleDates,
  weightOf,
} from "../src/board/geometry.ts";
import { totalsParts, visibleTotals } from "../src/board/totals.ts";
import {
  type EventData,
  needsFullRefresh,
  overlaps,
  shouldInvalidate,
} from "../src/data/invalidate.ts";
import { visibleQueue } from "../src/data/queries.ts";
import { keyName } from "../src/keys/keymap.ts";
import { matchIds } from "../src/keys/use-keys.ts";

describe("SSE → 無効化（m2-api.md 4.3）", () => {
  const today = "2026-10-02";
  test("board は日付の範囲、day は一致", () => {
    expect(overlaps(["board", "2026-10-01", "2026-10-07"], ["2026-10-03"])).toBe(true);
    expect(overlaps(["board", "2026-10-01", "2026-10-07"], ["2026-10-08"])).toBe(false);
    expect(overlaps(["day", "2026-10-02"], ["2026-10-02"])).toBe(true);
  });
  test("day は前日の論理日のイベントでも無効化する（0:00〜日付区切りは前日の論理日。D-054）", () => {
    // 深夜 3:50 に動いた AI は論理日 10/5 で届く。暦日 10/6 のデイビューを更新する
    expect(overlaps(["day", "2026-10-06"], ["2026-10-05"])).toBe(true);
    expect(
      shouldInvalidate(["day", "2026-10-06"], "work_item", { dates: ["2026-10-05"] }, "2026-10-05"),
    ).toBe(true);
    expect(shouldInvalidate(["day", "2026-10-06"], "follow_up", {}, "2026-10-05")).toBe(true);
    expect(overlaps(["day", "2026-10-06"], ["2026-10-04"])).toBe(false);
    expect(overlaps(["day", "2026-10-06"], ["2026-10-07"])).toBe(false);
  });
  test.each<[SseEventType, readonly unknown[], EventData, boolean]>([
    ["task", ["inbox"], { dates: [], inbox: true }, true],
    ["task", ["inbox"], { dates: ["2026-10-02"], inbox: false }, false],
    ["work_item", ["queue"], { dates: [] }, true],
    ["work_item", ["workItem", "w1"], { ids: ["w1"] }, true],
    ["work_item", ["workItem", "w2"], { ids: ["w1"] }, false],
    ["follow_up", ["board", "2026-10-01", "2026-10-03"], {}, true],
    ["follow_up", ["board", "2026-10-05", "2026-10-09"], {}, false],
    ["calendar", ["queue"], { dates: [today] }, false],
    // カレンダーの一覧（役割・Turnlane の中の色。D-125）は calendars: true のときだけ
    ["calendar", ["settings", "calendars"], { dates: [today], calendars: true }, true],
    ["calendar", ["settings", "calendar-status"], { dates: [today], calendars: true }, true],
    ["calendar", ["calendars", "writable"], { dates: [today], calendars: true }, true],
    ["calendar", ["settings", "calendars"], { dates: [today] }, false],
    ["calendar", ["settings", "general"], { dates: [today], calendars: true }, false],
    ["plan_guide", ["board", today, today], { dates: [today] }, true],
    ["source", ["sources"], {}, true],
    ["day_boundary", ["inbox"], {}, true],
    // 記録（日報）: タスク・AI・予定・計画の目安・自分の番の変化で取り直す（M4-3・D-192）
    ["task", ["dailyNote", today, "en"], { dates: [today] }, true],
    ["work_item", ["dailyNote", today, "en"], { dates: [today] }, true],
    ["work_item", ["dailyNote", "2026-09-30", "en"], { dates: [today] }, false],
    ["calendar", ["dailyNote", today, "en"], { dates: [today] }, true],
    ["plan_guide", ["dailyNote", today, "ja"], { dates: [today] }, true],
    ["follow_up", ["dailyNote", today, "en"], {}, true],
    // 日報の AI 要約（M4-6）は記録だけ
    ["daily_note", ["dailyNote", today, "en"], { dates: [today] }, true],
    ["daily_note", ["dailyNote", "2026-10-01", "en"], { dates: [today] }, false],
    ["daily_note", ["board", today, today], { dates: [today] }, false],
  ])("%s → %j = %s", (type, key, data, want) => {
    expect(shouldInvalidate(key, type, data, today)).toBe(want);
  });
  test("再接続: bootId が変わった、または rev が合わなければ全部無効化", () => {
    expect(needsFullRefresh(null, { bootId: "a", rev: 3 })).toBe(false);
    expect(needsFullRefresh({ bootId: "a", lastRev: 3 }, { bootId: "a", rev: 3 })).toBe(false);
    expect(needsFullRefresh({ bootId: "a", lastRev: 3 }, { bootId: "a", rev: 5 })).toBe(true);
    expect(needsFullRefresh({ bootId: "a", lastRev: 3 }, { bootId: "b", rev: 3 })).toBe(true);
  });
});

describe("週表示の寸法（ux-mvp 4.4.0）", () => {
  test("平日は同じ幅、週末は 0.6 倍", () => {
    // 週表示は今日も平日と同じ幅（D-074。今日の AI レーンは3日ボードだけ）
    expect(weightOf("2026-10-02")).toBe(1);
    expect(weightOf("2026-10-03")).toBe(0.6);
    expect(weightOf("2026-10-05")).toBe(1);
  });
  test("昨日・今日・以降。幅が足りなければ未来の日数を減らす", () => {
    expect(visibleDates("2026-10-02", 2000)[0]).toBe("2026-10-01");
    expect(visibleDates("2026-10-02", 2000).length).toBeGreaterThan(
      visibleDates("2026-10-02", 900).length,
    );
    expect(visibleDates("2026-10-02", 300)).toEqual(["2026-10-01", "2026-10-02"]);
  });
});

describe("キーボード（M2-7）", () => {
  const ev = (key: string, p: Partial<KeyboardEvent> = {}) =>
    ({
      key,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      ...p,
    }) as KeyboardEvent;
  test("表記", () => {
    expect(keyName(ev("j"))).toBe("j");
    expect(keyName(ev("J", { shiftKey: true }))).toBe("shift+j");
    expect(keyName(ev("?", { shiftKey: true }))).toBe("?");
    expect(keyName(ev("k", { metaKey: true }))).toBe("mod+k");
    expect(keyName(ev(" "))).toBe("space");
    expect(keyName(ev("Backspace", { metaKey: true }))).toBe("mod+backspace");
  });
  test("g 始まりの2打鍵", () => {
    expect(matchIds("g", null)).toEqual({ ids: [], prefix: true });
    expect(matchIds("q", "g").ids).toEqual(["goQueue"]);
    expect(matchIds("x", null).ids).toEqual(["select"]);
    expect(matchIds("r", "g").ids).toEqual(["goRecord"]);
    expect(
      matchIds(
        keyName({ key: "Enter", metaKey: true, ctrlKey: false, shiftKey: false, altKey: false }),
        null,
      ).ids,
    ).toEqual(["detail"]);
  });
});

describe("ヘッダの集計の省き方（W6、D-050）", () => {
  const H = 3_600_000;
  const zero = {
    freeMs: 0,
    eventsMs: 0,
    plannedMs: 0,
    plannedUnestimated: 0,
    doneCount: 0,
    taskCount: 0,
    aiMs: 0,
    idleMs: 0,
    expired: 0,
  };
  const t = (k: string) => k.slice(7);
  test("今日: Events → Planned → Free の順に省き、Idle と Expired は残す", () => {
    const parts = totalsParts(
      {
        phase: "today",
        totals: {
          ...zero,
          freeMs: 8 * H,
          eventsMs: H,
          plannedMs: 2 * H,
          idleMs: H / 2,
          expired: 1,
        },
      },
      t,
    );
    const texts = (n: number) => visibleTotals(parts, n).map((p) => p.text.split(" ")[0]);
    expect(texts(0)).toEqual(["free", "events", "planned", "idle", "expired"]);
    expect(texts(1)).toEqual(["free", "planned", "idle", "expired"]);
    expect(texts(2)).toEqual(["free", "idle", "expired"]);
    expect(texts(3)).toEqual(["idle", "expired"]);
  });
  test("過去: AI → done の順に省き、Idle は残す", () => {
    const parts = totalsParts(
      { phase: "past", totals: { ...zero, doneCount: 6, taskCount: 8, aiMs: 3 * H, idleMs: H } },
      t,
    );
    expect(visibleTotals(parts, 1).map((p) => p.text)).toEqual(["6/8 done", "idle 1h"]);
    expect(visibleTotals(parts, 2).map((p) => p.text)).toEqual(["idle 1h"]);
  });
});

describe("時間軸の初期スクロール（8:00 のラベルを切らない）", () => {
  test("勤務開始を含む時刻の線が上端から SCROLL_PAD_PX に来る", () => {
    // 時間軸の起点から 4h42m（8:42）→ 4時間目の線（8:00）
    expect(snapScroll(4.7 * HOUR_PX)).toBe(4 * HOUR_PX - SCROLL_PAD_PX);
    expect(snapScroll(0)).toBe(0);
    // 線の直前（上端の余白の内側）なら、その線を基準にする
    expect(snapScroll(5 * HOUR_PX - 5)).toBe(5 * HOUR_PX - SCROLL_PAD_PX);
  });
});

describe("m 明日の楽観的更新（D-052 (1)）", () => {
  test("フォローアップをスヌーズ中にしてタスクの日付を移す。帯（visibleQueue）から消える", () => {
    const fu = {
      id: "f1",
      kind: "reply" as const,
      status: "open" as const,
      title: { t: "text" as const, text: "x" },
      triggerAt: 0,
      snoozeUntil: null,
      engagedAt: null,
      expiresAt: null,
      taskId: "t1",
      taskDate: "2026-10-02",
      task: null,
    };
    const item = {
      workItemId: "w1",
      title: "x",
      status: "your_turn",
      reason: null,
      estimated: false,
      repoRoot: null,
      branch: null,
      prRef: null,
      sources: [],
      waitingSince: 0,
      waitStartedAway: false,
      followUps: [fu],
    } as QueueItem;
    const q = { items: [item] } as unknown as QueueResponse;
    const r = deferFollowUpInQueue(q, "f1", "2026-10-05");
    expect(r.items[0]?.followUps[0]).toMatchObject({ status: "snoozed", taskDate: "2026-10-05" });
    expect(visibleQueue(r.items)).toEqual([]);
    expect(visibleQueue(q.items)).toHaveLength(1);
  });
});
