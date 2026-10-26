/**
 * 週ボードの今日の AI レーンの配置（docs/design/README.md の W7、D-061、ux-mvp 4.4）。純粋関数。
 * 1. spansOf: 同じ AI 項目のターンを「ひと続きの作業」にまとめる。前のターンの終わりから次のターンの始まりまでが
 *    gapMs（30分）未満ならつなぐ。AI 時間はターンの長さの和（ブロックの壁時計の長さではない）
 * 2. layoutAiLane: まとめても短い（5分未満の）完了ブロックが、最小高さのせいで互いに重なって並ぶとき
 *    （前のブロックの表示上の下端から gapPx 未満で続くもの。AI 項目をまたいでよい）は、2件以上を1つのまとめ
 *    （`✓ 5 runs · 3m`）にする（W4 と同じ規則）。残りと一緒に列に分け、maxColumns を超えた分は overflow
 * サーバーの応答はターンごとのまま（デイビューと詳細パネルはターンごとに描く）。
 */
import { type Box, boxOf, columnize, type Overflow } from "./lanes.ts";

/** 同じ AI 項目のターンをつなぐ間隔の上限（これ未満ならひと続き） */
export const AI_SPAN_GAP_MS = 30 * 60_000;
/** これ未満の完了ブロックは、重なって並ぶときにまとめ表示へ入れる */
export const AI_SHORT_SPAN_MS = 5 * 60_000;

export interface AiRunLike {
  turnId: string;
  start: number;
  end: number;
  /** 稼働中（AI 時間は now まで数える） */
  open: boolean;
}

export interface AiSpan {
  /** 最初のターンの id */
  id: string;
  turnIds: string[];
  start: number;
  end: number;
  /** 最後のターンが稼働中 */
  open: boolean;
  /** ターンの長さの和（稼働中のターンは now まで） */
  aiMs: number;
}

export function spansOf(runs: readonly AiRunLike[], o: { gapMs?: number; now: number }): AiSpan[] {
  const gap = o.gapMs ?? AI_SPAN_GAP_MS;
  const xs = [...runs].sort((a, b) => a.start - b.start || a.turnId.localeCompare(b.turnId));
  const out: AiSpan[] = [];
  for (const r of xs) {
    const ms = Math.max(0, (r.open ? Math.max(r.end, o.now) : r.end) - r.start);
    const cur = out.at(-1);
    if (cur && r.start - cur.end < gap) {
      cur.turnIds.push(r.turnId);
      cur.end = Math.max(cur.end, r.end);
      cur.open = r.open;
      cur.aiMs += ms;
      continue;
    }
    out.push({
      id: r.turnId,
      turnIds: [r.turnId],
      start: r.start,
      end: r.end,
      open: r.open,
      aiMs: ms,
    });
  }
  return out;
}

export interface AiLaneBlockInput {
  id: string;
  start: number;
  end: number;
  /** 最小の高さ（px。週ボードは 20） */
  minPx: number;
  /** 短い完了ブロック（まとめ表示に入れてよい） */
  collapsible: boolean;
  /** AI 時間（まとめ表示の和に使う） */
  aiMs: number;
}

export interface AiLaneOptions {
  axisStart: number;
  pxPerMs: number;
  /** 並列の上限（3） */
  maxColumns: number;
  /** まとめ表示の最小高さ（px） */
  minPx: number;
  /** 短い完了ブロックの間がこれ未満なら続きとみなす（px） */
  gapPx: number;
}

interface Slot {
  top: number;
  height: number;
  column: number;
  columns: number;
}

export type AiLaneBox =
  | ({ kind: "block"; id: string } & Slot)
  | ({
      kind: "summary";
      /** `summary:<先頭の id>` */
      id: string;
      /** まとめたブロック（開始順） */
      ids: string[];
      start: number;
      end: number;
      /** AI 時間の和 */
      aiMs: number;
    } & Slot);

export function layoutAiLane(
  blocks: readonly AiLaneBlockInput[],
  o: AiLaneOptions,
): { placed: AiLaneBox[]; overflow: Overflow[] } {
  const box = (b: AiLaneBlockInput) => boxOf(b, o.axisStart, o.pxPerMs);
  const boxes: Box[] = [];
  const summaries = new Map<string, Omit<Extract<AiLaneBox, { kind: "summary" }>, keyof Slot>>();

  for (const b of blocks) if (!b.collapsible) boxes.push(box(b));

  // 短い完了ブロックの連なり（表示上の下端から gapPx 未満で続くもの）。2件以上ならまとめる
  const short = blocks.filter((b) => b.collapsible).sort((a, b) => a.start - b.start);
  let run: AiLaneBlockInput[] = [];
  let runBottom = Number.NEGATIVE_INFINITY;
  const flush = () => {
    const first = run[0];
    if (run.length === 1 && first) boxes.push(box(first));
    else if (first) {
      const id = `summary:${first.id}`;
      const top = box(first).top;
      const end = Math.max(...run.map((x) => x.end));
      boxes.push({ id, top, bottom: Math.max(top + o.minPx, (end - o.axisStart) * o.pxPerMs) });
      summaries.set(id, {
        kind: "summary",
        id,
        ids: run.map((x) => x.id),
        start: first.start,
        end,
        aiMs: run.reduce((a, x) => a + x.aiMs, 0),
      });
    }
    run = [];
    runBottom = Number.NEGATIVE_INFINITY;
  };
  for (const b of short) {
    const x = box(b);
    if (run.length > 0 && x.top >= runBottom + o.gapPx) flush();
    run.push(b);
    runBottom = Math.max(runBottom, x.bottom);
  }
  flush();

  const { placed, overflow } = columnize(boxes, o.maxColumns);
  return {
    placed: placed.map((p) => {
      const slot = { top: p.top, height: p.height, column: p.column, columns: p.columns };
      const s = summaries.get(p.id);
      return s ? { ...s, ...slot } : { kind: "block", id: p.id, ...slot };
    }),
    overflow,
  };
}
