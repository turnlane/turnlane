/**
 * 記録（日報。M4-3）、日付区切りでの日の確定（M4-4）、持ち越し（「残り N 件を今日へ」。D-192）、利用計測（M5-1）。
 * 儀式の画面（朝の計画・一日を閉じる）は D-192 で廃止した。閉じる概念は無く、放置は在席で数える（D-105）。
 *
 * - 記録: 日付区切りを越えたとき、その時点の日報を report_md に確定する（持ち越しはしない）。
 *   期限切れが後から遡って Idle を変えても、確定した日報は変わらない（phase0-plan 3.3.1）
 * - 持ち越し: 自動では動かさない。過去の日の列の「残り N 件を今日へ」で、その日に残った自分のタスクを今日の未定へ移す
 *   （rollover_count 加算。D-040・D-047 (4)）。移した事実は usage_event の `carry`（ref = `元の日:移した日:タスク id`）に
 *   残し、記録の「持ち越し」の節はそれだけを出す。元に戻せる
 */
import type { Database } from "bun:sqlite";
import {
  addDays,
  type Clock,
  carryTarget,
  dayStartMs,
  insertRow,
  type MutateCtx,
  newId,
  report as R,
  schema,
  type TurnlaneSettings,
  toLocalDate,
  updateRow,
  type WorkdayRule,
} from "@turnlane/core";
import type {
  CarriedTask,
  CarryDayInput,
  CarryDayResponse,
  DailyReport,
  DailyReportResponse,
  DailySummaryView,
  DeferFollowUpResponse,
  ReportCarryLine,
  ReportLocale,
  UndoCarryInput,
  UndoCarryResponse,
  UsageStats,
} from "@turnlane/core/api";
import { OpError, type UserOps } from "../derive/ops.ts";
import { logicalDay, plannedStart, responseWaitSegments } from "../derive/views.ts";
import { presenceIn } from "../presence/service.ts";
import { readMeta, type TaskRow } from "./common.ts";
import { buildDailyReport } from "./report.ts";
import type { TaskService } from "./tasks.ts";

export interface DailyNoteOptions {
  sqlite: Database;
  mutate: MutateCtx;
  clock: Clock;
  settings: () => TurnlaneSettings;
  rev: () => number;
  /** 画面の言語（ui.language。system は英語で書く） */
  locale: () => ReportLocale;
  tasks: TaskService;
  publish: (type: "task" | "follow_up", data: Record<string, unknown>) => void;
  /** 自分の番の操作（スヌーズ）。取り込みが動いていなければ無い */
  ops?: UserOps | undefined;
  /** 稼働日の規則と祝日名（M3-6）。無ければ設定の稼働曜日だけ（祝日なし） */
  workdays?: () => { rule: WorkdayRule; names: ReadonlyMap<string, string | null> };
  /** 日報の AI 要約（M4-6）。無ければ要約なし（オフと同じ表示） */
  summary?: () => { view(date: string): DailySummaryView } | null;
}

interface NoteRow {
  id: string;
  memo_md: string | null;
  report_md: string | null;
}

const SHOWN = "('reply', 'review_pr', 'approve', 'resume_error')";
/** 「残り N 件」に含める、その日より前の日付のまま残っている未完了の範囲（日） */
export const CARRY_OLDER_DAYS = 14;

/** usage_event の carry の ref（`元の日:移した日:タスク id`） */
const carryRef = (from: string, to: string, taskId: string) => `${from}:${to}:${taskId}`;

/**
 * その日に残っている自分のタスク（「残り N 件を今日へ」の対象。D-192）: 未完了（todo）で、自分の番でない。
 * 未定のものと、時間ブロックに置いたまま完了していないものの両方。older なら、その日より前（CARRY_OLDER_DAYS 日）の
 * 日付のまま残っている未完了も含める（古い順）
 */
export function carryCandidates(db: Database, date: string, older: boolean): TaskRow[] {
  const floor = older ? addDays(date, -CARRY_OLDER_DAYS) : date;
  return db
    .query<TaskRow, [string, string]>(
      `SELECT t.* FROM task t
        WHERE t.deleted_at IS NULL AND t.status = 'todo'
          AND t.scheduled_date <= ?1 AND t.scheduled_date >= ?2
          AND NOT EXISTS (SELECT 1 FROM follow_up f WHERE f.task_id = t.id AND f.deleted_at IS NULL
                          AND f.status IN ('open', 'snoozed'))
        ORDER BY t.scheduled_date, t.lane_order`,
    )
    .all(date, floor);
}

/** 列ごとの「残り N 件」（ボードの見出し。older は最初の過去の列だけ） */
export function carryCounts(db: Database, date: string): { count: number; older: number } {
  const same = carryCandidates(db, date, false).length;
  const all = carryCandidates(db, date, true).length;
  return { count: same, older: all - same };
}

export class DailyNoteService {
  constructor(private readonly o: DailyNoteOptions) {}

  #today(): string {
    const s = this.o.settings();
    return toLocalDate(this.o.clock.now(), s.tz, s.dayBoundary);
  }

  #note(date: string): NoteRow | null {
    return this.o.sqlite
      .query<NoteRow, [string]>(
        "SELECT id, memo_md, report_md FROM daily_note WHERE date = ? AND deleted_at IS NULL",
      )
      .get(date);
  }

  #upsertNote(date: string, p: Partial<typeof schema.dailyNote.$inferInsert>): void {
    const row = this.#note(date);
    if (row) updateRow(this.o.mutate, schema.dailyNote, row.id, p);
    else insertRow(this.o.mutate, schema.dailyNote, { date, ...p });
  }

  /** date の次の稼働日と飛ばした祝日（`m` 明日の行き先） */
  #next(date: string) {
    const w = this.o.workdays?.() ?? {
      rule: { weekdays: this.o.settings().workdays, holidays: new Set<string>() },
      names: new Map<string, string | null>(),
    };
    return carryTarget(date, w.rule, w.names);
  }

  /** その日から実際に移したタスク（usage_event の carry）。移した順 */
  #carriedFrom(date: string): { taskId: string; to: string }[] {
    return this.o.sqlite
      .query<{ ref: string }, [string]>(
        "SELECT ref FROM usage_event WHERE kind = 'carry' AND substr(ref, 1, 11) = ? ORDER BY at, rowid",
      )
      .all(`${date}:`)
      .map((r) => ({ to: r.ref.slice(11, 21), taskId: r.ref.slice(22) }));
  }

  /** 日報の事実。持ち越しの行は、その日から実際に移したタスクだけ（D-192） */
  #report(date: string): DailyReport {
    return buildDailyReport(this.o.sqlite, this.o.settings(), this.o.clock.now(), date, {
      carried: this.#carriedFrom(date),
    });
  }

  #summary(date: string): DailySummaryView {
    const sv = this.o.summary?.();
    if (sv) return sv.view(date);
    const s = this.o.settings().aiSummary;
    return {
      enabled: s.enabled,
      configuredTool: s.tool,
      md: null,
      tool: null,
      at: null,
      job: null,
    };
  }

  /** 要約に渡す日報の Markdown（確定済みなら保存したもの、未確定なら今の事実から組み立てた Note を含む全文。M4-6） */
  /**
   * AI 要約の子プロセスに渡す日報（ADR 0005 の追記・ADR 0018）。保存した指示・待ちの中身（asked・stopped）は外に出さない
   * ので、事実から組み立て直し、その 2 つを外す
   */
  reportMarkdown(date: string, locale: ReportLocale): string {
    const report = this.#report(this.#date(date));
    return R.renderDailyReport(
      {
        ...report,
        aiDid: report.aiDid.map(({ asked: _a, stopped: _s, ...x }) => x),
      },
      locale,
    );
  }

  /** 日付の検証（未来の日は 400） */
  checkDate(date: string): string {
    return this.#date(date);
  }

  #date(date: string | undefined): string {
    const d = date ?? this.#today();
    if (d > this.#today()) throw new OpError(400, "future_date");
    return d;
  }

  /**
   * GET /api/reports/daily/:date（記録のパネル・turnlane report・MCP）。確定済みならその Markdown に、確定の後で
   * 移した持ち越しの節を足したもの（確定は持ち越しより前に起きるため）
   */
  daily(date: string | undefined, lang: ReportLocale | undefined): DailyReportResponse {
    const d = this.#date(date);
    const locale = lang ?? this.o.locale();
    const report = this.#report(d);
    const note = this.#note(d);
    const markdown = note?.report_md
      ? R.withCarried(note.report_md, report.carried, locale)
      : R.renderDailyReport(report, locale);
    const summary = this.#summary(d);
    return {
      ...readMeta(this.o.settings(), this.o.clock.now(), this.o.rev()),
      date: d,
      report,
      markdown,
      saved: note?.report_md != null,
      summary,
      // コピー・turnlane report・MCP は先頭に Summary を付ける（見出しは UI の言語）
      exportMarkdown: R.withSummary(markdown, summary.md, summary.tool, locale),
    };
  }

  /** PUT /api/daily-notes/:date（Note の1行） */
  putNote(date: string, note: string | null): { rev: number; date: string; note: string | null } {
    const d = this.#date(date);
    const v = note?.trim() ? note.trim() : null;
    this.#upsertNote(d, { memoMd: v });
    this.o.publish("task", { dates: [d], ids: [], inbox: false });
    return { rev: this.o.rev(), date: d, note: v };
  }

  /**
   * 日付区切りでの日の確定（M4-4）: その時点の日報を report_md に残す。
   * Mac を使っていない（在席が無い）うえに AI の動きも完了も無い日は何もしない。確定したら true
   */
  finalizeDay(date: string): boolean {
    if (date >= this.#today()) return false;
    const note = this.#note(date);
    if (note?.report_md) return false;
    const report = this.#report(date);
    const day = logicalDay(date, this.o.settings());
    const present =
      presenceIn(this.o.sqlite, day.start, day.end, this.o.settings().presenceTailMs).length > 0;
    if (!present && report.runs === 0 && report.did.length === 0) return false;
    // 持ち越しは「残り N 件を今日へ」で後から足す（daily が確定の Markdown に足して返す）
    const md = R.renderDailyReport({ ...report, carried: [] }, this.o.locale());
    this.#upsertNote(date, { reportMd: md });
    return true;
  }

  /**
   * POST /api/days/:date/carry（「残り N 件を今日へ」。D-192）: その日に残っている自分のタスクを今日の未定へ。
   * 時間ブロックは外し、持ち越し回数を +1。過去の日だけ（今日・未来は 400）
   */
  carry(date: string, input: CarryDayInput): CarryDayResponse {
    const d = this.#date(date);
    const to = this.#today();
    if (d >= to) throw new OpError(400, "not_past");
    const moved: CarriedTask[] = [];
    const dates = new Set<string>([to]);
    for (const t of carryCandidates(this.o.sqlite, d, input.older === true)) {
      const from = t.scheduled_date ?? d;
      const blocks = this.o.sqlite
        .query<{ id: string; start_at: number; end_at: number }, [string]>(
          "SELECT id, start_at, end_at FROM time_block WHERE task_id = ? AND deleted_at IS NULL ORDER BY start_at",
        )
        .all(t.id);
      for (const b of blocks) this.o.tasks.deleteTimeBlock(b.id);
      this.o.tasks.move(t.id, { date: to, carry: true });
      this.recordUsage("carry", carryRef(from, to, t.id));
      dates.add(from);
      moved.push({
        taskId: t.id,
        from,
        blocks: blocks.map((b) => ({ id: b.id, start: b.start_at, end: b.end_at })),
      });
    }
    if (moved.length > 0)
      this.o.publish("task", { dates: [...dates], ids: moved.map((m) => m.taskId), inbox: false });
    return { rev: this.o.rev(), to, moved };
  }

  /** POST /api/days/carry/undo: 元の日付・元の時間ブロックに戻し、持ち越し回数と carry の記録も戻す */
  undoCarry(input: UndoCarryInput): UndoCarryResponse {
    const restored: string[] = [];
    const dates = new Set<string>();
    for (const m of input.moved) {
      const row = this.o.sqlite
        .query<{ scheduled_date: string | null; rollover_count: number }, [string]>(
          "SELECT scheduled_date, rollover_count FROM task WHERE id = ? AND deleted_at IS NULL",
        )
        .get(m.taskId);
      if (!row) continue;
      const cur = row.scheduled_date;
      this.o.tasks.move(m.taskId, { date: m.from });
      updateRow(this.o.mutate, schema.task, m.taskId, {
        rolloverCount: Math.max(0, row.rollover_count - 1),
      });
      for (const b of m.blocks) {
        const exists = this.o.sqlite
          .query<{ id: string }, [string]>("SELECT id FROM time_block WHERE id = ?")
          .get(b.id);
        if (exists) updateRow(this.o.mutate, schema.timeBlock, b.id, { deletedAt: null });
      }
      if (cur)
        this.o.sqlite.run("DELETE FROM usage_event WHERE kind = 'carry' AND ref = ?", [
          carryRef(m.from, cur, m.taskId),
        ]);
      dates.add(m.from);
      if (cur) dates.add(cur);
      restored.push(m.taskId);
    }
    if (restored.length > 0)
      this.o.publish("task", { dates: [...dates], ids: restored, inbox: false });
    return { rev: this.o.rev(), restored };
  }

  /** 利用イベント（M5-1）。本人の操作（user_op）とは別の kind で残す */
  recordUsage(kind: string, ref: string | null = null): void {
    this.o.sqlite.run("INSERT INTO usage_event (id, at, kind, ref) VALUES (?, ?, ?, ?)", [
      newId(this.o.clock),
      this.o.clock.now(),
      kind,
      ref,
    ]);
  }

  /** turnlane stats（M5-1。14日カウント、自分の番の処理数、平均応答） */
  stats(days: number): UsageStats {
    const s = this.o.settings();
    const today = this.#today();
    const from = dayStartMs(addDays(today, -(days - 1)), s.tz, s.dayBoundary);
    const local = (at: number) => toLocalDate(at, s.tz, s.dayBoundary);
    const opened = new Set<string>();
    for (const e of this.o.sqlite
      .query<{ at: number }, [number]>(
        "SELECT at FROM usage_event WHERE at >= ? AND kind = 'ui_open'",
      )
      .all(from))
      opened.add(local(e.at));
    const fus = this.o.sqlite
      .query<
        {
          id: string;
          work_item_id: string;
          status: "done" | "dismissed" | "expired" | "superseded";
          close_reason: string | null;
          trigger_at: number;
          engaged_at: number | null;
          closed_at: number;
        },
        [number]
      >(
        `SELECT id, work_item_id, status, close_reason, trigger_at, engaged_at, closed_at FROM follow_up
         WHERE deleted_at IS NULL AND closed_at >= ? AND status IN ('done', 'dismissed', 'expired', 'superseded')
           AND kind IN ${SHOWN}`,
      )
      .all(from);
    return R.usageStats({
      today,
      days,
      opened,
      followUps: fus.map((f) => ({
        date: local(f.closed_at),
        status: f.status,
        closeReason: f.close_reason,
        triggerAt: f.trigger_at,
        engagedAt: f.engaged_at,
        closedAt: f.closed_at,
        // 応答時間は猶予と放置の区間だけで数える（D-057）。返答・⏎ したもの以外は使わないので読まない
        waitSegments: f.status === "done" ? responseWaitSegments(this.o.sqlite, f) : [],
      })),
    });
  }

  /** date の計画の目安の開始（epoch ms。D-064・D-106） */
  plannedStart(date: string): number {
    return plannedStart(date, this.o.settings());
  }

  /**
   * `m` 明日（D-052 (1)）: 自分の番のタスクを次の稼働日へ移し（手での移動なので持ち越し回数は数えない）、
   * 次の稼働日の計画の目安の開始（D-064・D-106）までスヌーズする。今日の帯から消え、放置にも数えない（D-032）
   */
  defer(followUpId: string, date?: string): DeferFollowUpResponse {
    if (date !== undefined && date <= this.#today()) throw new OpError(400, "date_not_future");
    const ops = this.o.ops;
    if (!ops) throw new OpError(409, "ai_unavailable");
    const fu = this.o.sqlite
      .query<{ id: string; task_id: string | null; status: string }, [string]>(
        "SELECT id, task_id, status FROM follow_up WHERE id = ? AND deleted_at IS NULL",
      )
      .get(followUpId);
    if (!fu) throw new OpError(404, "follow_up not found");
    if (fu.status !== "open" && fu.status !== "snoozed")
      throw new OpError(409, `follow_up is ${fu.status}`);
    const to = date ?? this.#next(this.#today()).to;
    const until = this.plannedStart(to);
    let taskDate: string | null = null;
    if (fu.task_id) {
      const r = this.o.tasks.move(fu.task_id, { date: to });
      taskDate = r.task?.scheduledDate ?? to;
    }
    // 計画の目安の開始が過ぎている（深夜に閉じて朝を越えた等）ときは日付の移動だけ
    const snoozed = until > this.o.clock.now();
    if (snoozed) ops.snooze(followUpId, until);
    this.o.publish("follow_up", { ids: [followUpId], workItemIds: [] });
    return { rev: this.o.rev(), followUpId, taskDate, snoozeUntil: snoozed ? until : null };
  }

  /**
   * 今やる（自分の番の画面の「後で」）: スヌーズを外して帯に戻す。`m` 明日で次の稼働日へ移したタスク（日付が今日より後）は
   * 今日へ戻す。時間に置いた自分の番（開始の前）は、開始の来ていない時間ブロックを消して帯に戻す
   */
  wake(followUpId: string): DeferFollowUpResponse {
    const ops = this.o.ops;
    if (!ops) throw new OpError(409, "ai_unavailable");
    const fu = this.o.sqlite
      .query<{ id: string; task_id: string | null; status: string }, [string]>(
        "SELECT id, task_id, status FROM follow_up WHERE id = ? AND deleted_at IS NULL",
      )
      .get(followUpId);
    if (!fu) throw new OpError(404, "follow_up not found");
    if (fu.status !== "open" && fu.status !== "snoozed")
      throw new OpError(409, `follow_up is ${fu.status}`);
    const today = this.#today();
    let taskDate: string | null = null;
    if (fu.task_id) {
      const d = this.o.sqlite
        .query<{ scheduled_date: string | null }, [string]>(
          "SELECT scheduled_date FROM task WHERE id = ? AND deleted_at IS NULL",
        )
        .get(fu.task_id)?.scheduled_date;
      taskDate = d ?? null;
      if (d && d > today) {
        const r = this.o.tasks.move(fu.task_id, { date: today });
        taskDate = r.task?.scheduledDate ?? today;
      }
      // 時間に置いた自分の番（開始の前）: 時間の割り当て（開始がまだ来ていない時間ブロック）を外して帯に戻す。置いてから今までは
      // 集計外のまま残す（ブロックを消すと scheduled の区間も消えるため、スヌーズの区間として残す）
      if (fu.status === "open") {
        const now = this.o.clock.now();
        const blocks = this.o.sqlite
          .query<{ id: string; created_at: number }, [string, number]>(
            "SELECT id, created_at FROM time_block WHERE task_id = ? AND deleted_at IS NULL AND start_at > ? ORDER BY created_at",
          )
          .all(fu.task_id, now);
        const first = blocks[0];
        if (first) ops.keepExcluded(followUpId, first.created_at);
        for (const b of blocks) this.o.tasks.deleteTimeBlock(b.id);
      }
    }
    ops.unsnooze(followUpId);
    this.o.publish("follow_up", { ids: [followUpId], workItemIds: [] });
    return { rev: this.o.rev(), followUpId, taskDate, snoozeUntil: null };
  }
}

/** ReportCarryLine の形（タスクの題名は buildDailyReport が引く） */
export type CarriedRef = Pick<ReportCarryLine, "taskId" | "to">;
