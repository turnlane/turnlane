/**
 * 週ボードのドラッグ＆ドロップ（M2-17・M2-18。ux-mvp 7章）。dnd-kit の DndContext と、ドラッグ中の状態（ドロップ先、
 * 時間軸の仮置き、並べ替えの位置、ヘッダの容量の置き換え）を持つ。計算は core の plan/dnd.ts。
 *
 * | ドラッグ元 | ドロップ先 | 結果 |
 * |---|---|---|
 * | タスク（Unscheduled・Inbox トレイ・時間軸） | 別の日付カラム（ヘッダ・Unscheduled） | 日付の変更（時間軸から外したものはブロックを外す） |
 * | 同上 | Unscheduled のカード | その前後へ並べ替え（別の日なら日付も変える） |
 * | 同上 | 時間軸（自分レーン） | 時間ブロック（高さ = 見積、無ければ30分。15分スナップ、⌥ で5分） |
 * | 同上 | Inbox トレイ | 日付を外す |
 * | 時間ブロックの下端 | （伸縮） | 終了時刻の変更 |
 * | 自分レーンの空白 | （範囲選択） | 新規タスク＋時間ブロック |
 * | 自分の番（YOUR TURN の行） | 今日の時間軸 | そのタスクの時間ブロック（D-051） |
 * | 同上 | 未来の日付カラム（時間軸） | その日へ移してスヌーズ（D-052 (1)）、時間軸ならその時刻にブロック |
 * | AI カード | 自分レーン | 確認タスク（`Check: <題名>`）とその時刻の30分のブロック |
 * | 編集できる予定（D-093） | 時間軸（どの日でも。デイビューは予定のレーンでも自分レーンでも） | 予定の時刻の変更（長さは保つ） |
 * | 予定の下端 | （伸縮） | 予定の終了時刻の変更 |
 * | タスク・自分の番・AI カード | デイビューの予定のレーン | 不可（禁止のカーソル） |
 * | 同上 | 別の AI カード | 統合の確認ダイアログ |
 * | 同上 | 日付カラム・Inbox | 不可（禁止のカーソル） |
 *
 * 楽観的更新と ⌘Z は data/mutations.ts。タスクの時間ブロックはカレンダーに書かない。予定の移動・伸縮は Calendar.app へ書く
 * （patchEvent。D-093）。⌘Z で戻す（予定が外部で変わっていたら戻さない。D-096）。
 */

import {
  type CollisionDetection,
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  MeasuringStrategy,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  blockDurationMs,
  busyOverlapMs,
  type CalendarEventView,
  type DayColumn,
  type DayTotals,
  dropRange,
  FINE_SNAP_MIN,
  fmtClock,
  type Interval,
  neighborsFor,
  plannedWith,
  type QueueItem,
  resizeEnd,
  SNAP_MIN,
  selectRange,
  type TaskView,
  type TimeBlockView,
} from "@turnlane/core/web";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { TaskCard, titleText } from "../components/items.tsx";
import { primaryFollowUp } from "../components/TurnRow.tsx";
import { ConfirmDialog } from "../components/ui.tsx";
import {
  createCheckTask,
  mergeWorkItems,
  moveTask,
  patchBlock,
  patchEvent,
  placeTurn,
  scheduleTask,
  unscheduleTask,
} from "../data/mutations.ts";
import { currentToday } from "../data/sse.ts";
import { useI18n } from "../i18n/index.tsx";
import { PX_PER_MS } from "./geometry.ts";

/** ドラッグしているタスク（Unscheduled・Inbox トレイ・時間軸） */
export interface DragTask {
  kind?: "task";
  task: TaskView;
  /** 時間軸から持ち上げたときのブロック */
  block: TimeBlockView | null;
  /** ブロックの上端からつかんだ位置までの時間（時間軸から持ち上げたときだけ） */
  grabOffsetMs: number;
}

/** ドラッグしている自分の番（YOUR TURN の行） */
export interface DragTurn {
  kind: "turn";
  followUpId: string;
  taskId: string;
  /** タスクの日付（時間に置くとき、違う日ならその日へ移す） */
  taskDate: string | null;
  title: string;
  /** そのタスクに既にある時間ブロック（あれば移す。長さも保つ） */
  block: TimeBlockView | null;
  grabOffsetMs: number;
}

/** ドラッグしている AI カード（ひと続きの作業のブロック） */
export interface DragAi {
  kind: "ai";
  workItemId: string;
  title: string | null;
  grabOffsetMs: number;
}

/** ドラッグしている予定（編集できるものだけ。D-093） */
export interface DragCalEvent {
  kind: "event";
  event: CalendarEventView;
  grabOffsetMs: number;
}

export type DragItem = DragTask | DragTurn | DragAi | DragCalEvent;

const isTask = (a: DragItem): a is DragTask => a.kind === undefined || a.kind === "task";

export type DropData =
  | { kind: "date"; date: string }
  | { kind: "ai"; workItemId: string; title: string | null }
  | { kind: "card"; date: string; taskId: string; ids: readonly string[] }
  | {
      kind: "grid";
      date: string;
      axis: Interval;
      busy: readonly (Interval & { id?: string })[];
      /** デイビューの予定のレーン（予定だけを落とせる。D-093） */
      lane?: "events";
    }
  | { kind: "inbox" };

export interface GridPreview {
  date: string;
  range: Interval;
  /** busy な予定と重なる（斜線で示す。置くことは禁止しない） */
  overlap: boolean;
  /** 伸縮中のタスク（その位置を置き換えて描く） */
  taskId: string | null;
  /** 伸縮中の予定（その位置を置き換えて描く。D-093） */
  eventId?: string | null;
}

/** 仮置きの枠（破線）を出すか: 伸縮中はタスク・予定そのものを描くので出さない */
export const isDropGhost = (p: GridPreview | null): p is GridPreview =>
  p !== null && p.taskId === null && !p.eventId;

interface DndState {
  active: DragItem | null;
  /** 落とせない所の上にいる（禁止のカーソル。AI カードの日付移動など） */
  forbidden: boolean;
  over: DropData | null;
  preview: GridPreview | null;
  /** 並べ替えの挿入位置 */
  insert: { taskId: string; place: "before" | "after" } | null;
}

interface DndApi extends DndState {
  /** ドラッグ中のヘッダの集計（ドロップ後の値。ux-mvp 7章） */
  totalsOf: (day: DayColumn) => DayTotals;
  startResize: (
    e: React.PointerEvent,
    task: TaskView,
    block: TimeBlockView,
    day: DayColumn,
  ) => void;
  /** 予定の下端の伸縮（D-093） */
  startResizeEvent: (e: React.PointerEvent, event: CalendarEventView, day: DayColumn) => void;
}

const Ctx = createContext<DndApi | null>(null);

export function useBoardDnd(): DndApi | null {
  return useContext(Ctx);
}

const EMPTY: DndState = {
  active: null,
  forbidden: false,
  over: null,
  preview: null,
  insert: null,
};

/** 落とせないか（禁止のカーソル）。today は論理日の今日 */
export function forbiddenDrop(a: DragItem, over: DropData | null, today: string): boolean {
  if (!over) return false;
  // 予定は時間軸にだけ落とせる（日付カラム・Inbox・カードは不可）
  if (a.kind === "event") return over.kind !== "grid";
  // デイビューの予定のレーンには予定だけ（D-093）
  if (over.kind === "grid" && over.lane === "events") return true;
  if (a.kind === "ai") {
    if (over.kind === "ai") return over.workItemId === a.workItemId;
    return over.kind !== "grid";
  }
  if (a.kind === "turn") {
    if (over.kind === "ai" || over.kind === "inbox") return true;
    // 今日の時間軸と未来の日だけ
    return over.kind === "grid" ? over.date < today : over.date <= today;
  }
  return over.kind === "ai";
}

/** 時間軸に置くときの長さ */
function durationOf(a: DragItem): number {
  if (a.kind === "event") return a.event.end - a.event.start;
  if (a.kind === "ai") return blockDurationMs(null);
  if (a.kind === "turn") return a.block ? a.block.end - a.block.start : blockDurationMs(null);
  return a.block ? a.block.end - a.block.start : blockDurationMs(a.task.estimateMin);
}

function samePreview(a: GridPreview | null, b: GridPreview | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.date === b.date &&
    a.range.start === b.range.start &&
    a.range.end === b.range.end &&
    a.overlap === b.overlap &&
    a.taskId === b.taskId &&
    (a.eventId ?? null) === (b.eventId ?? null)
  );
}

/** 自分レーンの要素（data-grid）の今の位置から、ポインタの時刻を出す（スクロールしても正しい） */
function pointerTime(date: string, axis: Interval, clientY: number): number | null {
  const el = document.querySelector<HTMLElement>(`[data-grid="${date}"]`);
  if (!el) return null;
  return axis.start + (clientY - el.getBoundingClientRect().top) / scaleOf(el);
}

/** 時間軸の縮尺（ms あたりの px）。デイビューは時間軸の要素に data-px-per-ms を付ける（1時間の高さが違う） */
function scaleOf(el: Element | null): number {
  const v = Number((el?.closest("[data-px-per-ms]") as HTMLElement | null)?.dataset.pxPerMs);
  return Number.isFinite(v) && v > 0 ? v : PX_PER_MS;
}

/** 重なったドロップ先は、カード → 時間軸 → Inbox → 日付カラムの順に選ぶ（入れ子のカードを優先） */
const RANK: Record<DropData["kind"], number> = { ai: 0, card: 1, grid: 2, inbox: 3, date: 4 };
const collision: CollisionDetection = (args) => {
  const self = args.active.data.current as DragItem | undefined;
  const hits = pointerWithin(args).filter(
    (h) =>
      h.id !== `card:${args.active.id}` &&
      !(self?.kind === "ai" && String(h.id).startsWith(`aidrop:${self.workItemId}:`)),
  );
  const kind = (id: string | number) =>
    (args.droppableContainers.find((c) => c.id === id)?.data.current as DropData | undefined)?.kind;
  return hits.sort((a, b) => RANK[kind(a.id) ?? "date"] - RANK[kind(b.id) ?? "date"]).slice(0, 1);
};

export function BoardDnd({ children, today }: { children: ReactNode; today?: string | undefined }) {
  const { t } = useI18n();
  const [state, setState] = useState<DndState>(EMPTY);
  const [merge, setMerge] = useState<{
    from: { id: string; title: string };
    into: { id: string; title: string };
  } | null>(null);
  const todayRef = useRef(today);
  todayRef.current = today ?? currentToday();
  const pointer = useRef({ x: 0, y: 0, alt: false });
  // 最新の状態。描画を待たずに更新する（put）。描画の時に代入していると、描画が遅いとき（負荷の高い WebKit など）に
  // onDragOver で決めた落とし先を、その直後の pointermove が古い状態（落とし先なし）で上書きし、dnd-kit は落とし先が
  // 変わらないので onDragOver を二度と呼ばず、仮置きが出ないまま離して何も起きなかった
  const stateRef = useRef(state);
  const put = useCallback((f: (p: DndState) => DndState) => {
    const n = f(stateRef.current);
    if (n === stateRef.current) return;
    stateRef.current = n;
    setState(n);
  }, []);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  /** ポインタの位置とドロップ先から、仮置き（時間軸）と挿入位置を出す */
  const recompute = useCallback(
    (over: DropData | null) => {
      const s = stateRef.current;
      if (!s.active) return;
      const { y, alt } = pointer.current;
      let preview: GridPreview | null = null;
      let insert: DndState["insert"] = null;
      const forbidden = forbiddenDrop(s.active, over, todayRef.current ?? "");
      if (over?.kind === "grid" && !forbidden) {
        const t = pointerTime(over.date, over.axis, y);
        if (t !== null) {
          const dur = durationOf(s.active);
          const range = dropRange({
            pointer: t,
            grabOffsetMs: s.active.grabOffsetMs,
            durationMs: dur,
            axis: over.axis,
            stepMin: alt ? FINE_SNAP_MIN : SNAP_MIN,
          });
          // 予定を動かすときは自分自身と重なりを数えない
          const self = s.active.kind === "event" ? s.active.event.id : null;
          preview = {
            date: over.date,
            range,
            overlap:
              busyOverlapMs(range, self ? over.busy.filter((b) => b.id !== self) : over.busy) > 0,
            taskId: null,
          };
        }
      } else if (over?.kind === "card" && isTask(s.active)) {
        const el = document.querySelector<HTMLElement>(`[data-drop-card="${over.taskId}"]`);
        if (el) {
          const r = el.getBoundingClientRect();
          insert = { taskId: over.taskId, place: y < r.top + r.height / 2 ? "before" : "after" };
        }
      }
      put((p) =>
        p.over === over &&
        p.forbidden === forbidden &&
        samePreview(p.preview, preview) &&
        p.insert?.taskId === insert?.taskId &&
        p.insert?.place === insert?.place
          ? p
          : { ...p, over, forbidden, preview, insert },
      );
    },
    [put],
  );

  // ポインタは常に追う（dnd-kit の delta はスクロールを含まないので、画面の座標を直接読む）。ドラッグの開始を React が
  // 描いてから追い始めると、描画が遅いとき（負荷の高い WebKit など）に開始直後の動きを取りこぼし、仮置きが掴んだ位置の
  // 時刻になる。ドラッグ中だけ仮置きを計算し直す
  useEffect(() => {
    const move = (e: PointerEvent) => {
      pointer.current = { x: e.clientX, y: e.clientY, alt: e.altKey };
      if (stateRef.current.active) recompute(stateRef.current.over);
    };
    window.addEventListener("pointermove", move, { capture: true, passive: true });
    return () => window.removeEventListener("pointermove", move, { capture: true });
  }, [recompute]);
  // ドラッグ中は ⌥（5分刻み）を追う
  useEffect(() => {
    if (!state.active) return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Alt") return;
      pointer.current = { ...pointer.current, alt: e.type === "keydown" };
      recompute(stateRef.current.over);
    };
    window.addEventListener("keydown", key);
    window.addEventListener("keyup", key);
    return () => {
      window.removeEventListener("keydown", key);
      window.removeEventListener("keyup", key);
      document.body.style.cursor = "";
    };
  }, [state.active, recompute]);
  // 落とせない所の上では禁止のカーソル（AI カードの日付移動など。ux-mvp 7章）
  useEffect(() => {
    if (!state.active) return;
    document.body.style.cursor = state.forbidden ? "not-allowed" : "grabbing";
    return () => {
      document.body.style.cursor = "";
    };
  }, [state.active, state.forbidden]);

  const onDragStart = (e: DragStartEvent) => {
    const d = e.active.data.current as DragItem | undefined;
    if (!d) return;
    const ev = e.activatorEvent as PointerEvent;
    // 位置は上の pointermove が持っている（押した位置で上書きすると、開始の判定までに動いた分がずれる）
    pointer.current = { ...pointer.current, alt: ev.altKey };
    const top = e.active.rect.current.initial?.top ?? ev.clientY;
    put(() => ({
      ...EMPTY,
      active: {
        ...d,
        grabOffsetMs:
          (isTask(d) && d.block) || d.kind === "event"
            ? Math.max(0, (ev.clientY - top) / scaleOf(ev.target as Element | null))
            : 0,
      },
    }));
  };

  const onDragEnd = (e: DragEndEvent) => {
    const s = stateRef.current;
    put(() => EMPTY);
    const a = s.active;
    const over = (e.over?.data.current as DropData | undefined) ?? null;
    if (!a || !over) return;
    if (forbiddenDrop(a, over, todayRef.current ?? "")) return;
    if (a.kind === "event") {
      if (over.kind !== "grid") return;
      const p = s.preview;
      if (!p || p.date !== over.date) return;
      if (p.range.start === a.event.start && p.range.end === a.event.end) return;
      void patchEvent(a.event.id, { start: p.range.start, end: p.range.end });
      return;
    }
    if (a.kind === "turn") {
      const today = todayRef.current ?? "";
      if (over.kind === "grid") {
        const p = s.preview;
        if (!p || p.date !== over.date) return;
        if (a.block && a.block.start === p.range.start && a.block.end === p.range.end) return;
        void placeTurn({
          followUpId: a.followUpId,
          taskId: a.taskId,
          taskDate: a.taskDate,
          date: over.date,
          today,
          range: p.range,
          block: a.block,
        });
      } else if (over.kind === "date" || over.kind === "card")
        void placeTurn({
          followUpId: a.followUpId,
          taskId: a.taskId,
          taskDate: a.taskDate,
          date: over.date,
          today,
          range: null,
          block: null,
        });
      return;
    }
    if (a.kind === "ai") {
      const title = a.title ?? t("common.none");
      if (over.kind === "grid") {
        const p = s.preview;
        if (!p || p.date !== over.date) return;
        void createCheckTask({
          workItemId: a.workItemId,
          title: t("dnd.checkTitle", { title }),
          date: over.date,
          range: p.range,
        });
      } else if (over.kind === "ai" && over.workItemId !== a.workItemId)
        setMerge({
          from: { id: a.workItemId, title },
          into: { id: over.workItemId, title: over.title ?? t("common.none") },
        });
      return;
    }
    if (over.kind === "ai") return;
    const { task, block } = a;
    if (over.kind === "grid") {
      const p = s.preview;
      if (!p || p.date !== over.date) return;
      if (block && block.start === p.range.start && block.end === p.range.end) return;
      void scheduleTask(task, over.date, p.range);
    } else if (over.kind === "inbox") {
      if (task.scheduledDate !== null) void moveTask(task, null, { undoable: true });
    } else if (over.kind === "date") {
      if (block) void unscheduleTask(task, { date: over.date });
      else if (task.scheduledDate !== over.date) void moveTask(task, over.date, { undoable: true });
    } else if (over.kind === "card") {
      const place = s.insert?.taskId === over.taskId ? s.insert.place : "after";
      const n = neighborsFor(over.ids, task.id, over.taskId, place);
      // 同じ位置なら何もしない
      const ids = over.ids.filter((x) => x !== task.id);
      const i = over.ids.indexOf(task.id);
      if (
        !block &&
        task.scheduledDate === over.date &&
        i >= 0 &&
        (over.ids[i - 1] ?? null) === n.beforeId &&
        (over.ids[i + 1] ?? null) === n.afterId &&
        ids.length === over.ids.length - 1
      )
        return;
      if (block) void unscheduleTask(task, { date: over.date, ...n });
      else void moveTask(task, over.date, { ...n, undoable: true });
    }
  };

  // ---------- 下端の伸縮（dnd-kit を使わずポインタを直接追う） ----------
  const startResize = useCallback(
    (e: React.PointerEvent, task: TaskView, block: TimeBlockView, day: DayColumn) => {
      e.stopPropagation();
      e.preventDefault();
      const busy = day.events.filter((x) => x.busy);
      const calc = (clientY: number, alt: boolean): GridPreview | null => {
        const t = pointerTime(day.date, day.axis, clientY);
        if (t === null) return null;
        const end = resizeEnd({
          pointer: t,
          start: block.start,
          axis: day.axis,
          stepMin: alt ? FINE_SNAP_MIN : SNAP_MIN,
        });
        const range = { start: block.start, end };
        return { date: day.date, range, overlap: busyOverlapMs(range, busy) > 0, taskId: task.id };
      };
      const move = (ev: PointerEvent) => {
        const p = calc(ev.clientY, ev.altKey);
        if (p) put((s) => ({ ...s, preview: p }));
      };
      const up = (ev: PointerEvent) => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        document.body.style.cursor = "";
        const p = calc(ev.clientY, ev.altKey);
        put(() => EMPTY);
        if (p && p.range.end !== block.end) void patchBlock(block, p.range);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      document.body.style.cursor = "ns-resize";
    },
    [put],
  );

  // ---------- 予定の下端の伸縮（D-093） ----------
  const startResizeEvent = useCallback(
    (e: React.PointerEvent, event: CalendarEventView, day: DayColumn) => {
      e.stopPropagation();
      e.preventDefault();
      const busy = day.events.filter((x) => x.busy && x.id !== event.id);
      const calc = (clientY: number, alt: boolean): GridPreview | null => {
        const t = pointerTime(day.date, day.axis, clientY);
        if (t === null) return null;
        const end = resizeEnd({
          pointer: t,
          start: event.start,
          axis: day.axis,
          stepMin: alt ? FINE_SNAP_MIN : SNAP_MIN,
        });
        const range = { start: event.start, end };
        return {
          date: day.date,
          range,
          overlap: busyOverlapMs(range, busy) > 0,
          taskId: null,
          eventId: event.id,
        };
      };
      const move = (ev: PointerEvent) => {
        const p = calc(ev.clientY, ev.altKey);
        if (p) put((s) => ({ ...s, preview: p }));
      };
      const up = (ev: PointerEvent) => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        document.body.style.cursor = "";
        const p = calc(ev.clientY, ev.altKey);
        put(() => EMPTY);
        if (p && p.range.end !== event.end) void patchEvent(event.id, { end: p.range.end });
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      document.body.style.cursor = "ns-resize";
    },
    [put],
  );

  const totalsOf = useCallback(
    (day: DayColumn): DayTotals => {
      const a = state.active;
      if (!a || !isTask(a)) return day.totals;
      const target =
        state.over === null
          ? a.task.scheduledDate
          : state.over.kind === "inbox"
            ? null
            : state.over.kind === "ai"
              ? a.task.scheduledDate
              : state.over.date;
      if (target === a.task.scheduledDate) return day.totals;
      if (day.date === a.task.scheduledDate) return plannedWith(day.totals, a.task, -1);
      if (day.date === target) return plannedWith(day.totals, a.task, 1);
      return day.totals;
    },
    [state.active, state.over],
  );

  const api = useMemo<DndApi>(
    () => ({ ...state, totalsOf, startResize, startResizeEvent }),
    [state, totalsOf, startResize, startResizeEvent],
  );

  return (
    <Ctx.Provider value={api}>
      <DndContext
        sensors={sensors}
        collisionDetection={collision}
        onDragStart={onDragStart}
        onDragOver={(e) => recompute((e.over?.data.current as DropData | undefined) ?? null)}
        onDragEnd={onDragEnd}
        onDragCancel={() => put(() => EMPTY)}
        autoScroll={{
          threshold: { x: 0, y: 0.15 },
          // ポインタが時間軸の外（ヘッダ・帯）にあるときはスクロールしない（上の日付カラムへ運ぶ途中で 0:00 まで流れないように）
          canScroll: (el) => {
            const r = el.getBoundingClientRect();
            const { x, y } = pointer.current;
            return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
          },
        }}
        measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
      >
        {children}
        <DragOverlay dropAnimation={null}>
          {state.active ? (
            <div
              className="w-[220px] opacity-90 shadow-pop"
              style={{ visibility: state.preview ? "hidden" : "visible" }}
            >
              {isTask(state.active) ? (
                <TaskCard task={state.active.task} />
              ) : (
                <div
                  className={`flex h-7 items-center truncate rounded-chip border bg-raised px-2 text-body ${
                    state.forbidden ? "border-line text-fg3" : "border-accent text-fg"
                  }`}
                  data-testid="drag-chip"
                >
                  {state.active.kind === "turn"
                    ? state.active.title
                    : state.active.kind === "event"
                      ? (state.active.event.title ?? t("common.none"))
                      : (state.active.title ?? t("common.none"))}
                </div>
              )}
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
      {merge ? (
        <ConfirmDialog
          title={t("dnd.merge.title", { from: merge.from.title, into: merge.into.title })}
          body={t("dnd.merge.body", { from: merge.from.title, into: merge.into.title })}
          confirm={t("dnd.merge.confirm")}
          cancel={t("action.cancel")}
          onCancel={() => setMerge(null)}
          onConfirm={() => {
            setMerge(null);
            void mergeWorkItems(merge.from.id, merge.into.id);
          }}
        />
      ) : null}
    </Ctx.Provider>
  );
}

/** ドラッグできるタスク（Unscheduled・Inbox トレイのカード、時間軸のブロック） */
export function DraggableTask({
  task,
  block = null,
  children,
  className,
  style,
}: {
  task: TaskView;
  block?: TimeBlockView | null;
  children: ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  const id = block ? `block:${task.id}` : `task:${task.id}`;
  const { setNodeRef, listeners, isDragging } = useDraggable({
    id,
    data: { task, block, grabOffsetMs: 0 } satisfies DragTask,
  });
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      className={className}
      style={{ ...style, opacity: isDragging ? 0.35 : undefined, touchAction: "none" }}
      data-drag={id}
    >
      {children}
    </div>
  );
}

/** 並べ替えの的（Unscheduled のカード）。挿入位置に 2px の線を出す */
export function CardDrop({
  date,
  taskId,
  ids,
  children,
  className = "",
}: {
  date: string;
  taskId: string;
  ids: readonly string[];
  children: ReactNode;
  className?: string;
}) {
  const dnd = useBoardDnd();
  const { setNodeRef } = useDroppable({
    id: `card:${taskId}`,
    data: { kind: "card", date, taskId, ids } satisfies DropData,
  });
  const ins = dnd?.active && dnd.insert?.taskId === taskId ? dnd.insert.place : null;
  return (
    <div ref={setNodeRef} className={`relative ${className}`} data-drop-card={taskId}>
      {ins ? (
        <div
          className={`pointer-events-none absolute inset-x-0 z-10 h-0.5 rounded-full bg-accent ${
            ins === "before" ? "-top-[3px]" : "-bottom-[3px]"
          }`}
        />
      ) : null}
      {children}
    </div>
  );
}

/** 日付カラムの的（ヘッダ・終日の行・上部エリア）。ドラッグ中に上にあれば枠を付ける */
export function DateDrop({
  id,
  date,
  className,
  style,
  children,
}: {
  id: string;
  date: string;
  className?: string;
  style?: React.CSSProperties;
  children?: ReactNode;
}) {
  const dnd = useBoardDnd();
  const { setNodeRef } = useDroppable({ id, data: { kind: "date", date } satisfies DropData });
  const hot =
    dnd?.active &&
    dnd.over &&
    !dnd.forbidden &&
    (dnd.over.kind === "date" || dnd.over.kind === "card") &&
    dnd.over.date === date;
  return (
    <div
      ref={setNodeRef}
      className={`${className ?? ""} ${hot ? "bg-accent/5" : ""}`}
      style={style}
      data-drop-date={date}
    >
      {children}
    </div>
  );
}

/** 時間軸（自分レーン。lane = events はデイビューの予定のレーン。D-093）の的 */
export function useGridDrop(day: DayColumn, lane?: "events") {
  const busy = useMemo(
    () => day.events.filter((e) => e.busy).map((e) => ({ start: e.start, end: e.end, id: e.id })),
    [day.events],
  );
  return useDroppable({
    id: `${lane === "events" ? "evgrid" : "grid"}:${day.date}`,
    data: {
      kind: "grid",
      date: day.date,
      axis: day.axis,
      busy,
      ...(lane ? { lane } : {}),
    } satisfies DropData,
  });
}

/**
 * ドラッグできる予定（編集できるものだけ。D-093）。位置はこの要素に付け、中の EventBlock は全面に広げる。
 * 下端に伸縮のつまみ（6px）
 */
export function DraggableEvent({
  event,
  day,
  style,
  children,
}: {
  event: CalendarEventView;
  day: DayColumn;
  style: React.CSSProperties;
  children: ReactNode;
}) {
  const dnd = useBoardDnd();
  const id = `event:${event.id}`;
  const { setNodeRef, listeners, isDragging } = useDraggable({
    id,
    data: { kind: "event", event, grabOffsetMs: 0 } satisfies DragCalEvent,
  });
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      className="group absolute cursor-grab"
      style={{ ...style, opacity: isDragging ? 0.35 : undefined, touchAction: "none" }}
      data-drag={id}
    >
      {children}
      {dnd ? (
        <div
          className="absolute inset-x-1 bottom-0 h-1.5 cursor-ns-resize"
          onPointerDown={(e) => dnd.startResizeEvent(e, event, day)}
          data-testid="event-resize-handle"
        />
      ) : null}
    </div>
  );
}

/** Inbox トレイの的 */
export function useInboxDrop() {
  return useDroppable({ id: "inbox", data: { kind: "inbox" } satisfies DropData });
}

/** 自分レーンの空白の範囲選択（M2-18）: 押して縦に動かすと範囲を出し、離すと onDone(range) */
/** 空き枠のクリックで作る範囲（UX 監査 A6）: 押した位置を含む15分の枠から30分（軸の終わりで切る） */
export function clickSlot(at: number, axis: Interval): Interval {
  const step = SNAP_MIN * 60_000;
  const start = axis.start + Math.floor((at - axis.start) / step) * step;
  const s = Math.max(axis.start, Math.min(start, axis.end - step));
  return { start: s, end: Math.min(axis.end, s + 2 * step) };
}

/** 入力欄・メニューなどの浮いた部品が開いているか（そのときの空き枠のクリックは閉じるだけにする） */
function floating(): boolean {
  return document.querySelector('[role="dialog"],[role="menu"],[role="alertdialog"]') !== null;
}

/**
 * 空白の範囲選択（M2-18・D-093）とクリック（UX 監査 A6）: ドラッグで範囲、クリックでその枠から30分。
 * どちらも onDone（作成の入力欄）を開く。slotAt / openAt は右クリックのメニュー（空き枠）から使う
 */
export function useRangeSelect(
  day: DayColumn,
  onDone: (range: Interval, el: HTMLElement, as?: "task" | "event") => void,
) {
  const [range, setRange] = useState<Interval | null>(null);
  /** 範囲を出してから、その仮置きの枠を的に入力欄を開く */
  const openAt = (r: Interval, fallback: HTMLElement, as?: "task" | "event") => {
    flushSync(() => setRange(r));
    const ghost = document.querySelector<HTMLElement>(`[data-range-ghost="${day.date}"]`);
    onDone(r, ghost ?? fallback, as);
  };
  const slotAt = (clientY: number): Interval | null => {
    const at = pointerTime(day.date, day.axis, clientY);
    return at === null ? null : clickSlot(at, day.axis);
  };
  const onPointerDown = (e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    // 項目の上で押したときは選択しない（クリック・ドラッグに任せる）
    if ((e.target as HTMLElement).closest("[data-kind],[data-drag],button")) return;
    const from = pointerTime(day.date, day.axis, e.clientY);
    if (from === null) return;
    // 入力欄やメニューを開いているときのクリックは、それを閉じるだけ（Google カレンダーと同じ）
    const dismissing = floating();
    const target = e.target as HTMLElement;
    const y0 = e.clientY;
    let moved = false;
    let last: Interval | null = null;
    const calc = (ev: PointerEvent) => {
      const to = pointerTime(day.date, day.axis, ev.clientY);
      if (to === null) return null;
      return selectRange({
        from,
        to,
        axis: day.axis,
        stepMin: ev.altKey ? FINE_SNAP_MIN : SNAP_MIN,
      });
    };
    const move = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientY - y0) < 4) return;
      moved = true;
      last = calc(ev);
      setRange(last);
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (!moved) {
        // クリック: その枠から30分の入力欄（UX 監査 A6）
        if (dismissing || ev.button !== 0) return;
        openAt(clickSlot(from, day.axis), target);
        return;
      }
      const r = calc(ev) ?? last;
      if (!r) {
        setRange(null);
        return;
      }
      setRange(r);
      const ghost = document.querySelector<HTMLElement>(`[data-range-ghost="${day.date}"]`);
      onDone(r, ghost ?? target);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return { range, clear: () => setRange(null), onPointerDown, openAt, slotAt };
}

/** ドラッグできる自分の番の行（YOUR TURN 帯・デイビューの左パネル）。クリックは中の行に任せる */
export function DraggableTurn({
  followUpId,
  taskId,
  taskDate,
  title,
  block,
  children,
}: {
  followUpId: string;
  taskId: string;
  taskDate: string | null;
  title: string;
  block: TimeBlockView | null;
  children: ReactNode;
}) {
  const { setNodeRef, listeners, isDragging } = useDraggable({
    id: `turn:${followUpId}`,
    data: {
      kind: "turn",
      followUpId,
      taskId,
      taskDate,
      title,
      block,
      grabOffsetMs: 0,
    } satisfies DragTurn,
  });
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      style={{ opacity: isDragging ? 0.35 : undefined, touchAction: "none" }}
      data-drag={`turn:${followUpId}`}
    >
      {children}
    </div>
  );
}

/**
 * ドラッグできる AI カード（AI レーンのブロック）。別の AI カードを落とす的も兼ねる（統合の確認）。
 * 位置（absolute の top / left / width / height）はこの要素に付け、中のブロックは全面に広げる
 */
export function DraggableAi({
  dragId,
  workItemId,
  title,
  style,
  children,
}: {
  dragId: string;
  workItemId: string;
  title: string | null;
  style: React.CSSProperties;
  children: ReactNode;
}) {
  const dnd = useBoardDnd();
  const drag = useDraggable({
    id: `ai:${dragId}`,
    data: { kind: "ai", workItemId, title, grabOffsetMs: 0 } satisfies DragAi,
  });
  const drop = useDroppable({
    id: `aidrop:${workItemId}:${dragId}`,
    data: { kind: "ai", workItemId, title } satisfies DropData,
  });
  const hot =
    dnd?.active?.kind === "ai" &&
    dnd.over?.kind === "ai" &&
    dnd.over.workItemId === workItemId &&
    dnd.active.workItemId !== workItemId;
  return (
    <div
      ref={(el) => {
        drag.setNodeRef(el);
        drop.setNodeRef(el);
      }}
      {...drag.listeners}
      className={`absolute ${hot ? "z-20 rounded-chip outline outline-2 outline-accent" : ""}`}
      style={{ ...style, opacity: drag.isDragging ? 0.35 : undefined, touchAction: "none" }}
      data-drag={`ai:${dragId}`}
    >
      {children}
    </div>
  );
}

/**
 * 自分の番の行をドラッグできるようにする（ux-mvp 7章）。時間に置いていれば、その時刻を行に出す（`@15:00`。D-051）
 */
export function TurnDrag({
  item,
  blocks,
  tz,
  children,
}: {
  item: QueueItem;
  blocks: readonly TimeBlockView[];
  tz: string;
  children: (scheduledAt: string | null) => ReactNode;
}) {
  const { locale } = useI18n();
  const f = primaryFollowUp(item);
  const block = f?.taskId ? (blocks.find((b) => b.taskId === f.taskId) ?? null) : null;
  const at = block ? fmtClock(block.start, tz) : null;
  if (!f?.taskId) return <>{children(at)}</>;
  return (
    <DraggableTurn
      followUpId={f.id}
      taskId={f.taskId}
      taskDate={f.taskDate}
      title={titleText(f.title, locale)}
      block={block}
    >
      {children(at)}
    </DraggableTurn>
  );
}
