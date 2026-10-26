/**
 * 日報の AI 要約の欄（M4-6。ux-mvp 8章のシャットダウン Step 2、日報の画面）。
 * - 生成中は「Summarizing…」、届いたら本文と小さく `summary by claude`、編集できる
 * - 失敗は1行（`Summary unavailable — claude timed out · Retry`）。日報は要約なしで保存される
 * - 設定でオフなら何も出さない
 */
import type { DailySummaryView, SummaryFailure, SummaryTool } from "@turnlane/core/web";
import { summaryToolCommand } from "@turnlane/core/web";
import { Pencil, RotateCcw } from "lucide-react";
import { useState } from "react";
import { Button } from "../components/ui.tsx";
import { putSummary, startSummary } from "../data/mutations.ts";
import { type MessageKey, useI18n } from "../i18n/index.tsx";

export function failureText(
  t: ReturnType<typeof useI18n>["t"],
  tool: SummaryTool,
  f: SummaryFailure,
): string {
  const name = summaryToolCommand(tool);
  const key = `summary.reason.${f.kind}` as MessageKey;
  return t(key, { tool: name, code: f.kind === "exit" ? String(f.code ?? f.signal ?? "?") : "" });
}

export function SummaryBox({ date, summary }: { date: string; summary: DailySummaryView }) {
  const { t, locale } = useI18n();
  const [edit, setEdit] = useState<string | null>(null);
  if (!summary.enabled && summary.md === null) return null;
  const job = summary.job;
  const retry = () => void startSummary(date, locale);
  return (
    <section
      data-kind="summary"
      aria-label={t("summary.title")}
      className="mb-4 rounded-card border border-line bg-sunken px-4 pt-3 pb-3"
    >
      <header className="mb-1.5 flex items-center justify-between gap-2">
        <h2 className="font-semibold text-body">{t("summary.title")}</h2>
        {edit === null && job?.state !== "running" ? (
          <div className="flex items-center gap-1">
            {summary.md !== null ? (
              <Button size="sm" variant="ghost" onClick={() => setEdit(summary.md ?? "")}>
                <Pencil size={12} strokeWidth={1.5} aria-hidden="true" />
                {t("summary.edit")}
              </Button>
            ) : null}
            {summary.enabled && summary.md !== null ? (
              <Button size="sm" variant="ghost" onClick={retry}>
                <RotateCcw size={12} strokeWidth={1.5} aria-hidden="true" />
                {t("summary.retry")}
              </Button>
            ) : null}
          </div>
        ) : null}
      </header>
      {edit !== null ? (
        <div className="flex flex-col gap-2">
          <textarea
            aria-label={t("summary.title")}
            value={edit}
            onChange={(e) => setEdit(e.target.value)}
            className="h-24 w-full resize-y rounded-chip border border-line bg-bg p-2 text-body text-fg outline-none focus:border-accent"
          />
          <div className="flex justify-end gap-1.5">
            <Button size="sm" variant="ghost" onClick={() => setEdit(null)}>
              {t("summary.cancel")}
            </Button>
            <Button
              size="sm"
              variant="primary"
              onClick={() => void putSummary(date, edit).then((ok) => ok && setEdit(null))}
            >
              {t("summary.save")}
            </Button>
          </div>
        </div>
      ) : job?.state === "running" ? (
        <p className="text-body text-fg3" data-kind="summary-running">
          <span className="mr-1.5 inline-block size-2 animate-pulse rounded-full bg-[var(--dl-running)] align-middle" />
          {t("summary.running")}
        </p>
      ) : summary.md !== null ? (
        <div>
          <p className="whitespace-pre-wrap text-body text-fg">{summary.md}</p>
          {summary.tool ? (
            <p className="mt-1 text-meta text-fg3">
              {t("summary.by", { tool: summaryToolCommand(summary.tool) })}
            </p>
          ) : null}
        </div>
      ) : job?.state === "failed" ? (
        <p className="text-body text-fg2" data-kind="summary-failed">
          {t("summary.unavailable", { reason: failureText(t, job.tool, job.failure) })}
          {" · "}
          <button type="button" className="text-accent hover:underline" onClick={retry}>
            {t("summary.retry")}
          </button>
        </p>
      ) : (
        <p className="text-body text-fg3">
          {t("summary.none")}
          {" · "}
          <button type="button" className="text-accent hover:underline" onClick={retry}>
            {t("summary.generate")}
          </button>
        </p>
      )}
    </section>
  );
}
