/**
 * デイビューの集約（GET /api/day/:date。m2-api.md 2.3・2.4、M2-19）。週ボードの1日分（buildBoard の detail）に、
 * 自分・会議の時間、その論理日に閉じた自分の番、空き枠、リポジトリ別の放置を足す。
 * 描画の素材（予定・時間ブロック・実績・AI の実行と待ち）は暦日の時間軸（0:00〜24:00。D-054）にかかるもの。
 * 集計（totals・closedToday・idleByRepo）は同じ日付の論理日。ただし暦日の今日を 0:00〜日付区切りに
 * 開いたときは、今の論理日（前日）の集計を返す（summary.date。3日ボードの今日の列の AI 項目の値と同じ考え方）。
 */
import type { Database } from "bun:sqlite";
import {
  addDays,
  dayStartMs,
  derive,
  type TurnlaneSettings,
  type WorkdayRule,
} from "@turnlane/core";
import type {
  AiLaneItemDetail,
  DayColumn,
  DayDetail,
  DayResponse,
  Interval,
} from "@turnlane/core/api";
import { freeSlots, planWindow } from "@turnlane/core/plan";
import { closedRowsBetween, idleRepoKey, idleRepoOf } from "../derive/views.ts";
import { buildBoard } from "./board.ts";

function union(xs: Interval[]): Interval[] {
  const s = xs.filter((x) => x.end > x.start).sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const x of s) {
    const p = out.at(-1);
    if (p && x.start <= p.end) p.end = Math.max(p.end, x.end);
    else out.push({ ...x });
  }
  return out;
}

const len = (xs: Interval[]) => xs.reduce((a, x) => a + (x.end - x.start), 0);

const within = (xs: Interval[], r: Interval): Interval[] =>
  xs
    .map((x) => ({ start: Math.max(x.start, r.start), end: Math.min(x.end, r.end) }))
    .filter((x) => x.end > x.start);

/**
 * busy な時刻付きの予定の区間（source の役割のカレンダー、Turnlane の時間ブロックの予定を除く。和集合）。
 * デイビューの会議と空き枠に使い、拡張（ADR 0015）にも ExtDeps.calendar.busy として渡す
 */
export function busyIntervals(db: Database, from: number, to: number): Interval[] {
  return union(
    db
      .query<
        {
          start_at: number;
          end_at: number;
          status: "confirmed" | "tentative" | "cancelled" | null;
          availability: "busy" | "free" | "tentative" | "unavailable" | null;
          self_response: "accepted" | "declined" | "tentative" | "pending" | "unknown" | null;
          role: "source" | "writeback" | "ignored";
        },
        [number, number]
      >(
        `SELECT e.start_at, e.end_at, e.status, e.availability, e.self_response, c.role
         FROM calendar_event e JOIN calendar c ON c.id = e.calendar_id
         WHERE c.role = 'source' AND e.is_own_timeblock = 0 AND e.all_day = 0
           AND (e.status IS NULL OR e.status <> 'cancelled') AND e.end_at > ? AND e.start_at < ?`,
      )
      .all(from, to)
      .filter((e) =>
        derive.isBusyEvent({
          startAt: e.start_at,
          endAt: e.end_at,
          status: e.status,
          availability: e.availability,
          selfResponse: e.self_response,
          isOwnTimeblock: false,
          calendarRole: e.role,
        }),
      )
      .map((e) => ({ start: e.start_at, end: e.end_at })),
  );
}

export function buildDay(
  db: Database,
  settings: TurnlaneSettings,
  now: number,
  rev: number,
  date: string,
  rule: WorkdayRule = { weekdays: settings.workdays, holidays: new Set() },
): DayResponse {
  return db.transaction(() => {
    const board = buildBoard(db, settings, now, rev, date, date, rule, { detail: true });
    const col = board.days[0];
    if (!col) throw new Error("unreachable: buildBoard returned no day");
    // 集計の論理日: 暦日の今日を深夜（0:00〜日付区切り）に開いたときは今の論理日（前日）
    const night = col.phase === "today" && col.logicalPhase === "future";
    const statsDate = night ? board.today : date;
    let stats: DayColumn = col;
    if (night) {
      const prev = buildBoard(db, settings, now, rev, statsDate, statsDate, rule).days[0];
      if (!prev) throw new Error("unreachable: buildBoard returned no day");
      stats = prev;
    }
    const logical = {
      start: dayStartMs(statsDate, settings.tz, settings.dayBoundary),
      end: dayStartMs(addDays(statsDate, 1), settings.tz, settings.dayBoundary),
    };

    // 自分 = 全タスクの実績の和集合（壁時計。論理日。m2-api.md 2.4）
    const entries = db
      .query<{ start_at: number; end_at: number | null }, [number, number]>(
        "SELECT start_at, end_at FROM task_time_entry WHERE deleted_at IS NULL AND start_at < ? AND (end_at IS NULL OR end_at > ?)",
      )
      .all(logical.end, logical.start)
      .map((e) => ({ start: e.start_at, end: e.end_at ?? now }));
    const youMs = len(within(union(entries), logical));

    // 会議 = busy な時刻付き予定の和集合（論理日の中。D-105 で勤務時間で切るのをやめた）。予定は論理日にかかるもの
    // （暦日の列の外も含めて読み直す）
    const busyIv = busyIntervals(db, logical.start, logical.end);
    const meetingsMs = len(within(busyIv, logical));

    // 空き枠: 計画の窓（Free と同じ。容量の定義 9.1。D-106）− busy な予定 − 時間ブロック。今日は今より後だけ
    const window = planWindow({
      phase: col.logicalPhase,
      now,
      planned: col.plannedHours,
      workday: col.workday,
    });
    const slots = freeSlots(
      window,
      [...busyIv, ...col.timeBlocks.map((b) => ({ start: b.start, end: b.end }))],
      col.logicalPhase === "today" ? now : null,
    );

    // リポジトリ別の放置（和集合。D-045 (2)）
    const segs = db
      .query<
        { repo_root: string | null; scratch: number | null; start_at: number; end_at: number },
        [string]
      >(
        `SELECT w.repo_root, w.scratch, s.start_at, s.end_at FROM ai_wait_segment s
         LEFT JOIN work_item w ON w.id = s.work_item_id
         WHERE s.local_date = ? AND s.kind = 'idle' AND (w.hidden_at IS NULL)`,
      )
      .all(statsDate);
    const byRepo = new Map<string | null, Interval[]>();
    for (const s of segs) {
      // 壁打ちは git 管理外と分けて数える（D-135）
      const k = idleRepoKey(s.repo_root, s.scratch === 1);
      const xs = byRepo.get(k) ?? [];
      xs.push({ start: s.start_at, end: s.end_at });
      byRepo.set(k, xs);
    }
    const idleByRepo = [...byRepo]
      .map(([k, xs]) => ({ ...idleRepoOf(k), ms: len(union(xs)) }))
      .filter((x) => x.ms > 0)
      .sort((a, b) => b.ms - a.ms);

    const day: DayDetail = {
      ...col,
      aiLane: (col.aiLane ?? []) as AiLaneItemDetail[],
      totals: { ...stats.totals, youMs, meetingsMs },
      summary: { date: statsDate, phase: stats.logicalPhase },
      closedToday: closedRowsBetween(db, logical.start, logical.end),
      freeSlots: slots,
      idleByRepo,
    };
    const { days: _days, ...meta } = board;
    return { ...meta, day };
  })();
}
