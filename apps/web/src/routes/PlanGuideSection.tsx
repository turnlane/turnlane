/**
 * 設定の「計画の目安」（D-062・D-106）: 曜日ごとの計画の目安（`work_hours.planned`。キーは移行を減らすため旧名のまま）と
 * 稼働曜日（`workdays.weekdays`）。空き時間と「明日朝」のスヌーズにだけ使い、放置の計算には使わない（D-105）。
 * 時刻は HH:MM（24:00 まで）で、欄を離れたか ⏎ で保存する。CLI では `turnlane config set work_hours.planned '{…}'`。
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DEFAULT_PLANNED_SPAN,
  formatPlannedTime,
  type PlannedHours,
  parsePlannedTime,
  plannedHoursValue,
  readPlannedHours,
  WEEKDAY_KEYS,
} from "@turnlane/core/web";
import { useEffect, useState } from "react";
import { useI18n } from "../i18n/index.tsx";
import { api, unwrap } from "../lib/api.ts";
import { blurOnEnter } from "../lib/ime.ts";

/** 月〜日（2026-10-05 は月曜）の曜日名 */
const WEEK_DATES = ["05", "06", "07", "08", "09", "10", "11"].map((d) => `2026-10-${d}`);

async function getConfig<T>(key: string): Promise<T | null> {
  const r = await unwrap<{ value: T | null }>(api.api.config[":key"].$get({ param: { key } }));
  return r.value;
}

async function putConfig(key: string, value: unknown): Promise<void> {
  await unwrap(api.api.config[":key"].$put({ param: { key }, json: { value } }));
}

export function PlanGuideSection() {
  const { t, dayLabel } = useI18n();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["settings", "plan-guide"],
    queryFn: async () => ({
      planned: readPlannedHours(await getConfig("work_hours.planned")),
      weekdays: (await getConfig<number[]>("workdays.weekdays")) ?? [1, 2, 3, 4, 5],
    }),
  });
  const [err, setErr] = useState(false);
  if (!q.data) return null;
  const { planned, weekdays } = q.data;
  const save = async (key: string, value: unknown) => {
    setErr(false);
    try {
      await putConfig(key, value);
    } catch {
      setErr(true);
    }
    void qc.invalidateQueries({ queryKey: ["settings", "plan-guide"] });
  };
  const setSpan = (iso: number, startMin: number, endMin: number) => {
    const next: PlannedHours = { ...planned, [iso]: { startMin, endMin } };
    void save("work_hours.planned", plannedHoursValue(next));
  };
  const toggleDay = (iso: number) => {
    const next = weekdays.includes(iso) ? weekdays.filter((x) => x !== iso) : [...weekdays, iso];
    if (next.length > 0) void save("workdays.weekdays", next.sort());
  };
  return (
    <section
      className="flex flex-col gap-2"
      data-testid="settings-plan-guide"
      data-setting="plan-guide"
    >
      <div>
        <h2 className="text-section">{t("settings.planGuide")}</h2>
        <p className="text-meta text-fg3">{t("settings.planGuide.hint")}</p>
      </div>
      <div className="flex flex-col gap-1">
        {WEEKDAY_KEYS.map((k, i) => {
          const iso = i + 1;
          const on = weekdays.includes(iso);
          const span = planned[iso] ?? DEFAULT_PLANNED_SPAN;
          return (
            <div key={k} className="flex h-8 items-center gap-3">
              <label className="flex w-28 items-center gap-2 text-body">
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => toggleDay(iso)}
                  aria-label={`${dayLabel(WEEK_DATES[i] as string).weekday} ${t("settings.planGuide.workday")}`}
                  className="accent-[var(--dl-accent)]"
                />
                {dayLabel(WEEK_DATES[i] as string).weekday}
              </label>
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
      {err ? <p className="text-error text-meta">{t("settings.planGuide.invalid")}</p> : null}
    </section>
  );
}

/** HH:MM の入力。欄を離れたか ⏎ で確定し、読めなければ元に戻す（オンボーディング O6 も使う） */
export function TimeInput({
  value,
  onCommit,
  label,
}: {
  value: number;
  onCommit: (min: number) => void;
  label: string;
}) {
  const [v, setV] = useState(formatPlannedTime(value));
  useEffect(() => setV(formatPlannedTime(value)), [value]);
  const commit = () => {
    const m = parsePlannedTime(v.trim());
    if (m === null) setV(formatPlannedTime(value));
    else if (m !== value) onCommit(m);
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
