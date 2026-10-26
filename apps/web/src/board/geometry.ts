/**
 * ボードの寸法（ux-mvp 4.4・4.4.0、確定デザイン week-board-v4、D-074）。純粋関数にしてテストする。
 * - 3日ボード: 列は 3.6 : 12 : 5.4（今日は D-114 の 12 / 21 のまま、前後は 2 : 3）。今日の列は Plan（予定・自分の1レーン）56% / AI 44%（D-117）
 * - 週表示: 昨日・今日・以降の最大7日。平日は同じ幅（今日も AI レーンを持たない）、週末は 0.6 倍。幅が足りなければ未来の日数を減らす
 */
import { addDays } from "@turnlane/core/web";

/** 1時間の高さ（px。確定デザインの3日ボードは 50px。D-114。旧 44px） */
export const HOUR_PX = 50;
export const PX_PER_MS = HOUR_PX / 3_600_000;
/** 時刻の目盛りの幅 */
export const GUTTER_PX = 56;
/** 平日のカラムの最小幅（これを下回るなら未来の日数を減らす） */
export const MIN_DAY_PX = 150;
/** 週表示は最大7日（昨日・今日・以降5日） */
export const MAX_FUTURE_DAYS = 5;
/**
 * 3日ボードの今日の列のレーン（%）: Plan（予定と自分のタスクを1つのレーンに。W5 の入れ子）56% / AI 44%（D-117 で D-075 の
 * 2レーンに戻した。AI が線になったので D-075 の 35 / 65 より AI を狭く）。見出しは「予定 · 自分」と「AI」。
 * 予定 / 自分 / AI の3レーンはデイビューだけ
 */
export const TODAY_LANES = {
  plan: { left: 0, width: 56 },
  ai: { left: 56, width: 44 },
} as const;
/** 3日ボードの今日の列のレーンの見出しの行の高さ（px。夜間の札をこの行に置く。D-117） */
export const LANE_HEAD_PX = 22;
/** デイビューのレーン（%）: 予定 27% / 自分 29% / AI 44%（確定デザインのデイビュー。旧 15 / 25 / 60） */
export const DAY_LANES = {
  events: { left: 0, width: 27 },
  me: { left: 27, width: 29 },
  ai: { left: 56, width: 44 },
} as const;

export function isWeekend(date: string): boolean {
  const dow = new Date(`${date}T12:00:00Z`).getUTCDay();
  return dow === 0 || dow === 6;
}

/** 週表示の列の重み（D-074 で今日の2倍をやめた。今日も AI レーンを持たない） */
export function weightOf(date: string): number {
  return isWeekend(date) ? 0.6 : 1;
}

/** 表示する日付（昨日・今日・以降）。width はカラム全体の幅（目盛りを除く） */
export function visibleDates(anchor: string, width: number): string[] {
  const dates = [addDays(anchor, -1), anchor];
  const weight = (ds: string[]) => ds.reduce((a, d) => a + weightOf(d), 0);
  for (let i = 1; i <= MAX_FUTURE_DAYS; i++) {
    const next = [...dates, addDays(anchor, i)];
    if (weight(next) * MIN_DAY_PX > width) break;
    dates.push(addDays(anchor, i));
  }
  return dates;
}

/** 稼働日の間の休み（土日・祝日）の区切りの幅（確定デザインの3日ボード「土日」） */
export const GAP_PX = 26;

/**
 * CSS grid の列（目盛り + 各日の重み）。3日ボードは 3.6 : 12 : 5.4（前の日 約17% / 基準日 約57% / 次の日 約26%）。
 * 基準日は確定デザインの 5 : 12 : 4（D-114。旧 1 : 2 : 1）の 12 / 21 のまま変えず、前後の2列の合計（9）を前 : 次 = 2 : 3 に
 * 分け直した（次の稼働日の方を広く。2026-10-13 のオーナーの依頼）。gaps の日の前には休みの区切りの細い列を挟む
 */
const THREE_WEIGHTS = [3.6, 12, 5.4] as const;
/** 側の列を畳んだ帯の幅（B-1 (2)） */
export const BAND_PX = 48;

export function gridTemplate(
  dates: string[],
  mode: "three" | "week" = "week",
  gaps: ReadonlySet<string> = new Set(),
  /** 48px の帯に畳んだ列（3日ボードでパネルを開いたとき。B-1 (2)）。今日の列が残りの幅を全部使う */
  bands: ReadonlySet<string> = new Set(),
): string {
  const w = (d: string, i: number) =>
    mode === "three" ? (dates.length === 3 ? (THREE_WEIGHTS[i] ?? 1) : 1) : weightOf(d);
  return `${GUTTER_PX}px ${dates
    .map(
      (d, i) =>
        `${gaps.has(d) ? `${GAP_PX}px ` : ""}${bands.has(d) ? `${BAND_PX}px` : `minmax(0, ${w(d, i)}fr)`}`,
    )
    .join(" ")}`;
}

/** 前の列の日と続いていない日（3日ボードの列の間に休みの区切りを挟む）と、間の日付 */
export function gapsOf(dates: readonly string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (let i = 1; i < dates.length; i++) {
    const prev = dates[i - 1] as string;
    const cur = dates[i] as string;
    const skipped: string[] = [];
    for (let d = addDays(prev, 1); d < cur && skipped.length < 14; d = addDays(d, 1))
      skipped.push(d);
    if (skipped.length > 0) out.set(cur, skipped);
  }
  return out;
}

/** 3日ボードの応答がまだ無いときの仮の列（前日・基準日・翌日） */
export function provisionalThree(anchor: string): string[] {
  return [addDays(anchor, -1), anchor, addDays(anchor, 1)];
}

/** 時刻 → 時間軸の上端からの px */
export function yOf(ms: number, axisStart: number): number {
  return (ms - axisStart) * PX_PER_MS;
}

/** 時刻の目盛りのラベルが上端で切れないよう、時刻の線を上端からこの距離に置く */
export const SCROLL_PAD_PX = 12;

/** y を含む1時間の目盛りが上端から SCROLL_PAD_PX の位置に来るスクロール量 */
export function snapScroll(y: number, hourPx = HOUR_PX): number {
  return Math.max(0, Math.floor((y + SCROLL_PAD_PX) / hourPx) * hourPx - SCROLL_PAD_PX);
}
