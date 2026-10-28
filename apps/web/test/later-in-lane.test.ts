/**
 * 後でにした自分の番（スヌーズ・明日へ・時間に置いた開始の前）の見え方: AI の詳細パネルの補足は「後で」の行と同じ戻る時刻の文
 * （猶予の文より優先。見出しと待ちの長さはそのまま）、AI のレーンの札は放置の長さの代わりに `明日へ` / `後で`
 */
import { describe, expect, test } from "bun:test";
import type {
  AiLaneItem,
  DayColumn,
  QueueFollowUp,
  QueueItem,
  WorkItemDetail,
} from "@turnlane/core/web";
import { blocksOf, metaOf } from "../src/board/AiLane.tsx";
import { laneLatersOf } from "../src/board/lane-wait.ts";
import { translate } from "../src/i18n/index.tsx";
import { deferredTurn, laterTextOf } from "../src/lib/later-text.ts";
import { aiHeadOf } from "../src/panel/ai-state.ts";

const M = 60_000;
const TZ = "Asia/Tokyo";
const TODAY = "2026-10-28";
// 2026-10-28 12:00 JST
const NOW = Date.UTC(2026, 9, 28, 3, 0);
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
const item = (followUps: QueueFollowUp[]): QueueItem => ({
  workItemId: "wi",
  title: "wi",
  status: "your_turn",
  reason: null,
  estimated: false,
  repoRoot: "/fixture/repo-a",
  branch: "feat/x",
  prRef: null,
  sources: [],
  waitingSince: jst(28, 7, 14),
  waitStartedAway: false,
  followUps,
});

const snoozedToday = item([fu({ snoozeUntil: jst(28, 15) })]);
const snoozedNextDay = item([fu({ snoozeUntil: jst(29, 14) })]);
const tomorrow = item([fu({ snoozeUntil: jst(29, 10), taskDate: "2026-10-29" })]);
const placed = item([fu({ status: "scheduled", scheduledAt: jst(28, 21) })]);
const open = item([fu({ status: "open" })]);

const tr = (locale: "ja" | "en") => (x: { key: string; params?: Record<string, string> } | null) =>
  x ? translate(locale, x.key as never, x.params) : null;

describe("戻る時刻の文（「後で」の行と同じ）", () => {
  test("スヌーズ（今日・翌日）・明日へ・時間に置いた開始の前", () => {
    const ja = (x: QueueItem) => tr("ja")(laterTextOf(x, TODAY, NOW, TZ));
    expect(ja(snoozedToday)).toBe("スヌーズ · 15:00 に戻る");
    expect(ja(snoozedNextDay)).toBe("スヌーズ · 10/29 14:00 に戻る");
    expect(ja(tomorrow)).toBe("明日へ · 10/29 10:00");
    expect(ja(placed)).toBe("21:00 に");
    const en = (x: QueueItem) => tr("en")(laterTextOf(x, TODAY, NOW, TZ));
    expect(en(snoozedToday)).toBe("Snoozed · back at 15:00");
    expect(en(tomorrow)).toBe("Tomorrow · 10/29 10:00");
  });

  test("open のフォローアップがあれば後でではない", () => {
    expect(deferredTurn(open)).toBe(false);
    expect(deferredTurn(snoozedToday)).toBe(true);
    expect(deferredTurn(item([fu({ status: "open" }), fu({ id: "f2" })]))).toBe(false);
  });
});

/** 猶予中の返答待ちの詳細（見出しは「自分の番 · 返答待ち」、補足は今までなら猶予の文） */
function detail(): WorkItemDetail {
  const start = jst(28, 11, 54);
  return {
    workItem: { id: "wi", status: "your_turn", reason: "question", lastActivityAt: start },
    turns: [
      {
        turnId: "t1",
        start: start - 20 * M,
        end: start,
        open: false,
        toolCalls: 0,
        editedFiles: 0,
        inputTokens: null,
        outputTokens: null,
        endedWith: null,
        tool: "claude_code",
      },
    ],
    waits: [
      {
        waitKey: "k",
        kind: "grace",
        excludedBy: null,
        start,
        end: NOW,
        open: true,
        endReason: null,
        followUpId: null,
      },
    ],
    artifacts: [],
    followUps: [],
    permissionKind: null,
    errorKind: null,
    graceMs: 30 * M,
  } as unknown as WorkItemDetail;
}
const fmt = { clock: (ms: number) => String(ms), dur: (ms: number) => `${Math.round(ms / M)}m` };

describe("AI の詳細パネルの補足", () => {
  test("open のまま: 今までどおり猶予の文", () => {
    const h = aiHeadOf(detail(), NOW, fmt, undefined, null);
    expect(h.hint).toEqual({ key: "ai.hint.grace", params: { time: "24m" } });
  });

  test("スヌーズ・明日へ・時間に置いた: 戻る時刻の文が猶予の文より先。見出しと待ちの長さはそのまま", () => {
    const base = aiHeadOf(detail(), NOW, fmt);
    for (const x of [snoozedToday, snoozedNextDay, tomorrow, placed]) {
      const later = laterTextOf(x, TODAY, NOW, TZ);
      const h = aiHeadOf(detail(), NOW, fmt, undefined, later);
      expect(h.hint).toEqual(later);
      expect([h.head, h.sub, h.durMs]).toEqual([base.head, base.sub, base.durMs]);
    }
    expect(
      tr("ja")(aiHeadOf(detail(), NOW, fmt, undefined, laterTextOf(tomorrow, TODAY, NOW, TZ)).hint),
    ).toBe("明日へ · 10/29 10:00");
  });
});

const DAY0 = jst(28, 0);
function laneItem(): AiLaneItem {
  return {
    id: "wi",
    title: "Fixture work",
    titleSource: null,
    status: "your_turn",
    reason: "question",
    estimated: false,
    sources: [],
    repoRoot: "/fixture/repo-a",
    branch: "feat/x",
    prRef: null,
    aiMs: M,
    youMs: 0,
    idleMs: 11 * M,
    turns: 1,
    carriedFrom: null,
    runs: [{ turnId: "t1", start: jst(28, 7, 13), end: jst(28, 7, 14), open: false }],
    // 猶予の後の放置 11m
    waits: [
      {
        waitKey: "k",
        kind: "idle",
        idle: true,
        start: jst(28, 7, 29),
        end: jst(28, 7, 40),
        open: false,
      },
    ],
  } as unknown as AiLaneItem;
}
const laneDay = (it: AiLaneItem): DayColumn =>
  ({
    date: TODAY,
    phase: "today",
    logicalPhase: "today",
    axis: { start: DAY0, end: DAY0 + 24 * 60 * M },
    logical: { start: DAY0 + 4 * 60 * M, end: DAY0 + 28 * 60 * M },
    aiLane: [it],
  }) as unknown as DayColumn;

describe("AI のレーンの札", () => {
  const meta = (later: string | null, locale: "ja" | "en" = "ja") => {
    const d = laneDay(laneItem());
    const b = blocksOf(d, NOW).at(-1);
    if (!b) throw new Error("no block");
    const t = (k: string, p?: Record<string, string | number>) => translate(locale, k as never, p);
    return metaOf(b, NOW, d, t as never, TZ, later as never);
  };

  test("open のまま: 長さと放置（今まで）", () => {
    expect(meta(null)).toEqual({ right: "1m", sub: "放置 11m", kind: "time" });
  });

  test("後でにした: 放置の長さの代わりに 明日へ / 後で（英語も）", () => {
    expect(meta("menu.tomorrow")).toEqual({ right: "1m", sub: "明日へ", kind: "time" });
    expect(meta("board.later")).toEqual({ right: "1m", sub: "後で", kind: "time" });
    expect(meta("menu.tomorrow", "en").sub).toBe("Tomorrow");
    expect(meta("board.later", "en").sub).toBe("Later");
  });

  test("queue から札: 明日へ・スヌーズ・時間に置いた。open なものと上限待ちは入れない", () => {
    const m = laneLatersOf({
      today: TODAY,
      items: [
        { ...tomorrow, workItemId: "a" },
        { ...snoozedToday, workItemId: "b" },
        { ...placed, workItemId: "c" },
        { ...open, workItemId: "d" },
      ],
    });
    expect(Object.fromEntries(m)).toEqual({
      a: "menu.tomorrow",
      b: "board.later",
      c: "board.later",
    });
  });
});
