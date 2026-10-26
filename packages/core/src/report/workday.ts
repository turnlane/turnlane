/**
 * シャットダウンの持ち越し先（D-040）の既定の判定: 土日を除く平日。デーモンは M3-6 の `carryTarget` / `nextWorkday`
 * （稼働曜日の設定と祝日カレンダー。core/date/workdays.ts）を使い、これは稼働日の規則を渡されなかったときと、
 * UI が応答を待つ間の仮の値にだけ使う。
 */
import { addDays } from "../dates.ts";

export function isWeekday(date: string): boolean {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const dow = new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay();
  return dow !== 0 && dow !== 6;
}

/** date の次の稼働日（date 自身は含まない） */
export function nextWeekday(date: string, isWorkday: (d: string) => boolean = isWeekday): string {
  let d = addDays(date, 1);
  for (let i = 0; i < 31 && !isWorkday(d); i++) d = addDays(d, 1);
  return d;
}
