/**
 * AI のレーンの予定の帯（報告の state scheduled。0.8.1）: 自分のレーンの時間ブロックの AI 版。始める時刻（at）の位置に、
 * 薄い面と題名、`予定 · 22:00` の札、出どころ · プロジェクト。まだ動いていないので AI の項目ではない（実行中・AI 時間に
 * しない）。時刻を 30 分過ぎても始まらなければ札を `予定の時刻を過ぎています` にする（自分の番にはしない）。
 * 3 日ボード・週表示の AI のレーンとデイビューで共通。クリック・⏎ で予定の詳細パネル（PlanPanel）を開く
 */
import type { ReportPlanView } from "@turnlane/core/web";
import { fmtClock } from "@turnlane/core/web";
import { useI18n } from "../i18n/index.tsx";
import { clockOrDate } from "../lib/back-time.ts";
import { usePanelsAvailable } from "../lib/panels.ts";
import { planKey, setUi } from "../lib/store.ts";

/** 予定の時刻を過ぎたとみなすまでの余裕（デーモンの REPORT_PLAN_LATE_MS と同じ。画面を開いたまま時刻が過ぎても札を変える） */
export const PLAN_LATE_MS = 30 * 60_000;
/** 帯の長さ（予定には長さが無いので 30 分ぶん） */
const PLAN_SPAN_MS = 30 * 60_000;

type PlanTime = Pick<ReportPlanView, "at" | "overdue">;
type Translate = ReturnType<typeof useI18n>["t"];

/**
 * 帯の札（純粋関数）。withDate: 暦の今日でなければ `10/31 22:00`（AI の画面の行・詳細パネル。帯は列が日付を持つので時刻だけ）
 */
export function planLabel(
  p: PlanTime,
  now: number,
  tz: string,
  t: Translate,
  withDate = false,
): string {
  return p.overdue || now > p.at + PLAN_LATE_MS
    ? t("ai.plan.late")
    : t("ai.plan.at", { time: withDate ? clockOrDate(p.at, now, tz) : fmtClock(p.at, tz) });
}

/** 予定の詳細パネルを開く */
export function openPlanPanel(p: Pick<ReportPlanView, "source" | "externalId">): void {
  setUi({ panelPlan: planKey(p) });
}

export function PlanBands({
  plans,
  y,
  tz,
  now,
}: {
  plans: readonly ReportPlanView[];
  /** 時刻 → レーンの中の上端（px） */
  y: (ms: number) => number;
  tz: string;
  now: number;
}) {
  const { t } = useI18n();
  const panels = usePanelsAvailable();
  return (
    <>
      {plans.map((p) => {
        const top = y(p.at);
        const height = Math.max(32, y(p.at + PLAN_SPAN_MS) - top);
        const where = [p.source, p.project].filter(Boolean).join(" · ");
        const label = planLabel(p, now, tz, t);
        return (
          // 予定の面と同じく、ホバーで面を濃くしてクリックできることを示す
          <button
            type="button"
            key={p.id}
            className={`pointer-events-auto absolute inset-x-1 z-[1] flex flex-col overflow-hidden rounded-card border border-line border-dashed bg-sunken/60 px-1.5 py-0.5 text-left text-meta ${panels ? "cursor-pointer hover:border-fg3 hover:bg-sunken" : "cursor-default"}`}
            style={{ top, height }}
            onClick={(e) => {
              e.stopPropagation();
              if (panels) openPlanPanel(p);
            }}
            onPointerDown={(e) => e.stopPropagation()}
            data-testid="ai-plan"
            data-plan-id={p.id}
            data-late={p.overdue || now > p.at + PLAN_LATE_MS ? "" : undefined}
            title={[p.title ?? p.externalId, label, where].filter(Boolean).join("\n")}
          >
            <span className="truncate font-medium text-fg">{p.title ?? p.externalId}</span>
            <span className="truncate text-fg2">
              {label}
              {where ? ` · ${where}` : ""}
            </span>
          </button>
        );
      })}
    </>
  );
}
