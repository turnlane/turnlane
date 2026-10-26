/**
 * 計画の目安（D-062・D-106。phase0-plan 3.3.1）: 設定 `work_hours.planned` の曜日ごとの開始・終了。空き時間と「明日朝」にだけ使う。
 * 本人の意図の値で、学習しない。稼働日（稼働曜日かつ祝日でない）だけに当てはめる。
 * 時刻は暦日の 0:00 からの分（終了は 24:00 = 1440 まで）。
 */
import type { Interval } from "../api/common.ts";
import { isoWeekday } from "../date/workdays.ts";
import { addDays, dayStartMs, wallToEpoch } from "../dates.ts";

export const WEEKDAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type WeekdayKey = (typeof WEEKDAY_KEYS)[number];

export interface PlannedSpan {
  startMin: number;
  endMin: number;
}

/** ISO の曜日（月 = 1 … 日 = 7）→ 計画の目安 */
export type PlannedHours = Record<number, PlannedSpan>;

export const DEFAULT_PLANNED_SPAN: PlannedSpan = { startMin: 10 * 60, endMin: 19 * 60 };

export function defaultPlannedHours(): PlannedHours {
  const out: PlannedHours = {};
  for (let d = 1; d <= 7; d++) out[d] = { ...DEFAULT_PLANNED_SPAN };
  return out;
}

/** "HH:MM"（00:00〜24:00）→ 分。不正なら null */
export function parsePlannedTime(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (min > 59 || h > 24 || (h === 24 && min !== 0)) return null;
  return h * 60 + min;
}

export function formatPlannedTime(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

/** 設定の値（`{"mon": {"start": "10:00", "end": "19:00"}, …}`）を読む。書いていない・壊れた曜日は既定値 */
export function readPlannedHours(v: unknown): PlannedHours {
  const out = defaultPlannedHours();
  if (!v || typeof v !== "object") return out;
  WEEKDAY_KEYS.forEach((k, i) => {
    const x = (v as Record<string, unknown>)[k];
    if (!x || typeof x !== "object") return;
    const { start, end } = x as { start?: unknown; end?: unknown };
    const s = typeof start === "string" ? parsePlannedTime(start) : null;
    const e = typeof end === "string" ? parsePlannedTime(end) : null;
    if (s !== null && e !== null && e > s) out[i + 1] = { startMin: s, endMin: e };
  });
  return out;
}

/** 設定に書く形へ */
export function plannedHoursValue(
  h: PlannedHours,
): Record<WeekdayKey, { start: string; end: string }> {
  const out = {} as Record<WeekdayKey, { start: string; end: string }>;
  WEEKDAY_KEYS.forEach((k, i) => {
    const x = h[i + 1] ?? DEFAULT_PLANNED_SPAN;
    out[k] = { start: formatPlannedTime(x.startMin), end: formatPlannedTime(x.endMin) };
  });
  return out;
}

/**
 * その日付の計画の目安（epoch ms）。稼働日でない日（workday === false）は null。
 * 24:00 は翌日の 0:00（夏時間の日も壁時計どおり）
 */
export function plannedOn(
  date: string,
  hours: PlannedHours,
  tz: string,
  workday: boolean | null,
): Interval | null {
  if (workday === false) return null;
  const x = hours[isoWeekday(date)] ?? DEFAULT_PLANNED_SPAN;
  const at = (min: number) => {
    if (min >= 1440) return dayStartMs(addDays(date, 1), tz, 0);
    const [y, mo, d] = date.split("-").map(Number) as [number, number, number];
    return wallToEpoch(y, mo, d, min, tz);
  };
  return { start: at(x.startMin), end: at(x.endMin) };
}
