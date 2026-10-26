/**
 * 日報の事実を集める（M4-3。phase0-plan 4.6）。1つの読み取りトランザクションで DailyReport を組み立てる。
 * 文言は持たない（core/report/daily.ts が言語ごとに Markdown にする）。
 *
 * - AI 時間・Idle（和集合）・Expired・リポジトリ別の放置は M1 の aiDays と同じ値
 * - 会議は論理日の中の busy な時刻付き予定の和集合（m2-api.md 2.4 の meetingsMs。D-105 で勤務時間で切るのをやめた）。
 *   カレンダー未接続なら 0
 * - 自分の時間はタスクの実績の和集合。実績の無い完了タスクは時間ブロックを実績とみなす
 * - 持ち越しは、その日から実際に移したタスク（「残り N 件を今日へ」。D-192）。呼び出し側が id と移した日を渡す
 */

import type { Database } from "bun:sqlite";
import { addDays, dayStartMs, derive, repoName, type TurnlaneSettings } from "@turnlane/core";
import type {
  DailyReport,
  Interval,
  ReportAiLine,
  ReportCarryLine,
  ReportDidLine,
  TitleSpec,
  WorkItemStatus,
} from "@turnlane/core/api";
import { withHookEnds } from "../derive/hook-end.ts";
import { storedSubject } from "../derive/stored-subject.ts";
import { subagentRuns } from "../derive/subagents.ts";
import { aiDays, openWaitStarts, storedWaitOf } from "../derive/views.ts";
import { resolveTaskTitles, type TaskRow } from "./common.ts";

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
const clip = (x: Interval, w: Interval): Interval => ({
  start: Math.max(x.start, w.start),
  end: Math.min(x.end, w.end),
});

/** 同時に動いていた最大数（区間の掃引） */
export function maxOverlap(xs: Interval[]): number {
  const ev: [number, number][] = [];
  for (const x of xs) {
    if (x.end <= x.start) continue;
    ev.push([x.start, 1], [x.end, -1]);
  }
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0;
  let max = 0;
  for (const [, d] of ev) {
    cur += d;
    max = Math.max(max, cur);
  }
  return max;
}

/** id の順にタスクを引く（後で消したタスクも、持ち越した事実として出す） */
function tasksByIds(db: Database, ids: readonly string[]): TaskRow[] {
  const q = db.query<TaskRow, [string]>("SELECT * FROM task WHERE id = ?");
  return ids.flatMap((id) => {
    const row = q.get(id);
    return row ? [row] : [];
  });
}

export function buildDailyReport(
  db: Database,
  settings: TurnlaneSettings,
  now: number,
  date: string,
  opts: {
    /** その日から実際に移したタスク（id と移した日。並びは移した順）。省略時は無し */
    carried?: readonly { taskId: string; to: string }[];
  } = {},
): DailyReport {
  return db.transaction(() => {
    const axis: Interval = {
      start: dayStartMs(date, settings.tz, settings.dayBoundary),
      end: dayStartMs(addDays(date, 1), settings.tz, settings.dayBoundary),
    };
    const day = aiDays(db, settings, now, date, 1).days[0];
    const wh = axis;

    // 会議（論理日の中の busy な時刻付き予定）
    let meetingsMs = 0;
    {
      const events = db
        .query<
          {
            start_at: number;
            end_at: number;
            status: "confirmed" | "tentative" | "cancelled" | null;
            availability: "busy" | "free" | "tentative" | "unavailable" | null;
            self_response: "accepted" | "declined" | "tentative" | "pending" | "unknown" | null;
            is_own_timeblock: number;
            role: "source" | "writeback" | "ignored";
          },
          [number, number]
        >(
          `SELECT e.start_at, e.end_at, e.status, e.availability, e.self_response, e.is_own_timeblock, c.role
           FROM calendar_event e JOIN calendar c ON c.id = e.calendar_id
           WHERE e.all_day = 0 AND e.end_at > ? AND e.start_at < ?`,
        )
        .all(wh.start, wh.end);
      meetingsMs = len(
        union(
          events
            .filter((e) =>
              derive.isBusyEvent({
                startAt: e.start_at,
                endAt: e.end_at,
                status: e.status,
                availability: e.availability,
                selfResponse: e.self_response,
                isOwnTimeblock: e.is_own_timeblock === 1,
                calendarRole: e.role,
              }),
            )
            .map((e) => clip({ start: e.start_at, end: e.end_at }, wh)),
        ),
      );
    }

    // AI の実行数と最大並列（その日のターン。ノイズのセッションと非表示のカードを除く）
    // 終わっていないターンは実行中なら now、待ち中なら待ちの始まりまで（D-052 (4)。AI の時間と同じ区間）
    const turnRows = db
      .query<
        {
          id: string;
          work_item_id: string;
          started_at: number;
          ended_at: number | null;
          duration_ms: number | null;
          status: string;
          last_activity_at: number;
          wi_status: string;
        },
        [string]
      >(
        `SELECT t.id, t.work_item_id, t.started_at, t.ended_at, t.duration_ms, t.status, s.last_activity_at, w.status AS wi_status
         FROM ai_turn t JOIN ai_session s ON s.id = t.session_id JOIN work_item w ON w.id = t.work_item_id
         WHERE t.local_date = ? AND s.is_noise = 0 AND w.hidden_at IS NULL AND w.deleted_at IS NULL`,
      )
      .all(date);
    // StopFailure・idle_prompt の後に活動の無い終わっていないターンは、その hook の時刻で終わったものとして数える
    const turns = withHookEnds(db, turnRows);
    const waits = openWaitStarts(db);
    const runs = turns.map((t) => {
      const [start, end] = derive.turnAiInterval(
        {
          startedAt: t.started_at,
          endedAt: t.ended_at,
          durationMs: t.duration_ms,
          status: t.status,
          sessionLastActivityAt: t.last_activity_at,
        },
        { status: t.wi_status, openWaitStart: waits.get(t.work_item_id) ?? null, now },
      );
      return { start, end };
    });
    // 最大並列には、親のターンが閉じた後もサブエージェントだけが動いていた区間を親の続きとして入れる（実行数には数えない）
    const cards = new Set(turns.map((t) => t.work_item_id));
    const subRuns =
      turns.length > 0
        ? subagentRuns(
            db,
            now,
            { from: Math.min(...turns.map((t) => t.started_at)), to: now + 1 },
            waits,
          ).filter((r) => r.localDate === date && cards.has(r.workItemId))
        : [];

    // What I did（その日に完了したタスク）
    const doneRows = db
      .query<TaskRow, [number, number]>(
        `SELECT * FROM task WHERE deleted_at IS NULL AND status = 'done'
           AND completed_at >= ? AND completed_at < ? ORDER BY completed_at`,
      )
      .all(axis.start, axis.end);
    const carryRefs = opts.carried ?? [];
    const carryRows = tasksByIds(
      db,
      carryRefs.map((c) => c.taskId),
    );
    const titles = resolveTaskTitles(db, [...doneRows, ...carryRows]);
    const entries = db
      .query<{ task_id: string; start_at: number; end_at: number | null }, [number, number]>(
        "SELECT task_id, start_at, end_at FROM task_time_entry WHERE deleted_at IS NULL AND start_at < ? AND (end_at IS NULL OR end_at > ?)",
      )
      .all(axis.end, axis.start)
      .map((e) => ({
        taskId: e.task_id,
        ...clip({ start: e.start_at, end: e.end_at ?? now }, axis),
      }))
      .filter((e) => e.end > e.start);
    const blocks = db
      .query<{ task_id: string; start_at: number; end_at: number }, [number, number]>(
        "SELECT task_id, start_at, end_at FROM time_block WHERE deleted_at IS NULL AND task_id IS NOT NULL AND end_at > ? AND start_at < ?",
      )
      .all(axis.start, axis.end)
      .map((b) => ({ taskId: b.task_id, ...clip({ start: b.start_at, end: b.end_at }, axis) }));
    const fromAi = new Map(
      db
        .query<{ task_id: string; title: string | null; branch: string | null }, []>(
          `SELECT f.task_id, COALESCE(w.title_user, w.title_auto) AS title, w.branch
           FROM follow_up f JOIN work_item w ON w.id = f.work_item_id WHERE f.task_id IS NOT NULL`,
        )
        .all()
        .map((r) => [r.task_id, r.title ?? r.branch]),
    );
    const youIntervals: Interval[] = entries.map(({ start, end }) => ({ start, end }));
    const did: ReportDidLine[] = doneRows.map((t) => {
      let mine = entries.filter((e) => e.taskId === t.id);
      if (mine.length === 0) {
        mine = blocks.filter((b) => b.taskId === t.id);
        youIntervals.push(...mine.map(({ start, end }) => ({ start, end })));
      }
      const ms = mine.length > 0 ? len(union(mine)) : null;
      return {
        taskId: t.id,
        title: titles.get(t.id) ?? { t: "text", text: t.title },
        ms,
        fromAi: fromAi.has(t.id) ? (fromAi.get(t.id) ?? null) : null,
      };
    });

    // What the AI did（その日に動いた AI 項目）
    const prs = new Map<string, { pr: number; state: string }>();
    for (const a of db
      .query<{ work_item_id: string; ref: string; state: string }, []>(
        "SELECT work_item_id, ref, state FROM ai_artifact WHERE kind = 'pr' AND work_item_id IS NOT NULL ORDER BY first_seen_at",
      )
      .all()) {
      const n = Number(a.ref.slice(a.ref.lastIndexOf("#") + 1));
      if (Number.isFinite(n)) prs.set(a.work_item_id, { pr: n, state: a.state });
    }
    // 自分の番に出ている項目（open / snoozed のフォローアップがある。自分の番の画面と同じ判定。D-214 (3)）
    const turnOpen = new Set(
      db
        .query<{ id: string }, []>(
          `SELECT DISTINCT work_item_id AS id FROM follow_up
           WHERE deleted_at IS NULL AND status IN ('open', 'snoozed')
             AND kind IN ('approve', 'reply', 'review_pr', 'merge_pr', 'resume_error', 'check_changes')`,
        )
        .all()
        .map((r) => r.id),
    );
    const turnOf = (x: { id: string; status: string; reason: string | null }) =>
      x.status !== "your_turn"
        ? undefined
        : turnOpen.has(x.id)
          ? ("open" as const)
          : x.reason === "question" || x.reason === "hook:stop"
            ? ("grace" as const)
            : ("none" as const);
    // 保存した中身（ADR 0018・D-218）: その日の最初の自分の指示と、今止まっている待ちの中身。設定がオンのときだけ
    // 空同然の指示は飛ばす（stored-subject.ts）
    const askedOf = (id: string): string | null =>
      settings.storeDetail ? storedSubject(db, id, date, { dayOnly: true }) : null;
    const stoppedOf = (id: string) => {
      if (!settings.storeDetail) return null;
      const f = db
        .query<{ id: string }, [string]>(
          `SELECT id FROM follow_up WHERE work_item_id = ? AND deleted_at IS NULL AND status IN ('open', 'snoozed')
             AND kind IN ('approve', 'reply', 'resume_error') ORDER BY trigger_at DESC LIMIT 1`,
        )
        .get(id);
      return f ? storedWaitOf(db, f.id) : null;
    };
    const aiDid: ReportAiLine[] = (day?.items ?? [])
      .filter((x) => x.turns > 0 || x.aiMs > 0)
      .sort((a, b) => b.aiMs - a.aiMs)
      .map((x) => {
        const status = x.status as WorkItemStatus;
        const pr = prs.get(x.id);
        const turn = turnOf(x);
        const asked = askedOf(x.id);
        const stopped = stoppedOf(x.id);
        return {
          workItemId: x.id,
          repo: repoName(x.repoRoot),
          ...(x.scratch ? { scratch: true } : {}),
          title: x.title,
          branch: x.branch,
          status,
          ...(turn ? { turn } : {}),
          ...(asked ? { asked } : {}),
          ...(stopped ? { stopped } : {}),
          result: pr
            ? {
                kind: "pr" as const,
                pr: pr.pr,
                state: pr.state as "open" | "draft" | "merged" | "closed" | "unknown",
              }
            : {
                kind: "status" as const,
                status,
                // 利用枠の上限待ち（完了とは書かない）
                ...(status === "done" && x.reason === "rate_limit" ? { limit: true as const } : {}),
                // 質問で止まっているか、許可待ちか（D-052 (3)）
                ...(status === "needs_input"
                  ? {
                      waitingFor:
                        x.reason === "ask_user_question"
                          ? ("answer" as const)
                          : ("approval" as const),
                    }
                  : {}),
              },
          aiMs: x.aiMs,
          carried: status === "needs_input" || status === "running" || status === "error",
        };
      });

    // 期限切れになった項目の名前（S3）
    const expiredRows = db
      .query<
        {
          task_id: string | null;
          title: string | null;
          title_key: string | null;
          title_params: string | null;
        },
        [number, number]
      >(
        `SELECT f.task_id, t.title, t.title_key, t.title_params FROM follow_up f LEFT JOIN task t ON t.id = f.task_id
         WHERE f.deleted_at IS NULL AND f.status = 'expired' AND f.closed_at >= ? AND f.closed_at < ?
         ORDER BY f.closed_at`,
      )
      .all(axis.start, axis.end);
    const expTitles = resolveTaskTitles(
      db,
      expiredRows
        .filter((r) => r.task_id !== null)
        .map((r) => ({
          id: r.task_id as string,
          title: r.title ?? "",
          title_key: r.title_key,
          title_params: r.title_params,
        })),
    );
    const expiredItems: TitleSpec[] = expiredRows.map(
      (r) =>
        (r.task_id ? expTitles.get(r.task_id) : undefined) ?? { t: "text", text: r.title ?? "" },
    );

    const carried: ReportCarryLine[] = carryRefs.flatMap((c) => {
      const t = carryRows.find((r) => r.id === c.taskId);
      if (!t) return [];
      return [{ taskId: t.id, title: titles.get(t.id) ?? { t: "text", text: t.title }, to: c.to }];
    });

    const note =
      db
        .query<{ memo_md: string | null }, [string]>(
          "SELECT memo_md FROM daily_note WHERE date = ? AND deleted_at IS NULL",
        )
        .get(date)?.memo_md ?? null;

    return {
      date,
      youMs: len(union(youIntervals)),
      meetingsMs,
      aiMs: day?.aiMs ?? 0,
      runs: runs.length,
      maxParallel: maxOverlap([...runs, ...subRuns]),
      idleMs: day?.idleMs ?? 0,
      expired: day?.expired ?? 0,
      idleByRepo: (day?.idleByRepo ?? []).map((x) => ({
        repo: repoName(x.repoRoot),
        ...(x.scratch ? { scratch: true } : {}),
        ms: x.ms,
      })),
      expiredItems,
      did,
      aiDid,
      carried,
      note,
    };
  })();
}
