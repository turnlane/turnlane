/**
 * AI のレーン（3日ボードの今日の列・デイビュー）で、対応が要るもの（自分の番）を前に出す（D-246）。純粋関数にしてテストする。
 * - 重なるラベルの順: 自分の番（問い・許可・エラー。猶予中を含む）→ 実行中 → 完了・PR。先のものが場所を取り、後のものが
 *   先のラベルの `+N` に畳まれる
 * - 問いで止まっている項目（猶予中を含む）の最後の線の印は完了の ✓ ではなく自分の番の →、右の時間は `待ち 3m`（猶予中は
 *   `猶予 3m`）
 * 待ちの判定はデーモンの queue の item の `wait`（D-240 の openWaitOf）を使い、ここで複製しない
 */
import {
  isGrace,
  type OpenWaitBrief,
  type QueueItem,
  type QueueResponse,
  turnRows,
  type WorkItemStatus,
} from "@turnlane/core/web";
import { useMemo } from "react";
import { useQueue } from "../data/queries.ts";
import type { MessageKey } from "../i18n/index.tsx";
import { deferredTurn, laterShortKey } from "../lib/later-text.ts";

/** レーンの項目の開いている待ち */
export interface LaneWait {
  kind: OpenWaitBrief["kind"];
  /** 待ちの始まり（queue の waitingSince） */
  since: number;
  /** 猶予中（D-245） */
  grace: boolean;
}

/** queue（items と猶予中）から 項目 → 開いている待ち */
export function laneWaitsOf(
  q: Pick<QueueResponse, "items" | "grace"> | undefined,
): Map<string, LaneWait> {
  const out = new Map<string, LaneWait>();
  for (const x of turnRows(q?.items, q?.grace))
    if (x.wait)
      out.set(x.workItemId, { kind: x.wait.kind, since: x.waitingSince, grace: isGrace(x) });
  return out;
}

/** 重なるラベルの順（小さいほど先）: 0 = 自分の番、1 = 実行中、2 = 完了・PR ほか */
export function laneRank(status: WorkItemStatus, wait: LaneWait | undefined): number {
  if (wait || status === "needs_input" || status === "error") return 0;
  if (status === "running") return 1;
  return 2;
}

/** 問いで止まっている（猶予中を含む）待ち。許可・エラーは項目の状態がそのまま出る */
export function questionWait(wait: LaneWait | undefined): LaneWait | null {
  return wait && (wait.kind === "question" || wait.kind === "ask") ? wait : null;
}

/**
 * 最後の線の印の状態: 問いで止まっていれば自分の番（完了の ✓ にしない）。項目がブロック中・エラーならそのまま
 */
export function laneStatus(status: WorkItemStatus, wait: LaneWait | undefined): WorkItemStatus {
  if (status === "needs_input" || status === "error") return status;
  return questionWait(wait) ? "your_turn" : status;
}

/** 画面の queue から 項目 → 開いている待ち（SSE で queue が変われば作り直す） */
export function useLaneWaits(): Map<string, LaneWait> {
  const q = useQueue();
  return useMemo(() => laneWaitsOf(q.data), [q.data]);
}

/**
 * queue から 項目 → 後でにした自分の番の札（`明日へ` / `後で`）。帯・件数から外れた（open なフォローアップの無い）カードだけ。
 * レーンの札は放置の長さの代わりにこれを出す（スヌーズ中は放置に数えない）
 */
export function laneLatersOf(
  q: Pick<QueueResponse, "items" | "today"> | undefined,
): Map<string, MessageKey> {
  const out = new Map<string, MessageKey>();
  for (const x of q?.items ?? [])
    if (deferredTurn(x as QueueItem)) out.set(x.workItemId, laterShortKey(x, q?.today ?? ""));
  return out;
}

/** 画面の queue から 項目 → 後での札 */
export function useLaneLaters(): Map<string, MessageKey> {
  const q = useQueue();
  return useMemo(() => laneLatersOf(q.data), [q.data]);
}
