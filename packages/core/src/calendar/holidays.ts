/**
 * 祝日カレンダーの判定と祝日の日付（M3-6。phase0-plan 4.5 の「稼働日と祝日の判定方式」、D-040・D-044 (3)）。
 *
 * - 設定 `workdays.holiday_calendars` が null（未設定）なら自動: 次をすべて満たすカレンダーを採用する
 *   (1) 書き込み不可で、誕生日カレンダーではない (2) 窓内の予定がすべて終日で、その9割以上が1日だけ
 *   (3) 窓内に1件以上の予定がある。カレンダー名は見ない（言語で変わるため）。該当が複数なら和集合
 * - 配列なら手動（[] は祝日なし）。一度選んだら自動判定はしない
 * - 祝日の日付は、祝日カレンダーの終日予定の start_date〜end_date（終わりを含まない）。時刻付きの予定は無視する
 */
import { addDays } from "../dates.ts";

export interface HolidayCalendarFact {
  id: string;
  isWritable: boolean;
  /** EKCalendar の種類（"birthday" など）。ヘルパから一覧を受け取るまでは分からない（null） */
  type: string | null;
}

export interface HolidayEventFact {
  calendarId: string;
  allDay: boolean;
  startDate: string | null;
  endDate: string | null;
  title: string | null;
}

export type HolidayMode = "auto" | "manual" | "none";

const SINGLE_DAY_RATIO = 0.9;

/** 自動判定の候補（種類が分からないカレンダーは候補にしない。誕生日を祝日にしないため） */
export function isHolidayCandidate(c: HolidayCalendarFact): boolean {
  return !c.isWritable && c.type !== null && c.type !== "birthday";
}

export function detectHolidayCalendars(
  calendars: readonly HolidayCalendarFact[],
  events: readonly HolidayEventFact[],
): string[] {
  const byCal = new Map<string, HolidayEventFact[]>();
  for (const e of events) {
    const xs = byCal.get(e.calendarId) ?? [];
    xs.push(e);
    byCal.set(e.calendarId, xs);
  }
  const out: string[] = [];
  for (const c of calendars) {
    if (!isHolidayCandidate(c)) continue;
    const xs = byCal.get(c.id) ?? [];
    if (xs.length === 0) continue;
    if (!xs.every((e) => e.allDay && e.startDate && e.endDate)) continue;
    const single = xs.filter((e) => e.endDate === addDays(e.startDate as string, 1)).length;
    if (single / xs.length >= SINGLE_DAY_RATIO) out.push(c.id);
  }
  return out.sort();
}

/** 設定の値 → 採用する祝日カレンダー */
export function resolveHolidayCalendars(
  setting: readonly string[] | null | undefined,
  calendars: readonly HolidayCalendarFact[],
  events: readonly HolidayEventFact[],
): { mode: HolidayMode; ids: string[] } {
  if (setting === null || setting === undefined) {
    return { mode: "auto", ids: detectHolidayCalendars(calendars, events) };
  }
  if (setting.length === 0) return { mode: "none", ids: [] };
  return { mode: "manual", ids: [...setting].sort() };
}

/** 祝日の日付 → 祝日名（予定の題名をそのまま使う。複数あれば最初のもの） */
export function holidayDates(
  events: readonly HolidayEventFact[],
  calendarIds: readonly string[],
): Map<string, string | null> {
  const ids = new Set(calendarIds);
  const out = new Map<string, string | null>();
  for (const e of events) {
    if (!ids.has(e.calendarId) || !e.allDay || !e.startDate || !e.endDate) continue;
    for (let d = e.startDate; d < e.endDate; d = addDays(d, 1)) {
      if (!out.has(d)) out.set(d, e.title);
    }
  }
  return out;
}

/**
 * 「Holidays from」の表示用に、採用した祝日カレンダーを名前でまとめる（D-057 (2)）。
 * 同じ祝日カレンダーを複数のアカウントで購読していると同じ名前が並ぶので、1つにして件数を添える
 * （例「日本の祝日（3 アカウント）」/ "Japanese Holidays (3 accounts)"）。判定（和集合）には使わない。表示だけ。
 * 順序は最初に現れた順
 */
export function groupHolidaySources(
  calendars: readonly { name: string }[],
): { name: string; count: number }[] {
  const out: { name: string; count: number }[] = [];
  for (const c of calendars) {
    const g = out.find((x) => x.name === c.name);
    if (g) g.count++;
    else out.push({ name: c.name, count: 1 });
  }
  return out;
}
