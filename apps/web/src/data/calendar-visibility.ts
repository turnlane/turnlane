/**
 * カレンダーの一時的な表示・非表示（Issue #5。設定 `calendar.hidden`）。上部バーの「カレンダー」・予定の右クリック・予定の
 * パネルの ⋯ から切り替える。描く予定だけが変わり、忙しい時間・空き枠・会議中・集中モードの判定は変わらない（デーモンが
 * ボード・デイビューの予定の一覧からだけ外す）。
 * 消すときは手元のボード・デイビューの予定をその場で外し（楽観的）、戻すときは読み直す。ほかの画面には SSE の calendar で届く
 */

import { useQuery } from "@tanstack/react-query";
import type { BoardResponse, CalendarEventView, DayResponse } from "@turnlane/core/web";
import { getLocale } from "../i18n/current.ts";
import { translate } from "../i18n/index.tsx";
import { api, unwrap } from "../lib/api.ts";
import { toast } from "../lib/store.ts";
import { queryClient } from "./client.ts";

const CONFIG_KEY = ["settings", "config"] as const;
const SETTING = "calendar.hidden";

type ConfigValues = Record<string, unknown>;

/** 設定の値 → 表示しないカレンダーの ID */
export function hiddenOf(values: ConfigValues | undefined): string[] {
  const v = values?.[SETTING];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** 表示しないカレンダー（設定の画面と同じ問い合わせを使う） */
export function useHiddenCalendars(): Set<string> {
  const q = useQuery({
    queryKey: CONFIG_KEY,
    queryFn: () => unwrap<{ values: ConfigValues }>(api.api.config.$get()).then((r) => r.values),
    staleTime: 60_000,
  });
  return new Set(hiddenOf(q.data));
}

/** 予定の一覧からそのカレンダーの予定を外す（純粋関数） */
export function withoutCalendar<T extends { calendarId: string }>(
  xs: readonly T[],
  id: string,
): T[] {
  return xs.filter((e) => e.calendarId !== id);
}

const isView = (k: unknown) => k === "board" || k === "day";

/** カレンダーを表示しない・戻す */
export async function setCalendarHidden(id: string, hide: boolean): Promise<void> {
  const prev = queryClient.getQueryData<ConfigValues>(CONFIG_KEY);
  const now = hiddenOf(prev);
  const next = hide ? [...new Set([...now, id])] : now.filter((x) => x !== id);
  queryClient.setQueryData<ConfigValues>(CONFIG_KEY, { ...(prev ?? {}), [SETTING]: next });
  if (hide) {
    await queryClient.cancelQueries({ predicate: (q) => isView(q.queryKey[0]) });
    const strip = <T extends { events: CalendarEventView[]; allDayEvents: CalendarEventView[] }>(
      e: T,
    ): T => ({
      ...e,
      events: withoutCalendar(e.events, id),
      allDayEvents: withoutCalendar(e.allDayEvents, id),
    });
    queryClient.setQueriesData<BoardResponse>(
      { predicate: (q) => q.queryKey[0] === "board" },
      (b) => (b ? { ...b, days: b.days.map(strip) } : b),
    );
    queryClient.setQueriesData<DayResponse>({ predicate: (q) => q.queryKey[0] === "day" }, (d) =>
      d ? { ...d, day: strip(d.day) } : d,
    );
  }
  try {
    await unwrap(api.api.config[":key"].$put({ param: { key: SETTING }, json: { value: next } }));
  } catch {
    queryClient.setQueryData<ConfigValues>(CONFIG_KEY, prev);
    toast(translate(getLocale(), "toast.saveFailed"));
  }
  void queryClient.invalidateQueries({ predicate: (q) => isView(q.queryKey[0]) });
  void queryClient.invalidateQueries({ queryKey: ["settings"] });
}
