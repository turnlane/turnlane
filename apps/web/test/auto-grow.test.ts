/** 行数に合わせて伸びる textarea（AI に頼むの指示・タスクのメモ）の高さの決め方 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { growHeight } from "../src/components/AutoGrowTextarea.tsx";

const INF = Number.POSITIVE_INFINITY;
const base = { min: 56, max: 300, manual: 0, hardMax: INF };

describe("growHeight", () => {
  test("中身が最小より短ければ最小", () => {
    expect(growHeight({ ...base, content: 30 })).toBe(56);
  });
  test("中身に合わせて伸びる", () => {
    expect(growHeight({ ...base, content: 200 })).toBe(200);
  });
  test("上限で止まる（中でスクロール）", () => {
    expect(growHeight({ ...base, content: 900 })).toBe(300);
  });
  test("手で広げた高さは縮みの下限", () => {
    expect(growHeight({ ...base, content: 30, manual: 240 })).toBe(240);
    expect(growHeight({ ...base, content: 260, manual: 240 })).toBe(260);
  });
  test("手で広げた高さは自動の上限を超えてよいが、画面に収まる上限は超えない", () => {
    expect(growHeight({ ...base, content: 30, manual: 500 })).toBe(500);
    expect(growHeight({ ...base, content: 30, manual: 500, hardMax: 400 })).toBe(400);
  });
  test("画面に収まる上限が最小より小さくても最小は保つ", () => {
    expect(growHeight({ ...base, content: 900, max: 20, hardMax: 20 })).toBe(56);
  });
});

describe("使う所", () => {
  const src = (p: string) => readFileSync(join(import.meta.dir, "../src", p), "utf8");
  test("AI に頼むの指示は画面に収まる高さまで伸び、つまみで広げられる", () => {
    const s = src("launch/AskAi.tsx");
    expect(s).toMatch(/<AutoGrowTextarea\s+minRows=\{2\}\s+fitViewport/);
    expect(s).toMatch(/data-testid="ai-instruction"/);
    expect(s).toMatch(/resize-y rounded-control/);
  });
  test("タスクのメモも同じ部品で伸びる（手の広がりはそのまま）", () => {
    const s = src("panel/TaskPanel.tsx");
    expect(s).toMatch(/<AutoGrowTextarea\s+minRows=\{5\}\s+maxRows=\{NOTES_MAX_ROWS\}/);
    expect(s).toMatch(/-mx-2 resize-y rounded-card/);
  });
});
