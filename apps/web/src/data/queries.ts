/** 読み取りのフック（キーは m2-api.md 4.2）。鮮度は SSE の無効化が保証する */

import { useQuery } from "@tanstack/react-query";
import type {
  AiLiveResponse,
  AwayResponse,
  BoardResponse,
  DailyReportResponse,
  DayResponse,
  FocusView,
  InboxResponse,
  ProjectView,
  QueueResponse,
  SearchResponse,
  WorkItemDetail,
} from "@turnlane/core/web";
import type {
  CalendarStatusView,
  CalendarView,
  DesktopStatusResponse,
  EventsStatus,
  HealthReport,
  SourceView,
} from "@turnlane/daemon";
import { api, unwrap } from "../lib/api.ts";
import { fetchWithRev } from "./client.ts";
import { keys } from "./invalidate.ts";

export function useBoard(from: string, to: string, enabled = true) {
  return useQuery({
    queryKey: keys.board(from, to),
    queryFn: () =>
      fetchWithRev(keys.board(from, to), () =>
        unwrap<BoardResponse>(api.api.board.$get({ query: { from, to } })),
      ),
    enabled,
    placeholderData: (prev) => prev,
  });
}

/** 3日ボード（D-074）: 前の稼働日・around・次の稼働日 */
export function useBoardAround(around: string, enabled = true) {
  return useQuery({
    queryKey: keys.boardAround(around),
    queryFn: () =>
      fetchWithRev(keys.boardAround(around), () =>
        unwrap<BoardResponse>(api.api.board.$get({ query: { around } })),
      ),
    enabled,
    placeholderData: (prev) => prev,
  });
}

/** デイビュー（M2-19） */
export function useDay(date: string, enabled = true) {
  return useQuery({
    queryKey: keys.day(date),
    queryFn: () =>
      fetchWithRev(keys.day(date), () =>
        unwrap<DayResponse>(api.api.day[":date"].$get({ param: { date } })),
      ),
    enabled,
    placeholderData: (prev) => prev,
  });
}

export function useQueue() {
  return useQuery({
    queryKey: keys.queue(),
    queryFn: () => fetchWithRev(keys.queue(), () => unwrap<QueueResponse>(api.api.queue.$get())),
  });
}

/**
 * AI の画面の生きている AI 項目（GET /api/ai/live。ux-mvp 4.19）。SSE の合図（work_item・follow_up・task）に加えて 30 秒ごとに
 * 取り直す（片付けの判定はデーモンが 15 秒覚える。プロセスの有無の分からない項目の 6 時間は時計で過ぎる）
 */
export function useAiLive() {
  return useQuery({
    queryKey: keys.aiLive(),
    queryFn: () =>
      fetchWithRev(keys.aiLive(), () => unwrap<AiLiveResponse>(api.api.ai.live.$get())),
    refetchInterval: 30_000,
  });
}

/**
 * 離れていた間のまとめ（ux-mvp 4.13、D-214 (2)）。戻った時刻・30 分の期限は時刻で決まるので、SSE の合図に加えて
 * 1 分ごとに取り直す（在席の記録は SSE に流れない）
 */
export function useAway(enabled = true) {
  return useQuery({
    queryKey: keys.away(),
    queryFn: () => unwrap<AwayResponse>(api.api.away.$get()),
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    enabled,
  });
}

export function useInbox() {
  return useQuery({
    queryKey: keys.inbox(),
    queryFn: () => fetchWithRev(keys.inbox(), () => unwrap<InboxResponse>(api.api.inbox.$get())),
  });
}

export function useProjects() {
  return useQuery({
    queryKey: ["projects"],
    queryFn: async () =>
      (await unwrap<{ projects: ProjectView[] }>(api.api.projects.$get())).projects,
  });
}

/**
 * 集中モード（D-097。m2-api 25章）: 集中中の表示・開いている問い・問いの出し方。問いの開閉は SSE focus で取り直し、
 * 「次の予定の終わり」と表示の時刻のずれは1分ごとに取り直す
 */
export function useFocus() {
  return useQuery({
    queryKey: keys.focus(),
    queryFn: () => unwrap<FocusView>(api.api.focus.$get()),
    refetchInterval: 60_000,
    retry: false,
  });
}

/** デスクトップアプリの状態（ホットキー・通知の許可。desktop-shell.md 6.2）。ブラウザでは connected: false */
export function useDesktopStatus() {
  return useQuery({
    queryKey: ["desktop"],
    queryFn: () => unwrap<DesktopStatusResponse>(api.api.desktop.status.$get()),
    refetchInterval: 60_000,
  });
}

/** クイック入力のグローバルホットキー（Tauri の書式。設定 desktop.quick_add_shortcut。null は既定。D-077 の一覧で出す） */
export function useQuickAddShortcut() {
  return useQuery({
    queryKey: ["settings", "config", "desktop.quick_add_shortcut"],
    queryFn: () =>
      unwrap<{ value: string | null }>(
        api.api.config[":key"].$get({ param: { key: "desktop.quick_add_shortcut" } }),
      ).then((r) => (typeof r.value === "string" && r.value.trim() !== "" ? r.value : null)),
  });
}

/**
 * Turnlane で作る予定の書き先（Calendar.app のデフォルトカレンダー。D-093）。入力欄の色に使う。
 * デフォルトが変わると SSE settings で取り直す
 */
export function useEventTarget() {
  return useQuery({
    queryKey: ["settings", "calendar-status"],
    queryFn: () => unwrap<CalendarStatusView>(api.api.calendar.status.$get()),
    select: (s): EventsStatus | null => (s.connected ? s.events : null),
    staleTime: 60_000,
    retry: false,
  });
}

/** カレンダーの一覧（予定の書き先の選択・予定のパネルの移す先。select で絞る） */
export function useCalendars<T>(select: (cs: CalendarView[]) => T, enabled = true) {
  return useQuery({
    queryKey: ["calendars", "list"],
    queryFn: () => unwrap<{ calendars: CalendarView[] }>(api.api.calendars.$get()),
    select: (r) => select(r.calendars),
    staleTime: 60_000,
    retry: false,
    enabled,
  });
}

export function useHealth() {
  return useQuery({
    queryKey: keys.health(),
    queryFn: () => unwrap<HealthReport>(api.api.health.$get()),
    refetchInterval: 60_000,
  });
}

export function useSources() {
  return useQuery({
    queryKey: keys.sources(),
    queryFn: () => unwrap<{ sources: SourceView[]; backfillDone: boolean }>(api.api.sources.$get()),
    retry: false,
  });
}

export function useWorkItem(id: string | null) {
  return useQuery({
    queryKey: keys.workItem(id ?? ""),
    queryFn: () =>
      fetchWithRev(keys.workItem(id ?? ""), () =>
        unwrap<WorkItemDetail>(api.api["work-items"][":id"].$get({ param: { id: id ?? "" } })),
      ),
    enabled: id !== null,
  });
}

/** ⌘K の検索（M2-15。m2-api.md 17章）。無効化せず、毎回取り直す。入力中は前の結果を出したまま置き換える */
export function useSearch(q: string, limit: number) {
  const query = q.trim();
  return useQuery({
    queryKey: keys.search(query, limit),
    queryFn: () =>
      unwrap<SearchResponse>(api.api.search.$get({ query: { q: query, limit: String(limit) } })),
    enabled: query.length > 0,
    staleTime: 0,
    gcTime: 30_000,
    placeholderData: (prev) => prev,
  });
}

/** 帯・キュー・件数・通知に出す行（スヌーズ中のタスクしか無いカードは、明けるまで出さない。m2-api.md 2.2）。core と共有 */
/**
 * 画面に出す自分の番の行（D-245）: visibleQueue の後ろに猶予中の問いを薄い行として足す。見出しの数は countedTurns（猶予中を
 * 含めない）。通知は visibleQueue のまま
 */
export { countedTurns, isGrace, turnRows, visibleQueue } from "@turnlane/core/web";

/** 記録（M4-3・D-192）。日付区切りで確定済みならその Markdown、今日は今の事実から */
export function useDailyReport(date: string, lang: "en" | "ja", enabled = true) {
  return useQuery({
    queryKey: [...keys.dailyNote(date), lang],
    queryFn: () =>
      fetchWithRev(keys.dailyNote(date), () =>
        unwrap<DailyReportResponse>(
          api.api.reports.daily[":date"].$get({ param: { date }, query: { lang } }),
        ),
      ),
    enabled: enabled && date !== "",
    placeholderData: (prev) => prev,
  });
}
