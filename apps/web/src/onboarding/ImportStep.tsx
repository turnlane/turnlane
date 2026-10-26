/**
 * O3 直近7日の取り込み（onboarding.md 4.3、確定デザイン onb-O3-*、review §5 の 17〜27）。
 * - 7日の列（新しい日が左）に、その日に動いた AI の作業のラベルを積む。読み取り専用（ホバーだけ）
 * - 列の状態は API の日の状態に1対1（pending = 光らないスケルトン、importing = 光るスケルトン、done = `AI 5h40m`）
 * - 要約の1行は全部の日が済んでから。行の高さは先に取っておく（完了で列が動かない）
 * - デーモンとの接続が切れたら中断（B3）、30秒戻らなければ起動しない（B2）
 */
import {
  fmtDuration,
  type ImportProgress,
  type OnboardingBoard,
  type OnboardingView,
  prLabel,
  repoName,
} from "@turnlane/core/web";
import { Check as CheckIcon, Info, TriangleAlert } from "lucide-react";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useConn } from "../App.tsx";
import { BAR_COLOR } from "../components/items.tsx";
import type { MessageKey } from "../i18n/en.ts";
import { useI18n } from "../i18n/index.tsx";
import { useDetect, useImportProgress, useOnboardingBoard, useOnboardingSummary } from "./data.ts";
import { ButtonPair, OnboardingLayout, Spinner, StartFailed, withEnter } from "./parts.tsx";
import { type Act, visibleCount } from "./steps.ts";

type Item = OnboardingBoard["days"][number]["items"][number];
type DayState = ImportProgress["days"][number]["state"];

/** ラベル1つの高さの目安（題名・2行目・間。PR の行はもう1行） */
const ITEM_H = 50;
const PR_H = 16;
/** 畳んだ列の幅（日付が入る最小の幅。review §5 の 20） */
const COLLAPSED_W = 72;
const SPARSE = 3;
const MAX_LABELS = 4;

export function ImportStep({
  view,
  onBack,
  onContinue,
  onSkipRest,
}: {
  view: OnboardingView;
  onBack: () => void;
  onContinue: Act;
  onSkipRest: Act;
}) {
  const { t, shortDate } = useI18n();
  const progress = useImportProgress();
  const board = useOnboardingBoard();
  const det = useDetect();
  const conn = useConn();
  const done = progress.data?.doneAt != null;
  const summary = useOnboardingSummary(done);
  const [busy, setBusy] = useState<"continue" | "skip" | null>(null);

  // B3 → 30秒で B2（取り込みの途中でデーモンが落ちた）
  const down = conn !== "open" && !done;
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!down) {
      setFailed(false);
      return;
    }
    const id = setTimeout(() => setFailed(true), 30_000);
    return () => clearTimeout(id);
  }, [down]);

  const days = progress.data?.days ?? [];
  const nDone = days.filter((d) => d.state === "done").length;
  const byDate = new Map((board.data?.days ?? []).map((d) => [d.date, d]));
  const totalItems = (board.data?.days ?? []).reduce((n, d) => n + d.items.length, 0);

  const run = async (k: "continue" | "skip", f: Act) => {
    if (busy) return;
    setBusy(k);
    try {
      await f();
    } finally {
      setBusy(null);
    }
  };
  const doContinue = () => {
    if (done) void run("continue", onContinue);
  };
  const doSkip = () => {
    if (!done) void run("skip", onSkipRest);
  };

  const sourcesLine = (
    <SourcesLine progress={progress.data ?? null} detect={det.data?.sources ?? []} />
  );

  return (
    <OnboardingLayout
      view={view}
      wide
      back={onBack}
      lead={
        <div className="flex flex-col gap-1">
          {sourcesLine}
          <p className="text-fg3 text-meta">{t("onb.privacyLine")}</p>
        </div>
      }
      foot={[
        { key: "⏎", label: t("onb.continue") },
        ...(done ? [] : [{ key: "Esc", label: t("onb.import.skipRest") }]),
        { key: "⌘[", label: t("onb.back") },
      ]}
      keys={{ enter: doContinue, escape: doSkip }}
      buttons={
        <ButtonPair
          secondary={{
            labels: [t("onb.import.skipRest")],
            onClick: doSkip,
            disabled: done || busy !== null,
            testId: "onb-skip-rest",
          }}
          primary={{
            labels: [withEnter(t("onb.continue"))],
            onClick: doContinue,
            disabled: !done || busy !== null,
            testId: "onb-continue",
          }}
        />
      }
    >
      <div className="flex min-h-[360px] flex-1 flex-col">
        <div className="flex items-baseline gap-4">
          <h1 className="font-semibold text-fg text-title">{t("onb.import.title")}</h1>
          <span className="flex items-center gap-1.5 text-body text-fg2" data-part="days-done">
            {done ? (
              <>
                <CheckIcon size={14} strokeWidth={1.75} aria-hidden="true" />
                {t("onb.import.done")}
              </>
            ) : days.length > 0 ? (
              t("onb.import.daysOf", { n: nDone, total: days.length })
            ) : null}
          </span>
        </div>
        <p className="mt-1.5 text-body text-fg2">
          {done ? t("onb.import.subtitleDone") : t("onb.import.subtitle")}
        </p>
        {/* 要約の行（高さは先に取る） */}
        <div className="mt-3 min-h-[22px] text-body text-fg" data-part="summary">
          {done && summary.data?.complete ? (
            totalItems < SPARSE ? (
              <span className="text-fg2">{t("onb.import.sparse")}</span>
            ) : (
              <SummaryLine
                aiMs={summary.data.aiMs}
                items={summary.data.cards}
                waits={summary.data.waits}
              />
            )
          ) : null}
        </div>
        {down ? (
          <div className="mt-2">
            {failed ? (
              <StartFailed
                onRetry={() => location.reload()}
                onCopy={() => navigator.clipboard.writeText("turnlane doctor --redact")}
              />
            ) : (
              <p className="flex items-center gap-2 text-body text-fg2" data-part="paused">
                <Info size={14} strokeWidth={1.5} aria-hidden="true" />
                {t("onb.import.paused")}
                <Spinner size={12} />
              </p>
            )}
          </div>
        ) : null}
        <Columns
          days={days.map((d) => ({
            date: d.date,
            // 中断の間は取り込み中だった日も待機中の見た目に戻す（review §5 の 25）
            state: down && d.state === "importing" ? "pending" : d.state,
            label: shortDate(d.date),
            data: byDate.get(d.date) ?? null,
          }))}
        />
      </div>
    </OnboardingLayout>
  );
}

/** 「Last 7 days: your AI agents worked 23h10m on 41 items and waited for you 38 times.」（長さだけ等幅） */
function SummaryLine({ aiMs, items, waits }: { aiMs: number; items: number; waits: number }) {
  const { t } = useI18n();
  const parts = t("onb.import.summary", {
    time: "\u0000time\u0000",
    items: t("onb.import.items", { count: items }),
    waits: t("onb.import.times", { count: waits }),
  }).split("\u0000");
  return (
    <span>
      {parts.map((p, i) =>
        p === "time" ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: 文の切れ目の並びは固定
          <span key={i} className="font-mono">
            {fmtDuration(aiMs)}
          </span>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: 文の切れ目の並びは固定
          <span key={i}>{p}</span>
        ),
      )}
    </span>
  );
}

interface Col {
  date: string;
  state: DayState;
  label: string;
  data: OnboardingBoard["days"][number] | null;
}

function Columns({ days }: { days: Col[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(400);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    setHeight(el.clientHeight);
    return () => ro.disconnect();
  }, []);
  const [hover, setHover] = useState<{ item: Item; date: string; rect: DOMRect } | null>(null);
  return (
    <div
      ref={ref}
      className="mt-4 flex min-h-[240px] flex-1 gap-4 overflow-hidden"
      data-part="columns"
    >
      {days.map((d) => {
        const items = d.data?.items ?? [];
        const collapsed = d.state === "done" && items.length === 0;
        return (
          <section
            key={d.date}
            data-day={d.date}
            data-state={d.state}
            className={collapsed ? "shrink-0" : "min-w-0 flex-1"}
            style={collapsed ? { width: COLLAPSED_W } : undefined}
          >
            <DayHead col={d} collapsed={collapsed} />
            <div className="mt-4">
              {d.state === "done" ? (
                <Labels
                  items={items}
                  height={height - 64}
                  onHover={(item, rect) =>
                    setHover(item && rect ? { item, date: d.date, rect } : null)
                  }
                />
              ) : (
                <Skeleton shimmer={d.state === "importing"} />
              )}
            </div>
          </section>
        );
      })}
      {hover ? <ItemTip {...hover} /> : null}
    </div>
  );
}

function DayHead({ col, collapsed }: { col: Col; collapsed: boolean }) {
  const { t } = useI18n();
  let sub: ReactNode;
  if (col.state === "done")
    sub = collapsed ? (
      <span className="text-fg3">{t("onb.import.noWork")}</span>
    ) : (
      <span className="font-mono">AI {fmtDuration(col.data?.aiMs ?? 0)}</span>
    );
  else if (col.state === "importing")
    sub = (
      <span className="flex items-center gap-1.5">
        <Spinner size={12} />
        {t("onb.import.importing")}
      </span>
    );
  else sub = t("onb.import.waiting");
  return (
    <header className="min-w-0">
      <div className="truncate font-medium text-body text-fg">{col.label}</div>
      <div className="mt-0.5 text-fg2 text-meta">{sub}</div>
    </header>
  );
}

function Labels({
  items,
  height,
  onHover,
}: {
  items: Item[];
  height: number;
  onHover: (item: Item | null, rect: DOMRect | null) => void;
}) {
  const { t } = useI18n();
  // 入る数: 上から積んで、残りを「+N more」の1行にする
  let used = 0;
  let fit = 0;
  for (const it of items) {
    const h = ITEM_H + (it.prRef ? PR_H : 0);
    if (used + h > height - 16) break;
    used += h;
    fit++;
  }
  // 確定画像のとおり、列に積むのは4件まで（残りは「+N more」）。窓が低ければそれより少なく
  fit = Math.min(fit, MAX_LABELS);
  const { shown, more } = visibleCount(items.length, fit === items.length ? fit : fit + 1);
  return (
    <ul className="flex flex-col gap-4">
      {items.slice(0, shown).map((it) => (
        <li
          key={it.id}
          className="flex min-w-0 gap-2"
          data-item={it.id}
          onMouseEnter={(e) => onHover(it, e.currentTarget.getBoundingClientRect())}
          onMouseLeave={() => onHover(null, null)}
        >
          <span
            className="w-[3px] shrink-0 rounded-full"
            style={{ background: BAR_COLOR[it.status as keyof typeof BAR_COLOR] ?? BAR_COLOR.done }}
          />
          <div className="min-w-0 flex-1">
            <div className="truncate text-body text-fg">
              {it.title ?? it.branch ?? t("common.none")}
            </div>
            <div className="flex min-w-0 items-baseline gap-2 text-fg2 text-meta">
              <RepoBranch item={it} />
              <span className="ml-auto shrink-0 font-mono">{fmtDuration(it.aiMs)}</span>
            </div>
            {it.prRef ? <div className="text-fg2 text-meta">PR {prLabel(it.prRef)}</div> : null}
          </div>
        </li>
      ))}
      {more > 0 ? (
        <li className="pl-[11px] text-fg3 text-meta">{t("onb.import.more", { count: more })}</li>
      ) : null}
    </ul>
  );
}

/** `repo · branch`。ブランチを先に省き、それでも入らなければリポジトリ名を省く（review §5 の 19） */
function RepoBranch({ item }: { item: Item }) {
  const { t } = useI18n();
  const repo = item.scratch ? t("ai.scratch") : repoName(item.repoRoot);
  return (
    <span className="flex min-w-0 items-baseline">
      {repo ? <span className="max-w-full shrink-0 truncate">{repo}</span> : null}
      {item.branch ? (
        <span className="min-w-0 truncate">
          {repo ? "\u00a0·\u00a0" : ""}
          {item.branch}
        </span>
      ) : null}
    </span>
  );
}

function Skeleton({ shimmer }: { shimmer: boolean }) {
  const bar = shimmer ? "dl-shimmer" : "bg-sunken";
  return (
    <div className="flex flex-col gap-6" data-skeleton={shimmer ? "importing" : "pending"}>
      {[0.8, 0.62, 0.72].map((w) => (
        <div key={w} className="flex gap-2">
          <span className="w-[3px] shrink-0 rounded-full bg-sunken" />
          <div className="flex min-w-0 flex-1 flex-col gap-2 py-0.5">
            <span className={`h-2.5 rounded-full ${bar}`} style={{ width: `${w * 100}%` }} />
            <span className={`h-2 rounded-full ${bar}`} style={{ width: `${w * 60}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function clock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** ホバー: 全文の題名、`repo · branch`、時刻、AI 時間（操作なし。review §5 の 24 で日本語の幅を広く） */
function ItemTip({ item, date, rect }: { item: Item; date: string; rect: DOMRect }) {
  const { shortDate } = useI18n();
  const repo = repoName(item.repoRoot);
  const left = Math.min(rect.left, window.innerWidth - 340);
  const top = rect.bottom + 6 > window.innerHeight - 110 ? rect.top - 100 : rect.bottom + 6;
  return createPortal(
    <div
      role="tooltip"
      className="pointer-events-none fixed z-50 max-w-[320px] rounded-control bg-fg px-2.5 py-2 text-bg text-meta leading-5 shadow-pop"
      style={{ left: Math.max(8, left), top }}
    >
      <div className="font-medium">{item.title ?? item.branch}</div>
      <div className="opacity-80">{[repo, item.branch].filter(Boolean).join(" · ")}</div>
      {item.startAt !== null && item.endAt !== null ? (
        <div className="font-mono opacity-80">
          {shortDate(date)} {clock(item.startAt)}–{clock(item.endAt)}
        </div>
      ) : null}
      <div className="font-mono opacity-80">AI {fmtDuration(item.aiMs)}</div>
    </div>,
    document.body,
  );
}

const TOOL: Record<string, MessageKey> = {
  claude_code: "sources.tool.claude_code",
  codex: "sources.tool.codex",
};

/** 取り込み元の1行: `Claude Code · Default 84 ✓ · Codex 18 ⟳`。読めなかったファイルは赤（警告の部分だけ） */
function SourcesLine({
  progress,
  detect,
}: {
  progress: ImportProgress | null;
  detect: { id: string; tool: string; label: string; sessions7d: number }[];
}) {
  const { t } = useI18n();
  const [tip, setTip] = useState<{ text: string; rect: DOMRect } | null>(null);
  const info = new Map(detect.map((d) => [d.id, d]));
  const rows = (progress?.sources ?? []).filter((s) => info.has(s.id));
  return (
    <p
      className="flex flex-wrap items-center gap-x-3 gap-y-1 text-body text-fg2"
      data-part="sources-line"
    >
      {rows.map((s, i) => {
        const d = info.get(s.id) as (typeof detect)[number];
        const name = t(TOOL[d.tool] ?? "sources.tool.claude_code");
        const label =
          d.label === "default"
            ? d.tool === "claude_code"
              ? ` · ${t("onb.sources.default")}`
              : ""
            : ` · ${d.label}`;
        return (
          <span key={s.id} className="flex items-center gap-1.5" data-source-state={s.state}>
            {i > 0 ? <span className="pr-1.5 text-fg3">·</span> : null}
            {name}
            {label} {d.sessions7d}
            {s.skipped > 0 ? (
              <span
                role="note"
                tabIndex={-1}
                className="flex items-center gap-1 text-error"
                onMouseEnter={(e) =>
                  setTip({
                    text: t("onb.import.skippedHint", { count: s.skipped }),
                    rect: e.currentTarget.getBoundingClientRect(),
                  })
                }
                onMouseLeave={() => setTip(null)}
              >
                <span className="text-fg3">·</span>
                <TriangleAlert size={12} strokeWidth={1.5} aria-hidden="true" />
                {t("onb.import.skipped", { count: s.skipped })}
              </span>
            ) : null}
            {s.state === "done" ? (
              <CheckIcon size={13} strokeWidth={1.75} className="text-fg3" aria-hidden="true" />
            ) : s.state === "importing" ? (
              <Spinner size={12} />
            ) : null}
          </span>
        );
      })}
      {tip
        ? createPortal(
            <div
              role="tooltip"
              className="pointer-events-none fixed z-50 max-w-[380px] rounded-control bg-fg px-2.5 py-2 text-bg text-meta leading-5 shadow-pop"
              style={{ left: Math.max(8, tip.rect.left), top: tip.rect.top - 52 }}
            >
              {tip.text}
            </div>,
            document.body,
          )
        : null}
    </p>
  );
}
