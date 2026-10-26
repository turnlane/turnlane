/**
 * 容量（Free / Planned。m2-api.md 9.1、D-047 (1)・D-049 (2)(3)・D-106）。サーバーが DayTotals に入れて返し、
 * DnD 中はクライアントが同じ関数で再計算する。
 *
 * - 計画の窓（今日）: 計画の目安（D-106。設定 `work_hours.planned`）と [今, 終わり] の重なり。今が目安の終わりを
 *   過ぎていれば窓なし（Free 0）。計画の無い今日（稼働日でない）は窓なし
 * - 計画の窓（未来）: 計画の目安（D-062）。稼働日でない日（workday === false）は窓なし（D-049 (2)）
 * - Free = 窓の長さ − busy な予定の和集合と窓の重なりを15分単位に切り捨てる（0 未満にしない。D-062）。
 *   時間ブロックは引かない
 * - Planned = 対象のタスクの見積の和。見積の無いタスクは30分とみなし、件数を plannedUnestimated に返す
 * - 過去は 0（UI は出さない）
 */
import type { Interval } from "../api/common.ts";

export const UNESTIMATED_MS = 30 * 60_000;
/** Free を丸める単位（D-062） */
export const FREE_STEP_MS = 15 * 60_000;

export interface CapacityInput {
  phase: "past" | "today" | "future";
  now: number;
  /** その日の計画の目安（D-062・D-106）。稼働日でない日は null */
  planned: Interval | null;
  /** 稼働日か（M3-6 まで null = 稼働日として扱う） */
  workday: boolean | null;
  /** busy な予定（自分の時間ブロックは含まない） */
  busy: readonly Interval[];
  /** 対象のタスクの見積（分。null = 見積なし） */
  estimates: readonly (number | null)[];
}

export interface Capacity {
  freeMs: number;
  plannedMs: number;
  plannedUnestimated: number;
}

function unionLength(xs: readonly Interval[], within: Interval): number {
  const clipped = xs
    .map((x) => ({ start: Math.max(x.start, within.start), end: Math.min(x.end, within.end) }))
    .filter((x) => x.end > x.start)
    .sort((a, b) => a.start - b.start);
  let total = 0;
  let cur: Interval | null = null;
  for (const x of clipped) {
    if (cur && x.start <= cur.end) cur.end = Math.max(cur.end, x.end);
    else {
      if (cur) total += cur.end - cur.start;
      cur = { ...x };
    }
  }
  if (cur) total += cur.end - cur.start;
  return total;
}

/** その日の計画の窓（Free の分母）。無ければ null */
export function planWindow(
  i: Pick<CapacityInput, "phase" | "now" | "planned" | "workday">,
): Interval | null {
  if (i.phase === "past" || i.workday === false || !i.planned) return null;
  if (i.phase === "future") return i.planned;
  const start = Math.max(i.planned.start, i.now);
  return i.planned.end > start ? { start, end: i.planned.end } : null;
}

export function capacity(i: CapacityInput): Capacity {
  if (i.phase === "past") return { freeMs: 0, plannedMs: 0, plannedUnestimated: 0 };
  const w = planWindow(i);
  const raw = w ? Math.max(0, w.end - w.start - unionLength(i.busy, w)) : 0;
  const freeMs = Math.floor(raw / FREE_STEP_MS) * FREE_STEP_MS;
  let plannedMs = 0;
  let plannedUnestimated = 0;
  for (const e of i.estimates) {
    if (e === null) {
      plannedUnestimated++;
      plannedMs += UNESTIMATED_MS;
    } else plannedMs += e * 60_000;
  }
  return { freeMs, plannedMs, plannedUnestimated };
}

/**
 * 空き枠（デイビューの Unscheduled の `Free 12:00–13:00, 15:45–18:00`。m2-api.md 2.3 の freeSlots）:
 * 計画の窓から busy な予定と時間ブロックを引いた区間。始まりは15分単位に切り上げ、終わりは切り捨て、15分未満は出さない。
 * from を渡すと、それより前は出さない（今日は今より後だけ）
 */
export function freeSlots(
  window: Interval | null,
  taken: readonly Interval[],
  from: number | null = null,
): Interval[] {
  if (!window) return [];
  const lo = Math.max(window.start, from ?? window.start);
  if (lo >= window.end) return [];
  const xs = taken
    .map((x) => ({ start: Math.max(x.start, lo), end: Math.min(x.end, window.end) }))
    .filter((x) => x.end > x.start)
    .sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  let cur = lo;
  const push = (s: number, e: number) => {
    const start = Math.ceil(s / FREE_STEP_MS) * FREE_STEP_MS;
    const end = Math.floor(e / FREE_STEP_MS) * FREE_STEP_MS;
    if (end - start >= FREE_STEP_MS) out.push({ start, end });
  };
  for (const x of xs) {
    if (x.start > cur) push(cur, x.start);
    cur = Math.max(cur, x.end);
  }
  if (cur < window.end) push(cur, window.end);
  return out;
}
