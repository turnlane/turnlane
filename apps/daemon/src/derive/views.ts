/**
 * 読み取り用の集計（GET /api/work-items、/api/work-items/:id、/api/queue）。turnlane ai / turnlane queue が使う。
 * 本文は持っていないので、タイトル・状態・時刻・件数だけを返す。
 */

import type { Database } from "bun:sqlite";
import { asksBack } from "@turnlane/collectors";
import {
  addDays,
  dayStartMs,
  derive,
  plannedOn,
  report,
  type TurnlaneSettings,
  toLocalDate,
} from "@turnlane/core";
import type {
  AiRunDetail,
  ClosedKind,
  ClosedVia,
  QueueItem,
  QueueResponse,
  StoredWait,
  WaitSegmentDetail,
  WorkItemDetail,
} from "@turnlane/core/api";
import { errorKindOf, permissionKindOf, reviewDecisionOf } from "@turnlane/core/api";
import { readMeta, resolveTaskTitles, sourcesByWorkItem } from "../planner/common.ts";
import { presenceIn } from "../presence/service.ts";
import { hookEndsOf, withHookEnds } from "./hook-end.ts";
import { type CardLimitWait, cardLimitWait } from "./limit.ts";
import { cleanSubject } from "./stored-subject.ts";
import { subagentRuns } from "./subagents.ts";
import { type ResolvedTitle, titleResolver } from "./subject.ts";

export interface AiItem {
  id: string;
  title: string | null;
  titleSource: string | null;
  status: string;
  reason: string | null;
  estimated: boolean;
  tools: string[];
  repoRoot: string | null;
  /** 壁打ち（D-135） */
  scratch: boolean;
  branch: string | null;
  prRef: string | null;
  aiMs: number;
  turns: number;
  idleMs: number;
  /** 未完了で、元の日付から今日へ持ち越したカード */
  carriedFrom: string | null;
}

export interface AiDay {
  date: string;
  aiMs: number;
  idleMs: number;
  expired: number;
  idleByRepo: { repoRoot: string | null; scratch?: boolean; ms: number }[];
  items: AiItem[];
}

export interface AiDaysView {
  today: string;
  days: AiDay[];
}

interface WiRow {
  id: string;
  title_auto: string | null;
  title_user: string | null;
  title_source: string | null;
  status: string;
  status_reason: string | null;
  status_estimated: number;
  tools_json: string;
  repo_root: string | null;
  scratch: number;
  branch: string | null;
  pr_ref: string | null;
  hidden_at: number | null;
  first_activity_at: number;
  last_activity_at: number;
}

/**
 * リポジトリ別の放置の集計キー（D-135）: 壁打ちは git 管理外（null）と分けて数える。キーは repo_root か、壁打ちの印
 * （パスにならない文字列）
 */
const SCRATCH_KEY = "\u0000scratch";
export function idleRepoKey(repoRoot: string | null, scratch: boolean): string | null {
  return scratch && repoRoot === null ? SCRATCH_KEY : repoRoot;
}
export function idleRepoOf(key: string | null): { repoRoot: string | null; scratch?: boolean } {
  return key === SCRATCH_KEY ? { repoRoot: null, scratch: true } : { repoRoot: key };
}

function item(w: WiRow, shown: ResolvedTitle, extra: Partial<AiItem>): AiItem {
  let tools: string[] = [];
  try {
    tools = JSON.parse(w.tools_json) as string[];
  } catch {}
  return {
    id: w.id,
    // 件名の順（spec-glance §2.2。subject.ts）
    title: shown.title,
    titleSource: shown.source,
    status: w.status,
    reason: w.status_reason,
    estimated: w.status_estimated === 1,
    tools,
    repoRoot: w.repo_root,
    scratch: w.scratch === 1,
    branch: w.branch,
    prRef: w.pr_ref,
    aiMs: 0,
    turns: 0,
    idleMs: 0,
    carriedFrom: null,
    ...extra,
  };
}

/** 論理日の [始まり, 終わり) */
export function logicalDay(date: string, settings: TurnlaneSettings) {
  return {
    start: dayStartMs(date, settings.tz, settings.dayBoundary),
    end: dayStartMs(addDays(date, 1), settings.tz, settings.dayBoundary),
  };
}

/** 在席の区間（和集合済み・開始順）。from より後に終わるもの。T（presence.tail_min）は今の設定で足す（D-139） */
export function presenceFrom(
  db: Database,
  settings: Pick<TurnlaneSettings, "presenceTailMs">,
  from: number,
): [number, number][] {
  return presenceIn(db, from, Number.POSITIVE_INFINITY, settings.presenceTailMs);
}

/**
 * at に在席していたか。最後の区間が今に続いている（最後のサンプルから間がない）なら、その終わりより後も在席とみなす
 * （区間の終わりはサンプルの時刻までなので、今の数十秒を不在にしない）
 */
export function presentAt(presence: readonly [number, number][], at: number, now: number): boolean {
  if (presence.some(([s, e]) => at >= s && at < e)) return true;
  const last = presence.at(-1);
  return last !== undefined && at >= last[1] && now - last[1] < derive.PRESENCE_MAX_GAP_MS;
}

/** [from, to) の本人の操作（AI への人間入力・user_op・手動のタスク完了。D-076・D-079）の時刻 */
export function workOpsIn(db: Database, from: number, to: number): number[] {
  const turns = db
    .query<{ at: number }, [number, number]>(
      "SELECT started_at AS at FROM ai_turn WHERE initiator IN ('human', 'queued') AND started_at >= ? AND started_at < ?",
    )
    .all(from, to);
  const ops = db
    .query<{ at: number }, [number, number]>(
      "SELECT at FROM usage_event WHERE kind = 'user_op' AND at >= ? AND at < ?",
    )
    .all(from, to);
  const done = db
    .query<{ at: number }, [number, number]>(
      "SELECT completed_at AS at FROM task WHERE completed_at >= ? AND completed_at < ? AND auto_completed = 0 AND deleted_at IS NULL",
    )
    .all(from, to);
  return [...turns, ...ops, ...done].map((r) => r.at);
}

/**
 * 実際に作業した直近の論理日（D-076）: before より前で、本人の操作（AI への人間入力・user_op・手動のタスク完了）が
 * あった最後の論理日。無ければ null
 */
export function lastWorkedDate(
  db: Database,
  settings: TurnlaneSettings,
  before: string,
): string | null {
  const t = dayStartMs(before, settings.tz, settings.dayBoundary);
  const max = (sql: string) => db.query<{ at: number | null }, [number]>(sql).get(t)?.at ?? null;
  const ats = [
    max(
      "SELECT MAX(started_at) AS at FROM ai_turn WHERE initiator IN ('human', 'queued') AND started_at < ?",
    ),
    max("SELECT MAX(at) AS at FROM usage_event WHERE kind = 'user_op' AND at < ?"),
    max(
      "SELECT MAX(completed_at) AS at FROM task WHERE completed_at < ? AND auto_completed = 0 AND deleted_at IS NULL",
    ),
  ].filter((x): x is number => x !== null);
  return ats.length > 0 ? toLocalDate(Math.max(...ats), settings.tz, settings.dayBoundary) : null;
}

/**
 * その日（ターンの local_date）のカード別の AI 時間とターン数（D-052 (4)）。work_item_daily は duration_ms の和なので
 * 終わっていないターンが 0 になる。終わっていないターンは core の turnAiMs で数える
 */
export function aiTimeByWorkItem(
  db: Database,
  date: string,
  now: number,
): Map<string, { aiMs: number; turns: number }> {
  const raw = db
    .query<
      {
        id: string;
        work_item_id: string;
        started_at: number;
        ended_at: number | null;
        duration_ms: number | null;
        status: string;
        last_activity_at: number | null;
        wi_status: string;
      },
      [string]
    >(
      `SELECT t.id, t.work_item_id, t.started_at, t.ended_at, t.duration_ms, t.status, s.last_activity_at, w.status AS wi_status
       FROM ai_turn t JOIN work_item w ON w.id = t.work_item_id LEFT JOIN ai_session s ON s.id = t.session_id
       WHERE t.local_date = ? AND t.work_item_id IS NOT NULL`,
    )
    .all(date);
  // StopFailure・idle_prompt の後に活動の無い終わっていないターンは、その hook の時刻で終わったものとして数える
  const rows = withHookEnds(db, raw);
  const waits = openWaitStarts(db);
  const out = new Map<string, { aiMs: number; turns: number }>();
  for (const r of rows) {
    const ms = derive.turnAiMs(
      {
        startedAt: r.started_at,
        endedAt: r.ended_at,
        durationMs: r.duration_ms,
        status: r.status,
        sessionLastActivityAt: r.last_activity_at,
      },
      { status: r.wi_status, openWaitStart: waits.get(r.work_item_id) ?? null, now },
    );
    const x = out.get(r.work_item_id) ?? { aiMs: 0, turns: 0 };
    x.aiMs += ms;
    x.turns += 1;
    out.set(r.work_item_id, x);
  }
  // 親のターンが閉じた後もサブエージェントだけが動いていた時間（親のターンの区間を除く。ターン数には数えない）
  if (rows.length > 0) {
    const from = Math.min(...rows.map((r) => r.started_at));
    for (const r of subagentRuns(db, now, { from, to: now + 1 }, waits)) {
      const x = out.get(r.workItemId);
      if (!x || r.localDate !== date) continue;
      x.aiMs += r.end - r.start;
    }
  }
  return out;
}

/** カード → 開いている待ちの始まり（同じ待ちの最初の区分の start_at。複数あれば新しいもの） */
export function openWaitStarts(db: Database): Map<string, number> {
  const rows = db
    .query<{ work_item_id: string; start_at: number }, []>(
      `SELECT work_item_id, MIN(start_at) AS start_at FROM ai_wait_segment
       WHERE wait_key IN (SELECT wait_key FROM ai_wait_segment WHERE is_open = 1)
       GROUP BY work_item_id, wait_key`,
    )
    .all();
  const out = new Map<string, number>();
  for (const r of rows) out.set(r.work_item_id, Math.max(out.get(r.work_item_id) ?? 0, r.start_at));
  return out;
}

/**
 * 計画の目安の開始（D-064・D-106。設定 `work_hours.planned`）。スヌーズの「明日朝」・`m` 明日に使う。
 * 呼び出し側が稼働日を選んで渡す前提なので、稼働日かどうかは見ない
 */
export function plannedStart(date: string, settings: TurnlaneSettings): number {
  const p = plannedOn(date, settings.plannedHours, settings.tz, true);
  if (!p) throw new Error("unreachable: plannedOn(workday=true) returned null");
  return p.start;
}

/** from から days 日分（新しい日付を先に） */
export function aiDays(
  db: Database,
  settings: TurnlaneSettings,
  now: number,
  from: string,
  days: number,
): AiDaysView {
  const today = toLocalDate(now, settings.tz, settings.dayBoundary);
  const dates = Array.from({ length: days }, (_, i) => addDays(from, i)).reverse();
  const wis = new Map(
    db
      .query<WiRow, []>("SELECT * FROM work_item WHERE deleted_at IS NULL")
      .all()
      .map((w) => [w.id, w]),
  );
  const shown = titleResolver(db);
  const out: AiDay[] = [];
  for (const date of dates) {
    const daily = [...aiTimeByWorkItem(db, date, now)].map(([id, x]) => ({
      work_item_id: id,
      turn_count: x.turns,
      ai_ms: x.aiMs,
    }));
    // 放置は和集合で数える（日別・repo 別・カード別。D-045 (2)）
    const segs = db
      .query<
        {
          work_item_id: string;
          repo_root: string | null;
          scratch: number | null;
          start_at: number;
          end_at: number;
        },
        [string]
      >(
        "SELECT s.work_item_id, w.repo_root, w.scratch, s.start_at, s.end_at FROM ai_wait_segment s LEFT JOIN work_item w ON w.id = s.work_item_id WHERE s.local_date = ? AND s.kind = 'idle'",
      )
      .all(date);
    const agg = derive
      .aggregateDays(
        segs.map((r) => ({
          localDate: date,
          kind: "idle" as const,
          excludedBy: null,
          start: r.start_at,
          end: r.end_at,
          workItemId: r.work_item_id,
          repoRoot: idleRepoKey(r.repo_root, r.scratch === 1),
        })),
        [],
        settings,
      )
      .get(date);
    const idle = agg?.idleByWorkItem ?? new Map<string, number>();
    const items: AiItem[] = [];
    for (const d of daily) {
      const w = wis.get(d.work_item_id);
      if (!w || w.hidden_at) continue;
      items.push(
        item(w, shown.display(w), {
          aiMs: d.ai_ms,
          turns: d.turn_count,
          idleMs: idle.get(w.id) ?? 0,
        }),
      );
    }
    if (date === today) {
      // 未完了のカードは今日へ持ち越す（ai-session-ingestion 4.6）
      for (const w of wis.values()) {
        if (w.hidden_at || w.status === "done" || items.some((x) => x.id === w.id)) continue;
        items.push(
          item(w, shown.display(w), {
            idleMs: idle.get(w.id) ?? 0,
            carriedFrom: toLocalDate(w.last_activity_at, settings.tz, settings.dayBoundary),
          }),
        );
      }
    }
    const rank: Record<string, number> = {
      needs_input: 0,
      error: 1,
      running: 2,
      your_turn: 3,
      done: 4,
    };
    items.sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9) || b.aiMs - a.aiMs);
    const expired =
      db
        .query<{ n: number }, [number, number]>(
          "SELECT count(*) AS n FROM follow_up WHERE status = 'expired' AND closed_at >= ? AND closed_at < ?",
        )
        .get(
          dayStartMs(date, settings.tz, settings.dayBoundary),
          dayStartMs(addDays(date, 1), settings.tz, settings.dayBoundary),
        )?.n ?? 0;
    out.push({
      date,
      aiMs: items.reduce((s, x) => s + x.aiMs, 0),
      idleMs: agg?.idleMs ?? 0,
      expired,
      idleByRepo: [...(agg?.idleByRepo ?? [])]
        .filter(([, ms]) => ms > 0)
        .map(([key, ms]) => ({ ...idleRepoOf(key), ms }))
        .sort((a, b) => b.ms - a.ms),
      items,
    });
  }
  return { today, days: out };
}

export type { QueueItem } from "@turnlane/core/api";

/** YOUR TURN に出すタスクの種類（D-045 (1)・D-048 (4)） */
const SHOWN = ["reply", "review_pr", "approve", "resume_error"];

/**
 * 要対応キュー（ux-mvp 4.6、m2-api.md 2.4）: YOUR TURN のタスク（reply / review_pr / approve / resume_error。
 * open / snoozed）が1件以上あるカードだけ（D-048 (4)）。needs_input → error → your_turn、同じ状態の中では待ちの長い順。
 * needs_input は runner が必ずタスクを作る（D-049 (1)）。スヌーズ中のタスクしか無いカードも返す（帯・件数・通知は明けるまで隠し、自分の番の画面は「後で」の節に出す）
 */
export function queue(db: Database, settings: TurnlaneSettings, now: number): QueueItem[] {
  const fus = db
    .query<
      {
        id: string;
        work_item_id: string;
        kind: string;
        status: "open" | "snoozed";
        trigger_at: number;
        snooze_until: number | null;
        engaged_at: number | null;
        task_id: string | null;
        task_title: string | null;
        task_date: string | null;
        title_key: string | null;
        title_params: string | null;
        artifact_ref: string;
        scheduled_json: string | null;
        trigger_turn_id: string | null;
        returned_at: number | null;
      },
      []
    >(
      `SELECT f.id, f.work_item_id, f.kind, f.status, f.trigger_at, f.snooze_until, f.engaged_at, f.task_id, f.artifact_ref,
              f.trigger_turn_id, f.returned_at,
              t.title AS task_title, t.scheduled_date AS task_date, t.title_key, t.title_params,
              (SELECT json_group_array(json_array(b.created_at, b.start_at)) FROM time_block b
                WHERE f.task_id IS NOT NULL AND b.task_id = f.task_id AND b.deleted_at IS NULL) AS scheduled_json
       FROM follow_up f LEFT JOIN task t ON t.id = f.task_id
       WHERE f.deleted_at IS NULL AND f.status IN ('open', 'snoozed')
         AND f.kind IN (${SHOWN.map((k) => `'${k}'`).join(",")})
       ORDER BY f.trigger_at`,
    )
    .all();
  if (fus.length === 0) return [];
  const titles = resolveTaskTitles(
    db,
    fus
      .filter((f) => f.task_id !== null)
      .map((f) => ({
        id: f.task_id as string,
        title: f.task_title ?? "",
        title_key: f.title_key,
        title_params: f.title_params,
      })),
  );
  const open = new Map(
    db
      .query<{ work_item_id: string; start: number }, []>(
        "SELECT work_item_id, MIN(start_at) AS start FROM ai_wait_segment WHERE is_open = 1 GROUP BY work_item_id",
      )
      .all()
      .map((r) => [r.work_item_id, r.start]),
  );
  const all = new Map(
    db
      .query<WiRow & { status_changed_at: number }, []>(
        "SELECT * FROM work_item WHERE deleted_at IS NULL",
      )
      .all()
      .map((w) => [w.id, w]),
  );
  const firstWait = Math.min(...fus.map((f) => f.trigger_at), ...open.values());
  const presence = presenceFrom(db, settings, firstWait - 1);
  const rank: Record<string, number> = { needs_input: 0, error: 1, your_turn: 2 };
  const itemBase = queueItemBase(db, presence, now);
  const out: QueueItem[] = [];
  for (const id of new Set(fus.map((f) => f.work_item_id))) {
    const w = all.get(id);
    if (!w || w.hidden_at) continue;
    const mine = fus.filter((f) => f.work_item_id === id);
    const waitingSince =
      open.get(w.id) ?? Math.min(...mine.map((f) => f.trigger_at), w.status_changed_at);
    out.push({
      ...itemBase(w, waitingSince),
      followUps: mine.map((f) => ({
        id: f.id,
        kind: f.kind as QueueItem["followUps"][number]["kind"],
        ...(askedBackPending(db, f)
          ? { status: "asked_back" as const }
          : scheduledStatus(f.status, f.scheduled_json, now)),
        ...(f.kind === "reply" && f.artifact_ref.endsWith(derive.ASK_REF_SUFFIX)
          ? { ask: true }
          : {}),
        ...(derive.isLimitResume({ kind: f.kind, artifactRef: f.artifact_ref })
          ? { limit: true }
          : {}),
        title: (f.task_id ? titles.get(f.task_id) : undefined) ?? {
          t: "text",
          text: f.task_title ?? "",
        },
        triggerAt: f.trigger_at,
        snoozeUntil: f.snooze_until,
        engagedAt: f.engaged_at,
        // 返答と再開は72時間で期限切れ（D-020・D-045）。上限待ちが明けた後の再開（「再開できる」）は期限なし
        expiresAt: derive.isLimitResume({ kind: f.kind, artifactRef: f.artifact_ref })
          ? null
          : f.kind === "reply" || f.kind === "resume_error"
            ? f.trigger_at + settings.replyExpireMs
            : null,
        taskId: f.task_id,
        taskDate: f.task_date,
        task:
          f.task_title !== null
            ? { title: f.task_title, titleKey: f.title_key, titleParams: f.title_params }
            : null,
      })),
    });
  }
  // needs_input → error → your_turn。カードの状態がそれ以外（running など）でもタスクがあれば your_turn の扱い
  const r = (s: string) => rank[s] ?? 2;
  return out.sort((a, b) => r(a.status) - r(b.status) || a.waitingSince - b.waitingSince);
}

/**
 * 問い返し中（Issue #3。ADR 0020）: 返答タスクの問いに利用者が問いで返し、AI がそれに答えている間は status を asked_back に
 * する（DB は open のまま、読み取りの時刻で決める）。帯・件数・通知・後でには出さない。手で戻した行は対象外
 */
export function askedBackPending(
  db: Database,
  f: {
    kind: string;
    artifact_ref: string;
    trigger_turn_id: string | null;
    returned_at: number | null;
  },
): boolean {
  if (f.kind !== "reply" || f.returned_at !== null || !f.trigger_turn_id) return false;
  if (f.artifact_ref.endsWith(derive.ASK_REF_SUFFIX)) return false;
  return askedBackOfTurn(db, f.trigger_turn_id) === "pending";
}

/** 問いを出したターンの後の人の入力から、問い返しの段階（core の askedBackOf） */
export function askedBackOfTurn(db: Database, triggerTurnId: string): derive.AskedBack | null {
  const rows = db
    .query<
      {
        id: string;
        status: string;
        ended_at: number | null;
        ended_with: string | null;
        closing_question: number;
        text: string | null;
      },
      [string]
    >(
      `SELECT t.id, t.status, t.ended_at, t.ended_with, t.closing_question, i.text
       FROM ai_turn tr JOIN ai_turn t ON t.session_id = tr.session_id AND t.started_at > tr.started_at
       LEFT JOIN ai_instruction i ON i.turn_id = t.id
       WHERE tr.id = ? AND t.initiator IN ('human', 'queued') ORDER BY t.started_at`,
    )
    .all(triggerTurnId);
  // Stop の hook などで終わったとみなせるターン（記録に終わりが無い）は、返答なしで終わったものとして戻す
  const ends = hookEndsOf(db, rows);
  return derive.askedBackOf(
    rows.map((r) => ({
      status: (ends.has(r.id) ? "completed" : r.status) as derive.TurnFact["status"],
      endedWith: r.ended_with as derive.TurnFact["endedWith"],
      closingQuestion: r.closing_question === 1,
      ...(r.text !== null ? { instructionAsks: asksBack(r.text) } : {}),
    })),
  );
}

/**
 * 時間に置いた自分の番（ux-mvp 4.6）: open のフォローアップで、タスクの時間ブロックを作ってから開始までの間（待ちの集計外
 * `scheduled` と同じ区間）は status を scheduled にし、帯に戻る時刻（開始）を scheduledAt に入れる。DB の状態は open のまま
 */
function scheduledStatus(
  status: "open" | "snoozed",
  json: string | null,
  now: number,
): Pick<QueueItem["followUps"][number], "status" | "scheduledAt"> {
  if (status !== "open" || !json) return { status };
  let blocks: [number, number][] = [];
  try {
    blocks = (JSON.parse(json) as unknown[]).filter(
      (x): x is [number, number] =>
        Array.isArray(x) && typeof x[0] === "number" && typeof x[1] === "number",
    );
  } catch {
    return { status };
  }
  const until = derive.scheduledUntil(blocks, now);
  return until === null ? { status } : { status: "scheduled", scheduledAt: until };
}

/** 自分の番の行の、フォローアップ以外の部分（queue と graceQueue で共有） */
function queueItemBase(
  db: Database,
  presence: readonly [number, number][],
  now: number,
): (w: WiRow, waitingSince: number) => Omit<QueueItem, "followUps"> {
  const sources = sourcesByWorkItem(db);
  const wiTitles = titleResolver(db);
  return (w, waitingSince) => {
    const subject = wiTitles.subject(w);
    return {
      workItemId: w.id,
      // 件名の自動の題名（ai-title → PR の題名 → ブランチ。問い・許可の待ちの間は PR の題名を使わない。spec-glance §2.2）
      title: subject.title,
      userTitled: w.title_user !== null,
      ...(subject.source === "pr" ? { titleSource: "pr" as const } : {}),
      status: w.status as QueueItem["status"],
      reason: w.status_reason,
      estimated: w.status_estimated === 1,
      repoRoot: w.repo_root,
      scratch: w.scratch === 1,
      branch: w.branch,
      prRef: w.pr_ref,
      sources: sources.get(w.id) ?? [],
      waitingSince,
      waitStartedAway: !presentAt(presence, waitingSince, now),
    };
  };
}

/**
 * 猶予中の問い（D-245。GET /api/queue の `grace`）: セッションの待ち（D-240 の sessionWaitOf。runner が持つ）が問い（question）で、
 * そのターンにフォローアップ（返答タスク）がまだ無いもの。猶予（D-214 (3)）が過ぎて返答タスクができたら items の普通の行になる。
 * 閉じた返答タスク（対応不要など）のあるターンは出さない。設定で返答タスクを作らない（follow_up.kinds の reply がオフ）なら出さない。
 * 猶予の時刻を過ぎても返答タスクができるまで（判定の次の回まで）は出し続ける（行が一瞬消えてちらつかないように）
 */
export function graceQueue(
  db: Database,
  settings: TurnlaneSettings,
  now: number,
  waits: ReadonlyMap<string, derive.SessionWait>,
): QueueItem[] {
  if (settings.followUpKinds.reply !== true) return [];
  const cands = [...waits].filter(([, w]) => w.kind === "question");
  if (cands.length === 0) return [];
  const turnQ = db.query<
    { id: string; status: string; started_at: number; ended_at: number | null },
    [string]
  >("SELECT id, status, started_at, ended_at FROM ai_turn WHERE id = ?");
  // そのターンの返答タスク（どの状態でも。手で作ったものも）があれば出さない。開いた返答タスクは items の行、閉じたものは閉じた件
  const fuQ = db.query<{ n: number }, [string]>(
    "SELECT COUNT(*) AS n FROM follow_up WHERE deleted_at IS NULL AND kind = 'reply' AND trigger_turn_id = ?",
  );
  const wiQ = db.query<WiRow, [string]>(
    "SELECT * FROM work_item WHERE id = ? AND deleted_at IS NULL",
  );
  const rows: { w: WiRow; end: number; turnId: string }[] = [];
  for (const [id, sw] of cands) {
    const t = turnQ.get(sw.turnId);
    if (!t) continue;
    if ((fuQ.get(sw.turnId)?.n ?? 0) > 0) continue;
    const w = wiQ.get(id);
    if (!w || w.hidden_at) continue;
    // トランスクリプトが追いつかず Stop の hook で終わったターンは、その時刻から猶予を数える（返答タスクと同じ時刻）
    const end = t.ended_at ?? hookEndsOf(db, [t]).get(t.id) ?? t.started_at;
    rows.push({ w, end, turnId: sw.turnId });
  }
  if (rows.length === 0) return [];
  const presence = presenceFrom(db, settings, Math.min(...rows.map((r) => r.end)) - 1);
  const base = queueItemBase(db, presence, now);
  return rows
    .map(({ w, end, turnId }) => ({
      ...base(w, end),
      followUps: [],
      wait: { kind: "question" as const, turnId, followUpId: null },
      grace: { until: end + settings.replyDelayMs },
    }))
    .sort((a, b) => a.waitingSince - b.waitingSince);
}

/**
 * リセット前の上限待ち（GET /api/queue の `limitWaits`。自分の番の画面の「後で」）: カードが done・理由 rate_limit で、
 * 上限待ちがまだ明けていないもの（cardLimitWait）。open / snoozed のフォローアップ（YOUR TURN のタスク）のあるカードは
 * items のほうに出すので入れない。その停止の再開のタスク（`<turn>:limit`）を利用者が対応不要で閉じたもの（dismissed。
 * `POST /api/work-items/:id/dismiss-limit` が先に作る行も同じ）だけは出さない。自動で閉じた行（`auto:*`。明ける時刻が
 * 伸びて閉じた行など）は除く理由にしない。
 * 明ける早い順
 */
export function limitQueue(db: Database, settings: TurnlaneSettings, now: number): QueueItem[] {
  const wis = db
    .query<WiRow, []>(
      `SELECT * FROM work_item w WHERE w.deleted_at IS NULL AND w.hidden_at IS NULL
         AND w.status = 'done' AND w.status_reason = 'rate_limit'
         AND NOT EXISTS (SELECT 1 FROM follow_up f WHERE f.work_item_id = w.id AND f.deleted_at IS NULL
           AND f.status IN ('open', 'snoozed') AND f.kind IN (${SHOWN.map((k) => `'${k}'`).join(",")}))`,
    )
    .all();
  if (wis.length === 0) return [];
  const closedQ = db.query<{ n: number }, [string]>(
    "SELECT COUNT(*) AS n FROM follow_up WHERE deleted_at IS NULL AND dedupe_key = ? AND status = 'dismissed'",
  );
  const rows: { w: WiRow; l: CardLimitWait }[] = [];
  for (const w of wis) {
    const l = cardLimitWait(db, w.id, now);
    if (!l) continue;
    const key = derive.dedupeKey(w.id, "resume_error", derive.limitRef(l.turnId));
    if ((closedQ.get(key)?.n ?? 0) > 0) continue;
    rows.push({ w, l });
  }
  if (rows.length === 0) return [];
  const presence = presenceFrom(db, settings, Math.min(...rows.map((r) => r.l.since)) - 1);
  const base = queueItemBase(db, presence, now);
  return rows
    .map(({ w, l }) => ({
      ...base(w, l.since),
      followUps: [],
      limitWait: { since: l.since, until: l.until, untilKnown: l.untilKnown },
    }))
    .sort((a, b) => a.limitWait.until - b.limitWait.until);
}

/**
 * 自分の番1件の応答時間を数えるための待ち区間（D-057。`derive.countedResponseMs` に渡す）。
 * その自分の番に結び付いた待ち（`ai_wait_segment.follow_up_id`）の区間。1つの待ちに複数の自分の番が付くと
 * 区間は最初の1件にだけ結び付くので、結び付いた区間が無ければ同じカードの待ち区間を使う
 */
export function responseWaitSegments(
  db: Database,
  f: { id: string; work_item_id: string; trigger_at: number; closed_at: number },
): { kind: derive.WaitKind; start: number; end: number }[] {
  const rows = db
    .query<
      { follow_up_id: string | null; kind: derive.WaitKind; start_at: number; end_at: number },
      [string, number, number]
    >(
      `SELECT follow_up_id, kind, start_at, end_at FROM ai_wait_segment
       WHERE work_item_id = ? AND end_at > ? AND start_at < ?`,
    )
    .all(f.work_item_id, f.trigger_at, f.closed_at);
  const own = rows.filter((r) => r.follow_up_id === f.id);
  return (own.length > 0 ? own : rows).map((r) => ({
    kind: r.kind,
    start: r.start_at,
    end: r.end_at,
  }));
}

/** 人が応えて閉じた自分の番（応答時間を数える対象。自動で閉じた解決済み・期限切れ・対応不要は数えない。平均応答時間と同じ条件） */
const HAND_REASONS = ["auto:human_input", "auto:answered", "manual", "auto:next_turn_ok"];
function respondedByHand(f: {
  status: string;
  close_reason: string | null;
  engaged_at: number | null;
}): boolean {
  return (
    f.status === "done" && (HAND_REASONS.includes(f.close_reason ?? "") || f.engaged_at !== null)
  );
}

/** from〜to に閉じた自分の番（YOUR TURN のタスクの種類だけ。帯の閉じた行・デイビューの Closed today） */
export function closedRowsBetween(
  db: Database,
  from: number,
  to: number,
): QueueResponse["closedRows"] {
  const rows = db
    .query<
      {
        id: string;
        work_item_id: string;
        kind: string;
        status: string;
        close_reason: string | null;
        closed_at: number;
        trigger_at: number;
        engaged_at: number | null;
        task_id: string | null;
        task_title: string | null;
        title_key: string | null;
        title_params: string | null;
        repo_root: string | null;
        scratch: number | null;
        branch: string | null;
        artifact_ref: string;
        user_titled: number;
      },
      [number, number]
    >(
      `SELECT f.id, f.work_item_id, f.kind, f.status, f.close_reason, f.closed_at, f.trigger_at, f.engaged_at, f.task_id,
              t.title AS task_title, t.title_key, t.title_params, w.repo_root, w.scratch, w.branch,
              f.artifact_ref, (w.title_user IS NOT NULL AND w.title_user != '') AS user_titled
       FROM follow_up f LEFT JOIN task t ON t.id = f.task_id LEFT JOIN work_item w ON w.id = f.work_item_id
       WHERE f.deleted_at IS NULL AND f.closed_at >= ? AND f.closed_at < ? AND f.status IN ('done', 'dismissed', 'expired')
         AND f.kind IN (${SHOWN.map((k) => `'${k}'`).join(",")})
       ORDER BY f.closed_at`,
    )
    .all(from, to);
  const titles = resolveTaskTitles(
    db,
    rows
      .filter((f) => f.task_id !== null)
      .map((f) => ({
        id: f.task_id as string,
        title: f.task_title ?? "",
        title_key: f.title_key,
        title_params: f.title_params,
      })),
  );
  const closedRows: QueueResponse["closedRows"] = [];
  for (const f of rows) {
    const resolved =
      f.close_reason?.startsWith("auto:resolved:") || f.close_reason === "auto:pr_merged";
    const kind: ClosedKind =
      f.status === "dismissed"
        ? "not_needed"
        : f.status === "expired"
          ? "expired"
          : resolved
            ? "resolved"
            : "replied";
    const sig = f.close_reason?.startsWith("auto:resolved:")
      ? f.close_reason.slice("auto:resolved:".length)
      : f.close_reason === "auto:pr_merged"
        ? "pr_merged"
        : null;
    const via: ClosedVia | null =
      kind !== "replied"
        ? null
        : f.close_reason === "manual"
          ? "manual"
          : f.kind === "approve"
            ? "approve"
            : f.kind === "reply"
              ? f.artifact_ref.endsWith(":ask")
                ? "answer"
                : "reply"
              : f.kind === "resume_error"
                ? "resume"
                : f.kind === "merge_pr"
                  ? "merge"
                  : "review";
    closedRows.push({
      followUpId: f.id,
      workItemId: f.work_item_id,
      title: (f.task_id ? titles.get(f.task_id) : undefined) ?? {
        t: "text",
        text: f.task_title ?? "",
      },
      kind,
      via,
      userTitled: f.user_titled === 1,
      signal: sig === "commit" || sig === "new_session" || sig === "pr_merged" ? sig : null,
      closedAt: f.closed_at,
      responseMs: respondedByHand(f)
        ? derive.countedResponseMs(
            { triggerAt: f.trigger_at, engagedAt: f.engaged_at, closedAt: f.closed_at },
            responseWaitSegments(db, f),
          )
        : null,
      repoRoot: f.repo_root,
      scratch: f.scratch === 1,
      branch: f.branch,
    });
  }
  return closedRows;
}

/** 今日閉じた自分の番（帯の閉じた行）と、直近7日の平均応答時間・処理の件数（D-192） */
export function queueExtras(
  db: Database,
  settings: TurnlaneSettings,
  now: number,
): Pick<QueueResponse, "closedToday" | "closedRows" | "avgResponseMs" | "handled7d"> {
  const today = toLocalDate(now, settings.tz, settings.dayBoundary);
  const from = dayStartMs(today, settings.tz, settings.dayBoundary);
  const closedRows = closedRowsBetween(db, from, Number.MAX_SAFE_INTEGER);
  const closedToday: Record<ClosedKind, number> = {
    replied: 0,
    resolved: 0,
    not_needed: 0,
    expired: 0,
  };
  for (const r of closedRows) closedToday[r.kind]++;
  // 平均応答時間（直近7日。待ちの開始から ⏎ か返答まで。自動で閉じた解決済み・期限切れは数えない）。
  // 長さは壁時計ではなく、その間の猶予と放置の区間の和（D-057）
  const resp = db
    .query<
      {
        id: string;
        work_item_id: string;
        trigger_at: number;
        engaged_at: number | null;
        closed_at: number;
      },
      [number]
    >(
      `SELECT id, work_item_id, trigger_at, engaged_at, closed_at FROM follow_up
       WHERE deleted_at IS NULL AND status = 'done' AND closed_at >= ?
         AND (close_reason IN (${HAND_REASONS.map((r) => `'${r}'`).join(",")}) OR engaged_at IS NOT NULL)
         AND kind IN (${SHOWN.map((k) => `'${k}'`).join(",")})`,
    )
    .all(now - 7 * 86_400_000);
  const xs = resp
    .map((r) =>
      derive.countedResponseMs(
        { triggerAt: r.trigger_at, engagedAt: r.engaged_at, closedAt: r.closed_at },
        responseWaitSegments(db, r),
      ),
    )
    .filter((x): x is number => x !== null);
  // 処理の件数（直近7日 = 今日を含む 7 つの論理日。閉じた日で数える。turnlane stats の processed と同じ定義）
  const from7 = dayStartMs(addDays(today, -6), settings.tz, settings.dayBoundary);
  const handled7d = db
    .query<
      { status: "done" | "dismissed" | "expired" | "superseded"; close_reason: string | null },
      [number]
    >(
      `SELECT status, close_reason FROM follow_up
       WHERE deleted_at IS NULL AND closed_at >= ? AND status IN ('done', 'dismissed', 'expired', 'superseded')
         AND kind IN (${SHOWN.map((k) => `'${k}'`).join(",")})`,
    )
    .all(from7)
    .filter((f) => report.isHandled({ status: f.status, closeReason: f.close_reason })).length;
  return {
    closedToday,
    closedRows,
    avgResponseMs: xs.length > 0 ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null,
    handled7d,
  };
}

/** AI 詳細パネル（GET /api/work-items/:id。m2-api.md 2.3、M2-5）。本文は持っていないので、時刻・件数・時間だけ */
/**
 * 許可を求めているツールの種類とエラーの種類（D-116）: その AI 項目のセッションの最後の PermissionRequest / StopFailure の hook
 * （hook_event に種類だけ保存してある。コマンドの中身は保存しない。ADR 0005）。状態がブロック中・エラーのときだけ返す
 */
export function blockerOf(
  db: Database,
  id: string,
  status: string,
  reason: string | null,
): Pick<WorkItemDetail, "permissionKind" | "errorKind"> {
  const last = (name: string, col: "tool_name" | "error_type") =>
    db
      .query<{ v: string | null }, [string, string]>(
        `SELECT h.${col} AS v FROM hook_event h
         JOIN ai_session s ON s.external_id = h.session_external_id AND s.tool = h.tool
         WHERE s.id IN (SELECT DISTINCT session_id FROM ai_turn WHERE work_item_id = ?)
           AND h.hook_event_name = ?
           -- 自動で許可されるモードの許可の hook は待ちではない
           AND (h.hook_event_name <> 'PermissionRequest' OR COALESCE(h.permission_mode, '') <> 'bypassPermissions')
         ORDER BY h.occurred_at DESC LIMIT 1`,
      )
      .get(id, name)?.v ?? null;
  return {
    permissionKind:
      status === "needs_input" && reason === "hook:permission_request"
        ? permissionKindOf(last("PermissionRequest", "tool_name"))
        : null,
    // エラーの状態（1 時間）の後の再開待ち（your_turn の resume_error）と上限待ち（done の rate_limit）も止まった種類を返す
    // 上限待ちは種類の無い StopFailure（古い記録）を quota の通知から利用枠と推定したものもあるので、種類は rate_limit
    errorKind:
      reason === "rate_limit"
        ? "rate_limit"
        : (status === "error" && reason === "hook:stop_failure") || reason === "resume_error"
          ? errorKindOf(last("StopFailure", "error_type"))
          : null,
  };
}

/** サブエージェントだけの区間 → 実行の行（turnId は `subagent:<始まり>`。ツールの呼び出し・トークンは親のターンに数える） */
export function subagentRunDetail(
  r: { start: number; end: number; open: boolean },
  tool: string,
): AiRunDetail {
  return {
    turnId: `subagent:${r.start}`,
    start: r.start,
    end: r.end,
    open: r.open,
    toolCalls: 0,
    editedFiles: 0,
    inputTokens: null,
    outputTokens: null,
    endedWith: null,
    tool,
  };
}

export function workItemDetail(
  db: Database,
  id: string,
  settings: TurnlaneSettings,
  now: number,
  rev: number,
): WorkItemDetail | null {
  const w = db
    .query<
      WiRow & {
        group_key: string;
        manual_done_at: number | null;
      },
      [string]
    >("SELECT * FROM work_item WHERE id = ?")
    .get(id);
  if (!w) return null;
  const turnRows = db
    .query<
      {
        id: string;
        tool: string;
        started_at: number;
        ended_at: number | null;
        duration_ms: number | null;
        status: string;
        ended_with: AiRunDetail["endedWith"];
        edited_files_count: number;
        tool_counts_json: string | null;
        input_tokens: number | null;
        output_tokens: number | null;
        last_activity_at: number;
        instruction: string | null;
      },
      [string]
    >(
      `SELECT t.id, s.tool, t.started_at, t.ended_at, t.duration_ms, t.status, t.ended_with, t.edited_files_count,
              t.tool_counts_json, t.input_tokens, t.output_tokens, s.last_activity_at, i.text AS instruction
       FROM ai_turn t JOIN ai_session s ON s.id = t.session_id LEFT JOIN ai_instruction i ON i.turn_id = t.id
       WHERE t.work_item_id = ? ORDER BY t.started_at`,
    )
    .all(id);
  // StopFailure・idle_prompt の後に活動の無い終わっていないターンは、その hook の時刻で終わったものとして扱う（流れを
  // 「今」まで伸ばさない。AI の時間も同じ）。ai_turn は書き換えない
  const turns = withHookEnds(db, turnRows);
  // 保存した中身（ADR 0018）は設定がオンのときだけ出す
  const stored = settings.storeDetail;
  const runs: AiRunDetail[] = turns.map((t, i) => {
    const open = t.status === "running" && t.ended_at === null;
    let calls = 0;
    try {
      for (const v of Object.values(
        JSON.parse(t.tool_counts_json ?? "{}") as Record<string, number>,
      ))
        calls += typeof v === "number" ? v : 0;
    } catch {}
    return {
      turnId: t.id,
      start: t.started_at,
      end: open ? Math.max(now, t.started_at) : (t.ended_at ?? t.started_at + (t.duration_ms ?? 0)),
      open,
      toolCalls: calls,
      editedFiles: t.edited_files_count,
      inputTokens: t.input_tokens,
      outputTokens: t.output_tokens,
      endedWith: t.ended_with,
      tool: t.tool,
      ...(stored && cleanSubject(t.instruction)
        ? { instruction: cleanSubject(t.instruction) as string }
        : {}),
      // 問い返し（Issue #3）: 前のターンが AI の問いで終わり、この入力の 1 行目が問いの形
      ...(stored &&
      t.instruction &&
      turns[i - 1]?.ended_with === "question" &&
      asksBack(t.instruction)
        ? { askedBack: true as const }
        : {}),
    };
  });
  const artifacts = db
    .query<
      {
        kind: string;
        ref: string;
        url: string | null;
        title: string | null;
        state: string | null;
        review_decision: string | null;
        state_changed_at: number | null;
      },
      [string]
    >(
      "SELECT kind, ref, url, title, state, review_decision, state_changed_at FROM ai_artifact WHERE work_item_id = ? ORDER BY first_seen_at",
    )
    .all(id)
    .map(({ review_decision, state_changed_at, ...a }) => ({
      ...a,
      reviewDecision: reviewDecisionOf(review_decision),
      stateChangedAt: state_changed_at,
    }));
  const followUps = db
    .query<
      {
        id: string;
        kind: WorkItemDetail["followUps"][number]["kind"];
        status: string;
        triggerAt: number;
        closedAt: number | null;
        closeReason: string | null;
        artifact_ref: string;
        trigger_turn_id: string | null;
        returned_at: number | null;
      },
      [string]
    >(
      "SELECT id, kind, status, trigger_at AS triggerAt, closed_at AS closedAt, close_reason AS closeReason, artifact_ref, trigger_turn_id, returned_at FROM follow_up WHERE work_item_id = ? AND deleted_at IS NULL ORDER BY trigger_at",
    )
    .all(id)
    .map(({ artifact_ref, trigger_turn_id, returned_at, ...f }) => {
      const w = stored ? storedWaitOf(db, f.id) : null;
      // 問い返し中（Issue #3）は読み取りの時刻で asked_back
      const asked =
        f.status === "open" &&
        askedBackPending(db, { kind: f.kind, artifact_ref, trigger_turn_id, returned_at });
      const g = asked ? { ...f, status: "asked_back" } : f;
      return w ? { ...g, wait: w } : g;
    });
  const segs = db
    .query<
      {
        wait_key: string;
        kind: WaitSegmentDetail["kind"];
        excluded_by: WaitSegmentDetail["excludedBy"];
        start_at: number;
        end_at: number;
        is_open: number;
        end_reason: string | null;
        follow_up_id: string | null;
      },
      [string]
    >(
      "SELECT wait_key, kind, excluded_by, start_at, end_at, is_open, end_reason, follow_up_id FROM ai_wait_segment WHERE work_item_id = ? ORDER BY start_at",
    )
    .all(id);
  const waits: WaitSegmentDetail[] = segs.map((r) => ({
    waitKey: r.wait_key,
    kind: r.kind,
    excludedBy: r.excluded_by,
    start: r.start_at,
    end: r.end_at,
    open: r.is_open === 1,
    endReason: r.end_reason,
    followUpId: r.follow_up_id,
  }));
  const ranges = (pred: (x: (typeof segs)[number]) => boolean) =>
    derive.unionLength(segs.filter(pred).map((x) => [x.start_at, x.end_at] as [number, number]));
  const you = db
    .query<{ start_at: number; end_at: number | null }, [string]>(
      `SELECT e.start_at, e.end_at FROM task_time_entry e JOIN follow_up f ON f.task_id = e.task_id
       WHERE f.work_item_id = ? AND e.deleted_at IS NULL`,
    )
    .all(id);
  const youMs = derive.unionLength(
    you.map((r) => [r.start_at, r.end_at ?? now] as [number, number]),
  );
  // AI の時間: 終わっていないターンは実行中なら now、待ち中なら待ちの始まりまで（D-052 (4)。週ボード・日報と同じ）。
  // 親のターンが閉じた後もサブエージェントが動いていた区間を足す（二重に数えない）
  const waitStarts = openWaitStarts(db);
  const card = { status: w.status, openWaitStart: waitStarts.get(id) ?? null, now };
  const subRuns =
    turns.length > 0
      ? subagentRuns(db, now, { from: turns[0]?.started_at ?? 0, to: now + 1 }, waitStarts).filter(
          (r) => r.workItemId === id,
        )
      : [];
  const aiMs = derive.unionLength([
    ...turns.map((t) =>
      derive.turnAiInterval(
        {
          startedAt: t.started_at,
          endedAt: t.ended_at,
          durationMs: t.duration_ms,
          status: t.status,
          sessionLastActivityAt: t.last_activity_at,
        },
        card,
      ),
    ),
    ...subRuns.map((r) => [r.start, r.end] as [number, number]),
  ]);
  const idleMs = ranges((x) => x.kind === "idle");
  const pr = artifacts.filter((a) => a.kind === "pr").at(-1);
  const prMatch = pr ? /^([^#]+)#(\d+)$/.exec(pr.ref) : null;
  const sources = sourcesByWorkItem(db).get(id) ?? [];
  const shown = titleResolver(db).display(w);
  const first = Math.min(w.first_activity_at, ...runs.map((r) => r.start));
  const last = w.status === "done" ? w.last_activity_at : now;
  return {
    ...readMeta(settings, now, rev),
    workItem: {
      id: w.id,
      // 詳細の見出し（件名の順。spec-glance §2.2・§3.7）。直近の指示は画面が表示の瞬間に読んで差し替える
      title: shown.title,
      titleSource: shown.source,
      status: w.status as WorkItemDetail["workItem"]["status"],
      reason: w.status_reason,
      estimated: w.status_estimated === 1,
      sources,
      repoRoot: w.repo_root,
      scratch: w.scratch === 1,
      branch: w.branch,
      prRef: w.pr_ref,
      aiMs,
      youMs,
      idleMs,
      turns: runs.length,
      carriedFrom: null,
      groupKey: w.group_key,
      manualDoneAt: w.manual_done_at,
      hidden: w.hidden_at !== null,
      firstActivityAt: w.first_activity_at,
      lastActivityAt: w.last_activity_at,
    },
    // サブエージェントだけが動いていた区間も流れに入れる（親のブロックが途切れない。ターン数には数えない）
    turns: [
      ...runs,
      ...subRuns.map((r) => subagentRunDetail(r, turns.at(-1)?.tool ?? "claude_code")),
    ].sort((a, b) => a.start - b.start),
    artifacts,
    followUps,
    waits,
    breakdown: {
      aiMs,
      youMs,
      idleMs,
      graceMs: ranges((x) => x.kind === "grace"),
      excludedMs: {
        closed: ranges((x) => x.excluded_by === "closed"),
        away: ranges((x) => x.excluded_by === "away"),
        event: ranges((x) => x.excluded_by === "event"),
        snoozed: ranges((x) => x.excluded_by === "snoozed"),
        no_task: ranges((x) => x.excluded_by === "no_task"),
        scheduled: ranges((x) => x.excluded_by === "scheduled"),
      },
      expiredMs: ranges((x) => x.kind === "expired"),
      wallMs: Math.max(0, last - first),
    },
    ...blockerOf(db, id, w.status, w.status_reason),
    graceMs: settings.graceMs,
    open: {
      resume: turns.some((t) => t.tool === "claude_code" || t.tool === "codex"),
      pr: pr?.url ?? (prMatch ? `https://github.com/${prMatch[1]}/pull/${prMatch[2]}` : null),
      folder: w.repo_root !== null,
    },
  };
}

/** 保存した待ちの中身（wait_detail。ADR 0018）を API の形に */
export function storedWaitOf(db: Database, followUpId: string): StoredWait | null {
  const r = db
    .query<
      {
        kind: StoredWait["kind"];
        text: string | null;
        options_json: string | null;
        tool: string | null;
        label: string | null;
        command: string | null;
        error_kind: string | null;
      },
      [string]
    >(
      "SELECT kind, text, options_json, tool, label, command, error_kind FROM wait_detail WHERE follow_up_id = ?",
    )
    .get(followUpId);
  if (!r) return null;
  let options: string[] | undefined;
  if (r.kind === "ask") {
    try {
      const v = JSON.parse(r.options_json ?? "[]") as { options?: unknown }[];
      const o = Array.isArray(v) ? v[0]?.options : undefined;
      if (Array.isArray(o)) options = o.filter((x): x is string => typeof x === "string");
    } catch {}
  }
  const ek = r.error_kind ? errorKindOf(r.error_kind) : null;
  return {
    kind: r.kind,
    ...(r.text ? { text: r.text } : {}),
    ...(options ? { options } : {}),
    ...(r.tool ? { tool: r.tool.replace("\u0000", " ") } : {}),
    ...(r.label ? { label: r.label } : {}),
    ...(r.command ? { command: r.command } : {}),
    ...(ek ? { errorKind: ek } : {}),
  };
}
