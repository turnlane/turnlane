/**
 * Inbox の行（Inbox のレビュー v1）: 自分の番の画面の行と同じ部品（枠なし、ホバーで沈んだ面、選択中は細い枠、ホバーのボタン）。
 * ○ と題名、2行目は普通の書体で「プロジェクトの色の点 名前 · 出どころ（利用者の言葉）」。右端に等幅の見積もり、AI に頼める
 * タスク（プロジェクトにリポジトリがある）は小さな AI のアイコン、メモがあれば小さなメモのアイコン、7日以上残ったものは薄い字で
 * `8日前`（自分の番の「待ち」と同じ位置）。
 * ○ はマウスを乗せたとき・選んでいるときだけ。ホバーのボタンは 日に置く・AI に頼む・⋯（T4。D-139 (4)）。
 * 完了は塗った ✓ と薄い字。完了にした直後（lingering）は2行目を「完了 · 少しして今日閉じたへ」にしてその場に残す
 */
import { fmtDuration, type TaskView } from "@turnlane/core/web";
import { CalendarDays, SquareTerminal, StickyNote } from "lucide-react";
import { useItemActions } from "../actions/item-actions.tsx";
import { useI18n } from "../i18n/index.tsx";
import { TaskAiLine } from "../launch/TaskAiLine.tsx";
import { HoverToolbar } from "./HoverToolbar.tsx";
import { originLabel, titleText } from "./items.tsx";
import { QUEUE_ROW, QUEUE_ROW_SUB, QUEUE_ROW_TITLE, rowSurface, WaitText } from "./TurnRow.tsx";
import { Check } from "./ui.tsx";

const DAY = 86_400_000;
/** これ以上残ったものに `N日前` を出す */
export const STALE_DAYS = 7;

/** Inbox に入ってからの日数（7日未満は null） */
export function staleDays(createdAt: number, now: number): number | null {
  const d = Math.floor((now - createdAt) / DAY);
  return d >= STALE_DAYS ? d : null;
}

export function InboxRow({
  task,
  now,
  project,
  selected = false,
  onClick,
  onToggle,
  aiReady = false,
  lingering = false,
}: {
  task: TaskView;
  now: number;
  project?: { name: string; color: string | null } | null | undefined;
  selected?: boolean;
  onClick?: () => void;
  onToggle?: () => void;
  /** AI に頼める（プロジェクトにリポジトリがあり、まだ頼んでいない）。ふだん右に小さな AI のアイコン */
  aiReady?: boolean;
  /** 完了にした直後で、まだ「今日閉じた」へ移していない */
  lingering?: boolean;
}) {
  const { t, locale } = useI18n();
  const actions = useItemActions();
  const k = `task:${task.id}`;
  const done = task.status === "done";
  const title = titleText(task.title, locale);
  const source = originLabel(task.origin, t);
  const days = staleDays(task.createdAt, now);
  const mouse = actions
    ? {
        onContextMenu: (e: React.MouseEvent) => actions.menu(e, k),
        onDoubleClick: () => actions.doubleClick(k),
      }
    : {};
  return (
    // biome-ignore lint/a11y/useSemanticElements: 行の中にチェックボックス（ボタン）を置くため div
    <div
      role="button"
      tabIndex={-1}
      data-kind="task"
      data-id={task.id}
      data-selected={selected ? "" : undefined}
      data-lingering={lingering ? "" : undefined}
      onClick={onClick}
      onKeyDown={undefined}
      {...mouse}
      className={`${QUEUE_ROW} ${rowSurface({ selected })} ${done && !selected ? "opacity-60" : ""}`}
    >
      <Check
        checked={done}
        reveal
        label={done ? t("action.uncomplete") : t("action.complete")}
        {...(onToggle ? { onToggle } : {})}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <span
          data-kind="task-title"
          className={`${QUEUE_ROW_TITLE} ${done ? "text-fg2" : "text-fg"}`}
        >
          {title}
        </span>
        {lingering ? (
          <span className={QUEUE_ROW_SUB} data-kind="task-sub">
            {t("inbox.doneMoving")}
          </span>
        ) : project || source ? (
          <span className={QUEUE_ROW_SUB} data-kind="task-sub">
            {project ? (
              <>
                <span
                  className="size-1.5 shrink-0 rounded-full"
                  style={{ background: project.color ?? "var(--dl-text-3)" }}
                  aria-hidden="true"
                />
                <span className="min-w-0 truncate">{project.name}</span>
              </>
            ) : null}
            {project && source ? <span aria-hidden="true">·</span> : null}
            {source ? (
              <span className="min-w-0 shrink-0 truncate" data-kind="task-source">
                {source}
              </span>
            ) : null}
          </span>
        ) : null}
        {task.ai && !done ? <TaskAiLine ai={task.ai} taskId={task.id} /> : null}
      </div>
      {task.estimateMin !== null && !done ? (
        <span className="shrink-0 font-mono text-fg2 text-meta" data-kind="task-estimate">
          {fmtDuration(task.estimateMin * 60_000)}
        </span>
      ) : null}
      {aiReady && !done ? (
        // AI に頼める印（ふだんだけ。ホバー・選択中はボタンに替わる）
        <span
          className="shrink-0 text-fg3 group-hover:invisible group-data-[selected]:invisible"
          title={t("launch.title")}
          data-kind="task-ai-ready"
        >
          <SquareTerminal size={14} strokeWidth={1.5} aria-hidden="true" />
        </span>
      ) : null}
      {task.hasNotes ? (
        <span className="shrink-0 text-fg3" title={t("inbox.hasNotes")} data-kind="task-notes">
          <StickyNote size={14} strokeWidth={1.5} aria-hidden="true" />
          <span className="sr-only">{t("inbox.hasNotes")}</span>
        </span>
      ) : null}
      {days !== null ? (
        <span
          className="shrink-0 whitespace-nowrap text-fg3 text-meta"
          title={t("inbox.old")}
          data-kind="task-age"
        >
          <WaitText text={t("inbox.age", { count: days })} />
        </span>
      ) : null}
      {!done && actions ? (
        <HoverToolbar
          align="center"
          buttons={[
            {
              id: "move",
              icon: CalendarDays,
              label: t("taskPanel.placeDate"),
              keyId: "move",
              onClick: () => actions.run(k, "move"),
            },
            {
              id: "askAi",
              icon: SquareTerminal,
              label: t("launch.title"),
              onClick: (el) => actions.run(k, "askAi", el),
            },
          ]}
          onMore={(e) => actions.menu(e, k)}
        />
      ) : null}
    </div>
  );
}
