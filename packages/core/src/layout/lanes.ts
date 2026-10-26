/**
 * 時間軸の配置計算（m2-api.md 5章、M2-13）。サーバーは時刻だけを返し、列と位置はクライアントのこの純粋関数で決める。
 * - 表示上の終わり visEnd = max(end, start + minPx / pxPerMs) で重なりを判定する（時刻上は重ならない
 *   8:50–8:58 と 8:58–9:06 も、最小高さでは重なる）。開始位置は実時刻のまま（D2）
 * - 重なりのまとまり（連結成分）ごとに、開始順に空いている最も左の列へ入れ、まとまりの列数で幅を割る
 * - maxColumns を超えた分は overflow にまとめる（AI は3列 + `+N`）
 * 週ボードの自分レーン（まとめ表示 W4・予定との重なり W5）は me-lane.ts。
 */
export interface LaneInput {
  id: string;
  start: number;
  end: number;
  /** 最小の高さ（px。週ボードは 20 / デイビューの自分レーンは 16） */
  minPx: number;
}

export interface LaneOptions {
  axisStart: number;
  pxPerMs: number;
  /** AI は 3、自分は Infinity */
  maxColumns: number;
}

export interface Placed {
  id: string;
  top: number;
  height: number;
  /** 0 始まりの列 */
  column: number;
  /** そのまとまりの列数（幅は 1 / columns） */
  columns: number;
}

export interface Overflow {
  top: number;
  height: number;
  hidden: string[];
}

/** px の箱（上端・下端）を列に分ける。placeLanes と自分レーンの配置で共有する */
export interface Box {
  id: string;
  top: number;
  bottom: number;
}

export function columnize(
  boxes: readonly Box[],
  maxColumns: number,
): { placed: Placed[]; overflow: Overflow[] } {
  const xs = [...boxes].sort(
    (a, b) => a.top - b.top || b.bottom - a.bottom || a.id.localeCompare(b.id),
  );
  const placed: Placed[] = [];
  const overflow: Overflow[] = [];
  let group: Box[] = [];
  let groupBottom = Number.NEGATIVE_INFINITY;

  const flush = () => {
    if (group.length === 0) return;
    // 開始順に、空いている最も左の列へ（列ごとの最後の下端を覚える）
    const colBottoms: number[] = [];
    const cols: number[] = [];
    for (const g of group) {
      let c = colBottoms.findIndex((b) => b <= g.top);
      if (c < 0) {
        c = colBottoms.length;
        colBottoms.push(g.bottom);
      } else colBottoms[c] = g.bottom;
      cols.push(c);
    }
    const used = Math.min(colBottoms.length, maxColumns);
    const hidden: Box[] = [];
    group.forEach((g, i) => {
      const c = cols[i] as number;
      if (c < maxColumns) {
        placed.push({ id: g.id, top: g.top, height: g.bottom - g.top, column: c, columns: used });
      } else hidden.push(g);
    });
    if (hidden.length > 0) {
      const top = Math.min(...hidden.map((h) => h.top));
      const bottom = Math.max(...hidden.map((h) => h.bottom));
      overflow.push({ top, height: bottom - top, hidden: hidden.map((h) => h.id) });
    }
    group = [];
    groupBottom = Number.NEGATIVE_INFINITY;
  };

  for (const x of xs) {
    if (group.length > 0 && x.top >= groupBottom) flush();
    group.push(x);
    groupBottom = Math.max(groupBottom, x.bottom);
  }
  flush();
  return { placed, overflow };
}

/** 時刻の区間 → px の箱（最小の高さを守る） */
export function boxOf(it: LaneInput, axisStart: number, pxPerMs: number): Box {
  const top = (it.start - axisStart) * pxPerMs;
  const height = Math.max((it.end - it.start) * pxPerMs, it.minPx);
  return { id: it.id, top, bottom: top + height };
}

export function placeLanes(
  items: readonly LaneInput[],
  o: LaneOptions,
): { placed: Placed[]; overflow: Overflow[] } {
  return columnize(
    items.map((it) => boxOf(it, o.axisStart, o.pxPerMs)),
    o.maxColumns,
  );
}

/** 区間を時間軸の範囲で切り取る（前日から続く待ちなど。m2-api.md 2.4） */
export function clip(
  x: { start: number; end: number },
  axis: { start: number; end: number },
): { start: number; end: number } | null {
  const start = Math.max(x.start, axis.start);
  const end = Math.min(x.end, axis.end);
  return end > start ? { start, end } : null;
}
