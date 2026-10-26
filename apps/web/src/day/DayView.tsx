/**
 * デイビュー（M2-19。ux-mvp 4.5、確定デザイン day-view-v3、調整点 D1・D2）。
 * - 上部: 日の集計 `AI · You · Meetings · Idle · Expired` と `Work 8:42 – now (auto) · Edit`
 * - 右の一覧: YOUR TURN / Unscheduled（時間軸へのドラッグ元）/ Closed today（3日ボードの列と同じく未定を上に）
 * - 3レーン（Events 15% / Me 25% / AI 60%。D-074）× 24時間（暦どおり 0:00 区切り。D-054）
 * - AI はひと続きの作業（D-065）。クリックでターンの内訳をブロックの直下に開く。待ちの線は3種（猶予・放置＋背後の帯・集計外）を各項目の列にその項目の下端から引く
 * - 自分レーンは実時間の高さ（最小 16px、重なりは横並び）。自分の番への対応（返答・レビュー等）は自分レーンに描かず、
 *   AI レーンの待ちの終点に `↩ 8m` の印（D-074）
 * - Closed today は既定で見出しの 1 行の要約（種類ごとの件数と返事までの中央値）に畳み、押す・⏎ で行を開く（ux-mvp 4.5）
 * - 時間軸への DnD は週ボードと同じ部品（board/dnd.tsx）
 */

import { useNavigate, useRouterState } from "@tanstack/react-router";
import {
  type ClosedTodayRow,
  clip,
  type DayDetail,
  fmtClock,
  fmtDuration,
  fmtWait,
  type Interval,
  nextWeekday,
  type QueueItem,
  type TaskView,
  type TimeBlockView,
} from "@turnlane/core/web";
import { Ban, ChevronRight, Clock, Plus } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ItemActionsProvider,
  rangeKeys,
  slotMenu,
  toggleKey,
  useItemActions,
  useItemActionsHost,
  usePanelFollow,
} from "../actions/item-actions.tsx";
import { countedInDate, placementsOf } from "../board/day-split.ts";
import {
  BoardDnd,
  DraggableAi,
  DraggableEvent,
  DraggableTask,
  type GridPreview,
  isDropGhost,
  TurnDrag,
  useBoardDnd,
  useGridDrop,
  useRangeSelect,
} from "../board/dnd.tsx";
import { type Prompt, PromptView } from "../board/editors.tsx";
import { DAY_LANES, GUTTER_PX, snapScroll } from "../board/geometry.ts";
import { LABEL_PX } from "../board/labels.ts";
import { belowNow, placeTags, type Rail, type TagPlace } from "../board/lane-labels.ts";
import { laneRank, laneStatus, questionWait, useLaneWaits } from "../board/lane-wait.ts";
import {
  GridBackground,
  Gutter,
  initialScroll,
  LaneDivider,
  NowLine,
  scrollStartOf,
  strongRanges,
} from "../board/TimeGrid.tsx";
import {
  CLOSED_OPEN_EVENT,
  flashExpired,
  TotalsItem,
  useOpenExpired,
} from "../board/TotalsItem.tsx";
import { readOpenDays, writeOpenDays } from "../board/top-limits.ts";
import { expiredShown, expiredTipLines, idleTipLines, totalsTip } from "../board/totals-tip.ts";
import { WaitDots } from "../board/WaitDots.tsx";
import { TodayNotices } from "../board/WeekBoard.tsx";
import { openWaitKeys, type WaitEnd, waitEndsOf, waitEndText } from "../board/wait-ends.ts";
import { aiHoverOf, aiHoverProps } from "../components/AiHoverCard.tsx";
import { useAwayDigest } from "../components/AwayLine.tsx";
import { BulkBar } from "../components/BulkBar.tsx";
import { EventBlock, TaskCard, TaskToolbar, taskSurface, titleText } from "../components/items.tsx";
import { LegendButton } from "../components/Legend.tsx";
import { Nums } from "../components/Nums.tsx";
import { useOpenWith } from "../components/OpenWith.tsx";
import { StatusIcon } from "../components/StatusIcon.tsx";
import { closedFallback, closedLabel, primaryFollowUp, TurnRow } from "../components/TurnRow.tsx";
import { Check } from "../components/ui.tsx";
import { answerable, useAnswerEnabled } from "../data/answer.ts";
import { useAiItemSubject, useClosedSubject, useClosedSubjects } from "../data/glance.ts";
import {
  carryDay,
  completeItems,
  createEvent,
  createReplyTask,
  createTask,
  createTaskWithBlock,
  deferFollowUp,
  deleteTask,
  dismissFollowUps,
  moveTask,
  openTask,
  renameTask,
  setComplete,
  snoozeFollowUp,
  unscheduleTask,
} from "../data/mutations.ts";
import { countedTurns, turnRows, useDay, useProjects, useQueue } from "../data/queries.ts";
import { TimelineMarks, useTimelineMarks } from "../ext/marks.tsx";
import { type MessageKey, useI18n } from "../i18n/index.tsx";
import { useKeys } from "../keys/use-keys.ts";
import { dayNav } from "../lib/board-nav.ts";
import { useNow } from "../lib/clock.ts";
import { addDaysSafe } from "../lib/dates.ts";
import { useWindowWidth } from "../lib/fit.ts";
import { anyPanelOpen, type SelItem, setUi, useUi } from "../lib/store.ts";
import { whereName } from "../lib/where.ts";
import { AiLaneEmpty } from "../onboarding/BoardEmpty.tsx";
import { useFocusRequest, usePublishSelection } from "../palette/selection.ts";
import { closedInOrder, closedSummary } from "./closed-summary.ts";
import {
  connectorTarget,
  DAY_HOUR_PX,
  DAY_PX_PER_MS,
  type DayAiBlock,
  dayAiBlocks,
  EXCLUDED_LABEL_MIN_PX,
  layoutDayAi,
  layoutMe,
  type PlacedAi,
  WAIT_TRACK_PX,
  type WaitLine,
  waitExtentOf,
  waitLines,
  yAt,
} from "./layout.ts";

const H = DAY_HOUR_PX;
const BAND_MAX = 5;
/** レーンの幅（Events 15% / Me 25% / AI 60%。D-074。3日ボードの今日の列と同じ） */
const EV = DAY_LANES.events;
const ME = DAY_LANES.me;
const AI = DAY_LANES.ai;

/** AI の線の x（確定デザイン: 3px の線を AI レーンの左に 12px 間隔で詰める。ラベルは右の残りの幅） */
const BAR_LEFT = 6;
const BAR_STEP = 12;
const colX = (column: number) => BAR_LEFT + column * BAR_STEP;
const LABEL_H = 34;
/**
 * 待ちの札は線の右（AI レーンの中）に置く（§5.3。§8 の仮 6）。3 列目以降で右に場所が無いときだけ R27 の「一番左の線の左」
 * （猶予の終わりのラベルは線の右のまま）
 */
const waitLabelOnLeft = (l: WaitLine) => l.label?.t !== "grace" && l.column >= 2;

const TONE: Record<string, string> = {
  needs_input: "var(--dl-needs)",
  error: "var(--dl-error)",
  your_turn: "var(--dl-turn)",
  running: "var(--dl-running)",
  done: "var(--dl-text-3)",
};

export function DayView() {
  const { t, locale } = useI18n();
  const nav = useNavigate();
  const date = useUi(() => dayNav.date());
  const panelOpen = useUi((s) => anyPanelOpen(s) || s.recordOpen);
  const winW = useWindowWidth();
  const hideList = panelOpen && winW < 1200;
  // `/day?record=1`（メニューバーの g r）で記録のパネルを開く（D-192）
  useEffect(() => {
    if (new URLSearchParams(location.search).get("record") !== "1") return;
    setUi({ recordOpen: true });
    history.replaceState(null, "", "/day");
  }, []);
  const q = useDay(date);
  const queue = useQueue();
  const projects = useProjects();
  const now = useNow();
  const data = q.data;
  const day = data?.day;
  const tz = data?.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const isToday = day?.phase === "today";
  // 自分の番の行（猶予中の問いを末尾に薄く。D-245）
  const band = turnRows(queue.data?.items, queue.data?.grace);
  const projectName = (id: string | null) =>
    id ? (projects.data?.find((p) => p.id === id)?.name ?? null) : null;
  const layout = useMemo(
    () => (day ? placementsOf(day) : { placed: [], unscheduled: [], replies: [] }),
    [day],
  );

  const closedQ: unknown = useRouterState({
    select: (st) => (st.location.search as Record<string, unknown>).closed ?? null,
  });
  // 「今日閉じたもの」の開閉（既定は畳んだ要約の 1 行。開いた日はその日のあいだブラウザに覚える）
  const [closedOpenDays, setClosedOpenDays] = useState<Record<string, boolean>>(() =>
    readOpenDays(CLOSED_OPEN_KEY),
  );
  // `/day?closed=expired` で来たときは最初の描画から開く（期限切れの行の強調を同じ描画で当てる）
  const closedOpen = closedOpenDays[date] === true || closedQ === "expired";
  const setClosedOpen = (open: boolean) =>
    setClosedOpenDays((o) => {
      const next = { ...o, [date]: open };
      writeOpenDays(CLOSED_OPEN_KEY, next);
      return next;
    });
  // 期限切れの行へ送るとき（見出しの「期限切れ」）は開いてから強調する
  useEffect(() => {
    const on = () =>
      setClosedOpenDays((o) => {
        const next = { ...o, [date]: true };
        writeOpenDays(CLOSED_OPEN_KEY, next);
        return next;
      });
    window.addEventListener(CLOSED_OPEN_EVENT, on);
    return () => window.removeEventListener(CLOSED_OPEN_EVENT, on);
  }, [date]);
  const closedRows = useMemo(() => closedInOrder(day?.closedToday ?? []), [day]);

  // `/day?closed=expired`（見出しの「期限切れ」を押した。R79）: 読み込んだら「今日閉じた」の期限切れの行へ送って強調する
  const loadedDate = day?.date;
  useEffect(() => {
    if (closedQ !== "expired" || loadedDate !== date) return;
    flashExpired();
    void nav({ to: "/day", replace: true });
  }, [closedQ, loadedDate, date, nav]);

  // 開いたときは計画の目安の開始付近へ。今日で現在線が見えなければ現在線の付近へ
  const scroller = useRef<HTMLDivElement>(null);
  const scrolledFor = useRef<string | null>(null);
  useEffect(() => {
    const el = scroller.current;
    if (!el || !day || scrolledFor.current === day.date) return;
    scrolledFor.current = day.date;
    const start = scrollStartOf(day, day.axis.start + 8 * 3_600_000);
    let top = initialScroll(day.axis, start, H);
    if (day.phase === "today") {
      const nowY = yAt(now, day.axis.start);
      if (nowY > top + el.clientHeight - H || top > nowY)
        top = snapScroll(Math.max(0, nowY - el.clientHeight / 2), H);
    }
    el.scrollTop = top;
  }, [day, now]);

  // ---------- 選択とキー ----------
  const [sel, setSel] = useState<string | null>(null);
  const [multi, setMulti] = useState<string[]>([]);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [rangeDone, setRangeDone] = useState(0);
  // 他の画面からの新規予定（⌘K・⇧C）: 開いたら入力を出す（D-093）
  const newEventRequest = useUi((s) => s.newEventRequest);
  const loaded = day !== undefined;
  useEffect(() => {
    if (!newEventRequest || !loaded) return;
    setUi({ newEventRequest: null });
    setPrompt({
      kind: "new",
      date,
      anchor: document.querySelector("[data-lane-head='events']"),
      as: "event",
    });
  }, [newEventRequest, loaded, date]);
  const openWith = useOpenWith();
  const aiBlocks = useMemo(() => (day ? dayAiBlocks(day, now) : []), [day, now]);
  const keysInOrder = (): string[] => {
    const out: string[] = [];
    if (isToday) for (const x of band.slice(0, BAND_MAX)) out.push(`turn:${x.workItemId}`);
    for (const x of layout.unscheduled) out.push(`task:${x.id}`);
    // 今日閉じたもの: 畳んでいるときは見出しだけ、開いたら行も（右の一覧の並びと同じ）
    if (closedRows.length > 0) {
      out.push(CLOSED_HEAD);
      if (closedOpen) for (const r of closedRows) out.push(`closed:${r.followUpId}`);
    }
    for (const p of [...layout.placed].sort((a, b) => a.at.start - b.at.start))
      out.push(`task:${p.task.id}`);
    const seen = new Set<string>();
    for (const b of [...aiBlocks].sort((a, b) => a.at.start - b.at.start)) {
      if (seen.has(b.item.id)) continue;
      seen.add(b.item.id);
      out.push(`ai:${b.item.id}`);
    }
    return out;
  };
  const taskOf = (key: string | null): TaskView | null => {
    if (!key?.startsWith("task:") || !day) return null;
    const id = key.slice(5);
    return day.tasks.find((x) => x.id === id) ?? day.crossTasks.find((x) => x.id === id) ?? null;
  };
  const closedOf = (key: string | null) =>
    key?.startsWith("closed:") && key !== CLOSED_HEAD
      ? (closedRows.find((r) => `closed:${r.followUpId}` === key) ?? null)
      : null;
  const answerOn = useAnswerEnabled();
  const turnOf = (key: string | null): QueueItem | null =>
    key?.startsWith("turn:") ? (band.find((x) => `turn:${x.workItemId}` === key) ?? null) : null;
  const anchorEl = (key: string | null): HTMLElement | null => {
    if (!key) return null;
    const [kind, id] = key.split(":");
    return document.querySelector<HTMLElement>(`[data-kind="${kind}"][data-id="${id}"]`);
  };
  const selected = () => (multi.length > 0 ? multi : sel ? [sel] : []);
  const step = (delta: number, extend = false) => {
    const ks = keysInOrder();
    if (ks.length === 0) return;
    const i = sel ? ks.indexOf(sel) : -1;
    const next = ks[Math.max(0, Math.min(ks.length - 1, i < 0 ? 0 : i + delta))] as string;
    if (extend) setMulti((m) => [...new Set([...(m.length > 0 ? m : sel ? [sel] : []), next])]);
    setSel(next);
  };
  const turnIds = () =>
    selected()
      .map(turnOf)
      .map((x) => (x ? primaryFollowUp(x)?.id : undefined))
      .filter((x): x is string => !!x);
  const tasks = () =>
    selected()
      .map(taskOf)
      .filter((x): x is TaskView => x !== null);
  const today = data?.displayToday ?? date;
  useKeys({
    prevDay: () => {
      dayNav.shift(-1);
      return true;
    },
    nextDay: () => {
      dayNav.shift(1);
      return true;
    },
    prevWeek: () => {
      dayNav.shift(-7);
      return true;
    },
    nextWeek: () => {
      dayNav.shift(7);
      return true;
    },
    next: () => {
      step(1);
      return true;
    },
    prev: () => {
      step(-1);
      return true;
    },
    extendDown: () => {
      step(1, true);
      return true;
    },
    extendUp: () => {
      step(-1, true);
      return true;
    },
    today: () => {
      const xs = tasks();
      if (xs.length > 0) for (const x of xs) void moveTask(x, today);
      else dayNav.today();
      return true;
    },
    new: () => {
      setPrompt({ kind: "new", date, anchor: document.querySelector("[data-day-left]") });
      return true;
    },
    // 新しい予定（⇧C・⌘K。入力の時刻で作る。D-093）
    newEvent: () => {
      setPrompt({
        kind: "new",
        date,
        anchor: document.querySelector("[data-lane-head='events']"),
        as: "event",
      });
      return true;
    },
    rename: () => {
      const x = taskOf(sel);
      if (!x) return false;
      setPrompt({
        kind: "rename",
        initial: titleText(x.title, locale),
        anchor: anchorEl(sel),
        onSubmit: (v) => void renameTask(x, v),
      });
      return true;
    },
    move: () => {
      const ts = selected()
        .map(turnOf)
        .filter((x): x is QueueItem => x !== null);
      if (ts.length > 0) {
        for (const x of ts) {
          const f = primaryFollowUp(x);
          if (f) void deferFollowUp(f.id, nextWeekday(data?.today ?? date));
        }
        setMulti([]);
        return true;
      }
      const xs = tasks();
      if (xs.length === 0) return false;
      setPrompt({
        kind: "move",
        anchor: anchorEl(sel),
        onSubmit: (d) => {
          for (const x of xs) void moveTask(x, d);
        },
      });
      return true;
    },
    complete: () => {
      // まとめて1つの知らせと ⌘Z 1回で戻す（D-139 (3)）
      void completeItems(tasks(), turnIds());
      return true;
    },
    open: () => {
      if (sel === CLOSED_HEAD) {
        setClosedOpen(!closedOpen);
        return true;
      }
      const closedItem = closedOf(sel);
      if (closedItem) {
        setUi({ panelWorkItemId: closedItem.workItemId });
        return true;
      }
      const x = turnOf(sel);
      if (x) {
        const f = primaryFollowUp(x);
        // 猶予中の問い（D-245）は返答タスクが無いので項目の既定の開き先
        void openTask(f ? { followUpId: f.id } : { workItemId: x.workItemId });
        return true;
      }
      // AI カードも外部の既定の開き先（D-067）。詳細パネルは → / ⌘⏎
      if (sel?.startsWith("ai:")) {
        void openTask({ workItemId: sel.slice(3) });
        return true;
      }
      // 自分のタスクの ⏎ は詳細パネル（D-070）
      if (sel?.startsWith("task:")) {
        setUi({ panelTaskId: sel.slice(5) });
        return true;
      }
      return false;
    },
    openWith: () => {
      const x = turnOf(sel);
      const f = x ? primaryFollowUp(x) : undefined;
      if (f) {
        openWith.show(anchorEl(sel), { followUpId: f.id });
        return true;
      }
      if (sel?.startsWith("ai:")) {
        openWith.show(anchorEl(sel), { workItemId: sel.slice(3) });
        return true;
      }
      return false;
    },
    replyTask: () => {
      // AI カードだけ（D-066 (2)）
      if (!sel?.startsWith("ai:")) return false;
      void createReplyTask(sel.slice(3));
      return true;
    },
    // a: 自分の番の「答える」の節を詳細パネルに開く（D-238）
    answer: () => {
      const q = turnOf(sel);
      if (!q || !answerOn || !answerable(q)) return false;
      setUi({ panelWorkItemId: q.workItemId, answerFor: q.workItemId });
      return true;
    },
    detail: () => {
      const closedItem = closedOf(sel);
      if (closedItem) {
        setUi({ panelWorkItemId: closedItem.workItemId });
        return true;
      }
      const task = taskOf(sel);
      if (task) {
        setUi({ panelTaskId: task.id });
        return true;
      }
      const id = sel?.startsWith("ai:") ? sel.slice(3) : (turnOf(sel)?.workItemId ?? null);
      if (!id) return false;
      setUi({ panelWorkItemId: id });
      return true;
    },
    snooze: () => {
      const ids = turnIds();
      if (ids.length === 0) return false;
      setPrompt({
        kind: "snooze",
        anchor: anchorEl(sel),
        onSubmit: (p) => {
          for (const id of ids) void snoozeFollowUp(id, p);
        },
      });
      return true;
    },
    dismiss: () => {
      const ids = turnIds();
      if (ids.length === 0) return false;
      void dismissFollowUps(ids);
      setMulti([]);
      return true;
    },
    select: () => {
      if (!sel) return false;
      const k = sel;
      setMulti((m) => (m.includes(k) ? m.filter((x) => x !== k) : [...m, k]));
      return true;
    },
    // 1日後へ・1日前へ（ホバーのボタン・右クリックメニューと同じ。3日ボードと同じ処理。日付の無いタスクは今日から）
    later: () => {
      const xs = tasks();
      if (xs.length === 0) return false;
      for (const x of xs) void moveTask(x, addDaysSafe(x.scheduledDate ?? today, 1));
      return true;
    },
    earlier: () => {
      const xs = tasks();
      if (xs.length === 0) return false;
      for (const x of xs) void moveTask(x, addDaysSafe(x.scheduledDate ?? today, -1));
      return true;
    },
    delete: () => {
      for (const x of tasks()) void deleteTask(x);
      setMulti([]);
      return true;
    },
    unblock: () => {
      const xs = tasks().filter((x) => day?.timeBlocks.some((b) => b.taskId === x.id));
      if (xs.length === 0) return false;
      for (const x of xs) void unscheduleTask(x);
      return true;
    },
    escape: () => {
      if (multi.length > 0 || sel) {
        setMulti([]);
        setSel(null);
        return true;
      }
      return false;
    },
  });
  // ⌘K（ux-mvp 6.1）: 選んでいる項目をパレットに渡し、検索結果から来たタスクを選ぶ
  const itemOf = (k: string): SelItem[] => {
    const x = taskOf(k);
    if (x) return [{ kind: "task", task: x }];
    const tq = turnOf(k);
    if (tq) return [{ kind: "turn", item: tq }];
    if (k.startsWith("ai:")) {
      const id = k.slice(3);
      return [{ kind: "ai", id, title: day?.aiLane.find((a) => a.id === id)?.title ?? null }];
    }
    return [];
  };
  usePublishSelection(selected().flatMap(itemOf));
  // ---------- マウスの操作（UX 監査 A1〜A3・A14。actions/item-actions.tsx） ----------
  const host = useItemActionsHost({
    select: (k, how) => {
      if (how === "replace") setMulti([]);
      else if (how === "toggle") setMulti(toggleKey(multi, sel, k));
      else setMulti(rangeKeys(keysInOrder(), sel, k));
      setSel(k);
    },
    inMulti: (k) => multi.includes(k),
    itemsFor: (k) => (multi.includes(k) ? multi.flatMap(itemOf) : itemOf(k)),
    placed: (k) => day?.timeBlocks.some((b) => `task:${b.taskId}` === k) ?? false,
    eventOf: (id) => {
      const e = day?.events.find((x) => x.id === id) ?? day?.allDayEvents.find((x) => x.id === id);
      return e ?? null;
    },
  });
  const actions = host.api;
  const pick = (k: string) => actions.click(k);
  // パネルを開いている間は選び直した項目のパネルへ（U-07）
  usePanelFollow(sel);
  useFocusRequest(
    (f) => {
      if (f.date !== date || !keysInOrder().includes(f.key)) return false;
      setSel(f.key);
      setMulti([]);
      return true;
    },
    [day, date],
  );
  const isSel = (k: string) => sel === k || multi.includes(k);

  if (q.isError && !data)
    return (
      <div className="p-6 text-body text-fg2">
        {t("board.loadFailed")}{" "}
        <button type="button" className="text-accent" onClick={() => void q.refetch()}>
          {t("board.retry")}
        </button>
      </div>
    );
  if (!day) return <div className="p-6 text-body text-fg3">{t("board.loading")}</div>;

  return (
    <ItemActionsProvider value={actions}>
      <BoardDnd today={data?.today}>
        <div className="flex h-full min-w-0 flex-col" data-testid="day-view">
          <SummaryBar day={day} tz={tz} />
          <div className="flex min-h-0 flex-1">
            <div className="relative flex min-w-0 flex-1 flex-col">
              <LaneHeader />
              {/* 凡例（UX 監査 A9。レーンの見出しの線の凡例と同じものを含む） */}
              <LegendButton className="absolute right-4 bottom-3" />
              <div
                ref={scroller}
                className="min-h-0 flex-1 overflow-y-auto"
                data-testid="day-scroll"
              >
                <div className="flex">
                  <div className="shrink-0 border-line border-r" style={{ width: GUTTER_PX }}>
                    <Gutter
                      axis={day.axis}
                      tz={tz}
                      now={now}
                      showNow={isToday}
                      strong={strongRanges(day.axis, [day])}
                      hourPx={H}
                    />
                  </div>
                  <Timeline
                    day={day}
                    tz={tz}
                    now={now}
                    aiBlocks={aiBlocks}
                    isSel={isSel}
                    onPick={pick}
                    projectName={projectName}
                    rangeDone={rangeDone}
                    // 自分のレーンの空き枠のクリック・ドラッグは「タスク」を選んだ作成のポップオーバー（D-101 (2)）
                    onRange={(range, el, as) =>
                      setPrompt({
                        kind: "new",
                        date,
                        anchor: el,
                        range,
                        switchable: true,
                        ...(as ? { as } : {}),
                      })
                    }
                    // 予定のレーンの空き枠は「予定」を選んだ作成のポップオーバー（タスクにも切り替えられる。デイビューの
                    // レビューの「実装で直すこと」3、D-093）
                    onRangeEvent={(range, el) =>
                      setPrompt({
                        kind: "new",
                        date,
                        anchor: el,
                        range,
                        as: "event",
                        switchable: true,
                      })
                    }
                  />
                </div>
              </div>
            </div>
            {/* 右の一覧（300px。Sunsama と同じ並びで、時間軸がサイドバーの隣に来る。確定デザインのデイビュー）。
                1200 未満でパネルを開いたら隠す（一覧の内容は時間軸の上と帯にある。B-1 (2)） */}
            {hideList ? null : (
              <aside
                className="flex w-[300px] shrink-0 flex-col gap-6 overflow-y-auto border-line border-l px-3 py-4"
                data-day-left
                data-day-list
              >
                {/* 先頭行: 拡張の知らせ（todayNotices。3日ボードの今日の列と同じ。D-192） */}
                {isToday ? <TodayNotices /> : null}
                {isToday ? (
                  <section aria-label={t("board.yourTurn")} className="flex flex-col gap-1">
                    <ListTitle text={t("board.yourTurn")} count={countedTurns(band)} />
                    {/* 0 件のときの 1 行（B-10 (2)） */}
                    {band.length === 0 ? (
                      <p className="px-0.5 text-fg3 text-meta" data-testid="day-your-turn-empty">
                        {t("day.yourTurn.empty")}
                      </p>
                    ) : null}
                    {band.slice(0, BAND_MAX).map((x) => (
                      <TurnDrag key={x.workItemId} item={x} blocks={day.timeBlocks} tz={tz}>
                        {(at) => (
                          <TurnRow
                            item={x}
                            scheduledAt={at}
                            now={now}
                            tz={tz}
                            stacked
                            selected={isSel(`turn:${x.workItemId}`)}
                            onOpen={() => {
                              const f = primaryFollowUp(x);
                              void openTask(
                                f ? { followUpId: f.id } : { workItemId: x.workItemId },
                              );
                            }}
                          />
                        )}
                      </TurnDrag>
                    ))}
                    {band.length > BAND_MAX ? (
                      <button
                        type="button"
                        onClick={() => void nav({ to: "/queue" })}
                        className="px-1 text-left text-meta text-fg2 hover:text-fg"
                      >
                        {t("board.moreRows", { count: band.length - BAND_MAX })}
                      </button>
                    ) : null}
                  </section>
                ) : null}
                <section className="flex flex-col gap-1.5">
                  <div className="flex flex-wrap items-center justify-between gap-x-2">
                    <ListTitle text={t("board.unscheduled")} count={layout.unscheduled.length} />
                    {/* 過去の日の「残り N 件を今日へ」（D-192 §2.2。0 なら出さない） */}
                    {day.carry && day.carry.count + day.carry.older > 0 ? (
                      <button
                        type="button"
                        onClick={() => void carryDay(date, { older: (day.carry?.older ?? 0) > 0 })}
                        className="mb-1 shrink-0 rounded-control px-1 text-fg2 text-meta hover:underline"
                        title={t("board.carryToday.def")}
                        data-testid="carry-today"
                        data-date={date}
                      >
                        {t("board.carryToday", { count: day.carry.count + day.carry.older })}
                      </button>
                    ) : null}
                  </div>
                  {layout.unscheduled.map((x) => (
                    <DraggableTask key={x.id} task={x}>
                      <TaskCard
                        task={x}
                        selected={isSel(`task:${x.id}`)}
                        project={projectName(x.projectId)}
                        onClick={() => pick(`task:${x.id}`)}
                        onToggle={() => void setComplete(x, x.status !== "done")}
                      />
                    </DraggableTask>
                  ))}
                  {/* 常に「＋ 追加」（UX 監査 A5） */}
                  <button
                    type="button"
                    onClick={(e) => setPrompt({ kind: "new", date, anchor: e.currentTarget })}
                    className="flex h-7 items-center gap-1.5 self-start rounded-control px-1.5 text-body text-fg2 hover:bg-sunken hover:text-fg"
                    title={t("keys.new")}
                    data-testid="column-add"
                    data-date={date}
                  >
                    <Plus size={16} strokeWidth={1.5} aria-hidden="true" />
                    {t("board.addShort")}
                  </button>
                </section>
                {/* 今日閉じたもの（自分の番 → 未定 → 今日閉じたもの。3日ボードの列と同じく未定を上に） */}
                <ClosedToday
                  rows={closedRows}
                  tz={tz}
                  open={closedOpen}
                  onToggle={() => {
                    setSel(CLOSED_HEAD);
                    setClosedOpen(!closedOpen);
                  }}
                  isSel={isSel}
                />
                {/* 放置の内訳は見出しの「放置」のホバーと記録へ（確定デザインの右の一覧に無い。D-114） */}
              </aside>
            )}
          </div>
          {openWith.menu}
          {host.node}
          <BulkBar keys={multi} onClear={() => setMulti([])} />
          {prompt ? (
            <PromptView
              prompt={prompt}
              today={today}
              tz={tz}
              onCreateEvent={(e) => void createEvent(e)}
              onClose={() => {
                setPrompt(null);
                setRangeDone((x) => x + 1);
              }}
              onCreate={(raw, d, extra) => {
                if (prompt.kind === "new" && prompt.range && d)
                  return createTaskWithBlock({ raw, date: d, range: prompt.range });
                else
                  return createTask({
                    raw,
                    date: extra.date ?? d,
                    ...(extra.estimateMin !== undefined ? { estimateMin: extra.estimateMin } : {}),
                  });
              }}
            />
          ) : null}
        </div>
      </BoardDnd>
    </ItemActionsProvider>
  );
}

// ---------------------------------------------------------------------------------------------
// 上部の集計

function SummaryBar({ day, tz }: { day: DayDetail; tz: string }) {
  const { t, dayLabel, locale } = useI18n();
  const openExpired = useOpenExpired();
  // 期限切れの件名は「今日閉じた」の行と同じ（直近の指示。R79）
  const subjects = useClosedSubjects(day.totals.expired > 0 ? expiredShown(day.closedToday) : []);
  const x = day.totals;
  // 集計の論理日（D-054）。暦日の今日を深夜に開いたときは前日の論理日の値なので、その日付を添える
  const scope = day.summary;
  const scopeLabel =
    scope.date !== day.date
      ? (() => {
          const l = dayLabel(scope.date);
          return t("day.summaryOf", { day: `${l.weekday} ${l.date}` });
        })()
      : null;
  // 見出し（確定デザイン）: 左に「金曜日 · 今日」、右に大きな数字は1つ（「空き 2h10m」）と、残りを小さく
  // （予定 · 自分 · AI · 放置。点線の下線でホバーの定義）。0 の項目は出さない
  const free = day.phase !== "past" ? day.freeSlots.reduce((a, s) => a + (s.end - s.start), 0) : 0;
  const parts: { k: MessageKey; def: MessageKey; v: string; lines?: string[] }[] = [];
  const more = (count: number) => t("totals.tipMore", { count });
  if (x.meetingsMs > 0)
    parts.push({ k: "day.total.meetings", def: "totals.events.def", v: fmtDuration(x.meetingsMs) });
  if (x.youMs > 0)
    parts.push({ k: "day.total.you", def: "day.total.you.def", v: fmtDuration(x.youMs) });
  if (x.aiMs > 0) parts.push({ k: "totals.ai", def: "totals.ai.def", v: fmtDuration(x.aiMs) });
  // 放置は 0 なら出さない（B-8。R12「0 の値は出さない」に揃えた）
  if (scope.phase !== "future" && x.idleMs > 0)
    parts.push({
      k: "totals.idle",
      def: "totals.idle.def",
      v: fmtDuration(x.idleMs),
      // 放置の内訳（リポジトリ別。R27・R79）
      lines: idleTipLines(day.idleByRepo, {
        name: (r) => whereName(r, t("ai.scratch")) ?? t("totals.noRepo"),
        more,
      }),
    });
  // 期限切れの件名と閉じた時刻（R79）。押すと右の一覧の「今日閉じた」の期限切れの行へ
  if (x.expired > 0)
    parts.push({
      k: "totals.expired",
      def: "totals.expired.def",
      v: String(x.expired),
      lines: expiredTipLines(day.closedToday, {
        subject: (r) => subjects.get(r.followUpId) ?? closedFallback(r, locale),
        tz,
        more,
      }),
    });
  const rel = day.phase === "today" ? t("dayDivider.today") : dayLabel(day.date).date;
  return (
    <div className="flex shrink-0 items-start gap-4 border-line border-b px-4 pt-3 pb-2.5">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <h2 className="truncate font-semibold text-fg text-section" data-testid="day-title">
          {longWeekday(day.date, locale)}
          {rel ? <span> · {rel}</span> : null}
        </h2>
        {scopeLabel ? (
          <span className="text-fg3 text-meta" data-testid="day-totals-scope">
            {scopeLabel}
          </span>
        ) : null}
      </div>
      <div className="flex min-w-0 flex-col items-end gap-1">
        {free > 0 ? (
          <span className="flex items-baseline gap-1.5" title={t("totals.free.def")}>
            <span className="text-fg2 text-meta">{t("totals.free")}</span>
            <span className="font-mono font-semibold text-fg text-title leading-6">
              {fmtDuration(free)}
            </span>
          </span>
        ) : null}
        <div className="truncate whitespace-pre text-fg2 text-meta" data-testid="day-totals">
          {parts.map((p, i) => (
            <span key={p.k}>
              {i > 0 ? " · " : ""}
              <TotalsItem
                name={`${t(p.k)} ${p.v}`}
                tip={totalsTip(t(p.def), p.lines ?? [])}
                focusable={p.lines !== undefined && p.lines.length > 0}
                onClick={p.k === "totals.expired" ? () => openExpired(day.date) : undefined}
                data-totals={p.k}
              >
                {/* 等幅は長さだけ（D-114） */}
                {t(p.k)} <span className="font-mono">{p.v}</span>
              </TotalsItem>
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

/** デイビューの見出しの曜日（`金曜日` / `Friday`） */
function longWeekday(date: string, locale: "en" | "ja"): string {
  const d = new Date(`${date}T12:00:00Z`);
  return new Intl.DateTimeFormat(locale === "ja" ? "ja-JP" : "en-US", {
    weekday: "long",
    timeZone: "UTC",
  }).format(d);
}

/** 右の一覧の見出し（`自分の番 3`） */
function ListTitle({ text, count }: { text: string; count?: number }) {
  return (
    <h2 className="mb-1 flex items-center gap-2 px-0.5 font-semibold text-fg text-section">
      {text}
      {count ? (
        <span className="rounded-full bg-sunken px-1.5 font-medium text-fg2 text-meta">
          {count}
        </span>
      ) : null}
    </h2>
  );
}

// ---------------------------------------------------------------------------------------------
// 左パネル

/** 「今日閉じたもの」の見出しのキー（j / k で通る） */
const CLOSED_HEAD = "closed:head";
/** 開いた日（sessionStorage） */
const CLOSED_OPEN_KEY = "turnlane.day.closedOpen";

/**
 * 今日閉じたもの: 既定は見出しの 1 行の要約（`今日閉じたもの 14 · 返答 3 · 許可 9 · 対応不要 2 · 返事まで 4m`。0 の種類は出さない）。
 * 見出しを押す（⏎）と閉じ方 4 種の行（返答済み（取り消し線と時刻）/ ~ 解決（推定）（破線のチェック）/ 対応不要（⊘）/
 * 期限切れ（時計））を開き、もう一度で畳む
 */
function ClosedToday({
  rows,
  tz,
  open,
  onToggle,
  isSel,
}: {
  rows: ClosedTodayRow[];
  tz: string;
  open: boolean;
  onToggle: () => void;
  isSel: (k: string) => boolean;
}) {
  const { t } = useI18n();
  if (rows.length === 0) return null;
  const sum = closedSummary(rows);
  const parts = [
    ...sum.parts.map((p) => `${t(p.key as never)} ${p.count}`),
    ...(sum.medianMs !== null
      ? [t("day.closedSummary.median", { time: fmtDuration(sum.medianMs) })]
      : []),
  ];
  return (
    <section
      className="flex flex-col gap-1"
      data-testid="closed-today"
      aria-label={t("day.closedToday")}
    >
      <button
        type="button"
        tabIndex={-1}
        onClick={onToggle}
        aria-expanded={open}
        className={`flex min-h-7 items-start gap-1 rounded-control px-0.5 py-1 text-left text-fg2 text-meta hover:text-fg ${
          isSel(CLOSED_HEAD) ? "shadow-[inset_0_0_0_1.5px_var(--dl-accent)]" : ""
        }`}
        data-testid="closed-summary"
        data-kind="closed"
        data-id="head"
      >
        <ChevronRight
          size={14}
          strokeWidth={1.5}
          aria-hidden="true"
          className={`mt-px shrink-0 ${open ? "rotate-90" : ""}`}
        />
        <span className="min-w-0">
          <span className="font-semibold">{t("day.closedToday")}</span>{" "}
          <span className="font-mono font-medium">{sum.total}</span>
          {parts.map((p) => (
            <span key={p}>{` · ${p}`}</span>
          ))}
        </span>
      </button>
      {open
        ? rows.map((r) => (
            <ClosedTodayLine
              key={r.followUpId}
              row={r}
              tz={tz}
              selected={isSel(`closed:${r.followUpId}`)}
            />
          ))
        : null}
    </section>
  );
}

function ClosedTodayLine({
  row: r,
  tz,
  selected,
}: {
  row: ClosedTodayRow;
  tz: string;
  selected: boolean;
}) {
  const { t, locale } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  // 件名は行と同じ glance の件名（D-214 (1)）。読めなければ作ったときの件名
  const subject = useClosedSubject(r, ref, closedFallback(r, locale));
  const kind = r.kind;
  return (
    <div
      ref={ref}
      className={`flex h-8 min-w-0 items-center gap-2 rounded-control px-1 text-fg2 ${
        selected ? "shadow-[inset_0_0_0_1.5px_var(--dl-accent)]" : ""
      }`}
      data-closed={kind}
      data-kind="closed"
      data-id={r.followUpId}
      title={kind === "resolved" && r.signal ? r.signal.replace("_", " ") : undefined}
    >
      {kind === "not_needed" ? (
        <Ban size={16} strokeWidth={1.5} className="shrink-0 text-fg3" aria-hidden="true" />
      ) : kind === "expired" ? (
        <Clock size={16} strokeWidth={1.5} className="shrink-0 text-fg3" aria-hidden="true" />
      ) : (
        <Check checked dashed={kind === "resolved"} label={t("action.complete")} />
      )}
      <span className="min-w-0 flex-1 truncate text-body">{subject}</span>
      <Nums className="shrink-0 text-fg3 text-meta" text={closedLabel(r, t, tz)} />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// 時間軸

function LaneHeader() {
  const { t } = useI18n();
  // レーンの見出しだけ（待ちの線の凡例は右下の「?」の凡例に任せる。R19・D-114）。区切りの縦線は時間軸だけ（D-117）
  return (
    <div className="flex h-7 shrink-0 border-line border-b text-fg3 text-micro">
      <div className="shrink-0 border-line border-r" style={{ width: GUTTER_PX }} />
      <div className="relative flex min-w-0 flex-1">
        <div
          className="flex items-center px-2"
          style={{ width: `${EV.width}%` }}
          data-lane-head="events"
        >
          {t("day.lane.events")}
        </div>
        <div className="flex items-center px-2" style={{ width: `${ME.width}%` }}>
          {t("day.lane.me")}
        </div>
        <div className="flex min-w-0 items-center px-2" style={{ width: `${AI.width}%` }}>
          {t("day.lane.ai")}
        </div>
      </div>
    </div>
  );
}

/** 待ちの線の描き分け（猶予 = 1px 点線・状態色 50% / 放置 = 太い点線・状態色 / 集計外 = 1px 灰色点線） */
function waitStroke(kind: string, tone: string, _dir: "v" | "h"): string {
  if (kind === "idle") return `3px dotted ${TONE[tone] ?? "var(--dl-turn)"}`;
  if (kind === "grace") return `1px dotted ${TONE[tone] ?? "var(--dl-turn)"}`;
  return "1px dotted var(--dl-text-3)";
}

const lanePos = (l: { left: number; width: number }) => ({
  left: `${l.left}%`,
  width: `${l.width}%`,
});

function Timeline({
  day,
  tz,
  now,
  aiBlocks,
  isSel,
  onPick,
  projectName,
  rangeDone,
  onRange,
  onRangeEvent,
}: {
  day: DayDetail;
  tz: string;
  now: number;
  aiBlocks: DayAiBlock[];
  isSel: (k: string) => boolean;
  onPick: (k: string) => void;
  projectName: (id: string | null) => string | null;
  rangeDone: number;
  onRange: (range: Interval, el: HTMLElement, as?: "task" | "event") => void;
  /** 予定のレーンの範囲選択（新規予定。D-093） */
  onRangeEvent: (range: Interval, el: HTMLElement) => void;
}) {
  const { t, dayLabel } = useI18n();
  const axis = day.axis;
  const height = yAt(axis.end, axis.start);
  const isToday = day.phase === "today";
  const dnd = useBoardDnd();
  const drop = useGridDrop(day);
  const select = useRangeSelect(day, onRange);
  const clearRange = select.clear;
  // 予定のレーン（D-093）: 予定のドロップ先と、空白の範囲選択（新規予定）
  const evDrop = useGridDrop(day, "events");
  const evSelect = useRangeSelect(day, onRangeEvent);
  const clearEvRange = evSelect.clear;
  // 空き枠の右クリック: ここにタスク / 予定を作る・集中モード（UX 監査 A1）。予定は予定のレーンに作る
  const actions = useItemActions();
  const onSlotMenu = (e: React.MouseEvent<HTMLElement>) => {
    if ((e.target as HTMLElement).closest("[data-kind],[data-drag],button,[data-wait]")) return;
    const slot = select.slotAt(e.clientY);
    if (!slot || !actions) return;
    e.preventDefault();
    const el = e.target as HTMLElement;
    actions.openMenu(
      e.clientX,
      e.clientY,
      slotMenu(t, (as) =>
        as === "event" ? evSelect.openAt(slot, el) : select.openAt(slot, el, "task"),
      ),
    );
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: ポップオーバーを閉じたら消す
  useEffect(() => {
    clearRange();
    clearEvRange();
  }, [rangeDone]);
  const preview = dnd?.preview?.date === day.date ? dnd.preview : null;
  // 予定を動かしている間の仮置きは予定のレーンに出す
  const movingEvent = dnd?.active?.kind === "event";
  const ghost: GridPreview | null =
    isDropGhost(preview) && !movingEvent
      ? preview
      : select.range
        ? { date: day.date, range: select.range, overlap: false, taskId: null }
        : null;
  const evGhost: GridPreview | null =
    isDropGhost(preview) && movingEvent
      ? preview
      : evSelect.range
        ? { date: day.date, range: evSelect.range, overlap: false, taskId: null }
        : null;
  const countedIn = (at: Interval | null) => {
    const d = at ? countedInDate(day, at) : null;
    if (!d) return undefined;
    const l = dayLabel(d);
    return t("board.countedIn", { day: `${l.weekday} ${l.date}` });
  };

  // 拡張の時間軸の印（ADR 0015。公開のビルドでは無い）
  const marks = useTimelineMarks({ from: axis.start, to: axis.end });
  // 離れていた間のまとめ（D-214 (2)）: 今日の時間軸に入る離席の区間と、その間に変わった件
  const away = useAwayDigest();
  const awayAt =
    isToday && away && now < away.until ? clip({ start: away.from, end: away.to }, axis) : null;
  const awayIds = new Set(away?.items.map((x) => x.workItemId) ?? []);
  // 開いている待ち（D-240 の wait。猶予中を含む。D-246）
  const laneWaits = useLaneWaits();
  const { placed: aiPlaced, overflow } = layoutDayAi(
    aiBlocks,
    axis.start,
    waitExtentOf(aiBlocks, now, axis),
  );
  const lines = waitLines(day, aiPlaced, now);
  // ラベルは同じ項目の続き（chain）の最後のブロックにだけ（D-117）。前のブロックは線だけ
  const bareIds = new Set<string>(aiPlaced.filter((p) => !p.tail).map((p) => p.id));
  // 今の線（今日だけ）。どのラベルも今の線に重ねず、重なるものは線の下へずらす（lane-labels.ts）
  const nowY = isToday ? yAt(now, axis.start) : null;
  /** 題名のラベルの上端（今の線に重なるものは線の下へ） */
  const titleTop = (p: PlacedAi) => belowNow(p.top, LABEL_H, nowY);
  // ラベルの重なり（3日ボードの AI レーンと同じ規則。D-190）: 先に始まったラベルと重なるものはラベルを出さず、先のラベルに `+1`
  // 重なるラベルは対応が要るものを先に（D-246。3日ボードと同じ）: 自分の番 → 実行中 → 完了・PR
  const rankOf = (p: PlacedAi) =>
    laneRank(p.block.status, p.block.last ? laneWaits.get(p.block.item.id) : undefined);
  const merged = new Map<string, PlacedAi[]>();
  {
    const shown: PlacedAi[] = [];
    for (const p of [...aiPlaced]
      .filter((x) => x.tail)
      .sort((a, b) => rankOf(a) - rankOf(b) || titleTop(a) - titleTop(b) || a.column - b.column)) {
      const hit = shown.find(
        (x) => titleTop(p) < titleTop(x) + LABEL_H && titleTop(x) < titleTop(p) + LABEL_H,
      );
      if (hit) {
        bareIds.add(p.id);
        merged.set(hit.id, [...(merged.get(hit.id) ?? []), p]);
      } else shown.push(p);
    }
  }
  const moreOf = (id: string) => {
    const xs = merged.get(id);
    return xs && xs.length > 0
      ? {
          count: xs.length,
          hint: xs
            .map(
              (x) => `${fmtClock(x.block.at.start, tz)} ${x.block.item.title ?? t("common.none")}`,
            )
            .join("\n"),
        }
      : null;
  };
  // 画面の上端に残すラベル（sticky）の段: 同じ時間に動いている、より左の列のラベルの数だけ下へずらす（D-117）
  const stickyTopOf = (p: PlacedAi) =>
    4 +
    LABEL_H *
      aiPlaced.filter(
        (q) =>
          q.tail &&
          !bareIds.has(q.id) &&
          q.column < p.column &&
          q.top < p.top + p.height &&
          p.top < q.top + q.height,
      ).length;
  // ラベルは、その高さの範囲で動いている線のうち一番右の線の右から
  const labelLeftOf = (p: PlacedAi) => {
    let col = p.column;
    for (const q of aiPlaced)
      if (q.top < p.top + LABEL_H && p.top < (q.reach ?? q.top + q.height))
        col = Math.max(col, q.column);
    return colX(col) - colX(p.column) + 9;
  };
  // 自分レーン
  const layout = placementsOf(day);
  // 閉じた待ちの終わり（D-075）。開いている待ちだけを目立たせ、閉じた待ちは薄い線と終わりの点
  const ends = waitEndsOf(day.aiLane, layout.replies, day.timeEntries);
  const openKeys = new Map(day.aiLane.map((x) => [x.id, openWaitKeys(x.waits)]));
  const endOf = (l: WaitLine): WaitEnd | null =>
    openKeys.get(l.itemId)?.has(l.seg.waitKey)
      ? null
      : (ends.find((e) => e.itemId === l.itemId && e.waitKey === l.seg.waitKey) ?? null);
  /** 点・線のクリック: 返答のタスクのパネル、返答が無ければ AI 詳細パネル */
  const pickEnd = (k: string) => onPick(k);
  // 在席・状態の札（放置・会議中・離席 · 数えない・タスクなし など）: 題名のラベル（2 行目の待ちの札を含む）の後に場所を取る。
  // 題名・ほかの札・今の線と重ならない位置へ線の範囲でずらし、置けなければ省いて線のホバーに任せる（lane-labels.ts）。
  // 左端はその高さで動いている線（AI・待ち）の右へ寄せ、線の上に文字を重ねない
  const tags = new Map<string, TagPlace | null>();
  {
    const titles = aiPlaced
      .filter((p) => p.tail && !bareIds.has(p.id))
      .map((p) => ({ top: titleTop(p), height: LABEL_H }));
    const rails: Rail[] = [
      ...aiPlaced.map((p) => ({ x: colX(p.column) + 3, top: p.top, bottom: p.top + p.height })),
      ...lines
        .filter((l) => l.height > 0)
        .map((l) => ({
          x: colX(l.column) + l.track * WAIT_TRACK_PX + 3,
          top: l.top,
          bottom: l.top + l.height,
        })),
    ];
    const asks = lines.flatMap((l) => {
      const label = l.label;
      if (!label || l.height <= 0) return [];
      // 集計外の理由は開いている待ちだけ、置ける高さのある区間だけ（短い区間はホバー。D-065）
      if (label.t === "excluded" && (endOf(l) !== null || l.height < EXCLUDED_LABEL_MIN_PX))
        return [];
      if (label.t === "grace") return [];
      const left = waitLabelOnLeft(l);
      return [
        {
          id: l.key,
          want: label.t === "idle" ? l.top + l.height / 2 - LABEL_PX / 2 : l.top + 2,
          lo: l.top,
          hi: l.top + l.height - LABEL_PX,
          // 放置を先に（重なれば集計外の札を省く）。同じ種類は長い区間から
          weight: (label.t === "idle" ? 1e12 : 0) + (l.at.end - l.at.start),
          minLeft: colX(l.column) + 10 + (l.trackMax + l.track) * WAIT_TRACK_PX,
          region: left ? ("left" as const) : ("lane" as const),
        },
      ];
    });
    for (const [k, v] of placeTags(asks, titles, { tagPx: LABEL_PX, nowY, rails })) tags.set(k, v);
  }
  const meItems = layout.placed.map((p) => ({ id: p.task.id, at: resizeAt(p, preview) }));
  const mePlaced = layoutMe(meItems, axis);
  // 予定（伸縮中のものは仮の終わりで描く。D-093）
  const events =
    preview?.eventId != null
      ? day.events.map((e) => (e.id === preview.eventId ? { ...e, end: preview.range.end } : e))
      : day.events;
  const evPlaced = layoutMe(
    events.map((e) => ({ id: e.id, at: e })),
    axis,
  );

  return (
    <div className="relative min-w-0 flex-1" style={{ height }} data-day={day.date}>
      <GridBackground axis={axis} hourPx={H} />
      {/* レーンの間の細い区切り（D-117。D-114 でやめたものを戻した） */}
      <LaneDivider left={ME.left} />
      <LaneDivider left={AI.left} />
      {/* Events（予定のドロップ先と、空白の範囲選択で新規予定。D-093） */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: 空き枠の右クリック（キーボードは c / ⇧C） */}
      <div
        ref={evDrop.setNodeRef}
        onPointerDown={evSelect.onPointerDown}
        onContextMenu={onSlotMenu}
        className="absolute inset-y-0"
        style={lanePos(EV)}
        data-lane="events"
        data-evgrid={day.date}
      >
        {evPlaced.map((p) => {
          const e = events.find((x) => x.id === p.id);
          if (!e) return null;
          const pos: React.CSSProperties = {
            top: p.top,
            height: Math.max(20, p.height),
            left: `calc(${(p.column / p.columns) * 100}% + 4px)`,
            width: `calc(${100 / p.columns}% - 8px)`,
          };
          const block = (style: React.CSSProperties) => (
            <EventBlock
              key={e.id}
              e={e}
              tz={tz}
              hint={countedIn(e)}
              compact={p.height < 34}
              selected={isSel(`event:${e.id}`)}
              style={style}
            />
          );
          return e.editable && dnd ? (
            <DraggableEvent key={e.id} event={e} day={day} style={pos}>
              {block({ top: 0, bottom: 0, left: 0, right: 0 })}
            </DraggableEvent>
          ) : (
            block(pos)
          );
        })}
        {evGhost ? <Ghost axis={axis} ghost={evGhost} tz={tz} /> : null}
      </div>
      {/* Me（時間軸への DnD・範囲選択の的） */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: 空き枠の右クリック（キーボードは c / ⇧C） */}
      <div
        ref={drop.setNodeRef}
        data-grid={day.date}
        data-px-per-ms={DAY_PX_PER_MS}
        onPointerDown={select.onPointerDown}
        onContextMenu={onSlotMenu}
        className="absolute inset-y-0"
        style={lanePos(ME)}
      >
        {mePlaced.map((p) => {
          const pl = layout.placed.find((x) => x.task.id === p.id);
          if (!pl) return null;
          const block = pl.variant === "planned" ? pl.block : null;
          const style: React.CSSProperties = {
            top: p.top,
            height: p.height,
            left: `calc(${(p.column / p.columns) * 100}% + 4px)`,
            width: `calc(${100 / p.columns}% - ${p.columns > 1 ? 6 : 8}px)`,
          };
          const card = (s: React.CSSProperties) => (
            <MeBlock
              task={pl.task}
              variant={pl.variant}
              at={pl.at}
              height={p.height}
              fromAi={pl.task.workItemId !== null}
              selected={isSel(`task:${pl.task.id}`)}
              project={projectName(pl.task.projectId)}
              tz={tz}
              hint={pl.cross ? countedIn(pl.at) : undefined}
              onClick={() => onPick(`task:${pl.task.id}`)}
              style={s}
            />
          );
          if (block && dnd)
            return (
              <DraggableTask
                key={pl.task.id}
                task={pl.task}
                block={block}
                className="group absolute cursor-grab"
                style={{ ...style, zIndex: 1 }}
              >
                {card({ position: "absolute", inset: 0 })}
                <div
                  className="absolute inset-x-1 bottom-0 h-1.5 cursor-ns-resize"
                  onPointerDown={(e) => dnd.startResize(e, pl.task, block as TimeBlockView, day)}
                  data-testid="resize-handle"
                />
              </DraggableTask>
            );
          return (
            <div key={pl.task.id} className="absolute" style={{ ...style, zIndex: 1 }}>
              {card({ position: "absolute", inset: 0 })}
            </div>
          );
        })}
        {ghost ? <Ghost axis={axis} ghost={ghost} tz={tz} /> : null}
      </div>
      {/* AI */}
      <div className="absolute inset-y-0" style={lanePos(AI)} data-lane="ai">
        {/* 離れていた間（D-214 (2)）: まとめが出ている間、離席の区間を AI のレーンの背景に薄く敷く */}
        {awayAt ? (
          <div
            className="pointer-events-none absolute inset-x-0 bg-sunken"
            style={{ top: yAt(awayAt.start, axis.start), height: yAt(awayAt.end, awayAt.start) }}
            data-testid="away-shade"
            role="img"
            aria-label={t("away.shade", {
              from: fmtClock(awayAt.start, tz),
              to: fmtClock(awayAt.end, tz),
            })}
          />
        ) : null}
        {/* 取り込み元があるのに今日の実行が 0 件のときの 1 行（B-10） */}
        <AiLaneEmpty
          empty={day.phase === "today" && day.aiLane.length === 0}
          top={yAt(day.plannedHours?.start ?? axis.start + 9 * 3_600_000, axis.start) + 4}
        />
        {lines.map((l) => (
          <WaitLineView
            key={l.key}
            line={l}
            tz={tz}
            closed={endOf(l)}
            onPickEnd={pickEnd}
            tag={tags.get(l.key)}
          />
        ))}
        {aiPlaced.map((p) => (
          <AiSpanBlock
            key={p.id}
            emph={
              awayAt !== null &&
              awayIds.has(p.block.item.id) &&
              p.block.at.start < awayAt.end &&
              awayAt.start < p.block.at.end
            }
            bare={bareIds.has(p.id)}
            more={moreOf(p.id)}
            labelLeft={labelLeftOf(p)}
            p={p}
            drop={titleTop(p) - p.top}
            stickyTop={stickyTopOf(p)}
            now={now}
            isSel={isSel}
            onPick={onPick}
            hint={countedIn(p.block.at)}
          />
        ))}
        {overflow.map((o) => (
          <div
            key={`of-${o.top}`}
            className="absolute right-1 rounded-chip bg-sunken px-1 text-meta text-fg2"
            style={{ top: o.top }}
          >
            +{o.hidden.length}
          </div>
        ))}
        <TimelineMarks
          marks={marks}
          axisStart={axis.start}
          pxPerMs={DAY_PX_PER_MS}
          tz={tz}
          barX={colX}
          busyColumn={(top, bottom) =>
            aiPlaced
              .filter(
                (q) =>
                  q.top < bottom && top < Math.max(q.reach ?? q.top + q.height, q.top + LABEL_H),
              )
              .reduce((m, q) => Math.max(m, q.column), -1)
          }
        />
      </div>
      {/* 閉じた待ちの終わりの点（ホバーで `replied 13:40 · 3m`。D-075。D-074 の `↩ 8m` と旧コネクタを置き換え） */}
      <div className="pointer-events-none absolute inset-y-0" style={lanePos(AI)}>
        <div className="pointer-events-auto">
          <WaitDots
            ends={ends}
            axis={axis}
            pxPerMs={DAY_PX_PER_MS}
            colOf={(e) => {
              const l = lines
                .filter((x) => x.itemId === e.itemId && x.seg.waitKey === e.waitKey)
                .at(-1);
              if (l)
                return { column: 0, columns: 1, dx: colX(l.column) - 8 + l.track * WAIT_TRACK_PX };
              const c = connectorTarget(e.itemId, null, e.at, lines, aiPlaced);
              return c ? { column: 0, columns: 1, dx: colX(c.column) - 8 } : null;
            }}
            tz={tz}
            isSel={isSel}
            onPick={pickEnd}
          />
        </div>
      </div>
      {isToday ? <NowLine axis={axis} now={now} hourPx={H} /> : null}
    </div>
  );
}

/** 伸縮中のブロックは仮の範囲で描く */
function resizeAt(p: { task: TaskView; at: Interval }, preview: GridPreview | null): Interval {
  return preview && preview.taskId === p.task.id ? preview.range : p.at;
}

function Ghost({ axis, ghost, tz }: { axis: Interval; ghost: GridPreview; tz: string }) {
  const top = yAt(ghost.range.start, axis.start);
  const h = Math.max(16, yAt(ghost.range.end, ghost.range.start));
  return (
    <div
      className="pointer-events-none absolute right-1 left-1 z-30 rounded-card border border-accent border-dashed bg-accent/10"
      style={{ top, height: h }}
      data-range-ghost={ghost.date}
      data-testid="drop-ghost"
    >
      <span className="absolute top-0.5 right-1 rounded-chip bg-bg px-1 font-mono text-meta text-fg">
        {fmtClock(ghost.range.start, tz)}–{fmtClock(ghost.range.end, tz)}
      </span>
    </div>
  );
}

/**
 * 自分レーンのブロック: 計画は枠線、実績は塗り。15分未満（最小 16px）は1行。AI 由来は `← AI` を添え、右端に長さ。
 * 左に ○ を置かず、題名は予定と同じ左の余白から始める。完了・日付へ移す・⋯ は右のホバーのボタン（✓ →| ⋯。D-148）
 */
function MeBlock({
  task,
  variant,
  at,
  height,
  fromAi,
  selected,
  project,
  hint,
  onClick,
  style,
  tz,
}: {
  tz: string;
  task: TaskView;
  variant: "planned" | "done";
  at: Interval;
  height: number;
  fromAi: boolean;
  selected: boolean;
  project: string | null;
  hint?: string | undefined;
  onClick: () => void;
  style: React.CSSProperties;
}) {
  const { locale } = useI18n();
  const actions = useItemActions();
  const k = `task:${task.id}`;
  const done = task.status === "done";
  const surface = taskSurface(variant, selected);
  const ms = at.end - at.start;
  const small = height < 20;
  // 2行目（時刻の範囲・プロジェクト）を出せる高さ
  const two = height >= 36;
  const range = `${fmtClock(at.start, tz)}-${fmtClock(at.end, tz)}`;
  return (
    // biome-ignore lint/a11y/useSemanticElements: 中にチェックボックス（ボタン）を置くため div
    <div
      role="button"
      tabIndex={-1}
      data-kind="task"
      data-id={task.id}
      title={hint}
      onClick={onClick}
      onKeyDown={undefined}
      onContextMenu={actions ? (e) => actions.menu(e, k) : undefined}
      onDoubleClick={actions ? () => actions.doubleClick(k) : undefined}
      data-selected={selected ? "" : undefined}
      className={`group @container overflow-hidden rounded-chip px-1.5 ${surface}`}
      style={style}
    >
      <div className={`flex min-w-0 items-center gap-1.5 ${small ? "h-[14px]" : "h-[18px]"}`}>
        <span
          className={`min-w-0 flex-1 truncate ${small ? "text-meta" : "text-body"} font-medium ${
            done ? "text-fg3" : "text-fg"
          }`}
        >
          {titleText(task.title, locale)}
        </span>
        {fromAi ? (
          <span className="shrink-0 font-mono text-micro text-fg3 @max-[120px]:hidden">
            {"← AI"}
          </span>
        ) : null}
        {/* 右は計画なら長さ、1行の実績なら時刻の範囲（確定デザインのデイビュー。D-114） */}
        {variant === "planned" || two ? (
          variant === "planned" ? (
            <span className="shrink-0 font-mono text-fg2 text-meta @max-[90px]:hidden">
              {fmtDuration(ms)}
            </span>
          ) : null
        ) : (
          <span className="shrink-0 font-mono text-meta text-fg3 @max-[120px]:hidden">{range}</span>
        )}
      </div>
      {two ? (
        <div className="truncate text-meta text-fg3">
          <span className="font-mono">{range}</span>
          {project ? ` · #${project}` : ""}
        </div>
      ) : null}
      <TaskToolbar
        k={k}
        align="center"
        timeline
        done={done}
        onComplete={() => void setComplete(task, !done)}
        className="@max-[120px]:!hidden"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// AI レーン

function AiSpanBlock({
  p,
  now,
  isSel,
  onPick,
  hint,
  bare = false,
  more = null,
  labelLeft = 9,
  stickyTop = 4,
  emph = false,
  drop = 0,
}: {
  /** ラベルを線の上端から下へずらす幅（今の線に重なるとき。px） */
  drop?: number;
  /** ラベルを画面の上端に残すときの位置（px。D-117） */
  stickyTop?: number;
  p: PlacedAi;
  now: number;
  isSel: (k: string) => boolean;
  onPick: (k: string) => void;
  hint?: string | undefined;
  /** 線だけ（ラベルは先のラベルの `+1` にまとめた） */
  bare?: boolean;
  more?: { count: number; hint: string } | null;
  /** ラベルの左端（線の左端から px） */
  labelLeft?: number;
  /** 離れていた間に変わった件の線（D-214 (2)。線を太く） */
  emph?: boolean;
}) {
  const { t } = useI18n();
  const actions = useItemActions();
  const b = p.block;
  const item = b.item;
  // 問いで止まっている最後の線（猶予中を含む）は自分の番の印と `待ち 3m`（猶予中は `猶予 3m`。D-246）
  const laneWait = useLaneWaits().get(item.id);
  const status = b.last ? laneStatus(b.status, laneWait) : b.status;
  const qWait =
    b.last && item.status !== "needs_input" && item.status !== "error"
      ? questionWait(laneWait)
      : null;
  // 件名（直近の指示 → 自動の題名。spec-glance §2.2。fix-stale-title）。線が見えたら読む
  const ref = useRef<HTMLButtonElement>(null);
  const subject = useAiItemSubject(item, ref, !bare);
  const waitStart = (() => {
    const open = item.waits.find((w) => w.open);
    if (!open) return null;
    return Math.min(...item.waits.filter((w) => w.waitKey === open.waitKey).map((w) => w.start));
  })();
  const waiting =
    b.last && waitStart !== null && (item.status === "needs_input" || item.status === "error");
  // ラベルの2行目（確定デザイン）: ブロック中・エラーは `ブロック中 12m · 1h26m`（待ち · AI 時間）、
  // ほかは `2h29m · 放置 36m`（AI 時間 · 最後のブロックの放置）
  const meta = (
    b.span === null
      ? [
          item.carriedFrom
            ? t("ai.carried", { date: item.carriedFrom.slice(5).replace("-", "/") })
            : null,
        ]
      : qWait
        ? [
            t(qWait.grace ? "turn.graceShort" : "turn.waitLabel", {
              time: fmtWait(Math.max(0, now - qWait.since)),
            }),
            fmtDuration(p.chainAiMs),
          ]
        : waiting
          ? [
              // 待ちの種類（`許可待ち 12m · 1h26m`。確定デザイン）
              `${
                item.status === "needs_input"
                  ? t(
                      item.reason === "ask_user_question"
                        ? "board.needsAnswer"
                        : "board.needsPermission",
                    )
                  : t(`status.${item.status}`)
              } ${fmtWait(now - (waitStart ?? now))}`,
              fmtDuration(p.chainAiMs),
            ]
          : [
              fmtDuration(p.chainAiMs),
              b.last && item.idleMs >= 60_000
                ? t("board.idleLabel", { time: fmtDuration(item.idleMs) })
                : null,
            ]
  )
    .filter(Boolean)
    .join(" · ");
  const selected = isSel(`ai:${item.id}`);
  const x = colX(p.column);
  const color = status === "done" || status === "your_turn" ? "var(--dl-done)" : TONE[status];
  return (
    <>
      {/* ドラッグで自分レーンへ（確認タスク）・別の AI カードへ（統合）（ux-mvp 7章） */}
      <DraggableAi
        dragId={p.id}
        workItemId={item.id}
        title={item.title}
        style={{
          top: p.top,
          height: p.height,
          left: x,
          ...(bare ? { width: 9 } : { right: 4 }),
        }}
      >
        <button
          type="button"
          tabIndex={-1}
          data-kind="ai"
          data-id={item.id}
          data-block={p.id}
          ref={ref}
          {...aiHoverProps({ ...aiHoverOf(item, now, t("ai.scratch")), title: subject, hint })}
          onClick={() => {
            // 選択と詳細パネル（UX 監査 A3）。ターンの内訳は出さない（流れは詳細パネルの「この項目の流れ」。D-116）
            onPick(`ai:${item.id}`);
          }}
          onContextMenu={actions ? (e) => actions.menu(e, `ai:${item.id}`) : undefined}
          onDoubleClick={actions ? () => actions.doubleClick(`ai:${item.id}`) : undefined}
          className={`absolute inset-0 flex items-stretch rounded-control text-left ${
            selected ? "outline outline-[1.5px] outline-accent outline-offset-2" : ""
          }`}
        >
          <span
            className={`${emph ? "-ml-[1px] w-[5px]" : "w-[3px]"} shrink-0 rounded-full`}
            style={{ background: color ?? "var(--dl-text-3)" }}
            data-bar={status}
            data-away={emph ? "" : undefined}
          />
          {bare ? null : (
            // 長い線のラベルは、線の上端が画面の上に隠れても画面の上端に残す（sticky。D-117）
            <span
              className="sticky flex min-w-0 flex-1 flex-col self-start rounded-control bg-lane pr-1 text-meta leading-4"
              style={{
                marginLeft: labelLeft - 3,
                top: stickyTop,
                ...(drop > 0 ? { marginTop: drop } : {}),
              }}
              data-label="ai"
            >
              <span className="flex min-w-0 items-center gap-1 font-medium text-fg">
                <StatusIcon status={status} estimated={b.last && item.estimated} size={14} />
                <span className="min-w-0 truncate text-[12.5px]">
                  {subject ?? t("common.none")}
                </span>
                {more ? (
                  <span
                    className="shrink-0 rounded-chip border border-line px-1 text-fg2 text-micro"
                    title={more.hint}
                  >
                    +{more.count}
                  </span>
                ) : null}
              </span>
              {meta ? (
                <span className="min-w-0 truncate pl-[18px] text-fg2" data-testid="ai-meta">
                  <Nums text={meta} />
                </span>
              ) : null}
            </span>
          )}
        </button>
      </DraggableAi>
    </>
  );
}

const EXCLUDED_KEY: Record<string, MessageKey> = {
  closed: "day.wait.closed",
  away: "day.wait.away",
  event: "day.wait.event",
  no_task: "day.wait.no_task",
  snoozed: "day.wait.snoozed",
  scheduled: "day.wait.scheduled",
  expired: "day.wait.expired",
};

/**
 * 待ちの線1本。放置は太い点線＋背後に幅 12px・状態色 8% の帯（D1）＋ラベル `idle 11m`、ホバーで理由（事実のみ）。
 * 猶予は 1px 点線・状態色 50%、集計外は 1px 灰色点線と区間ごとに1回の理由。
 * この描き分けは開いている待ちだけ（D-075）。閉じた待ち（closed）は 1px 灰色点線で、ホバーで `replied 13:40 · 3m`、
 * クリックで返答のタスクのパネル。閉じた待ちのうち放置だった区間は、放置の事実として帯（4%）と text-tertiary の
 * ラベル・ホバーの理由を残す（仮置き）。集計外の理由のラベルは出さない
 */
function WaitLineView({
  line,
  tz,
  closed,
  onPickEnd,
  tag,
}: {
  /**
   * 札の置き場所（DayLane が題名・ほかの札・今の線と重ならないように決めたもの。lane-labels.ts）。
   * null は置けない（ホバーに任せる）、undefined は札の無い線
   */
  tag?: TagPlace | null | undefined;
  line: WaitLine;
  tz: string;
  /** 閉じた待ちの終わり（開いている待ちは null） */
  closed: WaitEnd | null;
  onPickEnd: (k: string) => void;
}) {
  const { t } = useI18n();
  const [hover, setHover] = useState(false);
  const w = line.seg;
  // 同じ列で重なる別の待ちは段（track）ごとに右へずらす（どの待ちの線か見分ける）
  const dx = line.track * WAIT_TRACK_PX;
  // 線は AI の線と同じ x に続ける（確定デザイン）。放置の 3px の点線は線に重ね、ほかの細い線は線の中ほど
  const base = colX(line.column) + dx;
  const x = base + (w.kind === "idle" && !closed ? 0 : 1);
  const tone = TONE[w.tone] ?? "var(--dl-turn)";
  const idle = w.kind === "idle";
  const label = line.label;
  // 札の位置は DayLane が決める（題名・ほかの札・今の線と重ねない。置けない札はホバー）
  const leftLabel = waitLabelOnLeft(line);
  const shown = tag != null;
  const labelText =
    label?.t === "idle" && shown
      ? t("board.idleLabel", { time: fmtDuration(label.ms) })
      : label?.t === "excluded" && shown && !closed
        ? t(EXCLUDED_KEY[label.by] ?? "day.wait.away")
        : null;
  // 置けなかった集計外の札は、線のホバーでだけ出す（D-065）
  const hoverText =
    label?.t === "excluded" && !shown && !closed
      ? t(EXCLUDED_KEY[label.by] ?? "day.wait.away")
      : null;
  const endText = closed ? waitEndText(closed, t, tz) : null;
  const endKey = closed
    ? closed.reply
      ? `task:${closed.reply.task.id}`
      : `ai:${closed.itemId}`
    : null;
  if (line.height <= 0) return null;
  return (
    <>
      {idle ? (
        // 放置の帯（D1）。ホバーで理由（事実のみ）。閉じた待ちは薄く（4%）
        // biome-ignore lint/a11y/noStaticElementInteractions: ホバーの説明。閉じた待ちはクリックで返答のパネル
        // biome-ignore lint/a11y/useKeyWithClickEvents: キーボードでは点ではなく項目を選ぶ
        <div
          className={`absolute ${endKey ? "cursor-pointer" : ""}`}
          data-wait="idle-band"
          onMouseEnter={() => setHover(true)}
          onMouseLeave={() => setHover(false)}
          onClick={endKey ? () => onPickEnd(endKey) : undefined}
          style={{
            top: line.top,
            height: line.height,
            left: base - 4.5,
            width: 12,
            background: `color-mix(in srgb, ${tone} ${closed ? 4 : 8}%, transparent)`,
          }}
        />
      ) : endKey ? (
        // 閉じた待ちの線のホバーとクリック（線は 1px なので当たりを広く取る）
        <button
          type="button"
          tabIndex={-1}
          data-kind="wait-closed"
          title={endText ?? ""}
          onClick={() => onPickEnd(endKey)}
          className="absolute cursor-pointer"
          style={{
            top: line.top,
            height: line.height,
            left: base - 3,
            width: 9,
          }}
        />
      ) : null}
      <div
        className="pointer-events-none absolute"
        data-wait={closed ? "closed" : w.kind}
        data-wait-item={line.itemId}
        style={{
          top: line.top,
          height: line.height,
          left: x,
          borderLeft: closed ? "1px dotted var(--dl-text-3)" : waitStroke(w.kind, w.tone, "v"),
          opacity: !closed && w.kind === "grace" ? 0.5 : 1,
        }}
      />
      {labelText && tag ? (
        <div
          className={`pointer-events-none absolute z-[2] overflow-hidden whitespace-nowrap text-meta leading-4 ${
            leftLabel ? "text-right" : ""
          }`}
          style={{
            top: tag.top,
            // 3 列目以降の線は、札を一番左の線の左に右寄せで置く（R27）。ほかは線の右（その高さの線より右）
            ...(leftLabel
              ? { right: `calc(100% - ${colX(0) - 8}px)`, width: 120 }
              : { left: tag.left, right: 4 }),
          }}
        >
          {/* 地の色の札にして、離れていた間の網掛け（D-224）や線の上でも読めるようにする */}
          <span
            className="inline-block rounded-chip bg-lane px-1 text-fg2"
            data-wait-label={w.kind}
            style={{ color: idle && !closed ? "var(--dl-text-2)" : undefined }}
          >
            <Nums text={labelText} />
          </span>
        </div>
      ) : null}
      {hoverText ? (
        // biome-ignore lint/a11y/noStaticElementInteractions: ホバーの説明だけで操作は無い
        <div
          className="absolute"
          data-wait="excluded-hover"
          onMouseEnter={() => setHover(true)}
          onMouseLeave={() => setHover(false)}
          style={{
            top: line.top,
            height: Math.max(line.height, 6),
            left: base - 4.5,
            width: 12,
            zIndex: 32,
          }}
        />
      ) : null}
      {hover && hoverText ? (
        <div
          className="pointer-events-none absolute z-40 whitespace-nowrap rounded-pop border border-line bg-raised px-2 py-1 font-mono text-meta text-fg2 shadow-pop"
          data-testid="excluded-hover"
          style={{
            top: line.top,
            left: base + 16,
          }}
        >
          {hoverText} · {fmtClock(line.at.start, tz)}–{fmtClock(line.at.end, tz)}
        </div>
      ) : null}
      {hover && idle ? (
        <div
          className="pointer-events-none absolute z-40 flex flex-col gap-1 rounded-pop border border-line bg-raised px-3 py-2 font-mono text-meta text-fg2 shadow-pop"
          data-testid="idle-hover"
          style={{
            top: line.top + Math.min(line.height / 2, 40),
            left: base + 24,
          }}
        >
          <div className="whitespace-nowrap font-semibold text-fg">
            {t("day.idleHover.title", {
              range: `${fmtClock(line.at.start, tz)}–${fmtClock(line.at.end, tz)}`,
              time: fmtDuration(line.at.end - line.at.start),
            })}
          </div>
          <div className="whitespace-nowrap">{t("day.idleHover.why")}</div>
          <div className="whitespace-nowrap">{t("day.idleHover.counts")}</div>
          {endText ? <div className="whitespace-nowrap">{endText}</div> : null}
        </div>
      ) : null}
    </>
  );
}
