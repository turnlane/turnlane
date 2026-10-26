/**
 * AI の線のホバーの吹き出し（D-116。案 design/mock-ai-detail-v1 の「AI の線のホバー」）: 詳細パネルの見出しと同じ言葉で
 * 題名 / 状態 · 長さ / うち放置 · AI（待ちがあるときだけ）/ リポジトリ · ブランチ / クリックで詳細。ターン・ツール呼び出しの数は出さない。
 * 幅 250px、線の右に出し、画面の端に当たるときは左へ（Tooltip の placeTip）。画面に1つだけ（AiHoverLayer を外枠に1つ置く）
 */
import { type AiRun, fmtDuration, type WorkItemStatus } from "@turnlane/core/web";
import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { type MessageKey, useI18n } from "../i18n/index.tsx";
import { whereName } from "../lib/where.ts";
import { Nums } from "./Nums.tsx";
import { StatusIcon } from "./StatusIcon.tsx";
import { placeTip } from "./Tooltip.tsx";

/** ホバーに出す中身（AI レーンの項目から作る。aiHoverOf） */
export interface AiHover {
  title: string | null;
  status: WorkItemStatus;
  estimated: boolean;
  head: MessageKey;
  sub: MessageKey | null;
  durMs: number | null;
  /** 待ちがあるときだけ「うち放置 · AI」 */
  idleMs: number | null;
  aiMs: number;
  where: string | null;
  /** 前日に計上する深夜の実行（`Counted in Sun 10/4`） */
  hint?: string | undefined;
}

type LaneItem = {
  title: string | null;
  status: WorkItemStatus;
  reason: string | null;
  estimated: boolean;
  repoRoot: string | null;
  scratch?: boolean | undefined;
  branch: string | null;
  aiMs: number;
  runs: readonly AiRun[];
  waits: readonly { start: number; end: number; waitKey: string; idle: boolean; open: boolean }[];
};

/**
 * AI レーンの項目 → ホバーの中身（詳細パネルの見出し aiHeadOf と同じ言葉。純粋関数）。scratchLabel は壁打ちの
 * リポジトリの欄の名前（D-135）
 */
export function aiHoverOf(it: LaneItem, now: number, scratchLabel = "Scratch"): AiHover {
  const open = it.waits.find((w) => w.open);
  const segs = open ? it.waits.filter((w) => w.waitKey === open.waitKey) : [];
  const last = segs.at(-1);
  const waitFrom = segs.length > 0 ? Math.min(...segs.map((w) => w.start)) : null;
  const idleMs = segs
    .filter((w) => w.idle)
    .reduce((a, w) => a + ((w === last ? Math.max(w.end, now) : w.end) - w.start), 0);
  const runs = [...it.runs].sort((a, b) => a.start - b.start);
  const lastRun = runs.at(-1);
  const where = [whereName(it, scratchLabel), it.branch].filter(Boolean).join(" · ") || null;
  const base = {
    title: it.title,
    status: it.status,
    estimated: it.estimated,
    aiMs: it.aiMs,
    where,
  };
  const waiting = {
    durMs: waitFrom !== null ? now - waitFrom : null,
    idleMs: waitFrom !== null ? idleMs : null,
  };
  if (it.status === "running") {
    // 今の稼働（間が1分未満のターンは続きとみなす）
    let start = lastRun?.start ?? now;
    for (let i = runs.length - 2; i >= 0; i--) {
      const r = runs[i] as AiRun;
      if (start - r.end < 60_000) start = r.start;
      else break;
    }
    return { ...base, head: "status.running", sub: null, durMs: now - start, idleMs: null };
  }
  if (it.status === "needs_input")
    return {
      ...base,
      head: "status.needs_input",
      sub: it.reason === "ask_user_question" ? "board.needsAnswer" : "board.needsPermission",
      ...waiting,
    };
  if (it.status === "error")
    return { ...base, head: "status.error", sub: "ai.sub.stopped", ...waiting };
  if (it.status === "your_turn") {
    if (it.reason === "hook:stop")
      return { ...base, head: "ai.head.aiDone", sub: "ai.sub.check", ...waiting };
    if (it.reason === "pr_open" || it.reason === "edits")
      return {
        ...base,
        head: "ai.head.aiDone",
        sub: it.reason === "pr_open" ? "ai.sub.prReview" : "ai.sub.changes",
        durMs: lastRun ? now - lastRun.end : null,
        idleMs: waiting.idleMs,
      };
    return { ...base, head: "status.your_turn", sub: "queue.kind.reply", ...waiting };
  }
  return { ...base, head: "status.done", sub: null, durMs: null, idleMs: null };
}

interface Shown {
  rect: { top: number; left: number; right: number; bottom: number; width: number };
  data: AiHover;
}
let current: Shown | null = null;
const listeners = new Set<() => void>();
const set = (x: Shown | null) => {
  current = x;
  for (const l of listeners) l();
};

/** 線（要素の中の data-bar、無ければ要素）の右に出すハンドラ */
export function aiHoverProps(data: AiHover) {
  return {
    onMouseEnter: (e: React.MouseEvent<HTMLElement>) => {
      const bar = e.currentTarget.querySelector("[data-bar]") ?? e.currentTarget;
      const r = bar.getBoundingClientRect();
      set({
        rect: { top: r.top, left: r.left, right: r.right, bottom: r.bottom, width: r.width },
        data,
      });
    },
    onMouseLeave: () => set(null),
    onMouseDown: () => set(null),
  };
}

export function hideAiHover(): void {
  set(null);
}

export function AiHoverLayer() {
  const shown = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
    () => current,
  );
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ of: Shown; top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!shown || !el) return;
    // 線の上端の高さに、線の右へ（はみ出すなら左へ）。placeTip は的の中ほどに合わせるので、的の高さを吹き出しの高さにする
    const p = placeTip(
      "right",
      { ...shown.rect, bottom: shown.rect.top + el.offsetHeight },
      { width: el.offsetWidth, height: el.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight },
    );
    setPos({ of: shown, top: p.top, left: p.left });
  }, [shown]);
  if (!shown) return null;
  const placed = pos?.of === shown ? pos : null;
  return createPortal(
    <div
      ref={ref}
      role="tooltip"
      data-testid="ai-hover"
      className="pointer-events-none fixed z-[60] flex w-[250px] flex-col gap-1 rounded-pop border border-line bg-raised px-3 py-2.5 shadow-pop"
      style={{
        top: placed?.top ?? 0,
        left: placed?.left ?? 0,
        visibility: placed ? "visible" : "hidden",
      }}
    >
      <HoverBody d={shown.data} />
    </div>,
    document.body,
  );
}

function HoverBody({ d }: { d: AiHover }) {
  const { t } = useI18n();
  return (
    <>
      <div className="truncate font-semibold text-body text-fg">{d.title ?? t("common.none")}</div>
      <div className="flex items-center gap-1.5 text-fg text-meta">
        <StatusIcon status={d.status} estimated={d.estimated} size={14} title={false} />
        <span className="min-w-0 truncate">
          <span className="font-medium">{t(d.head)}</span>
          {d.sub ? ` · ${t(d.sub)}` : ""}
          {d.durMs !== null ? (
            <>
              {d.sub ? " " : " · "}
              <span className="font-mono">{fmtDuration(d.durMs)}</span>
            </>
          ) : null}
          {d.status === "done" ? (
            <>
              {" · "}
              <Nums text={t("flow.totalAi", { time: fmtDuration(d.aiMs) })} />
            </>
          ) : null}
        </span>
      </div>
      {d.idleMs !== null ? (
        <div className="text-fg2 text-meta">
          <Nums
            text={t("ai.hover.idleAi", {
              idle: fmtDuration(d.idleMs),
              ai: fmtDuration(d.aiMs),
            })}
          />
        </div>
      ) : null}
      {d.where ? <div className="truncate text-fg2 text-meta">{d.where}</div> : null}
      {d.hint ? <div className="text-fg2 text-meta">{d.hint}</div> : null}
      <div className="mt-0.5 text-[11px] text-fg3">{t("ai.hover.click")}</div>
    </>
  );
}
