/**
 * O4 カレンダー（任意。onboarding.md 4.4、M6-23。画像は無く、O1〜O3 の部品で組む）。
 * - 主ボタン「Allow calendar access」で接続を始め（POST /api/onboarding/calendar/connect）、結果を待つ:
 *   /api/calendar/status を 1 秒ごとに読み、フルアクセスになったら同期を待ってカレンダー数と祝日の判定を出す
 * - 拒否されたら System Settings の案内（オンにしたら自動で進む）。カレンダーが 0 件・ヘルパが起動しない状態も
 * - 許可のダイアログを出せなかった（接続が 0 以外で終わった・30 秒たっても決まらない）ら、理由と Try again・
 *   Open System Settings・Not now（段階の決め方は calendar-connect.ts）
 * - 「今はしない」で飛ばせる（ボードに予定が出ないだけ。設定 › カレンダー でつなげる）
 */

import type { OnboardingView } from "@turnlane/core/web";
import { useI18n } from "../i18n/index.tsx";
import { holidaySummary } from "../routes/SettingsSections.tsx";
import { CalendarFailedBox } from "./CalendarFailedBox.tsx";
import { useCalendarConnect } from "./calendar-connect.ts";
import { openSystemSettings } from "./data.ts";
import { ButtonPair, OnboardingLayout, Points, ResultBox, Spinner, withEnter } from "./parts.tsx";
import type { Act } from "./steps.ts";

export function CalendarStep({
  view,
  onBack,
  onDone,
  onSkip,
}: {
  view: OnboardingView;
  onBack: () => void;
  /** 許可された（0 件も含む）→ 段を済みにして過去7日を数え直す */
  onDone: Act;
  /** 今はしない・拒否のまま進む・この起動では接続できない */
  onSkip: Act;
}) {
  const { t } = useI18n();
  const { phase, failure, busy, setBusy, status: st, start } = useCalendarConnect();

  const run = async (f: Act) => {
    if (busy) return;
    setBusy(true);
    try {
      await f();
    } finally {
      setBusy(false);
    }
  };

  const ready = phase === "granted" || phase === "none";
  const primaryAction = () => {
    if (phase === "idle" || phase === "failed") void start();
    else if (ready) void run(onDone);
    else if (phase === "denied" || phase === "unavailable") void run(onSkip);
  };
  const secondaryAction = () => {
    if (phase === "denied") void openSystemSettings("calendars");
    else void run(onSkip);
  };
  const primaryIndex = phase === "waiting" ? 1 : phase === "failed" ? 2 : phase === "idle" ? 0 : 3;
  const primaryLabels = [
    t("onb.calendar.allow"),
    t("onb.waitingMacos"),
    t("onb.calendar.tryAgain"),
    t("onb.continue"),
  ];
  const note =
    phase === "idle" || phase === "failed"
      ? t("onb.calendar.notNowNote")
      : phase === "granted"
        ? t("onb.calendar.recalc")
        : null;

  const holidays = st?.holidays;
  const defaultName = st?.events?.calendar
    ? st.events.calendar.account
      ? `${st.events.calendar.name} · ${st.events.calendar.account}`
      : st.events.calendar.name
    : null;

  return (
    <OnboardingLayout
      view={view}
      back={onBack}
      note={note}
      foot={[
        { key: "⏎", label: primaryLabels[primaryIndex] as string },
        ...(phase === "denied" || ready ? [] : [{ key: "Esc", label: t("onb.notNow") }]),
        { key: "⌘[", label: t("onb.back") },
      ]}
      keys={{
        enter: primaryAction,
        escape: () => {
          if (phase !== "waiting" && phase !== "denied" && !ready) void run(onSkip);
        },
      }}
      buttons={
        <ButtonPair
          // 許可された後は「今はしない」を出さない（Continue だけ）
          secondary={
            ready
              ? undefined
              : {
                  labels: [t("onb.notNow"), t("onb.openSystemSettings")],
                  active: phase === "denied" ? 1 : 0,
                  onClick: secondaryAction,
                  disabled: busy || phase === "waiting",
                  testId: "onb-not-now",
                }
          }
          primary={{
            labels: [
              withEnter(primaryLabels[0] as string),
              <>
                <Spinner />
                {primaryLabels[1]}
              </>,
              withEnter(primaryLabels[2] as string),
              withEnter(primaryLabels[3] as string),
            ],
            active: primaryIndex,
            onClick: primaryAction,
            disabled: busy || phase === "waiting",
            testId: "onb-calendar-primary",
          }}
        />
      }
    >
      <h1 className="font-semibold text-fg text-title">
        {t("onb.calendar.title")} <span className="font-normal text-fg3">{t("onb.optional")}</span>
      </h1>
      <p className="mt-1.5 text-body text-fg2">{t("onb.calendar.subtitle")}</p>
      <p className="mt-1 text-body text-fg2">{t("onb.calendar.uses")}</p>
      <Points items={[t("onb.calendar.point1"), t("onb.calendar.point2")]} />

      {phase === "granted" && st ? (
        <ResultBox
          mark="done"
          title={t("onb.calendar.found", { count: st.calendars.total })}
          lines={[
            ...(defaultName ? [t("onb.calendar.default", { name: defaultName })] : []),
            holidays && holidays.calendars.length > 0
              ? t("onb.calendar.holidaysFrom", { name: holidaySummary(holidays.calendars, t) })
              : t("onb.calendar.holidaysNone"),
          ]}
          testId="onb-calendar-granted"
        />
      ) : null}
      {phase === "none" ? (
        <ResultBox
          mark="waiting"
          title={t("onb.calendar.none.title")}
          lines={[t("onb.calendar.none.line")]}
          testId="onb-calendar-none"
        />
      ) : null}
      {phase === "denied" ? (
        <ResultBox
          mark="problem"
          title={t("onb.calendar.denied.title")}
          lines={[t("onb.calendar.denied.line")]}
          testId="onb-calendar-denied"
        />
      ) : null}
      {phase === "failed" ? <CalendarFailedBox failure={failure} /> : null}
      {phase === "unavailable" ? (
        <ResultBox
          mark="notSet"
          title={t("onb.calendar.unavailable")}
          testId="onb-calendar-unavailable"
        />
      ) : null}
    </OnboardingLayout>
  );
}
