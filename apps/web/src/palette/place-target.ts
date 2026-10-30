/**
 * 時間に置く（`p`。ux-mvp 6.1）の対象: 選んでいるタスク 1 件か、自分の番の行 1 件（Issue #4）。自分の番の行は、その待ちの
 * タスク（返答・確認・許可・再開のタスク）を置く（自分レーンへドラッグしたのと同じ。placeTurn）。純粋関数にしてテストする
 */
import { primaryFollowUp, type TaskView, type TitleSpec } from "@turnlane/core/web";
import type { SelItem } from "../lib/store.ts";

export type PlaceTarget =
  | {
      kind: "task";
      task: TaskView;
      title: TitleSpec;
      estimateMin: number | null;
      date: string | null;
    }
  | {
      kind: "turn";
      followUpId: string;
      taskId: string;
      title: TitleSpec;
      estimateMin: null;
      date: string | null;
    };

export function placeTargetOf(sel: readonly SelItem[]): PlaceTarget | null {
  if (sel.length !== 1) return null;
  const x = sel[0];
  if (x?.kind === "task")
    return {
      kind: "task",
      task: x.task,
      title: x.task.title,
      estimateMin: x.task.estimateMin,
      date: x.task.scheduledDate,
    };
  if (x?.kind === "turn") {
    const fu = primaryFollowUp(x.item);
    if (!fu?.taskId) return null;
    return {
      kind: "turn",
      followUpId: fu.id,
      taskId: fu.taskId,
      title: fu.title,
      estimateMin: null,
      date: fu.taskDate,
    };
  }
  return null;
}
