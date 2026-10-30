/** 報告の予定（scheduled。0.8.1）の札と、報告の項目の見分け */
import { describe, expect, test } from "bun:test";
import { planLabel } from "../src/board/PlanBands.tsx";
import { translate } from "../src/i18n/index.tsx";
import { isReportItem } from "../src/panel/AiPanel.tsx";

const TZ = "Asia/Tokyo";
const AT = Date.UTC(2026, 9, 30, 13, 0); // 22:00 JST
const t = (k: Parameters<typeof translate>[1], p?: Record<string, string | number>) =>
  translate("ja", k, p);

describe("予定の札", () => {
  test("予定 · 22:00。30 分過ぎたら「予定の時刻を過ぎています」", () => {
    expect(planLabel({ at: AT, overdue: false }, AT - 60_000, TZ, t)).toBe("予定 · 22:00");
    expect(planLabel({ at: AT, overdue: false }, AT + 29 * 60_000, TZ, t)).toBe("予定 · 22:00");
    expect(planLabel({ at: AT, overdue: false }, AT + 31 * 60_000, TZ, t)).toBe(
      "予定の時刻を過ぎています",
    );
    expect(planLabel({ at: AT, overdue: true }, AT, TZ, t)).toBe("予定の時刻を過ぎています");
  });
  test("報告の項目（リポジトリが無く、出どころが報告）", () => {
    expect(
      isReportItem({
        repoRoot: null,
        sources: [{ tool: "myscript", profile: null, report: true }],
      }),
    ).toBe(true);
    expect(
      isReportItem({
        repoRoot: "/w/app",
        sources: [{ tool: "myscript", profile: null, report: true }],
      }),
    ).toBe(false);
    expect(
      isReportItem({ repoRoot: null, sources: [{ tool: "claude_code", profile: null }] }),
    ).toBe(false);
  });
});
