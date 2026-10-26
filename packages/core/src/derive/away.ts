/**
 * 離れていた間のまとめ（ux-mvp 4.13、D-214 (2)）の判定。純粋関数（時計は引数）。
 *
 * - 離席: 在席の区間（T を足して和集合にしたもの。開始順）の間が `AWAY_GAP_MS`（10 分）以上空いたところ。今も在席して
 *   いる（最後の区間が今に続いている）ときだけ、いちばん新しい離席を選ぶ（10 分未満の間は離席にしない＝前の離席を
 *   置き換えない）。夜をまたいだ離席も同じ（昨日の最後の在席から今朝の最初の在席まで）
 * - 出す間: 戻ってから `AWAY_SHOW_MS`（30 分）まで。閉じた印（戻った時刻）と同じなら出さない。並んだ件のどれかを
 *   戻った後に開いた（engage）なら出さない。新しい離席が来れば印が変わるので、前のまとめは消える
 * - 中身: 離席の区間 [from, to) に起きた AI の項目の変化。1 件に 1 つ、強い順（待ち > エラー > PR > 完了）で代表を選び、
 *   時刻の順に並べる。1 件も無ければ出さない
 */
import type { AwayGroup, AwayKind } from "../api/away.ts";
import { PRESENCE_MAX_GAP_MS } from "./presence.ts";

/** これ以上在席が切れたら離席（戻ったときにまとめを出す） */
export const AWAY_GAP_MS = 10 * 60_000;
/** 戻ってからまとめを出す長さ */
export const AWAY_SHOW_MS = 30 * 60_000;
/** 前の在席をさかのぼる長さ（週末をまたいだ月曜の朝まで。これより前に在席が無ければ「いつから」が言えないので出さない） */
export const AWAY_LOOKBACK_MS = 72 * 3_600_000;

export interface AwayGap {
  /** 最後に在席していた時刻 */
  from: number;
  /** 戻った時刻 */
  to: number;
}

/**
 * いちばん新しい離席（今も在席しているときだけ）。presence は T を足して和集合にした在席の区間（開始順）。
 * 今が最後の区間の中か、最後の区間の終わりからサンプルの間（`PRESENCE_MAX_GAP_MS`）未満なら在席
 */
export function awayGap(
  presence: readonly (readonly [number, number])[],
  now: number,
  minGapMs: number = AWAY_GAP_MS,
): AwayGap | null {
  const spans = presence.filter(([s]) => s <= now);
  const last = spans.at(-1);
  if (!last) return null;
  if (now > last[1] && now - last[1] >= PRESENCE_MAX_GAP_MS) return null;
  for (let i = spans.length - 1; i > 0; i--) {
    const prev = spans[i - 1] as readonly [number, number];
    const cur = spans[i] as readonly [number, number];
    if (cur[0] - prev[1] >= minGapMs) return { from: prev[1], to: cur[0] };
  }
  return null;
}

/** 離席の間に起きた AI の項目の変化（1 件に複数あってよい） */
export interface AwayEvent {
  workItemId: string;
  kind: AwayKind;
  at: number;
  followUpId?: string | null;
  prNumber?: number;
  prRef?: string;
}

export const AWAY_GROUP: Record<AwayKind, AwayGroup> = {
  done: "done",
  pr_opened: "pr",
  pr_merged: "pr",
  question: "wait",
  ask: "wait",
  permission: "wait",
  error: "error",
};

/** 代表を選ぶ強さ（小さいほど強い） */
const RANK: Record<AwayGroup, number> = { wait: 0, error: 1, pr: 2, done: 3 };

export interface AwayPick extends AwayEvent {
  group: AwayGroup;
}

export interface AwayComposed extends AwayGap {
  key: string;
  until: number;
  counts: Record<AwayGroup, number>;
  items: AwayPick[];
}

export interface AwayComposeOptions {
  now: number;
  /** 閉じた印（設定 away.dismissed。戻った時刻の文字列） */
  dismissedKey?: string | null;
  /** 戻った後に開いた（engage した）AI の項目 */
  openedSince?: (workItemId: string, since: number) => boolean;
  showMs?: number;
}

/** まとめの印（戻った時刻） */
export const awayKey = (gap: AwayGap): string => String(gap.to);

/**
 * 離席と、その間の変化からまとめを作る。出さないときは null（出す間を過ぎた・閉じた・並んだ件を開いた・変化が無い）。
 * events は離席の区間の外のものを含んでよい（ここで [from, to) に絞る）
 */
export function composeAway(
  gap: AwayGap | null,
  events: readonly AwayEvent[],
  o: AwayComposeOptions,
): AwayComposed | null {
  if (!gap) return null;
  const until = gap.to + (o.showMs ?? AWAY_SHOW_MS);
  if (o.now >= until) return null;
  const key = awayKey(gap);
  if (o.dismissedKey === key) return null;
  const best = new Map<string, AwayPick>();
  for (const e of events) {
    if (e.at < gap.from || e.at >= gap.to) continue;
    const group = AWAY_GROUP[e.kind];
    const cur = best.get(e.workItemId);
    if (!cur || RANK[group] < RANK[cur.group] || (RANK[group] === RANK[cur.group] && e.at > cur.at))
      best.set(e.workItemId, { ...e, group });
  }
  const items = [...best.values()].sort(
    (a, b) => a.at - b.at || a.workItemId.localeCompare(b.workItemId),
  );
  if (items.length === 0) return null;
  if (o.openedSince && items.some((x) => o.openedSince?.(x.workItemId, gap.to))) return null;
  const counts: Record<AwayGroup, number> = { done: 0, pr: 0, wait: 0, error: 0 };
  for (const x of items) counts[x.group]++;
  return { ...gap, key, until, counts, items };
}
