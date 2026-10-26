/**
 * 自分の番の画面の「後で」の行（ux-mvp 4.6）: スヌーズ中・明日へ・時間に置いた自分の番（開始の前）・リセット前の上限待ち。
 * 帯・件数・通知（visibleQueue）には入れない。今やる（スヌーズ解除・時間の割り当てを外す）の楽観的更新
 */
import { describe, expect, test } from "bun:test";
import {
  removeLimitWaitFromQueue,
  snoozeFollowUpInQueue,
  wakeFollowUpInQueue,
} from "../../src/api/optimistic.ts";
import type { QueueFollowUp, QueueItem, QueueResponse } from "../../src/api/queue.ts";
import { scheduledUntil } from "../../src/derive/scheduled.ts";
import {
  initialNotifyState,
  isLater,
  laterBackAt,
  laterFollowUp,
  laterKind,
  laterRows,
  planNotifications,
  queueSummary,
  turnRows,
  visibleQueue,
} from "../../src/notify/plan.ts";

const TODAY = "2026-10-23";
/** 同じカードの再送の間隔（5 分）より長い間隔 */
const RESEND_GAP = 10 * 60_000;
const fu = (id: string, p: Partial<QueueFollowUp> = {}): QueueFollowUp => ({
  id,
  kind: "reply",
  status: "open",
  title: { t: "text", text: "x" },
  triggerAt: 0,
  snoozeUntil: null,
  engagedAt: null,
  expiresAt: null,
  taskId: "task",
  taskDate: TODAY,
  task: null,
  ...p,
});
const item = (id: string, followUps: QueueFollowUp[], p: Partial<QueueItem> = {}): QueueItem => ({
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
  followUps,
  ...p,
});

const open = item("open", [fu("f-open")]);
const snoozed = item("snoozed", [fu("f-s", { status: "snoozed", snoozeUntil: 3_000 })]);
const tomorrow = item("tomorrow", [
  fu("f-t", { status: "snoozed", snoozeUntil: 9_000, taskDate: "2026-10-24" }),
]);
const limit = item("limit", [], {
  status: "done",
  reason: "rate_limit",
  limitWait: { since: 100, until: 5_000, untilKnown: true },
});

describe("後での行", () => {
  test("3 種の行: スヌーズ・明日へ・上限待ち。戻る早い順。普通の行・帯・件数には入らない", () => {
    const items = [open, snoozed, tomorrow];
    const rows = laterRows(items, [limit]);
    expect(rows.map((x) => x.workItemId)).toEqual(["snoozed", "limit", "tomorrow"]);
    expect(rows.map((x) => laterKind(x, TODAY))).toEqual(["snoozed", "limit", "tomorrow"]);
    expect(rows.map(laterBackAt)).toEqual([3_000, 5_000, 9_000]);
    expect(rows.every(isLater)).toBe(true);
    expect(isLater(open)).toBe(false);
    // 帯（turnRows）・通知（visibleQueue）・件数（queueSummary）は open なものだけ
    expect(turnRows(items, []).map((x) => x.workItemId)).toEqual(["open"]);
    expect(visibleQueue(items).map((x) => x.workItemId)).toEqual(["open"]);
    expect(queueSummary(visibleQueue(items)).count).toBe(1);
  });

  test("同じカードに open なものがあれば後でに出さない（普通の行だけ）", () => {
    const both = item("both", [fu("a"), fu("b", { status: "snoozed", snoozeUntil: 1_000 })]);
    const limitToo = { ...limit, workItemId: "both" };
    expect(laterRows([both], [limitToo])).toEqual([]);
  });

  test("上限待ちの行は limitWait の無いものを除く", () => {
    const { limitWait: _, ...bare } = limit;
    expect(laterRows([], [bare as QueueItem])).toEqual([]);
  });
});

const scheduled = item(
  "scheduled",
  [fu("f-p", { status: "scheduled", scheduledAt: 4_000, taskDate: "2026-10-24" })],
  { status: "needs_input" },
);

describe("後での行: 時間に置いた自分の番", () => {
  test("時間に置いた行が入り、ほかの種類と混ぜて戻る早い順。明日へ（日付が先）より scheduled が勝つ", () => {
    const rows = laterRows([open, snoozed, tomorrow, scheduled], [limit]);
    expect(rows.map((x) => x.workItemId)).toEqual(["snoozed", "scheduled", "limit", "tomorrow"]);
    expect(rows.map((x) => laterKind(x, TODAY))).toEqual([
      "snoozed",
      "scheduled",
      "limit",
      "tomorrow",
    ]);
    expect(laterBackAt(scheduled)).toBe(4_000);
    expect(laterFollowUp(scheduled)?.id).toBe("f-p");
    expect(isLater(scheduled)).toBe(true);
  });

  test("帯・件数・通知に入れない（needs_input でも即時の通知を出さない）", () => {
    const items = [open, scheduled];
    expect(turnRows(items, []).map((x) => x.workItemId)).toEqual(["open"]);
    expect(queueSummary(visibleQueue(items))).toMatchObject({ count: 1, needsInput: 0 });
    const s0 = planNotifications(initialNotifyState(), visibleQueue([open]), 0).state;
    const r = planNotifications(s0, visibleQueue(items), RESEND_GAP);
    expect(r.notices).toEqual([]);
    // 開始が来て open になったら新しいフォローアップとして 1 回だけ即時に出る
    const back = {
      ...scheduled,
      followUps: scheduled.followUps.map((f) => ({ ...f, status: "open" as const })),
    };
    const r2 = planNotifications(r.state, visibleQueue([open, back]), RESEND_GAP * 2);
    expect(r2.notices.map((n) => n.kind)).toEqual(["immediate"]);
    const r3 = planNotifications(r2.state, visibleQueue([open, back]), RESEND_GAP * 3);
    expect(r3.notices).toEqual([]);
    expect(laterRows([open, back], [])).toEqual([]);
  });

  test("同じカードに open なものがあれば後でに出さない", () => {
    const both = item("both", [fu("a"), fu("b", { status: "scheduled", scheduledAt: 1_000 })]);
    expect(laterRows([both], [])).toEqual([]);
  });
});

describe("scheduledUntil（時間ブロックを作ってから開始まで）", () => {
  test("いまを含む区間の終わり。開始が来たら（開始と同じ時刻も）null", () => {
    expect(scheduledUntil([[100, 500]], 200)).toBe(500);
    expect(scheduledUntil([[100, 500]], 499)).toBe(500);
    expect(scheduledUntil([[100, 500]], 500)).toBeNull();
    expect(scheduledUntil([[100, 500]], 50)).toBeNull();
  });

  test("過去に置いたブロック（作った時刻より開始が前）は区間にならない。重なる区間はつなげる", () => {
    expect(scheduledUntil([[300, 100]], 200)).toBeNull();
    expect(
      scheduledUntil(
        [
          [100, 500],
          [200, 900],
        ],
        600,
      ),
    ).toBe(900);
    expect(
      scheduledUntil(
        [
          [700, 900],
          [100, 500],
        ],
        300,
      ),
    ).toBe(500);
    expect(scheduledUntil([], 300)).toBeNull();
  });
});

describe("楽観的更新", () => {
  const q = (items: QueueItem[], limitWaits: QueueItem[] = []): QueueResponse =>
    ({ items, limitWaits }) as unknown as QueueResponse;

  test("スヌーズで後でへ移り、今やるで帯に戻る（明日へ移したタスクは今日へ）", () => {
    const s = snoozeFollowUpInQueue(q([open]), "f-open", 7_000);
    expect(laterRows(s.items, []).map((x) => x.workItemId)).toEqual(["open"]);
    expect(visibleQueue(s.items)).toEqual([]);
    const w = wakeFollowUpInQueue(q([tomorrow]), "f-t", TODAY);
    expect(w.items[0]?.followUps[0]).toMatchObject({
      status: "open",
      snoozeUntil: null,
      taskDate: TODAY,
    });
    expect(laterRows(w.items, [])).toEqual([]);
  });

  test("時間に置いた行の今やる: open に戻し scheduledAt を外す（帯へ）", () => {
    const w = wakeFollowUpInQueue(q([scheduled]), "f-p", TODAY);
    const f = w.items[0]?.followUps[0];
    expect(f).toMatchObject({ status: "open", taskDate: TODAY });
    expect(f && "scheduledAt" in f).toBe(false);
    expect(visibleQueue(w.items).map((x) => x.workItemId)).toEqual(["scheduled"]);
    expect(laterRows(w.items, [])).toEqual([]);
  });

  test("上限待ちの対応不要で後でから消える", () => {
    const r = removeLimitWaitFromQueue(q([], [limit]), "limit");
    expect(laterRows(r.items, r.limitWaits)).toEqual([]);
  });
});
