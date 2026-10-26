/**
 * AI 稼働リボン（D-074。ux-mvp 4.4.0、m2-api 20章）。純粋関数にしてテストする。自分の番への対応の印（`↩`）は D-075 で
 * 閉じた待ちの点（wait-ends.ts）に置き換えた
 */
import type { DayColumn, Interval } from "@turnlane/core/web";

/** 区間の和集合（開始順） */
function union(xs: Interval[]): Interval[] {
  const s = xs.filter((x) => x.end > x.start).sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const x of s) {
    const p = out.at(-1);
    if (p && x.start <= p.end) p.end = Math.max(p.end, x.end);
    else out.push({ ...x });
  }
  return out;
}

/**
 * 列の右端の稼働リボン。過去日はデーモンの `aiRibbon`、今日は AI レーンの実行（稼働中は now まで）の和集合。
 * 未来は空
 */
export function ribbonOf(
  day: Pick<DayColumn, "phase" | "aiRibbon" | "aiLane">,
  now: number,
): Interval[] {
  if (day.aiRibbon.length > 0) return day.aiRibbon;
  if (day.phase !== "today" || !day.aiLane) return [];
  return union(
    day.aiLane.flatMap((x) =>
      x.runs.map((r) => ({ start: r.start, end: r.open ? Math.max(r.end, now) : r.end })),
    ),
  );
}
