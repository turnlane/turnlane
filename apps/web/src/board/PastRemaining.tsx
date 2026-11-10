/**
 * 「過去から N 件」（0.8.2。ux-mvp の今日の未定）: 今日より前の日付に todo / doing のまま残っている自分のタスクを、今日の
 * 「未定 N」の見出しの直下に 1 行で出す。既定は畳んだ状態で、行の左を押すと日付ごと（新しい順・警告色の小見出し）に
 * 通常のタスクの行（未定の行と同じ部品。親が描く）を並べる。右端の「すべて今日へ」で全部を今日の未定へ移す（元に戻せる）。
 * 0 件なら何も出さない。開閉はこのセッションの間だけ覚える（デイビューと 3 日ボードで共通）
 */
import type { PastRemainingGroup, TaskView } from "@turnlane/core/web";
import { ChevronRight } from "lucide-react";
import { type ReactNode, useState } from "react";
import { carryPast } from "../data/mutations.ts";
import { useI18n } from "../i18n/index.tsx";

const OPEN_KEY = "turnlane.pastRemaining.open";

function readOpen(): boolean {
  try {
    return sessionStorage.getItem(OPEN_KEY) === "1";
  } catch {
    return false;
  }
}

function writeOpen(v: boolean): void {
  try {
    sessionStorage.setItem(OPEN_KEY, v ? "1" : "0");
  } catch {}
}

/** 件数（純粋関数） */
export function pastCount(groups: readonly PastRemainingGroup[] | undefined): number {
  return (groups ?? []).reduce((n, g) => n + g.tasks.length, 0);
}

export function PastRemaining({
  groups,
  renderTask,
}: {
  groups: readonly PastRemainingGroup[] | undefined;
  /** タスクの行（未定の行と同じ部品。クリック・ドラッグ・右クリックはその部品のまま） */
  renderTask: (task: TaskView) => ReactNode;
}) {
  const { t, shortDate } = useI18n();
  const [open, setOpen] = useState(readOpen);
  const count = pastCount(groups);
  if (count === 0) return null;
  return (
    <div
      className="flex flex-col gap-1.5"
      data-testid="past-remaining"
      data-open={open ? "" : undefined}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5">
        <button
          type="button"
          onClick={() => {
            setOpen(!open);
            writeOpen(!open);
          }}
          aria-expanded={open}
          className="flex shrink-0 items-center gap-1 rounded-control px-0.5 text-fg2 text-meta hover:text-fg"
          data-testid="past-remaining-toggle"
        >
          <ChevronRight
            size={12}
            strokeWidth={1.5}
            aria-hidden="true"
            className={open ? "rotate-90" : ""}
          />
          {t("board.pastRemaining", { count })}
        </button>
        <button
          type="button"
          onClick={() => void carryPast()}
          className="shrink-0 rounded-control px-1 text-fg2 text-meta hover:underline"
          title={t("board.pastRemaining.def")}
          data-testid="past-remaining-carry"
        >
          {t("board.pastRemaining.carry")}
        </button>
      </div>
      {open
        ? (groups ?? []).map((g) => (
            <div
              key={g.date}
              className="flex flex-col gap-1.5"
              data-testid="past-remaining-day"
              data-date={g.date}
            >
              <h3 className="px-0.5 font-medium text-meta text-needs">{shortDate(g.date)}</h3>
              {g.tasks.map((x) => (
                <div key={x.id}>{renderTask(x)}</div>
              ))}
            </div>
          ))
        : null}
    </div>
  );
}
