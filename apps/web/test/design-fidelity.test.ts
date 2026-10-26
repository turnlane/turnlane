/**
 * 確定画像の再現性（D-114。docs/design/README.md の「再現性の修正」）。見た目の規則のうち自動で確かめられるもの:
 * - 状態アイコンは塗りの丸に地の色の記号（琥珀の一時停止・ティールの矢印・赤の三角）、実行中は開いた弧。推定でも点線の輪と `~` を付けない
 * - 等幅は時刻と長さだけ（題名・日本語・件数・プロジェクト名に使わない）
 * - タスクのカードは白い面に薄い灰の枠（濃い枠は選択中だけ）
 * - デイビューの AI レーンは、待ちの線の分も列を取る（待ちの点線とほかの AI の線を同じ x に重ねない）
 * - 3日ボードの幅・1時間の高さ・目盛りの列
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AiRunDetail, DayDetail, DayWaitSegment, WorkItemStatus } from "@turnlane/core/web";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GUTTER_PX, gridTemplate, HOUR_PX } from "../src/board/geometry.ts";
import { scrollStartOf } from "../src/board/TimeGrid.tsx";
import { AiRunBlock, taskSurface } from "../src/components/items.tsx";
import { splitNums } from "../src/components/Nums.tsx";
import { StatusIcon } from "../src/components/StatusIcon.tsx";
import { dayAiBlocks, layoutDayAi, waitExtentOf } from "../src/day/layout.ts";

const SRC = join(import.meta.dir, "../src");
const read = (p: string) => readFileSync(join(SRC, p), "utf8");

/** 等幅の要素（class に font-mono を持つ要素）の中の文字。入れ子は外側だけ見る */
function monoTexts(html: string): string[] {
  const out: string[] = [];
  const re = /<(\w+)[^>]*class="[^"]*\bfont-mono\b[^"]*"[^>]*>(.*?)<\/\1>/g;
  for (const m of html.matchAll(re)) out.push((m[2] as string).replace(/<[^>]+>/g, ""));
  return out;
}

/** 時刻・時刻の範囲・長さだけ */
const TIME_OR_DURATION = /^~?(\d{1,2}:\d{2}(\s?[–-]\s?\d{1,2}:\d{2})?|(\d+h)?(\d+m)?|\d+[hms])$/;

describe("状態アイコン（D-114 1）", () => {
  const html = (status: WorkItemStatus, estimated = false) =>
    renderToStaticMarkup(createElement(StatusIcon, { status, estimated }));

  test("ブロック中・自分の番は塗りの丸に地の色の記号", () => {
    for (const s of ["needs_input", "your_turn"] as const) {
      const h = html(s);
      expect(h).toMatch(/<circle cx="8" cy="8" r="7" fill="currentColor"/);
      expect(h).toContain("var(--dl-bg)");
    }
  });
  test("エラーは塗りの三角に !、実行中は開いた弧", () => {
    expect(html("error")).toMatch(/<path d="M8 1\.6 15 14\.2H1z" fill="currentColor"/);
    expect(html("running")).toMatch(/<path d="M8 2a6 6 0 1 1-6 6" fill="none"/);
  });
  test("推定でも形と濃さは同じ（点線の輪・`~`・薄くしない）。推定はラベルで伝える", () => {
    for (const s of ["needs_input", "your_turn", "running", "error", "done"] as const) {
      const est = html(s, true);
      expect(est).not.toContain("stroke-dasharray");
      expect(est).not.toContain("~</span>");
      expect(est).not.toContain("opacity-60");
      // 形は推定でないものと同じ
      expect(est.replace(/ (aria-label|title|data-estimated)="[^"]*"/g, "")).toBe(
        html(s).replace(/ (aria-label|title)="[^"]*"/g, ""),
      );
    }
  });
});

describe("等幅は時刻と長さだけ（D-114 2、D-101）", () => {
  test("文の中の時刻と長さだけを切り出す", () => {
    const mono = (s: string) => splitNums(s).filter((_, i) => i % 2 === 1);
    expect(mono("2h29m · 放置 36m")).toEqual(["2h29m", "36m"]);
    expect(mono("許可待ち 12m · 1h26m")).toEqual(["12m", "1h26m"]);
    expect(mono("AI 3 件 · 3m")).toEqual(["3m"]);
    expect(mono("計画 ~2h10m")).toEqual(["~2h10m"]);
    expect(mono("返答済み 8:50")).toEqual(["8:50"]);
    expect(mono("13:05–15:34")).toEqual(["13:05–15:34"]);
    expect(mono("夜間の AI の実行 1 件")).toEqual([]);
    expect(mono("Fix log parser in 5 files")).toEqual([]);
  });

  test("AI のラベル: 題名・言葉は sans、長さだけ等幅", () => {
    const html = renderToStaticMarkup(
      createElement(AiRunBlock, {
        title: "価格ページのA/Bテスト",
        status: "your_turn",
        estimated: false,
        sources: [],
        right: "2h29m",
        sub: "放置 36m",
        more: { count: 1, hint: "" },
      }),
    );
    const mono = monoTexts(html);
    expect(mono.length).toBeGreaterThan(0);
    for (const s of mono) expect(s).toMatch(TIME_OR_DURATION);
    expect(html).toContain("価格ページのA/Bテスト");
  });

  test("見出しの集計・件数・放置の表・まとめの文を丸ごと等幅にしない", () => {
    const board = read("board/WeekBoard.tsx");
    // 集計の行（TotalsLine）は Nums で長さだけを等幅に
    expect(board).not.toMatch(/whitespace-pre font-mono text-fg2 text-meta/);
    expect(board).not.toMatch(/font-medium font-mono text-fg2 text-meta">\s*\{band\.length\}/);
    const lane = read("board/AiLane.tsx");
    expect(lane).not.toMatch(/truncate font-mono text-meta">\s*\{t\("board\.runsGroup"/);
    const day = read("day/DayView.tsx");
    expect(day).not.toContain('data-testid="idle-by-repo"');
    expect(day).not.toMatch(
      /whitespace-pre font-mono text-fg2 text-meta"\s*data-testid="day-totals"/,
    );
    const tray = read("routes/TrayPage.tsx");
    expect(tray).not.toContain('<span className="font-mono">{items.length}</span>');
  });
});

describe("タスクのカード（D-114 3）", () => {
  test("未定のカードも時間軸の計画も白い面に薄い灰の枠。濃い枠は選択中だけ", () => {
    for (const v of ["card", "planned"] as const) {
      const s = taskSurface(v, false);
      expect(s).toContain("border-line");
      expect(s).toContain("bg-task");
      expect(s).not.toContain("border-taskplan");
      expect(s).not.toContain("border-accent");
      expect(taskSurface(v, true)).toContain("border-accent");
    }
  });
});

describe("D-114: 時間軸の寸法（確定画像）", () => {
  test("3日ボード: 目盛り 56px、1時間 50px、列は 3.6 : 12 : 5.4（今日は 12 / 21 のまま）", () => {
    expect(GUTTER_PX).toBe(56);
    expect(HOUR_PX).toBe(50);
    expect(gridTemplate(["2026-10-01", "2026-10-02", "2026-10-03"], "three")).toBe(
      "56px minmax(0, 3.6fr) minmax(0, 12fr) minmax(0, 5.4fr)",
    );
  });
  test("開いたときは計画の目安の開始と、それより前の朝の最初の項目の早い方から", () => {
    const H = 3_600_000;
    const axis = { start: 0, end: 24 * H };
    const base = {
      axis,
      plannedHours: { start: 10 * H, end: 19 * H },
      events: [{ start: 10 * H }],
      timeBlocks: [] as { start: number }[],
      timeEntries: [] as { start: number }[],
    };
    expect(scrollStartOf(base, 0)).toBe(10 * H);
    expect(scrollStartOf({ ...base, timeBlocks: [{ start: 9 * H }] }, 0)).toBe(9 * H);
    // 6:00 より前（深夜の作業）は見ない
    expect(scrollStartOf({ ...base, timeEntries: [{ start: 2 * H }] }, 0)).toBe(10 * H);
  });
});

describe("デイビューの AI レーン（D-114 5・9）", () => {
  const MIN = 60_000;
  const H = 60 * MIN;
  const A0 = Date.UTC(2026, 9, 1, 15, 0);
  const at = (h: number, m = 0) => A0 + h * H + m * MIN;
  const axis = { start: A0, end: A0 + 24 * H };
  const run = (id: string, start: number, end: number, open = false): AiRunDetail => ({
    turnId: id,
    start,
    end,
    open,
    toolCalls: 0,
    editedFiles: 0,
    inputTokens: null,
    outputTokens: null,
    endedWith: "end_turn",
    tool: "claude_code",
  });
  const wait = (start: number, end: number, open: boolean): DayWaitSegment => ({
    waitKey: "w",
    start,
    end,
    idle: true,
    open,
    tone: "your_turn",
    followUpId: null,
    kind: "idle",
    excludedBy: null,
    endReason: null,
  });
  type Item = DayDetail["aiLane"][number];
  const item = (id: string, runs: AiRunDetail[], waits: DayWaitSegment[], status: Item["status"]) =>
    ({
      id,
      title: id,
      titleSource: null,
      status,
      reason: null,
      estimated: false,
      sources: [],
      repoRoot: null,
      branch: null,
      prRef: null,
      aiMs: 0,
      youMs: 0,
      idleMs: 0,
      turns: runs.length,
      carriedFrom: null,
      runs,
      waits,
    }) satisfies Item;

  test("待っている間に始まった別の AI は、待ちの線と別の列に置く。線の高さは実行の長さのまま", () => {
    const now = at(17, 10);
    const d = {
      aiLane: [
        // 13:05〜15:34 に動き、15:34 から自分の番（今も待ち）
        item("ab", [run("a1", at(13, 5), at(15, 34))], [wait(at(15, 34), now, true)], "your_turn"),
        // 15:50〜16:54 に動いて終わった
        item("doc", [run("d1", at(15, 50), at(16, 54))], [], "done"),
      ],
      axis,
      phase: "today" as const,
      plannedHours: null,
    };
    const blocks = dayAiBlocks(d, now);
    const { placed } = layoutDayAi(blocks, axis.start, waitExtentOf(blocks, now, axis));
    const col = (id: string) => placed.find((p) => p.block.item.id === id)?.column;
    expect(col("ab")).not.toBe(col("doc"));
    const ab = placed.find((p) => p.block.item.id === "ab");
    expect(ab?.height).toBeCloseTo((149 / 60) * 60);
    expect(ab?.reach).toBeGreaterThan((ab?.top ?? 0) + (ab?.height ?? 0));
  });

  test("前日からの持ち越し（待ちだけ）も、待ちの線の分の列を取る。その間に動いたほかの項目は別の列", () => {
    const now = at(17, 10);
    const d = {
      aiLane: [
        // 前日から自分の番のまま（今日の実行は無い）。待ちは 0:00 から今まで続く
        {
          ...item("carry", [], [wait(axis.start, now, true)], "your_turn"),
          carriedFrom: "2026-10-01",
        },
        // 待ちの間に、10:50〜11:00 と 13:00〜13:10 に短い作業を繰り返した別の項目
        item(
          "short",
          [run("s1", at(10, 50), at(11, 0)), run("s2", at(13, 0), at(13, 10))],
          [],
          "done",
        ),
      ],
      axis,
      phase: "today" as const,
      plannedHours: { start: at(9), end: at(18) },
    };
    const blocks = dayAiBlocks(d, now);
    const { placed } = layoutDayAi(blocks, axis.start, waitExtentOf(blocks, now, axis));
    const carry = placed.find((p) => p.block.item.id === "carry");
    const short = placed.filter((p) => p.block.item.id === "short");
    expect(short).toHaveLength(2);
    for (const p of short) expect(p.column).not.toBe(carry?.column);
    // 持ち越しの列は今（待ちの終わり）まで取る
    expect(carry?.reach).toBeGreaterThanOrEqual(((now - axis.start) / 3_600_000) * 60 - 1);
  });
});
