/**
 * 操作と楽観的更新（m2-api.md 4.4）。定型: 影響するキーの取得を止める → 直前の値を退避 → 書き換え → 失敗したら戻して
 * トースト（Couldn't save. Restored.）→ 終わったら影響するキーを無効化。書き換えは core の純粋関数で行う。
 */

import type { Query } from "@tanstack/react-query";
import {
  type AiLaunchInput,
  type AiLaunchResult,
  addTaskToBoard,
  addTaskToInbox,
  type BoardResponse,
  type CalendarColorKey,
  type CalendarEventDetail,
  type CalendarEventView,
  type CarryDayResponse,
  type DayResponse,
  dayDiff,
  deferFollowUpInQueue,
  type FocusView,
  findBlock,
  findTask,
  type InboxResponse,
  markEngagedInQueue,
  moveTaskInBoard,
  type OpenAction,
  type OpenResult,
  openLandingText,
  orderKeyAfter,
  orderKeyBetween,
  parseTask,
  patchBlockInBoard,
  patchTaskInBoard,
  placeTaskInBoard,
  type QueueResponse,
  removeBlockFromBoard,
  removeFollowUpFromQueue,
  removeLimitWaitFromQueue,
  removeTaskFromBoard,
  removeTaskFromInbox,
  shiftByDays,
  snoozeFollowUpInQueue,
  type TaskView,
  type TaskWriteResponse,
  type TimeBlockView,
  type TimeBlockWriteResponse,
  type UpdateStatus,
  uuidv7,
  type WorktreeCleanupResult,
  wakeFollowUpInQueue,
} from "@turnlane/core/web";
import { getLocale } from "../i18n/current.ts";
import { type MessageKey, translate } from "../i18n/index.tsx";
import { prepareFinish } from "../launch/finish.ts";
import { ApiError, api, unwrap } from "../lib/api.ts";
import { inDesktop } from "../lib/desktop.ts";
import { openInApp } from "../lib/open.ts";
import { getUi, LINGER_MS, setUi, toast } from "../lib/store.ts";
import { queryClient } from "./client.ts";
import { keys } from "./invalidate.ts";
import { rememberLanding } from "./landing.ts";
import { currentToday } from "./sse.ts";

type Pred = (q: Query) => boolean;

/** 週ボードとデイビュー（デイビューは1日分の週ボードとして書き換える。setBoard） */
const isBoard: Pred = (q) => q.queryKey[0] === "board" || q.queryKey[0] === "day";
const isInbox: Pred = (q) => q.queryKey[0] === "inbox";
const isQueue: Pred = (q) => q.queryKey[0] === "queue";

async function optimistic<T>(
  affected: Pred,
  apply: (q: Query) => void,
  run: () => Promise<T>,
): Promise<T | null> {
  await queryClient.cancelQueries({ predicate: affected });
  const snap = queryClient
    .getQueryCache()
    .findAll({ predicate: affected })
    .map((q) => [q.queryKey, q.state.data] as const);
  for (const q of queryClient.getQueryCache().findAll({ predicate: affected })) apply(q);
  try {
    return await run();
  } catch {
    for (const [k, v] of snap) queryClient.setQueryData(k, v);
    toast(translate(getLocale(), "toast.saveFailed"));
    return null;
  } finally {
    void queryClient.invalidateQueries({ predicate: affected });
  }
}

/** デイビューの応答を1日分の週ボードとして読む（DayDetail は DayColumn と互換） */
function asBoard(q: Query): BoardResponse | undefined {
  const d = q.state.data as BoardResponse | DayResponse | undefined;
  if (!d) return undefined;
  return "day" in d ? { ...d, days: [d.day] } : d;
}

function setBoard(q: Query, f: (b: BoardResponse) => BoardResponse) {
  const d = q.state.data as BoardResponse | DayResponse | undefined;
  if (!d) return;
  if ("day" in d) {
    const next = f({ ...d, days: [d.day] }).days[0];
    // 書き換えは DayColumn の部分だけ（AI レーン・集計の詳細はそのまま。確定後の再取得で揃う）
    if (next) queryClient.setQueryData(q.queryKey, { ...d, day: { ...d.day, ...next } });
  } else queryClient.setQueryData(q.queryKey, f(d));
}
function setInbox(q: Query, f: (b: InboxResponse) => InboxResponse) {
  const d = q.state.data as InboxResponse | undefined;
  if (d) queryClient.setQueryData(q.queryKey, f(d));
}
function setQueue(q: Query, f: (b: QueueResponse) => QueueResponse) {
  const d = q.state.data as QueueResponse | undefined;
  if (d) queryClient.setQueryData(q.queryKey, f(d));
}

const either =
  (...ps: Pred[]): Pred =>
  (q) =>
    ps.some((p) => p(q));

/** 新しいタスク（c）。raw は NL パーサを通す（サーバーでも同じパーサ）。date が null なら Inbox */
export async function createTask(p: {
  raw: string;
  date: string | null;
  estimateMin?: number;
  /** デスクトップアプリのクイック入力（Inbox の経由の印 `Quick add`） */
  source?: "desktop";
}): Promise<TaskView | null> {
  const id = uuidv7();
  const now = Date.now();
  const parsed = parseTask(p.raw, { today: currentToday() || p.date || "1970-01-01" });
  const date = parsed.inbox ? null : (parsed.date ?? p.date);
  const temp: TaskView = {
    id,
    title: { t: "text", text: parsed.title },
    status: "todo",
    scheduledDate: date,
    laneOrder: "~",
    estimateMin: p.estimateMin ?? parsed.estimateMin,
    projectId: null,
    rolloverCount: 0,
    isHighlight: false,
    completedAt: null,
    autoCompleted: false,
    origin: { source: p.source ?? "manual", client: null, externalSource: null, externalUrl: null },
    followUpId: null,
    workItemId: null,
    createdAt: now,
    deletedAt: null,
  };
  const r = await optimistic(
    either(isBoard, isInbox),
    (q) => {
      if (isBoard(q)) setBoard(q, (b) => addTaskToBoard(b, temp));
      else if (temp.scheduledDate === null) setInbox(q, (b) => addTaskToInbox(b, temp));
    },
    () =>
      unwrap<TaskWriteResponse>(
        api.api.tasks.$post({
          json: {
            raw: p.raw,
            clientId: id,
            // パーサが日付を読まなかったときだけ、選んでいるカラムの日付を使う
            ...(parsed.date === null && !parsed.inbox ? { date: p.date } : {}),
            ...(p.estimateMin !== undefined ? { estimateMin: p.estimateMin } : {}),
            ...(p.source ? { source: p.source } : {}),
          },
        }),
      ),
  );
  return r?.task ?? null;
}

export async function renameTask(task: TaskView, title: string): Promise<void> {
  await optimistic(
    either(isBoard, isInbox, isQueue),
    (q) => {
      if (isBoard(q))
        setBoard(q, (b) => patchTaskInBoard(b, task.id, { title: { t: "text", text: title } }));
      if (isInbox(q))
        setInbox(q, (b) => ({
          ...b,
          tasks: b.tasks.map((t) =>
            t.id === task.id ? { ...t, title: { t: "text", text: title } } : t,
          ),
        }));
    },
    () => unwrap(api.api.tasks[":id"].$patch({ param: { id: task.id }, json: { title } })),
  );
}

/**
 * 完了 / 未完了（Space・○・メニュー・詳細パネル。全画面）。完了は「完了にしました · 元に戻す」の知らせを出し、⌘Z で前の状態
 * （todo / doing）に戻す（D-139 (3)）。日付と並びは完了で変わらないので、戻すと元の場所に出る。完了と一緒に閉じた自分の番も
 * 開き直す。undoable: false は取り消しを積まない（まとめて完了する completeItems が1つにまとめる）。
 * AI に頼むで起動した作業が生きていれば、先に完了のシート（片付け）を出す。Esc で取り消したら完了にしない
 */
export async function setComplete(
  task: TaskView,
  done: boolean,
  opts: { undoable?: boolean } = {},
): Promise<void> {
  if (done && !(await prepareFinish([task]))) return;
  const undo = await writeComplete(task, done);
  if (undo && opts.undoable !== false) {
    pushUndo(undo);
    completedToast(1);
  }
}

/** 完了・未完了を書く。完了にしたら取り消しの関数を返す（失敗・未完了・もともと完了なら null） */
async function writeComplete(task: TaskView, done: boolean): Promise<(() => Promise<void>) | null> {
  const now = Date.now();
  const prev = task.status === "doing" ? "doing" : "todo";
  const r = await optimistic(
    either(isBoard, isInbox, isQueue),
    (q) => {
      if (isBoard(q))
        setBoard(q, (b) =>
          patchTaskInBoard(b, task.id, {
            status: done ? "done" : "todo",
            completedAt: done ? now : null,
          }),
        );
      // Inbox は「今日閉じた」へ移す。完了にした直後の行は画面がしばらくその場に残す（recentDone。D-139 (4)）
      if (isInbox(q))
        setInbox(q, (b) =>
          done
            ? {
                ...removeTaskFromInbox(b, task.id),
                closed: [
                  { ...task, status: "done", completedAt: now },
                  ...(b.closed ?? []).filter((x) => x.id !== task.id),
                ],
              }
            : inboxReopen(b, task, task.status === "doing" ? "doing" : "todo"),
        );
    },
    () =>
      unwrap<TaskWriteResponse>(
        done
          ? api.api.tasks[":id"].complete.$post({ param: { id: task.id } })
          : api.api.tasks[":id"].uncomplete.$post({ param: { id: task.id }, json: {} }),
      ),
  );
  if (done && r) markRecentDone(task.id);
  if (!done) clearRecentDone(task.id);
  if (!done || !r || task.status === "done") return null;
  const reopen = r.closedFollowUps ?? [];
  return () => uncompleteTask(task, prev, reopen);
}

/** 完了の取り消し: 前の状態へ戻し、完了と一緒に閉じた自分の番を開き直す。Inbox のタスクは Inbox に戻す */
async function uncompleteTask(
  task: TaskView,
  status: "todo" | "doing",
  reopenFollowUps: string[],
): Promise<void> {
  await optimistic(
    either(isBoard, isInbox, isQueue),
    (q) => {
      if (isBoard(q))
        setBoard(q, (b) => patchTaskInBoard(b, task.id, { status, completedAt: null }));
      if (isInbox(q) && task.scheduledDate === null)
        setInbox(q, (b) => inboxReopen(b, task, status));
    },
    () =>
      unwrap(
        api.api.tasks[":id"].uncomplete.$post({
          param: { id: task.id },
          json: { status, ...(reopenFollowUps.length > 0 ? { reopenFollowUps } : {}) },
        }),
      ),
  );
  clearRecentDone(task.id);
  void queryClient.invalidateQueries({ queryKey: keys.task(task.id) });
}

/** Inbox に未完了で戻す: 「今日閉じた」から外し、作成の新しい順の元の位置へ入れる */
function inboxReopen(b: InboxResponse, task: TaskView, status: "todo" | "doing"): InboxResponse {
  const closed = (b.closed ?? []).filter((c) => c.id !== task.id);
  if (task.scheduledDate !== null || b.tasks.some((x) => x.id === task.id)) return { ...b, closed };
  const back = { ...task, status, completedAt: null };
  const i = b.tasks.findIndex((x) => x.createdAt < task.createdAt);
  const tasks = [...b.tasks];
  tasks.splice(i < 0 ? tasks.length : i, 0, back);
  return { ...b, tasks, closed };
}

/** いま完了にしたタスクの印（Inbox の行をその場に LINGER_MS 残す。D-139 (4)） */
function markRecentDone(id: string): void {
  const at = Date.now();
  setUi((s) => ({ recentDone: { ...s.recentDone, [id]: at } }));
  setTimeout(() => {
    if (getUi().recentDone[id] === at) clearRecentDone(id);
  }, LINGER_MS);
}

function clearRecentDone(id: string): void {
  if (!(id in getUi().recentDone)) return;
  setUi((s) => {
    const { [id]: _, ...rest } = s.recentDone;
    return { recentDone: rest };
  });
}

/** 「完了にしました · 元に戻す」（D-139 (3)。削除の知らせと同じ形） */
function completedToast(count: number): void {
  const locale = getLocale();
  toast(
    count > 1
      ? translate(locale, "toast.completedMany", { count })
      : translate(locale, "toast.completed"),
    { label: translate(locale, "action.undo"), run: () => void undoLast() },
  );
}

/**
 * まとめて完了（複数選択の Space・自分の番の画面の一括）: タスクは1件ずつ切り替え（完了済みは未完了に戻す）、自分の番は完了。
 * 完了にした分は知らせ1つと ⌘Z 1回でまとめて戻す。完了にするタスクに生きている AI の起動があれば先に完了のシートを出す
 * （Esc で取り消したら何もしない）
 */
export async function completeItems(tasks: TaskView[], followUpIds: string[]): Promise<void> {
  if (!(await prepareFinish(tasks.filter((x) => x.status !== "done")))) return;
  const undos = (
    await Promise.all([
      ...tasks.map((x) => writeComplete(x, x.status !== "done")),
      ...followUpIds.map((id) => writeFollowUpComplete(id)),
    ])
  ).filter((f): f is () => Promise<void> => f !== null);
  if (undos.length === 0) return;
  pushUndo(async () => {
    await Promise.all(undos.map((f) => f()));
  });
  completedToast(undos.length);
}

/** キャッシュの週ボード（どれか1つ。タスク・ブロックを探す・並びのキーを仮に決めるのに使う） */
function boards(): BoardResponse[] {
  return queryClient
    .getQueryCache()
    .findAll({ predicate: isBoard })
    .map(asBoard)
    .filter((b): b is BoardResponse => b !== undefined);
}

function cachedTask(id: string): TaskView | null {
  for (const b of boards()) {
    const t = findTask(b, id);
    if (t) return t;
  }
  return null;
}

function cachedBlock(taskId: string): TimeBlockView | null {
  for (const b of boards()) {
    const x = findBlock(b, taskId);
    if (x) return x;
  }
  return null;
}

function boardTz(): string {
  return boards()[0]?.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** 移した後の並びのキーを仮に決める（サーバーの結果で確定する。m2-api 4.4） */
function laneOrderFor(
  task: TaskView,
  date: string | null,
  beforeId: string | null | undefined,
  afterId: string | null | undefined,
): string {
  try {
    if (beforeId || afterId) {
      const a = beforeId ? (cachedTask(beforeId)?.laneOrder ?? null) : null;
      const b = afterId ? (cachedTask(afterId)?.laneOrder ?? null) : null;
      return orderKeyBetween(a, b);
    }
    if (task.scheduledDate === date) return task.laneOrder;
    const last = boards()
      .flatMap((b) => b.days.filter((d) => d.date === date).flatMap((d) => d.tasks))
      .filter((t) => t.id !== task.id)
      .map((t) => t.laneOrder)
      .sort()
      .at(-1);
    return orderKeyAfter(last ?? null);
  } catch {
    return "~";
  }
}

/** 今の位置（日付と前後）。⌘Z で元の場所へ戻すのに使う */
function positionOf(task: TaskView): {
  date: string | null;
  beforeId: string | null;
  afterId: string | null;
} {
  const day = boards()
    .flatMap((b) => b.days)
    .find((d) => d.date === task.scheduledDate && d.tasks.some((t) => t.id === task.id));
  if (!day) return { date: task.scheduledDate, beforeId: null, afterId: null };
  const ids = [...day.tasks].sort((a, b) => (a.laneOrder < b.laneOrder ? -1 : 1)).map((t) => t.id);
  const i = ids.indexOf(task.id);
  return { date: task.scheduledDate, beforeId: ids[i - 1] ?? null, afterId: ids[i + 1] ?? null };
}

function moveJson(
  date: string | null,
  opts: { afterId?: string | null | undefined; beforeId?: string | null | undefined },
) {
  return {
    date,
    ...(opts.afterId ? { afterId: opts.afterId } : {}),
    ...(opts.beforeId ? { beforeId: opts.beforeId } : {}),
  };
}

/**
 * 日付の移動・並べ替え（m・> / <・t・DnD）。手での移動は持ち越し回数を数えない（D-047 (4)）。
 * 時間に置いたタスクを別の日へ移すときは、ブロックも同じ時刻のまま日をずらす（Inbox へ移すときはブロックを外す）。
 * undoable なら ⌘Z で元の日付と並びへ戻す
 */
export async function moveTask(
  task: TaskView,
  date: string | null,
  opts: { afterId?: string | null; beforeId?: string | null; undoable?: boolean } = {},
): Promise<void> {
  const block = task.scheduledDate !== date ? cachedBlock(task.id) : null;
  const tz = boardTz();
  const shifted =
    block && date !== null && task.scheduledDate !== null
      ? (() => {
          const n = dayDiff(task.scheduledDate as string, date);
          return { start: shiftByDays(block.start, n, tz), end: shiftByDays(block.end, n, tz) };
        })()
      : null;
  const from = opts.undoable ? positionOf(task) : null;
  const laneOrder = laneOrderFor(task, date, opts.beforeId, opts.afterId);
  const ok = await optimistic(
    either(isBoard, isInbox),
    (q) => {
      if (isBoard(q))
        setBoard(q, (b) => {
          let x = moveTaskInBoard(b, task, date, laneOrder);
          if (block && shifted) x = patchBlockInBoard(x, block.id, shifted);
          else if (block) x = removeBlockFromBoard(x, block.id);
          return x;
        });
      if (isInbox(q))
        setInbox(q, (b) =>
          date === null
            ? addTaskToInbox(b, { ...task, scheduledDate: null })
            : removeTaskFromInbox(b, task.id),
        );
    },
    async () => {
      const r = await unwrap(
        api.api.tasks[":id"].move.$post({ param: { id: task.id }, json: moveJson(date, opts) }),
      );
      if (block && shifted)
        await unwrap(
          api.api["time-blocks"][":id"].$patch({
            param: { id: block.id },
            json: { startAt: shifted.start, endAt: shifted.end },
          }),
        );
      else if (block)
        await unwrap(api.api["time-blocks"][":id"].$delete({ param: { id: block.id } }));
      return r;
    },
  );
  if (ok && from) {
    pushUndo(async () => {
      const cur = cachedTask(task.id) ?? { ...task, scheduledDate: date, laneOrder };
      await moveTask(cur, from.date, { beforeId: from.beforeId, afterId: from.afterId });
      // Inbox へ移して外したブロックは削除済みなので、同じ時刻で作り直す
      if (block && !shifted && from.date)
        await placeTask(cachedTask(task.id) ?? cur, from.date, { ...block, id: uuidv7() });
    });
  }
}

/**
 * 時間に置く（DnD。M2-18）: タスクを date へ移し、時間ブロックを range にする（無ければ作る）。
 * 書き戻し（Turnlane カレンダー）は M3-3 で足す。それまでブロックは pending のまま保存する
 */
export async function scheduleTask(
  task: TaskView,
  date: string,
  range: { start: number; end: number },
): Promise<void> {
  const prevBlock = cachedBlock(task.id);
  const from = positionOf(task);
  const ok = await placeTask(task, date, {
    id: prevBlock?.id ?? uuidv7(),
    taskId: task.id,
    title: null,
    start: range.start,
    end: range.end,
  });
  if (!ok) return;
  pushUndo(async () => {
    const cur = cachedTask(task.id) ?? { ...task, scheduledDate: date };
    if (prevBlock) await placeTask(cur, from.date ?? date, prevBlock);
    else await unscheduleTask(cur, { undoable: false });
    if (from.date !== date)
      await moveTask(cachedTask(task.id) ?? cur, from.date, {
        beforeId: from.beforeId,
        afterId: from.afterId,
      });
  });
}

/** タスクを date へ移し、ブロックを block にする（既にあれば時刻を変え、無ければ block.id で作る） */
async function placeTask(task: TaskView, date: string, block: TimeBlockView): Promise<boolean> {
  const existing = cachedBlock(task.id);
  const r = await optimistic(
    either(isBoard, isInbox),
    (q) => {
      if (isBoard(q))
        setBoard(q, (b) =>
          placeTaskInBoard(b, task, date, { ...block, id: existing?.id ?? block.id }),
        );
      if (isInbox(q) && task.scheduledDate === null)
        setInbox(q, (b) => removeTaskFromInbox(b, task.id));
    },
    async () => {
      if (task.scheduledDate !== date)
        await unwrap(api.api.tasks[":id"].move.$post({ param: { id: task.id }, json: { date } }));
      if (existing)
        return unwrap<TimeBlockWriteResponse>(
          api.api["time-blocks"][":id"].$patch({
            param: { id: existing.id },
            json: { startAt: block.start, endAt: block.end },
          }),
        );
      return unwrap<TimeBlockWriteResponse>(
        api.api["time-blocks"].$post({
          json: { taskId: task.id, startAt: block.start, endAt: block.end, clientId: block.id },
        }),
      );
    },
  );
  return r !== null;
}

/**
 * 時間ブロックだけを外す（⌫、時間軸から Unscheduled へのドラッグ）。タスクは残る。
 * date を渡したら、その日付の Unscheduled へ移す（並びは beforeId / afterId）
 */
export async function unscheduleTask(
  task: TaskView,
  opts: {
    date?: string | null;
    beforeId?: string | null;
    afterId?: string | null;
    undoable?: boolean;
  } = {},
): Promise<void> {
  const block = cachedBlock(task.id);
  const date = opts.date === undefined ? task.scheduledDate : opts.date;
  if (!block) {
    if (date !== task.scheduledDate || opts.beforeId || opts.afterId)
      await moveTask(task, date, { ...opts, undoable: opts.undoable !== false });
    return;
  }
  const from = positionOf(task);
  const laneOrder = laneOrderFor(task, date, opts.beforeId, opts.afterId);
  const ok = await optimistic(
    either(isBoard, isInbox),
    (q) => {
      if (isBoard(q))
        setBoard(q, (b) =>
          moveTaskInBoard(removeBlockFromBoard(b, block.id), task, date, laneOrder),
        );
      if (isInbox(q) && date === null)
        setInbox(q, (b) => addTaskToInbox(b, { ...task, scheduledDate: null }));
    },
    async () => {
      await unwrap(api.api["time-blocks"][":id"].$delete({ param: { id: block.id } }));
      if (date !== task.scheduledDate || opts.beforeId || opts.afterId)
        await unwrap(
          api.api.tasks[":id"].move.$post({ param: { id: task.id }, json: moveJson(date, opts) }),
        );
      return true;
    },
  );
  if (ok && opts.undoable !== false)
    pushUndo(async () => {
      const cur = cachedTask(task.id) ?? { ...task, scheduledDate: date };
      // 外したブロックは削除済みなので、同じ時刻で作り直す
      await placeTask(cur, from.date ?? date ?? task.scheduledDate ?? "", {
        ...block,
        id: uuidv7(),
      });
    });
}

/** 時間ブロックの時刻を変える（下端の伸縮）。⌘Z で元へ */
export async function patchBlock(
  block: TimeBlockView,
  range: { start: number; end: number },
): Promise<void> {
  const ok = await optimistic(
    isBoard,
    (q) => setBoard(q, (b) => patchBlockInBoard(b, block.id, range)),
    () =>
      unwrap(
        api.api["time-blocks"][":id"].$patch({
          param: { id: block.id },
          json: { startAt: range.start, endAt: range.end },
        }),
      ),
  );
  if (ok)
    pushUndo(() => patchBlock({ ...block, ...range }, { start: block.start, end: block.end }));
}

/** 範囲選択から新規（タスク＋時間ブロック）。⌘Z でタスクごと消す */
export async function createTaskWithBlock(p: {
  raw: string;
  date: string;
  range: { start: number; end: number };
}): Promise<TaskView | null> {
  const task = await createTask({ raw: p.raw, date: p.date });
  if (!task?.scheduledDate) return task;
  const ok = await placeTask(task, task.scheduledDate, {
    id: uuidv7(),
    taskId: task.id,
    title: null,
    start: p.range.start,
    end: p.range.end,
  });
  if (ok) pushUndo(() => deleteTask(task, { undoable: false }));
  return task;
}

/** 削除（⌘⌫）。トーストの「元に戻す」と ⌘Z で restore */
export async function deleteTask(task: TaskView, opts: { undoable?: boolean } = {}): Promise<void> {
  const ok = await optimistic(
    either(isBoard, isInbox),
    (q) => {
      if (isBoard(q)) setBoard(q, (b) => removeTaskFromBoard(b, task.id));
      if (isInbox(q)) setInbox(q, (b) => removeTaskFromInbox(b, task.id));
    },
    () => unwrap(api.api.tasks[":id"].$delete({ param: { id: task.id } })),
  );
  if (ok && opts.undoable !== false) {
    pushUndo(() => restoreTask(task));
    const locale = getLocale();
    toast(translate(locale, "toast.deleted"), {
      label: translate(locale, "action.undo"),
      run: () => void undoLast(),
    });
  }
}

export async function restoreTask(task: TaskView): Promise<void> {
  await optimistic(
    either(isBoard, isInbox),
    (q) => {
      if (isBoard(q)) setBoard(q, (b) => addTaskToBoard(b, task));
      if (isInbox(q) && task.scheduledDate === null) setInbox(q, (b) => addTaskToInbox(b, task));
    },
    () => unwrap(api.api.tasks[":id"].restore.$post({ param: { id: task.id } })),
  );
}

// ---------- ⌘Z ----------
const undoStack: (() => Promise<void>)[] = [];
export function pushUndo(f: () => Promise<void>): void {
  undoStack.push(f);
  if (undoStack.length > 20) undoStack.shift();
}
export async function undoLast(): Promise<void> {
  const f = undoStack.pop();
  if (f) await f();
}

// ---------- 自分の番 ----------

/**
 * タスクから開く（D-059。ux-mvp 4.11、m2-api 13章）: ⏎ は既定の開き先、`o` のメニューは action を指定する。
 * 開く先の解決と起動・対応中の印はデーモンが行う（ID だけを送る）。
 * コピーはクリック・キー操作の中で始める必要がある（WebKit は操作の外の clipboard.writeText を拒む。Safari と
 * デスクトップアプリの WKWebView。desktop-shell.md 2.6）ので、await の前にリクエストとコピーを始める
 */
export async function openTask(p: {
  followUpId?: string;
  workItemId?: string;
  action?: OpenAction;
}): Promise<OpenResult | null> {
  const req = unwrap<OpenResult>(
    api.api.open.$post({
      json: {
        ...(p.followUpId ? { followUpId: p.followUpId } : { workItemId: p.workItemId }),
        ...(p.action ? { action: p.action } : {}),
      },
    }),
  );
  const copied = writeClipboardLater(
    req.then(
      (r) => r.command,
      () => null,
    ),
  );
  const fid = p.followUpId;
  if (fid) {
    const now = Date.now();
    for (const q of queryClient.getQueryCache().findAll({ predicate: isQueue }))
      setQueue(q, (x) => markEngagedInQueue(x, fid, now));
  }
  const loc = getLocale();
  try {
    const r = await req;
    await copied;
    const app = r.app ?? "";
    // 動いているセッションの着地（D-214 (4)）: 行に残し、知らせで言う
    if (r.outcome === "focused" && r.landing && fid)
      rememberLanding(fid, { app, landing: r.landing, at: Date.now() });
    if (r.fallback) openFallbackToast(r, loc);
    else if (r.outcome === "focused" && r.landing) toast(openLandingText(app, r.landing, loc));
    else if (r.outcome === "typed") toast(translate(loc, "toast.open.typed", { app }));
    else if (r.outcome === "opened_copied")
      toast(translate(loc, "toast.open.openedCopied", { app }));
    else if (r.outcome === "copied") toast(translate(loc, "toast.resumeCopied"));
    return r;
  } catch {
    toast(translate(loc, "toast.open.failed"));
    return null;
  } finally {
    if (fid) void queryClient.invalidateQueries({ predicate: isQueue });
  }
}

/**
 * 最初の開き方が失敗して別の開き方に落ちたときの知らせ（B-5。D-193）: 理由ごとの文（6 秒。普通の知らせより長い）。
 * 「コマンドはコピーしました」は実際にコピーに落ちたときだけ。ボタンは automation_denied でデスクトップアプリのときだけ
 * 「システム設定を開く」（オートメーションの画面）、no_terminal は「設定」
 */
export function openFallbackToast(r: OpenResult, loc: ReturnType<typeof getLocale>): void {
  const f = r.fallback;
  if (!f) return;
  const app = f.app ?? r.app ?? "";
  const copiedNote =
    r.outcome === "opened_copied" || r.outcome === "copied"
      ? ` ${translate(loc, "open.fail.copied")}`
      : "";
  if (f.reason === "automation_denied") {
    toast(
      `${translate(loc, "open.fail.automation_denied", { app })}${copiedNote}`,
      inDesktop()
        ? {
            label: translate(loc, "open.fail.openSettings"),
            run: () =>
              void api.api.desktop.notifications
                .$post({ json: { action: "open_automation_settings" } })
                .catch(() => {}),
          }
        : undefined,
      OPEN_FAIL_TOAST_MS,
    );
    return;
  }
  if (f.reason === "automation_timeout") {
    toast(
      `${translate(loc, "open.fail.automation_timeout", { button: translate(loc, "launch.openSession") })}${copiedNote}`,
      undefined,
      OPEN_FAIL_TOAST_MS,
    );
    return;
  }
  toast(
    `${translate(loc, "open.fail.no_terminal", { app })}${copiedNote}`,
    { label: translate(loc, "nav.settings"), run: () => openInApp("/settings#open") },
    OPEN_FAIL_TOAST_MS,
  );
}

/** 開くの失敗の知らせの長さ（普通の知らせより長い。B-5） */
export const OPEN_FAIL_TOAST_MS = 6000;

/**
 * クリップボードへ書く。中身がまだ無い（fetch の途中）ときは ClipboardItem に Promise を渡し、操作の中で書き込みを始める。
 * 中身が無い（null）ときは書かない（今のクリップボードを消さない）
 */
export function writeClipboardLater(text: Promise<string | null>): Promise<boolean> {
  if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
    const blob = text.then((t) => {
      if (t === null) throw new Error("nothing to copy");
      return new Blob([t], { type: "text/plain" });
    });
    // コピーするものが無い（端末で開けた）ときの失敗を、処理されない拒否としてページのエラーにしない
    blob.catch(() => {});
    return navigator.clipboard.write([new ClipboardItem({ "text/plain": blob })]).then(
      () => true,
      () => false,
    );
  }
  return text.then(async (t) => {
    if (t === null || !navigator.clipboard) return false;
    return navigator.clipboard.writeText(t).then(
      () => true,
      () => false,
    );
  });
}

/** スヌーズの選び方: 決まった長さ（終わりはサーバーが決める）か、「時刻を指定…」で読んだ時刻（epoch ms） */
export type SnoozeChoice = "30m" | "1h" | "tomorrow_morning" | { until: number };

export async function snoozeFollowUp(followUpId: string, choice: SnoozeChoice): Promise<void> {
  const until = typeof choice === "object" ? choice.until : null;
  await optimistic(
    isQueue,
    // 帯・件数からは消え、自分の番の画面の「後で」に移る（決まった長さの終わりの時刻はサーバーが決める）
    (q) => setQueue(q, (x) => snoozeFollowUpInQueue(x, followUpId, until)),
    () =>
      unwrap(
        api.api["follow-ups"][":id"].snooze.$post({
          param: { id: followUpId },
          json: typeof choice === "object" ? { until: choice.until } : { preset: choice },
        }),
      ),
  );
}

/** 今やる（自分の番の画面の「後で」）: スヌーズを外して帯に戻す。明日へ移したタスクは今日へ戻す */
export async function wakeFollowUp(followUpId: string, today: string): Promise<void> {
  await optimistic(
    isQueue,
    (q) => setQueue(q, (x) => wakeFollowUpInQueue(x, followUpId, today)),
    () => unwrap(api.api["follow-ups"][":id"].wake.$post({ param: { id: followUpId } })),
  );
  void queryClient.invalidateQueries({ predicate: isBoard });
}

/** 「後で」のリセット前の上限待ちを対応不要にする（明けても「再開できる」を出さない） */
export async function dismissLimitWait(workItemId: string): Promise<void> {
  await optimistic(
    isQueue,
    (q) => setQueue(q, (x) => removeLimitWaitFromQueue(x, workItemId)),
    () =>
      unwrap(api.api["work-items"][":id"]["dismiss-limit"].$post({ param: { id: workItemId } })),
  );
}

export async function dismissFollowUps(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await optimistic(
    isQueue,
    (q) => setQueue(q, (x) => ids.reduce((acc, id) => removeFollowUpFromQueue(acc, id), x)),
    () =>
      ids.length === 1
        ? unwrap(api.api["follow-ups"][":id"].dismiss.$post({ param: { id: ids[0] as string } }))
        : unwrap(api.api["follow-ups"]["bulk-dismiss"].$post({ json: { ids } })),
  );
  if (ids.length > 1) toast(translate(getLocale(), "toast.dismissed", { count: ids.length }));
}

/** 自分の番の「完了」（Space・チェック）。知らせの「元に戻す」と ⌘Z で開き直す（D-139 (3)） */
export async function completeFollowUp(followUpId: string): Promise<void> {
  const undo = await writeFollowUpComplete(followUpId);
  if (undo) {
    pushUndo(undo);
    completedToast(1);
  }
}

async function writeFollowUpComplete(followUpId: string): Promise<(() => Promise<void>) | null> {
  // 完了は閉じた行（取り消し線）として残るので、帯からは消してサーバーの closedRows に任せる
  const r = await optimistic(
    isQueue,
    (q) => setQueue(q, (x) => removeFollowUpFromQueue(x, followUpId)),
    () => unwrap(api.api["follow-ups"][":id"].complete.$post({ param: { id: followUpId } })),
  );
  if (!r) return null;
  return async () => {
    await optimistic(
      either(isQueue, isBoard, isInbox),
      () => {},
      () => unwrap(api.api["follow-ups"][":id"].reopen.$post({ param: { id: followUpId } })),
    );
    void queryClient.invalidateQueries({
      predicate: (x) => x.queryKey[0] === "task" || x.queryKey[0] === "workItem",
    });
  };
}

export type ReplyTaskResult = {
  created: boolean;
  taskId: string | null;
  followUp: { kind: string } | null;
};

/**
 * y の結果の出し方。作った・返答タスクがもうある・この件はもう別のタスクになっている（PR の確認・頼んだタスクなど）。
 * 作らなかったときはそのタスクの詳細パネルを開いて場所を示す（同じ件を同じ日に2つ並べない）
 */
export function replyTaskOutcome(r: ReplyTaskResult): {
  message: MessageKey;
  openTaskId: string | null;
} {
  if (r.created) return { message: "toast.replyTask.created", openTaskId: null };
  return {
    message: r.followUp?.kind === "reply" ? "toast.replyTask.exists" : "toast.replyTask.linked",
    openTaskId: r.taskId,
  };
}

/** AI カードの y: 返答タスクを手で作る（D-066 (2)）。カードに開いているタスクがあれば作らない（サーバーが判断） */
export async function createReplyTask(workItemId: string): Promise<void> {
  const loc = getLocale();
  try {
    const r = await unwrap<ReplyTaskResult>(
      api.api["work-items"][":id"]["reply-task"].$post({ param: { id: workItemId } }),
    );
    const o = replyTaskOutcome(r);
    toast(translate(loc, o.message));
    if (o.openTaskId) setUi({ panelTaskId: o.openTaskId });
  } catch {
    toast(translate(loc, "toast.replyTask.failed"));
  }
  void queryClient.invalidateQueries({
    predicate: (x) =>
      x.queryKey[0] === "board" ||
      x.queryKey[0] === "queue" ||
      x.queryKey[0] === "day" ||
      x.queryKey[0] === "workItem",
  });
}

/** AI の作業を手で完了にする・非表示にする（AI 詳細パネルと右クリックメニュー） */
export async function patchWorkItem(
  id: string,
  json: { manualDone?: boolean; hidden?: boolean },
): Promise<void> {
  await unwrap(api.api["work-items"][":id"].$patch({ param: { id }, json })).catch(() => {});
  void queryClient.invalidateQueries({ queryKey: keys.workItem(id) });
  void queryClient.invalidateQueries({
    predicate: (x) =>
      x.queryKey[0] === "board" || x.queryKey[0] === "queue" || x.queryKey[0] === "day",
  });
}

export function invalidateAll(): void {
  void queryClient.invalidateQueries({ queryKey: keys.queue() });
}

const isDailyNote: Pred = (q) => q.queryKey[0] === "dailyNote";

/**
 * `m` 明日（シャットダウン Step 1・YOUR TURN 帯・キュー。D-052 (1)）: 自分の番のタスクを次の稼働日へ移し、
 * その日の計画の目安の開始までスヌーズする（手での移動なので持ち越し回数は数えない）。次の稼働日と開始はサーバーが決める
 */
export async function deferFollowUp(followUpId: string, nextDate: string): Promise<void> {
  await optimistic(
    isQueue,
    (q) => setQueue(q, (x) => deferFollowUpInQueue(x, followUpId, nextDate)),
    () =>
      unwrap(
        api.api["follow-ups"][":id"].defer.$post({
          param: { id: followUpId },
        }),
      ),
  );
  void queryClient.invalidateQueries({ predicate: isBoard });
}

// ---------- DnD の残り（M2-17・M2-18。ux-mvp 7章、m2-api 19章） ----------

const refreshAll = () =>
  void queryClient.invalidateQueries({
    predicate: (q) =>
      ["board", "day", "queue", "inbox", "task", "workItem", "dailyNote"].includes(
        q.queryKey[0] as string,
      ),
  });

async function attempt(f: () => Promise<unknown>): Promise<boolean> {
  try {
    await f();
    return true;
  } catch {
    toast(translate(getLocale(), "toast.saveFailed"));
    return false;
  } finally {
    refreshAll();
  }
}

/**
 * 自分の番の行を落とした: 未来の日（date > today）ならその日へ移してスヌーズ（D-052 (1)）、range があればその時刻に
 * 時間ブロック（既にあれば移す。D-051）
 */
export async function placeTurn(p: {
  followUpId: string;
  taskId: string;
  taskDate: string | null;
  date: string;
  today: string;
  range: { start: number; end: number } | null;
  block: TimeBlockView | null;
}): Promise<boolean> {
  return attempt(async () => {
    if (p.date > p.today)
      await unwrap(
        api.api["follow-ups"][":id"].defer.$post({
          param: { id: p.followUpId },
          json: { date: p.date },
        } as never),
      );
    if (!p.range) return;
    // 今日（以前の日付のまま帯に出ているもの）を時間に置いたら、タスクの日付もその日にする（持ち越し回数は数えない）
    if (p.date <= p.today && p.taskDate !== p.date)
      await unwrap(
        api.api.tasks[":id"].move.$post({ param: { id: p.taskId }, json: { date: p.date } }),
      );
    if (p.block)
      await unwrap(
        api.api["time-blocks"][":id"].$patch({
          param: { id: p.block.id },
          json: { startAt: p.range.start, endAt: p.range.end },
        }),
      );
    else
      await unwrap(
        api.api["time-blocks"].$post({
          json: { taskId: p.taskId, startAt: p.range.start, endAt: p.range.end },
        }),
      );
  });
}

/** AI カードを自分レーンへ: 確認タスクとその時刻の時間ブロック。⌘Z でタスクごと消す */
export async function createCheckTask(p: {
  workItemId: string;
  title: string;
  date: string;
  range: { start: number; end: number };
}): Promise<void> {
  let task: TaskView | null = null;
  const ok = await attempt(async () => {
    const r = await unwrap<{ task: TaskView | null }>(
      api.api["work-items"][":id"]["check-task"].$post({
        param: { id: p.workItemId },
        json: { title: p.title, date: p.date, startAt: p.range.start, endAt: p.range.end },
      }),
    );
    task = r.task;
  });
  const created = task as TaskView | null;
  if (ok && created) pushUndo(() => deleteTask(created, { undoable: false }));
}

/** AI カードを別の AI カードへ: 統合（確認ダイアログの後） */
export async function mergeWorkItems(fromId: string, intoId: string): Promise<boolean> {
  const ok = await attempt(() =>
    unwrap(api.api["work-items"][":id"].merge.$post({ param: { id: fromId }, json: { intoId } })),
  );
  if (ok) toast(translate(getLocale(), "dnd.merged"));
  return ok;
}

/** Note（1行）を保存する */
export async function putDailyNote(date: string, note: string | null): Promise<void> {
  try {
    await unwrap(api.api["daily-notes"][":date"].$put({ param: { date }, json: { note } }));
  } catch {
    toast(translate(getLocale(), "toast.saveFailed"));
  }
}

// ---------- 日報の AI 要約（M4-6） ----------

/** 要約を作る・作り直す（実行中のものは取り消される）。結果は SSE daily_note で届く */
export async function startSummary(date: string, lang: "en" | "ja"): Promise<boolean> {
  try {
    await unwrap(
      api.api["daily-notes"][":date"].summary.$post({ param: { date }, json: { lang } }),
    );
    return true;
  } catch {
    toast(translate(getLocale(), "summary.startFailed"));
    return false;
  } finally {
    void queryClient.invalidateQueries({ predicate: isDailyNote });
  }
}

/** 手で直した要約を保存する（null・空で消す） */
export async function putSummary(date: string, summary: string | null): Promise<boolean> {
  try {
    await unwrap(
      api.api["daily-notes"][":date"].summary.$put({ param: { date }, json: { summary } }),
    );
    return true;
  } catch {
    toast(translate(getLocale(), "toast.saveFailed"));
    return false;
  } finally {
    void queryClient.invalidateQueries({ predicate: isDailyNote });
  }
}

// ---------- 持ち越し（「残り N 件を今日へ」。D-192） ----------

const refreshCarry = () =>
  void queryClient.invalidateQueries({ predicate: either(isDailyNote, isBoard, isQueue, isInbox) });

/**
 * 過去の日の列の「残り N 件を今日へ」: その日に残った自分のタスクを今日の未定へ移す（時間ブロックは外し、持ち越し回数 +1）。
 * older はその日より前の日付（14日）のまま残っている未完了も一緒に。完了と同じ知らせに「元に戻す」（⌘Z でも戻る。D-144）
 */
export async function carryDay(date: string, o: { older: boolean }): Promise<number> {
  let r: CarryDayResponse;
  try {
    r = await unwrap<CarryDayResponse>(
      api.api.days[":date"].carry.$post({ param: { date }, json: { older: o.older } }),
    );
  } catch {
    toast(translate(getLocale(), "toast.saveFailed"));
    return 0;
  } finally {
    refreshCarry();
  }
  const n = r.moved.length;
  if (n === 0) return 0;
  const undo = async () => {
    try {
      await unwrap(api.api.days.carry.undo.$post({ json: { moved: r.moved } }));
    } catch {
      toast(translate(getLocale(), "toast.saveFailed"));
    } finally {
      refreshCarry();
    }
  };
  pushUndo(undo);
  toast(
    translate(getLocale(), "toast.carried", { count: n }),
    { label: translate(getLocale(), "action.undo"), run: () => void undoLast() },
    4000,
  );
  return n;
}

// ---------- 予定（D-093。Calendar.app のデフォルトカレンダーへ書く。移動・伸縮・題名・カレンダーは ⌘Z で戻す。D-096） ----------

const isEventDetail: Pred = (q) => q.queryKey[0] === "calendarEvent";

/** 予定の書き込みの失敗のトースト（コードに応じた一文。m2-api 24章） */
function eventToast(e: unknown): void {
  const code = e instanceof ApiError ? e.code : "";
  const known = [
    "helper_not_connected",
    "helper_outdated",
    "no_default_calendar",
    "not_writable",
    "not_editable",
    "changed",
  ];
  // 選んだ書き先が消えた・無視にした（作成の入力・パネルで選んだ後に変わった）
  const unavailable = code === "calendar_not_found" || code === "calendar_ignored";
  const key = (
    unavailable
      ? "toast.event.calendar_unavailable"
      : known.includes(code)
        ? `toast.event.${code}`
        : "toast.event.saveFailed"
  ) as Parameters<typeof translate>[1];
  toast(translate(getLocale(), key));
}

/** 予定の楽観的更新（optimistic と同じ流れで、失敗のトーストだけ予定用） */
async function eventOptimistic<T>(
  apply: (q: Query) => void,
  run: () => Promise<T>,
): Promise<T | null> {
  const affected = either(isBoard, isEventDetail);
  await queryClient.cancelQueries({ predicate: affected });
  const snap = queryClient
    .getQueryCache()
    .findAll({ predicate: affected })
    .map((q) => [q.queryKey, q.state.data] as const);
  for (const q of queryClient.getQueryCache().findAll({ predicate: either(isBoard) })) apply(q);
  try {
    return await run();
  } catch (e) {
    for (const [k, v] of snap) queryClient.setQueryData(k, v);
    eventToast(e);
    return null;
  } finally {
    void queryClient.invalidateQueries({ predicate: affected });
  }
}

/** 日の列に予定を置き直す（id の予定を外し、時間軸にかかる列にだけ足して開始順に並べる。null なら外すだけ） */
export function putEventInBoard(
  b: BoardResponse,
  id: string,
  next: CalendarEventView | null,
): BoardResponse {
  return {
    ...b,
    days: b.days.map((d) => {
      const rest = d.events.filter((e) => e.id !== id);
      const hit = next && !next.allDay && next.end > d.axis.start && next.start < d.axis.end;
      if (!hit && rest.length === d.events.length) return d;
      return {
        ...d,
        events: hit ? [...rest, next].sort((x, y) => x.start - y.start) : rest,
      };
    }),
  };
}

function cachedEvent(id: string): CalendarEventView | null {
  for (const q of queryClient.getQueryCache().findAll({ predicate: isBoard })) {
    const b = asBoard(q);
    for (const d of b?.days ?? []) {
      const e = d.events.find((x) => x.id === id);
      if (e) return e;
    }
  }
  return null;
}

/**
 * 予定を作る（Calendar.app のデフォルトカレンダー。作成の入力で選び直したらそのカレンダー）。仮の ID で先に出し、
 * 失敗したら消してトースト。color は入力欄で見せた書き先のカレンダーの色
 */
export async function createEvent(p: {
  title: string;
  start: number;
  end: number;
  color?: string | null;
  /** Turnlane の中で選んだ書き先の色（D-125） */
  colorKey?: CalendarColorKey | null;
  calendarId?: string | null;
  /** 設定の書き先と違うカレンダーを選んだ（calendarId を API に送る。送らなければ Calendar.app のデフォルト） */
  chosen?: boolean;
}): Promise<string | null> {
  const temp: CalendarEventView = {
    id: `temp-${uuidv7()}`,
    title: p.title,
    start: p.start,
    end: p.end,
    allDay: false,
    startDate: null,
    endDate: null,
    calendarColor: p.color ?? null,
    calendarColorKey: p.colorKey ?? null,
    calendarId: p.calendarId ?? "",
    busy: true,
    editable: false,
  };
  const r = await eventOptimistic(
    (q) => setBoard(q, (b) => putEventInBoard(b, temp.id, temp)),
    () =>
      unwrap<{ event: CalendarEventDetail | null }>(
        api.api["calendar-events"].$post({
          json: {
            title: p.title,
            start: p.start,
            end: p.end,
            ...(p.chosen && p.calendarId ? { calendarId: p.calendarId } : {}),
          },
        }),
      ),
  );
  return r?.event?.id ?? null;
}

type EventPatchBody = { title?: string; start?: number; end?: number; calendarId?: string };
/** カレンダーを移すときに先に見せる色（移す先のカレンダーアプリの色と、Turnlane の中で選んだ色。D-125） */
export type EventLook = {
  calendarColor?: string | null;
  calendarColorKey?: CalendarColorKey | null;
};
/** ⌘Z の逆の書き込みの前提（m2-api 24章の ifMatch。D-096） */
export type EventIfMatch = {
  start: number;
  end: number;
  title?: string | null;
  calendarId?: string;
};

/**
 * 予定を変える前の値（⌘Z で戻す先）。時刻と題名は週ボードのキャッシュ、カレンダーは詳細パネルのキャッシュから。
 * 戻せない項目（キャッシュに無い）があれば null
 */
function eventBefore(
  id: string,
  patch: EventPatchBody,
): { patch: EventPatchBody; look: EventLook } | null {
  const cur = cachedEvent(id);
  const detail = queryClient.getQueryData<CalendarEventDetail>(keys.calendarEvent(id));
  const start = cur?.start ?? detail?.start;
  const end = cur?.end ?? detail?.end;
  const out: EventPatchBody = {};
  if (patch.start !== undefined || patch.end !== undefined) {
    if (start === undefined || end === undefined) return null;
    if (patch.start !== undefined) out.start = start;
    if (patch.end !== undefined) out.end = end;
  }
  if (patch.title !== undefined) {
    const t = cur?.title ?? detail?.title;
    if (!t) return null;
    out.title = t;
  }
  if (patch.calendarId !== undefined) {
    if (!detail) return null;
    out.calendarId = detail.calendarId;
  }
  return {
    patch: out,
    look: {
      calendarColor: detail?.calendarColor ?? cur?.calendarColor ?? null,
      calendarColorKey: detail?.calendarColorKey ?? cur?.calendarColorKey ?? null,
    },
  };
}

/**
 * 予定を変える（移動・伸縮・題名・カレンダー）。失敗したら戻してトースト。
 * 変えたら ⌘Z で戻せる（D-096）: 戻すときは、予定がまだ変えた後の状態のときだけ書く（ifMatch）。外部で変わって
 * いたら書かずに「戻しませんでした」のトースト
 */
export async function patchEvent(
  id: string,
  patch: EventPatchBody,
  look: EventLook = {},
  opts: { undoable?: boolean; ifMatch?: EventIfMatch } = {},
): Promise<boolean> {
  const cur = cachedEvent(id);
  const before = opts.undoable === false ? null : eventBefore(id, patch);
  const r = await eventOptimistic(
    (q) => {
      if (q.queryKey[0] === "calendarEvent") return;
      if (!cur) return;
      setBoard(q, (b) =>
        putEventInBoard(b, id, {
          ...cur,
          ...(patch.title !== undefined ? { title: patch.title } : {}),
          ...(patch.start !== undefined ? { start: patch.start } : {}),
          ...(patch.end !== undefined ? { end: patch.end } : {}),
          ...(look.calendarColor !== undefined ? { calendarColor: look.calendarColor } : {}),
          ...(look.calendarColorKey !== undefined
            ? { calendarColorKey: look.calendarColorKey }
            : {}),
          ...(patch.calendarId !== undefined ? { calendarId: patch.calendarId } : {}),
        }),
      );
    },
    () =>
      unwrap<CalendarEventDetail>(
        api.api["calendar-events"][":id"].$patch({
          param: { id },
          json: { ...patch, ...(opts.ifMatch ? { ifMatch: opts.ifMatch } : {}) },
        }),
      ),
  );
  // 詳細パネルは結果で置き換える（カレンダー名・色）
  if (r) queryClient.setQueryData(keys.calendarEvent(id), r);
  if (r && before) {
    const ifMatch: EventIfMatch = {
      start: r.start,
      end: r.end,
      title: r.title,
      calendarId: r.calendarId,
    };
    pushUndo(async () => {
      await patchEvent(id, before.patch, before.patch.calendarId !== undefined ? before.look : {}, {
        undoable: false,
        ifMatch,
      });
    });
  }
  return r !== null;
}

/** 予定を消す。失敗したら戻してトースト */
export async function deleteEvent(id: string): Promise<boolean> {
  const r = await eventOptimistic(
    (q) => setBoard(q, (b) => putEventInBoard(b, id, null)),
    () => unwrap<{ ok: true }>(api.api["calendar-events"][":id"].$delete({ param: { id } })),
  );
  return r !== null;
}

// ---------- 集中モード（D-097。m2-api 25章） ----------

async function focusCall(run: () => Promise<FocusView>): Promise<FocusView | null> {
  try {
    const v = await run();
    queryClient.setQueryData(keys.focus(), v);
    void queryClient.invalidateQueries({ queryKey: keys.queue() });
    return v;
  } catch (e) {
    const code = e instanceof ApiError ? e.code : "";
    toast(
      translate(
        getLocale(),
        code === "no_event" ? "focus.noEvent" : code === "ended" ? "focus.ended" : "focus.failed",
      ),
    );
    return null;
  } finally {
    void queryClient.invalidateQueries({ queryKey: keys.focus() });
  }
}

/** 手動で集中する（⌘K・メニューバー）。30分 / 1時間 / 次の予定の終わりまで */
export function startFocus(p: { minutes: 30 | 60 } | { until: "event_end" }) {
  return focusCall(() => unwrap<FocusView>(api.api.focus.start.$post({ json: p })));
}

export function endFocus() {
  return focusCall(() => unwrap<FocusView>(api.api.focus.end.$post()));
}

/** 「この予定の間は集中する」（D-130。予定の詳細パネル・予定の右クリック）。終わった予定は 409 ended */
export function reserveFocus(eventId: string) {
  return focusCall(() =>
    unwrap<FocusView>(api.api.focus.events[":id"].$post({ param: { id: eventId } })),
  );
}

/** 予約を取り消す（その予定の集中の最中なら終える） */
export function cancelFocusReservation(eventId: string) {
  return focusCall(() =>
    unwrap<FocusView>(api.api.focus.events[":id"].$delete({ param: { id: eventId } })),
  );
}

/** 問いへの答え（画面上部の帯・ポップオーバー）。古い問い（409 stale）は黙って取り直す */
export async function answerFocus(key: string, answer: "focus" | "skip"): Promise<void> {
  try {
    const v = await unwrap<FocusView>(api.api.focus.prompt.$post({ json: { key, answer } }));
    queryClient.setQueryData(keys.focus(), v);
  } catch (e) {
    if (!(e instanceof ApiError && e.code === "stale"))
      toast(translate(getLocale(), "focus.failed"));
  } finally {
    void queryClient.invalidateQueries({ queryKey: keys.focus() });
    void queryClient.invalidateQueries({ queryKey: keys.queue() });
  }
}

// ---------- 更新の知らせ（M6-17） ----------

/** ボードの更新の知らせを閉じる（その版は次のデーモンの起動まで出さない）。失敗しても画面からは消す */
export async function dismissUpdate(version: string): Promise<void> {
  const prev = queryClient.getQueryData<UpdateStatus>(keys.update());
  if (prev) queryClient.setQueryData(keys.update(), { ...prev, dismissed: version });
  try {
    const v = await unwrap<UpdateStatus>(api.api.update.dismiss.$post({ json: { version } }));
    queryClient.setQueryData(keys.update(), v);
  } catch {
    // 古いデーモン（口が無い）: この画面の間だけ閉じたままにする
  }
}

/**
 * 取得・検証の済んだ更新を入れる（Restart to update。ADR 0008 の追記 4）。入れ終わったら true。デーモンは新しい版で
 * 起き直し、アプリは SSE update の installed で開き直す。入れられなかった・ready でなかったら false
 */
export async function installUpdate(): Promise<boolean> {
  try {
    const v = await unwrap<UpdateStatus>(api.api.update.install.$post());
    queryClient.setQueryData(keys.update(), v);
    return v.download?.state === "installed";
  } catch {
    void queryClient.invalidateQueries({ queryKey: keys.update() });
    return false;
  }
}

// ---------- タスクから AI に頼む（D-107。m2-api 27章） ----------

/** 依頼して端末を開く。コピーになったら（端末が無い・オートメーションの許可が無い）クリップボードへ書く */
export async function launchAi(input: AiLaunchInput): Promise<AiLaunchResult | null> {
  const req = unwrap<AiLaunchResult>(api.api.ai.launches.$post({ json: input }));
  const copied = writeClipboardLater(
    req.then(
      (r) => r.command,
      () => null,
    ),
  );
  const loc = getLocale();
  try {
    const r = await req;
    await copied;
    const tool = translate(
      loc,
      input.tool === "codex" ? "launch.tool.codex" : "launch.tool.claude",
    );
    if (r.outcome === "opened")
      toast(translate(loc, "launch.toast.opened", { app: r.app ?? "", tool }));
    else if (r.outcome === "opened_copied")
      toast(translate(loc, "launch.toast.openedCopied", { app: r.app ?? "" }));
    else toast(translate(loc, "launch.toast.copied"));
    void queryClient.invalidateQueries({ queryKey: keys.task(input.taskId) });
    return r;
  } catch (e) {
    const code = e instanceof ApiError ? e.code : "";
    const known = [
      "tool_missing",
      "worktree_failed",
      "not_git",
      "repo_missing",
      "task_closed",
      "account_missing",
    ] as const;
    const k = (known as readonly string[]).includes(code) ? code : "failed";
    toast(translate(loc, `launch.error.${k}` as MessageKey));
    return null;
  }
}

export async function cleanupWorktree(
  launchId: string,
  force: boolean,
): Promise<WorktreeCleanupResult | null> {
  try {
    return await unwrap<WorktreeCleanupResult>(
      api.api.ai.launches[":id"].cleanup.$post({ param: { id: launchId }, json: { force } }),
    );
  } catch {
    toast(translate(getLocale(), "launch.error.failed"));
    return null;
  }
}

export async function runLaunchTest(launchId: string): Promise<void> {
  try {
    await unwrap(api.api.ai.launches[":id"].test.$post({ param: { id: launchId } }));
    void queryClient.invalidateQueries({ queryKey: ["aiCheck"] });
  } catch {
    toast(translate(getLocale(), "launch.error.failed"));
  }
}

export async function linkLaunch(launchId: string, sessionId: string): Promise<void> {
  try {
    await unwrap(
      api.api.ai.launches[":id"].link.$post({ param: { id: launchId }, json: { sessionId } }),
    );
  } catch {
    toast(translate(getLocale(), "launch.error.failed"));
  }
}

/**
 * カレンダーの色を Turnlane の中だけで選ぶ・戻す（D-125。key = null でカレンダーアプリの色に戻す）。そのカレンダーの
 * 予定の色を先に変え、失敗したら戻してトースト。カレンダーの一覧（設定・予定のパネル・作成の書き先）は確定後に取り直す
 */
export async function setCalendarColor(
  calendarId: string,
  key: CalendarColorKey | null,
): Promise<boolean> {
  const recolor = (es: CalendarEventView[]) =>
    es.some((e) => e.calendarId === calendarId)
      ? es.map((e) => (e.calendarId === calendarId ? { ...e, calendarColorKey: key } : e))
      : es;
  const r = await eventOptimistic(
    (q) =>
      setBoard(q, (b) => ({
        ...b,
        days: b.days.map((d) => ({
          ...d,
          events: recolor(d.events),
          allDayEvents: recolor(d.allDayEvents),
        })),
      })),
    () =>
      unwrap<{ calendar: unknown }>(
        api.api.calendars[":id"].$patch({ param: { id: calendarId }, json: { colorKey: key } }),
      ),
  );
  void queryClient.invalidateQueries({
    predicate: (q) =>
      q.queryKey[0] === "calendars" ||
      (q.queryKey[0] === "settings" &&
        (q.queryKey[1] === "calendars" || q.queryKey[1] === "calendar-status")),
  });
  return r !== null;
}

/**
 * 離れていた間のまとめを閉じる（D-214 (2)）。並んだ件を開いたとき・閉じたとき。同じ離席のまとめはもう出さない
 * （保存するのは戻った時刻の印だけ）
 */
export async function dismissAway(key: string): Promise<void> {
  queryClient.setQueryData(keys.away(), { digest: null });
  try {
    await unwrap(api.api.away.dismiss.$post({ json: { key } }));
  } finally {
    void queryClient.invalidateQueries({ queryKey: keys.away() });
  }
}
