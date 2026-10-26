import { type DayColumn, fmtDuration } from "@turnlane/core/web";

export type TotalsKey =
  | "totals.free"
  | "totals.events"
  | "totals.planned"
  | "totals.idle"
  | "totals.expired"
  | "totals.done"
  | "totals.ai";

export interface TotalsPart {
  text: string;
  drop: number | null;
  /** 計画が空きを超えている分（ms。「計画」の項目だけ。超えていなければ無い。D-192 §2.3） */
  over?: number;
  /** 項目の種類（ホバーの定義と、今日の列の大きな数字「空き」を取り出すのに使う） */
  key?: TotalsKey;
  /** 名前と値を分けたもの（今日の列の大きな数字） */
  label?: string;
  value?: string;
}

/**
 * ヘッダの集計（ux-mvp 4.4）。今日・未来は Free / Events / Planned / Idle / Expired、過去は done / AI / Idle。0 は出さない。
 * 項目の途中では切らない。幅が足りなければ重要度の低い順に項目ごと省く（W6、D-050）:
 * 今日・未来は Events → Planned → Free、過去は AI → done。Idle と Expired は必ず残す（プロダクトの芯の指標）
 */
export function totalsParts(
  day: Pick<DayColumn, "phase" | "totals">,
  t: (key: TotalsKey) => string,
  /**
   * 今日・未来の集計に AI 時間も足す（AI レーンを持たない今日の列。週表示・3日ボードの端の今日。D-074）。
   * 幅が足りないときは Free の次に省く
   */
  withAi = false,
): TotalsPart[] {
  const x = day.totals;
  const parts: TotalsPart[] = [];
  const part = (key: TotalsKey, value: string, drop: number | null): TotalsPart => ({
    text: `${t(key)} ${value}`,
    drop,
    key,
    label: t(key),
    value,
  });
  // 計画が空きを超えたら「計画」の数字を警告色にする（今日と未来だけ。過去の日には計画が無い。D-192 §2.3）
  const over = day.phase !== "past" && x.plannedMs > x.freeMs ? x.plannedMs - x.freeMs : 0;
  if (day.phase === "past") {
    if (x.taskCount > 0)
      parts.push({
        text: `${x.doneCount}/${x.taskCount} ${t("totals.done")}`,
        drop: 1,
        key: "totals.done",
      });
    if (x.aiMs > 0) parts.push(part("totals.ai", fmtDuration(x.aiMs), 0));
    if (x.idleMs > 0) parts.push(part("totals.idle", fmtDuration(x.idleMs), null));
  } else {
    if (x.freeMs > 0) parts.push(part("totals.free", fmtDuration(x.freeMs), 2));
    if (x.eventsMs > 0) parts.push(part("totals.events", fmtDuration(x.eventsMs), 0));
    if (x.plannedMs > 0)
      parts.push({
        ...part(
          "totals.planned",
          `${x.plannedUnestimated > 0 ? "~" : ""}${fmtDuration(x.plannedMs)}`,
          1,
        ),
        ...(over > 0 ? { over } : {}),
      });
    if (withAi && x.aiMs > 0) parts.push(part("totals.ai", fmtDuration(x.aiMs), 3));
    if (x.idleMs > 0) parts.push(part("totals.idle", fmtDuration(x.idleMs), null));
    if (x.expired > 0) parts.push(part("totals.expired", String(x.expired), null));
  }
  return parts;
}

/** 省く数 n のときに残す項目（drop の順位が n 未満のものを省く） */
export function visibleTotals<T extends { drop: number | null }>(parts: T[], n: number): T[] {
  return parts.filter((p) => p.drop === null || p.drop >= n);
}
