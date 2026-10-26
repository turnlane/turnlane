/** オンボーディングの段の表示と画面の割り当て（onboarding.md 3章、D-184、review-onboarding §5） */
import { describe, expect, test } from "bun:test";
import { ONBOARDING_STEPS, type OnboardingStep } from "@turnlane/core/web";
import { shouldInvalidate } from "../src/data/invalidate.ts";
import { translate } from "../src/i18n/index.tsx";
import {
  autoSkipped,
  backTarget,
  daysAgo,
  hasScreen,
  startRows,
  stepMarks,
  stepPosition,
  tildePath,
  visibleCount,
} from "../src/onboarding/steps.ts";

const pending = Object.fromEntries(ONBOARDING_STEPS.map((s) => [s, "pending"])) as Record<
  OnboardingStep,
  "pending" | "done" | "skipped" | "failed"
>;

describe("段の表示", () => {
  test("今の段・済み・これから", () => {
    const marks = stepMarks({
      step: "import",
      steps: { ...pending, sources: "done" },
      consentedAt: 1,
    });
    expect(marks.map((m) => m.mark)).toEqual([
      "done",
      "current",
      "upcoming",
      "upcoming",
      "upcoming",
      "upcoming",
      "upcoming",
      "upcoming",
    ]);
    expect(stepPosition("import")).toEqual({ n: 2, total: 8 });
  });

  test("O2 の Not now の後は Import・Hooks・AI tools を飛ばした印で残す（消さない）", () => {
    const marks = stepMarks({
      step: "calendar",
      steps: { ...pending, sources: "skipped", import: "skipped" },
      consentedAt: null,
    });
    const by = Object.fromEntries(marks.map((m) => [m.step, m.mark]));
    expect(by).toMatchObject({
      sources: "skipped",
      import: "skipped",
      calendar: "current",
      hooks: "skipped",
      mcp: "skipped",
      hours: "upcoming",
    });
    expect(marks).toHaveLength(8);
  });

  test("戻るは O3 以降だけ（O2 には無い。D-184）。画面は O2〜O8 の全部にある", () => {
    expect(backTarget("sources")).toBeNull();
    expect(backTarget("import")).toBe("sources");
    for (const s of ONBOARDING_STEPS) expect(hasScreen(s)).toBe(true);
    expect(backTarget("start")).toBe("notifications");
  });

  test("戻るは、画面を出さずに飛ばした段を飛ばす（Not now の後の O4 → O2、取り込み元なしの O6 → O4）", () => {
    const declined = {
      consentedAt: null,
      steps: { ...pending, sources: "skipped", import: "skipped" } as typeof pending,
    };
    expect(backTarget("calendar", declined, false)).toBe("sources");
    expect(backTarget("hours", declined, false)).toBe("calendar");
    expect(autoSkipped("hooks", declined, false)).toBe(true);
    expect(autoSkipped("calendar", declined, false)).toBe(false);
    // 同意したが取り込み元が 0 件（O2-empty の Continue）: 取り込み・hooks・AI tools を飛ばす
    const empty = {
      consentedAt: 1,
      steps: { ...pending, sources: "done", import: "skipped" } as typeof pending,
    };
    expect(autoSkipped("import", empty, false)).toBe(true);
    expect(autoSkipped("hooks", empty, false)).toBe(true);
    expect(backTarget("hours", empty, false)).toBe("calendar");
    // 同意して取り込み元がある: hooks から戻ると O4、AI tools から戻ると hooks
    const full = {
      consentedAt: 1,
      steps: { ...pending, sources: "done", import: "done" } as typeof pending,
    };
    expect(autoSkipped("hooks", full, true)).toBe(false);
    expect(backTarget("mcp", full, true)).toBe("hooks");
    expect(backTarget("calendar", full, true)).toBe("import");
  });

  test("失敗した段はダッシュで残す", () => {
    const marks = stepMarks({
      step: "mcp",
      steps: { ...pending, sources: "done", import: "done", calendar: "skipped", hooks: "failed" },
      consentedAt: 1,
    });
    const by = Object.fromEntries(marks.map((m) => [m.step, m.mark]));
    expect(by).toMatchObject({ calendar: "skipped", hooks: "skipped", mcp: "current" });
  });
});

describe("O8 の行（4.8）", () => {
  const base = {
    steps: pending,
    consented: true,
    sources: 3,
    importDone: true,
    calendar: { connected: true, authorization: "fullAccess", calendars: 12 },
    hooks: ["installed", "receiving", "pending_trust"],
    mcp: ["installed", "installed", "installed"],
    notifications: "granted" as const,
  };
  test("全部済み（Codex の承認待ちは ◐）", () => {
    const rows = startRows(base);
    expect(rows.map((r) => [r.key, r.mark])).toEqual([
      ["import", "done"],
      ["calendar", "done"],
      ["hooks", "waiting"],
      ["mcp", "done"],
      ["notifications", "done"],
    ]);
    expect(rows[0]?.text).toEqual({ key: "onb.start.import.sources", params: { count: 3 } });
    expect(rows[2]?.text.key).toBe("onb.start.hooks.codex");
  });
  test("飛ばした・拒否した・まだ取り込み中", () => {
    const rows = startRows({
      ...base,
      importDone: false,
      calendar: { connected: true, authorization: "denied", calendars: 0 },
      hooks: ["none", "none", "none"],
      mcp: ["none", "none", "none"],
      notifications: "off",
    });
    expect(rows.map((r) => [r.key, r.mark])).toEqual([
      ["import", "waiting"],
      ["calendar", "problem"],
      ["hooks", "notSet"],
      ["mcp", "notSet"],
      ["notifications", "notSet"],
    ]);
    expect(rows[0]?.text.key).toBe("onb.start.import.rest");
    expect(rows.map((r) => r.section)).toEqual(["ai", "calendar", "ai", "ai", "notify"]);
  });
  test("同意なし（Not now）: 取り込みは未設定、hooks・AI tools の行は出さない", () => {
    const rows = startRows({ ...base, consented: false, sources: 0, calendar: null });
    expect(rows.map((r) => [r.key, r.mark])).toEqual([
      ["import", "notSet"],
      ["calendar", "notSet"],
      ["notifications", "done"],
    ]);
  });
  test("hooks が届かない（silent）は ⚠、カレンダーが 0 件は ◐", () => {
    const rows = startRows({
      ...base,
      hooks: ["silent", "installed"],
      calendar: { connected: true, authorization: "fullAccess", calendars: 0 },
    });
    expect(rows.find((r) => r.key === "hooks")?.mark).toBe("problem");
    expect(rows.find((r) => r.key === "calendar")?.mark).toBe("waiting");
  });
});

describe("小さな整形", () => {
  test("パスを ~ で短く、最終の利用の日数", () => {
    expect(tildePath("/Users/x/.claude-acme", "/Users/x")).toBe("~/.claude-acme");
    expect(tildePath("/opt/claude", "/Users/x")).toBe("/opt/claude");
    const now = new Date(2026, 9, 2, 10, 20).getTime();
    expect(daysAgo(new Date(2026, 9, 2, 0, 5).getTime(), now)).toBe(0);
    expect(daysAgo(new Date(2026, 9, 1, 23, 0).getTime(), now)).toBe(1);
    expect(daysAgo(new Date(2026, 8, 29, 9, 0).getTime(), now)).toBe(3);
  });

  test("列に入りきらなければ最後の1行を +N more にする", () => {
    expect(visibleCount(3, 5)).toEqual({ shown: 3, more: 0 });
    expect(visibleCount(8, 5)).toEqual({ shown: 4, more: 4 });
  });

  test("文言: 会話の本文は保存も送信もしない。範囲は7日だけ。Cowork を出さない（D-181・D-186）", () => {
    expect(translate("en", "onb.privacyLine")).toBe("Conversation text is never saved or sent.");
    expect(translate("ja", "onb.privacyLine")).toBe("会話の本文は保存も送信もしません。");
    expect(translate("en", "onb.sources.import")).toBe("Import the last 7 days");
    expect(translate("ja", "onb.sources.import")).toBe("直近7日分を取り込む");
    for (const l of ["en", "ja"] as const) {
      expect(translate(l, "onb.sources.desktop")).not.toContain("Cowork");
      expect(translate(l, "onb.sources.range")).not.toMatch(/30/);
    }
    expect(translate("en", "onb.sources.count", { count: 84 })).toBe("84 sessions in 7 days");
    expect(
      translate("en", "onb.import.summary", {
        time: "23h10m",
        items: translate("en", "onb.import.items", { count: 41 }),
        waits: translate("en", "onb.import.times", { count: 38 }),
      }),
    ).toBe("Last 7 days: your AI agents worked 23h10m on 41 items and waited for you 38 times.");
    expect(
      translate("ja", "onb.import.summary", {
        time: "23h10m",
        items: translate("ja", "onb.import.items", { count: 41 }),
        waits: translate("ja", "onb.import.times", { count: 38 }),
      }),
    ).toBe("直近7日、AI は 41 件の作業で 23h10m 動き、あなたを 38 回待ちました。");
  });
});

describe("SSE の無効化", () => {
  test("import_progress は進捗・列・要約を、onboarding は状態を、source は検出を取り直す", () => {
    const k = (p: string) => ["onboarding", p] as const;
    expect(shouldInvalidate(k("progress"), "import_progress", {}, "2026-10-02")).toBe(true);
    expect(shouldInvalidate(k("board"), "import_progress", {}, "2026-10-02")).toBe(true);
    expect(shouldInvalidate(k("state"), "import_progress", {}, "2026-10-02")).toBe(false);
    expect(shouldInvalidate(k("state"), "onboarding", {}, "2026-10-02")).toBe(true);
    expect(shouldInvalidate(k("detect"), "source", {}, "2026-10-02")).toBe(true);
    expect(shouldInvalidate(k("board"), "work_item", {}, "2026-10-02")).toBe(true);
  });
});
