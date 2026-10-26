/**
 * 離れていた間のまとめの言い方（D-214 (2)）: 時刻の区間から始め、事実（件数・何が起きたか・変更の量）だけ。挨拶や擬人化を入れない
 */
import { describe, expect, test } from "bun:test";
import type { AwayItem } from "@turnlane/core/web";
import { awayCounts, awayRange, awayWhat, changeText } from "../src/components/AwayLine.tsx";
import { translate } from "../src/i18n/index.tsx";

const TZ = "Asia/Tokyo";
const ja = (k: Parameters<typeof translate>[1], p?: Record<string, string | number>) =>
  translate("ja", k, p);
const en = (k: Parameters<typeof translate>[1], p?: Record<string, string | number>) =>
  translate("en", k, p);
/** 2026-10-16 の JST の時刻 */
const at = (hhmm: string, day = 16) => {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  return Date.UTC(2026, 9, day, h - 9, m);
};

const item = (o: Partial<AwayItem>): AwayItem => ({
  workItemId: "w",
  title: "x",
  status: "done",
  kind: "done",
  at: at("17:22"),
  followUpId: null,
  pr: null,
  change: null,
  repoRoot: null,
  branch: null,
  ...o,
});

describe("離れていた間のまとめの文", () => {
  test("同じ日は区間、夜をまたげば 昨日 HH:MM から、それより前は日付", () => {
    expect(awayRange({ from: at("17:14"), to: at("17:48") }, TZ, ja)).toBe("17:14–17:48 の間に");
    expect(awayRange({ from: at("17:14"), to: at("17:48") }, TZ, en)).toBe("17:14–17:48");
    expect(awayRange({ from: at("19:02", 15), to: at("08:35") }, TZ, ja)).toBe("昨日 19:02 から");
    expect(awayRange({ from: at("19:02", 15), to: at("08:35") }, TZ, en)).toBe(
      "Since yesterday 19:02",
    );
    expect(awayRange({ from: at("19:02", 13), to: at("08:35") }, TZ, ja)).toBe("10/13 19:02 から");
  });

  test("件数は 0 の区分を出さない", () => {
    const counts = { done: 1, pr: 1, wait: 1, error: 0 };
    expect(awayCounts({ counts }, ja)).toBe("完了 1 · PR 1 · 新しい待ち 1");
    expect(awayCounts({ counts }, en)).toBe("1 done · 1 PR · 1 new wait");
    expect(awayCounts({ counts: { done: 3, pr: 0, wait: 2, error: 1 } }, en)).toBe(
      "3 done · 2 new waits · 1 error",
    );
  });

  test("何が起きたか: 完了 · N ファイル / PR #190 を開いた / 問い · 17:41", () => {
    expect(awayWhat(item({ change: { files: 6 } }), TZ, ja)).toBe("完了 · 6 ファイル");
    expect(
      awayWhat(
        item({
          kind: "pr_opened",
          pr: { number: 190, ref: "o/r#190", url: null },
          change: { files: 4, additions: 120, deletions: 8, ci: "pass" },
        }),
        TZ,
        ja,
      ),
    ).toBe("PR #190 を開いた · 4 ファイル · +120 −8 · CI 通過");
    expect(awayWhat(item({ kind: "question", at: at("17:41") }), TZ, ja)).toBe("問い · 17:41");
    expect(awayWhat(item({ kind: "permission", at: at("17:41") }), TZ, en)).toBe(
      "Approval · 17:41",
    );
    expect(changeText({ files: 1, ci: "none" }, en)).toBe("1 file");
    expect(changeText(null, en)).toBe("");
  });

  test("挨拶・擬人化の言葉を使わない", () => {
    const all = ["ja", "en"].flatMap((l) =>
      [
        "away.range",
        "away.sinceYesterday",
        "away.count.done",
        "away.kind.done",
        "settings.turn.awaySummary.hint",
      ].map((k) => translate(l as "ja" | "en", k as Parameters<typeof translate>[1], { count: 1 })),
    );
    for (const s of all) expect(s).not.toMatch(/おかえり|お疲れ|がんばり|頑張|Welcome|hard/i);
  });
});
