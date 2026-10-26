/**
 * 時間に置く（`p`。ux-mvp 6.1、m2-api.md 17章）の候補: その日の空き枠（DayDetail.freeSlots）から、
 * 長さ dur が入る開始時刻を時刻順に返す。今日は now より後（15分単位に切り上げ）だけ。
 * 1つの枠からは、枠の先頭と、そこから1時間ずつ後ろ（入るものだけ）を合わせて perSlot 件まで出す
 */
import type { Interval } from "../api/common.ts";

const STEP = 15 * 60_000;
const HOUR = 60 * 60_000;

export const PLACE_MAX = 9;

export function placeCandidates(
  slots: readonly Interval[],
  durMs: number,
  now: number | null,
  opts: { max?: number; perSlot?: number } = {},
): Interval[] {
  const max = opts.max ?? PLACE_MAX;
  const perSlot = opts.perSlot ?? 3;
  const lo = now === null ? Number.NEGATIVE_INFINITY : Math.ceil(now / STEP) * STEP;
  const out: Interval[] = [];
  for (const s of [...slots].sort((a, b) => a.start - b.start)) {
    let start = Math.max(s.start, lo);
    let n = 0;
    while (n < perSlot && start + durMs <= s.end && out.length < max) {
      out.push({ start, end: start + durMs });
      n++;
      start += HOUR;
    }
    if (out.length >= max) break;
  }
  return out;
}
