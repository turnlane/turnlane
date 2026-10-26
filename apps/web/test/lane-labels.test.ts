/**
 * AI レーンの札の置き場所（board/lane-labels.ts）: 題名が先、札は題名・ほかの札・今の線に重ねない。
 * 置けない札は null（ホバー）。デイビューの 16:30〜17:50（離れていた間の網掛け D-224 の上で 会議中・タスクなし・
 * 離席 · 数えない・放置 が重なった）に近い並びで確かめる
 */
import { describe, expect, test } from "bun:test";
import { belowNow, NOW_GAP_PX, placeTags, type TagRequest } from "../src/board/lane-labels.ts";

const TAG = 16;
const ask = (id: string, want: number, lo: number, hi: number, weight = 1): TagRequest => ({
  id,
  want,
  lo,
  hi,
  weight,
  minLeft: 16,
});
const overlaps = (a: { top: number; height: number }, b: { top: number; height: number }) =>
  a.top < b.top + b.height && b.top < a.top + a.height;

describe("belowNow", () => {
  test("a label crossing the now line moves just below it", () => {
    expect(belowNow(100, 34, 120)).toBe(120 + NOW_GAP_PX);
    expect(belowNow(40, 34, 120)).toBe(40);
    expect(belowNow(100, 34, null)).toBe(100);
  });
});

describe("placeTags", () => {
  test("the away scene: no tag overlaps a title, another tag or the now line", () => {
    // 題名（2 行）: 16:22 フッター、16:50 デプロイ（許可待ち）、17:16 アクセスログ。今は 17:50
    const nowY = 300;
    const titles = [
      { top: 140, height: 34 },
      { top: 196, height: 34 },
      { top: 248, height: 34 },
    ];
    const tags = placeTags(
      [
        ask("meeting", 192, 190, 230 - TAG, 10), // 会議中（題名の高さ）
        ask("no-task", 232, 230, 254 - TAG, 5), // タスクなし（短い区間、題名に挟まれる）
        ask("away", 256, 254, 300 - TAG, 30), // 離席 · 数えない（網掛けの上）
        ask("idle", 290, 282, 300 - TAG, 1e12), // 放置 2m（今まで続く）
      ],
      titles,
      { tagPx: TAG, nowY },
    );
    const placed = [...tags.values()].filter((x) => x !== null);
    expect(placed.length).toBeGreaterThan(0);
    for (const p of placed) {
      const box = { top: p.top, height: TAG };
      for (const t of titles) expect(overlaps(box, t)).toBe(false);
      expect(p.top >= nowY + NOW_GAP_PX || p.top + TAG <= nowY - NOW_GAP_PX).toBe(true);
    }
    for (const [i, a] of placed.entries())
      for (const b of placed.slice(i + 1))
        expect(overlaps({ top: a.top, height: TAG }, { top: b.top, height: TAG })).toBe(false);
    // 放置は今の線の下へ、題名に挟まれて置けない札はホバー（null）
    expect(tags.get("idle")?.top).toBe(nowY + NOW_GAP_PX);
    expect(tags.get("no-task")).toBeNull();
  });

  test("a tag moves right of the bars running at its height", () => {
    const tags = placeTags([ask("t", 0, 0, 40)], [], {
      tagPx: TAG,
      nowY: null,
      rails: [
        { x: 30, top: 0, bottom: 20 },
        { x: 60, top: 100, bottom: 200 },
      ],
    });
    expect(tags.get("t")).toEqual({ top: 0, left: 36 });
  });

  test("tags left of the first bar collide only with each other", () => {
    const tags = placeTags(
      [
        { ...ask("a", 10, 10, 10), region: "left" },
        { ...ask("b", 10, 10, 10), region: "left" },
      ],
      [{ top: 0, height: 34 }],
      { tagPx: TAG, nowY: null },
    );
    expect(tags.get("a")?.top).toBe(10);
    expect(tags.get("b")).toBeNull();
  });
});
