/**
 * 拡張の時間軸の印（ADR 0015 の timelineMarks）を AI レーンに描く。3日ボード（board/AiLane.tsx）とデイビュー
 * （day/DayView.tsx）で共通。公開のビルドでは印が無く、何も描かない。
 *
 * 見た目: 6px の中を塗らない実線の枠（待ちの線は点線なので形で分ける）と時計のアイコン。右に題名と時刻（mono）、
 * 2行目に detail。列は、その高さで動いている AI の線より右（線に重ねない）
 */
import { fmtClock } from "@turnlane/core/web";
import { Clock } from "lucide-react";
import { openPanelFor } from "../actions/item-actions.tsx";
import { Nums } from "../components/Nums.tsx";
import { ext } from "./registry.ts";
import type { TimelineMark, TimelineRange } from "./types.ts";

/** 枠の幅（6px。3px では完了した AI の灰の線と見分けられない）と線の最小の長さ・ラベルの高さ（AI の線のラベルと同じ） */
export const MARK_BAR_W = 6;
export const MARK_MIN_PX = 28;
export const MARK_LABEL_H = 34;

export type PlacedMark = TimelineMark & { ext: string };

/** 組み込んだ拡張の印（列ごとに呼ぶ。拡張の一覧はビルドのときに決まるので、フックを呼ぶ回数は一定） */
export function useTimelineMarks(range: TimelineRange): PlacedMark[] {
  const out: PlacedMark[] = [];
  for (const m of ext.timelineMarks) {
    // フックの呼び出し: 拡張の一覧はビルドのときに決まり、呼ぶ回数は変わらない
    for (const x of m.use(range))
      if (x.at < range.to && (x.end ?? x.at) >= range.from)
        out.push({ ...x, id: `${m.ext}:${x.id}`, ext: m.ext });
  }
  return out.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
}

export function TimelineMarks({
  marks,
  axisStart,
  pxPerMs,
  tz,
  barX,
  busyColumn,
}: {
  marks: readonly PlacedMark[];
  axisStart: number;
  pxPerMs: number;
  tz: string;
  /** 列 → 線の x（AI レーンの左から px） */
  barX: (column: number) => number;
  /** その高さの範囲で使っている AI の線（ラベルの高さを含む）の一番右の列（無ければ -1） */
  busyColumn: (top: number, bottom: number) => number;
}) {
  if (marks.length === 0) return null;
  return (
    <>
      {marks.map((m) => {
        const top = Math.max(0, (m.at - axisStart) * pxPerMs);
        const barH = Math.max(MARK_MIN_PX, ((m.end ?? m.at) - m.at) * pxPerMs);
        const column = busyColumn(top, top + Math.max(barH, MARK_LABEL_H)) + 1;
        const time = fmtClock(m.at, tz);
        const hint = [`${m.title} ${time}`, m.detail].filter(Boolean).join("\n");
        return (
          <button
            key={m.id}
            type="button"
            tabIndex={-1}
            data-kind="planned"
            data-mark={m.id}
            title={hint}
            onClick={m.taskId ? () => openPanelFor(`task:${m.taskId}`) : undefined}
            className={`absolute flex items-start text-left ${m.taskId ? "cursor-pointer" : "cursor-default"}`}
            // AI の線・ラベルより上（重なったときも押せる）
            style={{
              top,
              left: barX(column),
              right: 4,
              height: Math.max(barH, MARK_LABEL_H),
              zIndex: 2,
            }}
          >
            <span
              className="shrink-0 rounded-[3px] border-[1.5px] border-fg2 border-solid bg-transparent"
              style={{ width: MARK_BAR_W, height: barH }}
              data-bar="planned"
            />
            <span
              className="ml-1.5 flex min-w-0 flex-1 flex-col self-start rounded-control bg-lane pr-1 text-meta leading-4"
              data-label="planned"
            >
              <span className="flex min-w-0 items-center gap-1 font-medium text-fg">
                <Clock size={14} strokeWidth={1.75} className="shrink-0 text-fg2" aria-hidden />
                <span className="min-w-0 truncate text-[12.5px]">{m.title}</span>
                <span className="shrink-0 font-mono text-[12px]">{time}</span>
              </span>
              {m.detail ? (
                <span className="min-w-0 truncate pl-[18px] text-fg2">
                  <Nums text={m.detail} />
                </span>
              ) : null}
            </span>
          </button>
        );
      })}
    </>
  );
}
