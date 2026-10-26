/**
 * 新規の予定の書き先の選択（作成のポップオーバー。event-calendars.ts と editors.tsx の CalendarPicker）:
 * 選択肢・出すかどうか・初期値・選び直したときの書き先と色。カレンダー名・アカウントは架空のもの
 */
import { describe, expect, test } from "bun:test";
import type { CalendarView, EventsStatus } from "@turnlane/daemon";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CalendarPicker } from "../src/board/editors.tsx";
import {
  choiceColor,
  eventCalendarChoices,
  eventTargetOf,
  showCalendarPicker,
} from "../src/board/event-calendars.ts";

const cal = (p: Partial<CalendarView> & { id: string; name: string }): CalendarView => ({
  account: "example.com",
  color: "#6b8cc7",
  colorKey: null,
  writable: true,
  type: "calDAV",
  role: "source",
  isDefault: false,
  holiday: false,
  events: 0,
  lastSyncedAt: null,
  ...p,
});

const work = cal({ id: "c-work", name: "Work", isDefault: true });
const personal = cal({
  id: "c-personal",
  name: "Personal",
  account: "iCloud",
  color: "#9b7cf0",
  colorKey: "lavender",
});
const family = cal({ id: "c-family", name: "Family", account: "iCloud", color: "#e08a5a" });
const readOnly = cal({ id: "c-shared", name: "Team", writable: false });
const ignored = cal({ id: "c-old", name: "Old", role: "ignored" });
const holidays = cal({ id: "c-hol", name: "Holidays", writable: false, type: "subscription" });

const def: NonNullable<EventsStatus["calendar"]> = {
  id: work.id,
  name: work.name,
  account: work.account,
  color: work.color,
  colorKey: null,
};

describe("書き先の選択肢", () => {
  test("書き込めて無視していないカレンダーだけ。アカウントごとにまとめる（アカウント名・名前の順）", () => {
    const xs = eventCalendarChoices([work, readOnly, ignored, personal, holidays, family], def);
    expect(xs.map((c) => [c.account, c.name])).toEqual([
      ["example.com", "Work"],
      ["iCloud", "Family"],
      ["iCloud", "Personal"],
    ]);
  });

  test("設定の書き先は無視していても選択肢に残す（初期値として出せるように）", () => {
    const xs = eventCalendarChoices([{ ...work, role: "ignored" }, personal], def);
    expect(xs.map((c) => c.id)).toEqual(["c-work", "c-personal"]);
  });

  test("書き込めるカレンダーが2つ以上なら選択を出し、1つなら出さない（今と同じ見た目）", () => {
    expect(showCalendarPicker(eventCalendarChoices([work, personal], def))).toBe(true);
    expect(showCalendarPicker(eventCalendarChoices([work, readOnly, ignored, holidays], def))).toBe(
      false,
    );
    expect(showCalendarPicker(eventCalendarChoices([], null))).toBe(false);
  });
});

describe("書き先（初期値と選び直し）", () => {
  const xs = eventCalendarChoices([work, personal, family], def);

  test("初期値は設定の書き先。calendarId は送らない（今と同じく Calendar.app のデフォルトへ）", () => {
    const t = eventTargetOf(xs, def, null);
    expect(t.calendar?.id).toBe("c-work");
    expect(t.explicit).toBe(false);
  });

  test("選び直すとその予定だけその書き先（calendarId を送る）。色もそのカレンダーの色", () => {
    const t = eventTargetOf(xs, def, "c-personal");
    expect([t.calendar?.id, t.explicit]).toEqual(["c-personal", true]);
    // Turnlane の中で選んだ色（D-125）があればそれ
    expect(choiceColor(t.calendar)).toBe("var(--dl-cal-lavender)");
    const f = eventTargetOf(xs, def, "c-family");
    expect(choiceColor(f.calendar)).toBe("#e08a5a");
  });

  test("設定の書き先を選び直した・選択肢に無いものは、設定の書き先のまま（送らない）", () => {
    expect(eventTargetOf(xs, def, "c-work").explicit).toBe(false);
    const gone = eventTargetOf(xs, def, "c-gone");
    expect([gone.calendar?.id, gone.explicit]).toEqual(["c-work", false]);
  });
});

describe("CalendarPicker（作成のポップオーバーの下端）", () => {
  const xs = eventCalendarChoices([work, personal, family], def);
  const html = (value: string) =>
    renderToStaticMarkup(
      createElement(CalendarPicker, {
        choices: xs,
        value,
        label: "Calendar for this event",
        onChange: () => {},
      }),
    );

  test("ボタンに今の書き先の色の点と名前。キーで移れる（tabindex で外していない）", () => {
    const h = html("c-work");
    expect(h).toContain('data-testid="event-calendar-picker"');
    expect(h).toContain(">Work<");
    expect(h).toContain("background:#6b8cc7");
    expect(h).toContain('aria-label="Calendar for this event"');
    expect(h).not.toMatch(/data-testid="event-calendar-picker"[^>]*tabindex="-1"/);
    expect(html("c-personal")).toContain(">Personal<");
    expect(html("c-personal")).toContain("var(--dl-cal-lavender)");
  });
});
