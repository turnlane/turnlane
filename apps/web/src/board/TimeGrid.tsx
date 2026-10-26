/**
 * 時間軸の共通部品（M2-13。週ボード・デイビュー・朝の計画 Step 3 で共有）。
 * - 24時間（暦どおり 0:00 が起点。D-054）の縦スクロール、1時間ごとの目盛り
 * - 一様の地と1時間ごとの線（D-105 で勤務時間のパネルをやめた）
 * - 現在線（text-primary 1px と左端の点、目盛りに濃い地の mono の時刻）
 * 配置計算（重なりの列）は core の placeLanes。ここは描画だけを持つ。
 */
import { fmtClock, fmtClock2, type Interval } from "@turnlane/core/web";
import { HOUR_PX, snapScroll } from "./geometry.ts";

/** 時刻 → 上端からの px（1時間の高さは画面ごと。週ボード 44px、デイビュー 60px） */
const yBy = (hourPx: number) => (ms: number, axisStart: number) =>
  ((ms - axisStart) * hourPx) / 3_600_000;

/**
 * 時刻の目盛り（左端の列）。現在時刻のラベルは濃い地に白の mono。計画の目安（strong。D-106）の時刻は text-secondary、
 * それ以外は text-tertiary（地の上で 3:1 以上）
 */
export function Gutter({
  axis,
  tz,
  now,
  showNow,
  strong = [],
  hourPx = HOUR_PX,
}: {
  axis: Interval;
  tz: string;
  now: number;
  showNow: boolean;
  /** ラベルを濃くする時刻の範囲（この axis の上の計画の目安。両端を含む） */
  strong?: Interval[];
  hourPx?: number;
}) {
  const yOf = yBy(hourPx);
  const hours = hourMarks(axis);
  return (
    <div className="dl-ground relative" style={{ height: yOf(axis.end, axis.start) }}>
      {hours.map((h, i) =>
        // 現在時刻の札と重なる目盛りは出さない（確定デザイン: 17:10 の札があれば 17:00 は消える。D-114）
        i === 0 || (showNow && Math.abs(yOf(h, now)) < 14) ? null : (
          <div
            key={h}
            className={`absolute right-1.5 -translate-y-1/2 font-mono text-meta ${
              strongHour(h, strong) ? "text-fg2" : "text-fg3"
            }`}
            data-strong={strongHour(h, strong) ? "" : undefined}
            style={{ top: yOf(h, axis.start) }}
          >
            {fmtClock(h, tz)}
          </div>
        ),
      )}
      {showNow && now > axis.start && now < axis.end ? (
        <div
          className="absolute right-1 z-10 -translate-y-1/2 rounded-control bg-fg px-1 font-mono font-semibold text-bg text-meta"
          style={{ top: yOf(now, axis.start) }}
        >
          {fmtClock2(now, tz)}
        </div>
      ) : null}
    </div>
  );
}

/** 目盛りの時刻が計画の目安に入るか（終わりの時刻も含める: 10:00〜19:00 なら 10:00 と 19:00 を濃く） */
export function strongHour(t: number, strong: Interval[]): boolean {
  return strong.some((w) => t >= w.start && t <= w.end);
}

/**
 * 週表示・3日ボードの目盛りの濃さの範囲: 表示中の列の計画の目安を、目盛りの axis の上の時刻に写して並べる
 * （列ごとに日付が違うので、その日の 0:00 からの経過で合わせる）
 */
export function strongRanges(
  axis: Interval,
  cols: { axis: Interval; plannedHours: Interval | null }[],
): Interval[] {
  return cols.flatMap((c) =>
    c.plannedHours
      ? [
          {
            start: axis.start + (c.plannedHours.start - c.axis.start),
            end: axis.start + (c.plannedHours.end - c.axis.start),
          },
        ]
      : [],
  );
}

/** 1時間ごとの時刻（axis.start から。DST の日は 23 / 25 本） */
export function hourMarks(axis: Interval): number[] {
  const out: number[] = [];
  for (let t = axis.start; t < axis.end; t += 3_600_000) out.push(t);
  return out;
}

/**
 * 時間軸の背景: 一様の地と1時間ごとの薄い線（D-105。勤務時間を浮かせるパネルと時間外の沈めた地はやめた）
 */
export function GridBackground({ axis, hourPx = HOUR_PX }: { axis: Interval; hourPx?: number }) {
  const yOf = yBy(hourPx);
  const lines = hourMarks(axis)
    .slice(1)
    .map((t) => yOf(t, axis.start));
  return (
    <>
      <div className="dl-ground pointer-events-none absolute inset-0" />
      {lines.map((y) => (
        <div
          key={y}
          className="dl-grid pointer-events-none absolute inset-x-0 h-px"
          style={{ top: y }}
        />
      ))}
    </>
  );
}

/**
 * レーンの間の細い区切りの縦線（D-117。D-114 でやめたものを戻した）。色は1時間ごとの線と同じ罫線（.dl-grid）で控えめに。
 * 3日ボードの今日の列は 予定・自分 と AI の間、デイビューは3レーンの間
 */
export function LaneDivider({ left }: { left: number }) {
  return (
    <div
      className="dl-grid pointer-events-none absolute inset-y-0 z-[1] w-px"
      style={{ left: `${left}%` }}
      data-lane-divider={left}
    />
  );
}

/** 現在線（確定デザイン: text-primary 1px と左端の 6px の点。紫はやめた。D-104） */
export function NowLine({
  axis,
  now,
  hourPx = HOUR_PX,
}: {
  axis: Interval;
  now: number;
  hourPx?: number;
}) {
  const yOf = yBy(hourPx);
  if (now <= axis.start || now >= axis.end) return null;
  return (
    <div
      className="pointer-events-none absolute inset-x-0 z-20 h-px bg-fg"
      style={{ top: yOf(now, axis.start) }}
      data-testid="now-line"
    >
      <span className="absolute -top-[2.5px] -left-[3px] size-1.5 rounded-full bg-fg" />
    </div>
  );
}

/**
 * 開いたときのスクロール位置: 始まり（計画の目安の開始など）を含む時刻の目盛りが上端付近。目盛りのラベル（線の上下に半分ずつ）が
 * 上端で切れないよう、時刻の線が上端から SCROLL_PAD_PX 下に来る位置にそろえる
 */
export function initialScroll(axis: Interval, start: number, hourPx = HOUR_PX): number {
  return snapScroll(yBy(hourPx)(start, axis.start), hourPx);
}

/**
 * 開いたときに上端に出す時刻: 計画の目安の開始と、それより前に始まったその日の予定・時間ブロック・実績（6:00 以降）の早い方
 * （確定デザインは朝の最初の項目から見せる。D-114）。計画の目安が無ければ fallback
 */
export function scrollStartOf(
  day: {
    axis: Interval;
    plannedHours: Interval | null;
    events: { start: number }[];
    timeBlocks: { start: number }[];
    timeEntries: { start: number }[];
  },
  fallback: number,
): number {
  const plan = day.plannedHours?.start ?? fallback;
  const floor = day.axis.start + 6 * 3_600_000;
  const early = [...day.events, ...day.timeBlocks, ...day.timeEntries]
    .map((x) => x.start)
    .filter((t) => t >= floor && t < plan);
  return Math.min(plan, ...early);
}
