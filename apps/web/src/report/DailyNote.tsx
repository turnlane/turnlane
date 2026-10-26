/**
 * 記録（日報）の部品（M4-3・D-192。記録のパネル panel/RecordPanel.tsx が使う）。
 * - 本文は事実（DailyReport）から core/report の同じ関数で組み立てる（Markdown と画面の文言が一致する）
 * - 内訳の行（時間・放置）、帯グラフ（自分 / 会議 / AI / 放置）、やったこと・AI がやったこと・持ち越しの節
 * - Markdown のコピー（AI の要約がある日は先頭に `## Summary` を付ける。M4-6）
 */
import {
  type DailyReport,
  fmtDuration,
  type ReportAiLine,
  renderDailyReport,
  reportAiName,
  reportAiResultText,
  reportAiWhere,
  reportExpiredLine,
  reportHeadings,
  reportIdleByRepoLine,
  reportIdleLine,
  reportShortDate,
  reportTimeLine,
  reportTitle,
  type SummaryTool,
  withSummary,
} from "@turnlane/core/web";
import type { ReactNode } from "react";
import { useI18n } from "../i18n/index.tsx";

/** 記録の全文（コピー用）。確定済みならその Markdown、未確定なら今の事実から。AI 要約がある日は先頭に `## Summary` */
export function fullMarkdown(
  report: DailyReport,
  locale: "en" | "ja",
  o: {
    saved: string | null;
    note: string | null;
    summary?: { md: string | null; tool: SummaryTool | null } | undefined;
  },
): string {
  const md = o.saved ?? renderDailyReport(report, locale, { note: o.note });
  return withSummary(md, o.summary?.md ?? null, o.summary?.tool ?? null, locale);
}

/** 記録に書くことが何も無い日（空の日の文を出す） */
export function reportIsEmpty(r: DailyReport): boolean {
  return (
    r.did.length === 0 &&
    r.aiDid.length === 0 &&
    r.carried.length === 0 &&
    r.runs === 0 &&
    r.youMs === 0 &&
    r.aiMs === 0 &&
    r.idleMs === 0 &&
    r.expired === 0
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1">
      <h3 className="font-semibold text-body">{title}</h3>
      <ul className="flex flex-col gap-1">{children}</ul>
    </section>
  );
}

function Bullet({ children }: { children: ReactNode }) {
  return (
    <li className="flex gap-2 text-body">
      <span className="text-fg3" aria-hidden="true">
        –
      </span>
      <span className="min-w-0">{children}</span>
    </li>
  );
}

/** 内訳の2行（時間 / 放置 · 期限切れ）とリポジトリ別の放置。等幅は時間だけ */
export function ReportFigures({ report }: { report: DailyReport }) {
  const { locale } = useI18n();
  const byRepo = reportIdleByRepoLine(report, locale);
  const expired = reportExpiredLine(report, locale);
  return (
    <div className="flex flex-col gap-0.5 text-body text-fg" data-kind="record-figures">
      <p>{reportTimeLine(report, locale)}</p>
      <div className="border-turn border-l-2 pl-2" data-kind="idle-line">
        <div>{reportIdleLine(report, locale)}</div>
        {byRepo ? <div className="font-mono text-fg3 text-meta">{byRepo}</div> : null}
        {expired ? <div className="text-fg2 text-meta">{expired}</div> : null}
      </div>
    </div>
  );
}

/** やったこと・AI がやったこと・持ち越しの節（無い節は出さない） */
export function ReportSections({ report }: { report: DailyReport }) {
  const { locale } = useI18n();
  const h = reportHeadings(locale);
  return (
    <>
      {report.did.length > 0 ? (
        <Section title={h.did}>
          {report.did.map((x) => (
            <Bullet key={x.taskId}>
              {reportTitle(x.title, locale)}
              {x.ms !== null && x.ms > 0 ? (
                <span className="font-mono text-fg3 text-meta"> ({fmtDuration(x.ms)})</span>
              ) : null}
              {x.fromAi !== null ? (
                <span className="text-fg3 text-meta">
                  {" ← AI: "}
                  {x.fromAi}
                </span>
              ) : null}
            </Bullet>
          ))}
        </Section>
      ) : null}
      {report.aiDid.length > 0 ? (
        <Section title={h.aiDid}>
          {report.aiDid.map((x) => (
            <AiBullet key={x.workItemId} line={x} />
          ))}
        </Section>
      ) : null}
      {report.carried.length > 0 ? (
        <Section title={h.carried}>
          {report.carried.map((c) => (
            <Bullet key={c.taskId}>
              {reportTitle(c.title, locale)}
              <span className="font-mono text-fg3 text-meta">
                {" → "}
                {reportShortDate(c.to, locale)}
              </span>
            </Bullet>
          ))}
        </Section>
      ) : null}
    </>
  );
}

function AiBullet({ line }: { line: ReportAiLine }) {
  const { locale } = useI18n();
  return (
    <Bullet>
      <span className="font-mono text-fg3 text-meta">{`[${reportAiWhere(line, locale)}]`}</span>{" "}
      {reportAiName(line, locale)}
      {" — "}
      {reportAiResultText(line, locale)}
      <span className="font-mono text-fg3 text-meta"> (AI {fmtDuration(line.aiMs)})</span>
    </Bullet>
  );
}

/** 帯グラフ（自分 / 会議 / AI / 放置）と凡例。0 の項目は凡例に出さない */
export function DayBar({ report }: { report: DailyReport }) {
  const { t } = useI18n();
  const parts = [
    { k: "dailyNote.bar.you" as const, ms: report.youMs, color: "var(--dl-text-2)", dotted: false },
    {
      k: "dailyNote.bar.meetings" as const,
      ms: report.meetingsMs,
      color: "var(--dl-text-3)",
      dotted: false,
    },
    { k: "dailyNote.bar.ai" as const, ms: report.aiMs, color: "var(--dl-running)", dotted: false },
    { k: "dailyNote.bar.idle" as const, ms: report.idleMs, color: "var(--dl-turn)", dotted: true },
  ];
  const total = parts.reduce((a, p) => a + p.ms, 0);
  if (total === 0) return null;
  const fill = (p: (typeof parts)[number]) =>
    p.dotted ? `repeating-linear-gradient(90deg, ${p.color} 0 3px, transparent 3px 5px)` : p.color;
  return (
    <div className="flex flex-col gap-1.5" data-kind="day-bar">
      <div className="flex h-1.5 w-full gap-px overflow-hidden rounded-full bg-sunken">
        {parts
          .filter((p) => p.ms > 0)
          .map((p) => (
            <div key={p.k} style={{ width: `${(p.ms / total) * 100}%`, background: fill(p) }} />
          ))}
      </div>
      <ul className="flex flex-wrap gap-x-3 gap-y-0.5">
        {parts
          .filter((p) => p.ms > 0)
          .map((p) => (
            <li key={p.k} className="flex items-center gap-1.5 text-fg3 text-micro">
              <span
                className="inline-block h-0.5 w-2"
                style={{ background: fill(p) }}
                aria-hidden="true"
              />
              {t(p.k)} <span className="font-mono">{fmtDuration(p.ms)}</span>
            </li>
          ))}
      </ul>
    </div>
  );
}
