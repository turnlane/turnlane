/**
 * カレンダーの色（D-125）。Turnlane の中で選んだ色（パレットのキー）があればテーマのトークン `--dl-cal-<key>`、
 * 無ければカレンダーアプリの色（同期した値）。予定の面・作成のポップオーバーの上端・設定の色の丸がこれを使う
 */
import { CALENDAR_COLOR_KEYS, type CalendarColorKey, isCalendarColorKey } from "@turnlane/core/web";
import type { MessageKey } from "../i18n/index.tsx";

export const CAL_COLOR_FALLBACK = "var(--dl-text-3)";

export function calColorVar(key: CalendarColorKey): string {
  return `var(--dl-cal-${key})`;
}

export function calColor(
  color: string | null | undefined,
  key: string | null | undefined,
  fallback: string = CAL_COLOR_FALLBACK,
): string {
  if (isCalendarColorKey(key)) return calColorVar(key);
  return color ?? fallback;
}

/** パレットの並び（Google カレンダーの色の選択と同じく、暖色から寒色、最後に茶と灰） */
export const PALETTE: readonly CalendarColorKey[] = CALENDAR_COLOR_KEYS;

export function paletteLabel(key: CalendarColorKey): MessageKey {
  return `calColor.${key}` as MessageKey;
}
