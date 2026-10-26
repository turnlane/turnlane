/**
 * 拡張に渡す予定の事実（ExtDeps.calendar.events。ADR 0015）。空き時間と同じ busy の判定で、時刻付きの予定だけ。
 * 会議の判定は集中モードの対象（isFocusTarget の meetings）と同じ。題名・場所・参加者・会議リンクは渡さない
 */
import type { Database } from "bun:sqlite";
import { derive } from "@turnlane/core";
import { isFocusTarget } from "@turnlane/core/web";
import type { ExtCalendarEvent } from "./types.ts";

export function extCalendarEvents(db: Database, from: number, to: number): ExtCalendarEvent[] {
  return db
    .query<
      {
        id: string;
        start_at: number;
        end_at: number;
        status: derive.CalendarEventFact["status"];
        availability: derive.CalendarEventFact["availability"];
        self_response: derive.CalendarEventFact["selfResponse"];
        role: derive.CalendarEventFact["calendarRole"];
        has_attendees: number | null;
        has_meeting_link: number | null;
      },
      [number, number]
    >(
      `SELECT e.id, e.start_at, e.end_at, e.status, e.availability, e.self_response, c.role,
              e.has_attendees, e.has_meeting_link
         FROM calendar_event e JOIN calendar c ON c.id = e.calendar_id
        WHERE c.role = 'source' AND e.is_own_timeblock = 0 AND e.all_day = 0
          AND (e.status IS NULL OR e.status <> 'cancelled') AND e.end_at > ? AND e.start_at < ?
        ORDER BY e.start_at, e.id`,
    )
    .all(from, to)
    .flatMap((r) => {
      const busy = derive.isBusyEvent({
        startAt: r.start_at,
        endAt: r.end_at,
        status: r.status,
        availability: r.availability,
        selfResponse: r.self_response,
        isOwnTimeblock: false,
        calendarRole: r.role,
      });
      if (!busy) return [];
      const meeting = isFocusTarget(
        {
          id: r.id,
          title: null,
          start: r.start_at,
          end: r.end_at,
          allDay: false,
          busy,
          hasAttendees: r.has_attendees === null ? null : r.has_attendees === 1,
          hasMeetingLink: r.has_meeting_link === null ? null : r.has_meeting_link === 1,
        },
        "meetings",
      );
      return [{ id: r.id, start: r.start_at, end: r.end_at, meeting }];
    });
}
