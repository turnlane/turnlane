/**
 * 行の「対応中」（開いた件）。動いているセッションを開いたときは、どこに着地したかを後ろに付ける
 * （「対応中 · iTerm2 · タブ 3」。D-214 (4)、data/landing.ts）。着地が対応中の印より古ければ付けない
 */
import { openLandingShort, openLandingText } from "@turnlane/core/web";
import { useLanding } from "../data/landing.ts";
import { useI18n } from "../i18n/index.tsx";
import { useNow } from "../lib/clock.ts";

/** 対応中の印と着地の時刻のずれの許し（印はデーモン、着地はブラウザの時計） */
const SKEW_MS = 60_000;

export function EngagedLabel({
  followUpId,
  engagedAt,
  className,
}: {
  followUpId: string;
  engagedAt: number;
  className: string;
}) {
  const { t, locale } = useI18n();
  const now = useNow();
  const l = useLanding(followUpId, now);
  const where = l && l.at >= engagedAt - SKEW_MS ? l : null;
  return (
    <span
      className={className}
      data-kind="turn-engaged"
      title={where ? openLandingText(where.app, where.landing, locale) : undefined}
    >
      {t("turn.engaged")}
      {where ? ` · ${openLandingShort(where.app, where.landing, locale)}` : ""}
    </span>
  );
}
