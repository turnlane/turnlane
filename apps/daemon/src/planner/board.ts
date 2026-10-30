/**
 * 週ボードの集約（GET /api/board?from&to。m2-api.md 2.3・2.4）。1つの読み取りトランザクションで日ごとの
 * DayColumn を組み立てる。サーバーは時刻（epoch ms）と列挙値だけを返し、配置計算・文言はクライアントが行う。
 *
 * 表示と集計で日付の区切りを分ける（D-054、ux-mvp 4.4.1）:
 * - 表示（列の時間軸、今日の列、予定・時間ブロック・実績・AI の配置）は暦どおり 0:00 区切り
 * - 集計（totals、容量、Idle、Expired、AI 時間）は同じ日付の論理日（日付区切り。既定 04:00）
 */

import type { Database } from "bun:sqlite";
import {
  addDays,
  dayStartMs,
  derive,
  isCalendarColorKey,
  isWorkday,
  plannedOn,
  type TurnlaneSettings,
  toLocalDate,
  type WorkdayRule,
} from "@turnlane/core";
import type {
  AiLaneItem,
  AiRun,
  AiRunDetail,
  BoardResponse,
  CalendarEventView,
  DayColumn,
  DayWaitSegment,
  Interval,
  TimeEntryView,
  WaitSegmentBrief,
} from "@turnlane/core/api";
import { capacity } from "@turnlane/core/plan";
import { EDITABLE_SQL } from "../calendar/events.ts";
import { withHookEnds } from "../derive/hook-end.ts";
import { cardLimitWait } from "../derive/limit.ts";
import { subagentRuns } from "../derive/subagents.ts";
import { titleResolver } from "../derive/subject.ts";
import { aiTimeByWorkItem, openWaitStarts, subagentRunDetail } from "../derive/views.ts";
import { aiByTask } from "../launch/views.ts";
import {
  followUpsByTask,
  readMeta,
  resolveTaskTitles,
  sourcesByWorkItem,
  type TaskRow,
  taskView,
} from "./common.ts";
import { carryCounts } from "./daily-note.ts";

interface EventRow {
  id: string;
  title: string | null;
  start_at: number;
  end_at: number;
  all_day: number;
  start_date: string | null;
  end_date: string | null;
  status: "confirmed" | "tentative" | "cancelled" | null;
  availability: "busy" | "free" | "tentative" | "unavailable" | null;
  self_response: "accepted" | "declined" | "tentative" | "pending" | "unknown" | null;
  is_own_timeblock: number;
  role: "source" | "writeback" | "ignored";
  color: string | null;
  color_key: string | null;
  calendar_id: string;
  /** Turnlane から編集できる（D-093。EDITABLE_SQL） */
  editable: number;
}

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

export function buildBoard(
  db: Database,
  settings: TurnlaneSettings,
  now: number,
  rev: number,
  from: string,
  to: string,
  /** 稼働日（M3-6）。省略時は設定の稼働曜日だけ（祝日なし） */
  rule: WorkdayRule = { weekdays: settings.workdays, holidays: new Set() },
  /**
   * detail: デイビュー（M2-19）用。今日以外の日も AI レーンを返し、ターンにツール呼び出し数などを、
   * 待ちに3区分（kind / excludedBy / endReason）を付ける（DayDetail。core/api/day.ts）
   */
  opts: { detail?: boolean } = {},
): BoardResponse {
  return db.transaction(() => {
    const meta = readMeta(settings, now, rev);
    /** 論理日の今日（集計と儀式） */
    const today = meta.today;
    /** 暦日の今日（表示。D-054） */
    const displayToday = meta.displayToday;
    const dates: string[] = [];
    for (let d = from; d <= to; d = addDays(d, 1)) dates.push(d);
    const calStart = (d: string) => dayStartMs(d, settings.tz, 0);
    const logStart = (d: string) => dayStartMs(d, settings.tz, settings.dayBoundary);
    const phaseOf = (d: string, t: string): DayColumn["phase"] =>
      d < t ? "past" : d === t ? "today" : "future";
    // 暦日の時間軸と論理日の範囲の両方を覆う
    const rangeStart = Math.min(calStart(from), logStart(from));
    const rangeEnd = Math.max(calStart(addDays(to, 1)), logStart(addDays(to, 1)));

    // 予定（source のカレンダー。自分の時間ブロックは時間ブロックとして出すので除く）
    const events = db
      .query<EventRow, [number, number, string, string]>(
        `SELECT e.id, e.title, e.start_at, e.end_at, e.all_day, e.start_date, e.end_date, e.status, e.availability,
                e.self_response, e.is_own_timeblock, e.calendar_id, c.role, c.color, c.color_key,
                ${EDITABLE_SQL} AS editable
         FROM calendar_event e JOIN calendar c ON c.id = e.calendar_id
         WHERE c.role = 'source' AND e.is_own_timeblock = 0 AND (e.status IS NULL OR e.status <> 'cancelled')
           AND ((e.all_day = 0 AND e.end_at > ? AND e.start_at < ?)
             OR (e.all_day = 1 AND e.end_date > ? AND e.start_date <= ?))
         ORDER BY e.start_at`,
      )
      .all(rangeStart, rangeEnd, from, to);
    const hidden = new Set(settings.hiddenCalendars);
    const shown = (e: EventRow) => !hidden.has(e.calendar_id);
    const isBusy = (e: EventRow) =>
      derive.isBusyEvent({
        startAt: e.start_at,
        endAt: e.end_at,
        status: e.status,
        availability: e.availability,
        selfResponse: e.self_response,
        isOwnTimeblock: e.is_own_timeblock === 1,
        calendarRole: e.role,
      });
    const eventView = (e: EventRow): CalendarEventView => ({
      id: e.id,
      title: e.title,
      start: e.start_at,
      end: e.end_at,
      allDay: e.all_day === 1,
      startDate: e.start_date,
      endDate: e.end_date,
      calendarColor: e.color,
      calendarColorKey: isCalendarColorKey(e.color_key) ? e.color_key : null,
      calendarId: e.calendar_id,
      busy: isBusy(e),
      editable: e.editable === 1,
    });

    // タスク（その範囲の日付のもの。やめたものは出さない）。前日の日付のものは、0:00 をまたいで最初の列に
    // かかるブロックを描くために読む（crossTasks。D-054）
    const taskRows = db
      .query<TaskRow, [string, string]>(
        `SELECT * FROM task WHERE deleted_at IS NULL AND scheduled_date >= ? AND scheduled_date <= ?
           AND status IN ('todo', 'doing', 'done') ORDER BY lane_order`,
      )
      .all(addDays(from, -1), to);
    const fus = followUpsByTask(db);
    const titles = resolveTaskTitles(db, taskRows);
    // 頼んだ AI（D-107）
    const ais = aiByTask(
      db,
      taskRows.map((t) => t.id),
    );
    const blocks = db
      .query<
        {
          id: string;
          task_id: string | null;
          title: string | null;
          start_at: number;
          end_at: number;
        },
        [number, number]
      >(
        "SELECT id, task_id, title, start_at, end_at FROM time_block WHERE deleted_at IS NULL AND end_at > ? AND start_at < ? ORDER BY start_at",
      )
      .all(rangeStart, rangeEnd);
    const entries = db
      .query<
        {
          id: string;
          task_id: string;
          start_at: number;
          end_at: number | null;
          source: TimeEntryView["source"];
        },
        [number, number]
      >(
        "SELECT id, task_id, start_at, end_at, source FROM task_time_entry WHERE deleted_at IS NULL AND start_at < ? AND (end_at IS NULL OR end_at > ?) ORDER BY start_at",
      )
      .all(rangeEnd, rangeStart);
    // 応答区間の接続先: タスク → フォローアップ → その待ち区間のうち、応答の開始に最も近い終点のもの
    const waitEnds = new Map<string, { waitKey: string; end: number }[]>();
    for (const r of db
      .query<{ follow_up_id: string; wait_key: string; end_at: number }, []>(
        "SELECT follow_up_id, wait_key, MAX(end_at) AS end_at FROM ai_wait_segment WHERE follow_up_id IS NOT NULL GROUP BY follow_up_id, wait_key",
      )
      .all()) {
      const xs = waitEnds.get(r.follow_up_id) ?? [];
      xs.push({ waitKey: r.wait_key, end: r.end_at });
      waitEnds.set(r.follow_up_id, xs);
    }
    const entryView = (e: (typeof entries)[number]): TimeEntryView => {
      const fu = fus.get(e.task_id);
      let respondsTo: TimeEntryView["respondsTo"] = null;
      if (fu) {
        const near = (waitEnds.get(fu.followUpId) ?? []).sort(
          (a, b) => Math.abs(a.end - e.start_at) - Math.abs(b.end - e.start_at),
        )[0];
        respondsTo = { workItemId: fu.workItemId, waitKey: near?.waitKey ?? null };
      }
      return {
        id: e.id,
        taskId: e.task_id,
        start: e.start_at,
        end: e.end_at,
        source: e.source,
        respondsTo,
      };
    };

    // AI
    const wis = new Map(
      db
        .query<
          {
            id: string;
            title_user: string | null;
            title_auto: string | null;
            title_source: string | null;
            status: AiLaneItem["status"];
            status_reason: string | null;
            status_estimated: number;
            repo_root: string | null;
            scratch: number;
            branch: string | null;
            pr_ref: string | null;
            hidden_at: number | null;
            last_activity_at: number;
          },
          []
        >(
          "SELECT id, title_user, title_auto, title_source, status, status_reason, status_estimated, repo_root, scratch, branch, pr_ref, hidden_at, last_activity_at FROM work_item WHERE deleted_at IS NULL",
        )
        .all()
        .map((w) => [w.id, w]),
    );
    const sources = sourcesByWorkItem(db);
    const wiTitles = titleResolver(db);
    const expiredBy = new Map<string, number>();
    for (const r of db
      .query<{ closed_at: number }, [number, number]>(
        "SELECT closed_at FROM follow_up WHERE status = 'expired' AND deleted_at IS NULL AND closed_at >= ? AND closed_at < ?",
      )
      .all(rangeStart, Math.max(rangeEnd, now + 1))) {
      const d = toLocalDate(r.closed_at, settings.tz, settings.dayBoundary);
      expiredBy.set(d, (expiredBy.get(d) ?? 0) + 1);
    }

    const inBand = (t: TaskRow) => {
      // 帯に出ている自分の番のタスクは Unscheduled に入れない（D-025）
      const fu = fus.get(t.id);
      return fu !== undefined && (fu.status === "open" || fu.status === "snoozed");
    };
    const overlaps = (x: { start: number; end: number }, r: Interval) =>
      x.end > r.start && x.start < r.end;
    const entryEnd = (e: (typeof entries)[number]) => e.end_at ?? now;

    const days: DayColumn[] = dates.map((date) => {
      // 表示の区分は暦日、集計の区分は論理日（D-054）
      const phase = phaseOf(date, displayToday);
      const logicalPhase = phaseOf(date, today);
      const axis = { start: calStart(date), end: calStart(addDays(date, 1)) };
      const logical = { start: logStart(date), end: logStart(addDays(date, 1)) };
      // 稼働日（M3-6、D-040）: 稼働曜日（既定 月〜金）に含まれ、祝日カレンダーの終日予定の日でない
      const workday = isWorkday(date, rule);
      // 計画の目安（D-062・D-106）。稼働日でない日は無し
      const plannedHours = plannedOn(date, settings.plannedHours, settings.tz, workday);

      // 表示は時間軸（暦日）にかかるもの、集計は論理日にかかるもの
      const dayEvents = events.filter(
        (e) => e.all_day === 0 && e.end_at > axis.start && e.start_at < axis.end,
      );
      const logicalEvents = events.filter(
        (e) => e.all_day === 0 && e.end_at > logical.start && e.start_at < logical.end,
      );
      const allDay = events.filter(
        (e) => e.all_day === 1 && (e.start_date ?? "") <= date && (e.end_date ?? "") > date,
      );
      const busy = [...logicalEvents, ...allDay]
        .filter(isBusy)
        .map((e) => ({ start: e.start_at, end: e.end_at }));
      // 帯に出ている自分の番のタスクも、時間ブロックがこの列の時間軸にかかれば時間軸に描く（m2-api 19章。D-051）
      const dayTasks = taskRows.filter(
        (t) =>
          t.scheduled_date === date &&
          (!inBand(t) ||
            blocks.some(
              (b) => b.task_id === t.id && overlaps({ start: b.start_at, end: b.end_at }, axis),
            )),
      );
      const dayTaskIds = new Set(dayTasks.map((t) => t.id));
      // 前日の日付のタスクで、時間ブロック（無ければ完了の実績）がこの列の時間軸にかかるもの（0:00 をまたぐブロック）
      const prev = addDays(date, -1);
      const crossTasks = taskRows.filter((t) => {
        if (t.scheduled_date !== prev || inBand(t)) return false;
        // ブロックが複数あるタスク（前の時刻のブロックが残ったもの）もあるので、先頭ではなく、どれかが時間軸にかかるか
        const mine = blocks.filter((b) => b.task_id === t.id);
        if (mine.length > 0)
          return mine.some((b) => overlaps({ start: b.start_at, end: b.end_at }, axis));
        return (
          t.status === "done" &&
          entries.some(
            (e) => e.task_id === t.id && overlaps({ start: e.start_at, end: entryEnd(e) }, axis),
          )
        );
      });
      const crossIds = new Set(crossTasks.map((t) => t.id));
      const planned = dayTasks.filter((t) => !t.source_ref?.startsWith("follow_up:"));
      const cap = capacity({
        phase: logicalPhase,
        now,
        planned: plannedHours,
        workday,
        busy,
        estimates: planned.map((t) => t.estimate_min),
      });

      // AI の日別集計（M1 の work_item_daily と待ち区間）
      // AI の時間は終わっていないターンも数える（D-052 (4)。work_item_daily は duration_ms の和）
      const daily = [...aiTimeByWorkItem(db, date, now)]
        .map(([id, x]) => ({ work_item_id: id, turn_count: x.turns, ai_ms: x.aiMs }))
        .filter((d) => {
          const w = wis.get(d.work_item_id);
          return w && !w.hidden_at;
        });
      // 集計（論理日）の待ち区間
      const segs = segsOn(db, date);
      const idleUnion = union(
        segs.filter((s) => s.kind === "idle").map((s) => ({ start: s.start_at, end: s.end_at })),
      );
      // 表示（暦日の時間軸）のターン。長い実行も拾えるよう1日前に始まったものから読み、終わりで絞る
      // StopFailure・idle_prompt の後に活動の無い終わっていないターンは、その hook の時刻で終わったブロックにする
      const turns = withHookEnds(
        db,
        db
          .query<TurnRow, [number, number]>(
            "SELECT t.id, t.work_item_id, t.started_at, t.ended_at, t.duration_ms, t.status, t.ended_with, t.edited_files_count, t.tool_counts_json, t.input_tokens, t.output_tokens, s.tool FROM ai_turn t JOIN ai_session s ON s.id = t.session_id WHERE t.started_at >= ? AND t.started_at < ? AND s.is_noise = 0 ORDER BY t.started_at",
          )
          .all(axis.start - 86_400_000, axis.end),
      ).filter((t) => overlaps(runOf(t, now), axis));
      // 親のターンが閉じた後もサブエージェントだけが動いていた区間（親のブロックの続き）
      const subRuns = subagentRuns(
        db,
        now,
        { from: axis.start - 86_400_000, to: axis.end },
        openWaitStarts(db),
      ).filter((r) => overlaps(r, axis));
      const aiRibbon =
        phase === "past"
          ? union([
              ...turns
                .filter((t) => t.work_item_id && !wis.get(t.work_item_id)?.hidden_at)
                .map((t) => runOf(t, now)),
              ...subRuns
                .filter((r) => !wis.get(r.workItemId)?.hidden_at)
                .map((r) => ({ start: r.start, end: r.end })),
            ])
          : [];

      let aiLane: AiLaneItem[] | null = null;
      if (phase === "today" || opts.detail) {
        // 項目の AI 時間・Idle・ターン数は今の論理日の値（深夜 1:40 なら前日の論理日。D-054）。
        // デイビューの今日以外の日はその日の論理日の値
        const statsDate = phase === "today" ? today : date;
        const statsDaily =
          statsDate === date
            ? daily
            : [...aiTimeByWorkItem(db, statsDate, now)].map(([id, x]) => ({
                work_item_id: id,
                turn_count: x.turns,
                ai_ms: x.aiMs,
              }));
        const statsSegs = statsDate === date ? segs : segsOn(db, statsDate);
        const idleByWi = new Map<string, number>();
        for (const id of new Set(statsSegs.map((s) => s.work_item_id))) {
          idleByWi.set(
            id,
            len(
              union(
                statsSegs
                  .filter((s) => s.work_item_id === id && s.kind === "idle")
                  .map((s) => ({ start: s.start_at, end: s.end_at })),
              ),
            ),
          );
        }
        const statsRange = { start: logStart(statsDate), end: logStart(addDays(statsDate, 1)) };
        // 待ち線は時間軸にかかる区間（開いている待ちはクライアントが now まで描く）
        const laneSegs = db
          .query<SegRow, [number, number]>(
            "SELECT work_item_id, wait_key, follow_up_id, kind, excluded_by, end_reason, start_at, end_at, is_open FROM ai_wait_segment WHERE start_at < ? AND (end_at > ? OR is_open = 1) ORDER BY start_at",
          )
          .all(axis.end, axis.start);
        const ids = new Set<string>();
        for (const t of turns) {
          const w = t.work_item_id ? wis.get(t.work_item_id) : undefined;
          if (w && !w.hidden_at) ids.add(w.id);
        }
        // 未完了で今日へ持ち越したカード（M1 の aiDays と同じ規則）
        if (phase === "today")
          for (const w of wis.values())
            if (!w.hidden_at && w.status !== "done" && !ids.has(w.id)) ids.add(w.id);
        aiLane = [];
        for (const id of ids) {
          const w = wis.get(id);
          if (!w) continue;
          const d = statsDaily.find((x) => x.work_item_id === id);
          const myTurns = turns.filter((t) => t.work_item_id === id);
          const mine = laneSegs.filter((s) => s.work_item_id === id);
          // 開いている待ちは、その待ちの最後の区分だけが now に追従する（クライアントが描き足す）
          const lastEnd = new Map<string, number>();
          for (const s of mine)
            lastEnd.set(s.wait_key, Math.max(lastEnd.get(s.wait_key) ?? 0, s.end_at));
          const waits: WaitSegmentBrief[] = mine.map((s) => ({
            waitKey: s.wait_key,
            start: s.start_at,
            end: s.end_at,
            idle: s.kind === "idle",
            open: s.is_open === 1 && s.end_at === lastEnd.get(s.wait_key),
            tone: toneFor(db, s.follow_up_id, w.status, w.status_reason),
            followUpId: s.follow_up_id,
            ...(opts.detail
              ? { kind: s.kind, excludedBy: s.excluded_by ?? null, endReason: s.end_reason ?? null }
              : {}),
          }));
          const carriedFrom =
            myTurns.length > 0
              ? null
              : toLocalDate(w.last_activity_at, settings.tz, settings.dayBoundary);
          aiLane.push({
            id,
            // 件名の順（spec-glance §2.2）。ai-title → PR の題名 → ブランチ（問い・許可の待ちの間は PR の題名を使わない）
            title: wiTitles.display(w).title,
            titleSource: wiTitles.display(w).source,
            status: w.status,
            reason: w.status_reason,
            estimated: w.status_estimated === 1,
            sources: sources.get(id) ?? [],
            repoRoot: w.repo_root,
            scratch: w.scratch === 1,
            branch: w.branch,
            prRef: w.pr_ref,
            aiMs: d?.ai_ms ?? 0,
            youMs: youMsFor(db, id, statsRange),
            idleMs: idleByWi.get(id) ?? 0,
            turns: d?.turn_count ?? 0,
            carriedFrom: carriedFrom && carriedFrom < date ? carriedFrom : null,
            runs: [
              ...myTurns.map((t) => (opts.detail ? runDetailOf(t, now) : runOf(t, now))),
              ...subRuns
                .filter((r) => r.workItemId === id)
                .map((r) => {
                  const x = subagentRunDetail(r, myTurns.at(-1)?.tool ?? "claude_code");
                  return opts.detail
                    ? x
                    : { turnId: x.turnId, start: x.start, end: x.end, open: x.open };
                }),
            ].sort((a, b) => a.start - b.start),
            waits,
            // 上限待ち（利用枠で止まった）: レーンの札「利用上限 · 15:00 まで」
            ...(() => {
              const l = w.status_reason === "rate_limit" ? cardLimitWait(db, id, now) : null;
              return l
                ? { limit: { since: l.since, until: l.until, untilKnown: l.untilKnown } }
                : {};
            })(),
          });
        }
        const rank: Record<string, number> = {
          needs_input: 0,
          error: 1,
          running: 2,
          your_turn: 3,
          done: 4,
        };
        aiLane.sort(
          (a, b) =>
            (a.runs[0]?.start ?? a.waits[0]?.start ?? 0) -
              (b.runs[0]?.start ?? b.waits[0]?.start ?? 0) ||
            (rank[a.status] ?? 9) - (rank[b.status] ?? 9),
        );
      }

      return {
        date,
        phase,
        logicalPhase,
        axis,
        logical,
        workday,
        plannedHours,
        // 表示しないカレンダー（Issue #5）の予定は描かない。上の busy・下の集計は全部の予定で数える
        allDayEvents: allDay.filter(shown).map(eventView),
        events: dayEvents.filter(shown).map(eventView),
        tasks: dayTasks.map((t) => taskView(t, titles, fus.get(t.id), ais.get(t.id))),
        crossTasks: crossTasks.map((t) => taskView(t, titles, fus.get(t.id), ais.get(t.id))),
        // 時間軸にかかるものと、この列のタスクのもの（タスクのブロックが翌日の 0:00 以降だけでも Unscheduled にしない）
        timeBlocks: blocks
          .filter(
            (b) =>
              overlaps({ start: b.start_at, end: b.end_at }, axis) ||
              (b.task_id !== null && dayTaskIds.has(b.task_id)),
          )
          .map((b) => ({
            id: b.id,
            taskId: b.task_id,
            title: b.title,
            start: b.start_at,
            end: b.end_at,
          })),
        timeEntries: entries
          .filter(
            (e) =>
              overlaps({ start: e.start_at, end: entryEnd(e) }, axis) ||
              dayTaskIds.has(e.task_id) ||
              crossIds.has(e.task_id),
          )
          .map(entryView),
        totals: {
          ...cap,
          eventsMs: len(
            union(logicalEvents.filter(isBusy).map((e) => ({ start: e.start_at, end: e.end_at }))),
          ),
          doneCount: dayTasks.filter((t) => t.status === "done").length,
          taskCount: dayTasks.length,
          aiMs: daily.reduce((a, x) => a + x.ai_ms, 0),
          idleMs: len(idleUnion),
          expired: expiredBy.get(date) ?? 0,
        },
        aiRibbon,
        aiLane,
      };
    });

    // 「残り N 件を今日へ」（D-192）: 今日より前の列の未完了の件数。それより前の日付の残りは最初の過去の列にだけ数える
    let firstPast = true;
    for (const d of days) {
      if (d.logicalPhase !== "past") continue;
      const c = carryCounts(db, d.date);
      d.carry = { count: c.count, older: firstPast ? c.older : 0 };
      firstPast = false;
    }

    return { ...meta, days };
  })();
}

interface TurnRow {
  id: string;
  work_item_id: string | null;
  started_at: number;
  ended_at: number | null;
  duration_ms: number | null;
  status: string;
  ended_with: AiRunDetail["endedWith"];
  edited_files_count: number;
  tool_counts_json: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  tool: string;
}

/** デイビューのポップオーバー用（時刻・ツール呼び出し数・編集ファイル数・トークン。本文は持っていない） */
function runDetailOf(t: TurnRow, now: number): AiRunDetail {
  let calls = 0;
  try {
    for (const v of Object.values(JSON.parse(t.tool_counts_json ?? "{}") as Record<string, number>))
      calls += typeof v === "number" ? v : 0;
  } catch {}
  return {
    ...runOf(t, now),
    toolCalls: calls,
    editedFiles: t.edited_files_count,
    inputTokens: t.input_tokens,
    outputTokens: t.output_tokens,
    endedWith: t.ended_with,
    tool: t.tool,
  };
}

function runOf(t: TurnRow, now: number): AiRun {
  const open = t.status === "running" && t.ended_at === null;
  const end = open
    ? Math.max(now, t.started_at)
    : (t.ended_at ?? t.started_at + (t.duration_ms ?? 0));
  return { turnId: t.id, start: t.started_at, end: Math.max(end, t.started_at), open };
}

interface SegRow {
  work_item_id: string;
  wait_key: string;
  follow_up_id: string | null;
  kind: DayWaitSegment["kind"];
  excluded_by?: DayWaitSegment["excludedBy"];
  end_reason?: string | null;
  start_at: number;
  end_at: number;
  is_open: number;
}

/** その論理日の待ち区間（集計用） */
function segsOn(db: Database, date: string): SegRow[] {
  return db
    .query<SegRow, [string]>(
      "SELECT work_item_id, wait_key, follow_up_id, kind, start_at, end_at, is_open FROM ai_wait_segment WHERE local_date = ? ORDER BY start_at",
    )
    .all(date);
}

/**
 * 待ち線の色: フォローアップの種類から（approve → needs_input、resume_error → error、ほか your_turn）。
 * 上限待ち（理由 rate_limit）と、明けた後の再開（`<turn>:limit`）は琥珀（needs_input の系統。エラーの赤にしない）
 */
function toneFor(
  db: Database,
  followUpId: string | null,
  status: string,
  reason: string | null,
): WaitSegmentBrief["tone"] {
  if (followUpId) {
    const k = db
      .query<{ kind: string; artifact_ref: string }, [string]>(
        "SELECT kind, artifact_ref FROM follow_up WHERE id = ?",
      )
      .get(followUpId);
    if (k?.kind === "approve" || k?.artifact_ref.endsWith(":ask")) return "needs_input";
    if (k && derive.isLimitResume({ kind: k.kind, artifactRef: k.artifact_ref }))
      return "needs_input";
    if (k?.kind === "resume_error") return "error";
    if (k) return "your_turn";
  }
  if (reason === "rate_limit") return "needs_input";
  return status === "needs_input" ? "needs_input" : status === "error" ? "error" : "your_turn";
}

/** AI 項目の「自分」: その AI 項目のフォローアップのタスクの実績（その日の分） */
function youMsFor(db: Database, workItemId: string, axis: Interval): number {
  const rows = db
    .query<{ start_at: number; end_at: number | null }, [string]>(
      `SELECT e.start_at, e.end_at FROM task_time_entry e JOIN follow_up f ON f.task_id = e.task_id
       WHERE f.work_item_id = ? AND e.deleted_at IS NULL`,
    )
    .all(workItemId);
  return len(
    union(
      rows
        .map((r) => ({
          start: Math.max(r.start_at, axis.start),
          end: Math.min(r.end_at ?? r.start_at, axis.end),
        }))
        .filter((x) => x.end > x.start),
    ),
  );
}
