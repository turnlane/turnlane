/**
 * AI レーンの文字のラベルの置き場所（デイビューと 3日ボードの今日の列で共通。純粋関数）。
 * 線の右に置くラベル（題名・待ち・在席の札）は右端まで伸びるので、横の列によらず上下に重なれば重なりとして扱う。
 *
 * 優先の順（先のものが場所を取り、後のものがずれる・省かれる）:
 * 1. 題名のラベル（2 行目の待ちの札 `許可待ち 1h10m` を含む）。重なるものは先のラベルの `+N`（D-190 の規則。呼び出し側）
 * 2. 在席・状態の札（会議中・離席 · 数えない・猶予・放置・タスクなし）。望む位置が塞がっていれば線の範囲で下へずらし、
 *    無ければ上へ探す。置けなければ省いて線のホバーに任せる（長い区間の札から場所を取る）
 *
 * どのラベルも今の線（now）に重ねない。重なる位置のラベルは今の線の下へずらす
 */

/** 今の線の上下に空ける幅（px） */
export const NOW_GAP_PX = 3;
/** ずらすときの刻み（px） */
const STEP_PX = 2;
/** 札どうし・題名との間（px） */
const PAD_PX = 1;

export interface Box {
  top: number;
  height: number;
}

/** 今の線（y）に重なるラベルを線の下へずらした上端（重ならなければそのまま） */
export function belowNow(top: number, height: number, nowY: number | null): number {
  if (nowY === null) return top;
  return top < nowY + NOW_GAP_PX && nowY - NOW_GAP_PX < top + height ? nowY + NOW_GAP_PX : top;
}

/** 札の置き場所を探すときの縦の線（AI の線・待ちの線）。札の左端はその高さで動いている線の右へ寄せる */
export interface Rail {
  x: number;
  top: number;
  bottom: number;
}

export interface TagRequest {
  id: string;
  /** 望む上端（px） */
  want: number;
  /** 置いてよい上端の範囲（線の範囲） */
  lo: number;
  hi: number;
  /** 大きいほど先に場所を取る（区間の長さ） */
  weight: number;
  /** 札の左端の下限（自分の線の右。px） */
  minLeft: number;
  /** 置く場所（lane: 線の右、left: 一番左の線の左。場所が違えば重ならない） */
  region?: "lane" | "left";
}

export interface TagPlace {
  top: number;
  left: number;
}

const hits = (a: Box, b: Box) =>
  a.top < b.top + b.height + PAD_PX && b.top < a.top + a.height + PAD_PX;

/**
 * 札を置く。titles は題名のラベル（動かさない。今の線からずらした後の位置）。
 * 戻り値は id → 置き場所（置けなければ null。ホバーに任せる）
 */
export function placeTags(
  requests: readonly TagRequest[],
  titles: readonly Box[],
  opts: { tagPx: number; nowY: number | null; rails?: readonly Rail[]; railGapPx?: number },
): Map<string, TagPlace | null> {
  const { tagPx, nowY } = opts;
  const rails = opts.rails ?? [];
  const gap = opts.railGapPx ?? 6;
  const taken: Record<"lane" | "left", Box[]> = { lane: [...titles], left: [] };
  const out = new Map<string, TagPlace | null>();
  const order = [...requests].sort((a, b) => b.weight - a.weight || a.want - b.want);
  for (const r of order) {
    const region = r.region ?? "lane";
    const onNow = (y: number) =>
      nowY !== null && y < nowY + NOW_GAP_PX && nowY - NOW_GAP_PX < y + tagPx;
    const free = (y: number) =>
      !onNow(y) && !taken[region].some((o) => hits(o, { top: y, height: tagPx }));
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
    // 今の線にかかって置けない札（今まで続く線）は、今の線のすぐ下に置ける
    if (y === null && nowY !== null && hi + tagPx >= nowY - NOW_GAP_PX && free(nowY + NOW_GAP_PX))
      y = nowY + NOW_GAP_PX;
    if (y === null) {
      out.set(r.id, null);
      continue;
    }
    const top = y;
    let left = r.minLeft;
    if (region === "lane")
      for (const l of rails)
        if (l.top < top + tagPx && top < l.bottom) left = Math.max(left, l.x + gap);
    out.set(r.id, { top, left });
    taken[region].push({ top, height: tagPx });
  }
  return out;
}
