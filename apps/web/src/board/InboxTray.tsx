/**
 * 週ボードの Inbox トレイ（ux-mvp 7章の「Inbox カラム」）: 日付なしのタスクを週ボードの左に並べ、日付カラム・時間軸へ
 * ドラッグできるようにする。トレイへ落とすと日付を外す。閉じている間もドラッグ中は左端に細い的を出す。
 * 開閉はこのブラウザに覚える（localStorage。読めなければ閉じた状態）。
 */
import { Inbox, X } from "lucide-react";
import { type ReactNode, useState } from "react";
import { AddRow } from "../components/AddRow.tsx";
import { TaskCard } from "../components/items.tsx";
import { setComplete } from "../data/mutations.ts";
import { useInbox } from "../data/queries.ts";
import { useI18n } from "../i18n/index.tsx";
import { setUi } from "../lib/store.ts";
import { DraggableTask, useBoardDnd, useInboxDrop } from "./dnd.tsx";

const KEY = "turnlane.board.inboxTray";

function readOpen(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function useInboxTray(): { open: boolean; set: (v: boolean) => void; toggle: ReactNode } {
  const [open, setOpen] = useState(readOpen);
  const set = (v: boolean) => {
    setOpen(v);
    try {
      localStorage.setItem(KEY, v ? "1" : "0");
    } catch {
      // 保存できなくても開閉はできる
    }
  };
  return { open, set, toggle: <TrayToggle onClick={() => set(!open)} open={open} /> };
}

function TrayToggle({ onClick, open }: { onClick: () => void; open: boolean }) {
  const { t } = useI18n();
  const n = useInbox().data?.tasks.length ?? 0;
  return (
    <button
      type="button"
      onClick={onClick}
      title={open ? t("board.inboxTray.hide") : t("board.inboxTray.show")}
      aria-label={open ? t("board.inboxTray.hide") : t("board.inboxTray.show")}
      aria-pressed={open}
      className="flex flex-col items-center gap-0.5 rounded-chip px-1 py-0.5 text-fg3 hover:bg-raised hover:text-fg"
      data-testid="inbox-tray-toggle"
    >
      <Inbox size={16} strokeWidth={1.5} aria-hidden="true" />
      {n > 0 ? <span className="font-mono text-micro">{n}</span> : null}
    </button>
  );
}

export function InboxTray({
  open,
  onClose,
  today,
}: {
  open: boolean;
  onClose: () => void;
  today: string;
}) {
  const { t } = useI18n();
  const dnd = useBoardDnd();
  const drop = useInboxDrop();
  const tasks = useInbox().data?.tasks ?? [];
  // Inbox へ落とせるのはタスクだけ（自分の番・AI カードは不可。ux-mvp 7章）
  const active = dnd?.active;
  const dragging = !!active && (active.kind === undefined || active.kind === "task");
  const hot = dragging && dnd?.over?.kind === "inbox";
  if (!open) {
    // 閉じている間は、ドラッグ中だけ左端（時刻の目盛りの上）に的を重ねる（ボードの幅を変えない）
    if (!active || !("task" in active) || active.task.scheduledDate === null) return null;
    return (
      <div
        ref={drop.setNodeRef}
        className={`absolute inset-y-0 left-0 z-40 flex w-11 items-center justify-center border-line border-r ${hot ? "bg-raised" : "bg-sidebar"}`}
        title={t("board.dropToInbox")}
        data-testid="inbox-drop-strip"
      >
        <Inbox size={16} strokeWidth={1.5} className="text-fg2" aria-hidden="true" />
      </div>
    );
  }
  return (
    <aside
      ref={drop.setNodeRef}
      aria-label={t("inbox.title")}
      className={`flex w-[240px] shrink-0 flex-col gap-2 border-line border-r px-2 py-2 ${hot ? "bg-accent/5" : "bg-sidebar"}`}
      data-testid="inbox-tray"
    >
      <div className="flex items-center justify-between px-0.5">
        <h2 className="font-semibold text-meta text-fg2 tracking-wide">
          {t("inbox.title")} <span className="font-mono">{tasks.length}</span>
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("board.inboxTray.hide")}
          title={t("board.inboxTray.hide")}
          className="rounded-chip p-0.5 text-fg3 hover:bg-raised hover:text-fg"
        >
          <X size={14} strokeWidth={1.5} aria-hidden="true" />
        </button>
      </div>
      <AddRow today={today} compact />
      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
        {tasks.length === 0 ? (
          <p className="px-1 py-4 text-center text-meta text-fg3">
            {dragging ? t("board.dropToInbox") : t("inbox.empty")}
          </p>
        ) : null}
        {tasks.map((x) => (
          <DraggableTask key={x.id} task={x}>
            <TaskCard
              task={x}
              onToggle={() => void setComplete(x, x.status !== "done")}
              onClick={() => setUi({ panelTaskId: x.id })}
            />
          </DraggableTask>
        ))}
      </div>
    </aside>
  );
}
