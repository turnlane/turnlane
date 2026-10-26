import { generateKeyBetween, generateNKeysBetween } from "fractional-indexing";

/**
 * レーン内の並び順（fractional indexing。task.lane_order）。
 * キーは ASCII で、SQLite の既定の BINARY 照合順序でそのまま並ぶ。
 * before / after は「この2つの間に入れる」の下限と上限。null は端を表す。
 */
export function orderKeyBetween(before: string | null, after: string | null): string {
  return generateKeyBetween(before, after);
}

/** before と after の間に n 個のキーを昇順で作る（一括の並べ替え用）。 */
export function orderKeysBetween(before: string | null, after: string | null, n: number): string[] {
  return generateNKeysBetween(before, after, n);
}

/** 末尾に追加するときのキー */
export function orderKeyAfter(last: string | null): string {
  return generateKeyBetween(last, null);
}

/** 先頭に追加するときのキー */
export function orderKeyBefore(first: string | null): string {
  return generateKeyBetween(null, first);
}
