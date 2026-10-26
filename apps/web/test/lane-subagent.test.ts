/**
 * AI のレーン: 親の番が閉じてもサブエージェントが動いている間は、親のブロックが途切れず今まで続く（実行中）。
 * デーモンは親のターンの後に、サブエージェントだけが動いていた区間を実行（turnId `subagent:<始まり>`）として足す
 */
import { describe, expect, test } from "bun:test";
import type { AiLaneItem, DayColumn } from "@turnlane/core/web";
import { blocksOf } from "../src/board/AiLane.tsx";
import { dayAiBlocks } from "../src/day/layout.ts";

const M = 60_000;
// 2026-09-14 00:00 JST
const DAY0 = Date.UTC(2026, 8, 13, 15, 0);
const at = (h: number, m = 0) => DAY0 + (h * 60 + m) * M;

function item(p: Partial<AiLaneItem> = {}): AiLaneItem {
  return {
    id: "wi",
    title: "Fixture work",
    titleSource: null,
    status: "running",
    reason: "subagent:running",
    estimated: true,
    sources: [],
    repoRoot: "/fixture/repo-a",
    branch: "feat/x",
    prRef: null,
    aiMs: 20 * M,
    youMs: 0,
    idleMs: 0,
    turns: 1,
    carriedFrom: null,
    runs: [
      { turnId: "t1", start: at(10), end: at(10, 5), open: false },
      { turnId: `subagent:${at(10, 5)}`, start: at(10, 5), end: at(10, 20), open: true },
    ],
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
    plannedHours: null,
    aiLane: items,
  } as unknown as DayColumn;
}

describe("レーン: サブエージェントが動いている間の親のブロック", () => {
  test("親のターンとサブエージェントの区間は 1 本のブロック。実行中で、今まで続く", () => {
    const blocks = blocksOf(day([item()]), at(10, 25));
    expect(blocks).toHaveLength(1);
    const [b] = blocks;
    expect(b?.status).toBe("running");
    expect(b?.span).toMatchObject({ start: at(10), open: true });
    expect(b?.span.turnIds).toEqual(["t1", `subagent:${at(10, 5)}`]);
    // 日のビューも同じ
    const d = dayAiBlocks(day([item()]) as never, at(10, 25));
    expect(d).toHaveLength(1);
    expect(d[0]?.status).toBe("running");
    expect(d[0]?.span?.open).toBe(true);
  });

  test("サブエージェントの区間が無い（直す前の形）と、親のブロックは閉じた時刻で止まる", () => {
    const it = item({ runs: [{ turnId: "t1", start: at(10), end: at(10, 5), open: false }] });
    const [b] = blocksOf(day([it]), at(10, 25));
    expect(b?.span).toMatchObject({ end: at(10, 5), open: false });
  });

  test("サブエージェントの許可待ち（needs_input）は、待ちの始まりでブロックを切る（待ち線で描く）", () => {
    const it = item({
      status: "needs_input",
      reason: "hook:permission_request",
      waits: [
        {
          waitKey: "hook:h1",
          start: at(10, 12),
          end: at(10, 20),
          idle: false,
          open: true,
          tone: "needs_input",
          followUpId: null,
        },
      ],
    });
    const [b] = blocksOf(day([it]), at(10, 25));
    expect(b?.status).toBe("needs_input");
    expect(b?.span).toMatchObject({ end: at(10, 12), open: false });
  });
});
