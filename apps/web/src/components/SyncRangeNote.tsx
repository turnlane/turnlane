/**
 * 予定を取り込む範囲の外の日の 1 行（0.8.2。ux-mvp 4.13 の後「予定の取り込む範囲」）: カレンダーがつながっていて（1 つ以上の
 * カレンダーがある）、その日が `GET /api/calendar/status` の window（from〜to）の外のとき、「予定はまだ取り込んでいません
 * （取り込む範囲は 7 日前から 90 日後まで）」を控えめに出す。範囲の外の日が「予定がない日」に見えないように。日数は status の値
 */
import { useQuery } from "@tanstack/react-query";
import type { CalendarStatusView } from "@turnlane/daemon";
import { useI18n } from "../i18n/index.tsx";
import { api, unwrap } from "../lib/api.ts";

export interface SyncWindow {
  from: string;
  to: string;
  pastDays: number;
  futureDays: number;
}

/** つながっていて範囲があるときだけ範囲（純粋関数） */
export function syncWindowOf(s: CalendarStatusView | undefined): SyncWindow | null {
  if (!s?.connected || (s.calendars?.total ?? 0) === 0) return null;
  const w = s.window;
  return w ? { from: w.from, to: w.to, pastDays: w.pastDays, futureDays: w.futureDays } : null;
}

/** その日が範囲の外か（純粋関数） */
export function outsideSyncWindow(date: string, w: SyncWindow | null): boolean {
  return !!w && (date < w.from || date > w.to);
}

export function useSyncWindow(): SyncWindow | null {
  return (
    useQuery({
      queryKey: ["settings", "calendar-status"],
      queryFn: () => unwrap<CalendarStatusView>(api.api.calendar.status.$get()),
      select: syncWindowOf,
      staleTime: 60_000,
      retry: false,
    }).data ?? null
  );
}

export function SyncRangeNote({ date, className = "" }: { date: string; className?: string }) {
  const { t } = useI18n();
  const w = useSyncWindow();
  if (!w || !outsideSyncWindow(date, w)) return null;
  return (
    <p className={`text-fg3 text-meta ${className}`} data-testid="sync-range-note" data-date={date}>
      {t("calendar.outsideWindow", { past: w.pastDays, future: w.futureDays })}
    </p>
  );
}
