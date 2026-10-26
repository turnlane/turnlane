/**
 * ⌘K の一致（m2-api.md 17章、ux-mvp 6.1）: 空白で区切った語をすべて含む（大文字小文字を区別しない部分一致。AND）。
 * サーバーの検索とクライアントのコマンド・画面の絞り込みが同じ規則を使う。語の先頭の `#` は外す（`#142` → `142`）
 */

export function searchTokens(q: string): string[] {
  return q
    .toLowerCase()
    .split(/\s+/u)
    .map((t) => t.replace(/^#+/u, ""))
    .filter((t) => t.length > 0);
}

/** すべての語を含めば true。語が無ければ true */
export function matchesAll(haystack: string, tokens: readonly string[]): boolean {
  const h = haystack.toLowerCase();
  return tokens.every((t) => h.includes(t));
}

/**
 * 並べるための点数（大きいほど上）。一致しなければ -1。
 * 先頭からの一致 > 語の頭での一致 > 途中の一致。短い文字列を少し上にする
 */
export function matchScore(haystack: string, tokens: readonly string[]): number {
  if (tokens.length === 0) return 0;
  const h = haystack.toLowerCase();
  let score = 0;
  for (const t of tokens) {
    const i = h.indexOf(t);
    if (i < 0) return -1;
    if (i === 0) score += 3;
    else if (/[\s\-_/.·:(#]/u.test(h[i - 1] ?? "")) score += 2;
    else score += 1;
  }
  return score + 1 / (1 + h.length / 40);
}

/** 表示の文字列で一致した範囲（太字にする）。重なりはまとめる */
export function matchRanges(text: string, tokens: readonly string[]): [number, number][] {
  const lower = text.toLowerCase();
  const out: [number, number][] = [];
  for (const t of tokens) {
    let from = 0;
    for (;;) {
      const i = lower.indexOf(t, from);
      if (i < 0) break;
      out.push([i, i + t.length]);
      from = i + t.length;
    }
  }
  out.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const r of out) {
    const last = merged.at(-1);
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  return merged;
}
