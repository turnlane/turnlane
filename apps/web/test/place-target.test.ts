/** 時間に置く（`p`）の対象（Issue #4）: タスク 1 件か、自分の番の行 1 件（その待ちのタスク） */
import { describe, expect, test } from "bun:test";
import type { QueueItem, TaskView } from "@turnlane/core/web";
import { placeTargetOf } from "../src/palette/place-target.ts";

const title = { t: "text", text: "x" } as const;
const turn = (taskId: string | null) =>
  ({
    kind: "turn",
    item: {
      workItemId: "w1",
      followUps: [
        {
          id: "f1",
          kind: "reply",
          status: "open",
          title,
          taskId,
          taskDate: "2026-10-02",
          triggerAt: 0,
          snoozeUntil: null,
          engagedAt: null,
          expiresAt: null,
          task: null,
        },
      ],
    } as unknown as QueueItem,
  }) as const;

describe("placeTargetOf", () => {
  test("自分の番の行 1 件は、その待ちのタスクを置く", () => {
    expect(placeTargetOf([turn("t1")])).toEqual({
      kind: "turn",
      followUpId: "f1",
      taskId: "t1",
      title,
      estimateMin: null,
      date: "2026-10-02",
    });
  });
  test("タスクの無い待ち・複数選択・AI の項目は対象にしない", () => {
    expect(placeTargetOf([turn(null)])).toBeNull();
    expect(placeTargetOf([turn("t1"), turn("t2")])).toBeNull();
    expect(placeTargetOf([{ kind: "ai", id: "w1", title: null }])).toBeNull();
  });
  test("タスク 1 件は今までどおり", () => {
    const task = { id: "t9", title, estimateMin: 45, scheduledDate: null } as unknown as TaskView;
    expect(placeTargetOf([{ kind: "task", task }])).toMatchObject({
      kind: "task",
      estimateMin: 45,
    });
  });
});
