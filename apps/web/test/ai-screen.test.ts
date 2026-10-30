/**
 * AI の画面（ux-mvp 4.19）: 行の札と右端の時間の文言（ja / en）、節の見出し、行の 1 行の描画（件名・リポジトリ · ブランチ・
 * `2 セッション`・`サブ 2`・PR・ソースバッジ）、キー `g a`、右クリックの操作（下の節は AI の作業のメニュー）
 */
import { describe, expect, test } from "bun:test";
import { QueryClientProvider } from "@tanstack/react-query";
import { type LiveItem, type LiveLaunch, liveSections, type QueueItem } from "@turnlane/core/web";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { menuSpec } from "../src/actions/item-actions.tsx";
import { AiRow, liveLabel, liveTime, turnTime } from "../src/components/AiRow.tsx";
import { queryClient } from "../src/data/client.ts";
import { I18nProvider, makeI18n, translate } from "../src/i18n/index.tsx";
import { KEYMAP } from "../src/keys/keymap.ts";

const TZ = "Asia/Tokyo";
const MIN = 60_000;
const H = 60 * MIN;
// 2026-10-23 12:00 JST
const NOW = Date.UTC(2026, 9, 23, 3, 0);

const live = (p: Partial<LiveItem> = {}): LiveItem => ({
  id: "w1",
  title: "取り込みの再試行を入れる",
  titleSource: "ai_title",
  status: "done",
  reason: null,
  estimated: false,
  sources: [{ tool: "claude_code", profile: "main" }],
  repoRoot: "/w/turnlane",
  branch: "feat/retry",
  prRef: null,
  lastActivityAt: NOW - 80 * MIN,
  runStartedAt: null,
  process: "alive",
  liveSessions: 1,
  subagentsRunning: 0,
  launch: null,
  ...p,
});
const launch = (state: "clean" | "unmerged" | "dirty" | null, aiRunning = false): LiveLaunch => ({
  launchId: "l1",
  taskId: "t1",
  taskDone: true,
  aiRunning,
  worktree: state ? { path: "/w/turnlane-wt/x", branch: "tl/x", state } : null,
});

describe("札（ja / en）", () => {
  const cases: [Parameters<typeof liveLabel>[0], LiveItem, string, string][] = [
    ["running", live({ status: "running" }), "実行中", "Running"],
    [
      "running",
      live({ status: "running", reason: "subagent:running" }),
      "実行中 · サブだけ",
      "Running · subagents only",
    ],
    ["stopped", live({ status: "your_turn" }), "入力待ち", "Waiting for input"],
    ["stopped", live({ status: "error" }), "エラー · 対応不要にした", "Error · dismissed"],
    [
      "stopped",
      live({ status: "done" }),
      "完了 · プロセスが残っている",
      "Done · process still running",
    ],
    [
      "stale",
      live({ status: "done", lastActivityAt: NOW - 3 * 24 * H }),
      "完了 · プロセスが残っている",
      "Done · process still running",
    ],
    ["stopped", live({ process: "unknown" }), "~ 止まった", "~ Stopped"],
    ["cleanup", live({ launch: launch("unmerged") }), "worktree · 未マージ", "worktree · unmerged"],
    [
      "cleanup",
      live({ launch: launch("dirty") }),
      "worktree · 未コミット",
      "worktree · uncommitted",
    ],
    ["cleanup", live({ launch: launch("clean") }), "worktree が残っている", "worktree left"],
    [
      "cleanup",
      live({ launch: launch(null, true) }),
      "プロセスが残っている",
      "Process still running",
    ],
  ];
  for (const [section, x, ja, en] of cases)
    test(`${section}: ${en}`, () => {
      expect(liveLabel(section, x, makeI18n("ja").t)).toBe(ja);
      expect(liveLabel(section, x, makeI18n("en").t)).toBe(en);
    });
});

describe("右端の時間", () => {
  test("動いている = 今の作業の始まりから、止まっている・片付け = 最後の動きから", () => {
    const x = live({ status: "running", runStartedAt: NOW - 12 * MIN, lastActivityAt: NOW - MIN });
    expect(liveTime("running", x, NOW)).toBe("12m");
    expect(liveTime("stopped", live(), NOW)).toBe("1h20m");
    expect(liveTime("cleanup", live({ lastActivityAt: NOW - 50 * H }), NOW)).toBe("2d2h");
  });

  test("自分の番は待ち（不在の間に始まった待ちは時刻から。猶予中は残り）", () => {
    const t = makeI18n("ja").t;
    const it = {
      workItemId: "q",
      followUps: [{ id: "f", status: "open" }],
      waitingSince: NOW - 25 * MIN,
      waitStartedAway: false,
    } as unknown as QueueItem;
    expect(turnTime(it, NOW, TZ, t)).toBe("25m");
    expect(
      turnTime(
        { ...it, waitStartedAway: true, waitingSince: Date.UTC(2026, 9, 22, 13, 51) },
        NOW,
        TZ,
        t,
      ),
    ).toBe("22:51 から");
    expect(turnTime({ ...it, followUps: [], grace: { until: NOW + 12 * MIN } }, NOW, TZ, t)).toBe(
      "猶予 · あと 12m",
    );
  });
});

describe("節の見出し", () => {
  test("件数つき（ja / en）と、後での利用上限の数", () => {
    expect(translate("ja", "ai.live.running", { count: 3 })).toBe("動いている 3");
    expect(translate("en", "ai.live.cleanup", { count: 1 })).toBe("Needs cleanup 1");
    expect(translate("ja", "ai.live.laterLimit", { count: 2 })).toBe("うち利用上限 2");
    expect(translate("en", "ai.live.laterLimit", { count: 2 })).toBe("2 at usage limit");
    // 括弧の中は別の言葉（狭い画面では出さない）
    expect(
      translate("ja", "ai.live.stale", { count: 2 }) + translate("ja", "ai.live.staleWhy"),
    ).toBe("プロセスが残っている 2（最後の動きが 1 日より前）");
    expect(
      translate("en", "ai.live.stale", { count: 2 }) + translate("en", "ai.live.staleWhy"),
    ).toBe("Process still running 2 (last activity over a day ago)");
    expect(translate("ja", "nav.ai")).toBe("AI");
    expect(translate("en", "nav.ai")).toBe("AI");
  });
});

describe("プロセスが残っているだけの古い項目", () => {
  test("最後の動きが 1 日より前の 2 件は止まっているに入れず、末尾の stale に入る（止まっているの数に含めない）", () => {
    const items = [
      live({ id: "now", lastActivityAt: NOW - 80 * MIN }),
      live({ id: "d3", lastActivityAt: NOW - 3 * 24 * H, branch: "chore/tidy-links" }),
      live({ id: "d18", lastActivityAt: NOW - 18 * 24 * H, branch: "spike/csv-import" }),
    ];
    const s = liveSections(undefined, items, NOW);
    expect(s.stopped.map((x) => x.id)).toEqual(["now"]);
    expect(s.stale.map((x) => x.id)).toEqual(["d3", "d18"]);
    expect(liveTime("stale", items[1] as LiveItem, NOW)).toBe("3d");
  });
});

describe("行の描画", () => {
  const html = (locale: "ja" | "en", x: LiveItem, section: "running" | "stopped" | "cleanup") =>
    renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(
          I18nProvider,
          { locale } as Parameters<typeof I18nProvider>[0],
          createElement(AiRow, {
            row: { section, id: x.id, key: `ai:${x.id}`, live: x },
            now: NOW,
            tz: TZ,
            today: "2026-10-23",
          }),
        ),
      ),
    );

  test("件名・リポジトリ · ブランチ・札・サブ・PR・ソースバッジ・時間", () => {
    const out = html(
      "ja",
      live({
        status: "running",
        runStartedAt: NOW - 12 * MIN,
        subagentsRunning: 2,
        prRef: "example/turnlane#142",
      }),
      "running",
    );
    expect(out).toContain('data-section="running"');
    expect(out).toContain("取り込みの再試行を入れる");
    expect(out).toContain("turnlane");
    expect(out).toContain(" · feat/retry");
    expect(out).toContain("実行中");
    expect(out).toContain("サブ 2");
    expect(out).toContain("PR #142");
    expect(out).toContain("CC·main");
    expect(out).toContain(">12m<");
  });

  test("生きたセッションが 2 つなら `2 セッション`。推定の行はホバーに理由", () => {
    expect(html("ja", live({ liveSessions: 2 }), "stopped")).toContain("2 セッション");
    expect(html("en", live({ liveSessions: 2 }), "stopped")).toContain("2 sessions");
    const est = html("en", live({ process: "unknown", liveSessions: 0 }), "stopped");
    expect(est).toContain("~ Stopped");
    expect(est).toContain("stays here for 6 hours");
  });
});

describe("キーと操作", () => {
  test("g a で AI の画面へ", () => {
    expect(KEYMAP.find((k) => k.id === "goAi")?.keys).toEqual(["g a"]);
  });

  test("下の節の行の右クリックは AI の作業のメニュー（開く・詳細・他の開き方・完了にする・非表示）", () => {
    const ids = menuSpec([{ kind: "ai", id: "w1", title: "x" }]).map((m) => m.id);
    expect(ids).toEqual([
      "open",
      "detail",
      "openWith",
      "replyTask",
      "backToTurn",
      "aiDone",
      "aiHide",
    ]);
  });
});
