/**
 * 取り込みに同意していない（O2 の Not now）ときの、今日の AI レーンの空状態（onboarding.md 4.2、確定デザイン O2-S 8）。
 * 「Start importing →」で O2 → O3 だけをやり直す。× で隠す（この端末で覚える）
 */
import { useNavigate } from "@tanstack/react-router";
import { isInternalSource } from "@turnlane/core/web";
import { X } from "lucide-react";
import { useState } from "react";
import { useSources } from "../data/queries.ts";
import { useI18n } from "../i18n/index.tsx";
import { useOnboardingState } from "./data.ts";

const HIDE_KEY = "turnlane.onboarding.boardEmptyHidden";

function hidden(): boolean {
  try {
    return localStorage.getItem(HIDE_KEY) === "1";
  } catch {
    return false;
  }
}

export function ImportEmptyState({ empty }: { empty: boolean }) {
  const { t } = useI18n();
  const ob = useOnboardingState();
  const navigate = useNavigate();
  const [gone, setGone] = useState(hidden);
  if (!empty || gone || !ob.data || ob.data.consentedAt !== null) return null;
  return (
    <div
      className="sticky top-2 z-[1] mx-1 mt-2 flex items-start gap-1 text-fg2 text-meta"
      data-part="import-empty"
    >
      <p className="min-w-0 flex-1">
        {t("onb.boardEmpty")}{" "}
        <button
          type="button"
          className="font-medium text-fg2 hover:text-fg hover:underline"
          onClick={() => void navigate({ to: "/onboarding", search: { only: "import" } as never })}
        >
          {t("onb.boardEmpty.start")} →
        </button>
      </p>
      <button
        type="button"
        aria-label={t("onb.boardEmpty.dismiss")}
        className="shrink-0 text-fg3 hover:text-fg"
        onClick={() => {
          try {
            localStorage.setItem(HIDE_KEY, "1");
          } catch {}
          setGone(true);
        }}
      >
        <X size={12} strokeWidth={1.5} aria-hidden="true" />
      </button>
    </div>
  );
}

/**
 * 取り込み元が 1 つ以上設定済みで、今日の AI の実行が 0 件のときの 1 行（B-10 (1)。D-193）: 「Claude Code / Codex のセッションが
 * ここに出ます」。レーンの中、計画の目安の開始の高さに置く（線もアイコンも無し）。実行が 1 件でも入ったら消える。
 * 取り込みに同意していないときは ImportEmptyState（取り込み元を設定する →）の方を出す
 */
export function AiLaneEmpty({ empty, top }: { empty: boolean; top: number }) {
  const { t } = useI18n();
  const ob = useOnboardingState();
  const sources = useSources();
  if (!empty || !ob.data || ob.data.consentedAt === null) return null;
  const configured = (sources.data?.sources ?? []).some(
    (x) => x.enabled && !isInternalSource(x.tool),
  );
  if (!configured) return null;
  return (
    <p
      className="pointer-events-none absolute right-2 left-2 truncate text-fg3 text-meta"
      style={{ top }}
      data-testid="ai-lane-empty"
    >
      {t("board.aiLane.empty")}
    </p>
  );
}
