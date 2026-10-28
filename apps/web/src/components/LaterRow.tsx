/**
 * 自分の番の画面の「後で」の行（ux-mvp 4.6）: スヌーズ中・明日へ（次の稼働日へ移してスヌーズ）・時間に置いた自分の番
 * （開始の前）・リセット前の上限待ち。普通の行と同じ構成（件名 / 理由 · リポジトリ · ブランチ）で薄く（猶予中の行と同じ
 * text-tertiary）、右端に戻る時刻（`スヌーズ · 15:00 に戻る` / `明日へ · 10/24 10:00` / `9:00 に` / `利用上限 · 23:41 まで`。
 * 暦の今日でなければ時刻の前に日付）。帯・件数・通知には入れない。
 * 操作は 今やる（上限待ちには出さない）・開く・対応不要・詳細（1 クリック）
 */
import { fmtClock, laterFollowUp, laterKind, type QueueItem } from "@turnlane/core/web";
import { Ban, Undo2 } from "lucide-react";
import { useRef } from "react";
import { useItemActions } from "../actions/item-actions.tsx";
import { useGlance, useSeen, useShowDetail } from "../data/glance.ts";
import { useI18n } from "../i18n/index.tsx";
import { laterTextOf } from "../lib/later-text.ts";
import { whereName } from "../lib/where.ts";
import { HoverToolbar } from "./HoverToolbar.tsx";
import { titleText } from "./items.tsx";
import { OPEN_ICON } from "./OpenWith.tsx";
import { StatusIcon } from "./StatusIcon.tsx";
import { QUEUE_ROW, QUEUE_ROW_SUB, QUEUE_ROW_TITLE, rowSurface } from "./TurnRow.tsx";
import { turnView, WhyContent } from "./TurnWhy.tsx";

type Translate = ReturnType<typeof useI18n>["t"];

/**
 * 理由・件名を普通の行と同じ関数で作るための見かけの行（スヌーズ中・時間に置いたフォローアップを open として渡す。表示だけ）
 */
export function laterViewItem(item: QueueItem): QueueItem {
  return {
    ...item,
    followUps: item.followUps.map((f) =>
      f.status === "snoozed" || f.status === "scheduled" ? { ...f, status: "open" as const } : f,
    ),
  };
}

/**
 * 上限待ちの札（後での行・AI の画面の行）: 明ける時刻が分かれば `利用上限 · 03:00 まで`、見込みなら `利用上限 · 見込み 03:00`
 */
export function limitText(
  w: { until: number; untilKnown: boolean },
  tz: string,
  t: Translate,
): string {
  return t(w.untilKnown ? "queue.later.limit" : "queue.later.limitEstimate", {
    time: fmtClock(w.until, tz),
  });
}

/** 右端の戻る時刻の言葉（AI の詳細パネルの補足と同じ。lib/later-text.ts） */
export function laterLabel(
  item: QueueItem,
  today: string,
  now: number,
  tz: string,
  t: Translate,
): string {
  if (laterKind(item, today) === "limit" && item.limitWait) return limitText(item.limitWait, tz, t);
  const x = laterTextOf(item, today, now, tz);
  return x ? t(x.key, x.params) : "";
}

export function LaterRow({
  item,
  now,
  tz,
  today,
  selected = false,
}: {
  item: QueueItem;
  now: number;
  tz: string;
  today: string;
  selected?: boolean;
}) {
  const { t, locale } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const seen = useSeen(ref);
  const show = useShowDetail();
  const view0 = laterViewItem(item);
  const glance = useGlance(view0, seen);
  const view = turnView(view0, glance, locale);
  const parts = view.parts;
  const fu = laterFollowUp(item);
  const kind = laterKind(item, today);
  const title = view.subject || (fu ? titleText(fu.title, locale) : (item.title ?? ""));
  const why = parts.why ? t(`turn.why.${parts.why}`) : kind === "limit" ? t("board.limit") : "";
  const content = show && parts.hasContent ? <WhyContent parts={parts} /> : null;
  const link = [whereName(item, t("ai.scratch")), item.branch].filter(Boolean).join(" · ");
  const label = laterLabel(item, today, now, tz, t);
  const actions = useItemActions();
  const key = `turn:${item.workItemId}`;
  const run = (id: string) => () => actions?.run(key, id);
  const toolbar = actions ? (
    <HoverToolbar
      tipSide="bottom"
      onMore={(e) => actions.menu(e, key)}
      buttons={[
        ...(fu
          ? [
              {
                id: "wake",
                icon: Undo2,
                label: t("queue.later.wake"),
                onClick: run("wake"),
              },
            ]
          : []),
        {
          id: "open",
          icon: OPEN_ICON,
          label: t("menu.openTurn"),
          keyId: "open",
          onClick: run("open"),
        },
        {
          id: "dismiss",
          icon: Ban,
          label: t("menu.dismiss"),
          keyId: "dismiss",
          onClick: run("dismiss"),
        },
      ]}
    />
  ) : null;
  const status =
    kind === "limit"
      ? "done"
      : item.status === "needs_input" || item.status === "error"
        ? item.status
        : "your_turn";
  return (
    // biome-ignore lint/a11y/useSemanticElements: 行の中にボタンを置くため div
    <div
      ref={ref}
      role="button"
      tabIndex={-1}
      onClick={actions ? () => actions.click(key) : undefined}
      onKeyDown={undefined}
      onContextMenu={actions ? (e) => actions.menu(e, key) : undefined}
      onDoubleClick={actions ? () => actions.doubleClick(key) : undefined}
      data-kind="turn"
      data-id={item.workItemId}
      data-later={kind}
      data-selected={selected ? "" : undefined}
      title={[title, why, link, label].filter(Boolean).join("\n")}
      aria-label={[title, why, link, label].filter(Boolean).join("、")}
      className={`${QUEUE_ROW} ${rowSurface({ selected })} text-fg3 ${fu ? "hover:pr-[86px]" : "hover:pr-[60px]"}`}
    >
      <span className="inline-flex shrink-0 opacity-60">
        <StatusIcon status={status} estimated={item.estimated} size={16} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col">
        <span data-kind="turn-title" className={QUEUE_ROW_TITLE}>
          {title}
        </span>
        <span className={QUEUE_ROW_SUB.replace("text-fg2", "text-fg3")}>
          <span className="min-w-0 truncate" data-kind="turn-why">
            {why}
            {content ? (
              <>
                {why ? <span> · </span> : null}
                {content}
              </>
            ) : null}
          </span>
          {link ? (
            <span className="ml-6 min-w-0 shrink-[3] truncate" data-kind="turn-link">
              {link}
            </span>
          ) : null}
        </span>
      </div>
      <span data-kind="later-back" className="shrink-0 whitespace-nowrap text-fg3 text-meta">
        {label}
      </span>
      {toolbar}
    </div>
  );
}

/** 後での節の開閉（既定は開いた状態。ブラウザに覚える） */
const FOLD_KEY = "turnlane.laterOpen";

export function readLaterOpen(): boolean {
  try {
    return localStorage.getItem(FOLD_KEY) !== "0";
  } catch {
    return true;
  }
}

export function writeLaterOpen(open: boolean): void {
  try {
    localStorage.setItem(FOLD_KEY, open ? "1" : "0");
  } catch {
    // 保存できなくても開閉はできる
  }
}
