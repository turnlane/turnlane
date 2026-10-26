/**
 * ドラッグ操作の計算（M2-17・M2-18。ux-mvp 7章）。週ボード（とデイビュー）が同じ純粋関数を使う。
 * - 時間軸の上では15分単位にスナップする（`⌥` で5分）
 * - 時間ブロックの高さ = 見積、無ければ30分
 * - 並べ替えは前後のタスクの ID（`POST /api/tasks/:id/move` の beforeId / afterId）で表す
 * - ドラッグ中のヘッダの容量（Planned）はドロップ後の値に置き換える
 */
import type { DayTotals, TaskView } from "../api/board.ts";
import type { Interval } from "../api/common.ts";
import { addDays, formatLocalDate, wallClock, wallToEpoch } from "../dates.ts";
import { UNESTIMATED_MS } from "./capacity.ts";

export const SNAP_MIN = 15;
export const FINE_SNAP_MIN = 5;
export const DEFAULT_BLOCK_MIN = 30;

const MIN = 60_000;

/** 時間ブロックの長さ（見積。無いか 0 なら30分） */
export function blockDurationMs(estimateMin: number | null): number {
  return (estimateMin && estimateMin > 0 ? estimateMin : DEFAULT_BLOCK_MIN) * MIN;
}

/** 時間軸の起点からのスナップ（axis.start は暦日の 0:00 なので、15分単位は時計の15分になる） */
export function snapMs(t: number, origin: number, stepMin: number): number {
  const step = stepMin * MIN;
  return origin + Math.round((t - origin) / step) * step;
}

/**
 * 時間軸へのドロップ: ブロックの開始 = ポインタの時刻 − つかんだ位置（ブロックの上端からの時間）をスナップしたもの。
 * 長さは保ったまま、時間軸（その日の 0:00〜24:00）に収める
 */
export function dropRange(p: {
  pointer: number;
  grabOffsetMs: number;
  durationMs: number;
  axis: Interval;
  stepMin: number;
}): Interval {
  const step = p.stepMin * MIN;
  const dur = Math.max(step, p.durationMs);
  let start = snapMs(p.pointer - p.grabOffsetMs, p.axis.start, p.stepMin);
  start = Math.max(
    p.axis.start,
    Math.min(start, p.axis.end - Math.min(dur, p.axis.end - p.axis.start)),
  );
  return { start, end: start + dur };
}

/** 下端のドラッグ（伸縮）: 終了をスナップし、最短は1単位、時間軸の終わりまで */
export function resizeEnd(p: {
  pointer: number;
  start: number;
  axis: Interval;
  stepMin: number;
}): number {
  const step = p.stepMin * MIN;
  const end = snapMs(p.pointer, p.axis.start, p.stepMin);
  return Math.min(p.axis.end, Math.max(p.start + step, end));
}

/** 空白の範囲選択: 押した位置と今の位置を、それぞれ近いスナップの位置へ（上向きでもよい。最短1単位） */
export function selectRange(p: {
  from: number;
  to: number;
  axis: Interval;
  stepMin: number;
}): Interval {
  const step = p.stepMin * MIN;
  const clamp = (t: number) => Math.max(p.axis.start, Math.min(p.axis.end, t));
  const a = clamp(snapMs(p.from, p.axis.start, p.stepMin));
  const b = clamp(snapMs(p.to, p.axis.start, p.stepMin));
  const start = Math.min(a, b);
  let end = Math.max(a, b);
  if (end - start < step) end = Math.min(p.axis.end, start + step);
  return { start: Math.min(start, end - step), end };
}

/** 区間と busy な予定の重なり（ms。予定どうしの重なりは1回だけ数える） */
export function busyOverlapMs(range: Interval, busy: readonly Interval[]): number {
  const xs = busy
    .map((b) => ({ start: Math.max(b.start, range.start), end: Math.min(b.end, range.end) }))
    .filter((b) => b.end > b.start)
    .sort((a, b) => a.start - b.start);
  let total = 0;
  let curStart = -1;
  let curEnd = -1;
  for (const x of xs) {
    if (x.start <= curEnd) curEnd = Math.max(curEnd, x.end);
    else {
      total += curEnd - curStart;
      curStart = x.start;
      curEnd = x.end;
    }
  }
  return total + (curEnd - curStart);
}

/**
 * 並べ替え: 並び（ids、移すタスクを含んでいてよい）の over の前か後ろへ移すときの、前後の ID。
 * beforeId = 移した後に直前に来るもの、afterId = 直後に来るもの（どちらも無ければ null）
 */
export function neighborsFor(
  ids: readonly string[],
  movedId: string,
  overId: string | null,
  place: "before" | "after",
): { beforeId: string | null; afterId: string | null } {
  const rest = ids.filter((x) => x !== movedId);
  if (overId === null || !rest.includes(overId)) {
    return { beforeId: rest.at(-1) ?? null, afterId: null };
  }
  const i = rest.indexOf(overId);
  const at = place === "before" ? i : i + 1;
  return { beforeId: rest[at - 1] ?? null, afterId: rest[at] ?? null };
}

/** タスクが Planned に数えられるか（m2-api 9.1: 自分の番のタスクとやめたものは数えない） */
export function countsAsPlanned(t: Pick<TaskView, "followUpId" | "status">): boolean {
  return (
    t.followUpId === null && (t.status === "todo" || t.status === "doing" || t.status === "done")
  );
}

/**
 * ドラッグ中のヘッダ（ux-mvp 7章）: タスクを日付から外す（sign = -1）か、日付に足す（+1）ときの集計。
 * Free は時間ブロックを引かないので変わらない
 */
export function plannedWith(
  totals: DayTotals,
  task: Pick<TaskView, "estimateMin" | "followUpId" | "status">,
  sign: 1 | -1,
): DayTotals {
  if (!countsAsPlanned(task)) return totals;
  const ms = task.estimateMin === null ? UNESTIMATED_MS : task.estimateMin * MIN;
  return {
    ...totals,
    plannedMs: Math.max(0, totals.plannedMs + sign * ms),
    plannedUnestimated: Math.max(
      0,
      totals.plannedUnestimated + (task.estimateMin === null ? sign : 0),
    ),
  };
}

/** 日付の差（b − a、日数） */
export function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** 時刻を壁時計のまま days 日ずらす（夏時間の日も同じ時刻に置く） */
export function shiftByDays(ms: number, days: number, tz: string): number {
  const w = wallClock(ms, tz);
  const [y, mo, d] = addDays(formatLocalDate(w.year, w.month, w.day), days)
    .split("-")
    .map(Number) as [number, number, number];
  return wallToEpoch(y, mo, d, w.hour * 60 + w.minute, tz) + (ms % 60_000);
}
