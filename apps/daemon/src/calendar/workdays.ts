/**
 * 稼働日の規則を DB のキャッシュから組み立てる（M3-6）。週ボード・turnlane calendar status・（M4 の）持ち越しが使う。
 * 祝日カレンダーの自動判定に要るカレンダーの種類（誕生日か）は DB に列が無いので、ヘルパから最後に受け取った
 * 一覧（CalendarSync が持つ）を使う。デーモンの起動直後でまだ一覧が無いときは自動判定の候補が無い（祝日なし）。
 */
import type { Database } from "bun:sqlite";
import {
  type HolidayEventFact,
  type HolidayMode,
  holidayDates,
  resolveHolidayCalendars,
  type TurnlaneSettings,
  type WorkdayRule,
} from "@turnlane/core";

export interface HolidayState {
  mode: HolidayMode;
  calendars: { id: string; name: string }[];
  /** 祝日の論理日付 → 祝日名（窓の中だけ） */
  dates: Map<string, string | null>;
}

export function holidayState(
  db: Database,
  settings: Pick<TurnlaneSettings, "holidayCalendars">,
  types: ReadonlyMap<string, string>,
): HolidayState {
  const cals = db
    .query<{ id: string; name: string; is_writable: number }, []>(
      "SELECT id, name, is_writable FROM calendar ORDER BY name, id",
    )
    .all();
  const events = db
    .query<
      {
        calendarId: string;
        allDay: number;
        startDate: string | null;
        endDate: string | null;
        title: string | null;
      },
      []
    >(
      `SELECT calendar_id AS calendarId, all_day AS allDay, start_date AS startDate, end_date AS endDate, title
         FROM calendar_event e
        WHERE (e.status IS NULL OR e.status <> 'cancelled')
        ORDER BY start_at`,
    )
    .all()
    .map((e): HolidayEventFact => ({ ...e, allDay: e.allDay === 1 }));
  const r = resolveHolidayCalendars(
    settings.holidayCalendars,
    cals.map((c) => ({ id: c.id, isWritable: c.is_writable === 1, type: types.get(c.id) ?? null })),
    events,
  );
  const byId = new Map(cals.map((c) => [c.id, c.name]));
  return {
    mode: r.mode,
    calendars: r.ids.map((id) => ({ id, name: byId.get(id) ?? "(missing)" })),
    dates: holidayDates(events, r.ids),
  };
}

export function workdayRule(
  db: Database,
  settings: Pick<TurnlaneSettings, "holidayCalendars" | "workdays">,
  types: ReadonlyMap<string, string>,
): WorkdayRule {
  return {
    weekdays: settings.workdays,
    holidays: new Set(holidayState(db, settings, types).dates.keys()),
  };
}
