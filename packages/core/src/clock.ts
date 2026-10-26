/** 現在時刻の取得を差し替えられるようにする。時刻依存のロジックは必ず Clock を受け取る。 */
export interface Clock {
  /** UTC の epoch ms */
  now(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
};

/** テスト用の偽の時計。set / advance で時刻を動かす。 */
export class FakeClock implements Clock {
  #now: number;

  constructor(start: number | string | Date = Date.UTC(2026, 0, 1)) {
    this.#now = toMs(start);
  }

  now(): number {
    return this.#now;
  }

  set(at: number | string | Date): void {
    this.#now = toMs(at);
  }

  advance(ms: number): number {
    this.#now += ms;
    return this.#now;
  }
}

function toMs(v: number | string | Date): number {
  if (typeof v === "number") return v;
  const ms = typeof v === "string" ? Date.parse(v) : v.getTime();
  if (Number.isNaN(ms)) throw new Error(`invalid time: ${String(v)}`);
  return ms;
}
