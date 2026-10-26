/**
 * 稼働日（M3-6。phase0-plan 4.5、D-040）。
 * 稼働日 = 稼働曜日に含まれ、かつ祝日でない日。曜日は ISO の番号（月 = 1 … 日 = 7）。
 * 祝日は Mac のカレンダーの祝日カレンダーの終日予定から求めた日付の集合（calendar/holidays.ts）。
 * 窓（7日前〜21日後）の外は祝日なしとして扱う（集合に入っていないだけ）。
 */
import { addDays, isLocalDate } from "../dates.ts";

export interface WorkdayRule {
  /** 稼働曜日（ISO: 月 = 1 … 日 = 7） */
  weekdays: readonly number[];
  /** 祝日の論理日付（'YYYY-MM-DD'） */
  holidays: ReadonlySet<string>;
}

/** 既定の稼働曜日（月〜金。ロケールから推測しない） */
export const DEFAULT_WORKDAYS: readonly number[] = [1, 2, 3, 4, 5];

/** 'YYYY-MM-DD' の ISO 曜日（月 = 1 … 日 = 7） */
export function isoWeekday(date: string): number {
  if (!isLocalDate(date)) throw new Error(`invalid date: ${date}`);
  const d = new Date(`${date}T12:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
}

export function isWorkday(date: string, rule: WorkdayRule): boolean {
  return rule.weekdays.includes(isoWeekday(date)) && !rule.holidays.has(date);
}

/**
 * date より後の最初の稼働日。稼働曜日が空なら null（どこにも持ち越せない）。
 * 祝日が続いても稼働曜日があれば有限の日数で見つかる（祝日は窓の中だけ）
 */
export function nextWorkday(date: string, rule: WorkdayRule): string | null {
  if (!rule.weekdays.some((w) => w >= 1 && w <= 7)) return null;
  let d = addDays(date, 1);
  // 祝日の集合は有限なので、その件数 + 7 日の中に必ず稼働日がある
  for (let i = 0; i < rule.holidays.size + 8; i++) {
    if (isWorkday(d, rule)) return d;
    d = addDays(d, 1);
  }
  return null;
}

/** date より前の最後の稼働日（nextWorkday と対。3日ボードの前の列。D-074）。稼働曜日が空なら null */
export function prevWorkday(date: string, rule: WorkdayRule): string | null {
  if (!rule.weekdays.some((w) => w >= 1 && w <= 7)) return null;
  let d = addDays(date, -1);
  for (let i = 0; i < rule.holidays.size + 8; i++) {
    if (isWorkday(d, rule)) return d;
    d = addDays(d, -1);
  }
  return null;
}

/** date から until（含む）までのうち、稼働日でない日と理由（持ち越しで飛ばした理由を出すため） */
export function skippedDays(
  date: string,
  until: string,
  rule: WorkdayRule,
): { date: string; reason: "weekday" | "holiday" }[] {
  const out: { date: string; reason: "weekday" | "holiday" }[] = [];
  for (let d = date; d <= until; d = addDays(d, 1)) {
    if (!rule.weekdays.includes(isoWeekday(d))) out.push({ date: d, reason: "weekday" });
    else if (rule.holidays.has(d)) out.push({ date: d, reason: "holiday" });
  }
  return out;
}

/**
 * シャットダウンの持ち越し先（D-040、M4-2）: date の次の稼働日と、その間で飛ばした祝日（日報の Carried over に理由を出す）。
 * 稼働曜日が空なら翌日（どこにも持ち越せないよりよい）
 */
export function carryTarget(
  date: string,
  rule: WorkdayRule,
  holidayNames: ReadonlyMap<string, string | null> = new Map(),
): { to: string; skippedHolidays: { date: string; name: string | null }[] } {
  const to = nextWorkday(date, rule) ?? addDays(date, 1);
  const from = addDays(date, 1);
  const skippedHolidays =
    from < to
      ? skippedDays(from, addDays(to, -1), rule)
          .filter((x) => x.reason === "holiday")
          .map((x) => ({ date: x.date, name: holidayNames.get(x.date) ?? null }))
      : [];
  return { to, skippedHolidays };
}

/**
 * 3日ボードの左の列（D-076）: 前の稼働日と、実際に作業した直近の日（around より前で本人の操作がある日。
 * AI への入力・Turnlane の操作・タスクの完了）のうち新しい方。稼働曜日が空なら前日と作業日の新しい方
 */
export function boardPrevDay(around: string, rule: WorkdayRule, lastWorked: string | null): string {
  const prev = prevWorkday(around, rule) ?? addDays(around, -1);
  return lastWorked !== null && lastWorked < around && lastWorked > prev ? lastWorked : prev;
}
