import { describe, expect, test } from "bun:test";
import { FakeClock } from "../src/clock.ts";
import { formatHlc, HlcClock, parseHlc } from "../src/hlc.ts";

const DEVICE = "0192f0a1-2b3c-7d4e-8f00-112233445566";
const T0 = Date.parse("2026-10-02T00:00:00Z");

describe("HLC の文字列形式", () => {
  test("13桁の物理時刻・4桁16進のカウンタ・device_id 先頭8文字", () => {
    const s = formatHlc({ physical: T0, counter: 10, node: "0192f0a1" });
    expect(s).toBe(`${T0}:000a:0192f0a1`);
    expect(s.split(":")[0]).toHaveLength(13);
    expect(parseHlc(s)).toEqual({ physical: T0, counter: 10, node: "0192f0a1" });
  });
  test("小さい物理時刻はゼロ埋めされ、文字列比較で大小が決まる", () => {
    const a = formatHlc({ physical: 5, counter: 0, node: "n" });
    const b = formatHlc({ physical: 40, counter: 0, node: "n" });
    expect(a).toBe("0000000000005:0000:n");
    expect(a < b).toBe(true);
  });
  test("範囲外は例外", () => {
    expect(() => formatHlc({ physical: T0, counter: 0x10000, node: "n" })).toThrow();
    expect(() => formatHlc({ physical: -1, counter: 0, node: "n" })).toThrow();
    expect(() => parseHlc("bad")).toThrow();
  });
});

describe("HlcClock", () => {
  test("node は device_id のハイフンを除いた先頭8文字", () => {
    expect(new HlcClock(DEVICE, new FakeClock(T0)).node).toBe("0192f0a1");
  });

  test("時計が進めばカウンタは 0、同じ時刻ならカウンタが増える", () => {
    const clock = new FakeClock(T0);
    const hlc = new HlcClock(DEVICE, clock);
    expect(hlc.now()).toBe(`${T0}:0000:0192f0a1`);
    expect(hlc.now()).toBe(`${T0}:0001:0192f0a1`);
    clock.advance(1);
    expect(hlc.now()).toBe(`${T0 + 1}:0000:0192f0a1`);
  });

  test("壁時計が戻っても単調増加を保つ", () => {
    const clock = new FakeClock(T0);
    const hlc = new HlcClock(DEVICE, clock);
    const a = hlc.now();
    clock.set(T0 - 60_000);
    const b = hlc.now();
    expect(b > a).toBe(true);
    expect(parseHlc(b).physical).toBe(T0);
  });

  test("change_log の最大 hlc から復元すると、それより大きい値を返す", () => {
    const last = `${T0 + 5000}:0003:0192f0a1`;
    const hlc = new HlcClock(DEVICE, new FakeClock(T0), last);
    const next = hlc.now();
    expect(next > last).toBe(true);
    expect(next).toBe(`${T0 + 5000}:0004:0192f0a1`);
  });

  test("カウンタが溢れたら物理時刻を 1ms 進める", () => {
    const hlc = new HlcClock(DEVICE, new FakeClock(T0), `${T0}:ffff:0192f0a1`);
    expect(hlc.now()).toBe(`${T0 + 1}:0000:0192f0a1`);
  });

  test("1万回連続で呼んでも厳密に増加する", () => {
    const hlc = new HlcClock(DEVICE, new FakeClock(T0));
    let prev = "";
    for (let i = 0; i < 10_000; i++) {
      const s = hlc.now();
      expect(s > prev).toBe(true);
      prev = s;
    }
  });

  test("receive: 相手の方が進んでいれば相手に合わせてカウンタを進める", () => {
    const hlc = new HlcClock(DEVICE, new FakeClock(T0));
    expect(hlc.receive(`${T0 + 100}:0002:ffffffff`)).toBe(`${T0 + 100}:0003:0192f0a1`);
    expect(hlc.now()).toBe(`${T0 + 100}:0004:0192f0a1`);
  });

  test("receive: 壁時計が最大ならカウンタは 0", () => {
    const hlc = new HlcClock(DEVICE, new FakeClock(T0 + 500));
    expect(hlc.receive(`${T0}:0009:ffffffff`)).toBe(`${T0 + 500}:0000:0192f0a1`);
  });
});
