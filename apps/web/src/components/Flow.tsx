/**
 * この項目の流れ（D-116。AI の詳細パネルと自分の番の画面の詳細で共通の部品）: 区間ごとに線・名前・時刻・長さ。
 * 直近だけ出し、古い区間は「› それより前 N 区間 · AI 41m」に畳む（押すと全部）。下に合計「AI · 待ち · うち放置」
 */
import type { StoredWait, WorkItemDetail, WorkItemStatus } from "@turnlane/core/web";
import { fmtClock, fmtDuration } from "@turnlane/core/web";
import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { type MessageKey, useI18n } from "../i18n/index.tsx";
import {
  type FlowKind,
  type FlowRow,
  flowTotals,
  foldFlow,
  isExcluded,
  itemFlow,
} from "../panel/flow.ts";
import { Nums } from "./Nums.tsx";

/** 線（確定デザイン Q1 の FLOW_LINE と同じ。稼働中は青、待ちの色は状態で変える、数えない区間は灰の点線） */
export function flowLine(kind: FlowKind, now: boolean, status: WorkItemStatus): string {
  const tone =
    status === "needs_input"
      ? "var(--dl-needs)"
      : status === "error"
        ? "var(--dl-error)"
        : "var(--dl-turn)";
  if (kind === "run") return `3px solid ${now ? "var(--dl-running)" : "var(--dl-done)"}`;
  if (kind === "grace") return `1px dotted ${tone}`;
  if (kind === "idle") return `3px dotted ${tone}`;
  return "2px dotted var(--dl-line-excluded)";
}

export function FlowSection({
  detail,
  now,
  tz,
}: {
  detail: Pick<WorkItemDetail, "turns" | "waits" | "artifacts" | "breakdown"> &
    Partial<Pick<WorkItemDetail, "followUps">> & {
      workItem: Pick<WorkItemDetail["workItem"], "status">;
    };
  now: number;
  tz: string;
}) {
  const { t } = useI18n();
  const [all, setAll] = useState(false);
  const flow = itemFlow(detail, now);
  if (flow.rows.length === 0) return null;
  const { shown, earlier } = foldFlow(flow.rows);
  const rows = all ? flow.rows : shown;
  const total = flowTotals(detail, now);
  const status = detail.workItem.status;
  return (
    <section className="flex flex-col gap-2 border-line border-t pt-4" data-testid="flow">
      <h3 className="font-semibold text-fg2 text-meta">{t("queue.flow")}</h3>
      {earlier && !all ? (
        <button
          type="button"
          onClick={() => setAll(true)}
          className="flex items-center gap-1.5 self-start text-fg2 text-meta hover:text-fg"
          data-testid="flow-earlier"
        >
          <ChevronRight size={12} strokeWidth={1.5} aria-hidden="true" />
          <Nums
            text={t("flow.earlier", {
              count: earlier.count,
              time: fmtDuration(earlier.aiMs),
            })}
          />
        </button>
      ) : null}
      {rows.map((r) => (
        <FlowLine key={`${r.kind}-${r.start}`} row={r} status={status} tz={tz} />
      ))}
      {flow.doneAt !== null ? (
        <div className="flex items-center gap-3 text-body" data-flow="done">
          <span className="block w-8 shrink-0" aria-hidden="true" />
          <span className="w-14 shrink-0 text-fg2">{t("flow.done")}</span>
          <span className="flex-1 font-mono text-fg2 text-meta">{fmtClock(flow.doneAt, tz)}</span>
        </div>
      ) : null}
      <div className="mt-1 flex items-center gap-1 border-line border-t pt-3 text-fg2 text-meta">
        <span className="text-fg">
          <Nums text={t("flow.totalAi", { time: fmtDuration(total.aiMs) })} />
        </span>
        <span>
          {" · "}
          <Nums text={t("queue.waitTotal", { time: fmtDuration(total.waitMs) })} />
        </span>
        {total.idleMs > 0 ? (
          <span>
            {" · "}
            <Nums text={t("queue.ofIdle", { time: fmtDuration(total.idleMs) })} />
          </span>
        ) : null}
      </div>
    </section>
  );
}

/** 何で止まったかの 1 行（保存した待ちの中身。ADR 0018） */
export function stoppedText(
  w: StoredWait,
  t: ReturnType<typeof useI18n>["t"],
  locale: "en" | "ja",
) {
  const q = (s: string) => (locale === "ja" ? `「${s}」` : `“${s}”`);
  if (w.kind === "permission") return [w.tool, w.label, w.command].filter(Boolean).join(" · ");
  if (w.kind === "error") return w.errorKind ? t(`ai.err.${w.errorKind}` as MessageKey) : "";
  const opts = w.options && w.options.length > 0 ? ` ${w.options.slice(0, 3).join(" / ")}` : "";
  return w.text ? `${q(w.text)}${opts}` : "";
}

function FlowLine({ row, status, tz }: { row: FlowRow; status: WorkItemStatus; tz: string }) {
  const { t, locale } = useI18n();
  // 何を頼んだか / 何で止まったか（保存しているときだけ。1 日の流れとして読めるように。D-218）
  const note = row.asked
    ? t("flow.asked", { text: row.asked })
    : row.stopped
      ? t("flow.stopped", { text: stoppedText(row.stopped, t, locale) })
      : "";
  return (
    <div className="flex flex-col">
      <FlowMain row={row} status={status} tz={tz} />
      {note ? (
        <span
          className="truncate pl-11 text-fg2 text-meta"
          data-flow-note={row.asked ? "asked" : "stopped"}
          title={note}
        >
          {note}
        </span>
      ) : null}
    </div>
  );
}

function FlowMain({ row, status, tz }: { row: FlowRow; status: WorkItemStatus; tz: string }) {
  const { t } = useI18n();
  return (
    <div
      className={`flex items-center gap-3 text-body ${row.now ? "text-fg" : ""}`}
      data-flow={row.kind}
      data-now={row.now ? "1" : undefined}
    >
      <span
        className="block w-8 shrink-0"
        style={{ borderTop: flowLine(row.kind, row.now, status) }}
        aria-hidden="true"
      />
      <span className="w-14 shrink-0 whitespace-nowrap font-medium text-fg">
        {t(`flow.${row.kind}` as MessageKey)}
      </span>
      <span className={`flex-1 font-mono text-meta ${row.now ? "text-fg" : "text-fg2"}`}>
        {fmtClock(row.start, tz)}–{row.now ? t("flow.now") : fmtClock(row.end, tz)}
      </span>
      <span className={`font-mono text-meta ${row.now ? "text-fg" : "text-fg2"}`}>
        {isExcluded(row.kind) ? "—" : fmtDuration(row.end - row.start)}
      </span>
    </div>
  );
}
