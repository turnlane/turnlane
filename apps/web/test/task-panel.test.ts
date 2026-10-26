/** タスクの詳細パネル（タスクのパネルのレビュー v1）: 状態の1行・主のボタン・見積の任意の入力・AI の詳細パネルと同じ部品 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TaskAiView } from "@turnlane/core/web";
import { menuSpec } from "../src/actions/item-actions.tsx";
import { parseEstimate, taskHeadOf, taskPrimaryOf } from "../src/panel/task-state.ts";

const TODAY = "2026-10-09";
const TOMORROW = "2026-10-10";
const H = 3_600_000;
const T0 = Date.parse("2026-10-09T14:00:00+09:00");
const base = {
  status: "todo" as const,
  scheduledDate: null as string | null,
  estimateMin: null as number | null,
  completedAt: null as number | null,
  followUpId: null as string | null,
  ai: null as TaskAiView | null,
};
const ai = (workItemId: string | null, state = "running") =>
  ({ workItemId, state }) as unknown as TaskAiView;

describe("状態の1行", () => {
  test("Inbox · 見積", () => {
    expect(taskHeadOf({ ...base, estimateMin: 60 }, null, TODAY, TOMORROW)).toEqual({
      place: { k: "inbox" },
      range: null,
      min: 60,
    });
  });
  test("今日 14:00–15:00 · 置いた長さ（見積より置いた時間）", () => {
    const h = taskHeadOf(
      { ...base, scheduledDate: TODAY, estimateMin: 30 },
      { start: T0, end: T0 + H },
      TODAY,
      TOMORROW,
    );
    expect(h).toEqual({ place: { k: "today" }, range: { start: T0, end: T0 + H }, min: 60 });
  });
  test("明日・ほかの日（時間なし）", () => {
    expect(taskHeadOf({ ...base, scheduledDate: TOMORROW }, null, TODAY, TOMORROW).place).toEqual({
      k: "tomorrow",
    });
    expect(
      taskHeadOf({ ...base, scheduledDate: "2026-10-12", estimateMin: 30 }, null, TODAY, TOMORROW),
    ).toEqual({ place: { k: "date", date: "2026-10-12" }, range: null, min: 30 });
  });
  test("完了は完了の時刻だけ（長さを出さない）", () => {
    expect(
      taskHeadOf(
        { ...base, status: "done", scheduledDate: TODAY, estimateMin: 30, completedAt: T0 },
        { start: T0 - H, end: T0 },
        TODAY,
        TOMORROW,
      ),
    ).toEqual({ place: { k: "done", at: T0 }, range: null, min: null });
  });
});

describe("主のボタン（状態で1つ）", () => {
  const cases: [string, Parameters<typeof taskPrimaryOf>[0], boolean, string | null][] = [
    ["Inbox → 日に置く", { ...base }, false, "placeDate"],
    ["日付だけ → 時間を置く", { ...base, scheduledDate: TODAY }, false, "placeTime"],
    ["時間に置いた → AI に頼む", { ...base, scheduledDate: TODAY }, true, "askAi"],
    [
      "頼んだ AI が紐づいた → 開く",
      { ...base, scheduledDate: TODAY, ai: ai("w1") },
      true,
      "openAi",
    ],
    [
      "頼んだ AI がまだ紐づかない → 無し",
      { ...base, scheduledDate: TODAY, ai: ai(null) },
      true,
      null,
    ],
    [
      "頼んだ AI が確認待ち → 時間が無くても開く",
      { ...base, scheduledDate: TODAY, ai: ai("w1", "done_check") },
      false,
      "openAi",
    ],
    [
      "頼んだ AI が実行中・時間が無い → 時間を置く",
      { ...base, scheduledDate: TODAY, ai: ai("w1") },
      false,
      "placeTime",
    ],
    ["自分の番のタスク → 開く", { ...base, followUpId: "f1" }, false, "openTurn"],
    ["完了 → 無し", { ...base, status: "done" }, false, null],
  ];
  for (const [name, task, hasBlock, want] of cases)
    test(name, () => {
      expect(taskPrimaryOf(task, hasBlock)).toBe(want as never);
    });
});

describe("見積の任意の入力", () => {
  const cases: [string, number | null][] = [
    ["45", 45],
    ["45m", 45],
    ["1h30m", 90],
    ["1.5h", 90],
    ["2h", 120],
    ["90分", 90],
    ["1時間", 60],
    [" 1h 15m ", 75],
    ["", null],
    ["0", null],
    ["abc", null],
    ["25h", null],
  ];
  for (const [raw, want] of cases)
    test(`"${raw}" → ${want}`, () => {
      expect(parseEstimate(raw)).toBe(want);
    });
});

describe("パネルの作り（AI の詳細パネルと同じ部品）", () => {
  const SRC = join(import.meta.dir, "../src");
  const panel = readFileSync(join(SRC, "panel/TaskPanel.tsx"), "utf8");
  const aiPanel = readFileSync(join(SRC, "panel/AiPanel.tsx"), "utf8");
  test("頭・主のボタン・⋯ は AI のパネルと同じ部品", () => {
    for (const part of ["PanelHead", "ActionButton", "MoreButton", 'variant="detail"']) {
      expect(panel).toContain(part);
      expect(aiPanel).toContain(part);
    }
  });
  test("「⋯」は AI のパネルと同じくボタンの行の右端（頭には置かない。D-140 の残り）", () => {
    const actions = panel.slice(panel.indexOf("function Actions("));
    expect(actions).toContain('testId="task-more"');
    expect(actions.slice(actions.indexOf('testId="task-more"') - 80)).toContain(
      'className="ml-auto"',
    );
    expect(panel.slice(0, panel.indexOf("function Actions("))).not.toContain('testId="task-more"');
    // AI のパネルは 1 行目の右端に固定（ボタンが折り返しても「⋯」は 1 行目。answer-2）
    expect(aiPanel).toContain('className="absolute top-0 right-0"');
  });
  test("OS の select と数字の入力欄・使えない欄の案内を使わない", () => {
    expect(panel).not.toContain("<select");
    expect(panel).not.toContain('type="number"');
    expect(panel).not.toContain("taskPanel.noDate");
  });
  test("「⋯」は右クリックのメニューと同じ並び（menuSpec）から作る", () => {
    expect(panel).toContain('menuSpec([{ kind: "task", task }]');
    const ids = menuSpec(
      [{ kind: "task", task: { status: "todo" } as never }],
      { placed: true },
      [],
    )
      .map((s) => s.id)
      .filter((id) => id !== "detail");
    expect(ids).toEqual([
      "complete",
      "askAi",
      "today",
      "later",
      "move",
      "place",
      "rename",
      "unblock",
      "delete",
    ]);
  });
});

describe("予定の詳細パネル（D-138）もタスク・AI のパネルと同じ作り", () => {
  const SRC = join(import.meta.dir, "../src");
  const ev = readFileSync(join(SRC, "panel/EventPanel.tsx"), "utf8");
  test("頭・状態の1行・主のボタン・⋯・値の文字のボタン", () => {
    for (const part of [
      "PanelHead",
      "ActionButton",
      "MoreButton",
      'variant="detail"',
      "ValueButton",
      "ValueText",
      'data-testid="event-state"',
    ])
      expect(ev).toContain(part);
  });
  test("OS の select と数字の入力欄を使わない。時刻はタスクと同じポップオーバー", () => {
    expect(ev).not.toContain("<select");
    expect(ev).not.toContain("<input");
    expect(ev).toContain("<TimePrompt");
  });
  test("集中は主のボタン（設定済みは押した状態）。⋯ は右クリックと同じ並び（menuSpec）", () => {
    expect(ev).toContain('primary={focus === "off"}');
    expect(ev).toContain('pressed={focus === "on"}');
    expect(ev).toContain("menuSpec([], { event:");
  });
});
