/**
 * 楽観的更新の書き換え（m2-api.md 4.4）。キャッシュの応答を不変に書き換える純粋関数。
 * サーバーの結果と同じになるように書き、確定後の再取得で表示が変わらないようにする。
 */
import type { BoardResponse, DayColumn, TaskView, TimeBlockView } from "./board.ts";
import type { QueueResponse } from "./queue.ts";
import type { InboxResponse } from "./tasks.ts";

const byOrder = (a: TaskView, b: TaskView) =>
  a.laneOrder < b.laneOrder ? -1 : a.laneOrder > b.laneOrder ? 1 : 0;

function mapDays(board: BoardResponse, f: (d: DayColumn) => DayColumn): BoardResponse {
  return { ...board, days: board.days.map(f) };
}

export function findTask(board: BoardResponse | undefined, id: string): TaskView | null {
  for (const d of board?.days ?? []) {
    const t = d.tasks.find((x) => x.id === id) ?? d.crossTasks.find((x) => x.id === id);
    if (t) return t;
  }
  return null;
}

/** タスクの属性を変える（同じ日に残る） */
export function patchTaskInBoard(
  board: BoardResponse,
  id: string,
  patch: Partial<TaskView>,
): BoardResponse {
  const f = (t: TaskView) => (t.id === id ? { ...t, ...patch } : t);
  return mapDays(board, (d) =>
    d.tasks.some((t) => t.id === id) || d.crossTasks.some((t) => t.id === id)
      ? { ...d, tasks: d.tasks.map(f), crossTasks: d.crossTasks.map(f) }
      : d,
  );
}

/** タスクを日付へ移す（null なら Inbox へ。ボードからは消える） */
export function moveTaskInBoard(
  board: BoardResponse,
  task: TaskView,
  date: string | null,
  laneOrder: string,
): BoardResponse {
  const moved = { ...task, scheduledDate: date, laneOrder };
  return mapDays(board, (d) => {
    const without = d.tasks.filter((t) => t.id !== task.id);
    const cross = d.crossTasks.filter((t) => t.id !== task.id);
    const base = cross.length === d.crossTasks.length ? d : { ...d, crossTasks: cross };
    if (d.date === date) return { ...base, tasks: [...without, moved].sort(byOrder) };
    return without.length === d.tasks.length ? base : { ...base, tasks: without };
  });
}

/**
 * タスクを日付の時間軸に置く（DnD。M2-18）: タスクをその日付へ移し、そのタスクのブロックを block に置き換える。
 * ブロックはタスクの日付の列に入れる（サーバーもタスクの列に入れる。0:00 をまたぐ分は再取得で両日に出る）
 */
export function placeTaskInBoard(
  board: BoardResponse,
  task: TaskView,
  date: string,
  block: TimeBlockView,
): BoardResponse {
  const moved =
    task.scheduledDate === date ? board : moveTaskInBoard(board, task, date, task.laneOrder);
  return mapDays(moved, (d) => {
    const blocks = d.timeBlocks.filter((b) => b.taskId !== task.id && b.id !== block.id);
    if (d.date === date) return { ...d, timeBlocks: [...blocks, block] };
    return blocks.length === d.timeBlocks.length ? d : { ...d, timeBlocks: blocks };
  });
}

/** 時間ブロックの時刻を変える（移動・伸縮） */
export function patchBlockInBoard(
  board: BoardResponse,
  blockId: string,
  range: { start: number; end: number },
): BoardResponse {
  return mapDays(board, (d) =>
    d.timeBlocks.some((b) => b.id === blockId)
      ? {
          ...d,
          timeBlocks: d.timeBlocks.map((b) => (b.id === blockId ? { ...b, ...range } : b)),
        }
      : d,
  );
}

/** 時間ブロックを外す（タスクは残り、Unscheduled に戻る） */
export function removeBlockFromBoard(board: BoardResponse, blockId: string): BoardResponse {
  return mapDays(board, (d) =>
    d.timeBlocks.some((b) => b.id === blockId)
      ? { ...d, timeBlocks: d.timeBlocks.filter((b) => b.id !== blockId) }
      : d,
  );
}

/** タスクの時間ブロック（無ければ null） */
export function findBlock(board: BoardResponse | undefined, taskId: string): TimeBlockView | null {
  for (const d of board?.days ?? []) {
    const b = d.timeBlocks.find((x) => x.taskId === taskId);
    if (b) return b;
  }
  return null;
}

export function removeTaskFromBoard(board: BoardResponse, id: string): BoardResponse {
  return mapDays(board, (d) =>
    d.tasks.some((t) => t.id === id) || d.crossTasks.some((t) => t.id === id)
      ? {
          ...d,
          tasks: d.tasks.filter((t) => t.id !== id),
          crossTasks: d.crossTasks.filter((t) => t.id !== id),
        }
      : d,
  );
}

export function addTaskToBoard(board: BoardResponse, task: TaskView): BoardResponse {
  return mapDays(board, (d) =>
    d.date === task.scheduledDate ? { ...d, tasks: [...d.tasks, task].sort(byOrder) } : d,
  );
}

export function addTaskToInbox(inbox: InboxResponse, task: TaskView): InboxResponse {
  return { ...inbox, tasks: [task, ...inbox.tasks.filter((t) => t.id !== task.id)] };
}

export function removeTaskFromInbox(inbox: InboxResponse, id: string): InboxResponse {
  return { ...inbox, tasks: inbox.tasks.filter((t) => t.id !== id) };
}

/** 自分の番を帯・キューから消す（スヌーズ・対応不要。完了は閉じた行として残すのでサーバーの再取得に任せる） */
export function removeFollowUpFromQueue(queue: QueueResponse, followUpId: string): QueueResponse {
  return {
    ...queue,
    items: queue.items
      .map((x) => ({ ...x, followUps: x.followUps.filter((f) => f.id !== followUpId) }))
      .filter((x) => x.followUps.length > 0),
  };
}

/**
 * `m` 明日（D-052 (1)）: タスクの日付を移し、スヌーズ中にする。帯・キュー・件数からは消え（visibleQueue は open だけ）、
 * シャットダウン Step 1 は taskDate で「→ Mon 10/5」と残す。スヌーズの終わりはサーバーが決める
 */
export function deferFollowUpInQueue(
  queue: QueueResponse,
  followUpId: string,
  taskDate: string,
): QueueResponse {
  return {
    ...queue,
    items: queue.items.map((x) => ({
      ...x,
      followUps: x.followUps.map((f) =>
        f.id === followUpId
          ? { ...f, status: "snoozed" as const, taskDate: f.taskId ? taskDate : f.taskDate }
          : f,
      ),
    })),
  };
}

/** スヌーズ: 帯・件数からは消え（visibleQueue は open だけ）、自分の番の画面の「後で」に移る。終わりの時刻は分かれば入れる */
export function snoozeFollowUpInQueue(
  queue: QueueResponse,
  followUpId: string,
  until: number | null,
): QueueResponse {
  return {
    ...queue,
    items: queue.items.map((x) => ({
      ...x,
      followUps: x.followUps.map((f) =>
        f.id === followUpId ? { ...f, status: "snoozed" as const, snoozeUntil: until } : f,
      ),
    })),
  };
}

/**
 * 今やる（スヌーズ解除・時間の割り当てを外す）: open に戻して帯に戻す。明日へ移したタスクは今日へ戻す。時間に置いた自分の番は
 * scheduledAt を外す（サーバーが開始の前の時間ブロックを消す）
 */
export function wakeFollowUpInQueue(
  queue: QueueResponse,
  followUpId: string,
  today: string,
): QueueResponse {
  return {
    ...queue,
    items: queue.items.map((x) => ({
      ...x,
      followUps: x.followUps.map((f) => {
        if (f.id !== followUpId) return f;
        const { scheduledAt: _, ...rest } = f;
        return {
          ...rest,
          status: "open" as const,
          snoozeUntil: null,
          taskDate: f.taskDate && f.taskDate > today ? today : f.taskDate,
        };
      }),
    })),
  };
}

/** リセット前の上限待ちを対応不要にした: 後での行から消す */
export function removeLimitWaitFromQueue(queue: QueueResponse, workItemId: string): QueueResponse {
  return {
    ...queue,
    ...(queue.limitWaits
      ? { limitWaits: queue.limitWaits.filter((x) => x.workItemId !== workItemId) }
      : {}),
  };
}

/** ⏎（engage）した印を付ける */
export function markEngagedInQueue(
  queue: QueueResponse,
  followUpId: string,
  at: number,
): QueueResponse {
  return {
    ...queue,
    items: queue.items.map((x) => ({
      ...x,
      followUps: x.followUps.map((f) =>
        f.id === followUpId ? { ...f, engagedAt: f.engagedAt ?? at, status: "open" as const } : f,
      ),
    })),
  };
}
