/**
 * 自分の番の画面の「後で」（ux-mvp 4.6）: 4 種の行の右端の言葉（スヌーズ · 15:00 に戻る / 明日へ · 10/24 10:00 /
 * 9:00 に / 利用上限 · 23:41 まで・待ち 2h。暦の今日でなければ日付を添える）と、右クリックの操作（今やる・開く・詳細・
 * 対応不要。明日へ・スヌーズ・完了は出さない）
 */
import { describe, expect, test } from "bun:test";
import type { QueueFollowUp, QueueItem } from "@turnlane/core/web";
import { menuSpec } from "../src/actions/item-actions.tsx";
import { laterLabel } from "../src/components/LaterRow.tsx";
import { translate } from "../src/i18n/index.tsx";
import type { SelItem } from "../src/lib/store.ts";

const TZ = "Asia/Tokyo";
const TODAY = "2026-10-23";
const H = 3_600_000;
// 2026-10-23 12:00 JST
const NOW = Date.UTC(2026, 9, 23, 3, 0);
const jst = (d: number, h: number, m = 0) => Date.UTC(2026, 9, d, h - 9, m);

const fu = (p: Partial<QueueFollowUp> = {}): QueueFollowUp => ({
  id: "f1",
  kind: "reply",
  status: "snoozed",
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
const item = (o: Partial<QueueItem> = {}): QueueItem => ({
  workItemId: "w1",
  title: "w1",
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

const snoozed = item({ followUps: [fu({ snoozeUntil: jst(23, 15) })] });
const tomorrow = item({
  followUps: [fu({ snoozeUntil: jst(24, 10), taskDate: "2026-10-24" })],
});
const snoozedLater = item({ followUps: [fu({ snoozeUntil: jst(28, 14) })] });
const placed = item({
  followUps: [fu({ status: "scheduled", scheduledAt: jst(23, 21), taskDate: TODAY })],
});
const placedLater = item({
  followUps: [fu({ status: "scheduled", scheduledAt: jst(28, 9), taskDate: "2026-10-28" })],
});
const limitKnown = item({
  status: "done",
  reason: "rate_limit",
  limitWait: { since: jst(23, 18, 41), until: jst(23, 23, 41), untilKnown: true },
});
const limitGuess = item({
  status: "done",
  reason: "rate_limit",
  limitWait: { since: NOW - 2 * H, until: NOW + 3 * H, untilKnown: false },
});

describe("後での行の右端の言葉", () => {
  const label = (x: QueueItem, locale: "ja" | "en") =>
    laterLabel(x, TODAY, NOW, TZ, (k, p) => translate(locale, k, p));
  test("ja", () => {
    expect(label(snoozed, "ja")).toBe("スヌーズ · 15:00 に戻る");
    expect(label(tomorrow, "ja")).toBe("明日へ · 10/24 10:00");
    expect(label(limitKnown, "ja")).toBe("利用上限 · 23:41 まで");
    expect(label(limitGuess, "ja")).toBe("利用上限 · 見込み 15:00");
    expect(label(snoozedLater, "ja")).toBe("スヌーズ · 10/28 14:00 に戻る");
    expect(label(placed, "ja")).toBe("21:00 に");
    expect(label(placedLater, "ja")).toBe("10/28 9:00 に");
  });
  test("en", () => {
    expect(label(snoozed, "en")).toBe("Snoozed · back at 15:00");
    expect(label(tomorrow, "en")).toBe("Tomorrow · 10/24 10:00");
    expect(label(limitKnown, "en")).toBe("Usage limit · until 23:41");
    expect(label(limitGuess, "en")).toBe("Usage limit · est. 15:00");
    expect(label(snoozedLater, "en")).toBe("Snoozed · back at 10/28 14:00");
    expect(label(placed, "en")).toBe("at 21:00");
    expect(label(placedLater, "en")).toBe("at 10/28 9:00");
  });
});

describe("後での行の右クリック", () => {
  const ids = (xs: { id: string }[]) => xs.map((x) => x.id);
  test("スヌーズ中・明日へ・時間に置いた: 今やる・開く・詳細・対応不要", () => {
    for (const x of [snoozed, tomorrow, placed]) {
      const s: SelItem = { kind: "turn", item: x };
      expect(ids(menuSpec([s], { answer: true }))).toEqual(["wake", "open", "detail", "dismiss"]);
    }
  });
  test("上限待ち: 今やるは出さない", () => {
    const s: SelItem = { kind: "turn", item: limitKnown };
    expect(ids(menuSpec([s]))).toEqual(["open", "detail", "dismiss"]);
  });
  test("普通の行は今までどおり（今やるは出さない）", () => {
    const s: SelItem = { kind: "turn", item: item({ followUps: [fu({ status: "open" })] }) };
    const out = ids(menuSpec([s]));
    expect(out).toContain("snooze");
    expect(out).not.toContain("wake");
  });
});
