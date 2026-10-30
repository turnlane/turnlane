/**
 * 待ちの区分（classifyWait）の計算量: 在席・予定が数千あっても、待ち 1 つの区分は重なる分だけを見る。結果は在席・予定を
 * 待ちごとに素直に並べ直す計算（以前の作り）と同じ
 */
import { describe, expect, test } from "bun:test";
import { type ClassifyContext, classifyWait, type WaitInterval } from "../../src/derive/index.ts";
import { SETTINGS } from "./helpers.ts";

const MIN = 60_000;
const H = 60 * MIN;
const T0 = Date.UTC(2026, 8, 14, 1, 0);

/** 在席（gap 分ごとに 2/3 だけ使っていた）と予定（30 分ごとに 20 分）。重なりと並びの乱れも入れる */
function context(days: number, gapMin: number): ClassifyContext {
  const presence: [number, number][] = [];
  for (let t = T0 - days * 24 * H; t < T0; t += gapMin * MIN)
    presence.push([t, t + ((gapMin * 2) / 3) * MIN]);
  const busy: [number, number][] = [];
  for (let t = T0 - days * 24 * H; t < T0 + 24 * H; t += 30 * MIN) busy.push([t, t + 20 * MIN]);
  busy.push([T0 - 3 * H, T0 - H]); // 重なる予定
  busy.reverse(); // 並びは時刻順とは限らない
  return { settings: SETTINGS, presence, busy };
}

function waits(n: number): WaitInterval[] {
  return Array.from({ length: n }, (_, i) => {
    const start = T0 - (i % 300) * 37 * MIN;
    const end = start + (i % 5) * 90 * MIN + 10 * MIN;
    return {
      waitKey: `w${i}`,
      workItemId: `wi${i % 40}`,
      start,
      end,
      isOpen: false,
      endReason: null,
      estimated: false,
      followUpId: null,
      expired: i % 17 === 0,
      shown: [[start + 5 * MIN, end]],
      active: [[start + 5 * MIN, end - 2 * MIN]],
    };
  });
}

describe("classifyWait の計算量", () => {
  test("在席・予定の配列を待ちごとに並べ直さない（同じ結果を、数千の在席でも短い時間で）", () => {
    const ctx = context(21, 3);
    const ivs = waits(1500);
    const a = performance.now();
    const fast = ivs.map((iv) => classifyWait(iv, ctx));
    const fastMs = performance.now() - a;
    // 比べる相手: 待ちごとに新しい配列を渡す（和集合の覚えが効かない、以前と同じ並べ直し）
    const b = performance.now();
    const slow = ivs
      .slice(0, 150)
      .map((iv) => classifyWait(iv, { ...ctx, presence: [...ctx.presence], busy: [...ctx.busy] }));
    const slowMs = ((performance.now() - b) / 150) * 1500;
    expect(fast.slice(0, 150)).toEqual(slow);
    expect(fast.flat().length).toBeGreaterThan(1500);
    // 1500 の待ち × 在席 1 万で、以前の作りの数分の 1 以下
    expect(fastMs).toBeLessThan(Math.max(200, slowMs / 3));
  });

  test("重なる・時刻順でない在席と予定でも、区分は和集合で切った結果と同じ", () => {
    const ctx = context(2, 7);
    const shuffled: ClassifyContext = {
      ...ctx,
      presence: [...ctx.presence].reverse().concat([[T0 - 5 * H, T0 - 4 * H]]),
    };
    const merged: ClassifyContext = {
      ...ctx,
      presence: [...ctx.presence, [T0 - 5 * H, T0 - 4 * H] as [number, number]].sort(
        (x, y) => x[0] - y[0],
      ),
    };
    for (const iv of waits(80))
      expect(classifyWait(iv, shuffled)).toEqual(classifyWait(iv, merged));
  });
});
