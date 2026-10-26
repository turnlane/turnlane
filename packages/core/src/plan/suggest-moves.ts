/**
 * 朝の計画 Step 3 の移動候補（M4-7。m2-api.md 16章、ux-mvp 8章）。純粋関数。
 * - 対象: 今日の未着手（todo）で時間ブロックの無いタスク
 * - 順: `*`（ハイライト）の無いものを先に、並びの下（lane_order の大きい方）から
 * - 超過分（plannedMs − freeMs）が収まるまで選ぶ。見積の無いタスクは30分（m2-api.md 9.1）
 * - 行き先: 空き（freeMs − plannedMs − この関数で先に割り当てた分）が足りる最初の稼働日。
 *   稼働日でない日・Free の無い日は飛ばす。足りる日が無ければ最初の稼働日（無ければ null）
 * 自動では動かさない。UI が1件ずつ `⏎` で適用する。
 */
import { UNESTIMATED_MS } from "./capacity.ts";

export interface MoveTaskInput {
  id: string;
  status: string;
  estimateMin: number | null;
  isHighlight: boolean;
  laneOrder: string;
  /** 時間ブロックを持つ（時刻を決めたものは動かさない） */
  hasBlock: boolean;
}

export interface DayRoom {
  date: string;
  /** 稼働日でない日は false（null は稼働日として扱う） */
  workday: boolean | null;
  freeMs: number;
  plannedMs: number;
}

export interface MoveSuggestion {
  taskId: string;
  /** 見積（見積なしは30分）。超過分に数えた長さ */
  ms: number;
  estimated: boolean;
  to: string | null;
}

export function suggestMoves(
  tasks: readonly MoveTaskInput[],
  overMs: number,
  days: readonly DayRoom[],
): MoveSuggestion[] {
  if (overMs <= 0) return [];
  const candidates = tasks
    .filter((t) => t.status === "todo" && !t.hasBlock)
    .sort(
      (a, b) =>
        Number(a.isHighlight) - Number(b.isHighlight) ||
        (a.laneOrder < b.laneOrder ? 1 : a.laneOrder > b.laneOrder ? -1 : 0),
    );
  const open = days.filter((d) => d.workday !== false && d.freeMs > 0);
  const room = new Map(open.map((d) => [d.date, d.freeMs - d.plannedMs]));
  const out: MoveSuggestion[] = [];
  let left = overMs;
  for (const t of candidates) {
    if (left <= 0) break;
    const ms = t.estimateMin !== null ? t.estimateMin * 60_000 : UNESTIMATED_MS;
    const fit = open.find((d) => (room.get(d.date) ?? 0) >= ms);
    const to = fit?.date ?? open[0]?.date ?? null;
    if (to !== null) room.set(to, (room.get(to) ?? 0) - ms);
    out.push({ taskId: t.id, ms, estimated: t.estimateMin !== null, to });
    left -= ms;
  }
  return out;
}
