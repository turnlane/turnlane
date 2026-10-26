/**
 * 小さな月のカレンダー（日付の見出しの ▾。D-113 で後にした分）: 今日に印、選んでいる日を塗り、稼働日でない日（稼働曜日の外と
 * 祝日）は薄くする。‹ › と PageUp / PageDown で月を移り、← → ↑ ↓ で日を移り、⏎ / Space かクリックでその日へ行く。
 * 稼働日は設定の稼働曜日と、カレンダーの祝日（GET /api/calendar/status の upcoming。今日から窓の終わりまで）から決める。
 * 取れなければ月〜金。週は月曜はじまり（稼働曜日の並びと同じ ISO の順）
 */

import { useQuery } from "@tanstack/react-query";
import { addDays } from "@turnlane/core/web";
import type { CalendarStatusView } from "@turnlane/daemon";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n/index.tsx";
import { api, unwrap } from "../lib/api.ts";

/** 'YYYY-MM-DD' の ISO 曜日（月 = 1 … 日 = 7） */
export function isoDow(date: string): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const w = new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay();
  return w === 0 ? 7 : w;
}

/** 'YYYY-MM' に n か月足す */
export function addMonths(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const i = y * 12 + (m - 1) + n;
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`;
}

/** 日付を n か月ずらす（月末は丸める。1/31 → 2/28） */
export function shiftMonth(date: string, n: number): string {
  const month = addMonths(date.slice(0, 7), n);
  const [y, m] = month.split("-").map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${month}-${String(Math.min(Number(date.slice(8, 10)), last)).padStart(2, "0")}`;
}

/** その月の表（月曜はじまりの週 × 7日。前後の月の日で埋める。4〜6週） */
export function monthGrid(month: string): string[][] {
  const first = `${month}-01`;
  const start = addDays(first, -(isoDow(first) - 1));
  const weeks: string[][] = [];
  for (let d = start; weeks.length === 0 || d.slice(0, 7) === month; ) {
    const week: string[] = [];
    for (let i = 0; i < 7; i++) {
      week.push(d);
      d = addDays(d, 1);
    }
    weeks.push(week);
  }
  return weeks;
}

/** 稼働日でない日（稼働曜日の外か祝日） */
export function isOffDay(
  date: string,
  weekdays: readonly number[],
  holidays: { has: (d: string) => boolean },
) {
  return !weekdays.includes(isoDow(date)) || holidays.has(date);
}

function useWorkdays(): { weekdays: readonly number[]; holidays: Map<string, string | null> } {
  const q = useQuery({
    queryKey: ["settings", "calendar-status"],
    queryFn: () => unwrap<CalendarStatusView>(api.api.calendar.status.$get()),
    staleTime: 60_000,
    retry: false,
  });
  const s = q.data;
  return {
    weekdays: s?.workdays.weekdays ?? [1, 2, 3, 4, 5],
    holidays: new Map((s?.holidays.upcoming ?? []).map((h) => [h.date, h.name])),
  };
}

export function MiniCalendar({
  value,
  today,
  onPick,
}: {
  /** 選んでいる日（いま見ている日） */
  value: string;
  today: string;
  onPick: (date: string) => void;
}) {
  const { locale, dayLabel, t } = useI18n();
  const { weekdays, holidays } = useWorkdays();
  // キーで動かす日（roving tabindex）。表に出す月はこの日の月
  const [cursor, setCursor] = useState(value);
  const month = cursor.slice(0, 7);
  const grid = monthGrid(month);
  const ref = useRef<HTMLDivElement>(null);
  const moved = useRef(false);
  // 開いたら選んでいる日にフォーカスする。キーで動かしたら動かした先へ
  useEffect(() => {
    if (!moved.current && ref.current?.contains(document.activeElement) === false) {
      ref.current?.querySelector<HTMLElement>(`[data-date="${cursor}"]`)?.focus();
      return;
    }
    if (moved.current) ref.current?.querySelector<HTMLElement>(`[data-date="${cursor}"]`)?.focus();
    moved.current = false;
  }, [cursor]);
  const move = (d: string) => {
    moved.current = true;
    setCursor(d);
  };
  const fmt = new Intl.DateTimeFormat(locale === "ja" ? "ja-JP" : "en-US", {
    year: "numeric",
    month: "long",
    timeZone: "UTC",
  });
  const [y, m] = month.split("-").map(Number) as [number, number];
  const title = fmt.format(new Date(Date.UTC(y, m - 1, 15)));
  const onKey = (e: React.KeyboardEvent) => {
    const k = e.key;
    let next: string | null = null;
    if (k === "ArrowLeft") next = addDays(cursor, -1);
    else if (k === "ArrowRight") next = addDays(cursor, 1);
    else if (k === "ArrowUp") next = addDays(cursor, -7);
    else if (k === "ArrowDown") next = addDays(cursor, 7);
    else if (k === "PageUp") next = shiftMonth(cursor, -1);
    else if (k === "PageDown") next = shiftMonth(cursor, 1);
    else if (k === "Home") next = addDays(cursor, -(isoDow(cursor) - 1));
    else if (k === "End") next = addDays(cursor, 7 - isoDow(cursor));
    else if (k === "Enter" || k === " ") {
      e.preventDefault();
      e.stopPropagation();
      onPick(cursor);
      return;
    }
    if (next === null) return;
    e.preventDefault();
    e.stopPropagation();
    move(next);
  };
  const navBtn =
    "inline-flex size-7 items-center justify-center rounded-control text-fg2 hover:bg-sunken hover:text-fg";
  return (
    <div ref={ref} className="w-[252px] p-1.5" data-testid="mini-calendar" data-month={month}>
      <div className="mb-1 flex items-center gap-1">
        <span className="flex-1 pl-1.5 font-semibold text-body" aria-live="polite">
          {title}
        </span>
        <button
          type="button"
          className={navBtn}
          aria-label={t("miniCal.prevMonth")}
          data-testid="mini-calendar-prev"
          onClick={() => setCursor(shiftMonth(cursor, -1))}
        >
          <ChevronLeft size={16} strokeWidth={1.5} aria-hidden="true" />
        </button>
        <button
          type="button"
          className={navBtn}
          aria-label={t("miniCal.nextMonth")}
          data-testid="mini-calendar-next"
          onClick={() => setCursor(shiftMonth(cursor, 1))}
        >
          <ChevronRight size={16} strokeWidth={1.5} aria-hidden="true" />
        </button>
      </div>
      <table className="w-full table-fixed border-collapse" aria-label={title}>
        <thead>
          <tr>
            {(grid[0] ?? []).map((d) => (
              <th
                key={d}
                scope="col"
                className={`h-6 font-normal text-micro ${weekdays.includes(isoDow(d)) ? "text-fg2" : "text-fg3"}`}
              >
                {dayLabel(d).weekday}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {grid.map((week) => (
            <tr key={week[0]}>
              {week.map((d) => {
                const inMonth = d.slice(0, 7) === month;
                const off = isOffDay(d, weekdays, holidays);
                const selected = d === value;
                const isToday = d === today;
                const holiday = holidays.get(d);
                return (
                  <td key={d} className="p-0">
                    <button
                      type="button"
                      data-date={d}
                      data-off={off ? "" : undefined}
                      data-today={isToday ? "" : undefined}
                      tabIndex={d === cursor ? 0 : -1}
                      aria-label={`${dayLabel(d).weekday} ${d}${holiday ? ` · ${holiday}` : ""}`}
                      aria-current={isToday ? "date" : undefined}
                      aria-pressed={selected}
                      title={holiday ?? undefined}
                      onClick={() => onPick(d)}
                      onKeyDown={onKey}
                      onFocus={() => d !== cursor && setCursor(d)}
                      className={`relative mx-auto flex size-8 items-center justify-center rounded-control font-mono text-meta outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                        selected
                          ? "bg-accent font-semibold text-onaccent"
                          : `hover:bg-sunken ${isToday ? "font-semibold text-accent" : off || !inMonth ? "text-fg3" : "text-fg"}`
                      } ${inMonth ? "" : "opacity-50"}`}
                    >
                      {Number(d.slice(8, 10))}
                      {isToday && !selected ? (
                        <span
                          className="absolute bottom-1 size-1 rounded-full bg-accent"
                          aria-hidden="true"
                        />
                      ) : null}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
