/**
 * 許可のダイアログを出せなかったときの案内（O4 と 設定 › カレンダー で共通。onboarding.md 4.4）。
 * 理由（turnlane の stderr の要約は英語のまま）と、システム設定のカレンダーを開くボタン。Try again・Not now は呼び出し側のボタン
 */
import { useI18n } from "../i18n/index.tsx";
import type { CalendarFailure } from "./calendar-connect.ts";
import { openSystemSettings } from "./data.ts";
import { ResultBox } from "./parts.tsx";

export function CalendarFailedBox({ failure }: { failure: CalendarFailure | null }) {
  const { t } = useI18n();
  const reason =
    failure?.kind === "detail"
      ? failure.detail
      : failure?.kind === "helper"
        ? t("onb.calendar.failed.helper")
        : failure?.kind === "start"
          ? t("onb.calendar.failed.start")
          : t("onb.calendar.failed.timeout");
  return (
    <ResultBox mark="problem" title={t("onb.calendar.failed.title")} testId="onb-calendar-failed">
      <p className="text-body text-fg2" data-part="reason">
        <span className="text-fg3">{t("onb.calendar.failed.reasonLabel")}</span>{" "}
        <span className={failure?.kind === "detail" ? "font-mono text-meta" : ""}>{reason}</span>
      </p>
      <p className="text-body text-fg2">{t("onb.calendar.failed.line")}</p>
      <div className="mt-1">
        <button
          type="button"
          data-testid="onb-calendar-open-settings"
          onClick={() => void openSystemSettings("calendars")}
          className="inline-flex h-7 items-center rounded-card border border-line bg-raised px-3 font-medium text-body text-fg hover:border-fg3 focus-visible:outline focus-visible:outline-[1.5px] focus-visible:outline-accent focus-visible:outline-offset-2"
        >
          {t("onb.openSystemSettings")}
        </button>
      </div>
    </ResultBox>
  );
}
