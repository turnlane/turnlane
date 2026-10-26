import { fmtClock, wallClock } from "@turnlane/core/web";

/**
 * 戻る時刻の表記（自分の番の画面の「後で」の右端、スヌーズの「時刻を指定…」）: 暦の今日なら `9:00`、今日でなければ
 * `10/28 14:00`（日付は相対でなく実際の日付）
 */
export function clockOrDate(ms: number, now: number, tz: string): string {
  const a = wallClock(ms, tz);
  const b = wallClock(now, tz);
  const same = a.year === b.year && a.month === b.month && a.day === b.day;
  return same ? fmtClock(ms, tz) : `${a.month}/${a.day} ${fmtClock(ms, tz)}`;
}
