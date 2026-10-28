/**
 * 今日の AI レーン（M2-14。ux-mvp 4.4、D-028、W2、W7）。
 * - ブロックはターンごとではなく AI 項目ごとのひと続きの作業（間隔30分未満のターン。D-061）。右端は AI 時間の和。
 *   状態はブロックの最後のターンに従う（後に続きのあるブロックは完了）
 * - 5分未満の完了ブロックが最小高さで重なって並ぶときは `✓ 5 runs · 3m` にまとめる（W4 と同じ規則）
 * - AI 項目は最小 20px・1行（状態アイコン、タイトル、ソースバッジ、右端に時間）。並列は3列まで、超えたら `+N`
 * - 待ち線は2種だけ: 放置 = 2px 点線・状態色（10分以上のときだけ無彩色の mono ラベル `idle 11m`）/ それ以外 = 1px 灰色点線。
 *   ラベルはブロックの題名・ほかのラベルと重ねない（下へずらし、置けなければ短い区間の方を省いて線のホバーに。board/labels.ts）
 *   この描き分けは開いている待ちだけ。閉じた待ちは 1px 灰色点線と終わりの点（ホバーで `replied 13:40 · 3m`。D-075）
 * - 前日からの未完了 AI の持ち越し（今日の実行が無く、開いている待ちだけを持つ）
 */
import {
  AI_SHORT_SPAN_MS,
  type AiLaneBox,
  type AiLaneItem,
  type AiSpan,
  clip,
  type DayColumn,
  fmtClock,
  fmtDuration,
  type Interval,
  layoutAiLane,
  spansOf,
  type WorkItemStatus,
} from "@turnlane/core/web";
import { type ReactNode, useState } from "react";
import { aiHoverOf } from "../components/AiHoverCard.tsx";
import { AiRunBlock } from "../components/items.tsx";
import { Nums } from "../components/Nums.tsx";
import { TimelineMarks, useTimelineMarks } from "../ext/marks.tsx";
import { type MessageKey, useI18n } from "../i18n/index.tsx";
import { countedInDate, laneTopOf, type Placement } from "./day-split.ts";
import { DraggableAi } from "./dnd.tsx";
import { HOUR_PX, yOf } from "./geometry.ts";
import { LABEL_PX } from "./labels.ts";
import { belowNow, placeTags, type TagRequest } from "./lane-labels.ts";
import { laneRank, laneStatus, questionWait, useLaneLaters, useLaneWaits } from "./lane-wait.ts";
import { WaitDots } from "./WaitDots.tsx";
import { openWaitKeys, type WaitEnd, waitEndsOf, waitEndText } from "./wait-ends.ts";

/**
 * 並列の列の上限（D-117 で 4 → 6。線は 12px 間隔なので6列でも 70px ほど。上限を超えた分は `+N` に隠れて読めない）
 */
const MAX_COLS = 6;
/** 同じ項目の次のブロックまでがこれより短ければ、その間も列を取る（ほかの項目を間に挟まない。D-117） */
const CHAIN_GAP_MS = 60 * 60_000;
/** AI の線（確定デザイン: 3px の線を AI レーンの左に 12px 間隔で並べる）とラベルの高さ（2行） */
const BAR_W = 3;
const BAR_STEP = 12;
const BAR_LEFT = 6;
const LABEL_H = 34;
/** 2 行目を消したラベルの高さ（題名の行だけ。B-3） */
const LABEL_LINE_PX = 18;
/** ドラッグの要素に位置を付け、中のブロックは全面に広げる */
const FILL: React.CSSProperties = { top: 0, left: 0, width: "100%", height: "100%" };
const MIN_PX = 20;
/**
 * ラベルの付く線の最小の高さ（D-117）。短い作業（8m など）でもラベルの題名の行と並ぶ長さにし、点のように見せない。
 * 同じ項目の続きの線（ラベル無し）は MIN_PX
 */
export const LABELED_MIN_PX = 28;
/** 待ちの線の横の放置のラベルを出さない（3日ボード。確定デザイン） */
const HIDE_IDLE_LABELS = true;
const TONE: Record<string, string> = {
  needs_input: "var(--dl-needs)",
  error: "var(--dl-error)",
  your_turn: "var(--dl-turn)",
};

export interface Block {
  id: string;
  item: AiLaneItem;
  /** 時間軸で切ったブロックの区間 */
  at: Interval;
  /** 切る前のひと続きの作業（AI 時間はターンの和。0:00 をまたぐ実行も切らない長さで出す。D-054） */
  span: AiSpan;
  /** ブロックの状態（最後のブロックは項目の状態、後に続きのあるものは done。D-061） */
  status: WorkItemStatus;
  last: boolean;
  carried: boolean;
}

/** ひと続きの作業のブロック（持ち越しは開いている待ちの始まりに 20px で置く） */
export function blocksOf(day: DayColumn, now: number): Block[] {
  const out: Block[] = [];
  for (const item of day.aiLane ?? []) {
    // 自分を待って止まっている間（needs_input）は実行のブロックを待ちの始まりで切る（待ち線で描く）
    const blockedAt =
      item.status === "needs_input" ? item.waits.find((w) => w.open)?.start : undefined;
    const runs = item.runs.map((r) => {
      const end = r.open && blockedAt !== undefined && blockedAt > r.start ? blockedAt : r.end;
      return { turnId: r.turnId, start: r.start, end, open: r.open && end === r.end };
    });
    const spans = spansOf(runs, { now })
      .map((span) => ({
        span,
        c: clip({ start: span.start, end: Math.max(span.end, span.start + 1) }, day.axis),
      }))
      .filter((x): x is { span: AiSpan; c: Interval } => x.c !== null);
    for (const [i, { span, c }] of spans.entries()) {
      const last = i === spans.length - 1;
      out.push({
        id: `${item.id}:${span.id}`,
        item,
        at: c,
        span,
        // 上限待ち（利用枠）の最後のブロックは琥珀（needs_input の系統。エラーの赤にしない）
        status: last ? (item.limit ? "needs_input" : item.status) : "done",
        last,
        carried: false,
      });
    }
    if (spans.length === 0) {
      // 持ち越しは、最初に見える待ちと上端（計画の目安の開始と今の早い方。D-105）の遅い方に 20px で置く
      // （夜間の待ちは画面の外になるため）
      const w = item.waits.map((x) => clip(x, day.axis)).find((x) => x !== null);
      const start = Math.max(w?.start ?? day.axis.start, laneTopOf(day, now));
      out.push({
        id: `carry:${item.id}`,
        item,
        at: { start, end: start + 1 },
        span: { id: `carry:${item.id}`, turnIds: [], start, end: start + 1, open: false, aiMs: 0 },
        status: item.status,
        last: true,
        carried: true,
      });
    }
  }
  return out;
}

/** まとめ表示に入れてよいか（5分未満の完了ブロック。W7） */
export function collapsible(b: Block): boolean {
  return (
    !b.carried &&
    !b.span.open &&
    b.status === "done" &&
    b.span.end - b.span.start < AI_SHORT_SPAN_MS
  );
}

/** 同じ項目のひと続きのブロック（列を1つ取り、ラベルは最後のブロックに1つ。D-117） */
export interface Chain {
  /** 最初のブロックの id */
  id: string;
  blocks: Block[];
  /** 列を取る終わり（最後のブロックの後の待ちまで） */
  end: number;
}

/**
 * 同じ項目のブロックを、間が CHAIN_GAP_MS より短いものどうしでつなぐ（D-117）。つないだ間も列を取るので、短い作業を
 * 繰り返す項目の線の間にほかの項目の線を挟まず、項目が列を移らない。extent はブロックが列を取る終わり（待ちを含む）
 */
export function chainsOf(blocks: readonly Block[], extent: (b: Block) => number): Chain[] {
  const out: Chain[] = [];
  const open = new Map<string, Chain>();
  for (const b of [...blocks].sort((x, y) => x.at.start - y.at.start)) {
    const c = open.get(b.item.id);
    if (c && b.at.start - c.end < CHAIN_GAP_MS) {
      c.blocks.push(b);
      c.end = Math.max(c.end, extent(b));
      continue;
    }
    const n = { id: b.id, blocks: [b], end: extent(b) };
    out.push(n);
    open.set(b.item.id, n);
  }
  return out;
}

/** 選択の順（キーボードの j / k） */
export function aiKeysOf(day: DayColumn, now: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const b of [...blocksOf(day, now)].sort((a, b) => a.at.start - b.at.start)) {
    if (seen.has(b.item.id)) continue;
    seen.add(b.item.id);
    out.push(`ai:${b.item.id}`);
  }
  return out;
}

export function AiLane({
  day,
  now,
  tz,
  isSel,
  onPick,
  replies = [],
}: {
  day: DayColumn;
  now: number;
  tz: string;
  isSel: (k: string) => boolean;
  onPick: (k: string) => void;
  /** 自分の番への対応（閉じた待ちの終わりの点のホバーに出す。D-075） */
  replies?: readonly Placement[];
}) {
  const { t, dayLabel } = useI18n();
  const axis = day.axis;
  const pxPerMs = HOUR_PX / 3_600_000;
  // 拡張の時間軸の印（ADR 0015。公開のビルドでは無い）
  const marks = useTimelineMarks({ from: axis.start, to: axis.end });
  // 開いている待ち（D-240 の wait。猶予中を含む）。対応が要るものを前に、問いの印を自分の番に（D-246）
  const waits = useLaneWaits();
  // 後でにした自分の番（スヌーズ・明日へ・時間に置いた）の札
  const laters = useLaneLaters();
  // 前日からの持ち越し（今日の実行が無く待ちだけ）はレーンに描かない。対応待ちの行に出ている（確定デザインの3日ボード。D-114）
  const blocks = blocksOf(day, now).filter((b) => !b.carried);
  // 列はブロックの後に続く待ちの線の分も取る（待ちの点線とほかの AI の線を同じ x に重ねない。確定デザインの3日ボード。D-114）
  const extent = (b: Block): number => {
    if (b.carried) return b.at.end;
    const next = blocks
      .filter((x) => x.item.id === b.item.id && x.at.start > b.at.start)
      .reduce((m, x) => Math.min(m, x.at.start), Number.POSITIVE_INFINITY);
    let end = b.at.end;
    for (const w of b.item.waits) {
      if (w.start < b.at.start || w.start >= next) continue;
      const c = clip({ start: w.start, end: w.open ? Math.max(w.end, now) : w.end }, axis);
      if (c) end = Math.max(end, c.end);
    }
    return end;
  };
  const chains = chainsOf(blocks, extent);
  const chainById = new Map(chains.map((c) => [c.id, c]));
  const { placed, overflow } = layoutAiLane(
    chains.map((c) => ({
      id: c.id,
      start: c.blocks[0]?.at.start ?? c.end,
      // ラベルを付ける最後のブロックは LABELED_MIN_PX の線を描くので、その分も取る
      end: Math.max(c.end, (c.blocks.at(-1)?.at.start ?? c.end) + LABELED_MIN_PX / pxPerMs),
      minPx: LABELED_MIN_PX,
      // 1つのブロックだけの短い完了はまとめてよい（W7）。続きのある項目はまとめない（D-117）
      collapsible: c.blocks.length === 1 && collapsible(c.blocks[0] as Block),
      aiMs: c.blocks.reduce((a, x) => a + x.span.aiMs, 0),
    })),
    { axisStart: axis.start, pxPerMs, maxColumns: MAX_COLS, minPx: MIN_PX, gapPx: 4 },
  );
  const countedIn = (at: Interval | null) => {
    // 0:00〜日付区切りの実行は前日に計上する（D-054）
    const d = at ? countedInDate(day, at) : null;
    if (!d) return undefined;
    const l = dayLabel(d);
    return t("board.countedIn", { day: `${l.weekday} ${l.date}` });
  };
  // クリックは選択と詳細パネル（画面の onPick。UX 監査 A3）
  const pick = (itemId: string) => onPick(`ai:${itemId}`);
  /** 閉じた待ちの点・線のクリック: 返答のタスクのパネル、返答が無ければ AI 詳細パネル */
  const pickEnd = (k: string) => (k.startsWith("ai:") ? pick(k.slice(3)) : onPick(k));
  /** 閉じた待ちの線のホバーとクリック（線は 1px なので当たりを広く取る。D-075） */
  const closedHit = (end: WaitEnd, top: number, h: number, left: number, k: string) => (
    <button
      key={`wh-${end.id}-${k}`}
      type="button"
      tabIndex={-1}
      data-kind="wait-closed"
      title={waitEndText(end, t, tz)}
      onClick={() => pickEnd(end.reply ? `task:${end.reply.task.id}` : `ai:${end.itemId}`)}
      className="absolute cursor-pointer"
      style={{ top, height: h, width: 9, left }}
    />
  );
  const out: ReactNode[] = [];
  const under: ReactNode[] = [];
  /** ブロック → 置いた列（待ち線をその列に引く。まとめに入ったものはまとめの列） */
  const colOf = new Map<string, { column: number; columns: number }>();
  /** ブロック単体で置いた AI 項目（まとめの内訳を選択で開くのは、まとめにしか出ていない項目だけ） */
  const shownAlone = new Set<string>();
  // 線は AI レーンの左に詰めて 12px 間隔で並べ、ラベルは線の右の残りの幅をすべて使う（3日ボードのレビューの「直すこと」1）。
  // ラベルの左端は、ラベルの高さの範囲で動いている線のうち一番右の線の右（ほかの線をまたがない）
  const barX = (column: number) => BAR_LEFT + column * BAR_STEP;
  const labelLeft = (top: number, own: number) => {
    let col = own;
    for (const q of placed)
      if (q.top < top + LABEL_H && top < q.top + q.height) col = Math.max(col, q.column);
    return barX(col) + BAR_W + 6;
  };
  // ラベルは項目の続き（chain）の最後のブロックに1つだけ（D-117。確定画像の R3: 項目ごとにラベルは1つ、題名と今の状態、
  // 長さは合計）。最後のブロックは今の状態で、開いたときの位置（今）に近い。前のブロックは線だけ
  // 今の線（今日の列だけ）。ラベルは今の線に重ねず、重なるものは線の下へずらす（デイビューと同じ規則。lane-labels.ts）
  const nowY = day.phase === "today" ? yOf(now, axis.start) : null;
  const labelTop = (p: (typeof placed)[number]): number => {
    const c = p.kind === "summary" ? null : chainById.get(p.id);
    const tail = c?.blocks.at(-1);
    return belowNow(tail ? yOf(tail.at.start, axis.start) : p.top, LABEL_H, nowY);
  };
  // ラベルの重なり（B-3）: 先に始まったラベルが場所を取る。後のラベルは (1) 2 行目（長さ · 放置）を消して 1 行にする
  // (2) 題名の行がまだ重なるなら出さず、先のラベルに `+1` を添える（ホバーで内訳）
  // 重なるラベルは対応が要るものを先に（D-246）: 自分の番 → 実行中 → 完了・PR。後のものが先のラベルの `+N` に畳まれる
  const rankOf = (p: (typeof placed)[number]): number => {
    const tail = p.kind === "summary" ? undefined : chainById.get(p.id)?.blocks.at(-1);
    if (!tail) return 2;
    return laneRank(tail.status, tail.last ? waits.get(tail.item.id) : undefined);
  };
  const order = [...placed].sort(
    (x, y) => rankOf(x) - rankOf(y) || labelTop(x) - labelTop(y) || x.column - y.column,
  );
  const shownLabels: { id: string; top: number; h: number }[] = [];
  const merged = new Map<string, string[]>();
  const hiddenLabel = new Set<string>();
  /** 2 行目を消して 1 行にしたラベル */
  const oneLine = new Set<string>();
  for (const p of order) {
    const top = labelTop(p);
    const overlapsAt = (h: number) => shownLabels.find((l) => top < l.top + l.h && l.top < top + h);
    const hit = overlapsAt(LABEL_LINE_PX);
    if (hit) {
      hiddenLabel.add(p.id);
      merged.set(hit.id, [...(merged.get(hit.id) ?? []), p.id]);
      continue;
    }
    const tight = overlapsAt(LABEL_H) !== undefined;
    if (tight) oneLine.add(p.id);
    shownLabels.push({ id: p.id, top, h: tight ? LABEL_LINE_PX : LABEL_H });
  }
  const titleOfBox = (id: string) => {
    const c = chainById.get(id);
    const b = c?.blocks.at(-1);
    if (b) return `${fmtClock(b.at.start, tz)} ${b.item.title ?? t("common.none")}`;
    const g = placed.find((x) => x.id === id);
    return g?.kind === "summary"
      ? t("board.runsGroup", { count: g.ids.length, time: fmtDuration(g.aiMs) })
      : "";
  };
  const moreOf = (id: string) => {
    const xs = merged.get(id);
    return xs && xs.length > 0 ? { count: xs.length, hint: xs.map(titleOfBox).join("\n") } : null;
  };
  // 画面の上端に残すラベル（sticky）の段: 同じ時間に動いている、より左の列のラベルの数だけ下へずらす（D-117）
  const labeled = placed.filter((p) => p.kind !== "summary" && !hiddenLabel.has(p.id));
  const stickyTopOf = (p: (typeof placed)[number]) =>
    4 +
    LABEL_H *
      labeled.filter(
        (q) => q.column < p.column && q.top < p.top + p.height && p.top < q.top + q.height,
      ).length;
  for (const p of placed) {
    const slot = { column: p.column, columns: p.columns };
    const x = barX(p.column);
    if (p.kind === "summary") {
      for (const id of p.ids)
        for (const b of chainById.get(id)?.blocks ?? []) colOf.set(b.id, slot);
      continue;
    }
    const chain = chainById.get(p.id);
    if (!chain) continue;
    const tail = chain.blocks.at(-1) as Block;
    const m = metaOf(tail, now, day, t, tz, laters.get(tail.item.id));
    // 問いで止まっている最後の線（猶予中を含む。D-246）: 右は `待ち 3m`（猶予中は `猶予 3m`）
    const tailWait = tail.last ? waits.get(tail.item.id) : undefined;
    const qWait =
      tail.item.status === "needs_input" || tail.item.status === "error" || tail.item.limit
        ? null
        : questionWait(tailWait);
    const right = qWait
      ? t(qWait.grace ? "turn.graceShort" : "turn.waitLabel", {
          time: fmtDuration(Math.max(0, now - qWait.since)),
        })
      : m.kind === "time" && chain.blocks.length > 1
        ? fmtDuration(chain.blocks.reduce((a, y) => a + y.span.aiMs, 0))
        : m.right;
    for (const b of chain.blocks) {
      const isTail = b === tail;
      const bare = !isTail || hiddenLabel.has(p.id);
      const single = oneLine.has(p.id);
      const top = yOf(b.at.start, axis.start);
      // 線は実行の長さだけ（列は待ちの分も取ってある）。ラベルを付ける線は LABELED_MIN_PX まで伸ばし、短い作業（8m など）も
      // 題名の行と並ぶ長さにする（D-117）。ラベル（2行）は線より高いことがあるので、要素はラベルの高さを取り、線の高さは別に渡す
      const barH = Math.max(isTail ? LABELED_MIN_PX : MIN_PX, yOf(b.at.end, b.at.start));
      const style: React.CSSProperties = {
        top,
        height: bare ? barH : Math.max(barH, single ? LABEL_LINE_PX : LABEL_H),
        left: x,
        ...(bare ? { width: BAR_W + 6 } : { right: 4 }),
      };
      // ラベルを他の線の右へ寄せるとき、線は自分の位置に残す（ラベルだけ右へ）
      const shift = bare ? 0 : labelLeft(top, p.column) - x - BAR_W - 6;
      const drop = bare ? 0 : belowNow(top, single ? LABEL_LINE_PX : LABEL_H, nowY) - top;
      colOf.set(b.id, slot);
      shownAlone.add(b.item.id);
      // ドラッグで自分レーンへ（確認タスク）・別の AI カードへ（統合）。日付カラムへは落とせない（ux-mvp 7章）
      out.push(
        <DraggableAi
          key={b.id}
          dragId={b.id}
          workItemId={b.item.id}
          title={b.item.title}
          style={style}
        >
          <AiRunBlock
            title={bare ? null : b.item.title}
            status={b.last ? laneStatus(b.status, tailWait) : b.status}
            later={b.last && laters.has(b.item.id)}
            barHeight={barH}
            stickyTop={stickyTopOf(p)}
            hover={aiHoverOf(b.item, now, t("ai.scratch"))}
            item={b.item}
            estimated={b.last && b.item.estimated}
            sources={b.item.sources}
            right={bare ? null : right}
            sub={bare || single ? null : m.sub}
            more={bare ? null : moreOf(p.id)}
            bare={bare}
            shift={shift}
            drop={drop}
            selected={isSel(`ai:${b.item.id}`)}
            carried={b.carried ? b.item.carriedFrom : null}
            hint={b.carried ? undefined : countedIn(b.at)}
            onClick={() => pick(b.item.id)}
            workItemId={b.item.id}
            style={FILL}
          />
        </DraggableAi>,
      );
    }
  }
  for (const p of placed) {
    if (p.kind !== "summary") continue;
    const members = p.ids.flatMap((id) => chainById.get(id)?.blocks ?? []);
    out.push(
      <RunsGroup
        key={p.id}
        box={p}
        blocks={members}
        tz={tz}
        hint={countedIn({ start: p.start, end: p.end })}
        selectedInside={members.some((b) => isSel(`ai:${b.item.id}`))}
        onlyHere={members.some((b) => isSel(`ai:${b.item.id}`) && !shownAlone.has(b.item.id))}
        isSel={isSel}
        onPick={pick}
        bare={hiddenLabel.has(p.id)}
        style={{ top: p.top, height: p.height, left: barX(p.column), right: 4 }}
      />,
    );
  }
  for (const o of overflow) {
    out.push(
      <div
        key={`of-${o.top}`}
        className="absolute right-1 rounded-chip border border-line bg-raised px-1 text-fg2 text-micro"
        style={{ top: o.top }}
        title={o.hidden.length.toString()}
      >
        +{o.hidden.length}
      </div>,
    );
  }
  // 閉じた待ちの終わり（D-075）と、点を置く列（その待ちの最後の線の列）
  const ends = waitEndsOf(day.aiLane ?? [], replies, day.timeEntries);
  const endById = new Map(ends.map((e) => [e.id, e]));
  const endCol = new Map<string, { column: number; columns: number }>();
  const idleLabels: (TagRequest & { text: string; top: number; height: number; x: number })[] = [];
  // 待ち線（その AI 項目の列に、待ちの始まりから引く。列は待ちの直前のブロックのもの）。線は AI の線と同じ x に続ける
  for (const item of day.aiLane ?? []) {
    const open = openWaitKeys(item.waits);
    const mine = blocks
      .filter((b) => b.item.id === item.id && colOf.has(b.id))
      .sort((a, b) => a.at.start - b.at.start);
    // 前日からの持ち越しは待ちの線を今日の列に引かない（対応待ちの行に出ている。確定デザインの3日ボードに無い。D-114）
    if (mine.length === 0 || mine.every((b) => b.carried)) continue;
    const colFor = (start: number) => {
      const b = [...mine].reverse().find((x) => x.at.start <= start) ?? mine[0];
      return colOf.get(b?.id ?? "") as { column: number; columns: number };
    };
    const segs = item.waits
      .map((w) => ({
        w,
        c: clip({ start: w.start, end: w.open ? Math.max(w.end, now) : w.end }, axis),
      }))
      .filter((x): x is { w: (typeof item.waits)[number]; c: Interval } => x.c !== null);
    // 同じ待ちの放置をまとめてラベルの長さにする（10分以上だけ。D-028）
    const idleTotal = new Map<string, number>();
    for (const { w, c } of segs)
      if (w.idle) idleTotal.set(w.waitKey, (idleTotal.get(w.waitKey) ?? 0) + (c.end - c.start));
    /** 開いている放置の線の範囲（待ちごと）。ラベルの望む位置は最初の線の中ほど */
    const idleRange = new Map<string, { x: number; top: number; bottom: number; want: number }>();
    for (const { w, c } of segs) {
      const col = colFor(c.start);
      const top = yOf(c.start, axis.start);
      const h = Math.max(1, yOf(c.end, c.start));
      // 目立たせるのは開いている待ちだけ。閉じた待ちは区分によらず 1px 灰色点線（D-075）
      const live = open.has(w.waitKey);
      const end = live ? undefined : endById.get(`${item.id}:${w.waitKey}`);
      if (end) endCol.set(end.id, col);
      const idle = live && w.idle;
      const x = barX(col.column) + (idle ? 0 : 1);
      out.push(
        <div
          key={`w-${item.id}-${w.waitKey}-${c.start}`}
          className="pointer-events-none absolute"
          data-wait={live ? (w.idle ? "idle" : "other") : "closed"}
          data-wait-item={item.id}
          data-wait-key={w.waitKey}
          data-wait-open={w.open ? "1" : "0"}
          style={{
            top,
            height: h,
            left: x,
            borderLeft: idle
              ? `3px dotted ${TONE[w.tone] ?? "var(--dl-turn)"}`
              : "1px dotted var(--dl-text-3)",
          }}
        />,
      );
      // ブロックより下に敷く（ブロックのクリックを奪わない）
      if (end) under.push(closedHit(end, top, h, barX(col.column) - 3, `${c.start}`));
      if (idle) {
        const r = idleRange.get(w.waitKey);
        if (r) r.bottom = top + h;
        else
          idleRange.set(w.waitKey, {
            x: barX(col.column),
            top,
            bottom: top + h,
            want: top + h / 2 - LABEL_PX / 2,
          });
      }
    }
    // 放置のラベル（10分以上。D-028）。線の右に置き、AI のラベル・ほかのラベルと重ならない位置に（置けなければホバーだけ）
    for (const [waitKey, r] of idleRange) {
      const total = idleTotal.get(waitKey) ?? 0;
      if (total < 10 * 60_000) continue;
      idleLabels.push({
        id: `${item.id}\u0000${waitKey}`,
        minLeft: r.x + 8,
        want: r.want,
        lo: r.top,
        hi: r.bottom - LABEL_PX,
        weight: total,
        text: t("board.idleLabel", { time: fmtDuration(total) }),
        top: r.top,
        height: r.bottom - r.top,
        x: r.x,
      });
    }
  }
  // 札は題名のラベルの後に場所を取る（デイビューと同じ規則。題名・ほかの札・今の線と重ねない。lane-labels.ts）
  const labelTops = placeTags(
    idleLabels,
    shownLabels.map((l) => ({ top: l.top, height: l.h })),
    { tagPx: LABEL_PX, nowY },
  );
  for (const l of idleLabels) {
    // 3日ボードは放置を AI のラベルの2行目（`2h29m · 放置 36m`）に出し、線の横には出さない（確定デザイン。D-114）
    const y = HIDE_IDLE_LABELS ? null : labelTops.get(l.id);
    if (y === null || y === undefined) {
      // 置けない（短い区間の方）: ラベルは省き、線のホバーで出す
      under.push(
        <div
          key={`lh-${l.id}`}
          data-kind="idle-hover"
          title={l.text}
          className="absolute"
          style={{ top: l.top, height: Math.max(6, l.height), width: 9, left: l.x - 3 }}
        />,
      );
      continue;
    }
    out.push(
      <div
        key={`l-${l.id}`}
        data-wait-label="idle"
        className="pointer-events-none absolute overflow-hidden whitespace-nowrap text-fg2 text-meta"
        style={{ top: y.top, left: y.left, right: 4 }}
      >
        <Nums text={l.text} />
      </div>,
    );
  }
  // 待ちに結び付かない返答の点: その AI 項目の、返答の時刻より前に始まった最後のブロックの列
  const replyCol = (wi: string | null, at: number) => {
    const mine = blocks
      .filter((b) => b.item.id === wi && colOf.has(b.id))
      .sort((a, b) => a.at.start - b.at.start);
    const b = [...mine].reverse().find((x) => x.at.start <= at) ?? mine[0];
    return b ? (colOf.get(b.id) ?? null) : null;
  };
  out.push(
    <WaitDots
      key="wait-ends"
      ends={ends}
      axis={axis}
      pxPerMs={pxPerMs}
      colOf={(e) => {
        const c = endCol.get(e.id) ?? replyCol(e.itemId, e.at);
        return c ? { column: 0, columns: 1, dx: barX(c.column) } : null;
      }}
      x={1}
      tz={tz}
      isSel={isSel}
      onPick={pickEnd}
    />,
  );
  out.push(
    <TimelineMarks
      key="ext-marks"
      marks={marks}
      axisStart={axis.start}
      pxPerMs={pxPerMs}
      tz={tz}
      barX={barX}
      busyColumn={(top, bottom) =>
        placed
          .filter((q) => q.top < bottom && top < q.top + Math.max(q.height, LABEL_H))
          .reduce((m, q) => Math.max(m, q.column), -1)
      }
    />,
  );
  return (
    <>
      {under}
      {out}
    </>
  );
}

/** 高さに応じた題名の行数（最大4行。D-074） */
export function titleLines(height: number): number {
  return Math.max(1, Math.min(4, Math.floor((height - 2) / 18)));
}

/** 待ちの長さの起点（開いている待ちの最初の区分から。区分ごとの始まりではない） */
function waitStartOf(item: AiLaneItem): number | null {
  const openWait = item.waits.find((w) => w.open);
  if (!openWait) return null;
  return Math.min(...item.waits.filter((w) => w.waitKey === openWait.waitKey).map((w) => w.start));
}

/**
 * ラベルの2行目: ブロックの AI 時間（稼働中は今まで）と、最後のブロックの放置（`2h15m · 放置 50m`）。
 * 自分を待って止まっている最後のブロック（ブロック中・エラー）は、状態の名前と待ちの長さ（`ブロック中 12m`）
 */
export function metaOf(
  b: Block,
  now: number,
  day: DayColumn,
  t: ReturnType<typeof useI18n>["t"],
  tz: string,
  /** 後でにした自分の番の札（明日へ / 後で）。あれば放置の長さの代わりに出す */
  later?: MessageKey | null,
): { right: string | null; sub: string | null; kind: "time" | "wait" } {
  if (b.carried) return { right: null, sub: null, kind: "wait" };
  // 上限待ち（利用枠で止まった）: 明ける時刻（`利用上限 · 15:00 まで`）、分からなければ止まってからの長さ
  const limit = b.last ? b.item.limit : undefined;
  if (limit)
    return {
      right: limit.untilKnown
        ? t("board.limitUntil", { time: fmtClock(limit.until, tz) })
        : t("board.limitWaiting", { time: fmtDuration(Math.max(0, now - limit.since)) }),
      sub: null,
      kind: "wait",
    };
  const ws = waitStartOf(b.item);
  // 自分を待って止まっている最後のブロックは待ちの種類と長さ（`許可待ち 12m`。確定デザイン）
  if (b.last && ws !== null && b.item.status === "needs_input")
    return {
      right: `${t(b.item.reason === "ask_user_question" ? "board.needsAnswer" : "board.needsPermission")} ${fmtDuration(now - ws)}`,
      sub: null,
      kind: "wait",
    };
  if (b.last && ws !== null && b.item.status === "error")
    return { right: `${t("status.error")} ${fmtDuration(now - ws)}`, sub: null, kind: "wait" };
  // 後でにした自分の番（スヌーズ・明日へ・時間に置いた）: 放置の長さの代わりに `明日へ` / `後で`（スヌーズ中は放置に数えない）
  if (b.last && later) return { right: fmtDuration(b.span.aiMs), sub: t(later), kind: "time" };
  // 自分の番も長さと放置（`2h29m · 放置 36m`。待ちの長さは対応待ちの行に出ている）
  let idle = 0;
  if (b.last)
    for (const w of b.item.waits) {
      if (!w.idle) continue;
      const c = clip({ start: w.start, end: w.open ? Math.max(w.end, now) : w.end }, day.axis);
      if (c) idle += c.end - c.start;
    }
  return {
    right: fmtDuration(b.span.aiMs),
    sub: idle >= 60_000 ? t("board.idleLabel", { time: fmtDuration(idle) }) : null,
    kind: "time",
  };
}

/**
 * 短い完了ブロックのまとめ表示（W7。W4 と同じ部品の振る舞い）: `✓ 5 runs · 3m`。ホバーで内訳（時刻・題名・AI 時間）、
 * クリックで内訳を開き、1件ずつ選んで詳細パネルを開ける
 */
function RunsGroup({
  box,
  blocks,
  tz,
  hint,
  selectedInside,
  onlyHere,
  isSel,
  onPick,
  style,
  bare = false,
}: {
  /** ラベルを出さない（重なるので先のラベルの `+1` にまとめた） */
  bare?: boolean;
  box: Extract<AiLaneBox, { kind: "summary" }>;
  blocks: Block[];
  tz: string;
  hint?: string | undefined;
  /** 内訳のどれかの AI 項目を選んでいる */
  selectedInside: boolean;
  /** 選んでいる AI 項目がこのまとめにしか出ていない（j / k で選んだときも内訳を開く） */
  onlyHere: boolean;
  isSel: (k: string) => boolean;
  onPick: (itemId: string) => void;
  style: React.CSSProperties;
}) {
  const { t } = useI18n();
  // クリックで開き、内訳の外の項目を選んだら閉じる
  const [clicked, setClicked] = useState(false);
  const open = onlyHere || (clicked && selectedInside);
  const lines = blocks.map(
    (b) =>
      `${fmtClock(b.span.start, tz)}–${fmtClock(b.span.end, tz)}  ${b.item.title ?? t("common.none")} · ${fmtDuration(b.span.aiMs)}`,
  );
  return (
    <div className="absolute" style={{ ...style, zIndex: open ? 30 : 1 }}>
      <button
        type="button"
        tabIndex={-1}
        data-kind="runs-group"
        title={[...lines, ...(hint ? [hint] : [])].join("\n")}
        onClick={() => {
          const first = blocks[0];
          setClicked(true);
          if (first) onPick(first.item.id);
        }}
        className={`flex h-full items-stretch gap-1.5 rounded-control text-left ${bare ? "w-[9px]" : "w-full"} ${
          open ? "outline outline-[1.5px] outline-accent outline-offset-2" : ""
        }`}
      >
        <span className="w-[3px] shrink-0 rounded-full bg-done" />
        {bare ? null : (
          <span className="flex h-[18px] min-w-0 items-center text-fg2">
            <span className="truncate text-meta">
              <Nums
                text={t("board.runsGroup", { count: box.ids.length, time: fmtDuration(box.aiMs) })}
              />
            </span>
          </span>
        )}
      </button>
      {open ? (
        <div className="absolute top-full left-0 mt-1 flex min-w-[280px] flex-col gap-0.5 rounded-pop border border-line bg-raised p-1 shadow-pop">
          {blocks.map((b) => (
            <AiRunBlock
              key={b.id}
              title={b.item.title}
              status={b.status}
              estimated={false}
              sources={b.item.sources}
              right={`${fmtClock(b.span.start, tz)} · ${fmtDuration(b.span.aiMs)}`}
              selected={isSel(`ai:${b.item.id}`)}
              onClick={() => onPick(b.item.id)}
              compact
              style={{ position: "relative", height: 24, width: "100%" }}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
