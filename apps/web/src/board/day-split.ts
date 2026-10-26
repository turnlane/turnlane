/**
 * 表示の日付と集計の日付（D-054、ux-mvp 4.4.1）。週ボードの列は暦日（0:00〜24:00）で、集計は論理日（日付区切り）。
 * 列にどのブロックを描くか、どのブロックが前日に計上されるかを純粋関数で決める。
 */
import {
  addDays,
  type DayColumn,
  type Interval,
  type TaskView,
  type TimeBlockView,
} from "@turnlane/core/web";

/** タスクを時間軸に置く位置: 時間ブロック（計画）か、完了の実績。どちらも無ければ Unscheduled */
export interface Placement {
  task: TaskView;
  at: Interval;
  variant: "planned" | "done";
  overlapMs: number;
  /** 前日の日付のタスクを 0:00 以降に描いている（ホバーで `Counted in` を出す） */
  cross: boolean;
  /** 置いた時間ブロック（完了の実績で置いたものは null）。移動・伸縮はこのブロックを動かす */
  block: TimeBlockView | null;
}

type PlaceDay = Pick<
  DayColumn,
  "tasks" | "crossTasks" | "timeBlocks" | "timeEntries" | "events" | "axis" | "logical"
>;

const hits = (b: Interval, iv: Interval) => b.end > iv.start && b.start < iv.end;

/**
 * この列でタスクを置く時間ブロック。timeBlocks にはこの列のタスクのブロックが他の日のものも入る（時間軸にかからない
 * ものも。サーバーの board.ts）ので、先頭のものではなく、この列の時間軸にかかるものを選ぶ。その日の日付のタスクは、
 * 時間軸の後ろの論理日（翌日 0:00〜日付区切り）にかかるものも選ぶ（翌日の列に描き、Unscheduled にしない）。
 * どれにもかからなければ null（別の日に残ったブロックだけなら Unscheduled に出す）
 */
function blockOf(day: PlaceDay, task: TaskView, cross: boolean): TimeBlockView | null {
  const mine = day.timeBlocks.filter((b) => b.taskId === task.id);
  const onAxis = mine.find((b) => hits(b, day.axis));
  if (onAxis || cross) return onAxis ?? null;
  const tail = { start: day.axis.end, end: Math.max(day.axis.end, day.logical.end) };
  return mine.find((b) => hits(b, tail)) ?? null;
}

function placeOf(day: PlaceDay, task: TaskView, cross: boolean): Placement | null {
  const busy = day.events.filter((e) => e.busy);
  const block = blockOf(day, task, cross);
  const entries = day.timeEntries.filter((e) => e.taskId === task.id);
  if (block) {
    const overlapMs =
      task.status === "done"
        ? 0
        : busy.reduce(
            (a, e) => a + Math.max(0, Math.min(e.end, block.end) - Math.max(e.start, block.start)),
            0,
          );
    return {
      task,
      at: { start: block.start, end: block.end },
      variant: task.status === "done" ? "done" : "planned",
      overlapMs,
      cross,
      block,
    };
  }
  if (task.status === "done" && entries.length > 0) {
    const start = Math.min(...entries.map((e) => e.start));
    const end = Math.max(...entries.map((e) => e.end ?? e.start));
    return { task, at: { start, end }, variant: "done", overlapMs: 0, cross, block: null };
  }
  return null;
}

/**
 * 自分の番への対応（返答・レビュー・許可など）か（D-074）: 自分の番のタスクを時間ブロック無しで完了し、実績だけで
 * 時間軸に置いたもの。自分レーンのブロックにせず、AI レーンの待ちの終点に `↩ 8m` の印で出す。
 * 自分の番を時間に置いた（ブロックがある）ものは計画なので自分レーンに描く
 */
export function isReply(p: Placement): boolean {
  return p.task.followUpId !== null && p.variant === "done" && p.block === null;
}

/**
 * 列のタスクの置き場所。その日のタスクは時間に置いたものと Unscheduled に分け、時間に置いたもののうち自分の番への対応
 * （isReply）は replies に分ける（D-074）。前日の日付のタスク（crossTasks）は 0:00 をまたいだブロックを描くためだけに置き、
 * Unscheduled には入れない。描くときは時間軸で切る（両日に分けて描く）
 */
export function placementsOf(day: PlaceDay): {
  placed: Placement[];
  unscheduled: TaskView[];
  replies: Placement[];
} {
  const placed: Placement[] = [];
  const unscheduled: TaskView[] = [];
  const replies: Placement[] = [];
  const put = (p: Placement) => (isReply(p) ? replies : placed).push(p);
  for (const task of day.tasks) {
    const p = placeOf(day, task, false);
    if (p) put(p);
    else unscheduled.push(task);
  }
  for (const task of day.crossTasks ?? []) {
    const p = placeOf(day, task, true);
    if (p) put(p);
  }
  return { placed, unscheduled, replies };
}

/**
 * 区間を時間軸で切ったとき、0:00〜日付区切り（axis.start〜logical.start）に始まるなら、計上する前日の日付を返す。
 * それ以外（その日の論理日に入る）は null
 */
export function countedInDate(
  day: Pick<DayColumn, "date" | "axis" | "logical">,
  at: Interval,
): string | null {
  const start = Math.max(at.start, day.axis.start);
  if (start >= day.axis.end || at.end <= day.axis.start) return null;
  return start < day.logical.start ? addDays(day.date, -1) : null;
}

/**
 * 計画の目安の窓（D-106）: 範囲外のヒントの「夜」の判定と AI レーンの初期位置に使う。稼働日でなければ無し。
 * 時間軸の背景は一様で、この窓で塗り分けない（D-105 で勤務時間の背景をやめた）
 */
export function planWindows(day: Pick<DayColumn, "plannedHours">): Interval[] {
  return day.plannedHours ? [day.plannedHours] : [];
}

/**
 * AI レーンで持ち越しのブロックを置く上端（D-105）: 今日は計画の目安の開始と今の早い方、他の日は計画の目安の開始
 * （無ければ時間軸の始まり）
 */
export function laneTopOf(
  day: Pick<DayColumn, "phase" | "plannedHours" | "axis">,
  now: number,
): number {
  const plan = day.plannedHours?.start ?? null;
  if (day.phase === "today") return Math.max(day.axis.start, Math.min(plan ?? now, now));
  return plan ?? day.axis.start;
}
