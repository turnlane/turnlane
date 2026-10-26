/**
 * 閉じた待ちの終わりの点（D-075。ux-mvp 4.4・4.5）: 5px の点。ホバーで `replied 13:40 · 3m`、クリックで返答のタスクの
 * パネル（返答の無い閉じ方は AI 詳細パネル）。D-074 の `↩ 8m` の印を置き換える。3日ボードの今日の列とデイビューで共有する。
 * 点はふだん描かない（線の端の点は確定画像に無く、短い線が読みにくくなる。D-117）。当たりは残し、ホバーと選択中だけ点を出す
 */
import type { Interval } from "@turnlane/core/web";
import { useI18n } from "../i18n/index.tsx";
import { DOT_PX, layoutWaitDots, type WaitEnd, waitEndText } from "./wait-ends.ts";

/** 点の当たり（見た目の点より広く取る） */
const HIT_PX = 13;

export function WaitDots({
  ends,
  axis,
  pxPerMs,
  colOf,
  x = 9,
  tz,
  isSel,
  onPick,
}: {
  ends: readonly WaitEnd[];
  axis: Interval;
  pxPerMs: number;
  /** 点を置く列（待ち線の列。無ければ先頭の列） */
  colOf: (end: WaitEnd) => { column: number; columns: number; dx?: number } | null;
  /** 列の左端から線までの px（点の中心を線に合わせる） */
  x?: number;
  tz: string;
  isSel: (k: string) => boolean;
  /** `task:<id>`（返答）か `ai:<id>`（返答の無い閉じ方） */
  onPick: (k: string) => void;
}) {
  const { t } = useI18n();
  const dots = layoutWaitDots(ends, axis, pxPerMs, colOf);
  return (
    <>
      {dots.map((d) => {
        const e = ends.find((x) => x.id === d.id);
        if (!e) return null;
        const key = e.reply ? `task:${e.reply.task.id}` : `ai:${e.itemId}`;
        const selected = e.reply ? isSel(key) : false;
        return (
          <button
            key={d.id}
            type="button"
            tabIndex={-1}
            data-kind="wait-end"
            data-dot={selected ? "shown" : "hover"}
            data-id={e.reply?.task.id ?? e.itemId}
            data-wait-end={e.id}
            title={waitEndText(e, t, tz)}
            onClick={() => onPick(key)}
            className="group absolute z-20 flex items-end justify-center"
            style={{
              top: d.top + DOT_PX - HIT_PX + (HIT_PX - DOT_PX) / 2,
              height: HIT_PX,
              width: HIT_PX,
              left: `calc(${(d.column / d.columns) * 100}% + ${x + (d.dx ?? 0) + 0.5 - HIT_PX / 2}px)`,
            }}
          >
            <span
              className={`mb-[4px] block rounded-full ${
                selected ? "bg-accent" : "bg-transparent group-hover:bg-fg2"
              }`}
              style={{ width: DOT_PX, height: DOT_PX }}
            />
          </button>
        );
      })}
    </>
  );
}
