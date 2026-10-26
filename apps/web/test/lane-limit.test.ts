/**
 * AI のレーンの札（metaOf）: 利用枠で止まったセッション（上限待ち）は「エラー」と出さず、`利用上限 · 15:00 まで`
 * （明ける時刻が分かるとき）か `利用上限 · 待ち 2h`（分からないとき）。最後のブロックは琥珀（needs_input の系統）
 */
import { describe, expect, test } from "bun:test";
import type { AiLaneItem, DayColumn } from "@turnlane/core/web";
import { blocksOf, metaOf } from "../src/board/AiLane.tsx";
import { translate } from "../src/i18n/index.tsx";

const M = 60_000;
const TZ = "Asia/Tokyo";
// 2026-09-14 00:00 JST
const DAY0 = Date.UTC(2026, 8, 13, 15, 0);
const at = (h: number, m = 0) => DAY0 + (h * 60 + m) * M;

function item(p: Partial<AiLaneItem> = {}): AiLaneItem {
  return {
    id: "wi",
    title: "Fixture work",
    titleSource: null,
    status: "done",
    reason: "rate_limit",
    estimated: false,
    sources: [],
    repoRoot: "/fixture/repo-a",
    branch: "feat/x",
    prRef: null,
    aiMs: 20 * M,
    youMs: 0,
    idleMs: 0,
    turns: 1,
    carriedFrom: null,
    runs: [{ turnId: "t1", start: at(10), end: at(10, 20), open: false }],
    waits: [],
    ...p,
  };
}

function day(items: AiLaneItem[]): DayColumn {
  return {
    date: "2026-09-14",
    phase: "today",
    logicalPhase: "today",
    axis: { start: DAY0, end: DAY0 + 24 * 60 * M },
    logical: { start: DAY0 + 4 * 60 * M, end: DAY0 + 28 * 60 * M },
    aiLane: items,
  } as unknown as DayColumn;
}

const label = (it: AiLaneItem, now: number, locale: "ja" | "en" = "ja") => {
  const d = day([it]);
  const b = blocksOf(d, now).at(-1);
  if (!b) throw new Error("no block");
  const t = (k: string, p?: Record<string, string | number>) => translate(locale, k as never, p);
  return { block: b, meta: metaOf(b, now, d, t as never, TZ) };
};

describe("レーンの札: 上限待ち", () => {
  test("明ける時刻が分かる: 利用上限 · 15:00 まで（英語は Usage limit · until 15:00）。ブロックは琥珀", () => {
    const it = item({ limit: { since: at(10, 20), until: at(15), untilKnown: true } });
    const { block, meta } = label(it, at(11));
    expect(meta).toEqual({ right: "利用上限 · 15:00 まで", sub: null, kind: "wait" });
    expect(block.status).toBe("needs_input");
    expect(label(it, at(11), "en").meta.right).toBe("Usage limit · until 15:00");
  });

  test("明ける時刻が分からない: 利用上限 · 待ち 2h（止まってからの長さ）", () => {
    const it = item({ limit: { since: at(10, 20), until: at(15, 20), untilKnown: false } });
    expect(label(it, at(12, 20)).meta.right).toBe("利用上限 · 待ち 2h");
    expect(label(it, at(12, 20), "en").meta.right).toBe("Usage limit · waiting 2h");
  });

  test("明けた後（limit が無い）は普通の終わった印（AI 時間）", () => {
    const it = item({ reason: "ended" });
    const { block, meta } = label(it, at(16));
    expect(block.status).toBe("done");
    expect(meta).toEqual({ right: "20m", sub: null, kind: "time" });
  });

  test("エラーは今までどおり「エラー Nh」（赤）", () => {
    const it = item({
      status: "error",
      reason: "hook:stop_failure",
      waits: [
        {
          waitKey: "turn:t1:error",
          start: at(10, 20),
          end: at(10, 50),
          idle: false,
          open: true,
          tone: "error",
          followUpId: null,
        },
      ],
    });
    const { block, meta } = label(it, at(10, 50));
    expect(block.status).toBe("error");
    expect(meta.right).toBe("エラー 30m");
  });
});
