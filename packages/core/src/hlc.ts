import type { Clock } from "./clock.ts";

/**
 * Hybrid Logical Clock（phase0-plan 2.2）。
 * 文字列形式: `<物理時刻ms 13桁ゼロ埋め>:<カウンタ 4桁16進>:<device_id 先頭8文字>`。
 * 文字列比較でそのまま大小が決まる。
 */
export interface Hlc {
  physical: number;
  counter: number;
  node: string;
}

const MAX_COUNTER = 0xffff;
const HLC_RE = /^(\d{13}):([0-9a-f]{4}):(.{1,8})$/;

export function formatHlc(h: Hlc): string {
  if (!Number.isSafeInteger(h.physical) || h.physical < 0 || h.physical > 9_999_999_999_999) {
    throw new Error(`hlc physical out of range: ${h.physical}`);
  }
  if (!Number.isInteger(h.counter) || h.counter < 0 || h.counter > MAX_COUNTER) {
    throw new Error(`hlc counter out of range: ${h.counter}`);
  }
  return `${String(h.physical).padStart(13, "0")}:${h.counter.toString(16).padStart(4, "0")}:${h.node}`;
}

export function parseHlc(s: string): Hlc {
  const m = HLC_RE.exec(s);
  if (!m) throw new Error("invalid hlc string");
  return {
    physical: Number(m[1]),
    counter: Number.parseInt(m[2] as string, 16),
    node: m[3] as string,
  };
}

export class HlcClock {
  readonly node: string;
  readonly #clock: Clock;
  #physical = 0;
  #counter = 0;

  constructor(deviceId: string, clock: Clock, last?: string | null) {
    this.node = deviceId.replaceAll("-", "").slice(0, 8);
    if (this.node.length === 0) throw new Error("deviceId is empty");
    this.#clock = clock;
    if (last) {
      const h = parseHlc(last);
      this.#physical = h.physical;
      this.#counter = h.counter;
    }
  }

  /** ローカルの事象（書き込み）に付ける新しい HLC。単調増加する。 */
  now(): string {
    const wall = this.#clock.now();
    if (wall > this.#physical) {
      this.#physical = wall;
      this.#counter = 0;
    } else {
      this.#bump();
    }
    return formatHlc({ physical: this.#physical, counter: this.#counter, node: this.node });
  }

  /** 他端末の HLC を受け取ったときに時計を進める（将来の同期用）。 */
  receive(remote: string): string {
    const r = parseHlc(remote);
    const wall = this.#clock.now();
    const maxP = Math.max(wall, this.#physical, r.physical);
    if (maxP === this.#physical && maxP === r.physical) {
      this.#counter = Math.max(this.#counter, r.counter);
      this.#bump();
    } else if (maxP === this.#physical) {
      this.#bump();
    } else if (maxP === r.physical) {
      this.#physical = r.physical;
      this.#counter = r.counter;
      this.#bump();
    } else {
      this.#physical = maxP;
      this.#counter = 0;
    }
    return formatHlc({ physical: this.#physical, counter: this.#counter, node: this.node });
  }

  #bump(): void {
    if (this.#counter >= MAX_COUNTER) {
      // カウンタが溢れたら論理的に 1ms 進める（文字列の大小関係を保つ）
      this.#physical += 1;
      this.#counter = 0;
    } else {
      this.#counter += 1;
    }
  }
}
