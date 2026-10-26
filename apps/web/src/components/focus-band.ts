/**
 * 集中モード中の帯の文言（ux-mvp 4.15、design README R18・WD4。純粋関数）。
 * `集中モード · 「定例」の間 · 14:58 まで · 残り 30m` と右端の `止めた通知 1`（0 件なら `自分の番の通知を止めています`）。
 * 時刻と残り時間は mono で出すので、区切り（·）ごとのまとまりを、文字・mono・題名の断片に分けて返す。
 * 残り時間は分の切り上げ（14:57:30 なら `残り 1m`）。題名は会議でも「この予定の間は集中する」の予定でもあれば出す
 */
import { fmtClock, fmtDuration } from "@turnlane/core/web";
import type { AnyMessageKey, Params } from "../i18n/index.tsx";

const MIN = 60_000;

export interface BandSeg {
  text: string;
  kind: "text" | "mono" | "title";
}

export interface FocusBandText {
  /** 区切り（·）で並べるまとまり */
  groups: BandSeg[][];
  /** 右端（終了のボタンの左） */
  right: string;
  /** 止めた通知があるか（右端を件数で出す） */
  held: boolean;
}

type T = (key: AnyMessageKey, params?: Params) => string;

/** 辞書の `{name}` を断片に分ける（差し込む値はその断片の種類のまま） */
function segs(template: string, values: Record<string, BandSeg>): BandSeg[] {
  const out: BandSeg[] = [];
  for (const [i, part] of template.split(/\{(\w+)\}/).entries()) {
    if (i % 2 === 1) {
      const v = values[part];
      if (v) out.push(v);
    } else if (part) out.push({ text: part, kind: "text" });
  }
  return out;
}

/** 残り時間（分の切り上げ。`30m` / `1h5m`） */
export function focusLeft(until: number, now: number): string {
  const left = Math.max(0, until - now);
  return fmtDuration(Math.ceil(left / MIN) * MIN);
}

export function focusBandText(
  active: { until: number; title: string | null },
  held: number,
  now: number,
  tz: string,
  t: T,
): FocusBandText {
  const title = active.title?.trim();
  const groups: BandSeg[][] = [[{ text: t("focus.band.name"), kind: "text" }]];
  if (title) groups.push(segs(t("focus.band.during"), { title: { text: title, kind: "title" } }));
  groups.push(
    segs(t("focus.band.until"), { time: { text: fmtClock(active.until, tz), kind: "mono" } }),
  );
  groups.push(
    segs(t("focus.band.left"), { left: { text: focusLeft(active.until, now), kind: "mono" } }),
  );
  return {
    groups,
    right: held > 0 ? t("focus.band.held", { count: held }) : t("focus.muted"),
    held: held > 0,
  };
}

/** 帯の文を1行の文字にする（title 属性・読み上げ・テスト） */
export function bandPlain(b: FocusBandText): string {
  return b.groups.map((g) => g.map((s) => s.text).join("")).join(" · ");
}
