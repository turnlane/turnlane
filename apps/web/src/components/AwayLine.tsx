/**
 * 離れていた間のまとめの 1 行（ux-mvp 4.13、D-214 (2)）。メニューバーの上と、今日の列の帯の見出し（「自分の番 N」の右）に出す。
 * `17:14–17:48 の間に  完了 1 · PR 1 · 新しい待ち 1  ▸`。押すと下に件が開く（状態アイコン・件名・何が起きたか）。
 * 件を押すと開く（待ちは engage して端末へ、ほかは詳細パネル）。開いたらまとめは閉じる（同じ離席ではもう出さない）。
 * 言い方は事実だけ（挨拶・擬人化・「AI ががんばった」は書かない）。時刻の区間から始める
 */
import {
  type AwayDigest,
  type AwayGroup,
  type AwayItem,
  addDays,
  type ChangeSize,
  fmtClock,
  toLocalDate,
  type WorkItemStatus,
} from "@turnlane/core/web";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import { useAway } from "../data/queries.ts";
import { type I18n, useI18n } from "../i18n/index.tsx";
import { Nums } from "./Nums.tsx";
import { StatusIcon } from "./StatusIcon.tsx";

type T = I18n["t"];

/** 区間の言い方: 同じ日は `17:14–17:48 の間に`、前の日からは `昨日 19:02 から`、それより前は `10/14 19:02 から` */
export function awayRange(d: Pick<AwayDigest, "from" | "to">, tz: string, t: T): string {
  const from = fmtClock(d.from, tz);
  const a = toLocalDate(d.from, tz, 0);
  const b = toLocalDate(d.to, tz, 0);
  if (a === b) return t("away.range", { from, to: fmtClock(d.to, tz) });
  if (addDays(a, 1) === b) return t("away.sinceYesterday", { from });
  const [, m, day] = a.split("-").map(Number) as [number, number, number];
  return t("away.sinceDate", { date: `${m}/${day}`, from });
}

const ORDER: AwayGroup[] = ["done", "pr", "wait", "error"];

/** 件数（0 の区分は出さない）: `完了 1 · PR 1 · 新しい待ち 1` */
export function awayCounts(d: Pick<AwayDigest, "counts">, t: T): string {
  return ORDER.filter((g) => d.counts[g] > 0)
    .map((g) => t(`away.count.${g}`, { count: d.counts[g] }))
    .join(" · ");
}

/** 変更の量: `6 ファイル · +120 −8 · CI 通過`（無いものは出さない） */
export function changeText(c: ChangeSize | null | undefined, t: T): string {
  if (!c) return "";
  const parts: string[] = [];
  if (c.files !== null && c.files > 0) parts.push(t("away.files", { count: c.files }));
  if (typeof c.additions === "number" && typeof c.deletions === "number")
    parts.push(`+${c.additions} −${c.deletions}`);
  if (c.ci === "pass" || c.ci === "fail" || c.ci === "pending") parts.push(t(`away.ci.${c.ci}`));
  return parts.join(" · ");
}

/** 何が起きたか: `完了 · 6 ファイル` / `PR #190 を開いた` / `問い · 17:41` */
export function awayWhat(x: AwayItem, tz: string, t: T): string {
  const time = fmtClock(x.at, tz);
  const head =
    x.kind === "pr_opened" || x.kind === "pr_merged"
      ? t(`away.kind.${x.kind}`, { n: x.pr?.number ?? "" })
      : t(`away.kind.${x.kind}`, { time });
  const ch = changeText(x.change, t);
  return ch ? `${head} · ${ch}` : head;
}

const ICON: Record<AwayItem["kind"], WorkItemStatus> = {
  done: "done",
  pr_opened: "your_turn",
  pr_merged: "done",
  question: "your_turn",
  ask: "your_turn",
  permission: "needs_input",
  error: "error",
};

/**
 * まとめの 1 行と開いた一覧。digest が無ければ何も出さない。onOpen は件を開く（呼んだ側でまとめを閉じる）
 */
export function AwayLine({
  digest,
  tz,
  now,
  variant,
  onOpen,
}: {
  digest: AwayDigest | null | undefined;
  tz: string;
  now: number;
  variant: "tray" | "band";
  onOpen: (x: AwayItem, d: AwayDigest) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  if (!digest || now >= digest.until || digest.items.length === 0) return null;
  const Chevron = open ? ChevronDown : ChevronRight;
  const tray = variant === "tray";
  return (
    <div
      className={`flex min-w-0 flex-col ${tray ? "px-2" : ""}`}
      data-testid="away"
      data-variant={variant}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        title={open ? t("away.collapse") : t("away.expand")}
        className={`flex min-w-0 items-center gap-2 rounded-control text-left text-fg2 text-meta hover:bg-sunken hover:text-fg ${
          tray ? "h-7 px-2" : "h-6 px-1"
        }`}
        data-testid="away-line"
      >
        <Nums className="shrink-0" text={awayRange(digest, tz, t)} />
        <span className="min-w-0 truncate" data-kind="away-counts">
          {awayCounts(digest, t)}
        </span>
        <Chevron
          size={14}
          strokeWidth={1.5}
          className="ml-auto shrink-0 text-fg3"
          aria-hidden="true"
        />
      </button>
      {open ? (
        <ul className="flex min-w-0 flex-col" data-testid="away-list">
          {digest.items.map((x) => (
            <li key={x.workItemId} className="min-w-0">
              <button
                type="button"
                onClick={() => onOpen(x, digest)}
                className={`flex w-full min-w-0 items-center gap-2 rounded-control text-left text-meta hover:bg-sunken ${
                  tray ? "h-7 pr-2 pl-5" : "h-6 pr-1 pl-3"
                }`}
                data-testid="away-item"
                data-id={x.workItemId}
                data-kind={x.kind}
                title={`${x.title ?? ""}\n${awayWhat(x, tz, t)}`}
              >
                <StatusIcon status={ICON[x.kind]} size={12} title={false} />
                <span className="min-w-[40%] flex-1 truncate text-fg">
                  {x.title ?? t("common.none")}
                </span>
                <span className="min-w-0 truncate whitespace-nowrap text-fg2" data-kind="away-what">
                  <Nums text={awayWhat(x, tz, t)} />
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** まとめを読む（設定がオフ・離席が無いときは null） */
export function useAwayDigest(): AwayDigest | null {
  return useAway().data?.digest ?? null;
}
