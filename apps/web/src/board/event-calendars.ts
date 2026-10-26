/**
 * 新規の予定の書き先の選択（作成のポップオーバー）。選択肢は書き込めて無視していないカレンダーを、アカウントごとに
 * まとめて並べる。初期値は設定の書き先（Calendar.app のデフォルトカレンダー）。選び直したら、その予定だけそこへ作る
 * （設定の書き先は変えない。次に開いたときは設定の書き先に戻る）
 */
import type { CalendarColorKey } from "@turnlane/core/web";
import type { CalendarView, EventsStatus } from "@turnlane/daemon";
import { calColor } from "../lib/cal-color.ts";

export interface EventCalendarChoice {
  id: string;
  name: string;
  account: string | null;
  color: string | null;
  colorKey: CalendarColorKey | null;
}

type DefaultCalendar = NonNullable<EventsStatus["calendar"]>;

/**
 * 書き先の選択肢: 書き込めて無視していない（role = source）カレンダー。設定の書き先は（無視していても）必ず含める。
 * アカウントごとにまとめる（アカウント名・名前の順。アカウントの無いものは先頭）
 */
export function eventCalendarChoices(
  calendars: readonly CalendarView[],
  defaultCal: DefaultCalendar | null,
): EventCalendarChoice[] {
  const out: EventCalendarChoice[] = calendars
    .filter((c) => (c.writable && c.role === "source") || c.id === defaultCal?.id)
    .map((c) => ({
      id: c.id,
      name: c.name,
      account: c.account,
      color: c.color,
      colorKey: c.colorKey,
    }));
  if (defaultCal && !out.some((c) => c.id === defaultCal.id)) out.push({ ...defaultCal });
  const key = (c: EventCalendarChoice) => c.account ?? "";
  return out.sort((a, b) => key(a).localeCompare(key(b)) || a.name.localeCompare(b.name));
}

/** 選択を出すか（書き込める書き先が2つ以上のときだけ。1つなら今と同じ見た目） */
export function showCalendarPicker(choices: readonly EventCalendarChoice[]): boolean {
  return choices.length >= 2;
}

/**
 * 作る予定の書き先: 選んだもの（無ければ・選択肢に無ければ設定の書き先）。explicit は設定の書き先と違うものを
 * 選んだとき（そのときだけ API に calendarId を送る。送らなければ今と同じく Calendar.app のデフォルトへ）
 */
export function eventTargetOf(
  choices: readonly EventCalendarChoice[],
  defaultCal: DefaultCalendar | null,
  picked: string | null,
): { calendar: EventCalendarChoice | null; explicit: boolean } {
  const chosen = picked ? (choices.find((c) => c.id === picked) ?? null) : null;
  if (chosen && chosen.id !== defaultCal?.id) return { calendar: chosen, explicit: true };
  return { calendar: defaultCal ? { ...defaultCal } : chosen, explicit: false };
}

/** 入力欄・上端の線・楽観的に出す予定の色（Turnlane の中で選んだ色があればそれ。D-125） */
export function choiceColor(c: EventCalendarChoice | null): string | null {
  return c ? calColor(c.color, c.colorKey, "") || null : null;
}
