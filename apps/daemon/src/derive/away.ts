/**
 * 離れていた間のまとめ（GET /api/away。ux-mvp 4.13、D-214 (2)）。判定は core の derive.awayGap / composeAway（純粋関数）。
 * ここは DB から事実を集めるだけ: 在席の区間（presence_span）、フォローアップ（新しい待ち・エラー）、ターンの終わり（完了・
 * エラー）、PR（見つけた時刻・マージの時刻）。新しく保存するのは「閉じた」印（設定 away.dismissed）だけ。
 * 件名は自分の番の行と同じ（自分で付けた名前 → その日の最初の保存した指示 → 自動の題名。D-214 (1)）
 */
import type { Database } from "bun:sqlite";
import { derive, type TurnlaneSettings, toLocalDate } from "@turnlane/core";
import type {
  AwayDigest,
  AwayItem,
  ChangeSize,
  QueueItem,
  WorkItemStatus,
} from "@turnlane/core/api";
import { presenceIn } from "../presence/service.ts";
import { storedSubject } from "./stored-subject.ts";
import { titleResolver } from "./subject.ts";

/** 設定「戻ったときのまとめを出す」（既定オン） */
export const AWAY_SETTING_KEY = "turn.away_summary";
/** 閉じたまとめの印（戻った時刻の文字列。端末内だけ） */
export const AWAY_DISMISSED_KEY = "away.dismissed";
/** 同じ項目のターンがこれより短い間で続けば、ひと続きの作業として編集したファイルの数を足す（AI レーンの規則と同じ） */
const CHAIN_MS = 30 * 60_000;

/** setting の値（JSON）を sqlite から読む（読めなければ undefined） */
export function settingValue(db: Database, key: string): unknown {
  const r = db
    .query<{ v: string }, [string]>("SELECT value_json AS v FROM setting WHERE key = ?")
    .get(key);
  if (!r) return undefined;
  try {
    return JSON.parse(r.v) as unknown;
  } catch {
    return undefined;
  }
}

/** PR の変更の量と CI（gh で読めたときだけ。読めなければ null） */
export type PrChangeLookup = (ref: string) => Promise<
  | (Omit<ChangeSize, "files"> & {
      files: number | null;
    })
  | null
>;

/**
 * 最後のひと続きの作業（at までに終わったターンを、間が 30 分未満のあいだ遡る）で編集したファイルの数の和。
 * 編集が無ければ null
 */
export function runFiles(db: Database, workItemId: string, at: number): number | null {
  const turns = db
    .query<
      { started_at: number; ended_at: number | null; edited_files_count: number },
      [string, number]
    >(
      `SELECT t.started_at, t.ended_at, t.edited_files_count FROM ai_turn t JOIN ai_session s ON s.id = t.session_id
       WHERE t.work_item_id = ? AND s.is_noise = 0 AND t.ended_at IS NOT NULL AND t.ended_at <= ?
       ORDER BY t.ended_at DESC LIMIT 200`,
    )
    .all(workItemId, at);
  let sum = 0;
  let start: number | null = null;
  for (const t of turns) {
    if (start !== null && start - (t.ended_at ?? t.started_at) >= CHAIN_MS) break;
    sum += t.edited_files_count;
    start = t.started_at;
  }
  return sum > 0 ? sum : null;
}

/** 離席の区間に起きた変化（core の AwayEvent）を集める */
export function awayEvents(db: Database, from: number, to: number): derive.AwayEvent[] {
  const out: derive.AwayEvent[] = [];
  // 新しい待ち・エラー（AI が止まった時刻 = きっかけのターンの終わり。許可待ちは hook の時刻 = trigger_at）
  for (const f of db
    .query<
      {
        id: string;
        work_item_id: string;
        kind: string;
        artifact_ref: string;
        trigger_at: number;
        turn_end: number | null;
      },
      [number, number]
    >(
      `SELECT f.id, f.work_item_id, f.kind, f.artifact_ref, f.trigger_at, t.ended_at AS turn_end
       FROM follow_up f LEFT JOIN ai_turn t ON t.id = f.trigger_turn_id
       WHERE f.deleted_at IS NULL AND f.status <> 'superseded'
         AND f.kind IN ('reply', 'approve', 'resume_error')
         AND f.artifact_ref NOT LIKE '%${derive.MANUAL_REF_SUFFIX}'
         AND f.artifact_ref NOT LIKE '%${derive.LIMIT_REF_SUFFIX}'
         AND COALESCE(t.ended_at, f.trigger_at) >= ? AND COALESCE(t.ended_at, f.trigger_at) < ?`,
    )
    .all(from, to)) {
    const at = f.kind === "approve" ? f.trigger_at : (f.turn_end ?? f.trigger_at);
    out.push({
      workItemId: f.work_item_id,
      kind:
        f.kind === "approve"
          ? "permission"
          : f.kind === "resume_error"
            ? "error"
            : derive.isAskReply({ kind: f.kind, artifactRef: f.artifact_ref })
              ? "ask"
              : "question",
      at,
      followUpId: f.id,
    });
  }
  // ターンの終わり: 質問なしで終わった = 完了、エラーで終わった = エラー（再開のタスクが無いときも事実として出す）。
  // 利用枠で止まった（上限待ち）はエラーに数えない（明けた後の「再開できる」も上で外している）。hook の窓は大まか
  // （ターンの始まりから終わりの 1 分後まで）
  for (const t of db
    .query<
      {
        work_item_id: string;
        ended_at: number;
        status: string;
        ended_with: string | null;
        pending_question: number;
        closing_question: number;
        limited: number;
      },
      [number, number]
    >(
      `SELECT t.work_item_id, t.ended_at, t.status, t.ended_with, t.pending_question, t.closing_question,
              EXISTS (SELECT 1 FROM hook_event h
                      WHERE h.session_external_id = s.external_id AND h.tool = s.tool
                        AND ((h.hook_event_name = 'StopFailure' AND h.error_type = 'rate_limit')
                             -- 種類の無い StopFailure（古い記録）でも、利用枠の自動再開の通知があれば利用枠（core の turnStopOf）
                             OR (h.hook_event_name = 'Notification' AND h.notification_type IN ('quota_auto_resume_fired', 'quota_auto_resume_stale', 'quota_auto_resume_disabled')))
                        AND h.occurred_at >= t.started_at - 1000 AND h.occurred_at <= t.ended_at + 60000) AS limited
       FROM ai_turn t JOIN ai_session s ON s.id = t.session_id
       WHERE t.work_item_id IS NOT NULL AND s.is_noise = 0 AND s.is_subagent = 0
         AND t.ended_at >= ? AND t.ended_at < ?
         -- 閉じた後もサブエージェントが動いていたターンは、まだ終わっていない（完了・エラーに数えない。再開したターンで数える）
         AND NOT EXISTS (SELECT 1 FROM ai_session c
                         WHERE c.parent_session_id = s.id AND c.is_subagent = 1
                           AND c.started_at <= t.ended_at
                           AND COALESCE(c.ended_at, c.last_activity_at) > t.ended_at + 1000)`,
    )
    .all(from, to)) {
    if (t.status === "error" || t.ended_with === "error") {
      if (t.limited === 0) out.push({ workItemId: t.work_item_id, kind: "error", at: t.ended_at });
    } else if (
      t.status === "completed" &&
      (t.ended_with === "end_turn" || t.ended_with === null) &&
      (t.pending_question === 0 || t.closing_question === 1)
    )
      out.push({ workItemId: t.work_item_id, kind: "done", at: t.ended_at });
  }
  // PR: 見つけた（開いた）時刻とマージの時刻
  for (const p of db
    .query<
      {
        work_item_id: string;
        ref: string;
        state: string;
        first_seen_at: number;
        state_changed_at: number | null;
      },
      [number, number, number, number]
    >(
      `SELECT work_item_id, ref, state, first_seen_at, state_changed_at FROM ai_artifact
       WHERE kind = 'pr' AND work_item_id IS NOT NULL
         AND ((first_seen_at >= ? AND first_seen_at < ?)
           OR (state = 'merged' AND state_changed_at >= ? AND state_changed_at < ?))`,
    )
    .all(from, to, from, to)) {
    const n = Number(/#(\d+)$/.exec(p.ref)?.[1]);
    if (!Number.isFinite(n)) continue;
    if (p.first_seen_at >= from && p.first_seen_at < to)
      out.push({
        workItemId: p.work_item_id,
        kind: "pr_opened",
        at: p.first_seen_at,
        prNumber: n,
        prRef: p.ref,
      });
    if (p.state === "merged" && p.state_changed_at !== null)
      out.push({
        workItemId: p.work_item_id,
        kind: "pr_merged",
        at: p.state_changed_at,
        prNumber: n,
        prRef: p.ref,
      });
  }
  return out;
}

interface WiRow {
  id: string;
  title_user: string | null;
  title_auto: string | null;
  title_source: string | null;
  branch: string | null;
  repo_root: string | null;
  scratch: number;
  status: string;
  hidden_at: number | null;
  merged_into_id: string | null;
}

/** 離れていた間のまとめ（出さないときは null）。prChange があれば PR の変更の量と CI を足す */
export async function awayDigest(
  db: Database,
  settings: TurnlaneSettings,
  now: number,
  prChange?: PrChangeLookup,
): Promise<AwayDigest | null> {
  if (settingValue(db, AWAY_SETTING_KEY) === false) return null;
  const presence = presenceIn(db, now - derive.AWAY_LOOKBACK_MS, now + 1, settings.presenceTailMs);
  const gap = derive.awayGap(presence, now);
  if (!gap) return null;
  const dismissed = settingValue(db, AWAY_DISMISSED_KEY);
  const engaged = db.query<{ n: number }, [string, number]>(
    "SELECT count(*) AS n FROM follow_up WHERE work_item_id = ? AND engaged_at >= ?",
  );
  const wis = new Map(
    db
      .query<WiRow, []>(
        "SELECT id, title_user, title_auto, title_source, branch, repo_root, scratch, status, hidden_at, merged_into_id FROM work_item WHERE deleted_at IS NULL",
      )
      .all()
      .map((w) => [w.id, w]),
  );
  // 隠した・まとめた・消した項目の変化は出さない
  const events = awayEvents(db, gap.from, gap.to).filter((e) => {
    const w = wis.get(e.workItemId);
    return w !== undefined && w.hidden_at === null && w.merged_into_id === null;
  });
  const c = derive.composeAway(gap, events, {
    now,
    dismissedKey: typeof dismissed === "string" ? dismissed : null,
    openedSince: (id, since) => (engaged.get(id, since)?.n ?? 0) > 0,
  });
  if (!c) return null;
  const titles = titleResolver(db);
  const day = toLocalDate(now, settings.tz, settings.dayBoundary);
  const items: AwayItem[] = [];
  for (const x of c.items) {
    const w = wis.get(x.workItemId) as WiRow;
    const subject =
      (!w.title_user && settings.storeDetail ? storedSubject(db, w.id, day) : null) ??
      titles.subject(w).title;
    // 変更の量は終わった件（完了・PR）だけ。PR は gh で読めたときの値、無ければ編集したファイルの数
    let change: ChangeSize | null = null;
    if (x.group === "done" || x.group === "pr") {
      const files = runFiles(db, w.id, c.to);
      const ref =
        x.prRef ??
        db
          .query<{ ref: string }, [string]>(
            "SELECT ref FROM ai_artifact WHERE work_item_id = ? AND kind = 'pr' AND state IN ('open', 'draft', 'unknown') ORDER BY first_seen_at DESC LIMIT 1",
          )
          .get(w.id)?.ref;
      const pr = ref && prChange ? await prChange(ref).catch(() => null) : null;
      change =
        pr || files !== null
          ? {
              files: pr?.files ?? files,
              ...(pr
                ? {
                    additions: pr.additions ?? null,
                    deletions: pr.deletions ?? null,
                    ci: pr.ci ?? null,
                  }
                : {}),
            }
          : null;
    }
    const url = x.prRef
      ? (db
          .query<{ url: string | null }, [string]>(
            "SELECT url FROM ai_artifact WHERE kind = 'pr' AND ref = ?",
          )
          .get(x.prRef)?.url ?? null)
      : null;
    items.push({
      workItemId: w.id,
      title: subject,
      status: w.status as WorkItemStatus,
      kind: x.kind,
      at: x.at,
      followUpId: x.followUpId ?? null,
      pr: x.prNumber !== undefined && x.prRef ? { number: x.prNumber, ref: x.prRef, url } : null,
      change,
      repoRoot: w.repo_root,
      ...(w.scratch === 1 ? { scratch: true } : {}),
      branch: w.branch,
    });
  }
  return {
    key: c.key,
    from: c.from,
    to: c.to,
    until: c.until,
    counts: c.counts,
    items,
  };
}

/** 控えだけを読む PR の変更の量と CI（gh を呼ばない） */
export type PrChangeCached = (ref: string) =>
  | (Omit<ChangeSize, "files"> & {
      files: number | null;
    })
  | null;

/**
 * 自分の番の一覧の、終わった件（PR の確認待ち・マージ待ち）に変更の量を付ける（D-214 (2) の 6）。ファイル数は最後の
 * ひと続きの作業で編集した数、PR の +N −M と CI は控えがあるときだけ
 */
export function withChange(
  db: Database,
  items: QueueItem[],
  cached?: PrChangeCached | null,
): QueueItem[] {
  return items.map((x) => {
    if (!x.followUps.some((f) => f.kind === "review_pr" || f.kind === "merge_pr")) return x;
    const files = runFiles(db, x.workItemId, x.waitingSince);
    const pr = x.prRef && cached ? cached(x.prRef) : null;
    if (!pr && files === null) return x;
    return {
      ...x,
      change: {
        files: pr?.files ?? files,
        ...(pr
          ? { additions: pr.additions ?? null, deletions: pr.deletions ?? null, ci: pr.ci ?? null }
          : {}),
      },
    };
  });
}
