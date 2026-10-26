/**
 * 実装の手直し（2回目。D-117・D-118。docs/design/README.md の「手直し（D-117）」）。自動で確かめられるもの:
 * - レーンの間の細い区切りの縦線（3日ボードは2レーンの間、デイビューは3レーンの間）
 * - 3日ボードの今日以外（昨日・次の稼働日）の日付は text-secondary（今日より目立たせない）
 * - ツールチップはウインドウの端で切らない（上に入らなければ下、右に入らなければ左、画面の内側に寄せる）
 * - AI のレーン: 同じ項目の近いブロックは1つの列（chain）で、ラベルは最後のブロックに1つ。ラベルの付く線は最小 28px（3日ボード）。
 *   閉じた待ちの終わりの点はふだん描かない。夜間の札はレーンの見出しの行
 * - 取り込みの知らせ（D-118）: 正常は出さない。推定・停止だけ、どの取り込み元か分かる1行
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AiRunDetail, DayDetail } from "@turnlane/core/web";
import type { SourceView } from "@turnlane/daemon";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { type Block, chainsOf, LABELED_MIN_PX } from "../src/board/AiLane.tsx";
import { WaitDots } from "../src/board/WaitDots.tsx";
import { placeTip } from "../src/components/Tooltip.tsx";
import { AI_META_PX, AI_MIN_PX, dayAiBlocks, layoutDayAi } from "../src/day/layout.ts";
import { makeI18n } from "../src/i18n/index.tsx";
import { sourcesNotice } from "../src/layout/sources-notice.ts";

const SRC = join(import.meta.dir, "../src");
const read = (p: string) => readFileSync(join(SRC, p), "utf8");
const MIN = 60_000;
const H = 60 * MIN;
const A0 = Date.UTC(2026, 9, 1, 15, 0); // 2026-10-02 0:00 JST
const at = (h: number, m = 0) => A0 + h * H + m * MIN;
const axis = { start: A0, end: A0 + 24 * H };

describe("レーンの区切りの縦線（D-117 2）", () => {
  test("3日ボードは 予定・自分 と AI の間、デイビューは3レーンの間。色は1時間の線と同じ罫線", () => {
    expect(read("board/WeekBoard.tsx")).toContain("<LaneDivider left={L.ai.left} />");
    const day = read("day/DayView.tsx");
    expect(day).toContain("<LaneDivider left={ME.left} />");
    expect(day).toContain("<LaneDivider left={AI.left} />");
    expect(read("board/TimeGrid.tsx")).toMatch(/className="dl-grid pointer-events-none absolute/);
  });
});

describe("3日ボードの見出し（D-117 3）", () => {
  test("今日以外の日付は text-secondary（次の稼働日も今日より目立たせない）", () => {
    expect(read("board/WeekBoard.tsx")).toContain('phase === "today" ? "text-fg" : "text-fg2"');
  });
});

describe("ツールチップの置き場所（D-117 4）", () => {
  const view = { width: 1440, height: 900 };
  const size = { width: 140, height: 24 };
  test("上に入らないもの（ウインドウの上端のサイドバーのボタン）は下に出す", () => {
    const r = { top: 14, left: 200, right: 224, bottom: 38, width: 24 };
    const p = placeTip("top", r, size, view);
    expect(p.side).toBe("bottom");
    expect(p.top).toBeGreaterThanOrEqual(38);
  });
  test("上に入るものは上に、左右は画面の内側に寄せる", () => {
    const r = { top: 400, left: 1420, right: 1440, bottom: 420, width: 20 };
    const p = placeTip("top", r, size, view);
    expect(p.side).toBe("top");
    expect(p.top + size.height).toBeLessThanOrEqual(400);
    expect(p.left + size.width).toBeLessThanOrEqual(1440 - 4);
    expect(p.left).toBeGreaterThanOrEqual(4);
  });
  test("右に入らないものは左に出す。上下は画面の内側", () => {
    const r = { top: 880, left: 1400, right: 1430, bottom: 900, width: 30 };
    const p = placeTip("right", r, size, view);
    expect(p.side).toBe("left");
    expect(p.left + size.width).toBeLessThanOrEqual(1400);
    expect(p.top + size.height).toBeLessThanOrEqual(900 - 4);
  });
});

function run(id: string, start: number, end: number): AiRunDetail {
  return {
    turnId: id,
    start,
    end,
    open: false,
    toolCalls: 3,
    editedFiles: 1,
    inputTokens: null,
    outputTokens: null,
    endedWith: "end_turn",
    tool: "claude_code",
  };
}
type Item = DayDetail["aiLane"][number];
const item = (id: string, runs: AiRunDetail[]): Item => ({
  id,
  title: id,
  titleSource: null,
  status: "done",
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
  waits: [],
});
const day = (aiLane: Item[]) => ({ aiLane, axis, phase: "past" as const, plannedHours: null });

describe("AI のレーンの読みやすさ（D-117 5）", () => {
  // 短い作業（8m など）を 40分おきに繰り返す項目と、その間に始まる別の項目
  const lint = item("lint", [
    run("l1", at(11, 30), at(11, 38)),
    run("l2", at(12, 18), at(12, 23)),
    run("l3", at(13, 8), at(13, 17)),
  ]);
  const ci = item("ci", [run("c1", at(12, 30), at(12, 36))]);
  const asBlock = (b: ReturnType<typeof dayAiBlocks>[number]): Block =>
    ({
      id: b.id,
      item: { id: b.item.id },
      at: b.at,
      span: b.span,
      status: b.status,
      last: b.last,
      carried: false,
    }) as unknown as Block;

  test("3日ボード: 同じ項目の間が60分未満のブロックは1つの chain（間も列を取る）", () => {
    const blocks = dayAiBlocks(day([lint, ci]), at(17)).map(asBlock);
    const chains = chainsOf(blocks, (b) => b.at.end);
    expect(chains.map((c) => c.blocks.map((b) => b.item.id))).toEqual([
      ["lint", "lint", "lint"],
      ["ci"],
    ]);
    // 間が60分以上なら別の chain
    const far = item("far", [run("f1", at(9), at(9, 5)), run("f2", at(11), at(11, 5))]);
    const c2 = chainsOf(dayAiBlocks(day([far]), at(17)).map(asBlock), (b) => b.at.end);
    expect(c2).toHaveLength(2);
    expect(LABELED_MIN_PX).toBe(28);
  });

  test("デイビュー: chain は同じ列、ラベル（tail）は最後のブロックだけ。線の高さは tail が2行、前は1行の最小", () => {
    const { placed } = layoutDayAi(dayAiBlocks(day([lint, ci]), at(17)), axis.start);
    const mine = placed.filter((p) => p.block.item.id === "lint");
    expect(new Set(mine.map((p) => p.column)).size).toBe(1);
    expect(mine.map((p) => p.tail)).toEqual([false, false, true]);
    expect(mine.map((p) => p.height)).toEqual([AI_MIN_PX, AI_MIN_PX, AI_META_PX]);
    // ci は lint の間に始まるが、lint の列には入らない
    const c = placed.find((p) => p.block.item.id === "ci");
    expect(c?.column).not.toBe(mine[0]?.column);
    // ラベルの長さは chain の合計
    expect(mine[2]?.chainAiMs).toBe(22 * MIN);
  });

  test("閉じた待ちの終わりの点はふだん描かない（ホバー・選択中だけ）", () => {
    const html = renderToStaticMarkup(
      createElement(WaitDots, {
        ends: [
          {
            id: "a:k",
            itemId: "a",
            waitKey: "k",
            at: at(10),
            reply: null,
            endReason: "resolved",
          },
        ],
        axis,
        pxPerMs: 50 / H,
        colOf: () => ({ column: 0, columns: 1 }),
        tz: "Asia/Tokyo",
        isSel: () => false,
        onPick: () => {},
      }),
    );
    expect(html).toContain("bg-transparent");
    expect(html).not.toContain("bg-fg3");
  });

  test("夜間の札はレーンの見出しの行（時間軸の線に重ねない）、文字は sans", () => {
    const src = read("board/overlays.tsx");
    expect(src).toContain("top: s.top - f.top - LANE_HEAD_PX + 2");
    expect(src).not.toMatch(/data-testid=\{`offscreen-\$\{dir\}`\}/);
    expect(src.slice(src.indexOf('data-testid="offscreen-up"') - 400)).not.toMatch(
      /font-mono[^\n]*\n[^\n]*data-testid="offscreen-up"/,
    );
  });
});

describe("取り込みの知らせ（D-118）", () => {
  const { t } = makeI18n("ja");
  const src = (
    id: string,
    tool: string,
    healthLevel: string,
    profileLabel?: string,
  ): SourceView => ({
    id,
    tool,
    rootPath: `/x/${id}`,
    profileLabel: profileLabel ?? null,
    enabled: true,
    hooksState: "receiving",
    mcpState: "installed",
    healthLevel,
    healthReason: null,
    detectedVersion: null,
    lastIngestAt: null,
    lastHookAt: null,
    excludeGlobs: [],
    includeGlobs: [],
  });
  test("すべて正常なら出さない", () => {
    expect(sourcesNotice([src("a", "claude_code", "L0"), src("b", "codex", "L0")], t)).toBeNull();
    expect(sourcesNotice([], t)).toBeNull();
  });
  test("停止が1つなら名前", () => {
    const n = sourcesNotice([src("a", "claude_code", "L0"), src("b", "codex", "L3")], t);
    expect(n?.level).toBe("stopped");
    expect(n?.text).toBe("Codex の取り込みが止まっています");
    expect(n?.detail).toContain("Codex: 停止");
  });
  test("推定が複数なら件数。停止があれば停止を優先", () => {
    const est = sourcesNotice([src("a", "claude_code", "L1"), src("b", "codex", "L2")], t);
    expect(est?.level).toBe("estimated");
    expect(est?.text).toBe("2 件の取り込みの状態は推定です");
    const mix = sourcesNotice(
      [src("a", "claude_code", "L1", "work"), src("b", "claude_code", "L3", "main")],
      t,
    );
    expect(mix?.level).toBe("stopped");
    expect(mix?.text).toBe("Claude Code · main の取り込みが止まっています");
  });
  test("サイドバーは「取り込み OK」の行を持たず、知らせの行は設定の AI を開く", () => {
    const shell = read("layout/AppShell.tsx");
    expect(shell).not.toContain("top.sourcesOk");
    expect(shell).toContain('hash="ai"');
    expect(shell).toContain('data-testid="sources-mark"');
  });
});
