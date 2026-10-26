/**
 * タスクと時間ブロックの操作（m2-api.md 2.2、phase0-plan 3.4）。すべて mutate() 経由で書き、SSE の task を送る。
 * - 作成は clientId（UUIDv7）をそのまま ID にする（再送で二重作成しない）
 * - 外部取り込みは (external_source, external_id) で冪等: 既存は作らずに返し、ユーザーが削除したものは作り直さない
 * - move の carry: true のときだけ持ち越し回数を加算（9.2。手での移動は数えない）
 * - 自分の番のタスクの完了は、対応するフォローアップの complete に委ねる（同じ結果になる）
 */
import type { Database } from "bun:sqlite";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  type Clock,
  dayStartMs,
  insertRow,
  insertRowIfAbsent,
  type MutateCtx,
  newId,
  orderKeyAfter,
  orderKeyBefore,
  orderKeyBetween,
  schema,
  softDelete,
  type TurnlaneSettings,
  toLocalDate,
  updateRow,
} from "@turnlane/core";
import {
  type CreateTaskInput,
  createTaskInput,
  type InboxResponse,
  type MoveTaskInput,
  type PatchTaskInput,
  type TaskDetailResponse,
  type TaskView,
  type TaskWriteResponse,
  type TimeBlockView,
  type TimeBlockWriteResponse,
  type UncompleteTaskInput,
} from "@turnlane/core/api";
import { parseTask } from "@turnlane/core/nlp";
import { sql } from "drizzle-orm";
import { OpError } from "../derive/ops.ts";
import { projectIdForRepo } from "../derive/projects.ts";
import { DESKTOP_SOURCE_REF, readMeta, type TaskRow, viewsFor } from "./common.ts";

export interface TaskServiceOptions {
  sqlite: Database;
  mutate: MutateCtx;
  clock: Clock;
  settings: () => TurnlaneSettings;
  rev: () => number;
  publish: (
    type: "task",
    data: { dates: string[]; ids: string[]; inbox: boolean; addedBy?: string },
  ) => void;
  /** 自分の番のタスクの完了をフォローアップに委ねる（取り込みが動いていなければ undefined） */
  completeFollowUp?: (followUpId: string) => void;
  /** 完了の取り消しで、完了と一緒に閉じた自分の番を開き直す（D-139 (3)） */
  reopenFollowUp?: (followUpId: string) => void;
  /** 書いた後に判定（待ち）を起こす */
  onChanged?: () => void;
}

type TimeBlockRow = {
  id: string;
  task_id: string | null;
  title: string | null;
  start_at: number;
  end_at: number;
  deleted_at: number | null;
};

export class TaskService {
  constructor(private readonly o: TaskServiceOptions) {}

  #row(id: string, includeDeleted = false): TaskRow {
    const r = this.o.sqlite
      .query<TaskRow, [string]>(
        `SELECT * FROM task WHERE id = ?${includeDeleted ? "" : " AND deleted_at IS NULL"}`,
      )
      .get(id);
    if (!r) throw new OpError(404, "not_found");
    return r;
  }

  #view(id: string): TaskView {
    return viewsFor(this.o.sqlite, [this.#row(id, true)])[0] as TaskView;
  }

  #today(): string {
    const s = this.o.settings();
    return toLocalDate(this.o.clock.now(), s.tz, s.dayBoundary);
  }

  #emit(ids: string[], dates: (string | null)[], addedBy?: string): void {
    const ds = [...new Set(dates.filter((d): d is string => d !== null))];
    this.o.publish("task", {
      ids,
      dates: ds,
      inbox: dates.some((d) => d === null),
      // MCP から追加したときは UI がトースト（「<client> が1件追加しました [元に戻す]」）を出す
      ...(addedBy ? { addedBy } : {}),
    });
    this.o.onChanged?.();
  }

  #laneEnd(date: string | null, first: boolean): string {
    const rows = this.o.sqlite
      .query<{ lane_order: string }, [string | null]>(
        `SELECT lane_order FROM task WHERE deleted_at IS NULL AND ${
          date === null ? "scheduled_date IS NULL AND ? IS NULL" : "scheduled_date = ?"
        } ORDER BY lane_order`,
      )
      .all(date);
    if (rows.length === 0) return orderKeyBetween(null, null);
    return first
      ? orderKeyBefore((rows[0] as { lane_order: string }).lane_order)
      : orderKeyAfter((rows.at(-1) as { lane_order: string }).lane_order);
  }

  #projectId(name: string): string {
    const r = this.o.sqlite
      .query<{ id: string }, [string]>(
        "SELECT id FROM project WHERE name = ? AND deleted_at IS NULL",
      )
      .get(name);
    if (r) return r.id;
    return insertRow(this.o.mutate, schema.project, { name }).id;
  }

  create(input: CreateTaskInput): TaskWriteResponse & { status: 200 | 201 } {
    const rev = this.o.rev();
    if (input.clientId) {
      const existing = this.o.sqlite
        .query<{ id: string }, [string]>("SELECT id FROM task WHERE id = ?")
        .get(input.clientId);
      if (existing) return { rev, task: this.#view(existing.id), created: false, status: 200 };
    }
    let title = input.title;
    let date = input.date;
    let estimate = input.estimateMin;
    let projectId =
      input.projectId ?? (input.projectName ? this.#projectId(input.projectName) : undefined);
    let priority = input.priority;
    let time: { hour: number; minute: number } | null = null;
    let someday = false;
    if (title === undefined && input.raw !== undefined) {
      const p = parseTask(input.raw, { today: this.#today() });
      title = p.title;
      if (date === undefined && (p.date !== null || p.inbox)) date = p.inbox ? null : p.date;
      if (estimate === undefined && p.estimateMin !== null) estimate = p.estimateMin;
      if (projectId === undefined && p.project) projectId = this.#projectId(p.project);
      if (priority === undefined && p.priority !== null) priority = p.priority;
      time = p.time;
      someday = p.someday && p.date === null;
    }
    const scheduledDate = someday ? null : (date ?? null);
    const source = input.source ?? "manual";
    const values = {
      ...(input.clientId ? { id: input.clientId } : {}),
      title: title ?? "",
      notesMd: input.notes ?? null,
      status: someday ? ("someday" as const) : ("todo" as const),
      scheduledDate,
      laneOrder: this.#laneEnd(scheduledDate, input.placeFirst === true),
      estimateMin: estimate ?? null,
      priority: priority ?? 0,
      projectId: projectId ?? null,
      // desktop は DB の CHECK を変えずに manual + source_ref で残す（TaskSource の注記）
      source: source === "desktop" ? ("manual" as const) : source,
      sourceRef:
        source === "mcp"
          ? `mcp:${input.client ?? "unknown"}${input.cwd ? `:${input.cwd}` : ""}`
          : source === "desktop"
            ? DESKTOP_SOURCE_REF
            : null,
      externalSource: input.external?.source ?? null,
      externalId: input.external?.id ?? null,
      externalUrl: input.external?.url ?? null,
    };
    let id: string;
    if (input.external) {
      const r = insertRowIfAbsent(
        this.o.mutate,
        schema.task,
        values,
        ["externalSource", "externalId"],
        sql`external_source IS NOT NULL`,
      );
      if (!r.created) {
        // ユーザーが削除したものは作り直さない。既存はタイトル等を上書きしない
        if (r.row.deletedAt !== null)
          return { rev, task: null, created: false, skipped: "deleted", status: 200 };
        return { rev, task: this.#view(r.row.id), created: false, status: 200 };
      }
      id = r.row.id;
    } else {
      id = insertRow(this.o.mutate, schema.task, values).id;
    }
    // 時刻が書かれていれば時間ブロックも作る（見積、無ければ30分）
    if (time && scheduledDate) {
      const s = this.o.settings();
      const base = dayStartMs(scheduledDate, s.tz, s.dayBoundary) - s.dayBoundary * 60_000;
      let start = base + (time.hour * 60 + time.minute) * 60_000;
      if (time.hour * 60 + time.minute < s.dayBoundary) start += 86_400_000;
      insertRow(this.o.mutate, schema.timeBlock, {
        taskId: id,
        title: null,
        startAt: start,
        endAt: start + (estimate ?? 30) * 60_000,
        tz: s.tz,
      });
    }
    this.#emit(
      [id],
      [scheduledDate],
      source === "mcp" ? (input.external?.source ?? input.client ?? "MCP") : undefined,
    );
    return { rev, task: this.#view(id), created: true, status: 201 };
  }

  /** GET /api/tasks/:id（タスクの詳細パネル。D-070）。削除済みは 404 */
  detail(id: string): TaskDetailResponse {
    const r = this.#row(id);
    const blocks = this.o.sqlite
      .query<{ id: string }, [string]>(
        "SELECT id FROM time_block WHERE task_id = ? AND deleted_at IS NULL ORDER BY start_at",
      )
      .all(id)
      .map((b) => this.#blockView(b.id));
    const project = r.project_id
      ? this.o.sqlite
          .query<{ name: string }, [string]>("SELECT name FROM project WHERE id = ?")
          .get(r.project_id)
      : null;
    return {
      ...readMeta(this.o.settings(), this.o.clock.now(), this.o.rev()),
      task: this.#view(id),
      notes: r.notes_md ?? null,
      blocks,
      projectName: project?.name ?? null,
    };
  }

  byExternal(source: string, externalId: string): TaskView | null {
    const r = this.o.sqlite
      .query<{ id: string }, [string, string]>(
        "SELECT id FROM task WHERE external_source = ? AND external_id = ? AND deleted_at IS NULL",
      )
      .get(source, externalId);
    return r ? this.#view(r.id) : null;
  }

  patch(id: string, p: PatchTaskInput): TaskWriteResponse {
    const r = this.#row(id);
    updateRow(this.o.mutate, schema.task, id, {
      // 自動生成タスクの題名を変えたら、人が書いた題名になる（D-046）
      ...(p.title !== undefined ? { title: p.title, titleKey: null, titleParams: null } : {}),
      ...(p.notes !== undefined ? { notesMd: p.notes } : {}),
      ...(p.estimateMin !== undefined ? { estimateMin: p.estimateMin } : {}),
      ...(p.priority !== undefined ? { priority: p.priority } : {}),
      ...(p.projectId !== undefined ? { projectId: p.projectId } : {}),
      ...(p.isHighlight !== undefined ? { isHighlight: p.isHighlight ? 1 : 0 } : {}),
      ...(p.status !== undefined
        ? {
            status: p.status,
            ...(p.status === "someday" ? { scheduledDate: null } : {}),
            completedAt: null,
          }
        : {}),
    });
    this.#emit([id], [r.scheduled_date, p.status === "someday" ? null : r.scheduled_date]);
    return { rev: this.o.rev(), task: this.#view(id) };
  }

  move(id: string, m: MoveTaskInput): TaskWriteResponse {
    const r = this.#row(id);
    const order = (x: string | null | undefined) =>
      x
        ? (this.o.sqlite
            .query<{ lane_order: string }, [string]>("SELECT lane_order FROM task WHERE id = ?")
            .get(x)?.lane_order ?? null)
        : null;
    const before = order(m.beforeId);
    const after = order(m.afterId);
    let laneOrder: string;
    try {
      laneOrder =
        before !== null || after !== null
          ? orderKeyBetween(before, after)
          : r.scheduled_date === m.date
            ? r.lane_order
            : this.#laneEnd(m.date, false);
    } catch {
      throw new OpError(400, "bad_order");
    }
    updateRow(this.o.mutate, schema.task, id, {
      scheduledDate: m.date,
      laneOrder,
      ...(m.carry ? { rolloverCount: r.rollover_count + 1 } : {}),
      ...(r.status === "someday" && m.date !== null ? { status: "todo" as const } : {}),
    });
    this.#emit([id], [r.scheduled_date, m.date]);
    return { rev: this.o.rev(), task: this.#view(id) };
  }

  #liveFollowUps(taskId: string): string[] {
    return this.o.sqlite
      .query<{ id: string }, [string]>(
        "SELECT id FROM follow_up WHERE task_id = ? AND status IN ('open', 'snoozed') AND deleted_at IS NULL ORDER BY trigger_at",
      )
      .all(taskId)
      .map((r) => r.id);
  }

  /** 完了にした後（AI に頼んだタスクの worktree の片付け。D-107）。main.ts が入れる */
  onCompleted: ((id: string) => void) | null = null;

  complete(id: string): TaskWriteResponse {
    const r = this.#row(id);
    // 頼んだタスク（D-107）には自分の番が複数付きうる。開いているものをすべて済ませてから、タスクを閉じる
    const closed: string[] = [];
    if (this.o.completeFollowUp)
      for (const fu of this.#liveFollowUps(id)) {
        this.o.completeFollowUp(fu);
        closed.push(fu);
      }
    if (this.#row(id).status !== "done") {
      updateRow(this.o.mutate, schema.task, id, {
        status: "done",
        completedAt: this.o.clock.now(),
        autoCompleted: 0,
      });
      // 計測中の実績を閉じる
      this.#stopTimers(id);
    }
    this.onCompleted?.(id);
    this.#emit([id], [r.scheduled_date]);
    // 閉じた自分の番（完了の取り消しで開き直す。D-139 (3)）
    return { rev: this.o.rev(), task: this.#view(id), closedFollowUps: closed };
  }

  /**
   * 未完了に戻す。完了の取り消し（⌘Z。D-139 (3)）は前の状態（todo / doing）と、完了と一緒に閉じた自分の番を渡す。
   * 日付と並び（scheduled_date・lane_order）は完了で変わらないのでそのまま
   */
  uncomplete(id: string, opts: UncompleteTaskInput = {}): TaskWriteResponse {
    const r = this.#row(id);
    for (const fu of opts.reopenFollowUps ?? []) this.o.reopenFollowUp?.(fu);
    updateRow(this.o.mutate, schema.task, id, {
      status: opts.status ?? "todo",
      completedAt: null,
      autoCompleted: 0,
    });
    this.#emit([id], [r.scheduled_date]);
    return { rev: this.o.rev(), task: this.#view(id) };
  }

  #stopTimers(taskId: string): void {
    const now = this.o.clock.now();
    for (const e of this.o.sqlite
      .query<{ id: string; start_at: number }, [string]>(
        "SELECT id, start_at FROM task_time_entry WHERE task_id = ? AND end_at IS NULL AND deleted_at IS NULL",
      )
      .all(taskId)) {
      updateRow(this.o.mutate, schema.taskTimeEntry, e.id, { endAt: Math.max(now, e.start_at) });
    }
  }

  /** ワンタップ実績（開始）。もう一度呼ぶと止める */
  start(id: string): TaskWriteResponse {
    const r = this.#row(id);
    const running = this.o.sqlite
      .query<{ id: string }, [string]>(
        "SELECT id FROM task_time_entry WHERE task_id = ? AND end_at IS NULL AND deleted_at IS NULL",
      )
      .get(id);
    if (running) this.#stopTimers(id);
    else {
      const now = this.o.clock.now();
      insertRow(this.o.mutate, schema.taskTimeEntry, {
        taskId: id,
        startAt: now,
        endAt: null,
        source: "tap",
      });
      if (r.status === "todo")
        updateRow(this.o.mutate, schema.task, id, { status: "doing", startedAt: now });
    }
    this.#emit([id], [r.scheduled_date]);
    return { rev: this.o.rev(), task: this.#view(id) };
  }

  remove(id: string): TaskWriteResponse {
    const r = this.#row(id);
    softDelete(this.o.mutate, schema.task, id);
    this.#emit([id], [r.scheduled_date]);
    return { rev: this.o.rev(), task: this.#view(id) };
  }

  restore(id: string): TaskWriteResponse {
    const r = this.#row(id, true);
    if (r.deleted_at !== null) updateRow(this.o.mutate, schema.task, id, { deletedAt: null });
    this.#emit([id], [r.scheduled_date]);
    return { rev: this.o.rev(), task: this.#view(id) };
  }

  /**
   * turnlane add がデーモン停止中に書いた spool（spool/cli-*.jsonl）を取り込む。clientId で冪等なので、
   * 取り込みの途中で止まって読み直しても重複しない。取り込んだファイルは消す（Turnlane 自身のファイル）
   */
  ingestCliSpool(dir: string): number {
    let n = 0;
    let names: string[] = [];
    try {
      names = readdirSync(dir).filter((f) => /^cli-\d{8}\.jsonl$/.test(f));
    } catch {
      return 0;
    }
    for (const name of names.sort()) {
      const path = join(dir, name);
      const text = readFileSync(path, "utf8");
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          const v = JSON.parse(line) as { kind?: string; body?: unknown };
          if (v.kind !== "add_task") continue;
          const input = createTaskInput.safeParse(v.body);
          if (!input.success) continue;
          const r = this.create(input.data);
          if (r.created) n++;
        } catch {
          // 壊れた行は飛ばす
        }
      }
      // 取り込み中に追記されていなければ消す（追記されていたら次回にもう一度読む。clientId で冪等）
      if (readFileSync(path, "utf8") === text) rmSync(path, { force: true });
    }
    return n;
  }

  inbox(): InboxResponse {
    const s = this.o.settings();
    const rows = this.o.sqlite
      .query<TaskRow, []>(
        "SELECT * FROM task WHERE scheduled_date IS NULL AND deleted_at IS NULL AND status IN ('todo', 'doing') ORDER BY created_at DESC",
      )
      .all();
    // 今日（論理日）完了にしたもの（「今日閉じた n」。D-139 (4)）
    const now = this.o.clock.now();
    const from = dayStartMs(toLocalDate(now, s.tz, s.dayBoundary), s.tz, s.dayBoundary);
    const closed = this.o.sqlite
      .query<TaskRow, [number]>(
        "SELECT * FROM task WHERE scheduled_date IS NULL AND deleted_at IS NULL AND status = 'done' AND completed_at >= ? ORDER BY completed_at DESC",
      )
      .all(from);
    return {
      ...readMeta(s, now, this.o.rev()),
      tasks: viewsFor(this.o.sqlite, rows),
      closed: viewsFor(this.o.sqlite, closed),
    };
  }

  // ---------- 時間ブロック（Turnlane の中だけ。カレンダーには書かない。D-093） ----------

  #block(id: string): TimeBlockRow {
    const r = this.o.sqlite
      .query<TimeBlockRow, [string]>(
        "SELECT id, task_id, title, start_at, end_at, deleted_at FROM time_block WHERE id = ?",
      )
      .get(id);
    if (!r) throw new OpError(404, "not_found");
    return r;
  }

  #blockView(id: string): TimeBlockView {
    const b = this.#block(id);
    return {
      id: b.id,
      taskId: b.task_id,
      title: b.title,
      start: b.start_at,
      end: b.end_at,
    };
  }

  /** ブロックが影響する日付: 計上する論理日と、描く列の暦日（D-054） */
  #blockDates(start: number, end: number): string[] {
    const s = this.o.settings();
    const last = Math.max(start, end - 1);
    return [
      ...new Set([
        toLocalDate(start, s.tz, s.dayBoundary),
        toLocalDate(last, s.tz, s.dayBoundary),
        toLocalDate(start, s.tz, 0),
        toLocalDate(last, s.tz, 0),
      ]),
    ];
  }

  /**
   * POST /api/work-items/:id/check-task（m2-api 19章）: AI カードを自分レーンへ落とした確認タスクと時間ブロック。
   * 題名はクライアントが UI の言語で作る。source = ai、source_ref = work_item:<id>、プロジェクトはリポジトリの対応から
   */
  createCheckTask(
    workItemId: string,
    p: {
      title: string;
      date: string;
      startAt: number;
      endAt: number;
      clientId?: string | undefined;
    },
  ): TaskWriteResponse {
    const w = this.o.sqlite
      .query<{ id: string; repo_root: string | null }, [string]>(
        "SELECT id, repo_root FROM work_item WHERE id = ? AND deleted_at IS NULL",
      )
      .get(workItemId);
    if (!w) throw new OpError(404, "work_item not found");
    if (p.clientId) {
      const existing = this.o.sqlite
        .query<{ id: string }, [string]>("SELECT id FROM task WHERE id = ?")
        .get(p.clientId);
      if (existing) return { rev: this.o.rev(), task: this.#view(existing.id), created: false };
    }
    const id = insertRow(this.o.mutate, schema.task, {
      ...(p.clientId ? { id: p.clientId } : {}),
      title: p.title,
      status: "todo",
      scheduledDate: p.date,
      laneOrder: this.#laneEnd(p.date, false),
      estimateMin: Math.round((p.endAt - p.startAt) / 60_000),
      projectId: projectIdForRepo(this.o.sqlite, w.repo_root),
      source: "ai",
      sourceRef: `work_item:${workItemId}`,
    }).id;
    insertRow(this.o.mutate, schema.timeBlock, {
      taskId: id,
      title: null,
      startAt: p.startAt,
      endAt: p.endAt,
      tz: this.o.settings().tz,
    });
    this.#emit([id], [p.date, ...this.#blockDates(p.startAt, p.endAt)]);
    return { rev: this.o.rev(), task: this.#view(id), created: true };
  }

  createTimeBlock(p: {
    taskId?: string | null | undefined;
    title?: string | null | undefined;
    startAt: number;
    endAt: number;
    clientId?: string | undefined;
  }): TimeBlockWriteResponse {
    if (p.taskId) this.#row(p.taskId);
    const id = p.clientId ?? newId(this.o.clock);
    const exists = this.o.sqlite
      .query<{ id: string }, [string]>("SELECT id FROM time_block WHERE id = ?")
      .get(id);
    if (!exists)
      insertRow(this.o.mutate, schema.timeBlock, {
        id,
        taskId: p.taskId ?? null,
        title: p.title ?? null,
        startAt: p.startAt,
        endAt: p.endAt,
        tz: this.o.settings().tz,
      });
    this.#emit(p.taskId ? [p.taskId] : [id], this.#blockDates(p.startAt, p.endAt));
    return { rev: this.o.rev(), timeBlock: this.#blockView(id) };
  }

  patchTimeBlock(id: string, p: { startAt?: number | undefined; endAt?: number | undefined }) {
    const b = this.#block(id);
    const start = p.startAt ?? b.start_at;
    const end = p.endAt ?? b.end_at;
    if (end <= start) throw new OpError(400, "end_before_start");
    updateRow(this.o.mutate, schema.timeBlock, id, {
      startAt: start,
      endAt: end,
    });
    this.#emit(
      [b.task_id ?? id],
      [...this.#blockDates(b.start_at, b.end_at), ...this.#blockDates(start, end)],
    );
    return { rev: this.o.rev(), timeBlock: this.#blockView(id) };
  }

  deleteTimeBlock(id: string): TimeBlockWriteResponse {
    const b = this.#block(id);
    softDelete(this.o.mutate, schema.timeBlock, id);
    this.#emit([b.task_id ?? id], this.#blockDates(b.start_at, b.end_at));
    return { rev: this.o.rev(), timeBlock: null };
  }
}
