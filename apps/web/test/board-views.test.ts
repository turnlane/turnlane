/**
 * 常用フィードバック（D-075。ux-mvp 4.4.0・4.4・4.5・6章）: 3日ボードの今日の列のレーン、閉じた待ちの終わりの点
 * （返答との結び付け・ホバーの文・位置）、ビューのキー（⌘1〜⌘3・g の2打鍵）と ⌘K の行。TZ は Asia/Tokyo。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type TaskView, type TimeEntryView, wallToEpoch } from "@turnlane/core/web";
import type { Placement } from "../src/board/day-split.ts";
import { DAY_LANES, TODAY_LANES } from "../src/board/geometry.ts";
import {
  DOT_GAP_PX,
  DOT_PX,
  layoutWaitDots,
  openWaitKeys,
  type WaitEnd,
  waitEndsOf,
  waitEndText,
} from "../src/board/wait-ends.ts";
import { makeI18n, translate } from "../src/i18n/index.tsx";
import { KEYMAP, keyHint, keyName } from "../src/keys/keymap.ts";
import { matchIds } from "../src/keys/use-keys.ts";
import { type BuildInput, buildSections } from "../src/palette/model.ts";

const TZ = "Asia/Tokyo";
const at = (hhmm: string, day = 2) => {
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
    followUpId: "f",
    workItemId: "w1",
    createdAt: 0,
    deletedAt: null,
    ...p,
  };
}

const reply = (id: string, s: string, e: string, workItemId = "w1"): Placement => ({
  task: task(id, { workItemId }),
  at: { start: at(s), end: at(e) },
  variant: "done",
  overlapMs: 0,
  cross: false,
  block: null,
});
const entry = (
  taskId: string,
  s: string,
  respondsTo: TimeEntryView["respondsTo"],
): TimeEntryView => ({
  id: `e-${taskId}`,
  taskId,
  start: at(s),
  end: at(s) + 60_000,
  source: "followup_estimate",
  respondsTo,
});
const seg = (waitKey: string, s: string, e: string, open = false, endReason?: string) => ({
  waitKey,
  start: at(s),
  end: at(e),
  open,
  ...(endReason ? { endReason } : {}),
});

describe("今日の列のレーン（D-117 で D-075 の2レーンに戻した。3レーンはデイビューだけ）", () => {
  test("3日ボード: 予定・自分の1レーン 56% / AI 44%", () => {
    expect(TODAY_LANES).toEqual({ plan: { left: 0, width: 56 }, ai: { left: 56, width: 44 } });
  });
  test("デイビューは 予定 27 / 自分 29 / AI 44 の3レーン", () => {
    expect([DAY_LANES.events.width, DAY_LANES.me.width, DAY_LANES.ai.width]).toEqual([27, 29, 44]);
    expect(DAY_LANES.ai.left).toBe(56);
  });
  test("3日ボードの今日の列の見出しは「予定 · 自分」と「AI」、レーンの間に区切りの縦線", () => {
    const src = readFileSync(join(import.meta.dir, "../src/board/WeekBoard.tsx"), "utf8");
    expect(src).toContain('(["plan", "ai"] as const)');
    expect(src).not.toContain('(["events", "me", "ai"] as const)');
    expect(src).toContain("<LaneDivider left={L.ai.left} />");
    // 予定と自分を分けない（入れ子の1レーン）
    expect(src).not.toMatch(/data-lane="events"/);
  });
});

describe("閉じた待ちの終わり（ux-mvp 4.4・4.5、D-075）", () => {
  const items = [
    {
      id: "w1",
      waits: [
        // 閉じた待ち k1（猶予 → 放置。終点 10:20）
        seg("k1", "10:00", "10:15"),
        seg("k1", "10:15", "10:20", false, "human_input"),
        // 閉じた待ち k2（終点 11:30）
        seg("k2", "11:00", "11:30", false, "resolved"),
        // 開いている待ち k3（目立たせる）
        seg("k3", "13:00", "13:10"),
        seg("k3", "13:10", "13:20", true),
      ],
    },
    { id: "w2", waits: [seg("m1", "09:00", "09:05")] },
  ];

  test("開いている区間を持つ待ちは閉じた待ちにしない", () => {
    expect([...openWaitKeys(items[0]?.waits ?? [])]).toEqual(["k3"]);
    const ends = waitEndsOf(items, [], []);
    expect(ends.map((e) => [e.id, e.at])).toEqual([
      ["w2:m1", at("09:05")],
      ["w1:k1", at("10:20")],
      ["w1:k2", at("11:30")],
    ]);
    expect(ends.find((e) => e.id === "w1:k2")?.endReason).toBe("resolved");
  });

  test("返答は実績の respondsTo の待ちに、無ければ終点の近い閉じた待ちに結ぶ（1つの待ちに1つ）", () => {
    const r1 = reply("r1", "11:31", "11:34"); // respondsTo k1 を指す（終点は遠くても k1）
    const r2 = reply("r2", "10:21", "10:24"); // waitKey 無し → 残りのうち近い k2
    const r3 = reply("r3", "15:00", "15:02"); // w1 の閉じた待ちは埋まった → 返答の時刻に点だけ
    const ends = waitEndsOf(
      items,
      [r1, r2, r3],
      [
        entry("r1", "11:31", { workItemId: "w1", waitKey: "k1" }),
        entry("r2", "10:21", { workItemId: "w1", waitKey: null }),
      ],
    );
    const by = (id: string) => ends.find((e) => e.id === id);
    expect(by("w1:k1")?.reply?.task.id).toBe("r1");
    expect(by("w1:k2")?.reply?.task.id).toBe("r2");
    expect(by("reply:r3")).toMatchObject({ itemId: "w1", waitKey: null, at: at("15:00") });
    expect(by("w2:m1")?.reply).toBeNull();
  });

  test("ホバーの文: 返答は `replied 13:40 · 3m`、無ければ閉じ方か終わった時刻", () => {
    const en = makeI18n("en").t;
    const ja = makeI18n("ja").t;
    const base: WaitEnd = {
      id: "w1:k1",
      itemId: "w1",
      waitKey: "k1",
      at: at("13:38"),
      reply: reply("r", "13:40", "13:43"),
      endReason: "human_input",
    };
    expect(waitEndText(base, en, TZ)).toBe("replied 13:40 · 3m");
    expect(waitEndText(base, ja, TZ)).toBe("13:40 に返答 · 3m");
    const none = { ...base, reply: null };
    expect(waitEndText(none, en, TZ)).toBe("replied 13:38");
    expect(waitEndText({ ...none, endReason: "resolved" }, en, TZ)).toBe("resolved 13:38");
    expect(waitEndText({ ...none, endReason: "resolved" }, ja, TZ)).toBe("13:38 に解決");
    expect(waitEndText({ ...none, endReason: null }, en, TZ)).toBe("ended 13:38");
    expect(waitEndText({ ...none, endReason: null }, ja, TZ)).toBe("13:38 に終了");
  });

  test("点は待ちの終点に下端を合わせ、同じ列で重なれば下へずらす。時間軸の外は置かない", () => {
    const axis = { start: at("00:00"), end: at("00:00", 3) };
    const pxPerMs = 60 / 3_600_000;
    const end = (id: string, hhmm: string, day = 2): WaitEnd => ({
      id,
      itemId: id === "c" ? "w2" : "w1",
      waitKey: id,
      at: at(hhmm, day),
      reply: null,
      endReason: null,
    });
    const dots = layoutWaitDots(
      [end("a", "10:12"), end("b", "10:13"), end("c", "10:13"), end("x", "01:00", 3)],
      axis,
      pxPerMs,
      (e) => (e.itemId === "w2" ? { column: 1, columns: 2 } : { column: 0, columns: 2 }),
    );
    const y = (hhmm: string) => (at(hhmm) - axis.start) * pxPerMs - DOT_PX;
    expect(dots).toEqual([
      { id: "a", top: y("10:12"), column: 0, columns: 2 },
      { id: "b", top: y("10:12") + DOT_GAP_PX, column: 0, columns: 2 },
      { id: "c", top: y("10:13"), column: 1, columns: 2 },
    ]);
  });
});

describe("ビューのキー（ux-mvp 6章、D-075）", () => {
  const ev = (key: string, meta = false) => ({
    key,
    metaKey: meta,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
  });
  test("⌘1 3日ボード / ⌘2 週表示 / ⌘3 デイビュー", () => {
    expect(matchIds(keyName(ev("1", true)), null).ids).toEqual(["viewThree"]);
    expect(matchIds(keyName(ev("2", true)), null).ids).toEqual(["viewWeek"]);
    expect(matchIds(keyName(ev("3", true)), null).ids).toEqual(["viewDay"]);
  });
  test("g の2打鍵", () => {
    const g = (k: string) => matchIds(k, "g").ids;
    expect(g("b")).toEqual(["goBoard"]);
    expect(g("w")).toEqual(["viewWeek"]);
    expect(g("d")).toEqual(["goDayToday"]);
    expect(g("y")).toEqual(["goQueue"]);
    expect(g("q")).toEqual(["goQueue"]);
    expect(g("i")).toEqual(["goInbox"]);
    expect(g("r")).toEqual(["goRecord"]);
    expect(g("p")).toEqual([]);
    expect(g("s")).toEqual(["goSettings"]);
    expect(matchIds("g", null)).toEqual({ ids: [], prefix: true });
  });
  test("w は残す。グローバルのキーは重複しない", () => {
    expect(matchIds("w", null).ids).toEqual(["toggleWeek"]);
    const global = KEYMAP.filter((d) => d.scope === "global").flatMap((d) => d.keys);
    expect(new Set(global).size).toBe(global.length);
  });
  test("ツールチップの表記", () => {
    expect(keyHint("viewThree")).toBe("⌘1");
    expect(keyHint("viewWeek")).toBe("⌘2 / g w");
    expect(keyHint("viewDay")).toBe("⌘3");
  });
});

describe("⌘K の Go to（ux-mvp 6.1、D-075）", () => {
  const input = (q: string): BuildInput => {
    const i18n = makeI18n("en");
    return {
      q,
      category: "goto",
      t: i18n.t,
      tEn: (k, x) => translate("en", k, x),
      shortDate: i18n.shortDate,
      titleOf: (x) => (x.t === "text" ? x.text : ""),
      today: "2026-10-05",
      now: Date.parse("2026-10-05T13:20:00+09:00"),
      tz: TZ,
      selection: [],
      queue: [],
      recent: [],
      search: undefined,
      theme: "dark",
      language: "en",
      hooksText: null,
      calendarText: null,
    };
  };
  const row = (q: string, id: string) =>
    buildSections(input(q))
      .flatMap((s) => s.rows)
      .find((r) => r.id === id);
  test("3 days / Week はキーの処理を呼び、各行にキーを出す", () => {
    expect(row("3 days", "goto:three")).toMatchObject({
      keys: ["mod+1"],
      run: { t: "key", id: "viewThree" },
    });
    expect(row("week", "goto:weekView")).toMatchObject({
      keys: ["mod+2", "g w"],
      run: { t: "key", id: "viewWeek" },
    });
    expect(row("day", "goto:day")?.keys).toEqual(["mod+3"]);
    expect(row("your", "goto:queue")?.keys).toEqual(["g y"]);
    expect(row("daily note", "goto:record")?.keys).toEqual(["g r"]);
  });
});
