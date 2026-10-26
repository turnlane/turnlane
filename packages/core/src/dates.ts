/**
 * 論理日付（phase0-plan 2.2）。「どの日のレーンか」は日付区切り（既定 04:00）を適用した
 * `YYYY-MM-DD` で持つ。例: 区切り 04:00 なら 1/2 の 03:59 は 1/1 の日に入る。
 */

/** 日付区切り。0 時からの分（既定 04:00 = 240） */
export type DayBoundary = number;
export const DEFAULT_DAY_BOUNDARY: DayBoundary = 4 * 60;

const LOCAL_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(tz, f);
  }
  return f;
}

/** 実行環境のタイムゾーン（IANA 名） */
export function systemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** `"04:00"` → 240。範囲外や書式違いは例外。 */
export function parseDayBoundary(hhmm: string): DayBoundary {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) throw new Error(`invalid day boundary: ${hhmm}`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) throw new Error(`invalid day boundary: ${hhmm}`);
  return h * 60 + min;
}

export interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

/** epoch ms をタイムゾーン tz の壁時計に変換する。 */
export function wallClock(ms: number, tz: string): WallClock {
  const parts: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
  for (const p of formatterFor(tz).formatToParts(ms)) parts[p.type] = p.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

/**
 * epoch ms の論理日付。壁時計の時刻が区切りより前なら前日になる。
 * 夏時間の切り替わりでも「壁時計で比較する」ので、区切りの意味（例: 午前4時）は保たれる。
 */
export function toLocalDate(
  ms: number,
  tz: string,
  boundary: DayBoundary = DEFAULT_DAY_BOUNDARY,
): string {
  const w = wallClock(ms, tz);
  const date = formatLocalDate(w.year, w.month, w.day);
  return w.hour * 60 + w.minute < boundary ? addDays(date, -1) : date;
}

export function formatLocalDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function isLocalDate(s: string): boolean {
  const m = LOCAL_DATE_RE.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCDate() === Number(m[3]) && d.getUTCMonth() === Number(m[2]) - 1;
}

/** `YYYY-MM-DD` に日数を足す（暦の計算。タイムゾーンに依存しない）。 */
export function addDays(date: string, days: number): string {
  const m = LOCAL_DATE_RE.exec(date);
  if (!m) throw new Error(`invalid local date: ${date}`);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days));
  return formatLocalDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/** `YYYYMMDD`（ファイル名用） */
export function compactDate(date: string): string {
  if (!LOCAL_DATE_RE.test(date)) throw new Error(`invalid local date: ${date}`);
  return date.replaceAll("-", "");
}

/** タイムゾーン tz の壁時計（年月日 + 0 時からの分）を epoch ms にする。夏時間の切り替わりでも収束するまで補正する */
export function wallToEpoch(
  year: number,
  month: number,
  day: number,
  minutes: number,
  tz: string,
): number {
  const target = Date.UTC(year, month - 1, day, 0, minutes);
  let guess = target;
  for (let i = 0; i < 4; i++) {
    const w = wallClock(guess, tz);
    const diff = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute) - target;
    if (diff === 0) break;
    guess -= diff;
  }
  return guess;
}

/** 論理日付の始まり（その日の日付区切りの時刻）の epoch ms */
export function dayStartMs(
  date: string,
  tz: string,
  boundary: DayBoundary = DEFAULT_DAY_BOUNDARY,
): number {
  const m = LOCAL_DATE_RE.exec(date);
  if (!m) throw new Error(`invalid local date: ${date}`);
  return wallToEpoch(Number(m[1]), Number(m[2]), Number(m[3]), boundary, tz);
}

/** 論理日付の終わり（翌日の始まり）の epoch ms */
export function dayEndMs(
  date: string,
  tz: string,
  boundary: DayBoundary = DEFAULT_DAY_BOUNDARY,
): number {
  return dayStartMs(addDays(date, 1), tz, boundary);
}

/** その論理日付の 0:00 からの経過分（日付区切りより後の深夜は 24:00 以降。例 1:00 → 1500） */
export function minutesOfLogicalDay(
  ms: number,
  date: string,
  tz: string,
  boundary: DayBoundary = DEFAULT_DAY_BOUNDARY,
): number {
  return (ms - dayStartMs(date, tz, boundary)) / 60_000 + boundary;
}
