/**
 * 猶予中の問いを自分の番の行に出す（D-245）と、AI のレーンで対応が要るものを前に出す（D-246）
 */
import { describe, expect, test } from "bun:test";

import type { QueueItem } from "@turnlane/core/web";

import { menuSpec } from "../src/actions/item-actions.tsx";

import { laneRank, laneStatus, laneWaitsOf, questionWait } from "../src/board/lane-wait.ts";

import type { SelItem } from "../src/lib/store.ts";

const MIN = 60_000;

const base = (id: string, o: Partial<QueueItem> = {}): QueueItem => ({
  workItemId: id,
  title: id,
  status: "your_turn",
  reason: null,
  estimated: false,
  repoRoot: "/w/app",
  branch: "feat/x",
  prRef: null,
  sources: [],
  waitingSince: 0,
  waitStartedAway: false,
  followUps: [],
  ...o,
});
const fu = (id: string, kind: "reply" | "approve" = "reply") => ({
  id,
  kind,
  status: "open" as const,
  title: { t: "text" as const, text: id },
  triggerAt: 0,
  snoozeUntil: null,
  engagedAt: null,
  expiresAt: null,
  taskId: null,
  taskDate: null,
  task: null,
});
const graceItem = (id: string, since: number) =>
  base(id, {
    waitingSince: since,
    wait: { kind: "question", turnId: `t-${id}`, followUpId: null },
    grace: { until: since + 15 * MIN },
  });

describe("猶予中の行の操作（D-245）: 答える・開く・詳細だけ", () => {
  const ids = (xs: { id: string }[]) => xs.map((x) => x.id);
  test("右クリック: 完了・明日へ・スヌーズ・対応不要は出さない", () => {
    const g: SelItem = { kind: "turn", item: graceItem("g", 0) };
    expect(ids(menuSpec([g], { answer: true }))).toEqual(["open", "answer", "detail"]);
    expect(ids(menuSpec([g]))).toEqual(["open", "detail"]);
  });
  test("猶予が過ぎて返答タスクができた行は普通の右クリック", () => {
    const n: SelItem = {
      kind: "turn",
      item: { ...graceItem("g", 0), followUps: [fu("f1")] },
    };
    expect(ids(menuSpec([n], { answer: true }))).toContain("dismiss");
  });
});

describe("AI のレーンの順と印（D-246）", () => {
  const waits = laneWaitsOf({
    items: [
      base("perm", {
        status: "needs_input",
        followUps: [fu("f1", "approve")],
        waitingSince: 3 * MIN,
        wait: { kind: "permission", turnId: "tp", followUpId: "f1" },
      }),
      base("pr", { followUps: [{ ...fu("f2"), kind: "review_pr" }] }),
    ],
    grace: [graceItem("q", 5 * MIN)],
  });
  test("待ちは queue の wait（猶予中を含む）から。PR の確認待ちは待ちに入れない", () => {
    expect([...waits.keys()].sort()).toEqual(["perm", "q"]);
    expect(waits.get("q")).toEqual({ kind: "question", since: 5 * MIN, grace: true });
    expect(waits.get("perm")?.grace).toBe(false);
  });
  test("順: 自分の番（問い・許可・エラー。猶予中を含む）→ 実行中 → 完了・PR", () => {
    const rows = [
      { id: "done", r: laneRank("done", undefined) },
      { id: "running", r: laneRank("running", undefined) },
      { id: "q", r: laneRank("done", waits.get("q")) },
      { id: "err", r: laneRank("error", undefined) },
      { id: "pr", r: laneRank("your_turn", undefined) },
    ];
    expect(
      [...rows].sort((a, b) => a.r - b.r || a.id.localeCompare(b.id)).map((x) => x.id),
    ).toEqual(["err", "q", "running", "done", "pr"]);
  });
  test("問いで止まっている（猶予中を含む）最後の線は ✓ ではなく自分の番の印。許可・エラーはそのまま", () => {
    expect(laneStatus("done", waits.get("q"))).toBe("your_turn");
    expect(laneStatus("needs_input", waits.get("perm"))).toBe("needs_input");
    expect(laneStatus("done", undefined)).toBe("done");
    expect(questionWait(waits.get("perm"))).toBeNull();
    expect(questionWait(waits.get("q"))?.grace).toBe(true);
  });
});
