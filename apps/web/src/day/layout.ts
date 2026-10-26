/**
 * デイビューの配置（M2-19。ux-mvp 4.5、確定デザイン day-view-v3）。純粋関数にしてテストする。
 * - AI は週ボードと同じ「ひと続きの作業」（同じ項目で間隔30分未満のターン。core の spansOf。D-065）。
 *   週ボードのまとめ表示（`✓ N runs`）は使わない。項目の最後のブロックだけ2行（メタ `AI 38m · You 8m · Idle 13m`）
 * - 並列は4列まで（core の placeLanes）、超えたら `+N`。同じ項目の近いブロックは chain にまとめて同じ列に（D-117）
 * - 待ちの線は各 AI 項目の列に、その項目の実行ブロックの下端から引く（区間の始まりがブロックに隠れる分は下端から）
 * - 集計外のラベル（away / in meeting …）は区間ごとに1回、放置のラベルはひと続きの放置ごとに1回。
 *   集計外のラベルが短さ（14px 未満）や AI のブロックとの重なりで隠れるときはホバーでだけ出す（labelHoverOnly。D-065）。
 *   放置のラベルはブロック・ほかのラベルと重ならない位置へ下へずらし、置けなければ（短い区間の方）ホバーに任せる（board/labels.ts）
 * - 同じ列で別々の待ち（別の AI 項目、同じ項目の別の待ち）の線が上下に重なるときは、線を横にずらす（track。WAIT_TRACK_PX ずつ）。
 *   どの待ちの線か見分けられるようにする（以前は同じ x に重なって1本に見えた）
 * - 自分レーン: 実時間の高さ、15分未満は最小 16px、重なりは横に並べる（D2）
 */
import {
  type AiRunDetail,
  type AiSpan,
  clip,
  type DayDetail,
  type DayWaitSegment,
  type Interval,
  type Overflow,
  type Placed,
  placeLanes,
  spansOf,
  type WorkItemStatus,
} from "@turnlane/core/web";
import { laneTopOf } from "../board/day-split.ts";
import { colsOverlap, LABEL_PX, placeLabels } from "../board/labels.ts";

/** デイビューの1時間の高さ（週ボードの 44px より大きく、ターンと待ちの線を読める高さ） */
export const DAY_HOUR_PX = 60;
export const DAY_PX_PER_MS = DAY_HOUR_PX / 3_600_000;
/** 並列の列の上限（D-117 で 4 → 6。3日ボードと同じ。上限を超えた分は `+N` に隠れて読めない） */
export const AI_MAX_COLS = 6;
/** AI のブロックの最小の高さ（1行）と、メタの行を持つ項目の最後のブロック（2行） */
export const AI_MIN_PX = 20;
export const AI_META_PX = 36;
/** 自分レーンの最小の高さ（15分未満。D2） */
export const ME_MIN_PX = 16;

export const yAt = (ms: number, axisStart: number) => (ms - axisStart) * DAY_PX_PER_MS;

type Item = DayDetail["aiLane"][number];

export interface DayAiBlock {
  id: string;
  item: Item;
  /** ブロック内のターン（開始順）。持ち越し（今日の実行が無い）は空 */
  runs: AiRunDetail[];
  /** ひと続きの作業（AI 時間はターンの和）。持ち越しは null */
  span: AiSpan | null;
  /** 時間軸で切った区間 */
  at: Interval;
  /** その日の項目の最後のブロック（メタの行と、待っていれば状態のアイコン） */
  last: boolean;
  status: WorkItemStatus;
}

/** ひと続きの作業のブロック（D-065）。needs_input で止まっている実行は待ちの始まりで切る（週ボードと同じ） */
export function dayAiBlocks(
  day: Pick<DayDetail, "aiLane" | "axis" | "phase" | "plannedHours">,
  now: number,
): DayAiBlock[] {
  const out: DayAiBlock[] = [];
  for (const item of day.aiLane) {
    const blockedAt =
      item.status === "needs_input" ? item.waits.find((w) => w.open)?.start : undefined;
    const byTurn = new Map(item.runs.map((r) => [r.turnId, r]));
    const cut = item.runs.map((r) => {
      const end = r.open && blockedAt !== undefined && blockedAt > r.start ? blockedAt : r.end;
      return { turnId: r.turnId, start: r.start, end, open: r.open && end === r.end };
    });
    const runs = spansOf(cut, { now })
      .map((span) => {
        const end = span.open ? Math.max(span.end, now) : span.end;
        return {
          span,
          c: clip({ start: span.start, end: Math.max(end, span.start + 1) }, day.axis),
        };
      })
      .filter((x): x is { span: AiSpan; c: Interval } => x.c !== null);
    runs.forEach(({ span, c }, i) => {
      const last = i === runs.length - 1;
      out.push({
        id: `${item.id}:${span.id}`,
        item,
        runs: span.turnIds.flatMap((id) => {
          const r = byTurn.get(id);
          return r ? [r] : [];
        }),
        span,
        at: c,
        last,
        status: last ? item.status : "done",
      });
    });
    if (runs.length === 0) {
      // 持ち越し: 最初に見える待ちと上端（計画の目安の開始と今の早い方。D-105）の遅い方に置く（夜間の待ちは画面の外になるため）
      const w = item.waits.map((x) => clip(x, day.axis)).find((x) => x !== null);
      const start = Math.max(w?.start ?? day.axis.start, laneTopOf(day, now));
      out.push({
        id: `carry:${item.id}`,
        item,
        runs: [],
        span: null,
        at: { start, end: start + 1 },
        last: true,
        status: item.status,
      });
    }
  }
  return out;
}

export interface PlacedAi extends Placed {
  block: DayAiBlock;
  /** 列を取っている下端（待ちの線を含む。px） */
  reach?: number;
  /** 同じ項目のひと続きのブロック（chain）の最後か（ラベルを付けるのは最後だけ。D-117） */
  tail: boolean;
  /** chain の AI 時間の合計（ラベルの長さ） */
  chainAiMs: number;
  /** chain の最初のブロックの id */
  chainId: string;
}

/** 同じ項目の次のブロックまでがこれより短ければ、1つの chain にして列を取り続ける（D-117） */
export const CHAIN_GAP_MS = 60 * 60_000;

/**
 * AI のブロックの配置（D-117）: 同じ項目のブロックを、間が CHAIN_GAP_MS より短いものどうしで chain にまとめ、chain ごとに
 * 列を決める（項目が列を移らず、短い作業を繰り返す項目の線の間にほかの項目の線を挟まない）。ラベルは chain の最後の
 * ブロックに1つ（tail）。線の高さは実行の長さ（ラベルの付く最後は AI_META_PX、それより前は AI_MIN_PX まで伸ばす）
 */
export function layoutDayAi(
  blocks: DayAiBlock[],
  axisStart: number,
  /**
   * 列を決めるときの終わり（ブロックの後に続く待ちの線の分も列を取る。待ちの点線とほかの AI の線を同じ x に重ねない。
   * 確定デザインのデイビュー。D-114）。描く高さは実行の長さのまま
   */
  extentOf?: (b: DayAiBlock) => number,
): { placed: PlacedAi[]; overflow: Overflow[] } {
  const ext = (b: DayAiBlock) => (extentOf ? Math.max(b.at.end, extentOf(b)) : b.at.end);
  type Chain = { id: string; blocks: DayAiBlock[]; end: number };
  const chains: Chain[] = [];
  const open = new Map<string, Chain>();
  for (const b of [...blocks].sort((x, y) => x.at.start - y.at.start)) {
    const c = open.get(b.item.id);
    if (c && b.span !== null && b.at.start - c.end < CHAIN_GAP_MS) {
      c.blocks.push(b);
      c.end = Math.max(c.end, ext(b));
      continue;
    }
    const n = { id: b.id, blocks: [b], end: ext(b) };
    chains.push(n);
    open.set(b.item.id, n);
  }
  const byId = new Map(chains.map((c) => [c.id, c]));
  const r = placeLanes(
    chains.map((c) => {
      const first = c.blocks[0] as DayAiBlock;
      const tail = c.blocks.at(-1) as DayAiBlock;
      return {
        id: c.id,
        start: first.at.start,
        end: Math.max(c.end, tail.at.start + AI_META_PX / DAY_PX_PER_MS),
        minPx: AI_META_PX,
      };
    }),
    { axisStart, pxPerMs: DAY_PX_PER_MS, maxColumns: AI_MAX_COLS },
  );
  return {
    placed: r.placed.flatMap((p) => {
      const c = byId.get(p.id);
      if (!c) return [];
      const aiMs = c.blocks.reduce((a, x) => a + (x.span?.aiMs ?? 0), 0);
      return c.blocks.map((block, i) => {
        const tail = i === c.blocks.length - 1;
        const top = yAt(block.at.start, axisStart);
        const height = Math.max(
          tail ? AI_META_PX : AI_MIN_PX,
          (block.at.end - block.at.start) * DAY_PX_PER_MS,
        );
        const next = c.blocks[i + 1];
        const reach = next ? yAt(next.at.start, axisStart) : p.top + p.height;
        return {
          id: block.id,
          top,
          height,
          column: p.column,
          columns: p.columns,
          reach: Math.max(top + height, reach),
          block,
          tail,
          chainAiMs: aiMs,
          chainId: c.id,
        };
      });
    }),
    overflow: r.overflow,
  };
}

/**
 * ブロックの後に続く待ち（次のブロックの前まで。開いている待ちは now まで）の終わり。
 * 前日からの持ち越し（今日の実行が無く待ちだけ。デイビューは描く）は、その日に見える待ちの全部（持ち越しのブロックは
 * 最初の待ちの途中に置くので、ブロックより前に始まった待ちも含める）。以前は持ち越しの列が 1 ブロック分しか取られず、
 * 一日じゅう続く待ちの線の上にほかの項目の AI の線が同じ x で並び、どの項目の待ちか見分けられなかった（PO の既知の点）
 */
export function waitExtentOf(
  blocks: readonly DayAiBlock[],
  now: number,
  axis: Interval,
): (b: DayAiBlock) => number {
  return (b) => {
    const next = blocks
      .filter((x) => x.item.id === b.item.id && x.at.start > b.at.start)
      .reduce((m, x) => Math.min(m, x.at.start), Number.POSITIVE_INFINITY);
    let end = b.at.end;
    for (const w of b.item.waits) {
      if ((b.span && w.start < b.at.start) || w.start >= next) continue;
      const c = clip({ start: w.start, end: w.open ? Math.max(w.end, now) : w.end }, axis);
      if (c) end = Math.max(end, c.end);
    }
    return end;
  };
}

export type WaitLabel =
  | { t: "idle"; ms: number }
  | { t: "excluded"; by: NonNullable<DayWaitSegment["excludedBy"]> | "expired" }
  | { t: "grace"; ms: number; end: DayWaitSegment["endReason"] };

export interface WaitLine {
  key: string;
  itemId: string;
  seg: DayWaitSegment;
  /** 時間軸で切った（開いている待ちは now まで伸ばした）区間 */
  at: Interval;
  top: number;
  height: number;
  column: number;
  columns: number;
  label: WaitLabel | null;
  /**
   * ラベルを線の上に置くと隠れる（短い・AI のブロックと重なる）ので、ホバーでだけ出す（集計外。D-065）。
   * 放置は、ブロック・ほかのラベルと重ならない位置が線の範囲に無いとき（帯のホバーに任せる）
   */
  labelHoverOnly: boolean;
  /** ラベルの上端（px）。放置のラベルは線の中ほどを基準に、AI のブロック・ほかのラベルに重ならない位置へ下へずらす */
  labelTop: number;
  /** 同じ列で上下に重なる別の待ちと見分けるための横のずらし（0 から。x は track × WAIT_TRACK_PX だけ右へ） */
  track: number;
  /** 上下に重なる待ちの段のうち最も右のもの（ラベルをそれより右に置き、ほかの段の線に重ねない） */
  trackMax: number;
}

/** 待ちの線を横にずらす1段の幅（px）と段の数（超えたら折り返す） */
export const WAIT_TRACK_PX = 6;
export const WAIT_TRACKS = 3;

/**
 * 同じ列で上下に重なる別々の待ち（項目 × waitKey）に、別の段（track）を割り当てる。
 * 同じ待ちの区間（放置 → 集計外 → 放置…）は同じ段に置いて1本の線に見せる。重ならなければ段 0（従来の位置）
 */
export function assignWaitTracks(lines: WaitLine[]): void {
  type Group = { lines: WaitLine[]; top: number; bottom: number; col: string; track: number };
  const groups = new Map<string, Group>();
  for (const l of lines) {
    const col = `${l.column}/${l.columns}`;
    const k = `${col}|${l.itemId}|${l.seg.waitKey}`;
    const g = groups.get(k);
    if (g) {
      g.lines.push(l);
      g.top = Math.min(g.top, l.top);
      g.bottom = Math.max(g.bottom, l.top + l.height);
    } else groups.set(k, { lines: [l], top: l.top, bottom: l.top + l.height, col, track: 0 });
  }
  const done: Group[] = [];
  for (const g of [...groups.values()].sort((a, b) => a.top - b.top || b.bottom - a.bottom)) {
    const used = new Set(
      done
        .filter((d) => d.col === g.col && d.top < g.bottom && g.top < d.bottom)
        .map((d) => d.track),
    );
    let t = 0;
    while (used.has(t)) t++;
    g.track = t % WAIT_TRACKS;
    done.push(g);
    for (const l of g.lines) l.track = g.track;
  }
  for (const g of done) {
    const max = Math.max(
      ...done
        .filter((d) => d.col === g.col && d.top < g.bottom && g.top < d.bottom)
        .map((d) => d.track),
    );
    for (const l of g.lines) l.trackMax = max;
  }
}

/** 集計外のラベルを置くのに要る高さ（これ未満の区間には書かない） */
export const EXCLUDED_LABEL_MIN_PX = 14;

/**
 * 待ちの線: 項目のブロックのうち、区間の始まりより前に始まった最後のもの（無ければ最初）の列に、そのブロックの下端から引く
 */
export function waitLines(
  day: Pick<DayDetail, "aiLane" | "axis">,
  placed: PlacedAi[],
  now: number,
): WaitLine[] {
  const out: WaitLine[] = [];
  for (const item of day.aiLane) {
    const mine = placed
      .filter((p) => p.block.item.id === item.id)
      .sort((a, b) => a.block.at.start - b.block.at.start);
    if (mine.length === 0) continue;
    const segs = item.waits
      .map((w) => ({
        w,
        c: clip({ start: w.start, end: w.open ? Math.max(w.end, now) : w.end }, day.axis),
      }))
      .filter((x): x is { w: DayWaitSegment; c: Interval } => x.c !== null)
      .sort((a, b) => a.c.start - b.c.start);
    // ひと続きの放置の長さ（同じ待ちの idle が続く間）と、集計外の理由が続く区間の先頭を出す
    let prev: { w: DayWaitSegment; c: Interval } | null = null;
    let idleRun: WaitLine | null = null;
    for (const [i, x] of segs.entries()) {
      const { w, c } = x;
      const host = [...mine].reverse().find((p) => p.block.at.start <= c.start) ?? mine[0];
      if (!host) continue;
      const segTop = yAt(c.start, day.axis.start);
      const hostBottom = host.top + host.height;
      // 区間の始まりがブロックに隠れる分は、ブロックの下端から。ブロックより前（持ち越しの夜間の待ちなど）は描かない
      const top = Math.max(segTop, hostBottom);
      const bottom = yAt(c.end, day.axis.start);
      const contiguous =
        prev !== null && prev.w.waitKey === w.waitKey && Math.abs(prev.c.end - c.start) < 1000;
      let label: WaitLabel | null = null;
      if (w.kind === "idle") {
        if (contiguous && prev?.w.kind === "idle" && idleRun?.label?.t === "idle") {
          idleRun.label = { t: "idle", ms: idleRun.label.ms + (c.end - c.start) };
        } else label = { t: "idle", ms: c.end - c.start };
      } else if (w.kind === "excluded" || w.kind === "expired") {
        const by = w.kind === "expired" ? "expired" : (w.excludedBy ?? "away");
        const sameAsPrev =
          contiguous &&
          prev?.w.kind === w.kind &&
          (prev?.w.excludedBy ?? null) === (w.excludedBy ?? null);
        if (!sameAsPrev) label = { t: "excluded", by };
      } else if (w.kind === "grace") {
        // 猶予のうちに閉じた待ち: 終わりに `grace 8m → replied`
        const next = segs[i + 1];
        const closesHere = !w.open && (!next || next.w.waitKey !== w.waitKey);
        if (closesHere) {
          const graceMs = segs
            .filter((s) => s.w.waitKey === w.waitKey && s.w.kind === "grace")
            .reduce((a, s) => a + (s.c.end - s.c.start), 0);
          label = { t: "grace", ms: graceMs, end: w.endReason };
        }
      }
      const line: WaitLine = {
        key: `${item.id}:${w.waitKey}:${c.start}`,
        itemId: item.id,
        seg: w,
        at: c,
        top,
        height: Math.max(0, bottom - top),
        column: host.column,
        columns: host.columns,
        label,
        labelHoverOnly: false,
        labelTop: top + 2,
        track: 0,
        trackMax: 0,
      };
      if (label?.t === "excluded") {
        const top0 = line.top + 2;
        const covered = placed.some(
          (p) => colsOverlap(p, host) && p.top < top0 + LABEL_PX && top0 < p.top + p.height,
        );
        // 同じ列で同じ高さに別の待ちの集計外のラベルが出ていれば、重ねずにホバーに任せる（同じ会議で別々の待ちが止まるとき）
        const taken = out.some(
          (o) =>
            o.label?.t === "excluded" &&
            !o.labelHoverOnly &&
            colsOverlap(o, host) &&
            o.labelTop < top0 + LABEL_PX &&
            top0 < o.labelTop + LABEL_PX,
        );
        line.labelHoverOnly = line.height < EXCLUDED_LABEL_MIN_PX || covered || taken;
      }
      if (label?.t === "grace") line.labelTop = top + line.height - 8;
      if (w.kind === "idle" && label) idleRun = line;
      if (w.kind !== "idle") idleRun = null;
      out.push(line);
      prev = x;
    }
  }
  assignWaitTracks(out.filter((l) => l.height > 0));
  // 放置のラベル: 線の中ほどを望む位置に、AI のブロック・ほかのラベルと重ならない位置へ下へずらす。
  // 置けないもの（短い区間の方）は省いてホバーに任せる（labelHoverOnly）
  const fixed = out.flatMap((l) =>
    (l.label?.t === "excluded" && !l.labelHoverOnly) || l.label?.t === "grace"
      ? [{ top: l.labelTop, height: LABEL_PX, column: l.column, columns: l.columns }]
      : [],
  );
  const idle = out.filter((l) => l.label?.t === "idle" && l.height > 0);
  const tops = placeLabels(
    idle.map((l) => ({
      id: l.key,
      column: l.column,
      columns: l.columns,
      want: l.top + l.height / 2 - LABEL_PX / 2,
      lo: l.top,
      hi: l.top + l.height - LABEL_PX,
      weight: l.label?.t === "idle" ? l.label.ms : 0,
    })),
    [...placed, ...fixed],
  );
  for (const l of idle) {
    const y = tops.get(l.key);
    if (y === null || y === undefined) l.labelHoverOnly = true;
    else l.labelTop = y;
  }
  return out;
}

export interface MeInput {
  id: string;
  at: Interval;
}

/** 自分レーン: 実時間の高さ（最小 16px）、重なりは横に並べる（D2。列の数に上限なし） */
export function layoutMe(items: MeInput[], axis: Interval): Placed[] {
  return placeLanes(
    items.flatMap((x) => {
      const c = clip(x.at, axis);
      return c ? [{ id: x.id, start: c.start, end: c.end, minPx: ME_MIN_PX }] : [];
    }),
    { axisStart: axis.start, pxPerMs: DAY_PX_PER_MS, maxColumns: Number.POSITIVE_INFINITY },
  ).placed;
}

/**
 * 応答ブロックと AI の待ちをつなぐコネクタの終点（AI レーンの列）。待ちの線のうち、応答の開始に最も近い終点を持つもの。
 * 無ければ項目の最後のブロックの列
 */
export function connectorTarget(
  itemId: string,
  waitKey: string | null,
  at: number,
  lines: WaitLine[],
  placed: PlacedAi[],
): { column: number; columns: number } | null {
  const ls = lines
    .filter((l) => l.itemId === itemId && (waitKey === null || l.seg.waitKey === waitKey))
    .sort((a, b) => Math.abs(a.at.end - at) - Math.abs(b.at.end - at));
  const l = ls[0];
  if (l) return { column: l.column, columns: l.columns };
  const p = placed.filter((x) => x.block.item.id === itemId).at(-1);
  return p ? { column: p.column, columns: p.columns } : null;
}
