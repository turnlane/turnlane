import type { Clock } from "./clock.ts";

/**
 * 主キー用の UUIDv7。時刻部分は渡した Clock から取る（テストで並び順を固定できる）。
 * 同じミリ秒内でも Bun の実装が単調増加を保証する。
 */
export function newId(clock?: Clock): string {
  return clock ? Bun.randomUUIDv7("hex", clock.now()) : Bun.randomUUIDv7();
}

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isUuidV7(s: string): boolean {
  return UUID_V7.test(s);
}

/** UUIDv7 の先頭 48bit（epoch ms）を取り出す。 */
export function uuidV7Time(id: string): number {
  return Number.parseInt(id.replaceAll("-", "").slice(0, 12), 16);
}
