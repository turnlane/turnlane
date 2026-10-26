/**
 * 3日ボードの今日の列の上部（自分の番の帯・未定）に出す件数（B-2。D-193）。上部は中でスクロールせず中身の高さどおりに出し、
 * 時間軸には最小 TIMELINE_MIN_PX を残す。足りなければ未定を 3 → 2 → 1 に減らし（1 件は必ず見せる）、それでも足りなければ
 * 自分の番の帯を 3 → 2 → 1 に減らす。減らした分は「ほか N 件 ▸」に入る。純粋関数（高さは行の目安で見積もる）
 */

/** 自分の番の帯は上位 3 件（3日ボード） */
export const BAND_MAX = 3;
/** 未定は先頭 3 件 */
export const UNSCHEDULED_MAX = 3;
/** 時間軸に残す最小の高さ（約 5 時間ぶん） */
export const TIMELINE_MIN_PX = 240;
/** 上部より上にあるもの（列の見出し・レーンの見出し）の目安 */
const HEAD_PX = 120;
/**
 * 自分の番の行 1 件（帯の見出しを含めた目安）。行の幅が 560px 未満では件名と理由の 2 行（44px。D-207、spec-glance §3.2）に
 * なるので、2 行の高さで見積もる
 */
const BAND_ROW_PX = 48;
const BAND_HEAD_PX = 28;
/** 未定のカード 1 件と見出し・「＋ 追加」の目安 */
const CARD_PX = 36;
const UNSCHEDULED_HEAD_PX = 56;

export interface TopLimits {
  band: number;
  unscheduled: number;
}

function heightOf(band: number, unscheduled: number): number {
  return (
    (band > 0 ? BAND_HEAD_PX + band * BAND_ROW_PX : 0) + UNSCHEDULED_HEAD_PX + unscheduled * CARD_PX
  );
}

/**
 * boardHeight（列全体の高さ。px）に対して出せる件数。counts はその列にある件数（帯・未定の最大）
 */
export function topLimits(
  boardHeight: number,
  counts: { band: number; unscheduled: number },
): TopLimits {
  let band = Math.min(BAND_MAX, counts.band);
  let unscheduled = Math.min(UNSCHEDULED_MAX, counts.unscheduled);
  const budget = boardHeight - HEAD_PX - TIMELINE_MIN_PX;
  const fits = () => heightOf(band, unscheduled) <= budget;
  while (!fits() && unscheduled > 1) unscheduled--;
  while (!fits() && band > 1) band--;
  return { band, unscheduled };
}

const OPEN_KEY = "turnlane.board.unscheduledOpen";

/** 日付ごとの開閉（その日のあいだブラウザに覚える。sessionStorage。覚えられなければ空） */
export function readOpenDays(key: string): Record<string, boolean> {
  try {
    const raw = globalThis.sessionStorage?.getItem(key);
    const v = raw ? (JSON.parse(raw) as unknown) : null;
    return v && typeof v === "object" ? (v as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

export function writeOpenDays(key: string, v: Record<string, boolean>): void {
  try {
    globalThis.sessionStorage?.setItem(key, JSON.stringify(v));
  } catch {
    // 覚えられなくても開閉はできる
  }
}

/** 「ほか N 件 ▸」で開いた日（その日のあいだブラウザに覚える。日付ごと） */
export function readUnscheduledOpen(): Record<string, boolean> {
  return readOpenDays(OPEN_KEY);
}

export function writeUnscheduledOpen(v: Record<string, boolean>): void {
  writeOpenDays(OPEN_KEY, v);
}
