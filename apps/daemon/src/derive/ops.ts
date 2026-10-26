/**
 * ユーザー操作（phase0-plan 3.4）: フォローアップの ⏎（engage）/ s（スヌーズ）/ e（対応不要。D-031）/ Space（完了）、
 * AI カードの y（返答タスクを手で作る。D-066 (2)）、カードの手動完了・非表示・タイトル。すべて mutate() 経由で書く。
 * 書いた後は runner を起こす（状態・待ちの再計算）。
 */
import type { Database } from "bun:sqlite";
import {
  type Clock,
  derive,
  insertRow,
  type MutateCtx,
  newId,
  orderKeyAfter,
  orderKeyBetween,
  readSettings,
  schema,
  softDelete,
  type TaskTitleParams,
  taskTitleKeyFor,
  toLocalDate,
  updateRow,
} from "@turnlane/core";
import { isLaunchTask } from "../launch/link.ts";
import { cardLimitWait } from "./limit.ts";
import type { FollowUpRow } from "./load.ts";
import { mergeCardInto } from "./merge.ts";
import { projectIdForRepo } from "./projects.ts";
import { capSnoozes } from "./runner.ts";

export class OpError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

export class UserOps {
  constructor(
    private readonly sqlite: Database,
    private readonly mutate: MutateCtx,
    private readonly clock: Clock,
    private readonly onChanged: () => void,
    /** SSE（作った行を他の画面・メニューバーに知らせる） */
    private readonly publish?: (type: "task" | "follow_up", data: Record<string, unknown>) => void,
  ) {}

  #followUp(id: string): FollowUpRow {
    const row = this.sqlite
      .query<FollowUpRow, [string]>("SELECT * FROM follow_up WHERE id = ? AND deleted_at IS NULL")
      .get(id);
    if (!row) throw new OpError(404, "follow_up not found");
    return row;
  }

  #live(row: FollowUpRow): void {
    if (row.status !== "open" && row.status !== "snoozed")
      throw new OpError(409, `follow_up is ${row.status}`);
  }

  /** ⏎: 外部を開いた（ここからは自分の応答） */
  engage(id: string): FollowUpRow {
    const row = this.#followUp(id);
    this.#live(row);
    const now = this.clock.now();
    if (row.engaged_at === null) {
      updateRow(this.mutate, schema.followUp, id, {
        engagedAt: now,
        // スヌーズ中に ⏎ したらスヌーズを終える
        ...(row.status === "snoozed"
          ? {
              status: "open" as const,
              snoozeUntil: null,
              snoozesJson: capSnoozes(row.snoozes_json, now),
            }
          : {}),
      });
    }
    this.onChanged();
    return this.#followUp(id);
  }

  /** z: スヌーズ。区間を snoozes_json に残す（D-032） */
  snooze(id: string, until: number): FollowUpRow {
    const row = this.#followUp(id);
    this.#live(row);
    const now = this.clock.now();
    if (!(until > now)) throw new OpError(400, "until must be in the future");
    const list = JSON.parse(capSnoozes(row.snoozes_json, now)) as [number, number][];
    list.push([now, until]);
    updateRow(this.mutate, schema.followUp, id, {
      status: "snoozed",
      snoozeUntil: until,
      snoozesJson: JSON.stringify(list),
    });
    this.onChanged();
    return this.#followUp(id);
  }

  /**
   * 今やる（スヌーズ解除。自分の番の画面の「後で」）: スヌーズを終えて open に戻す（帯に戻る）。スヌーズの区間は今の時刻で
   * 閉じる。open ならそのまま返す
   */
  unsnooze(id: string): FollowUpRow {
    const row = this.#followUp(id);
    this.#live(row);
    if (row.status === "open") return row;
    const now = this.clock.now();
    updateRow(this.mutate, schema.followUp, id, {
      status: "open",
      snoozeUntil: null,
      snoozesJson: capSnoozes(row.snoozes_json, now),
    });
    this.onChanged();
    return this.#followUp(id);
  }

  /**
   * 時間に置いた自分の番の「今やる」（時間ブロックを消す前）: ブロックを作ってから今までの区間（集計外 scheduled だった区間）を
   * スヌーズの区間として残す。ブロックを消すと scheduled の区間も消え、過ぎた時間が放置に数え直されるため。from が今以降なら何もしない
   */
  keepExcluded(id: string, from: number): void {
    const row = this.#followUp(id);
    this.#live(row);
    const now = this.clock.now();
    if (!(from < now)) return;
    const list = JSON.parse(capSnoozes(row.snoozes_json, now)) as [number, number][];
    list.push([from, now]);
    list.sort((a, b) => a[0] - b[0]);
    updateRow(this.mutate, schema.followUp, id, { snoozesJson: JSON.stringify(list) });
  }

  /**
   * リセット前の上限待ちの対応不要（自分の番の画面の「後で」の行の `e`）:明けた後の再開のタスク（`<turn>:limit`）を
   * 対応不要で閉じた形で先に作る。同じ dedupe_key では作り直さないので、明けても「再開できる」は出ない。
   * 上限待ちでなければ 409
   */
  dismissLimit(workItemId: string): FollowUpRow {
    const now = this.clock.now();
    const l = cardLimitWait(this.sqlite, workItemId, now);
    if (!l) throw new OpError(409, "not waiting for a usage limit");
    const ref = derive.limitRef(l.turnId);
    const key = derive.dedupeKey(workItemId, "resume_error", ref);
    const existing = this.sqlite
      .query<FollowUpRow, [string]>(
        "SELECT * FROM follow_up WHERE dedupe_key = ? AND deleted_at IS NULL",
      )
      .get(key);
    if (existing) {
      if (existing.status === "open" || existing.status === "snoozed")
        return this.dismiss(existing.id);
      return existing;
    }
    const id = newId(this.clock);
    insertRow(this.mutate, schema.followUp, {
      id,
      workItemId,
      kind: "resume_error",
      artifactRef: ref,
      dedupeKey: key,
      triggerAt: l.until,
      triggerTurnId: l.turnId,
      status: "dismissed",
      closedAt: now,
      closeReason: "dismissed",
    });
    this.onChanged();
    return this.#followUp(id);
  }

  /** e: 対応不要（dismiss）。同じトリガでは再生成しない */
  dismiss(id: string): FollowUpRow {
    const row = this.#followUp(id);
    this.#live(row);
    const now = this.clock.now();
    updateRow(this.mutate, schema.followUp, id, {
      status: "dismissed",
      closedAt: now,
      closeReason: "dismissed",
      snoozesJson: capSnoozes(row.snoozes_json, now),
    });
    // 頼んだタスク（D-107）は閉じない（自分の番だけを外す）
    if (row.task_id && !isLaunchTask(this.sqlite, row.task_id))
      updateRow(this.mutate, schema.task, row.task_id, { status: "canceled", completedAt: null });
    this.onChanged();
    return this.#followUp(id);
  }

  bulkDismiss(ids: string[]): number {
    let n = 0;
    for (const id of ids) {
      try {
        this.dismiss(id);
        n++;
      } catch (e) {
        if (!(e instanceof OpError) || e.status === 400) throw e;
      }
    }
    return n;
  }

  /** Space: 手動で完了 */
  complete(id: string): FollowUpRow {
    const row = this.#followUp(id);
    this.#live(row);
    const now = this.clock.now();
    updateRow(this.mutate, schema.followUp, id, {
      status: "done",
      closedAt: now,
      closeReason: "manual",
      snoozesJson: capSnoozes(row.snoozes_json, now),
    });
    // 頼んだタスク（D-107）は自分の番を済ませても閉じない（AI が続きを始める。閉じるのはタスクの完了から）
    if (row.task_id && !isLaunchTask(this.sqlite, row.task_id)) {
      updateRow(this.mutate, schema.task, row.task_id, {
        status: "done",
        completedAt: now,
        autoCompleted: 0,
      });
      const est = derive.estimateResponse(row.engaged_at, now);
      insertRow(this.mutate, schema.taskTimeEntry, {
        taskId: row.task_id,
        startAt: est.start,
        endAt: est.end,
        source: "followup_estimate",
      });
    }
    this.onChanged();
    return this.#followUp(id);
  }

  /**
   * 完了の取り消し（⌘Z と知らせの「元に戻す」。D-139 (3)）: 手で完了にした自分の番を open に戻す（スヌーズ中に完了した
   * ものは同じ時刻までのスヌーズに戻す）。complete で一緒に閉じた
   * タスク（頼んだタスク以外）は未完了に戻し、complete が足した応答の実績（followup_estimate）を消す。
   * open / snoozed ならそのまま返す（2回押しても同じ）。手での完了でなければ 409
   */
  reopen(id: string): FollowUpRow {
    const row = this.#followUp(id);
    if (row.status === "open" || row.status === "snoozed") return row;
    if (row.status !== "done" || row.close_reason !== "manual" || row.closed_at === null)
      throw new OpError(409, `follow_up is ${row.status}`);
    // スヌーズ中に完了したもの（complete は snooze_until を残す。起こした後なら過去の時刻）は、同じ時刻までのスヌーズに戻す。
    // 完了で閉じたスヌーズの区間（snoozes_json の最後。終わりを完了の時刻に詰めた）も元の終わりに戻す
    const now = this.clock.now();
    const snoozed = row.snooze_until !== null && row.snooze_until > Math.max(now, row.closed_at);
    let snoozes = row.snoozes_json;
    if (snoozed) {
      try {
        const v = JSON.parse(row.snoozes_json) as [number, number][];
        const last = v.at(-1);
        if (last && last[1] === row.closed_at) last[1] = row.snooze_until as number;
        snoozes = JSON.stringify(v);
      } catch {
        // 読めなければそのまま
      }
    }
    updateRow(this.mutate, schema.followUp, id, {
      status: snoozed ? "snoozed" : "open",
      closedAt: null,
      closeReason: null,
      ...(snoozed ? { snoozesJson: snoozes } : {}),
    });
    if (row.task_id && !isLaunchTask(this.sqlite, row.task_id)) {
      const task = this.sqlite
        .query<{ status: string }, [string]>(
          "SELECT status FROM task WHERE id = ? AND deleted_at IS NULL",
        )
        .get(row.task_id);
      if (task?.status === "done")
        updateRow(this.mutate, schema.task, row.task_id, {
          status: "todo",
          completedAt: null,
          autoCompleted: 0,
        });
      const est = derive.estimateResponse(row.engaged_at, row.closed_at);
      for (const e of this.sqlite
        .query<{ id: string }, [string, number, number]>(
          "SELECT id FROM task_time_entry WHERE task_id = ? AND source = 'followup_estimate' AND start_at = ? AND end_at = ? AND deleted_at IS NULL",
        )
        .all(row.task_id, est.start, est.end))
        softDelete(this.mutate, schema.taskTimeEntry, e.id);
    }
    this.onChanged();
    return this.#followUp(id);
  }

  /**
   * y: カードの返答タスクを手で作る（D-066 (2)。phase0-plan 3.3）。トリガはカードの最後のターン、trigger_at は今。
   * open / snoozed の reply（どの種類でも）が既にあれば作らずにそれを返す。ターンが無いカード（PR の head ブランチだけの
   * カードなど）はトリガのターンなし・artifact_ref `card:manual` で作る。
   * カードに開いているタスク（完了・取り消し以外）が既に結び付いていれば（open / snoozed のフォローアップのタスク（種類を
   * 問わない）か、そのカードのセッションを起動した頼んだタスク（D-107））、作らずにそのタスクを返す（同じ件が同じ日に2つ
   * 並ばないように）。row は結び付けたフォローアップ（頼んだタスクだけのときは null）
   */
  createReplyTask(workItemId: string): {
    row: FollowUpRow | null;
    created: boolean;
    taskId: string | null;
  } {
    const w = this.sqlite
      .query<
        {
          id: string;
          title_user: string | null;
          title_auto: string | null;
          repo_root: string | null;
          branch: string | null;
          scratch: number;
        },
        [string]
      >(
        "SELECT id, title_user, title_auto, repo_root, branch, scratch FROM work_item WHERE id = ? AND deleted_at IS NULL",
      )
      .get(workItemId);
    if (!w) throw new OpError(404, "work_item not found");
    const live = this.sqlite
      .query<FollowUpRow, [string]>(
        "SELECT * FROM follow_up WHERE work_item_id = ? AND kind = 'reply' AND status IN ('open', 'snoozed') AND deleted_at IS NULL ORDER BY trigger_at DESC LIMIT 1",
      )
      .get(workItemId);
    if (live) return { row: live, created: false, taskId: live.task_id };
    const OPEN_TASK = "k.deleted_at IS NULL AND k.status NOT IN ('done', 'canceled')";
    const linked = this.sqlite
      .query<FollowUpRow, [string]>(
        `SELECT f.* FROM follow_up f JOIN task k ON k.id = f.task_id
         WHERE f.work_item_id = ? AND f.status IN ('open', 'snoozed') AND f.deleted_at IS NULL AND ${OPEN_TASK}
         ORDER BY f.trigger_at DESC LIMIT 1`,
      )
      .get(workItemId);
    if (linked) return { row: linked, created: false, taskId: linked.task_id };
    const launched = this.sqlite
      .query<{ id: string }, [string]>(
        `SELECT k.id FROM ai_launch l JOIN task k ON k.id = l.task_id
         WHERE ${OPEN_TASK} AND l.session_id IN (SELECT DISTINCT session_id FROM ai_turn WHERE work_item_id = ?)
         ORDER BY l.created_at DESC LIMIT 1`,
      )
      .get(workItemId);
    if (launched) return { row: null, created: false, taskId: launched.id };
    const last = this.sqlite
      .query<{ id: string }, [string]>(
        `SELECT t.id FROM ai_turn t JOIN ai_session s ON s.id = t.session_id
         WHERE t.work_item_id = ? AND s.is_noise = 0 ORDER BY t.started_at DESC, t.id DESC LIMIT 1`,
      )
      .get(workItemId);
    const settings = readSettings(this.mutate.db);
    const now = this.clock.now();
    const today = toLocalDate(now, settings.tz, settings.dayBoundary);
    const used = this.sqlite.query<{ n: number }, [string]>(
      "SELECT count(*) AS n FROM follow_up WHERE dedupe_key = ?",
    );
    const ref = derive.manualRef(
      last?.id ?? "card",
      (r) => (used.get(derive.dedupeKey(workItemId, "reply", r))?.n ?? 0) > 0,
    );
    // 題名は自動の返答タスクと同じく種類とパラメータで保存する（D-046）。表示時にカードの今の題名で組み立てる
    const params: TaskTitleParams = {
      title: w.title_user ?? w.title_auto ?? null,
      repo: w.repo_root ? (w.repo_root.split("/").at(-1) ?? null) : null,
      branch: w.branch,
      pr: null,
      prTitle: null,
      ...(w.scratch === 1 ? { scratch: true } : {}),
    };
    const tail = this.sqlite
      .query<{ lane_order: string }, [string]>(
        "SELECT lane_order FROM task WHERE scheduled_date = ? AND deleted_at IS NULL ORDER BY lane_order DESC LIMIT 1",
      )
      .get(today);
    const fuId = newId(this.clock);
    const task = insertRow(this.mutate, schema.task, {
      title: "",
      titleKey: taskTitleKeyFor("reply"),
      titleParams: JSON.stringify(params),
      status: "todo",
      scheduledDate: today,
      laneOrder: tail ? orderKeyAfter(tail.lane_order) : orderKeyBetween(null, null),
      projectId: projectIdForRepo(this.sqlite, w.repo_root),
      source: "manual",
      sourceRef: `follow_up:${fuId}`,
    });
    insertRow(this.mutate, schema.followUp, {
      id: fuId,
      workItemId,
      kind: "reply",
      artifactRef: ref,
      dedupeKey: derive.dedupeKey(workItemId, "reply", ref),
      triggerAt: now,
      triggerTurnId: last?.id ?? null,
      status: "open",
      taskId: task.id,
    });
    this.onChanged();
    this.publish?.("task", { dates: [today], ids: [task.id], inbox: false });
    this.publish?.("follow_up", { ids: [fuId], workItemIds: [workItemId] });
    return { row: this.#followUp(fuId), created: true, taskId: task.id };
  }

  /** カードの手動完了・非表示・タイトル */
  patchWorkItem(
    id: string,
    p: { titleUser?: string | null; hidden?: boolean; manualDone?: boolean },
  ): void {
    const w = this.sqlite
      .query<{ id: string }, [string]>(
        "SELECT id FROM work_item WHERE id = ? AND deleted_at IS NULL",
      )
      .get(id);
    if (!w) throw new OpError(404, "work_item not found");
    const now = this.clock.now();
    updateRow(this.mutate, schema.workItem, id, {
      ...(p.titleUser !== undefined ? { titleUser: p.titleUser } : {}),
      ...(p.hidden !== undefined ? { hiddenAt: p.hidden ? now : null } : {}),
      ...(p.manualDone !== undefined ? { manualDoneAt: p.manualDone ? now : null } : {}),
    });
    this.onChanged();
  }

  /**
   * POST /api/work-items/:id/merge（m2-api.md 19章）: id のカードを intoId へ統合する（merge.ts の mergeCardInto）
   */
  mergeWorkItem(id: string, intoId: string): void {
    if (id === intoId) throw new OpError(409, "cannot_merge");
    const q = this.sqlite.query<{ id: string; merged_into_id: string | null }, [string]>(
      "SELECT id, merged_into_id FROM work_item WHERE id = ? AND deleted_at IS NULL",
    );
    const from = q.get(id);
    const into = q.get(intoId);
    if (!from || !into || from.merged_into_id || into.merged_into_id)
      throw new OpError(409, "cannot_merge");
    mergeCardInto(this.sqlite, this.mutate, id, intoId, this.clock.now());
    this.onChanged();
    this.publish?.("follow_up", { ids: [], workItemIds: [id, intoId] });
  }
}
