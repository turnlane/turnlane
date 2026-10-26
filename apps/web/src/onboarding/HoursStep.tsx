/**
 * O6 計画の目安と稼働日（onboarding.md 4.6、M6-25、D-105）。設定 › 計画の目安と稼働日 と同じ値・同じ入力（TimeInput）。
 * - 稼働日（曜日の札）、計画の目安（毎日同じ 1 組か、曜日ごと）、祝日（カレンダーを許可していれば自動判定の結果、
 *   していなければ None）、一日の始まり（day_boundary）
 * - 値は変えたらすぐ保存する（設定画面と同じ）。「Continue」で段を済みにする。飛ばせない（初期値のままでも進める）
 * - 「勤務」「working hours」の言葉は出さない（D-105）
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DEFAULT_PLANNED_SPAN,
  type OnboardingView,
  type PlannedHours,
  plannedHoursValue,
  readPlannedHours,
  WEEKDAY_KEYS,
} from "@turnlane/core/web";
import { useState } from "react";
import { useI18n } from "../i18n/index.tsx";
import { blurOnEnter } from "../lib/ime.ts";
import { TimeInput } from "../routes/PlanGuideSection.tsx";
import { holidaySummary } from "../routes/SettingsSections.tsx";
import { getConfig, putConfig, useCalendarStatus } from "./data.ts";
import { ButtonPair, Disclosure, OnboardingLayout, withEnter } from "./parts.tsx";
import type { Act } from "./steps.ts";

/** 月〜日（2026-10-05 は月曜）の曜日名（設定画面と同じ） */
const WEEK_DATES = ["05", "06", "07", "08", "09", "10", "11"].map((d) => `2026-10-${d}`);

function useHoursConfig() {
  return useQuery({
    queryKey: ["onboarding", "hours"],
    queryFn: async () => ({
      planned: readPlannedHours(await getConfig("work_hours.planned")),
      weekdays: (await getConfig<number[]>("workdays.weekdays")) ?? [1, 2, 3, 4, 5],
      dayBoundary: (await getConfig<string>("day_boundary")) ?? "04:00",
    }),
  });
}

/** 稼働日の計画の目安がすべて同じなら、その 1 組 */
function commonSpan(planned: PlannedHours, weekdays: number[]) {
  const spans = weekdays.map((d) => planned[d] ?? DEFAULT_PLANNED_SPAN);
  const first = spans[0] ?? DEFAULT_PLANNED_SPAN;
  return spans.every((s) => s.startMin === first.startMin && s.endMin === first.endMin)
    ? first
    : null;
}

export function HoursStep({
  view,
  onBack,
  onContinue,
}: {
  view: OnboardingView;
  onBack: () => void;
  onContinue: Act;
}) {
  const { t, dayLabel } = useI18n();
  const qc = useQueryClient();
  const q = useHoursConfig();
  const cal = useCalendarStatus();
  const [err, setErr] = useState(false);
  const [perDay, setPerDay] = useState(false);
  const [busy, setBusy] = useState(false);
  const data = q.data;

  const save = async (key: string, value: unknown) => {
    setErr(false);
    try {
      await putConfig(key, value);
    } catch {
      setErr(true);
    }
    void qc.invalidateQueries({ queryKey: ["onboarding", "hours"] });
    void qc.invalidateQueries({ queryKey: ["settings"] });
  };
  const doContinue = async () => {
    if (busy || !data) return;
    setBusy(true);
    try {
      await onContinue();
    } finally {
      setBusy(false);
    }
  };

  const weekdays = data?.weekdays ?? [];
  const planned = data?.planned ?? {};
  const common = data ? commonSpan(planned, weekdays) : null;
  const showPerDay = perDay || common === null;
  const setAll = (startMin: number, endMin: number) => {
    const next: PlannedHours = { ...planned };
    for (let d = 1; d <= 7; d++) next[d] = { startMin, endMin };
    void save("work_hours.planned", plannedHoursValue(next));
  };
  const setSpan = (iso: number, startMin: number, endMin: number) => {
    void save("work_hours.planned", plannedHoursValue({ ...planned, [iso]: { startMin, endMin } }));
  };
  const toggleDay = (iso: number) => {
    const next = weekdays.includes(iso) ? weekdays.filter((x) => x !== iso) : [...weekdays, iso];
    if (next.length > 0) void save("workdays.weekdays", next.sort());
  };

  const holidays = cal.data?.holidays;
  const calendarOn = cal.data?.connected === true && cal.data.authorization === "fullAccess";
  const holidayLine =
    calendarOn && holidays && holidays.calendars.length > 0
      ? t("onb.hours.holidaysFrom", { name: holidaySummary(holidays.calendars, t) })
      : t("onb.hours.holidaysNone");

  const rowClass = "flex min-h-8 items-start gap-4";
  const labelClass = "w-32 shrink-0 pt-1.5 text-body text-fg2";

  return (
    <OnboardingLayout
      view={view}
      back={onBack}
      note={t("onb.hours.note")}
      foot={[
        { key: "⏎", label: t("onb.continue") },
        { key: "⌘[", label: t("onb.back") },
      ]}
      keys={{ enter: () => void doContinue() }}
      buttons={
        <ButtonPair
          primary={{
            labels: [withEnter(t("onb.continue"))],
            onClick: () => void doContinue(),
            disabled: busy || !data,
            testId: "onb-hours-continue",
          }}
        />
      }
    >
      <h1 className="font-semibold text-fg text-title">{t("onb.hours.title")}</h1>
      <p className="mt-1.5 text-body text-fg2">{t("onb.hours.subtitle")}</p>

      {data ? (
        <div className="mt-6 flex flex-col gap-4" data-part="hours">
          <div className={rowClass} data-setting="plan-guide">
            <span className={labelClass}>{t("onb.hours.workingDays")}</span>
            <div className="flex flex-wrap gap-1.5">
              {WEEKDAY_KEYS.map((k, i) => {
                const iso = i + 1;
                const on = weekdays.includes(iso);
                return (
                  <button
                    key={k}
                    type="button"
                    aria-pressed={on}
                    data-day={k}
                    onClick={() => toggleDay(iso)}
                    className={`h-7 min-w-11 rounded-chip border px-2.5 font-medium text-body transition-colors ${
                      on
                        ? "border-accent bg-accent text-onaccent"
                        : "border-line bg-raised text-fg2 hover:border-fg3"
                    }`}
                  >
                    {dayLabel(WEEK_DATES[i] as string).weekday}
                  </button>
                );
              })}
            </div>
          </div>
          <div className={rowClass}>
            <span className={labelClass}>{t("onb.hours.planGuide")}</span>
            <div className="flex min-w-0 flex-col gap-2">
              {showPerDay ? (
                <div className="flex flex-col gap-1">
                  {WEEKDAY_KEYS.map((k, i) => {
                    const iso = i + 1;
                    const on = weekdays.includes(iso);
                    const span = planned[iso] ?? DEFAULT_PLANNED_SPAN;
                    return (
                      <div key={k} className="flex h-8 items-center gap-3" data-day-row={k}>
                        <span className="w-10 text-body text-fg">
                          {dayLabel(WEEK_DATES[i] as string).weekday}
                        </span>
                        {on ? (
                          <span className="flex items-center gap-1.5">
                            <TimeInput
                              value={span.startMin}
                              onCommit={(v) =>
                                v < span.endMin ? setSpan(iso, v, span.endMin) : setErr(true)
                              }
                              label={`${k} start`}
                            />
                            <span className="text-fg3">–</span>
                            <TimeInput
                              value={span.endMin}
                              onCommit={(v) =>
                                v > span.startMin ? setSpan(iso, span.startMin, v) : setErr(true)
                              }
                              label={`${k} end`}
                            />
                          </span>
                        ) : (
                          <span className="text-body text-fg3">{t("settings.planGuide.off")}</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <span className="flex h-8 items-center gap-1.5" data-part="plan-guide-common">
                  <TimeInput
                    value={(common ?? DEFAULT_PLANNED_SPAN).startMin}
                    onCommit={(v) => {
                      const end = (common ?? DEFAULT_PLANNED_SPAN).endMin;
                      v < end ? setAll(v, end) : setErr(true);
                    }}
                    label="start"
                  />
                  <span className="text-fg3">–</span>
                  <TimeInput
                    value={(common ?? DEFAULT_PLANNED_SPAN).endMin}
                    onCommit={(v) => {
                      const start = (common ?? DEFAULT_PLANNED_SPAN).startMin;
                      v > start ? setAll(start, v) : setErr(true);
                    }}
                    label="end"
                  />
                </span>
              )}
              <Disclosure
                open={showPerDay}
                onToggle={() => {
                  if (showPerDay && common === null) {
                    // 曜日ごとに違う値を「毎日同じ」に戻す: 最初の稼働日の値に揃える
                    const first = planned[weekdays[0] ?? 1] ?? DEFAULT_PLANNED_SPAN;
                    setAll(first.startMin, first.endMin);
                  }
                  setPerDay(!showPerDay);
                }}
                showLabel={t("onb.hours.perDay")}
                hideLabel={t("onb.hours.sameHours")}
                testId="onb-hours-per-day"
              >
                {null}
              </Disclosure>
            </div>
          </div>
          <div className={rowClass} data-setting="holidays">
            <span className={labelClass}>{t("onb.hours.holidays")}</span>
            <span className="pt-1.5 text-body text-fg" data-part="holidays">
              {holidayLine}
            </span>
          </div>
          <div className={rowClass} data-setting="day-boundary">
            <span className={labelClass}>{t("onb.hours.dayStart")}</span>
            <div className="flex min-w-0 flex-col gap-1">
              <DayStartInput
                value={data.dayBoundary}
                onCommit={(v) => void save("day_boundary", v)}
                label={t("onb.hours.dayStart")}
              />
              <span className="text-fg3 text-meta">{t("onb.hours.dayStartHint")}</span>
            </div>
          </div>
          {err ? <p className="text-error text-meta">{t("settings.planGuide.invalid")}</p> : null}
        </div>
      ) : (
        <div className="mt-6 flex flex-col gap-4" data-skeleton="">
          {[0, 1, 2, 3].map((i) => (
            <span key={i} className="h-7 w-72 rounded-full bg-sunken" />
          ))}
        </div>
      )}
    </OnboardingLayout>
  );
}

/** HH:MM（一日の始まり。設定の HhmmInput と同じ振る舞い: 欄を離れたか ⏎ で確定、読めなければ元に戻す） */
function DayStartInput({
  value,
  onCommit,
  label,
}: {
  value: string;
  onCommit: (v: string) => void;
  label: string;
}) {
  const [v, setV] = useState(value);
  const commit = () => {
    const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(v.trim());
    if (!m) {
      setV(value);
      return;
    }
    const h = Number(m[1]);
    const mm = Number(m[2]);
    const next = `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
    setV(next);
    if (next !== value) onCommit(next);
  };
  return (
    <input
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={blurOnEnter}
      aria-label={label}
      inputMode="numeric"
      className="h-7 w-16 rounded-card border border-line bg-bg px-2 text-center font-mono text-body outline-none focus:border-accent"
    />
  );
}
