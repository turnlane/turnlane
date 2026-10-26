/**
 * 時間に置いた自分の番（待ちの集計外 `scheduled` と同じ区間）: タスクの時間ブロックを作った時刻から開始までは、帯・件数・通知に
 * 出さず「後で」に出す（ux-mvp 4.6）。区間は `[ブロックを作った時刻, ブロックの開始)`。重なる区間はつなげて、いまを含む区間の
 * 終わり（帯に戻る時刻）を返す。いまがどの区間にも入っていなければ null（開始が来た・過去に置いた・置いていない）
 */
export function scheduledUntil(
  blocks: readonly (readonly [createdAt: number, startAt: number])[],
  now: number,
): number | null {
  const rs = blocks
    .filter(([s, e]) => e > s)
    .map(([s, e]) => [s, e] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  let cur: [number, number] | null = null;
  for (const r of rs) {
    if (cur && r[0] <= cur[1]) cur[1] = Math.max(cur[1], r[1]);
    else {
      if (cur && cur[0] <= now && now < cur[1]) return cur[1];
      cur = [r[0], r[1]];
    }
  }
  return cur && cur[0] <= now && now < cur[1] ? cur[1] : null;
}
