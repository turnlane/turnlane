/**
 * カレンダーの色のパレット（D-125）。Turnlane の中だけで選ぶ色で、カレンダーアプリ・Google 側の色は書き換えない。
 * ここはキーと並び順だけ。値はテーマ（ライト・ダーク）ごとに web のトークン `--dl-cal-<key>`（apps/web/src/styles.css）に持つ。
 * DB（calendar.color_key）と API にはキーを入れる。キーを消すと保存済みの色がカレンダーアプリの色に戻るので、消さずに足す
 */
export const CALENDAR_COLOR_KEYS = [
  "red",
  "orange",
  "yellow",
  "lime",
  "green",
  "sky",
  "blue",
  "lavender",
  "purple",
  "pink",
  "brown",
  "gray",
] as const;

export type CalendarColorKey = (typeof CALENDAR_COLOR_KEYS)[number];

export function isCalendarColorKey(v: unknown): v is CalendarColorKey {
  return typeof v === "string" && (CALENDAR_COLOR_KEYS as readonly string[]).includes(v);
}
