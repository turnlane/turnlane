/** タスクに付く「頼んだ AI」の状態（D-107。plan §B.2）の1行 */
import type { TaskAiState, TaskAiView, WorkItemStatus } from "@turnlane/core/web";
import { useSyncExternalStore } from "react";
import { StatusIcon } from "../components/StatusIcon.tsx";
import { useI18n } from "../i18n/index.tsx";
import { getCleaning, subscribeCleaning } from "./finish.ts";

/** 頼んだ AI の状態 → 状態アイコン（形と色は AI 項目と同じ。AI 完了 · 確認は自分の番の色） */
export const TASK_AI_ICON: Record<TaskAiState, WorkItemStatus> = {
  starting: "running",
  running: "running",
  needs_input: "needs_input",
  your_turn: "your_turn",
  done_check: "your_turn",
  error: "error",
  limit: "needs_input",
  unlinked: "error",
  failed: "error",
};

/** 完了のときの片付けの途中のタスク（行の札を `片付け中` にする） */
export function useCleaningTasks(): ReadonlySet<string> {
  return useSyncExternalStore(subscribeCleaning, getCleaning, getCleaning);
}

/**
 * タスクのカード・詳細パネルの「頼んだ AI」の1行（状態アイコンと言葉。ツール名は mono にしない）。完了のときの片付けの途中は
 * `片付け中`（taskId を渡したとき）
 */
export function TaskAiLine({
  ai,
  taskId,
  className = "",
}: {
  ai: TaskAiView;
  taskId?: string;
  className?: string;
}) {
  const { t } = useI18n();
  const cleaning = useCleaningTasks().has(taskId ?? "");
  return (
    <span
      className={`flex min-w-0 items-center gap-1.5 text-meta ${ai.state === "failed" || ai.state === "unlinked" ? "text-fg2" : "text-fg"} ${className}`}
      data-testid="task-ai"
      data-state={cleaning ? "cleaning" : ai.state}
    >
      <StatusIcon status={cleaning ? "running" : TASK_AI_ICON[ai.state]} size={12} title={false} />
      <span className="truncate">
        {t(cleaning ? "launch.state.cleaning" : `launch.state.${ai.state}`)}
      </span>
    </span>
  );
}
