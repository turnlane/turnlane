import { addDays, isLocalDate } from "@turnlane/core/web";

/** 日付に日数を足す（不正な日付ならそのまま返す） */
export function addDaysSafe(date: string, days: number): string {
  return isLocalDate(date) ? addDays(date, days) : date;
}
