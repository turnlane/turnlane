/**
 * ボード（M2-3・M2-14・M2-6 の帯。ux-mvp 4.4・4.4.0、確定デザイン week-board-v4、D-074）。
 * 各カラムは上から ヘッダ → 終日の行 → YOUR TURN 帯（今日だけ）→ Unscheduled → 24時間の時間軸。上部エリアの高さは内容で決める。
 * - 3日ボード（既定）: 前の稼働日 25% / 基準日 50% / 次の稼働日 25%。基準日が今日なら Plan（予定・自分）35% / AI 65% の2レーン（D-075）
 * - 週表示（計画モード）: 昨日・今日・以降の最大7日。AI の時間軸のブロックは出さず、右端の稼働リボンとヘッダの AI 時間だけ
 */

import { useNavigate } from "@tanstack/react-router";
import {
  type BoardResponse,
  clip,
  type DayColumn,
  fmtClock,
  fmtDuration,
  layoutMeLane,
  type MeLaneBox,
  type MeLaneItem,
  nextWeekday,
  type QueueItem,
  type QueueResponse,
  type TaskView,
  type TimeBlockView,
} from "@turnlane/core/web";
import { ChevronLeft, Plus, Triangle } from "lucide-react";
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ItemActionsProvider,
  rangeKeys,
  slotMenu,
  toggleKey,
  useItemActions,
  useItemActionsHost,
  usePanelFollow,
} from "../actions/item-actions.tsx";
import { AwayLine, useAwayDigest } from "../components/AwayLine.tsx";
import { BulkBar } from "../components/BulkBar.tsx";
import { AllDayChip, EventBlock, TaskCard, titleText } from "../components/items.tsx";
import { LegendButton } from "../components/Legend.tsx";
import { Nums } from "../components/Nums.tsx";
import { useOpenWith } from "../components/OpenWith.tsx";
import {
  ClosedFold,
  ClosedTurnRow,
  closedFallback,
  primaryFollowUp,
  TurnRow,
} from "../components/TurnRow.tsx";
import { answerable, useAnswerEnabled } from "../data/answer.ts";
import { useClosedSubjects } from "../data/glance.ts";
import {
  carryDay,
  completeItems,
  createEvent,
  createReplyTask,
  createTask,
  createTaskWithBlock,
  deferFollowUp,
  deleteTask,
  dismissAway,
  dismissFollowUps,
  moveTask,
  openTask,
  renameTask,
  setComplete,
  snoozeFollowUp,
  unscheduleTask,
} from "../data/mutations.ts";
import {
  countedTurns,
  turnRows,
  useBoard,
  useBoardAround,
  useInbox,
  useProjects,
  useQueue,
} from "../data/queries.ts";
import { currentToday, setToday } from "../data/sse.ts";
import { ext } from "../ext/registry.ts";
import { type MessageKey, useI18n } from "../i18n/index.tsx";
import { useKeys } from "../keys/use-keys.ts";
import { boardNav, dayNav } from "../lib/board-nav.ts";
import { useNow } from "../lib/clock.ts";
import { addDaysSafe } from "../lib/dates.ts";
import { useWindowWidth } from "../lib/fit.ts";
import { anyPanelOpen, getUi, type SelItem, setUi, useUi } from "../lib/store.ts";
import { AiLaneEmpty, ImportEmptyState } from "../onboarding/BoardEmpty.tsx";
import { useFocusRequest, usePublishSelection } from "../palette/selection.ts";
import { AiLane, aiKeysOf } from "./AiLane.tsx";
import { countedInDate, type Placement, placementsOf } from "./day-split.ts";
import {
  BoardDnd,
  CardDrop,
  DateDrop,
  DraggableEvent,
  DraggableTask,
  type GridPreview,
  isDropGhost,
  TurnDrag,
  useBoardDnd,
  useGridDrop,
  useRangeSelect,
} from "./dnd.tsx";
import { type Prompt, PromptView } from "./editors.tsx";
import {
  GUTTER_PX,
  gapsOf,
  gridTemplate,
  HOUR_PX,
  LANE_HEAD_PX,
  PX_PER_MS,
  provisionalThree,
  snapScroll,
  TODAY_LANES,
  visibleDates,
  yOf,
} from "./geometry.ts";
import { InboxTray, useInboxTray } from "./InboxTray.tsx";
import { HoverLinks, hoverWorkItem, OffscreenHint } from "./overlays.tsx";
import { ribbonOf } from "./ribbon.ts";
import {
  GridBackground,
  Gutter,
  initialScroll,
  LaneDivider,
  NowLine,
  scrollStartOf,
  strongRanges,
} from "./TimeGrid.tsx";
import { TotalsItem, useOpenExpired } from "./TotalsItem.tsx";
import {
  readUnscheduledOpen,
  topLimits,
  UNSCHEDULED_MAX,
  writeUnscheduledOpen,
} from "./top-limits.ts";
import { type TotalsKey, type TotalsPart, totalsParts, visibleTotals } from "./totals.ts";
import { expiredShown, expiredTipLines, totalsTip } from "./totals-tip.ts";

/** 今日の列の自分の番の帯は上位 3 件（B-2。デイビューの右の一覧とメニューバーは 5 / 8 のまま） */
const BAND_MAX = 3;

interface Sel {
  date: string;
  key: string | null;
}

export function WeekBoard() {
  const { t, dayLabel, locale } = useI18n();
  const nav = useNavigate();
  const wrap = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  /** ホバー中の AI 項目（待ちと帯の行・応答ブロックの接続線。M2-16） */
  const [hoverWi, setHoverWi] = useState<string | null>(null);
  const [width, setWidth] = useState(1200);
  const [boardHeight, setBoardHeight] = useState(900);
  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setWidth(el.clientWidth);
      setBoardHeight(el.clientHeight);
    });
    ro.observe(el);
    setWidth(el.clientWidth);
    setBoardHeight(el.clientHeight);
    return () => ro.disconnect();
  }, []);
  const anchor = useUi(() => boardNav.anchor());
  const mode = useUi((s) => s.boardMode);
  const weekDates = visibleDates(anchor, width - GUTTER_PX);
  const threeQ = useBoardAround(anchor, mode === "three");
  const weekQ = useBoard(weekDates[0] as string, weekDates.at(-1) as string, mode === "week");
  const board = mode === "three" ? threeQ : weekQ;
  const queue = useQueue();
  const inbox = useInbox();
  const projects = useProjects();
  const data = board.data;
  // 3日ボードの列は応答の日付（前・次の稼働日はデーモンが決める）。応答が来るまでは前日・翌日で仮に描く
  const threeDays =
    mode === "three" && data?.days.length === 3 && data.days[1]?.date === anchor ? data.days : null;
  const dates =
    mode === "three" ? (threeDays?.map((d) => d.date) ?? provisionalThree(anchor)) : weekDates;
  useEffect(() => {
    if (!threeDays) return;
    const [p, a, n] = threeDays.map((d) => d.date) as [string, string, string];
    const cur = getUi().boardNeighbors;
    if (cur?.around !== a || cur.prev !== p || cur.next !== n)
      setUi({ boardNeighbors: { around: a, prev: p, next: n } });
  }, [threeDays]);
  // 週表示の見出しは表示中の日付の範囲（D-101 (3)）
  const rangeFrom = mode === "week" ? (weekDates[0] ?? null) : null;
  const rangeTo = mode === "week" ? (weekDates.at(-1) ?? null) : null;
  useEffect(() => {
    const next = rangeFrom && rangeTo ? { from: rangeFrom, to: rangeTo } : null;
    const cur = getUi().boardRange;
    if (cur?.from !== next?.from || cur?.to !== next?.to) setUi({ boardRange: next });
  }, [rangeFrom, rangeTo]);
  const now = useNow();
  // 表示の今日（暦日。今日の列・`t`・新規作成）と、論理日の今日（儀式・`m` の次の稼働日）。D-054
  const displayToday = useUi((s) => s.serverDisplayToday);
  const logicalToday = data?.today ?? currentToday();
  const today = data?.displayToday ?? displayToday ?? logicalToday;
  useEffect(() => {
    if (data?.today && data.today !== currentToday()) setToday(data.today);
  }, [data?.today]);

  const days = (data?.days ?? []).filter((d) => dates.includes(d.date));
  const todayCol = days.find((d) => d.phase === "today");
  /** 今日の列を 予定 / 自分 / AI の3レーンにするか（3日ボードで基準日が今日のときだけ。D-074） */
  const split = (date: string) => mode === "three" && date === today && dates[1] === date;
  const splitToday = todayCol && split(todayCol.date) ? todayCol : undefined;
  const tz = data?.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  // 自分の番の行（猶予中の問いを末尾に薄く。D-245）
  const band = turnRows(queue.data?.items, queue.data?.grace);
  const projectName = (id: string | null) =>
    id ? (projects.data?.find((p) => p.id === id)?.name ?? null) : null;
  // 狭い幅でパネルを開いたら側の 2 列を 48px の帯に畳み、サイドバーも畳む（B-1 (2)。§8 の仮 5）。
  // 1200 以上でも側の列の計算上の幅が 120px を切るなら帯にする（安全弁）
  const panelOpen = useUi((s) => anyPanelOpen(s) || s.recordOpen);
  const winW = useWindowWidth();
  const narrowPanel = mode === "three" && panelOpen && winW < 1200;
  const sideW = ((width - GUTTER_PX) * 3.6) / 21;
  const autoBands =
    mode === "three" && threeDays && (narrowPanel || (panelOpen && sideW < 120))
      ? threeDays.filter((d) => d.date !== anchor).map((d) => d.date)
      : [];
  const [expanded, setExpanded] = useState<string | null>(null);
  const bands = new Set(autoBands.filter((d) => d !== expanded));
  useEffect(() => {
    if (!panelOpen) setExpanded(null);
  }, [panelOpen]);
  const autoSidebar = useRef(false);
  useEffect(() => {
    if (narrowPanel && !getUi().sidebarCollapsed) {
      setUi({ sidebarCollapsed: true });
      autoSidebar.current = true;
    } else if (!narrowPanel && autoSidebar.current) {
      autoSidebar.current = false;
      setUi({ sidebarCollapsed: false });
    }
  }, [narrowPanel]);

  // 開いたときは計画の目安の開始付近へ、日中は現在線を見える位置に保つ
  const scrolledFor = useRef<string | null>(null);
  useEffect(() => {
    const el = scroller.current;
    const ref = todayCol ?? days[1];
    if (!el || !ref || scrolledFor.current === ref.date) return;
    scrolledFor.current = ref.date;
    const start = scrollStartOf(ref, ref.axis.start + 5 * 3_600_000);
    let top = initialScroll(ref.axis, start);
    if (todayCol) {
      // 現在線が見えなければ（夕方の下端より下、深夜の上端より上。D-054）現在線の付近へ
      const nowY = yOf(now, todayCol.axis.start);
      const below = nowY > top + el.clientHeight - HOUR_PX;
      const above = top > nowY;
      if (below || above) top = snapScroll(Math.max(0, nowY - el.clientHeight / 2));
    }
    el.scrollTop = top;
  }, [todayCol, days, now]);

  // ---------- 選択とキー（M2-7） ----------
  const [sel, setSel] = useState<Sel>({ date: anchor, key: null });
  // 何も選んでいない間は、選択の列を基準日（今日）に合わせる
  useEffect(() => {
    setSel((x) => (x.key ? x : { date: anchor, key: null }));
  }, [anchor]);
  const [multi, setMulti] = useState<string[]>([]);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  /** 範囲選択のポップオーバーを閉じたら、時間軸の仮の範囲を消す */
  const [rangeDone, setRangeDone] = useState(0);
  const tray = useInboxTray();
  const openWith = useOpenWith();
  const layout = useMemo(() => days.map((d) => ({ day: d, ...placementsOf(d) })), [days]);
  // 上部（自分の番・未定）は中でスクロールせず、時間軸に最小 240px を残す分だけ出す（B-2）。未定の「ほか N 件 ▸」で開いた日はブラウザに覚える
  const [unscheduledOpen, setUnscheduledOpen] =
    useState<Record<string, boolean>>(readUnscheduledOpen);
  const limits = topLimits(boardHeight, {
    band: band.length,
    unscheduled: Math.max(0, ...layout.map((l) => l.unscheduled.length)),
  });
  const unscheduledShown = (date: string, n: number) =>
    unscheduledOpen[date] ? n : Math.min(n, limits.unscheduled);
  const columnKeys = (date: string): string[] => {
    const l = layout.find((x) => x.day.date === date);
    if (!l) return [];
    const out: string[] = [];
    if (l.day.phase === "today")
      for (const q of band.slice(0, limits.band)) out.push(`turn:${q.workItemId}`);
    for (const x of l.unscheduled.slice(0, unscheduledShown(l.day.date, l.unscheduled.length)))
      out.push(`task:${x.id}`);
    for (const p of [...l.placed].sort((a, b) => a.at.start - b.at.start))
      out.push(`task:${p.task.id}`);
    if (split(l.day.date)) out.push(...aiKeysOf(l.day, now));
    return out;
  };
  const taskOf = (key: string | null): TaskView | null => {
    if (!key?.startsWith("task:")) return null;
    const id = key.slice(5);
    for (const d of days) {
      const x = d.tasks.find((t) => t.id === id) ?? d.crossTasks.find((t) => t.id === id);
      if (x) return x;
    }
    // 左の Inbox のトレーのタスク（日付なし。ボードの応答の日には無い）。ホバーのボタン・メニュー・キーの対象にする
    return inbox.data?.tasks.find((t) => t.id === id) ?? null;
  };
  const answerOn = useAnswerEnabled();
  const turnOf = (key: string | null): QueueItem | null =>
    key?.startsWith("turn:") ? (band.find((q) => `turn:${q.workItemId}` === key) ?? null) : null;
  const anchorEl = (key: string | null): HTMLElement | null => {
    if (!key) return null;
    const [kind, id] = key.split(":");
    return document.querySelector<HTMLElement>(`[data-kind="${kind}"][data-id="${id}"]`);
  };
  // `c` の作成のポップオーバーの置き場所: その列の「+ 追加」（無ければ時間軸の列）。以前の data-col は作り直しで無くなり、
  // 置き場所が無いままポップオーバーが画面の外に出ていた
  const colEl = (date: string) =>
    document.querySelector<HTMLElement>(`[data-testid="column-add"][data-date="${date}"]`) ??
    document.querySelector<HTMLElement>(`[data-day="${date}"]`);
  const selected = () => (multi.length > 0 ? multi : sel.key ? [sel.key] : []);
  const step = (delta: number, extend = false) => {
    const ks = columnKeys(sel.date);
    if (ks.length === 0) return;
    const i = sel.key ? ks.indexOf(sel.key) : -1;
    const next = ks[Math.max(0, Math.min(ks.length - 1, i < 0 ? 0 : i + delta))] as string;
    if (extend) {
      const base = multi.length > 0 ? multi : sel.key ? [sel.key] : [];
      setMulti([...new Set([...base, next])]);
    }
    setSel({ date: sel.date, key: next });
  };
  const moveCol = (delta: number) => {
    const i = dates.indexOf(sel.date);
    const d = dates[Math.max(0, Math.min(dates.length - 1, (i < 0 ? 1 : i) + delta))] as string;
    // h / l で帯の列に移ったら、その列を広げる（B-1 (2)）
    if (bands.has(d)) setExpanded(d);
    setSel({ date: d, key: columnKeys(d)[0] ?? null });
    setMulti([]);
  };
  const forTasks = (f: (t: TaskView) => void) => {
    for (const k of selected()) {
      const x = taskOf(k);
      if (x) f(x);
    }
  };
  const forTurns = (f: (q: QueueItem) => void) => {
    for (const k of selected()) {
      const q = turnOf(k);
      if (q) f(q);
    }
  };
  useKeys({
    prevDay: () => {
      moveCol(-1);
      return true;
    },
    nextDay: () => {
      moveCol(1);
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
      const tasks = selected()
        .map(taskOf)
        .filter((x): x is TaskView => x !== null);
      if (tasks.length > 0) for (const x of tasks) void moveTask(x, today);
      else {
        boardNav.today();
        setSel({ date: today, key: null });
      }
      return true;
    },
    new: () => {
      setPrompt({ kind: "new", date: sel.date, anchor: colEl(sel.date) });
      return true;
    },
    // 新しい予定（⇧C。入力の時刻で作る。D-093）
    newEvent: () => {
      setPrompt({ kind: "new", date: sel.date, anchor: colEl(sel.date), as: "event" });
      return true;
    },
    rename: () => {
      const x = taskOf(sel.key);
      if (!x) return false;
      setPrompt({
        kind: "rename",
        initial: titleText(x.title, locale),
        anchor: anchorEl(sel.key),
        onSubmit: (v) => void renameTask(x, v),
      });
      return true;
    },
    move: () => {
      // YOUR TURN 帯の自分の番: 明日（次の稼働日）へ移し、その日の計画の目安の開始までスヌーズ（D-052 (1)）
      const turns = selected()
        .map(turnOf)
        .filter((x): x is QueueItem => x !== null);
      if (turns.length > 0) {
        for (const q of turns) {
          const f = primaryFollowUp(q);
          if (f) void deferFollowUp(f.id, nextWeekday(logicalToday));
        }
        setMulti([]);
        return true;
      }
      const tasks = selected()
        .map(taskOf)
        .filter((x): x is TaskView => x !== null);
      if (tasks.length === 0) return false;
      setPrompt({
        kind: "move",
        anchor: anchorEl(sel.key),
        onSubmit: (d) => {
          for (const x of tasks) void moveTask(x, d);
        },
      });
      return true;
    },
    later: () => {
      forTasks((x) => void moveTask(x, addDaysSafe(x.scheduledDate ?? today, 1)));
      return true;
    },
    earlier: () => {
      forTasks((x) => void moveTask(x, addDaysSafe(x.scheduledDate ?? today, -1)));
      return true;
    },
    complete: () => {
      // まとめて1つの知らせと ⌘Z 1回で戻す（D-139 (3)）
      const ts: TaskView[] = [];
      const fs: string[] = [];
      forTasks((x) => ts.push(x));
      forTurns((q) => {
        const f = primaryFollowUp(q);
        if (f) fs.push(f.id);
      });
      void completeItems(ts, fs);
      return true;
    },
    open: () => {
      const q = turnOf(sel.key);
      if (q) {
        const f = primaryFollowUp(q);
        // 猶予中の問い（D-245）は返答タスクが無いので項目の既定の開き先
        void openTask(f ? { followUpId: f.id } : { workItemId: q.workItemId });
        return true;
      }
      // AI カードも外部の既定の開き先（D-067）。詳細パネルは → / ⌘⏎
      if (sel.key?.startsWith("ai:")) {
        void openTask({ workItemId: sel.key.slice(3) });
        return true;
      }
      // 自分のタスクの ⏎ は詳細パネル（D-070）
      if (sel.key?.startsWith("task:")) {
        setUi({ panelTaskId: sel.key.slice(5) });
        return true;
      }
      return false;
    },
    openWith: () => {
      const q = turnOf(sel.key);
      const f = q ? primaryFollowUp(q) : undefined;
      if (f) {
        openWith.show(anchorEl(sel.key), { followUpId: f.id });
        return true;
      }
      if (sel.key?.startsWith("ai:")) {
        openWith.show(anchorEl(sel.key), { workItemId: sel.key.slice(3) });
        return true;
      }
      return false;
    },
    replyTask: () => {
      // AI カードだけ（D-066 (2)）
      if (!sel.key?.startsWith("ai:")) return false;
      void createReplyTask(sel.key.slice(3));
      return true;
    },
    // a: 自分の番の「答える」の節を詳細パネルに開く（D-238）
    answer: () => {
      const q = turnOf(sel.key);
      if (!q || !answerOn || !answerable(q)) return false;
      setUi({ panelWorkItemId: q.workItemId, answerFor: q.workItemId });
      return true;
    },
    detail: () => {
      // 自分のタスクはタスクの詳細パネル（元の AI 項目へはパネルから行く。D-070）
      const task = taskOf(sel.key);
      if (task) {
        setUi({ panelTaskId: task.id });
        return true;
      }
      const id = sel.key?.startsWith("ai:")
        ? sel.key.slice(3)
        : (turnOf(sel.key)?.workItemId ?? null);
      if (!id) return false;
      setUi({ panelWorkItemId: id });
      return true;
    },
    snooze: () => {
      const ids = selected()
        .map(turnOf)
        .map((q) => (q ? primaryFollowUp(q)?.id : undefined))
        .filter((x): x is string => !!x);
      if (ids.length === 0) return false;
      setPrompt({
        kind: "snooze",
        anchor: anchorEl(sel.key),
        onSubmit: (p) => {
          for (const id of ids) void snoozeFollowUp(id, p);
        },
      });
      return true;
    },
    dismiss: () => {
      const ids = selected()
        .map(turnOf)
        .map((q) => (q ? primaryFollowUp(q)?.id : undefined))
        .filter((x): x is string => !!x);
      if (ids.length === 0) return false;
      void dismissFollowUps(ids);
      setMulti([]);
      return true;
    },
    select: () => {
      if (!sel.key) return false;
      const k = sel.key;
      setMulti((m) => (m.includes(k) ? m.filter((x) => x !== k) : [...m, k]));
      return true;
    },
    delete: () => {
      forTasks((x) => void deleteTask(x));
      setMulti([]);
      return true;
    },
    unblock: () => {
      // ⌫: 時間ブロックだけを外す（タスクは残り、Unscheduled に戻る。ux-mvp 7章）
      const tasks = selected()
        .map(taskOf)
        .filter((x): x is TaskView => x !== null)
        .filter((x) => days.some((d) => d.timeBlocks.some((b) => b.taskId === x.id)));
      if (tasks.length === 0) return false;
      for (const x of tasks) void unscheduleTask(x);
      return true;
    },
    escape: () => {
      if (multi.length > 0 || sel.key) {
        setMulti([]);
        setSel({ date: sel.date, key: null });
        return true;
      }
      return false;
    },
  });

  // ⌘K（ux-mvp 6.1）: 選んでいる項目をパレットに渡し、検索結果から来たタスクを選ぶ
  const aiTitle = (id: string): string | null => {
    for (const d of days) {
      const x = d.aiLane?.find((a) => a.id === id);
      if (x) return x.title;
    }
    return null;
  };
  const itemOf = (k: string): SelItem[] => {
    const x = taskOf(k);
    if (x) return [{ kind: "task", task: x }];
    const q = turnOf(k);
    if (q) return [{ kind: "turn", item: q }];
    if (k.startsWith("ai:")) return [{ kind: "ai", id: k.slice(3), title: aiTitle(k.slice(3)) }];
    return [];
  };
  usePublishSelection(selected().flatMap(itemOf));
  useFocusRequest(
    (f) => {
      if (!f.date || !dates.includes(f.date) || !columnKeys(f.date).includes(f.key)) return false;
      setSel({ date: f.date, key: f.key });
      setMulti([]);
      return true;
    },
    [layout, dates],
  );

  const isSel = (k: string) => sel.key === k || multi.includes(k);
  // ---------- マウスの操作（UX 監査 A1〜A3・A14。actions/item-actions.tsx） ----------
  const eventOf = (id: string) => {
    for (const d of days) {
      const e = d.events.find((x) => x.id === id) ?? d.allDayEvents.find((x) => x.id === id);
      if (e) return { date: d.date, e };
    }
    return null;
  };
  /** 項目のある列（予定はその日の列） */
  const dateOfKey = (k: string): string => {
    if (k.startsWith("event:")) return eventOf(k.slice(6))?.date ?? sel.date;
    return dates.find((d) => columnKeys(d).includes(k)) ?? sel.date;
  };
  const host = useItemActionsHost({
    select: (k, how) => {
      const date = dateOfKey(k);
      if (how === "replace") setMulti([]);
      else if (how === "toggle") setMulti(toggleKey(multi, sel.key, k));
      else setMulti(rangeKeys(columnKeys(date), sel.date === date ? sel.key : null, k));
      setSel({ date, key: k });
    },
    inMulti: (k) => multi.includes(k),
    itemsFor: (k) => (multi.includes(k) ? multi.flatMap(itemOf) : itemOf(k)),
    placed: (k) => days.some((d) => d.timeBlocks.some((b) => `task:${b.taskId}` === k)),
    eventOf: (id) => {
      const x = eventOf(id);
      return x ? x.e : null;
    },
  });
  const actions = host.api;
  // パネルを開いている間は選び直した項目のパネルへ（U-07）
  usePanelFollow(sel.key);
  const clickKey = (_date: string, k: string) => actions.click(k);

  if (board.isError && !data)
    return (
      <div className="p-6 text-body text-fg2">
        {t("board.loadFailed")}{" "}
        <button type="button" className="text-accent" onClick={() => void board.refetch()}>
          {t("board.retry")}
        </button>
      </div>
    );

  // 稼働日の間の休み（土日・祝日）は細い区切りの列（確定デザインの3日ボード「土日」）
  const gaps = mode === "three" ? gapsOf(dates) : new Map<string, string[]>();
  const template = gridTemplate(dates, mode, new Set(gaps.keys()), bands);
  /** 帯にした列の各行（見出し以外）: 沈んだ面だけ。落とし先は日付のまま */
  const bandCell = (date: string, row: string) => (
    <DateDrop
      key={`${row}:${date}`}
      id={`${row}:${date}`}
      date={date}
      className="border-line border-t border-r bg-sunken"
    />
  );
  const gapCell = (date: string, row: string, label = false) => {
    const skipped = gaps.get(date);
    if (!skipped) return null;
    return (
      <div
        key={`gap-${row}-${date}`}
        className="flex flex-col items-center gap-0.5 border-line border-r bg-sunken pt-3 text-fg2 text-micro"
        data-gap={date}
        title={
          label
            ? skipped.map((d) => `${dayLabel(d).weekday} ${dayLabel(d).date}`).join(" · ")
            : undefined
        }
      >
        {label ? skipped.map((d) => <span key={d}>{dayLabel(d).weekday}</span>) : null}
      </div>
    );
  };
  return (
    <ItemActionsProvider value={actions}>
      <BoardDnd today={logicalToday}>
        <div className="relative flex h-full min-w-0">
          <InboxTray open={tray.open} onClose={() => tray.set(false)} today={logicalToday} />
          <div
            ref={wrap}
            className="flex h-full min-w-0 flex-1 flex-col"
            data-testid="week-board"
            onPointerOver={(e) => {
              const wi = hoverWorkItem(e.target as Element, days);
              if (wi !== hoverWi) setHoverWi(wi);
            }}
            onPointerLeave={() => setHoverWi(null)}
          >
            {/* ヘッダ・終日・上部エリア（スクロールしない） */}
            <div
              className="grid shrink-0 border-line border-b"
              style={{ gridTemplateColumns: template }}
            >
              <div className="flex items-start justify-center border-line border-r pt-2">
                {tray.open ? null : tray.toggle}
              </div>
              {dates.map((date, i) => {
                const d = days.find((x) => x.date === date);
                const phase = date < today ? "past" : date === today ? "today" : "future";
                const { weekday, date: md } = dayLabel(date);
                const rel =
                  phase === "today"
                    ? null
                    : date === addDaysSafe(today, -1)
                      ? t("dayDivider.yesterday")
                      : mode === "three" && i === 2 && dates[1] === today
                        ? t("dayDivider.nextWorkday")
                        : null;
                if (bands.has(date))
                  return [
                    gapCell(date, "head", true),
                    <DayBand
                      key={date}
                      date={date}
                      day={d}
                      rel={rel}
                      unscheduled={layout.find((x) => x.day.date === date)?.unscheduled.length ?? 0}
                      onExpand={() => setExpanded(date)}
                    />,
                  ];
                return [
                  gapCell(date, "head", true),
                  <DateDrop
                    key={date}
                    id={`head:${date}`}
                    date={date}
                    // 狭い前後の列（3日ボードの前の日は約17%）で日付が隣の列にはみ出さないよう切る。今日の列は今のまま
                    className={`flex min-h-16 min-w-0 items-start gap-2 border-line border-r px-3 pt-2.5 pb-2 ${phase === "today" ? "" : "overflow-hidden"}`}
                  >
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      {/* 列ヘッダの日付からその日のデイビューを開く（M2-19） */}
                      <button
                        type="button"
                        tabIndex={-1}
                        title={t("day.openDay")}
                        data-open-day={date}
                        onClick={() => {
                          dayNav.set(date);
                          void nav({ to: "/day" });
                        }}
                        className="flex min-w-0 items-center gap-2 text-left hover:underline"
                      >
                        {/* 今日以外（昨日・次の稼働日）の日付は text-secondary で今日より目立たせない（確定画像。D-117） */}
                        <span
                          className={`shrink-0 whitespace-nowrap font-semibold text-section ${phase === "today" ? "text-fg" : "text-fg2"}`}
                          data-day-title={phase}
                        >
                          {weekday} {md}
                        </span>
                        {phase === "today" ? (
                          <span className="shrink-0 rounded-control bg-fg px-1.5 font-semibold text-bg text-meta">
                            {t("dayDivider.today")}
                          </span>
                        ) : rel ? (
                          <span className="min-w-0 truncate text-fg2 text-meta">{rel}</span>
                        ) : null}
                      </button>
                      {split(date) ? null : (
                        <TotalsLine day={d} withAi={phase === "today" && !split(date)} />
                      )}
                    </div>
                    {split(date) ? <TodayFigure day={d} /> : null}
                    {/* 帯から広げた列の「畳む」（B-1 (2)） */}
                    {expanded === date && autoBands.includes(date) ? (
                      <button
                        type="button"
                        onClick={() => setExpanded(null)}
                        className="shrink-0 rounded-control text-fg3 hover:bg-sunken hover:text-fg"
                        title={t("board.collapseDay")}
                        aria-label={t("board.collapseDay")}
                        data-testid="collapse-day"
                      >
                        <ChevronLeft size={16} strokeWidth={1.5} aria-hidden="true" />
                      </button>
                    ) : null}
                  </DateDrop>,
                ];
              })}
              {/* 終日の行は終日の予定がある日だけ（確定デザインに空の行は無い。D-114） */}
              {days.some((x) => dates.includes(x.date) && x.allDayEvents.length > 0) ? (
                <>
                  <div className="border-line border-t border-r" />
                  {dates.map((date) => {
                    const d = days.find((x) => x.date === date);
                    if (bands.has(date)) return [gapCell(date, "allday"), bandCell(date, "allday")];
                    return [
                      gapCell(date, "allday"),
                      <DateDrop
                        key={date}
                        id={`allday:${date}`}
                        date={date}
                        className="flex min-w-0 flex-col gap-0.5 border-line border-t border-r px-2 py-0.5"
                        style={{ minHeight: 24 }}
                      >
                        {(d?.allDayEvents ?? []).map((e) => (
                          <AllDayChip key={e.id} e={e} />
                        ))}
                      </DateDrop>,
                    ];
                  })}
                </>
              ) : null}
              <div className="border-line border-t border-r" />
              {dates.map((date) => {
                const l = layout.find((x) => x.day.date === date);
                const isToday = date === today;
                if (bands.has(date)) return [gapCell(date, "top"), bandCell(date, "top")];
                return [
                  gapCell(date, "top"),
                  <DateDrop
                    key={date}
                    id={`top:${date}`}
                    date={date}
                    // 上部（自分の番・未定）は中身の高さどおり（中でスクロールしない。B-2）。出す件数は topLimits が決める
                    className="flex min-w-0 flex-col gap-3 border-line border-t border-r px-3 py-3"
                  >
                    {/* 今日の列の先頭行: 拡張の知らせ（todayNotices。D-192・ADR 0015）。公開のビルドでは何も出ない */}
                    {isToday ? <TodayNotices /> : null}
                    {isToday ? (
                      <YourTurnBand
                        band={band}
                        max={limits.band}
                        blocks={days.flatMap((x) => x.timeBlocks)}
                        queue={queue.data}
                        now={now}
                        tz={tz}
                        isSel={isSel}
                        onPick={(k) => clickKey(date, k)}
                        onMore={() => {
                          // 画面を移るときはボードの詳細パネルを閉じる（キューの詳細と 2 枚にしない。D-214 の §4）。
                          // キューは帯に出しきれなかった最初の件を選んで開く
                          setUi({ panelWorkItemId: null, panelTaskId: null, panelEventId: null });
                          const next = band[limits.band];
                          void nav({
                            to: "/queue",
                            ...(next ? { search: { item: next.workItemId } } : {}),
                          });
                        }}
                      />
                    ) : null}
                    <Unscheduled
                      date={date}
                      tasks={l?.unscheduled ?? []}
                      shown={unscheduledShown(date, l?.unscheduled.length ?? 0)}
                      onToggleMore={() =>
                        setUnscheduledOpen((o) => {
                          const next = { ...o, [date]: !o[date] };
                          writeUnscheduledOpen(next);
                          return next;
                        })
                      }
                      carry={l?.day.carry ?? null}
                      onCarry={(older) => void carryDay(date, { older })}
                      isSel={isSel}
                      onPick={(k) => clickKey(date, k)}
                      onAdd={(el) => setPrompt({ kind: "new", date, anchor: el })}
                      projectName={projectName}
                      showEmptyHint={isToday && (l?.day.tasks.length ?? 0) === 0}
                    />
                  </DateDrop>,
                ];
              })}
              {/* 今日の列のレーンの見出し「予定 · 自分」「AI」（D-117 で2レーンに戻した。text-tertiary の小さな文字） */}
              {splitToday ? (
                <>
                  <div className="border-line border-t border-r" />
                  {dates.map((date) => [
                    gapCell(date, "lanes"),
                    <div
                      key={date}
                      className={`relative min-w-0 border-line border-t border-r text-fg3 text-micro ${bands.has(date) ? "bg-sunken" : ""}`}
                      style={{ height: LANE_HEAD_PX }}
                      data-lanes={split(date) ? date : undefined}
                    >
                      {split(date)
                        ? (["plan", "ai"] as const).map((k) => (
                            <span
                              key={k}
                              className="absolute top-1 truncate px-2"
                              style={{
                                left: `${TODAY_LANES[k].left}%`,
                                width: `${TODAY_LANES[k].width}%`,
                              }}
                            >
                              {k === "plan" ? t("board.lane.plan") : t("day.lane.ai")}
                            </span>
                          ))
                        : null}
                    </div>,
                  ])}
                </>
              ) : null}
            </div>
            {/* 24時間の時間軸 */}
            <div ref={frame} className="relative flex min-h-0 flex-1 flex-col">
              <OffscreenHint day={splitToday} now={now} scroller={scroller} frame={frame} />
              {/* 凡例（UX 監査 A9） */}
              <LegendButton className="absolute right-4 bottom-3" />
              <div
                ref={scroller}
                className="min-h-0 flex-1 overflow-y-auto"
                data-testid="board-scroll"
              >
                <div className="grid" style={{ gridTemplateColumns: template }}>
                  <div className="border-line border-r">
                    {(todayCol ?? days[0]) ? (
                      <Gutter
                        axis={(todayCol ?? (days[0] as DayColumn)).axis}
                        tz={tz}
                        now={now}
                        showNow={todayCol !== undefined}
                        strong={strongRanges((todayCol ?? (days[0] as DayColumn)).axis, days)}
                      />
                    ) : null}
                  </div>
                  {dates.map((date) => {
                    const l = layout.find((x) => x.day.date === date);
                    if (!l || bands.has(date))
                      return [
                        gapCell(date, "grid"),
                        <DateDrop
                          key={date}
                          id={`grid:${date}`}
                          date={date}
                          className={`border-line border-r ${bands.has(date) ? "bg-sunken" : ""}`}
                          style={{ height: 24 * HOUR_PX }}
                        />,
                      ];
                    return [
                      gapCell(date, "grid"),
                      <DayGrid
                        key={date}
                        day={l.day}
                        placed={l.placed}
                        replies={l.replies}
                        split={split(date)}
                        onOpenDay={() => {
                          dayNav.set(date);
                          void nav({ to: "/day" });
                        }}
                        now={now}
                        tz={tz}
                        isSel={isSel}
                        onPick={(k) => clickKey(date, k)}
                        projectName={projectName}
                        rangeDone={rangeDone}
                        onRange={(range, el, as) =>
                          // 空き枠のクリック・ドラッグの入力欄は「タスク / 予定」を切り替えられる（既定はタスク。D-093・D-101 (2)）
                          setPrompt({
                            kind: "new",
                            date,
                            anchor: el,
                            range,
                            switchable: true,
                            ...(as ? { as } : {}),
                          })
                        }
                      />,
                    ];
                  })}
                </div>
              </div>
            </div>
            <HoverLinks workItemId={hoverWi} day={splitToday} scroller={scroller} />
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
                onCreate={(raw, date, extra) => {
                  if (prompt.kind === "new" && prompt.range && date)
                    return createTaskWithBlock({ raw, date, range: prompt.range });
                  else
                    return createTask({
                      raw,
                      date: extra.date ?? date,
                      ...(extra.estimateMin !== undefined
                        ? { estimateMin: extra.estimateMin }
                        : {}),
                    });
                }}
              />
            ) : null}
          </div>
        </div>
      </BoardDnd>
    </ItemActionsProvider>
  );
}

/**
 * 文字が要素の幅からはみ出しているか。scrollWidth は整数に丸められ、1px 未満のはみ出し（それでも末尾が「…」になる）を
 * 見逃すので、文字の実際の幅で比べる
 */
function overflows(el: HTMLElement): boolean {
  if (el.scrollWidth > el.clientWidth) return true;
  const r = document.createRange();
  r.selectNodeContents(el);
  return r.getBoundingClientRect().width > el.getBoundingClientRect().width + 0.01;
}

/** ヘッダの集計の1行（W6）。項目と省く順は totals.ts */
function TotalsLine({
  day: raw,
  withAi = false,
  align = "start",
  omit,
}: {
  day: DayColumn | undefined;
  withAi?: boolean;
  align?: "start" | "end";
  /** 出さない項目（今日の列の「空き」は大きな数字で出すので省く）。集計は本物の値のまま（計画が空きを超えたかの判定を変えない） */
  omit?: TotalsKey;
}) {
  const { t, locale } = useI18n();
  // ドラッグ中はドロップ後の値（ux-mvp 7章）
  const dnd = useBoardDnd();
  const day = raw && dnd ? { ...raw, totals: dnd.totalsOf(raw) } : raw;
  const ref = useRef<HTMLDivElement>(null);
  // 省いた数は集計の文字列ごとに持つ（文字列が変わったら 0 から数え直す。ドラッグ中は毎回変わる）
  const [fit, setFit] = useState<{ key: string; n: number }>({ key: "", n: 0 });
  const [, setRefit] = useState(0);
  // 集計の種類は論理日の区分で決める（深夜の昨日の列は、まだ閉じていない今日の集計。D-054）
  const parts = day
    ? totalsParts({ phase: day.logicalPhase, totals: day.totals }, t, withAi).filter(
        (p) => !omit || p.key !== omit,
      )
    : [];
  const key = parts.map((p) => p.text).join("|");
  const maxDrop = parts.reduce((a, p) => (p.drop === null ? a : Math.max(a, p.drop + 1)), 0);
  // 集計か幅が変わったら全部出し直し、はみ出す間は低い順に1つずつ省く
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // 出し直し: 省いた数を戻し、はみ出しの検査（下の effect）を走らせるために必ず描き直す
    const refit = () => {
      setFit({ key: "", n: 0 });
      setRefit((x) => x + 1);
    };
    let w = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth !== w) {
        w = el.clientWidth;
        refit();
      }
    });
    ro.observe(el);
    // Web フォントが後から読み込まれると幅は同じまま文字だけ広がるので、そのときも出し直す
    const fonts = document.fonts;
    fonts?.addEventListener("loadingdone", refit);
    void fonts?.ready.then(refit);
    return () => {
      ro.disconnect();
      fonts?.removeEventListener("loadingdone", refit);
    };
  }, []);
  const dropped = fit.key === key ? fit.n : 0;
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && overflows(el) && dropped < maxDrop) setFit({ key, n: dropped + 1 });
  });
  const shown = visibleTotals(parts, dropped);
  // 期限切れの内訳（R79）: 今の論理日の列だけ（閉じた行は今日の分しか持たない。過去の日の集計に期限切れは出さない）
  const queue = useQueue();
  const openExpired = useOpenExpired();
  const expiredRows =
    day?.logicalPhase === "today" && day.totals.expired > 0 && queue.data
      ? expiredShown(queue.data.closedRows)
      : [];
  const subjects = useClosedSubjects(expiredRows);
  const expiredLines =
    expiredRows.length > 0 && queue.data
      ? expiredTipLines(queue.data.closedRows, {
          subject: (r) => subjects.get(r.followUpId) ?? closedFallback(r, locale),
          tz: queue.data.tz,
          more: (count) => t("totals.tipMore", { count }),
        })
      : [];
  const tipOf = (p: TotalsPart): string | undefined => {
    if (!p.key) return undefined;
    const def = t(`${p.key}.def` as MessageKey);
    if (p.over) return totalsTip(def, [t("totals.over", { time: fmtDuration(p.over) })]);
    if (p.key === "totals.expired") return totalsTip(def, expiredLines);
    return def;
  };
  return (
    <div
      ref={ref}
      className={`truncate whitespace-pre text-fg2 text-meta ${align === "end" ? "text-right" : ""}`}
      data-testid="totals"
      title={shown.length < parts.length ? parts.map((p) => p.text).join(" · ") : undefined}
    >
      {shown.length === 0
        ? " "
        : shown.map((p, i) => (
            <span key={p.text}>
              {i > 0 ? " · " : ""}
              {/* 項目ごとにホバーで定義（点線の下線。確定デザイン）。計画が空きを超えたら数字だけ琥珀の文字と三角（D-192 §2.3）。
                  期限切れは件名と閉じた時刻の内訳を足し、押すとデイビューの「今日閉じた」の期限切れの行へ（R79） */}
              <TotalsItem
                name={p.text}
                tip={tipOf(p)}
                focusable={p.key === "totals.expired"}
                onClick={
                  p.key === "totals.expired" && day ? () => openExpired(day.date) : undefined
                }
                data-totals={p.key}
                data-over={p.over ? "1" : undefined}
              >
                {/* 等幅は長さだけ（「計画」などの言葉は sans。D-114） */}
                {p.over && p.label && p.value ? (
                  <>
                    {p.label}{" "}
                    <span
                      className="inline-flex items-center gap-0.5 font-semibold text-needs"
                      data-testid="totals-over"
                    >
                      <Triangle size={12} strokeWidth={1.5} aria-hidden="true" />
                      <Nums text={p.value} />
                    </span>
                  </>
                ) : (
                  <Nums text={p.text} />
                )}
              </TotalsItem>
            </span>
          ))}
    </div>
  );
}

/**
 * 今日の列の見出しの右（確定デザイン）: 大きな数字は1つだけ（「空き 7h15m」）、残り（予定 · 計画 · 放置）は下に小さく。
 * 0 の項目は出さない
 */
function TodayFigure({ day: raw }: { day: DayColumn | undefined }) {
  const { t } = useI18n();
  const dnd = useBoardDnd();
  const day = raw && dnd ? { ...raw, totals: dnd.totalsOf(raw) } : raw;
  if (!day) return null;
  const parts = totalsParts({ phase: day.logicalPhase, totals: day.totals }, t);
  const free = parts.find((p) => p.key === "totals.free");
  return (
    <div
      className="flex min-w-0 shrink flex-col items-end gap-1 overflow-hidden"
      data-testid="today-figure"
    >
      {free ? (
        <span className="flex items-baseline gap-1.5" title={t("totals.free.def")}>
          <span className="text-fg2 text-meta">{free.label}</span>
          <span className="font-mono font-semibold text-fg text-title leading-6">{free.value}</span>
        </span>
      ) : null}
      <TotalsLine day={raw} align="end" omit="totals.free" />
    </div>
  );
}

/**
 * 側の列を畳んだ 48px の帯（B-1 (2)。D-193）: 曜日・日付・未定の件数だけ。全体がボタンで、押すとその列だけ広げる。
 * ホバーで見出しの集計を 1 行に。カードは描かない（帯は見出しだけ）。落とし先は日付のまま（DateDrop）
 */
function DayBand({
  date,
  day,
  rel,
  unscheduled,
  onExpand,
}: {
  date: string;
  day: DayColumn | undefined;
  rel: string | null;
  unscheduled: number;
  onExpand: () => void;
}) {
  const { t, dayLabel } = useI18n();
  const { weekday, date: md } = dayLabel(date);
  const parts = day
    ? totalsParts({ phase: day.logicalPhase, totals: day.totals }, t).map((p) => p.text)
    : [];
  const tip = [
    `${weekday} ${md}`,
    rel,
    ...parts,
    unscheduled > 0 ? `${t("board.unscheduled")} ${unscheduled}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <DateDrop
      id={`head:${date}`}
      date={date}
      className="flex min-w-0 flex-col items-center border-line border-r bg-sunken pt-2.5"
    >
      <button
        type="button"
        tabIndex={-1}
        onClick={onExpand}
        title={`${tip} · ${t("board.expandDay")}`}
        className="flex w-full flex-col items-center gap-0.5 text-fg2 hover:text-fg"
        data-testid="day-band"
        data-date={date}
      >
        <span className="text-fg3 text-micro">{weekday}</span>
        <span className="font-mono text-meta">{md}</span>
        {unscheduled > 0 ? (
          <span className="mt-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-fg px-1 font-semibold text-[10px] text-bg">
            {unscheduled}
          </span>
        ) : null}
      </button>
    </DateDrop>
  );
}

/** 今日の列の先頭行の知らせ（拡張の todayNotices。ADR 0015） */
export function TodayNotices() {
  return (
    <>
      {ext.todayNotices.map((x) => (
        <x.component key={x.key} />
      ))}
    </>
  );
}

function YourTurnBand({
  band,
  max,
  queue,
  now,
  tz,
  isSel,
  onPick,
  onMore,
  blocks,
}: {
  band: QueueItem[];
  /** 出す行数（上位 N 件。時間軸に最小の高さを残すために減ることがある。B-2） */
  max: number;
  /** 時間ブロック（自分の番を時間に置いた時刻 `@15:00` と、ドラッグで移すときの元のブロック） */
  blocks: TimeBlockView[];
  queue: QueueResponse | undefined;
  now: number;
  tz: string;
  isSel: (k: string) => boolean;
  onPick: (k: string) => void;
  onMore: () => void;
}) {
  const { t } = useI18n();
  const shown = band.slice(0, max);
  // 見出しの数は猶予中を含めない（D-245）
  const count = countedTurns(band);
  // 今日閉じたもの（返答済み・解決済み）は `✓ N closed ▸` の1行に畳む（D-074）
  const closed = (queue?.closedRows ?? []).filter(
    (r) => r.kind === "replied" || r.kind === "resolved",
  );
  // 離れていた間のまとめ（D-214 (2)）: 見出し「自分の番 N」の右（入らなければ下の行）。開いた一覧は見出しの下
  const away = useAwayDigest();
  const awayShown = away !== null && now < away.until;
  if (band.length === 0 && closed.length === 0 && !awayShown) return null;
  const awayLine = (
    <AwayLine
      digest={away}
      tz={tz}
      now={now}
      variant="band"
      onOpen={(x, d) => {
        void dismissAway(d.key);
        if (x.followUpId) void openTask({ followUpId: x.followUpId });
        else setUi({ panelWorkItemId: x.workItemId, panelTaskId: null, panelEventId: null });
      }}
    />
  );
  return (
    <section aria-label={t("board.needsYou")} className="flex flex-col gap-1">
      {/* 「対応待ち 3」（確定デザイン: 今日の列の一番上。ブロック中の行だけ琥珀の面）。0 件なら見出しは出さない（B-2・B-8） */}
      {band.length > 0 ? (
        <div className="mb-1 flex min-w-0 flex-wrap items-start gap-x-3 gap-y-0.5">
          <h2 className="flex h-6 shrink-0 items-center gap-2 px-0.5 font-semibold text-fg text-section">
            {t("board.needsYou")}
            {count > 0 ? (
              <span className="rounded-full bg-sunken px-1.5 font-medium text-fg2 text-meta">
                {count}
              </span>
            ) : null}
          </h2>
          {awayShown ? <div className="min-w-[240px] flex-1">{awayLine}</div> : null}
        </div>
      ) : awayShown ? (
        <div className="mb-1">{awayLine}</div>
      ) : null}
      {shown.map((q) => (
        <TurnDrag key={q.workItemId} item={q} blocks={blocks} tz={tz}>
          {(at) => (
            <TurnRow
              item={q}
              now={now}
              tz={tz}
              scheduledAt={at}
              selected={isSel(`turn:${q.workItemId}`)}
              onClick={() => onPick(`turn:${q.workItemId}`)}
              onOpen={() => {
                const f = primaryFollowUp(q);
                void openTask(f ? { followUpId: f.id } : { workItemId: q.workItemId });
              }}
            />
          )}
        </TurnDrag>
      ))}
      {band.length > max ? (
        <button
          type="button"
          onClick={onMore}
          className="px-1 text-left text-fg2 text-meta hover:text-fg"
          data-testid="band-more"
        >
          {t("board.moreRows", { count: band.length - max })}
        </button>
      ) : null}
      <ClosedFold count={closed.length}>
        <div className="flex flex-col">
          {closed.map((r) => (
            <ClosedTurnRow key={r.followUpId} row={r} tz={tz} />
          ))}
        </div>
      </ClosedFold>
    </section>
  );
}

function Unscheduled({
  date,
  tasks,
  shown,
  onToggleMore,
  carry,
  onCarry,
  isSel,
  onPick,
  onAdd,
  projectName,
  showEmptyHint,
}: {
  date: string;
  tasks: TaskView[];
  /** 出す件数（先頭 N 件。「ほか N 件 ▸」で全件。B-2） */
  shown: number;
  onToggleMore: () => void;
  /** 過去の日の「残り N 件を今日へ」（D-192 §2.2）。無ければ出さない */
  carry: { count: number; older: number } | null;
  onCarry: (older: boolean) => void;
  isSel: (k: string) => boolean;
  onPick: (k: string) => void;
  /** 末尾の「+ 追加」（無ければ出さない。朝の計画の今日の列） */
  onAdd?: ((el: HTMLElement) => void) | undefined;
  projectName: (id: string | null) => string | null;
  showEmptyHint: boolean;
}) {
  const { t, dayLabel } = useI18n();
  const ids = tasks.map((x) => x.id);
  const total = carry ? carry.count + carry.older : 0;
  // 「残り N 件を今日へ」（過去の日の列の見出しの右端。0 なら出さない。B-8）。それより前の日付の残りも含める（§8 の仮 3）
  const carryButton =
    carry && total > 0 ? (
      <button
        type="button"
        onClick={() => onCarry(carry.older > 0)}
        className="shrink-0 rounded-control px-1 text-fg2 text-meta hover:underline"
        title={
          carry.older > 0
            ? `${t("board.carryToday.def")}\n${t("board.carryToday.older", {
                count: carry.older,
                date: `${dayLabel(date).weekday} ${dayLabel(date).date}`,
              })}`
            : t("board.carryToday.def")
        }
        data-testid="carry-today"
        data-date={date}
      >
        {t("board.carryToday", { count: total })}
      </button>
    ) : null;
  // 列の末尾に常に「+ 追加」（ホバーだけにしない。UX 監査 A5・U-03）。空の列は高さ 20px のまま（W3）
  const add = onAdd ? (
    <button
      type="button"
      onClick={(e) => onAdd(e.currentTarget)}
      className="flex h-7 items-center gap-1.5 self-start rounded-control px-1.5 text-left text-body text-fg2 hover:bg-sunken hover:text-fg"
      title={showEmptyHint ? t("board.emptyToday") : t("keys.new")}
      data-testid="column-add"
      data-date={date}
    >
      <Plus size={16} strokeWidth={1.5} aria-hidden="true" />
      {t("board.addShort")}
    </button>
  ) : null;
  // 見出し「未定 3」（件数は全件）。右端に「残り N 件を今日へ」。1 行に入らなければボタンが下の行に折り返す（見出しは折り返さない）
  const head = (
    <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5">
      <h2 className="flex shrink-0 items-center gap-1.5 px-0.5 font-semibold text-fg2 text-meta">
        {t("board.unscheduled")}
        {tasks.length > 0 ? <span className="font-mono font-medium">{tasks.length}</span> : null}
      </h2>
      {carryButton}
    </div>
  );
  if (tasks.length === 0)
    return (
      <section className="flex flex-col gap-1.5">
        {head}
        {add}
      </section>
    );
  const hidden = tasks.length - shown;
  // 「ほか N 件 ▸」はその場で全件に開く（もう一度押すと戻る。B-2）
  const more =
    hidden > 0 || shown > Math.min(tasks.length, UNSCHEDULED_MAX) ? (
      <button
        type="button"
        onClick={onToggleMore}
        className="h-7 shrink-0 rounded-control px-1.5 text-left text-fg2 text-meta hover:bg-sunken hover:text-fg"
        data-testid="unscheduled-more"
        data-date={date}
      >
        {hidden > 0 ? t("board.moreRows", { count: hidden }) : t("board.unscheduled.less")}
      </button>
    ) : null;
  // 確定デザイン: カードと「+ 追加」を横に並べ、幅が足りなければ折り返す（今日の列の未定は1行。D-114）
  return (
    <section className="flex flex-col gap-1.5">
      {head}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5" data-testid="unscheduled-row">
        {tasks.slice(0, shown).map((x) => (
          <CardDrop key={x.id} date={date} taskId={x.id} ids={ids} className="w-full max-w-[340px]">
            <DraggableTask task={x}>
              <TaskCard
                task={x}
                selected={isSel(`task:${x.id}`)}
                project={projectName(x.projectId)}
                onClick={() => onPick(`task:${x.id}`)}
                onToggle={() => void setComplete(x, x.status !== "done")}
              />
            </DraggableTask>
          </CardDrop>
        ))}
        {more}
        {add}
      </div>
    </section>
  );
}

function DayGrid({
  day,
  placed,
  replies,
  split,
  onOpenDay,
  now,
  tz,
  isSel,
  onPick,
  projectName,
  rangeDone,
  onRange,
}: {
  day: DayColumn;
  placed: Placement[];
  /** 自分の番への対応（3日ボードの今日の列では AI レーンの印。他の列には描かない。D-074） */
  replies: Placement[];
  /** Plan（予定・自分）/ AI の2レーン（3日ボードの今日の列。D-075）。false は Plan の1レーン＋右端の稼働リボン */
  split: boolean;
  /** 稼働リボンのクリック: その日のデイビューを開く */
  onOpenDay: () => void;
  now: number;
  tz: string;
  isSel: (k: string) => boolean;
  onPick: (k: string) => void;
  projectName: (id: string | null) => string | null;
  /** 範囲選択のポップオーバーを閉じた回数（変わったら仮の範囲を消す） */
  rangeDone: number;
  onRange: (range: { start: number; end: number }, el: HTMLElement, as?: "task" | "event") => void;
}) {
  const { t } = useI18n();
  const actions = useItemActions();
  const axis = day.axis;
  const height = yOf(axis.end, axis.start);
  const isToday = day.phase === "today";
  const dnd = useBoardDnd();
  const drop = useGridDrop(day);
  const select = useRangeSelect(day, onRange);
  const clearRange = select.clear;
  // 空き枠の右クリック: ここにタスク / 予定を作る・集中モード（UX 監査 A1）
  const onSlotMenu = (e: React.MouseEvent<HTMLElement>) => {
    if ((e.target as HTMLElement).closest("[data-kind],[data-drag],button")) return;
    const slot = select.slotAt(e.clientY);
    if (!slot || !actions) return;
    e.preventDefault();
    const el = e.target as HTMLElement;
    actions.openMenu(
      e.clientX,
      e.clientY,
      slotMenu(t, (as) => select.openAt(slot, el, as)),
    );
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: ポップオーバーを閉じたら消す
  useEffect(() => clearRange(), [rangeDone]);
  const preview = dnd?.preview?.date === day.date ? dnd.preview : null;
  const ghost: GridPreview | null = isDropGhost(preview)
    ? preview
    : select.range
      ? {
          date: day.date,
          range: select.range,
          overlap: day.events.some(
            (e) =>
              e.busy && e.end > (select.range?.start ?? 0) && e.start < (select.range?.end ?? 0),
          ),
          taskId: null,
        }
      : null;
  const L = TODAY_LANES;
  const resize = preview && !isDropGhost(preview) ? preview : null;
  // 今日の列（3日ボード）も他の列も、予定と自分のタスクを1つのレーンに（W5 の入れ子）。今日の列だけ右に AI のレーン
  // （D-117 で D-075 の2レーンに戻した）。空き枠のクリック・ドロップは予定と自分のレーンで受ける
  return (
    <div className="relative min-w-0 border-line border-r" style={{ height }} data-day={day.date}>
      <GridBackground axis={axis} />
      {/* biome-ignore lint/a11y/noStaticElementInteractions: 空き枠の右クリック（キーボードは c / ⇧C） */}
      <div
        ref={drop.setNodeRef}
        data-grid={day.date}
        onPointerDown={select.onPointerDown}
        onContextMenu={onSlotMenu}
        className={`absolute inset-y-0 left-0 ${split ? "" : "right-0"}`}
        style={split ? { width: `${L.plan.width}%` } : undefined}
        data-lane="plan"
      >
        <MeLane
          day={day}
          placed={placed}
          tz={tz}
          isSel={isSel}
          onPick={onPick}
          projectName={projectName}
          resize={resize}
        />
        {ghost ? <DropGhost day={day} ghost={ghost} tz={tz} /> : null}
      </div>
      {/* レーンの間の細い区切り（D-117） */}
      {split ? <LaneDivider left={L.ai.left} /> : null}
      {!split && day.phase !== "future" ? (
        <AiRibbon day={day} now={now} tz={tz} onOpenDay={onOpenDay} />
      ) : null}
      {split ? (
        <div
          className="absolute inset-y-0 right-0"
          style={{ left: `${L.ai.left}%` }}
          data-lane="ai"
        >
          <ImportEmptyState empty={day.phase === "today" && (day.aiLane ?? []).length === 0} />
          {/* 取り込み元があるのに今日の実行が 0 件のときの 1 行（B-10）。計画の目安の開始の高さに置く */}
          <AiLaneEmpty
            empty={day.phase === "today" && (day.aiLane ?? []).length === 0}
            top={yOf(day.plannedHours?.start ?? axis.start + 9 * 3_600_000, axis.start) + 4}
          />
          <AiLane day={day} now={now} tz={tz} isSel={isSel} onPick={onPick} replies={replies} />
        </div>
      ) : null}
      {isToday ? <NowLine axis={axis} now={now} /> : null}
    </div>
  );
}

/**
 * AI 稼働リボン（時間軸の右端の内側 3px・灰。稼働区間の和集合。ux-mvp 4.4、M2-16、D-074、D-114）。過去の日と、AI レーンを持たない今日の列。
 * ホバーで `AI 10:02–10:40`、クリックでその日のデイビュー（当たりは幅 8px）
 */
function AiRibbon({
  day,
  now,
  tz,
  onOpenDay,
}: {
  day: DayColumn;
  now: number;
  tz: string;
  onOpenDay: () => void;
}) {
  const { t } = useI18n();
  return (
    <>
      {ribbonOf(day, now).map((r) => {
        const c = clip(r, day.axis);
        if (!c) return null;
        return (
          <button
            key={r.start}
            type="button"
            tabIndex={-1}
            onClick={onOpenDay}
            className="group absolute right-1 z-[2] flex w-1.5 cursor-pointer justify-end"
            style={{
              top: yOf(c.start, day.axis.start),
              height: Math.max(2, yOf(c.end, c.start)),
            }}
            title={`${t("board.ribbon", { range: `${fmtClock(r.start, tz)}–${fmtClock(r.end, tz)}` })} · ${t("day.openDay")}`}
            data-testid="ai-ribbon"
          >
            {/* 前後の日の AI は終わった作業なので灰（確定デザインの前日の AI の線の色）。列の境目から離す（D-114） */}
            <span className="h-full w-[3px] rounded-full bg-done opacity-70 group-hover:opacity-100" />
          </button>
        );
      })}
    </>
  );
}

/**
 * 時間軸の仮置き（ドラッグ中・範囲選択中）: 破線の枠と、開始・終了の時刻（ux-mvp 7章）。予定と重なる位置は斜線（色は付けない）
 */
function DropGhost({ day, ghost, tz }: { day: DayColumn; ghost: GridPreview; tz: string }) {
  const top = yOf(ghost.range.start, day.axis.start);
  const h = Math.max(ME_MIN_PX, yOf(ghost.range.end, ghost.range.start));
  return (
    <div
      className={`pointer-events-none absolute right-1 left-1 z-30 rounded-card border border-accent border-dashed bg-accent/10 ${
        ghost.overlap ? "dl-hatch" : ""
      }`}
      style={{ top, height: h }}
      data-range-ghost={day.date}
      data-testid="drop-ghost"
    >
      <span className="absolute top-0.5 right-1 rounded-chip bg-bg px-1 font-mono text-meta text-fg">
        {fmtClock(ghost.range.start, tz)}–{fmtClock(ghost.range.end, tz)}
      </span>
    </div>
  );
}

/** 自分レーンの寸法（W4・W5、D-050）: 最小 20px、予定の題名の行 20px、重なりの警告付きの計画は2行ぶん */
const ME_MIN_PX = 20;
const ME_TITLE_PX = 20;
const ME_OVERLAP_PX = 36;
/** 時間軸のタスクで2行目（見積・プロジェクト）を出せる高さ */
const ME_TWO_LINES_PX = 36;
/** 重なりの警告に加えて見積・プロジェクトの行も出せる高さ */
const ME_THREE_LINES_PX = 52;

/** 列の位置 → left / width（入れ子なら予定の列の中で、題名の下に字下げ） */
function slotStyle(b: MeLaneBox, inset: number): { left: string; width: string } {
  const host = b.kind === "event" ? null : b.host;
  const hostLeft = host ? `${(host.column / host.columns) * 100}%` : "0%";
  const hostWidth = host ? `${100 / host.columns}%` : "100%";
  const indent = host ? 14 : 0;
  const frac = `(${hostWidth} - ${indent + inset + 4}px)`;
  return {
    left: `calc(${hostLeft} + ${indent + inset}px + ${frac} * ${b.column / b.columns})`,
    width: `calc(${frac} / ${b.columns} - ${b.columns > 1 ? 2 : 0}px)`,
  };
}

/** 自分のレーン: 予定（カードにしない）と、時間に置いたタスク（計画は枠線、完了は塗り）。配置は core の layoutMeLane */
function MeLane({
  day,
  placed: raw,
  tz,
  isSel,
  onPick,
  projectName,
  resize,
}: {
  day: DayColumn;
  placed: Placement[];
  tz: string;
  isSel: (k: string) => boolean;
  onPick: (k: string) => void;
  projectName: (id: string | null) => string | null;
  /** 下端の伸縮中の仮の範囲 */
  resize: GridPreview | null;
}) {
  const dnd = useBoardDnd();
  const placed = resize
    ? raw.map((p) =>
        p.task.id === resize.taskId
          ? {
              ...p,
              at: resize.range,
              overlapMs: day.events
                .filter((e) => e.busy)
                .reduce(
                  (a, e) =>
                    a +
                    Math.max(
                      0,
                      Math.min(e.end, resize.range.end) - Math.max(e.start, resize.range.start),
                    ),
                  0,
                ),
            }
          : p,
      )
    : raw;
  const { t, dayLabel } = useI18n();
  const countedIn = (d: string | null) => {
    if (!d) return undefined;
    const { weekday, date } = dayLabel(d);
    return t("board.countedIn", { day: `${weekday} ${date}` });
  };
  const axis = day.axis;
  // 伸縮中の予定は仮の終わりで描く（D-093）
  const events = resize?.eventId
    ? day.events.map((e) => (e.id === resize.eventId ? { ...e, end: resize.range.end } : e))
    : day.events;
  const input: MeLaneItem[] = [];
  for (const e of events) {
    const c = clip(e, axis);
    if (c) input.push({ id: e.id, kind: "event", ...c, minPx: ME_MIN_PX });
  }
  for (const p of placed) {
    const c = clip(p.at, axis);
    if (c)
      input.push({
        id: p.task.id,
        kind: p.variant,
        ...c,
        minPx: p.overlapMs > 0 ? ME_OVERLAP_PX : ME_MIN_PX,
      });
  }
  const boxes = layoutMeLane(input, {
    axisStart: axis.start,
    pxPerMs: PX_PER_MS,
    titlePx: ME_TITLE_PX,
    minPx: ME_MIN_PX,
    gapPx: 4,
  });
  // タスクを中に入れた予定（題名の行だけにする）
  const hosts = new Set(boxes.flatMap((b) => (b.kind !== "event" && b.host ? [b.host.id] : [])));
  const items: ReactNode[] = [];
  for (const b of boxes) {
    if (b.kind === "event") {
      const e = events.find((x) => x.id === b.id);
      if (!e) continue;
      const pos = { top: b.top, height: b.height, ...slotStyle(b, 4) };
      const block = (style: React.CSSProperties) => (
        <EventBlock
          key={`e-${e.id}`}
          e={e}
          tz={tz}
          selected={isSel(`event:${e.id}`)}
          hint={countedIn(countedInDate(day, e))}
          // 1時間に満たない予定は1行（`16:00 プロダクト定例`。確定デザイン。D-114）
          compact={b.height < 40 || hosts.has(e.id)}
          style={style}
        />
      );
      // 編集できる予定はドラッグで移動、下端で伸縮（D-093）
      items.push(
        e.editable && dnd ? (
          <DraggableEvent key={`e-${e.id}`} event={e} day={day} style={pos}>
            {block({ top: 0, bottom: 0, left: 0, right: 0 })}
          </DraggableEvent>
        ) : (
          block(pos)
        ),
      );
    } else if (b.kind === "task") {
      const p = placed.find((x) => x.task.id === b.id);
      if (!p) continue;
      const card = (style: React.CSSProperties) => (
        <TaskCard
          key={`t-${p.task.id}`}
          task={p.task}
          variant={p.variant}
          overlapMs={p.overlapMs}
          hint={p.cross ? countedIn(p.task.scheduledDate) : undefined}
          compact={b.height < (p.overlapMs > 0 ? ME_THREE_LINES_PX : ME_TWO_LINES_PX)}
          selected={isSel(`task:${p.task.id}`)}
          project={projectName(p.task.projectId)}
          onClick={() => onPick(`task:${p.task.id}`)}
          onToggle={() => void setComplete(p.task, p.task.status !== "done")}
          style={style}
          // 短い完了のカードは右に完了の時刻（T4。D-139 (4)）
          right={
            p.task.status === "done" &&
            p.task.completedAt !== null &&
            b.height < ME_TWO_LINES_PX ? (
              <span className="shrink-0 font-mono text-fg3 text-meta @max-[140px]:hidden">
                {fmtClock(p.task.completedAt, tz)}
              </span>
            ) : undefined
          }
        />
      );
      // 計画（時間ブロック）はドラッグで移動、下端で伸縮できる（M2-18）。完了の実績は動かさない
      const block = p.variant === "planned" ? p.block : null;
      if (block && dnd)
        items.push(
          <DraggableTask
            key={`t-${p.task.id}`}
            task={p.task}
            block={block}
            className="group absolute cursor-grab"
            style={{ top: b.top, height: b.height, zIndex: 1, ...slotStyle(b, 4) }}
          >
            {card({ top: 0, bottom: 0, left: 0, right: 0 })}
            <div
              className="absolute inset-x-1 bottom-0 h-1.5 cursor-ns-resize"
              onPointerDown={(e) => dnd.startResize(e, p.task, block, day)}
              data-testid="resize-handle"
            />
          </DraggableTask>,
        );
      else items.push(card({ top: b.top, height: b.height, zIndex: 1, ...slotStyle(b, 4) }));
    } else {
      const tasks = b.ids
        .map((id) => placed.find((x) => x.task.id === id))
        .filter((x): x is Placement => x !== undefined);
      items.push(
        <DoneGroup
          key={`s-${b.ids[0]}`}
          box={b}
          tasks={tasks}
          hint={countedIn(
            tasks.find((p) => p.cross)?.task.scheduledDate ??
              countedInDate(day, { start: b.start, end: b.end }),
          )}
          tz={tz}
          isSel={isSel}
          onPick={onPick}
          style={{ top: b.top, height: b.height, ...slotStyle(b, 4) }}
        />,
      );
    }
  }
  // タスクに付かない時間ブロック（範囲選択で作ったもの。M2-18）
  for (const b of day.timeBlocks.filter((x) => x.taskId === null)) {
    const c = clip(b, axis);
    if (!c) continue;
    items.push(
      <div
        key={`b-${b.id}`}
        title={countedIn(countedInDate(day, b))}
        className="absolute rounded-card border border-fg3/60 px-2 text-body text-fg2"
        style={{
          top: yOf(c.start, axis.start),
          height: Math.max(ME_MIN_PX, yOf(c.end, c.start)),
          left: 4,
          right: 4,
        }}
      >
        {b.title}
      </div>,
    );
  }
  return <>{items}</>;
}

/**
 * 連続した短い完了ブロックのまとめ表示（W4）: `✓ 3 done · 41m`。ホバーで内訳（時刻と題名）、
 * クリックで先頭を選び、内訳を開く（中のどれかを選んでいる間は開いたまま。j / k でも中を移れる）
 */
function DoneGroup({
  box,
  tasks,
  hint,
  tz,
  isSel,
  onPick,
  style,
}: {
  box: Extract<MeLaneBox, { kind: "summary" }>;
  tasks: Placement[];
  /** 前日に計上するとき `Counted in Sun 10/4`（D-054） */
  hint?: string | undefined;
  tz: string;
  isSel: (k: string) => boolean;
  onPick: (k: string) => void;
  style: React.CSSProperties;
}) {
  const { t, locale } = useI18n();
  const open = tasks.some((p) => isSel(`task:${p.task.id}`));
  const lines = tasks.map(
    (p) =>
      `${fmtClock(p.at.start, tz)}–${fmtClock(p.at.end, tz)}  ${titleText(p.task.title, locale)}`,
  );
  return (
    <div className="absolute" style={{ ...style, zIndex: open ? 30 : 1 }}>
      <button
        type="button"
        tabIndex={-1}
        data-kind="done-group"
        title={[...lines, ...(hint ? [hint] : [])].join("\n")}
        onClick={() => {
          const first = tasks[0];
          if (first) onPick(`task:${first.task.id}`);
        }}
        className={`flex h-full w-full items-start overflow-hidden rounded-card border bg-task px-2 text-left shadow-task ${
          open ? "border-accent" : "border-taskline"
        }`}
      >
        <span className="flex h-[18px] min-w-0 items-center gap-1.5 text-fg3">
          <span className="truncate font-mono text-meta">
            {t("board.doneGroup", {
              count: box.ids.length,
              time: fmtDuration(box.totalMs),
            })}
          </span>
        </span>
      </button>
      {open ? (
        <div className="absolute top-full left-0 mt-1 flex min-w-[280px] flex-col gap-0.5 rounded-card border border-line bg-bg p-1 shadow-lg">
          {tasks.map((p) => (
            <TaskCard
              key={p.task.id}
              task={p.task}
              variant="done"
              selected={isSel(`task:${p.task.id}`)}
              onClick={() => onPick(`task:${p.task.id}`)}
              onToggle={() => void setComplete(p.task, p.task.status !== "done")}
              right={
                <span className="shrink-0 font-mono text-meta text-fg3">
                  {fmtClock(p.at.start, tz)}
                </span>
              }
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export type { BoardResponse };

/**
 * 週ボードの今日の列だけ（朝の計画 Step 3。M4-7）。ヘッダ（日付と集計）、YOUR TURN、Unscheduled、24時間の時間軸を
 * 週ボードと同じ部品で描く。開いたときは計画の目安の開始の付近へスクロールする。DnD も週ボードと同じ
 */
export function TodayColumn({
  day,
  queue,
  now,
  tz,
  height,
  projectName,
}: {
  day: DayColumn;
  queue: QueueResponse | undefined;
  now: number;
  tz: string;
  /** 時間軸の見える高さ（px） */
  height: number;
  projectName: (id: string | null) => string | null;
}) {
  const { t, dayLabel } = useI18n();
  const scroller = useRef<HTMLDivElement>(null);
  const [sel, setSel] = useState<string | null>(null);
  const isSel = (k: string) => sel === k;
  const l = useMemo(() => placementsOf(day), [day]);
  const band = turnRows(queue?.items, queue?.grace);
  const { weekday, date: md } = dayLabel(day.date);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 開いたときに1回だけ
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTop = initialScroll(
      day.axis,
      day.plannedHours?.start ?? day.axis.start + 9 * 3_600_000,
    );
  }, []);
  return (
    <BoardDnd>
      <div
        className="flex min-w-0 flex-col overflow-hidden rounded-card border border-line"
        data-testid="today-column"
      >
        <div className="flex flex-col gap-1.5 border-line border-b px-3 pt-2 pb-2">
          <div className="text-section">
            <span className="font-medium">
              {weekday} {md}
            </span>
            <span className="text-fg2"> · {t("dayDivider.today")}</span>
          </div>
          <TotalsLine day={day} />
          <YourTurnBand
            band={band}
            max={BAND_MAX}
            blocks={day.timeBlocks}
            queue={queue}
            now={now}
            tz={tz}
            isSel={isSel}
            onPick={setSel}
            onMore={() => {}}
          />
          <Unscheduled
            date={day.date}
            tasks={l.unscheduled}
            shown={l.unscheduled.length}
            onToggleMore={() => {}}
            carry={null}
            onCarry={() => {}}
            isSel={isSel}
            onPick={setSel}
            projectName={projectName}
            showEmptyHint={false}
          />
        </div>
        <div ref={scroller} className="min-h-0 overflow-y-auto" style={{ height }}>
          <div className="grid" style={{ gridTemplateColumns: `${GUTTER_PX}px minmax(0, 1fr)` }}>
            <div className="border-line border-r">
              <Gutter
                axis={day.axis}
                tz={tz}
                now={now}
                showNow={day.phase === "today"}
                strong={strongRanges(day.axis, [day])}
              />
            </div>
            <DayGrid
              day={day}
              placed={l.placed}
              replies={l.replies}
              split={day.phase === "today"}
              onOpenDay={() => {}}
              now={now}
              tz={tz}
              isSel={isSel}
              onPick={setSel}
              projectName={projectName}
              rangeDone={0}
              onRange={() => {}}
            />
          </div>
        </div>
      </div>
    </BoardDnd>
  );
}
