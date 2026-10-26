/**
 * オンボーディングの画面（/onboarding。onboarding.md 3章、M6-21〜M6-26）。サイドバーを出さない。
 * - 今の段（GET /api/onboarding の step）の画面を出す。途中で閉じても次は同じ段から
 * - 画面: O2 sources → O3 import → O4 calendar → O5 hooks → O5a mcp → O6 hours → O7 notifications → O8 start。
 *   同意が無いときの hooks・mcp は画面を出さずに飛ばす（取り込み元が 0 件なら各画面が対象なしで飛ばす）
 * - O8 の「ボードを開く」で流れを終える（state=done）。主ボタンは常にボード（D-192）
 * - `?only=import` は、Not now の後にボードの空状態から取り込みだけをやり直す入口（O2 → O3 → ボード。段は進めない）
 */
import { useNavigate, useSearch } from "@tanstack/react-router";
import type { OnboardingStep, OnboardingView } from "@turnlane/core/web";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n/index.tsx";
import { CalendarStep } from "./CalendarStep.tsx";
import { ConfigStep } from "./ConfigStep.tsx";
import { consent, putStep, useDetect, useOnboardingState } from "./data.ts";
import { HoursStep } from "./HoursStep.tsx";
import { ImportStep } from "./ImportStep.tsx";
import { NotifyStep } from "./NotifyStep.tsx";
import { SourcesStep } from "./SourcesStep.tsx";
import { StartStep } from "./StartStep.tsx";
import { autoSkipped, backTarget } from "./steps.ts";

export function OnboardingPage() {
  const { t } = useI18n();
  const st = useOnboardingState();
  const search = useSearch({ strict: false }) as { only?: string };
  const only = search.only === "import";
  const navigate = useNavigate();
  const [localStep, setLocalStep] = useState<OnboardingStep>("sources");
  const finishing = useRef(false);
  const view = st.data;
  // 戻る先の判定（取り込む Claude Code / Codex があるか）。同意の前は検出の結果で足りる
  const det = useDetect(!!view && !only);
  const hasSources = (det.data?.sources ?? []).some(
    (s) => s.enabled && s.readable && (s.tool === "claude_code" || s.tool === "codex"),
  );

  const toBoard = () => void navigate({ to: "/board" });

  // 流れが済んでいる → ボードへ。同意が無い段（hooks・mcp）は画面を出さずに飛ばす
  useEffect(() => {
    if (!view || only || finishing.current) return;
    if (view.state === "done") {
      finishing.current = true;
      toBoard();
      return;
    }
    if ((view.step === "hooks" || view.step === "mcp") && view.consentedAt === null)
      void putStep(view.step, "skipped");
  });

  if (st.isError)
    return (
      <div className="flex h-full items-center justify-center bg-bg text-body text-fg2">
        {t("common.error")}
      </div>
    );
  if (!view) return <div className="h-full bg-bg" />;

  const step = only ? localStep : view.step;
  const shown: OnboardingView = only ? { ...view, step: localStep } : view;
  const back = (from: OnboardingStep) => () => {
    const to = backTarget(from, view, hasSources);
    if (!to) return;
    if (only) setLocalStep(to);
    else void putStep(to, "pending");
  };

  if (step === "sources")
    return (
      <SourcesStep
        view={shown}
        onImport={async (ids, empty) => {
          await consent(ids);
          if (only) {
            if (empty) toBoard();
            else setLocalStep("import");
            return;
          }
          // 0件の Continue は同意だけ（O3 は出さない。4.2）
          if (empty) await putStep("import", "skipped");
        }}
        onNotNow={async () => {
          if (only) return toBoard();
          await putStep("sources", "skipped");
          await putStep("import", "skipped");
        }}
      />
    );
  if (step === "import")
    return (
      <ImportStep
        view={shown}
        onBack={back("import")}
        onContinue={async () => {
          if (only) return toBoard();
          await putStep("import", "done");
        }}
        // 7日のうち残りの日の取り込みは裏で続くので「済んだ」にする（プロンプトの仮置き 6）
        onSkipRest={async () => {
          if (only) return toBoard();
          await putStep("import", "done");
        }}
      />
    );
  if (step === "calendar")
    return (
      <CalendarStep
        view={shown}
        onBack={back("calendar")}
        onDone={async () => {
          await putStep("calendar", "done");
        }}
        onSkip={async () => {
          await putStep("calendar", "skipped");
        }}
      />
    );
  if (step === "hooks" || step === "mcp") {
    if (autoSkipped(step, view, true)) return <div className="h-full bg-bg" />;
    return (
      <ConfigStep
        // hooks → mcp で部品を作り直す（前の段の結果を持ち越さない）
        key={step}
        kind={step}
        view={shown}
        onBack={back(step)}
        onDone={async (failed) => {
          await putStep(step, failed ? "failed" : "done");
        }}
        onSkip={async () => {
          await putStep(step, "skipped");
        }}
        onNone={async () => {
          await putStep(step, "skipped");
        }}
      />
    );
  }
  if (step === "hours")
    return (
      <HoursStep
        view={shown}
        onBack={back("hours")}
        onContinue={async () => {
          await putStep("hours", "done");
        }}
      />
    );
  if (step === "notifications")
    return (
      <NotifyStep
        view={shown}
        onBack={back("notifications")}
        onDone={async () => {
          await putStep("notifications", "done");
        }}
        onSkip={async () => {
          await putStep("notifications", "skipped");
        }}
      />
    );
  if (step === "start")
    return (
      <StartStep
        view={shown}
        onBack={back("start")}
        onOpen={async () => {
          finishing.current = true;
          await putStep("start", "done");
          toBoard();
        }}
      />
    );
  return <div className="h-full bg-bg" />;
}
