/**
 * 利用計測（M5-1。phase0-plan 4.7、D-006）。事実から `turnlane stats` の値を組み立てる純粋関数。
 * - 14日カウントに数える日: UI を開いた日（usage_event の ui_open。D-192 で儀式の条件を外した）
 * - 自分の番の処理数（主要指標）: YOUR TURN のタスク（reply / review_pr / approve / resume_error）のうち、
 *   返答・解決・対応不要で閉じたもの（期限切れと置き換えは数えない）
 * - 平均応答時間: 待ちの開始（trigger_at）から ⏎ か返答まで。自動で閉じた解決済み・期限切れは数えない（キュー画面と同じ定義）。
 *   長さは壁時計ではなく、その間の猶予と放置の区間の和で数える（D-057。`countedResponseMs`）
 */
import type { UsageDay, UsageStats } from "../api/daily-note.ts";
import { addDays } from "../dates.ts";
import { countedResponseMs, type WaitSegment } from "../derive/time.ts";

export interface UsageFollowUpFact {
  /** 閉じた論理日付 */
  date: string;
  status: "done" | "dismissed" | "expired" | "superseded";
  closeReason: string | null;
  triggerAt: number;
  engagedAt: number | null;
  closedAt: number;
  /** この自分の番の待ち区間（区分を問わない。D-057）。応答時間は猶予と放置の部分だけで数える */
  waitSegments: readonly Pick<WaitSegment, "kind" | "start" | "end">[];
}

export interface UsageFacts {
  today: string;
  days: number;
  /** UI を開いた論理日付 */
  opened: ReadonlySet<string>;
  followUps: readonly UsageFollowUpFact[];
}

const HUMAN_REASONS = new Set(["auto:human_input", "auto:answered", "manual", "auto:next_turn_ok"]);

/** 閉じた理由の区分。処理（handled）は replied + resolved + notNeeded（期限切れは含まない） */
export function closedKind(
  f: Pick<UsageFollowUpFact, "status" | "closeReason">,
): "replied" | "resolved" | "notNeeded" | "expired" | null {
  if (f.status === "dismissed") return "notNeeded";
  if (f.status === "expired") return "expired";
  if (f.status !== "done") return null;
  return f.closeReason?.startsWith("auto:resolved:") || f.closeReason === "auto:pr_merged"
    ? "resolved"
    : "replied";
}

/** 処理した自分の番か（返答・解決・対応不要。期限切れ・置き換えは数えない。自分の番の画面の「処理 N 件（7日）」も同じ） */
export function isHandled(f: Pick<UsageFollowUpFact, "status" | "closeReason">): boolean {
  const k = closedKind(f);
  return k !== null && k !== "expired";
}

export function usageStats(f: UsageFacts): UsageStats {
  const from = addDays(f.today, -(f.days - 1));
  const inRange = f.followUps.filter((x) => x.date >= from && x.date <= f.today);
  const days: UsageDay[] = [];
  for (let i = 0; i < f.days; i++) {
    const date = addDays(from, i);
    const opened = f.opened.has(date);
    days.push({
      date,
      opened,
      counted: opened,
      processed: inRange.filter((x) => x.date === date && isHandled(x)).length,
    });
  }
  // 連続日数: 今日で終わる。今日がまだ数えられていなければ（まだ開いていない）昨日で終わる
  let streak = 0;
  const counted = new Map(days.map((d) => [d.date, d.counted]));
  let d = counted.get(f.today) ? f.today : addDays(f.today, -1);
  while (counted.get(d)) {
    streak++;
    d = addDays(d, -1);
  }
  const by = { replied: 0, resolved: 0, notNeeded: 0, expired: 0 };
  for (const x of inRange) {
    const k = closedKind(x);
    if (k) by[k]++;
  }
  const processed = by.replied + by.resolved + by.notNeeded;
  const resp = inRange
    .filter(
      (x) =>
        x.status === "done" &&
        (x.engagedAt !== null || (x.closeReason !== null && HUMAN_REASONS.has(x.closeReason))),
    )
    .map((x) => countedResponseMs(x, x.waitSegments))
    .filter((x): x is number => x !== null);
  return {
    today: f.today,
    days,
    countedDays: days.filter((x) => x.counted).length,
    streak,
    followUps: {
      processed,
      perWeek: Math.round(((processed * 7) / f.days) * 10) / 10,
      ...by,
    },
    avgResponseMs:
      resp.length > 0 ? Math.round(resp.reduce((a, b) => a + b, 0) / resp.length) : null,
  };
}
