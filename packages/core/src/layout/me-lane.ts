/**
 * 週ボードの自分レーンの配置（docs/design/README.md の W1・W4・W5、D-050）。純粋関数。
 * 1. 最小高さのせいで重なって見えるだけの、連続した完了ブロック（間隔 gapPx 未満で続くもの）は、
 *    2件以上なら1つのまとめ表示（`✓ 3 done · 41m`）にする（W4）。詳細はデイビューで見る
 * 2. 予定の中で始まるタスクは、予定に題名の行と最小高さぶんの高さがあれば、予定の題名の下に字下げして入れる
 *    （確定デザイン week-board-v4 の Design review / Write article outline の並べ方）。
 *    入らなければ予定と列を分ける（W5）。どちらでも文字は重ならない
 * 3. 残り（予定・計画タスク・単独の完了・まとめ）は従来どおり重なりで列に分ける。項目はすべて最小高さを守る
 */
import { type Box, boxOf, columnize, type Placed } from "./lanes.ts";

export interface MeLaneItem {
  id: string;
  kind: "event" | "planned" | "done";
  start: number;
  end: number;
  /** 最小の高さ（px）。計画に重なりの警告を出すときは2行ぶん */
  minPx: number;
}

export interface MeLaneOptions {
  axisStart: number;
  pxPerMs: number;
  /** 予定の題名の行の高さ（px）。入れ子のタスクはこれより下に置く */
  titlePx: number;
  /** まとめ表示の最小高さ・入れ子に要るタスクの高さ（px） */
  minPx: number;
  /** 完了ブロックの間がこれ未満なら連続とみなす（px） */
  gapPx: number;
}

/** 列の位置（幅 1 / columns の column 番目） */
export interface Slot {
  column: number;
  columns: number;
}

export type MeLaneBox =
  | ({ kind: "event"; id: string; top: number; height: number } & Slot)
  | ({
      kind: "task";
      id: string;
      top: number;
      height: number;
      /** 入れ子の場合の予定の id と、その予定の列 */
      host: (Slot & { id: string }) | null;
    } & Slot)
  | ({
      kind: "summary";
      /** まとめた完了タスク（開始順） */
      ids: string[];
      start: number;
      end: number;
      /** 各ブロックの長さの和 */
      totalMs: number;
      top: number;
      height: number;
      host: (Slot & { id: string }) | null;
    } & Slot);

interface Unit {
  kind: "task" | "summary";
  ids: string[];
  start: number;
  end: number;
  totalMs: number;
  /** 最小の高さ（px） */
  minPx: number;
  box: Box;
}

export function layoutMeLane(items: readonly MeLaneItem[], o: MeLaneOptions): MeLaneBox[] {
  const box = (it: MeLaneItem) => boxOf(it, o.axisStart, o.pxPerMs);
  const events = items.filter((x) => x.kind === "event");
  const units: Unit[] = [];

  // 1. 連続した完了ブロックをまとめる（W4）
  const done = items.filter((x) => x.kind === "done").sort((a, b) => a.start - b.start);
  let run: MeLaneItem[] = [];
  let runBottom = Number.NEGATIVE_INFINITY;
  const flush = () => {
    if (run.length === 1) {
      const it = run[0] as MeLaneItem;
      units.push(unitOf("task", [it], box(it), it.minPx));
    } else if (run.length > 1) {
      const top = box(run[0] as MeLaneItem).top;
      const end = Math.max(...run.map((x) => x.end));
      const bottom = Math.max(top + o.minPx, (end - o.axisStart) * o.pxPerMs);
      units.push(unitOf("summary", run, { id: `summary:${run[0]?.id}`, top, bottom }, o.minPx));
    }
    run = [];
    runBottom = Number.NEGATIVE_INFINITY;
  };
  for (const it of done) {
    const b = box(it);
    if (run.length > 0 && b.top >= runBottom + o.gapPx) flush();
    run.push(it);
    runBottom = Math.max(runBottom, b.bottom);
  }
  flush();
  for (const it of items.filter((x) => x.kind === "planned"))
    units.push(unitOf("task", [it], box(it), it.minPx));

  // 2. 予定の中で始まるものは、入るなら予定の題名の下へ（W5、v4 の並べ方）
  const hostable = events
    .map((e) => ({ e, b: box(e) }))
    .filter(({ b }) => b.bottom - b.top >= o.titlePx + o.minPx)
    .sort((a, b) => a.e.start - b.e.start || b.e.end - a.e.end);
  const nested = new Map<string, Unit[]>();
  const free: Unit[] = [];
  for (const u of units) {
    const h = hostable.find(({ e }) => e.start <= u.start && u.start < e.end);
    if (!h) {
      free.push(u);
      continue;
    }
    // 題名の下へ下げる（下端は実時刻のまま、ただし最小高さは守る）
    const top = Math.max(u.box.top, h.b.top + o.titlePx);
    const moved = {
      ...u,
      box: { id: u.box.id, top, bottom: Math.max(u.box.bottom, top + u.minPx) },
    };
    const list = nested.get(h.e.id) ?? [];
    list.push(moved);
    nested.set(h.e.id, list);
  }

  // 3. 予定（入れ子の下端まで含めた範囲）と、入れ子でないものを列に分ける
  const shared: Box[] = [
    ...events.map((e) => {
      const b = box(e);
      const inner = nested.get(e.id) ?? [];
      return {
        id: e.id,
        top: b.top,
        bottom: Math.max(b.bottom, ...inner.map((u) => u.box.bottom)),
      };
    }),
    ...free.map((u) => u.box),
  ];
  const slots = new Map<string, Placed>(
    columnize(shared, Number.POSITIVE_INFINITY).placed.map((p) => [p.id, p]),
  );
  const out: MeLaneBox[] = [];
  const emit = (
    u: Unit,
    top: number,
    height: number,
    slot: Slot,
    host: (Slot & { id: string }) | null,
  ) => {
    if (u.kind === "summary")
      out.push({
        kind: "summary",
        ids: u.ids,
        start: u.start,
        end: u.end,
        totalMs: u.totalMs,
        top,
        height,
        host,
        ...slot,
      });
    else out.push({ kind: "task", id: u.ids[0] as string, top, height, host, ...slot });
  };
  for (const e of events) {
    const p = slots.get(e.id);
    if (!p) continue;
    const b = box(e);
    out.push({
      kind: "event",
      id: e.id,
      top: b.top,
      height: b.bottom - b.top,
      column: p.column,
      columns: p.columns,
    });
    const inner = nested.get(e.id) ?? [];
    const sub = new Map(
      columnize(
        inner.map((u) => u.box),
        Number.POSITIVE_INFINITY,
      ).placed.map((p) => [p.id, p]),
    );
    for (const u of inner) {
      const q = sub.get(u.box.id);
      if (q)
        emit(
          u,
          q.top,
          q.height,
          { column: q.column, columns: q.columns },
          {
            id: e.id,
            column: p.column,
            columns: p.columns,
          },
        );
    }
  }
  for (const u of free) {
    const p = slots.get(u.box.id);
    if (p) emit(u, p.top, p.height, { column: p.column, columns: p.columns }, null);
  }
  return out;
}

function unitOf(kind: Unit["kind"], run: MeLaneItem[], box: Box, minPx: number): Unit {
  return {
    minPx,
    kind,
    ids: run.map((x) => x.id),
    start: Math.min(...run.map((x) => x.start)),
    end: Math.max(...run.map((x) => x.end)),
    totalMs: run.reduce((a, x) => a + (x.end - x.start), 0),
    box,
  };
}
