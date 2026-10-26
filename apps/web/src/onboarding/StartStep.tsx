/**
 * O8 はじめる（onboarding.md 4.8、M6-26、D-192）。画像は無く、O1〜O3 の部品で組む。
 * - 各段の結果を行で出す（● 済み / ◐ 待ち / ○ 未設定 / ⚠ 問題あり）。行を押すと設定の該当の節を開く
 * - メニューバー・クイック入力（アプリの中だけ）・コマンドラインの案内
 * - 主ボタンは常に「ボードを開く」（朝の計画は廃止。D-192）。2つ目のボタンは無い
 */

import { useNavigate } from "@tanstack/react-router";
import type { OnboardingView } from "@turnlane/core/web";
import { useState } from "react";
import { useDesktopStatus, useQuickAddShortcut, useSources } from "../data/queries.ts";
import { useI18n } from "../i18n/index.tsx";
import { inDesktop, shortcutLabel } from "../lib/desktop.ts";
import {
  installCliLink,
  useCalendarStatus,
  useDetect,
  useImportProgress,
  useInstallStatus,
} from "./data.ts";
import { ButtonPair, OnboardingLayout, StatusDot, withEnter } from "./parts.tsx";
import { type Act, startRows } from "./steps.ts";

/**
 * コマンドラインの行（4.8）。配布版で Homebrew の binary が無く、まだ ~/.local/bin に置いていなければ Install ▸
 * （~/.local/bin/turnlane のリンク。M6-15）。Homebrew 版・開発時の配置では出さない
 */
function CliLine() {
  const { t } = useI18n();
  const inst = useInstallStatus();
  const [result, setResult] = useState<"occupied" | "failed" | null>(null);
  const [busy, setBusy] = useState(false);
  const st = inst.data;
  const offer = st?.mode === "app" && !st.cli.homebrew;
  const linked = st?.cli.localBin.linked === true;
  const install = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await installCliLink();
      setResult(r.ok ? null : r.reason === "occupied" ? "occupied" : "failed");
    } catch {
      setResult("failed");
    } finally {
      setBusy(false);
    }
  };
  return (
    <p className="flex items-center gap-2 text-meta" data-part="cli">
      <span className="font-mono">{t("onb.start.cli")}</span>
      {offer && linked ? (
        <span className="text-fg3" data-cli="installed">
          {st.cli.localBin.inPath ? t("onb.start.cliInstalled") : t("onb.start.cliNotInPath")}
        </span>
      ) : offer && result ? (
        <span className="text-fg3" data-cli={result}>
          {t(result === "occupied" ? "onb.start.cliOccupied" : "onb.start.cliFailed")}
        </span>
      ) : offer ? (
        <button
          type="button"
          onClick={() => void install()}
          disabled={busy}
          data-testid="onb-install-cli"
          className="inline-flex items-center font-medium text-fg2 hover:text-fg hover:underline"
        >
          {t("onb.start.cliInstall")}
        </button>
      ) : null}
    </p>
  );
}

export function StartStep({
  view,
  onBack,
  onOpen,
}: {
  view: OnboardingView;
  onBack: () => void;
  onOpen: Act;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const det = useDetect();
  const progress = useImportProgress();
  const cal = useCalendarStatus();
  const src = useSources();
  const desktop = useDesktopStatus();
  const shortcut = useQuickAddShortcut();
  const [busy, setBusy] = useState(false);

  const app = desktop.data?.connected ? desktop.data.app : null;
  const sources = (src.data?.sources ?? []).filter(
    (s) => s.enabled && (s.tool === "claude_code" || s.tool === "codex"),
  );
  const notifications = app
    ? app.notifications === "granted"
      ? "granted"
      : app.notifications === "denied"
        ? "denied"
        : "off"
    : typeof Notification !== "undefined" && Notification.permission === "granted"
      ? "granted"
      : "off";
  const rows = startRows({
    steps: view.steps,
    consented: view.consented,
    sources: det.data
      ? det.data.sources.filter((s) => s.enabled && s.readable).length
      : sources.length,
    importDone: progress.data?.doneAt != null || view.backfillDone,
    calendar: cal.data
      ? {
          connected: cal.data.connected,
          authorization: cal.data.authorization,
          calendars: cal.data.calendars.total,
        }
      : null,
    hooks: sources.map((s) => s.hooksState),
    mcp: sources.map((s) => s.mcpState),
    notifications,
  });
  const NAME = {
    import: "onb.start.import",
    calendar: "onb.start.calendar",
    hooks: "onb.start.hooks",
    mcp: "onb.start.mcp",
    notifications: "onb.start.notify",
  } as const;

  const open = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onOpen();
    } finally {
      setBusy(false);
    }
  };
  const inApp = app !== null || inDesktop();

  return (
    <OnboardingLayout
      view={view}
      back={onBack}
      foot={[
        { key: "⏎", label: t("onb.start.open") },
        { key: "⌘[", label: t("onb.back") },
      ]}
      keys={{ enter: () => void open() }}
      buttons={
        <ButtonPair
          primary={{
            labels: [withEnter(t("onb.start.open"))],
            onClick: () => void open(),
            disabled: busy,
            testId: "onb-open-board",
          }}
        />
      }
    >
      <h1 className="font-semibold text-fg text-title">{t("onb.start.title")}</h1>

      <ul
        className="mt-6 flex flex-col"
        aria-label={t("onb.start.summary")}
        data-part="summary-rows"
      >
        {rows.map((r) => (
          <li key={r.key}>
            <button
              type="button"
              data-row={r.key}
              data-mark={r.mark}
              onClick={() => void navigate({ to: "/settings", hash: r.section })}
              className="flex h-9 w-full items-center gap-3 rounded-card px-4 text-left hover:bg-sunken/50"
            >
              <StatusDot mark={r.mark} />
              <span className="w-32 shrink-0 font-medium text-body text-fg">{t(NAME[r.key])}</span>
              <span
                className={`min-w-0 truncate text-body ${r.mark === "problem" ? "text-fg" : "text-fg2"}`}
              >
                {t(r.text.key, r.text.params)}
              </span>
            </button>
          </li>
        ))}
      </ul>

      <div className="mt-8 flex flex-col gap-1.5 text-body text-fg2" data-part="tips">
        {inApp ? <p>{t("onb.start.menuBar")}</p> : null}
        {inApp ? (
          <p>
            {t("onb.start.quickAdd", {
              key: shortcutLabel(app?.shortcut.accelerator ?? shortcut.data ?? null),
            })}
          </p>
        ) : null}
        <CliLine />
      </div>
    </OnboardingLayout>
  );
}
