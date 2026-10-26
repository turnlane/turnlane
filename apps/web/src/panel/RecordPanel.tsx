/**
 * 記録のパネル（D-192 §3）。デイビュー・3日ボード・週表示の上部の「記録」（D-221）・⌘K の Go to「記録」・`g r` で、右の詳細
 * パネルと同じ枠に排他で開く。ボードではボードの基準の日（既定は今日）の記録
 * - 見出し「記録 · 金 10/2」、右に「Markdown をコピー」と ×。日付の前後（‹ › / h / l）で日を変えるとその日の記録に追従する
 * - 中身の順: 内訳（時間・放置）→ 帯グラフ → AI の要約（設定でオンのときだけ。開いた時点で無ければ作り始める）→ やったこと →
 *   AI がやったこと → 持ち越し → メモ（1行）
 * - 今日: 今の事実から組み立て、見出しの下に「今日の分はまだ増えます」。過去: 日付区切りで確定した Markdown。未来: 空の日の文
 * - 本文の編集は無い（確定の瞬間が無くなったので、編集した本文の使い道が無い。§8 の仮 8）
 */
import { useRouterState } from "@tanstack/react-router";
import type { DailyReportResponse } from "@turnlane/core/web";
import { Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { tipProps } from "../components/Tooltip.tsx";
import { Button } from "../components/ui.tsx";
import { putDailyNote, startSummary } from "../data/mutations.ts";
import { useDailyReport } from "../data/queries.ts";
import { useI18n } from "../i18n/index.tsx";
import { boardNav, dayNav } from "../lib/board-nav.ts";
import { blurOnEnter } from "../lib/ime.ts";
import { setUi, toast, useUi } from "../lib/store.ts";
import {
  DayBar,
  fullMarkdown,
  ReportFigures,
  ReportSections,
  reportIsEmpty,
} from "../report/DailyNote.tsx";
import { SummaryBox } from "../report/Summary.tsx";
import { PanelFrame, PanelHead } from "./PanelFrame.tsx";

/** 「Markdown をコピー」をアイコンだけにする幅（§3.2 の 320px） */
const NARROW_PX = 340;

const closePanel = () => setUi({ recordOpen: false });

export function RecordPanel() {
  const open = useUi((s) => s.recordOpen);
  const { t } = useI18n();
  if (!open) return null;
  return (
    <PanelFrame label={t("nav.record")} testId="record-panel" variant="detail">
      <RecordBody />
    </PanelFrame>
  );
}

function RecordBody() {
  const { t, locale, dayLabel } = useI18n();
  // ボード（3日・週）ではボードの基準の日（既定は今日）、デイビューではその日（D-221）
  const onBoard = useRouterState({ select: (s) => s.location.pathname === "/board" });
  const date = useUi(() => (onBoard ? boardNav.anchor() : dayNav.date()));
  const today = useUi((s) => s.serverToday) ?? "";
  const future = today !== "" && date > today;
  const isToday = date === today;
  const q = useDailyReport(date, locale, !future);
  const d = q.data;
  const label = dayLabel(date);
  const title = t("record.title", { date: `${label.weekday} ${label.date}` });
  // 幅が狭ければコピーをアイコンだけに
  const ref = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const el = ref.current?.parentElement;
    if (!el) return;
    const on = () => setNarrow(el.clientWidth < NARROW_PX);
    on();
    const ro = new ResizeObserver(on);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // AI の要約（M4-6）: 設定でオンで、その日の要約が無く、作っていなければ、開いた時点で作り始める
  const started = useRef<string | null>(null);
  useEffect(() => {
    if (!d || future) return;
    const s = d.summary;
    if (!s.enabled || s.md !== null || s.job !== null || started.current === d.date) return;
    started.current = d.date;
    void startSummary(d.date, locale);
  }, [d, future, locale]);
  const copy = async () => {
    const md = d
      ? fullMarkdown(d.report, locale, {
          saved: d.saved ? d.markdown : null,
          note: d.report.note,
          summary: d.summary,
        })
      : `## ${title}\n`;
    try {
      await navigator.clipboard.writeText(md);
      toast(t("dailyNote.copied"));
    } catch {
      toast(t("toast.saveFailed"));
    }
  };
  const copyButton = narrow ? (
    <button
      type="button"
      onClick={() => void copy()}
      className="inline-flex size-7 shrink-0 items-center justify-center rounded-control text-fg2 hover:bg-sunken hover:text-fg"
      {...tipProps(t("dailyNote.copy"))}
      data-testid="record-copy"
    >
      <Copy size={16} strokeWidth={1.5} aria-hidden="true" />
    </button>
  ) : (
    <Button size="sm" onClick={() => void copy()} data-testid="record-copy">
      <Copy size={12} strokeWidth={1.5} aria-hidden="true" />
      {t("dailyNote.copy")}
    </Button>
  );
  return (
    // 下に 24px（横の余白と同じ）: スクロールの入れ物の下の余白は WebKit で効かないことがあるので中身に持つ（D-221）
    <div
      ref={ref}
      className="flex min-h-0 shrink-0 flex-col gap-5 pb-6"
      data-kind="record"
      data-date={date}
    >
      <div className="flex flex-col gap-1">
        <PanelHead
          title={
            <h2 className="min-w-0 flex-1 truncate font-semibold text-[15px] text-fg leading-7">
              {title}
            </h2>
          }
          lead={undefined}
          onClose={closePanel}
          aside={copyButton}
        />
        {isToday && d && !reportIsEmpty(d.report) ? (
          <p className="text-fg3 text-meta" data-testid="record-live">
            {t("record.live")}
          </p>
        ) : null}
      </div>
      {future ? (
        <Empty k="record.emptyToday" />
      ) : !d ? (
        <p className="text-body text-fg3">{q.isError ? t("common.error") : t("common.loading")}</p>
      ) : (
        <>
          {reportIsEmpty(d.report) ? (
            <Empty k={isToday ? "record.emptyToday" : "record.emptyPast"} />
          ) : (
            <>
              <ReportFigures report={d.report} />
              <DayBar report={d.report} />
              <SummaryBox date={d.date} summary={d.summary} />
              <ReportSections report={d.report} />
            </>
          )}
          {/* 今日の記録が空 → 中身ありに変わっても（SSE）、書いている途中のメモを作り直さない（取り消しの履歴とフォーカスを残す） */}
          <Memo key={d.date} date={d.date} note={d.report.note} />
        </>
      )}
    </div>
  );
}

function Empty({ k }: { k: "record.emptyToday" | "record.emptyPast" }) {
  const { t } = useI18n();
  return (
    <p className="text-body text-fg3" data-testid="record-empty">
      {t(k)}
    </p>
  );
}

/**
 * メモ（1行）。離れたときに保存する。欄にフォーカスしたままパネルを閉じた（Esc・×・日付の切り替え・画面の移動）ときも、
 * 消える前に保存する（閉じるときは blur が来ない）
 */
function Memo({ date, note }: { date: string; note: string | null }) {
  const { t } = useI18n();
  const [v, setV] = useState(note ?? "");
  const saved = useRef(note ?? "");
  const latest = useRef(v);
  latest.current = v;
  // date は key で固定（日付が変われば作り直す）。閉じるときは最後に入れた値を、その日に保存する
  const commit = () => {
    const now = latest.current;
    if (now === saved.current) return;
    saved.current = now;
    void putDailyNote(date, now.trim() || null);
  };
  const commitRef = useRef(commit);
  commitRef.current = commit;
  useEffect(() => () => commitRef.current(), []);
  // 保存した値が後から届いたら（閉じる時の保存の後に開き直した・ほかの窓で書いた）合わせる。欄にフォーカスがある間と、
  // まだ保存していない文がある間は置き直さない（取り消しの履歴と書きかけの文を残す）
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const next = note ?? "";
    if (next === saved.current || latest.current !== saved.current) return;
    if (input.current && document.activeElement === input.current) return;
    saved.current = next;
    setV(next);
  }, [note]);
  return (
    <section className="flex flex-col gap-1">
      <h3 className="font-semibold text-body">{t("dailyNote.note")}</h3>
      <input
        ref={input}
        type="text"
        value={v}
        maxLength={500}
        placeholder={t("dailyNote.notePlaceholder")}
        onChange={(e) => setV(e.target.value)}
        onBlur={commit}
        onKeyDown={blurOnEnter}
        className="h-7 w-full rounded-chip border border-line bg-bg px-2 text-body text-fg outline-none placeholder:text-fg3 focus:border-accent"
        data-testid="record-memo"
      />
    </section>
  );
}
