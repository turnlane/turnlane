import { describe, expect, test } from "bun:test";
import { layoutMeLane, type MeLaneBox, type MeLaneItem } from "../../src/layout/me-lane.ts";

const MIN = 60_000;
const H = 60 * MIN;
/** 1時間 44px（週ボードの既定） */
const PX = 44 / H;
const at = (hh: number, mm = 0) => hh * H + mm * MIN;
const opts = { axisStart: 0, pxPerMs: PX, titlePx: 20, minPx: 20, gapPx: 4 };
const item = (
  id: string,
  kind: MeLaneItem["kind"],
  s: [number, number?],
  e: [number, number?],
  minPx = 20,
): MeLaneItem => ({ id, kind, start: at(...s), end: at(...e), minPx });
const byId = (xs: MeLaneBox[], id: string) =>
  xs.find((x) => (x.kind === "summary" ? x.ids.includes(id) : x.id === id));

describe("layoutMeLane（W4・W5、D-050）", () => {
  test("W4: 8:50–8:58、8:58–9:06、9:06–9:31 の完了は1つのまとめ（3件・41分）、幅いっぱい", () => {
    const r = layoutMeLane(
      [
        item("a", "done", [8, 50], [8, 58]),
        item("b", "done", [8, 58], [9, 6]),
        item("c", "done", [9, 6], [9, 31]),
      ],
      opts,
    );
    expect(r).toHaveLength(1);
    const s = r[0];
    expect(s?.kind).toBe("summary");
    if (s?.kind !== "summary") return;
    expect(s.ids).toEqual(["a", "b", "c"]);
    expect(s.totalMs).toBe(41 * MIN);
    expect(s.top).toBeCloseTo(at(8, 50) * PX);
    expect(s.top + s.height).toBeCloseTo(at(9, 31) * PX);
    expect([s.column, s.columns]).toEqual([0, 1]);
  });

  test("W4: 最小高さの下端からの間が gap 未満なら続きとみなす（17:00–17:15 と 17:30–17:50）。離れたものは単独", () => {
    const r = layoutMeLane(
      [
        item("x", "done", [16, 20], [16, 40]),
        item("a", "done", [17, 0], [17, 15]),
        item("b", "done", [17, 30], [17, 50]),
      ],
      opts,
    );
    expect(byId(r, "x")?.kind).toBe("task");
    const s = byId(r, "a");
    expect(s?.kind).toBe("summary");
    if (s?.kind === "summary") expect(s.ids).toEqual(["a", "b"]);
  });

  test("本当に時間が重なる計画タスク同士は従来どおり列に分け、まとめない", () => {
    const r = layoutMeLane(
      [item("a", "planned", [10], [11]), item("b", "planned", [10, 30], [11, 30])],
      opts,
    );
    expect(r.map((x) => [x.kind, x.column, x.columns])).toEqual([
      ["task", 0, 2],
      ["task", 1, 2],
    ]);
  });

  test("W5: 予定（60分）の中で始まる計画は、予定の題名の下に入れ子（v4 の Design review / Write article outline）", () => {
    const r = layoutMeLane(
      [item("ev", "event", [14], [15]), item("t", "planned", [14, 15], [15], 34)],
      opts,
    );
    const ev = byId(r, "ev");
    const t = byId(r, "t");
    expect([ev?.column, ev?.columns]).toEqual([0, 1]);
    if (t?.kind !== "task") throw new Error("task");
    expect(t.host?.id).toBe("ev");
    // 題名の行（20px）より下、警告の2行ぶん（34px）を守る
    expect(t.top).toBeCloseTo(at(14) * PX + 20);
    expect(t.height).toBeCloseTo(34);
  });

  test("W5: 予定が短く入れ子にできないとき（45分 = 33px）は列を分ける", () => {
    const r = layoutMeLane(
      [item("ev", "event", [10], [10, 45]), item("t", "done", [10, 2], [10, 10])],
      opts,
    );
    const ev = byId(r, "ev");
    const t = byId(r, "t");
    expect([ev?.column, ev?.columns]).toEqual([0, 2]);
    expect([t?.column, t?.columns]).toEqual([1, 2]);
    if (t?.kind === "task") expect(t.host).toBeNull();
  });

  test("予定より前に始まって予定にかかるタスクは入れ子にせず列を分ける。入れ子の下端が後続と重なれば列を分ける", () => {
    const r = layoutMeLane(
      [
        item("ev", "event", [14], [15]),
        item("before", "planned", [13, 45], [14, 15]),
        item("in", "planned", [14, 40], [15]),
        item("after", "planned", [15], [15, 15]),
      ],
      opts,
    );
    expect(byId(r, "before")?.columns).toBe(2);
    const inner = byId(r, "in");
    if (inner?.kind !== "task") throw new Error("task");
    expect(inner.host?.id).toBe("ev");
    // 入れ子（14:40 から最小 20px）は 15:00 を超えて 15:00 の後続と重なるので、後続は別の列
    expect(byId(r, "after")?.columns).toBe(2);
  });

  test("計画タスクも最小 20px（15分のタスク）", () => {
    const r = layoutMeLane([item("t", "planned", [15, 30], [15, 45])], opts);
    expect(r[0]?.height).toBe(20);
  });
});
