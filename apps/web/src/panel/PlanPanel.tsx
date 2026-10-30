/**
 * 予定の詳細パネル（報告の state scheduled。0.8.1。ux-mvp 4.20）: 予定の帯・AI の画面の「後で」の予定の行から開く。
 * 報告の項目の詳細（AiPanel の報告の項目）と同じ小さい作りで、状態は「予定」: 題名、出どころ · プロジェクト、`予定 · 22:00`
 * （暦の今日でなければ `10/31 22:00`）、開く（報告の url があるとき）、流れは `予定 22:00 まだ動いていません` の 1 行、
 * `⋯` は非表示だけ。AI の項目がまだ無いので対象は `report:<source>:<id>`（store の panelPlan）。started などで AI の項目に
 * なったら（SSE で読み直した workItemId）、その項目の AI 詳細パネルに切り替える
 */

import type { ReportItemResponse } from "@turnlane/core/web";
import { CalendarClock, EyeOff } from "lucide-react";
import { useEffect, useState } from "react";
import { PLAN_LATE_MS, planLabel } from "../board/PlanBands.tsx";
import { ContextMenu, type MenuEntry } from "../components/ContextMenu.tsx";
import { sourceBadgeText } from "../components/ui.tsx";
import { hidePlan, openPlan } from "../data/mutations.ts";
import { useQueue, useReportItem } from "../data/queries.ts";
import { useI18n } from "../i18n/index.tsx";
import { keyHint } from "../keys/keymap.ts";
import { clockOrDate } from "../lib/back-time.ts";
import { useNow } from "../lib/clock.ts";
import { parsePlanKey, setUi, useUi } from "../lib/store.ts";
import { ActionButton, MoreButton, PanelFrame, PanelHead } from "./PanelFrame.tsx";

const closePlan = () => setUi({ panelPlan: null });

export function PlanPanel() {
  const key = useUi((s) => s.panelPlan);
  const ref = key ? parsePlanKey(key) : null;
  const { t } = useI18n();
  const q = useReportItem(ref);
  const workItemId = q.data?.workItemId ?? null;
  // started などで AI の項目になった: その項目の詳細に切り替える（setUi が予定のパネルを閉じる）
  useEffect(() => {
    if (key && workItemId) setUi({ panelWorkItemId: workItemId });
  }, [key, workItemId]);
  if (!key || !ref) return null;
  const d = q.data;
  return (
    <PanelFrame label={t("ai.detail")} testId="ai-panel" variant="detail">
      {d?.plan ? (
        <PlanDetail d={d} plan={d.plan} />
      ) : (
        <>
          <PanelHead title={t("ai.detail")} onClose={closePlan} />
          <div className="text-body text-fg3" data-testid="plan-gone">
            {q.isError || (d && !d.workItemId) ? t("ai.plan.gone") : t("common.loading")}
          </div>
        </>
      )}
    </PanelFrame>
  );
}

function PlanDetail({
  d,
  plan,
}: {
  d: ReportItemResponse;
  plan: NonNullable<ReportItemResponse["plan"]>;
}) {
  const { t } = useI18n();
  const now = useNow();
  const tz = useQueue().data?.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const late = plan.overdue || now > plan.at + PLAN_LATE_MS;
  const where = [d.source, d.project].filter(Boolean).join(" · ");
  const hide: MenuEntry = {
    id: "hide",
    label: t("ai.hide"),
    icon: EyeOff,
    danger: true,
    run: () => void hidePlan(d.source, d.externalId),
  };
  return (
    <>
      <PanelHead title={d.title ?? d.externalId} onClose={closePlan} />
      <div className="-mt-3 flex flex-col gap-1.5" data-testid="ai-state" data-state="scheduled">
        <div className="flex items-center gap-2 text-body">
          <CalendarClock
            size={16}
            strokeWidth={1.5}
            className="shrink-0 text-fg2"
            aria-hidden="true"
          />
          <span className={`font-medium ${late ? "text-fg2" : "text-fg"}`} data-testid="plan-label">
            {planLabel(plan, now, tz, t, true)}
          </span>
        </div>
      </div>
      <div className="flex flex-col gap-2.5">
        <div className="flex items-center gap-1.5 text-fg2 text-meta" data-testid="ai-report-from">
          <span className="shrink-0 font-mono text-fg3 text-micro" title={d.source}>
            {sourceBadgeText({ tool: d.source, profile: null, report: true })}
          </span>
          <span className="min-w-0 truncate">{where}</span>
        </div>
        <div
          className="relative mt-0.5 flex flex-wrap items-center gap-1.5 pr-10"
          data-testid="ai-actions"
        >
          {d.url ? (
            <ActionButton
              primary
              onClick={() => void openPlan(d.source, d.externalId)}
              keys={keyHint("open")}
              testId="ai-primary"
            >
              {t("menu.openAi")}
            </ActionButton>
          ) : null}
          <MoreButton
            testId="ai-more"
            className="absolute top-0 right-0"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setMenu({ x: r.right - 240, y: r.bottom + 4 });
            }}
          />
          {menu ? (
            <ContextMenu x={menu.x} y={menu.y} entries={[hide]} onClose={() => setMenu(null)} />
          ) : null}
        </div>
      </div>
      <section className="flex flex-col gap-2 border-line border-t pt-4" data-testid="flow">
        <h3 className="font-semibold text-fg2 text-meta">{t("queue.flow")}</h3>
        <div className="flex items-center gap-3 text-body" data-flow="scheduled">
          <span className="block w-8 shrink-0" aria-hidden="true" />
          <span className="w-14 shrink-0 text-fg2">{t("ai.plan.flow")}</span>
          <span className="font-mono text-fg2 text-meta">{clockOrDate(plan.at, now, tz)}</span>
          <span className="min-w-0 flex-1 truncate text-fg3 text-meta">
            {t("ai.plan.notStarted")}
          </span>
        </div>
      </section>
    </>
  );
}
