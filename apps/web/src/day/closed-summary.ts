/**
 * デイビューの右の一覧の「今日閉じたもの」の要約の行（既定で畳む 1 行）: 種類ごとの件数と返事までの中央値。
 * `今日閉じたもの 14 · 返答 3 · 許可 9 · 対応不要 2 · 返事まで 4m`。0 の種類は出さない。純粋関数
 */
import type { ClosedTodayRow, ClosedVia } from "@turnlane/core/web";

/** 一覧の並び（返答済み → 解決（推定）→ 対応不要 → 期限切れ） */
export const CLOSED_ORDER: Record<ClosedTodayRow["kind"], number> = {
  replied: 0,
  resolved: 1,
  not_needed: 2,
  expired: 3,
};

/** 返答済みの閉じ方の並び（閉じ方の無い返答済みは最後の「完了」） */
const VIA_ORDER: ClosedVia[] = [
  "reply",
  "answer",
  "approve",
  "review",
  "merge",
  "resume",
  "manual",
];

export interface ClosedPart {
  /** 種類の名前の訳のキー（閉じた行の右の言葉と同じ訳） */
  key: string;
  count: number;
}

export interface ClosedSummary {
  total: number;
  parts: ClosedPart[];
  /** 人が応えて閉じた行の応答時間の中央値（無ければ null） */
  medianMs: number | null;
}

function keyOf(r: Pick<ClosedTodayRow, "kind" | "via">): string {
  if (r.kind !== "replied") return `day.closed.${r.kind}`;
  return r.via ? `turn.closedVia.${r.via}` : "day.closed.replied";
}

function rank(r: Pick<ClosedTodayRow, "kind" | "via">): number {
  if (r.kind !== "replied") return 100 + CLOSED_ORDER[r.kind];
  const i = r.via ? VIA_ORDER.indexOf(r.via) : -1;
  return i < 0 ? VIA_ORDER.length : i;
}

export function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1
    ? (s[m] as number)
    : Math.round(((s[m - 1] as number) + (s[m] as number)) / 2);
}

export function closedSummary(
  rows: readonly Pick<ClosedTodayRow, "kind" | "via" | "responseMs">[],
): ClosedSummary {
  const counts = new Map<string, { count: number; rank: number }>();
  for (const r of rows) {
    const k = keyOf(r);
    const c = counts.get(k);
    if (c) c.count++;
    else counts.set(k, { count: 1, rank: rank(r) });
  }
  const parts = [...counts.entries()]
    .sort((a, b) => a[1].rank - b[1].rank)
    .map(([key, v]) => ({ key, count: v.count }));
  const ms = rows.map((r) => r.responseMs).filter((x): x is number => typeof x === "number");
  return { total: rows.length, parts, medianMs: median(ms) };
}

/** 一覧の行の順（種類の順、同じ種類の中は閉じた順のまま） */
export function closedInOrder<T extends Pick<ClosedTodayRow, "kind">>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => CLOSED_ORDER[a.kind] - CLOSED_ORDER[b.kind]);
}
