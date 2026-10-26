/**
 * 週ボードの仕上げ（M2-16。ux-mvp 4.4）:
 * - 範囲外のヒント: 今日の AI レーンで、スクロールで見えない上・下に AI のブロックがあるとき、見えている範囲の上端・下端に
 *   固定して件数を出す（`↑ 上に 1 件`。B-9）。押すとそのブロックが見える位置へスクロールする
 * - ホバーの接続線: AI のブロック・YOUR TURN の行・自分の応答ブロックにホバーすると、その AI 項目の
 *   (1) 開いている待ちの終点と YOUR TURN の行、(2) 閉じた待ちの終点と自分の応答ブロックを 1px の点線でつなぐ
 * 位置は DOM の矩形から測る（帯はスクロールの外、時間軸はスクロールの中なので、画面の座標で線を引く）
 */
import type { DayColumn, Interval } from "@turnlane/core/web";
import { type RefObject, useEffect, useLayoutEffect, useState } from "react";
import { useI18n } from "../i18n/index.tsx";
import { blocksOf } from "./AiLane.tsx";
import { LANE_HEAD_PX, PX_PER_MS, TODAY_LANES } from "./geometry.ts";

const MIN_PX = 20;

export interface OffscreenSide {
  count: number;
  /** スクロール先（最も近いブロックの上端の px） */
  targetY: number;
}

/**
 * 見えている範囲 [top, bottom)（px。時間軸の上端から）の外にある AI のブロックを数える。
 * ブロックは最小 20px の高さで描くので、その高さで見えているかを決める
 */
export function offscreenAi(
  blocks: readonly Interval[],
  axisStart: number,
  view: { top: number; bottom: number },
): { above: OffscreenSide | null; below: OffscreenSide | null } {
  const above: Interval[] = [];
  const below: Interval[] = [];
  const y = (ms: number) => (ms - axisStart) * PX_PER_MS;
  for (const b of blocks) {
    const top = y(b.start);
    const bottom = Math.max(top + MIN_PX, y(b.end));
    if (bottom <= view.top) above.push(b);
    else if (top >= view.bottom) below.push(b);
  }
  const side = (xs: Interval[], near: (a: Interval, b: Interval) => Interval) =>
    xs.length === 0 ? null : { count: xs.length, targetY: y(xs.reduce(near).start) };
  return {
    above: side(above, (a, b) => (a.end >= b.end ? a : b)),
    below: side(below, (a, b) => (a.start <= b.start ? a : b)),
  };
}

/** 今日の AI レーンの上端・下端に固定するヒント */
export function OffscreenHint({
  day,
  now,
  scroller,
  frame,
}: {
  day: DayColumn | undefined;
  now: number;
  scroller: RefObject<HTMLDivElement | null>;
  /** ヒントを置く枠（scroller を包む relative な要素） */
  frame: RefObject<HTMLDivElement | null>;
}) {
  const { t } = useI18n();
  const [, setTick] = useState(0);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const on = () => setTick((x) => x + 1);
    el.addEventListener("scroll", on, { passive: true });
    const ro = new ResizeObserver(on);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", on);
      ro.disconnect();
    };
  }, [scroller]);
  const el = scroller.current;
  const box = frame.current;
  if (day?.phase !== "today" || !el || !box) return null;
  const col = el.querySelector<HTMLElement>(`[data-day="${day.date}"]`);
  if (!col) return null;
  const blocks = blocksOf(day, now)
    .filter((b) => !b.carried)
    .map((b) => b.at);
  const view = { top: el.scrollTop, bottom: el.scrollTop + el.clientHeight };
  const r = offscreenAi(blocks, day.axis.start, view);
  const c = col.getBoundingClientRect();
  const f = box.getBoundingClientRect();
  const s = el.getBoundingClientRect();
  // AI レーンの左端と右端（3日ボードの今日の列の 56%〜。D-117）
  const left = c.left - f.left + (c.width * TODAY_LANES.ai.left) / 100;
  const right = f.right - c.right + 8;
  // 文は「AI の実行」とも「夜間」とも言わない（AI レーンの見出しの行の中にあるので AI だと分かる。B-9・R34）
  const label = (side: OffscreenSide, dir: "up" | "down") =>
    t(dir === "up" ? "board.offscreen.up" : "board.offscreen.down", { count: side.count });
  const go = (side: OffscreenSide) => {
    el.scrollTop = Math.max(0, side.targetY - el.clientHeight / 3);
  };
  // 上の札はレーンの見出しの行（「AI」の右）に置く。時間軸の上に置くと AI の線・待ちの線・ラベルに重なる（D-117）。
  // 下の札は時間軸の下端の右寄せ（線はレーンの左に詰めるので、右は空いている）。文字は sans（件数は等幅にしない。R21）
  return (
    <>
      {r.above ? (
        <button
          type="button"
          tabIndex={-1}
          className="absolute z-30 flex h-[18px] items-center whitespace-nowrap px-1 text-fg2 text-micro hover:text-fg hover:underline"
          style={{ left: left + 28, top: s.top - f.top - LANE_HEAD_PX + 2 }}
          data-testid="offscreen-up"
          onClick={() => r.above && go(r.above)}
        >
          {label(r.above, "up")}
        </button>
      ) : null}
      {r.below ? (
        <button
          type="button"
          tabIndex={-1}
          className="absolute z-30 whitespace-nowrap rounded-chip border border-line bg-raised px-1.5 text-fg2 text-meta shadow-pop hover:text-fg"
          style={{ right, bottom: f.bottom - s.bottom + 4 }}
          data-testid="offscreen-down"
          onClick={() => r.below && go(r.below)}
        >
          {label(r.below, "down")}
        </button>
      ) : null}
    </>
  );
}

interface Line {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** ホバーした要素 → その AI 項目（応答ブロックは respondsTo から） */
export function hoverWorkItem(target: Element | null, days: readonly DayColumn[]): string | null {
  const el = target?.closest<HTMLElement>(
    '[data-kind="ai"][data-id],[data-kind="turn"][data-id],[data-kind="task"][data-id]',
  );
  if (!el) return null;
  const id = el.dataset.id ?? null;
  if (el.dataset.kind !== "task") return id;
  for (const d of days)
    for (const e of d.timeEntries)
      if (e.taskId === id && e.respondsTo) return e.respondsTo.workItemId;
  return null;
}

/** ホバー中の AI 項目について、待ちの終点と帯の行・応答ブロックをつなぐ点線 */
export function HoverLinks({
  workItemId,
  day,
  scroller,
}: {
  workItemId: string | null;
  day: DayColumn | undefined;
  scroller: RefObject<HTMLDivElement | null>;
}) {
  const [lines, setLines] = useState<Line[]>([]);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!workItemId || !day || !el) {
      setLines([]);
      return;
    }
    const measure = () => {
      const view = el.getBoundingClientRect();
      const inView = (y: number) => y >= view.top && y <= view.bottom;
      const out: Line[] = [];
      const waits = [
        ...el.querySelectorAll<HTMLElement>(`[data-wait-item="${CSS.escape(workItemId)}"]`),
      ];
      // (1) 開いている待ちの終点 → YOUR TURN の行
      const open = waits
        .filter((w) => w.dataset.waitOpen === "1")
        .map((w) => w.getBoundingClientRect())
        .sort((a, b) => b.bottom - a.bottom)[0];
      const row = document.querySelector<HTMLElement>(
        `[data-kind="turn"][data-id="${CSS.escape(workItemId)}"]`,
      );
      if (open && row && inView(open.bottom)) {
        const r = row.getBoundingClientRect();
        out.push({ x1: open.left, y1: open.bottom, x2: r.right, y2: r.top + r.height / 2 });
      }
      // (2) 閉じた待ちの終点 → 自分の応答ブロック
      for (const e of day.timeEntries) {
        if (e.respondsTo?.workItemId !== workItemId) continue;
        const block = el.querySelector<HTMLElement>(
          `[data-kind="task"][data-id="${CSS.escape(e.taskId)}"]`,
        );
        const seg = waits
          .filter((w) => !e.respondsTo?.waitKey || w.dataset.waitKey === e.respondsTo.waitKey)
          .map((w) => w.getBoundingClientRect())
          .sort((a, b) => b.bottom - a.bottom)[0];
        if (!block || !seg) continue;
        const b = block.getBoundingClientRect();
        if (!inView(seg.bottom) || !inView(b.top)) continue;
        out.push({
          x1: seg.left,
          y1: seg.bottom,
          x2: b.right,
          y2: b.top + Math.min(10, b.height / 2),
        });
      }
      setLines(out);
    };
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    return () => el.removeEventListener("scroll", measure);
  }, [workItemId, day, scroller]);
  if (lines.length === 0) return null;
  return (
    <svg
      className="pointer-events-none fixed inset-0 z-40 h-full w-full"
      aria-hidden="true"
      data-testid="hover-links"
    >
      {lines.map((l) => (
        <g key={`${l.x1}-${l.y1}-${l.x2}-${l.y2}`}>
          <line
            x1={l.x1}
            y1={l.y1}
            x2={l.x2}
            y2={l.y2}
            stroke="var(--dl-text-2)"
            strokeWidth={1}
            strokeDasharray="2 3"
          />
          <circle cx={l.x1} cy={l.y1} r={2} fill="var(--dl-text-2)" />
          <circle cx={l.x2} cy={l.y2} r={2} fill="var(--dl-text-2)" />
        </g>
      ))}
    </svg>
  );
}
