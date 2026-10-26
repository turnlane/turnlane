/**
 * 閉じた待ちの終わりの点（D-075。ux-mvp 4.4・4.5）。D-074 の `↩ 8m` の印を置き換える。
 * - AI レーンで目立たせる待ち線は開いている待ち（待ち中・放置中）だけ。閉じた待ちは薄い線と、終わりに小さな点
 * - 点のホバーは返答（自分の番のタスクの実績。`TimeEntryView.respondsTo` でその待ちに結ぶ）の時刻と所要時間
 *   `replied 13:40 · 3m`。返答のタスクが無い閉じ方（解決・対応不要など）は終わった時刻だけ
 * - どの閉じた待ちにも結び付かない返答（待ちが時間軸の外など）は、返答の時刻に点だけを置く
 * 週ボード（3日ボードの今日の列）とデイビューで共有する純粋関数
 */
import { fmtClock, fmtDuration, type Interval, type TimeEntryView } from "@turnlane/core/web";
import type { MessageKey } from "../i18n/en.ts";
import type { Placement } from "./day-split.ts";

interface WaitLike extends Interval {
  waitKey: string;
  open: boolean;
  /** デイビューだけが持つ（閉じ方） */
  endReason?: string | null;
}

export interface WaitEnd {
  /** 点の id（`<AI 項目>:<waitKey>`。待ちに結び付かない返答は `reply:<task id>`） */
  id: string;
  itemId: string;
  /** null = 待ちに結び付かない返答 */
  waitKey: string | null;
  /** 点を置く時刻（待ちの終点。待ちの無い返答は返答の開始） */
  at: number;
  /** その待ちに答えた返答（無ければ null） */
  reply: Placement | null;
  /** 閉じ方（デイビューの待ちだけ。無ければ null） */
  endReason: string | null;
}

/** 開いている区間を1つでも持つ待ち（waitKey）。目立たせるのはこれだけ */
export function openWaitKeys(waits: readonly WaitLike[]): Set<string> {
  return new Set(waits.filter((w) => w.open).map((w) => w.waitKey));
}

/**
 * 閉じた待ちの終わりと、そこに答えた返答。返答は実績の `respondsTo`（無ければタスクの AI 項目）で AI 項目を決め、
 * 同じ waitKey の閉じた待ちへ、無ければ終点が返答の開始に最も近い閉じた待ちへ結ぶ（1つの待ちに返答は1つ）
 */
export function waitEndsOf(
  items: readonly { id: string; waits: readonly WaitLike[] }[],
  replies: readonly Placement[],
  entries: readonly TimeEntryView[],
): WaitEnd[] {
  const ends: WaitEnd[] = [];
  for (const item of items) {
    const open = openWaitKeys(item.waits);
    const byKey = new Map<string, WaitLike[]>();
    for (const w of item.waits) {
      if (open.has(w.waitKey)) continue;
      const xs = byKey.get(w.waitKey) ?? [];
      xs.push(w);
      byKey.set(w.waitKey, xs);
    }
    for (const [waitKey, segs] of byKey) {
      const last = segs.reduce((a, b) => (b.end > a.end ? b : a));
      ends.push({
        id: `${item.id}:${waitKey}`,
        itemId: item.id,
        waitKey,
        at: last.end,
        reply: null,
        endReason: last.endReason ?? null,
      });
    }
  }
  const out: WaitEnd[] = [...ends];
  const sorted = [...replies].sort((a, b) => a.at.start - b.at.start);
  const pending: { p: Placement; itemId: string | null }[] = [];
  // 1. 実績が指す待ち（同じ waitKey）
  for (const p of sorted) {
    const r = entries.find((e) => e.taskId === p.task.id && e.respondsTo)?.respondsTo ?? null;
    const itemId = r?.workItemId ?? p.task.workItemId;
    const exact =
      r?.waitKey != null
        ? ends.find((x) => x.itemId === itemId && x.waitKey === r.waitKey && x.reply === null)
        : undefined;
    if (exact) exact.reply = p;
    else pending.push({ p, itemId });
  }
  // 2. 残りは、同じ AI 項目の空いている閉じた待ちのうち終点が近いもの。無ければ返答の時刻に点だけ
  for (const { p, itemId } of pending) {
    const near = ends
      .filter((x) => x.itemId === itemId && x.reply === null)
      .sort((a, b) => Math.abs(a.at - p.at.start) - Math.abs(b.at - p.at.start))[0];
    if (near) near.reply = p;
    else if (itemId)
      out.push({
        id: `reply:${p.task.id}`,
        itemId,
        waitKey: null,
        at: p.at.start,
        reply: p,
        endReason: null,
      });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** 点の直径（px） */
export const DOT_PX = 5;
/** 同じ列で点が重なるときに下へずらす間隔 */
export const DOT_GAP_PX = 6;

export interface WaitDot {
  id: string;
  /** 点の上端（下端を待ちの終点に合わせる） */
  top: number;
  column: number;
  columns: number;
  /** 待ちの線の段のずらし（px。デイビューで同じ列に重なる別の待ち。layout.ts の track） */
  dx?: number;
}

/**
 * 点の位置: その AI 項目の列（colOf。無ければ先頭の列）の、待ちの終点の高さ。同じ列で前の点と重なるときは下へずらす。
 * 時間軸の外は置かない
 */
export function layoutWaitDots(
  ends: readonly WaitEnd[],
  axis: Interval,
  pxPerMs: number,
  colOf: (end: WaitEnd) => { column: number; columns: number; dx?: number } | null,
): WaitDot[] {
  const out: WaitDot[] = [];
  const lastTop = new Map<string, number>();
  for (const x of [...ends].sort((a, b) => a.at - b.at)) {
    if (x.at <= axis.start || x.at > axis.end) continue;
    const col = colOf(x) ?? { column: 0, columns: 1 };
    const key = `${col.column}/${col.columns}/${col.dx ?? 0}`;
    const y = (x.at - axis.start) * pxPerMs - DOT_PX;
    const prev = lastTop.get(key);
    const top = Math.max(0, prev === undefined ? y : Math.max(y, prev + DOT_GAP_PX));
    lastTop.set(key, top);
    out.push({ id: x.id, top, ...col });
  }
  return out;
}

/** 閉じ方 → 語（返答は repliedAt。ここに無いものは `ended 13:40`） */
const END_KEY: Record<string, MessageKey> = {
  engaged: "day.end.engaged",
  resolved: "day.end.resolved",
  dismissed: "day.end.dismissed",
  expired: "day.end.expired",
};

/**
 * 点と線のホバーの文: 返答があれば `replied 13:40 · 3m`（返答の開始と所要時間）。無ければ閉じ方と時刻
 * （`resolved 13:40`。閉じ方の分からない週ボードは `ended 13:40`）
 */
export function waitEndText(
  e: WaitEnd,
  t: (key: MessageKey, params?: Record<string, string | number>) => string,
  tz: string,
): string {
  if (e.reply) {
    const { start, end } = e.reply.at;
    return t("board.waitEnd.replied", {
      time: fmtClock(start, tz),
      dur: fmtDuration(end - start),
    });
  }
  const time = fmtClock(e.at, tz);
  if (e.endReason === "human_input") return t("board.waitEnd.repliedAt", { time });
  const k = e.endReason ? END_KEY[e.endReason] : undefined;
  return k ? t("board.waitEnd.reason", { reason: t(k), time }) : t("board.waitEnd.ended", { time });
}
