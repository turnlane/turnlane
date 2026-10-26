import { describe, expect, test } from "bun:test";
import { FakeClock, systemClock } from "../src/clock.ts";
import { isUuidV7, newId, uuidV7Time } from "../src/ids.ts";
import { orderKeyAfter, orderKeyBefore, orderKeyBetween, orderKeysBetween } from "../src/order.ts";

describe("FakeClock", () => {
  test("set / advance", () => {
    const c = new FakeClock("2026-10-02T00:00:00Z");
    expect(c.now()).toBe(Date.parse("2026-10-02T00:00:00Z"));
    c.advance(1500);
    expect(c.now()).toBe(Date.parse("2026-10-02T00:00:01.500Z"));
    c.set(0);
    expect(c.now()).toBe(0);
    expect(() => c.set("not a date")).toThrow();
  });
  test("systemClock は Date.now", () => {
    const before = Date.now();
    const n = systemClock.now();
    expect(n).toBeGreaterThanOrEqual(before);
  });
});

describe("newId (UUIDv7)", () => {
  test("UUIDv7 の書式で、時刻部分は Clock の時刻", () => {
    const clock = new FakeClock("2026-10-02T12:34:56.789Z");
    const id = newId(clock);
    expect(isUuidV7(id)).toBe(true);
    expect(uuidV7Time(id)).toBe(clock.now());
  });
  test("同じ時刻でも重複せず、生成順に文字列として増加する", () => {
    const clock = new FakeClock("2026-10-02T00:00:00Z");
    const ids = Array.from({ length: 1000 }, () => newId(clock));
    expect(new Set(ids).size).toBe(1000);
    expect([...ids].sort()).toEqual(ids);
  });
  test("Clock を渡さなければ現在時刻", () => {
    const id = newId();
    expect(Math.abs(uuidV7Time(id) - Date.now())).toBeLessThan(5000);
  });
});

describe("fractional index", () => {
  test("空のレーンの最初のキーと前後への追加", () => {
    const a = orderKeyAfter(null);
    const b = orderKeyAfter(a);
    const z = orderKeyBefore(a);
    expect([z, a, b]).toEqual([z, a, b].sort());
    expect(z < a && a < b).toBe(true);
  });
  test("間への挿入を繰り返しても並び順が保たれる", () => {
    let lo = orderKeyAfter(null);
    const hi = orderKeyAfter(lo);
    const keys = [lo, hi];
    for (let i = 0; i < 200; i++) {
      const k = orderKeyBetween(lo, hi);
      expect(lo < k && k < hi).toBe(true);
      keys.push(k);
      lo = k;
    }
    expect(new Set(keys).size).toBe(keys.length);
  });
  test("n 個のキーを昇順で作る", () => {
    const ks = orderKeysBetween(null, null, 5);
    expect(ks).toHaveLength(5);
    expect([...ks].sort()).toEqual(ks);
  });
  test("SQLite の BINARY 照合でも同じ順に並ぶ（ASCII のみ）", () => {
    const ks = orderKeysBetween(null, null, 50);
    for (const k of ks) expect(/^[\x21-\x7e]+$/.test(k)).toBe(true);
  });
});
