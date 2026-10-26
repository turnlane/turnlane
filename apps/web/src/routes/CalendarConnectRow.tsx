/**
 * 設定 › カレンダー のつなぐ行（onboarding.md 6 章「O4 と同じ部品」）。フルアクセスでつながっていなければ出す:
 * `Allow calendar access` → 待ち（30 秒まで）→ 許可・拒否（System Settings の案内）・失敗（理由と Try again・Open System Settings）。
 * 段階の決め方は O4 と同じ（onboarding/calendar-connect.ts）
 */
import { useQueryClient } from "@tanstack/react-query";
import type { CalendarStatusView } from "@turnlane/daemon";
import { useEffect } from "react";
import { useT } from "../i18n/index.tsx";
import { CalendarFailedBox } from "../onboarding/CalendarFailedBox.tsx";
import { useCalendarConnect } from "../onboarding/calendar-connect.ts";
import { openSystemSettings } from "../onboarding/data.ts";
import { Spinner } from "../onboarding/parts.tsx";

const BUTTON =
  "inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-card border px-3 font-medium text-body focus-visible:outline focus-visible:outline-[1.5px] focus-visible:outline-accent focus-visible:outline-offset-2 disabled:opacity-45";

export function CalendarConnectRow({ status }: { status: CalendarStatusView }) {
  const t = useT();
  const qc = useQueryClient();
  const c = useCalendarConnect();
  const denied =
    c.phase === "denied" ||
    (c.phase === "idle" &&
      status.connected &&
      status.authorization !== null &&
      status.authorization !== "notDetermined" &&
      status.authorization !== "fullAccess");
  // 許可されたら節を読み直す（カレンダーの一覧と予定の書き先が出る）
  useEffect(() => {
    if (c.phase === "granted" || c.phase === "none")
      void qc.invalidateQueries({ queryKey: ["settings"] });
  }, [c.phase, qc]);
  if (c.phase === "granted" || c.phase === "none") return null;

  return (
    <div
      className="flex flex-col gap-2"
      data-testid="settings-calendar-connect"
      data-phase={c.phase}
    >
      {denied ? (
        <>
          <p className="font-medium text-body text-fg">{t("onb.calendar.denied.title")}</p>
          <p className="text-body text-fg2">{t("onb.calendar.denied.line")}</p>
          <div>
            <button
              type="button"
              className={`${BUTTON} border-line bg-raised text-fg hover:border-fg3`}
              onClick={() => void openSystemSettings("calendars")}
            >
              {t("onb.openSystemSettings")}
            </button>
          </div>
        </>
      ) : c.phase === "unavailable" ? (
        <p className="text-body text-fg3">{t("onb.calendar.unavailable")}</p>
      ) : (
        <>
          {c.phase === "failed" ? (
            <CalendarFailedBox failure={c.failure} />
          ) : (
            <p className="text-body text-fg3">{t("sources.calendarOffHint")}</p>
          )}
          <div>
            <button
              type="button"
              data-testid="settings-calendar-allow"
              disabled={c.busy || c.phase === "waiting"}
              onClick={() => void c.start()}
              className={`${BUTTON} border-accent bg-accent text-onaccent hover:opacity-90`}
            >
              {c.phase === "waiting" ? (
                <>
                  <Spinner size={12} />
                  {t("onb.waitingMacos")}
                </>
              ) : c.phase === "failed" ? (
                t("onb.calendar.tryAgain")
              ) : (
                t("onb.calendar.allow")
              )}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
