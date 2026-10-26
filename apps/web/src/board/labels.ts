/**
 * 待ちの線のラベル（`放置 5h20m` など）の置き場所（3日ボードの AI レーンとデイビューで共通。純粋関数）。
 * - ラベルは他のラベル・AI のブロック（の題名）と重ねない
 * - 望む位置（線の中ほどなど）が塞がっていれば下へずらし、線の範囲の下端まで空きが無ければ上へ探す
 * - それでも置けないラベルは省く（null。ホバーに任せる）。長い区間のラベルから順に場所を取るので、省くのは短い区間の方
 */

/** 列の中の横の位置（column / columns） */
export interface LabelSlot {
  column: number;
  columns: number;
}

export interface LabelBox extends LabelSlot {
  top: number;
  height: number;
}

export interface LabelRequest extends LabelSlot {
  id: string;
  /** 望む上端（px） */
  want: number;
  /** 置いてよい上端の範囲（線の上端〜下端 - ラベルの高さ） */
  lo: number;
  hi: number;
  /** 大きいほど先に場所を取る（区間の長さ） */
  weight: number;
}

/** ラベルの高さ（px。text-meta の1行） */
export const LABEL_PX = 16;
const STEP_PX = 2;

/** 列の横の範囲（0〜1）が重なるか */
export function colsOverlap(a: LabelSlot, b: LabelSlot): boolean {
  return (
    a.column / a.columns < (b.column + 1) / b.columns &&
    b.column / b.columns < (a.column + 1) / a.columns
  );
}

/**
 * ラベルを置く。obstacles は動かないもの（AI のブロック、位置の決まった別のラベル）。
 * 戻り値は id → 上端（置けなければ null）
 */
export function placeLabels(
  requests: readonly LabelRequest[],
  obstacles: readonly LabelBox[],
  labelPx = LABEL_PX,
): Map<string, number | null> {
  const taken: LabelBox[] = [...obstacles];
  const out = new Map<string, number | null>();
  const order = [...requests].sort((a, b) => b.weight - a.weight || a.want - b.want);
  for (const r of order) {
    const free = (y: number) =>
      !taken.some((o) => colsOverlap(o, r) && o.top < y + labelPx && y < o.top + o.height);
    const lo = r.lo;
    const hi = Math.max(r.lo, r.hi);
    const want = Math.min(Math.max(r.want, lo), hi);
    let y: number | null = null;
    for (let c = want; c <= hi; c += STEP_PX)
      if (free(c)) {
        y = c;
        break;
      }
    if (y === null)
      for (let c = want - STEP_PX; c >= lo; c -= STEP_PX)
        if (free(c)) {
          y = c;
          break;
        }
    out.set(r.id, y);
    if (y !== null) taken.push({ top: y, height: labelPx, column: r.column, columns: r.columns });
  }
  return out;
}
