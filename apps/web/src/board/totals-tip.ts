/**
 * 見出しの集計のホバー（R79）: 1 行目に定義、続けて内訳を 1 件 1 行（3 件まで、超えた分は「ほか N 件」）。
 * 期限切れは期限切れになった件の件名と閉じた時刻、放置はリポジトリ別の放置（デイビューだけ。3日ボード・週表示の列には内訳が無い）
 */
import { type ClosedTodayRow, fmtClock, fmtDuration } from "@turnlane/core/web";

/** ホバーに出す内訳の上限 */
export const TIP_MAX = 3;
/** 件名の上限（文字。超えたら … で切る。ツールチップは 360px まで） */
const SUBJECT_MAX = 40;

function clip(s: string, n = SUBJECT_MAX): string {
  const xs = [...s.replace(/\s+/g, " ").trim()];
  return xs.length > n ? `${xs.slice(0, n - 1).join("")}…` : xs.join("");
}

/** 上限まで 1 行ずつ。超えた分は more(N) の 1 行 */
export function tipLines<T>(
  xs: readonly T[],
  line: (x: T) => string,
  more: (n: number) => string,
  max = TIP_MAX,
): string[] {
  const shown = xs.slice(0, max).map(line);
  return xs.length > max ? [...shown, more(xs.length - max)] : shown;
}

/**
 * 期限切れの内訳: 期限切れで閉じた件を閉じた順に `件名 · 9:00`。件名は「今日閉じた」の行と同じ（D-227 の件名の順。
 * 自分で付けた名前 → 直近の指示 → 作ったときの件名。subject に渡す）
 */
export function expiredTipLines<R extends Pick<ClosedTodayRow, "kind" | "closedAt">>(
  rows: readonly R[],
  o: {
    subject: (row: R) => string;
    tz: string;
    more: (n: number) => string;
  },
): string[] {
  const xs = rows.filter((r) => r.kind === "expired").sort((a, b) => a.closedAt - b.closedAt);
  return tipLines(xs, (r) => `${clip(o.subject(r))} · ${fmtClock(r.closedAt, o.tz)}`, o.more);
}

/** 内訳に出す期限切れの行（閉じた順の先頭 TIP_MAX 件。件名の直近の指示を読む行） */
export function expiredShown<R extends Pick<ClosedTodayRow, "kind" | "closedAt">>(
  rows: readonly R[],
): R[] {
  return rows
    .filter((r) => r.kind === "expired")
    .sort((a, b) => a.closedAt - b.closedAt)
    .slice(0, TIP_MAX);
}

/** 放置の内訳: リポジトリ別の放置を長い順に `api-gateway 22m`（0 は出さない） */
export function idleTipLines(
  byRepo: readonly { repoRoot: string | null; scratch?: boolean; ms: number }[],
  o: {
    name: (x: { repoRoot: string | null; scratch?: boolean }) => string;
    more: (n: number) => string;
  },
): string[] {
  const xs = byRepo.filter((x) => x.ms > 0).sort((a, b) => b.ms - a.ms);
  return tipLines(xs, (x) => `${clip(o.name(x))} ${fmtDuration(x.ms)}`, o.more);
}

/** ホバーの文（定義の下に内訳）。改行で区切る（ツールチップは改行を残す） */
export function totalsTip(def: string, lines: readonly string[]): string {
  return [def, ...lines].join("\n");
}
