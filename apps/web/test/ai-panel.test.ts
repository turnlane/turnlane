/**
 * AI の詳細パネルの作り直し（D-115・D-116。docs/design/README.md の「AI の詳細パネル」R37〜）:
 * - 見出し: 状態と待ちの種類と長さ、すること、補足。PR を確認する前は「AI 完了 · PR の確認待ち」
 * - 許可の種類・エラーの種類を文に入れる（無ければ種類なしの文）
 * - 流れ: 項目全体を時刻順に、会議の区間は「会議中」、直近だけ出して古い区間は畳む、合計は今の待ちの分
 * - ホバーの吹き出し: 同じ言葉。ターン・ツール呼び出しの数を出さない
 * - パネルにターンの一覧・ツール呼び出しの数・取り込み元の札・壁時計を出さない
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkItemDetail } from "@turnlane/core/web";
import { aiHoverOf } from "../src/components/AiHoverCard.tsx";
import { aiHeadOf, prStateKey } from "../src/panel/ai-state.ts";
import { FLOW_VISIBLE, flowTotals, foldFlow, itemFlow } from "../src/panel/flow.ts";

const M = 60_000;
const at = (h: number, m = 0) => (h * 60 + m) * M;
const fmt = {
  clock: (ms: number) => {
    const m = Math.round(ms / M);
    return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
  },
  dur: (ms: number) => `${Math.round(ms / M)}m`,
};

type W = WorkItemDetail["waits"][number];
const wait = (key: string, kind: W["kind"], s: number, e: number, p: Partial<W> = {}): W => ({
  waitKey: key,
  kind,
  excludedBy: kind === "excluded" ? "event" : null,
  start: s,
  end: e,
  open: false,
  endReason: null,
  followUpId: null,
  ...p,
});
const turn = (s: number, e: number, open = false) => ({
  turnId: `t${s}`,
  start: s,
  end: e,
  open,
  toolCalls: 4,
  editedFiles: 1,
  inputTokens: null,
  outputTokens: null,
  endedWith: null,
  tool: "claude_code",
});

function detail(p: {
  status: WorkItemDetail["workItem"]["status"];
  reason?: string | null;
  turns: ReturnType<typeof turn>[];
  waits?: W[];
  artifacts?: WorkItemDetail["artifacts"];
  permissionKind?: WorkItemDetail["permissionKind"];
  errorKind?: WorkItemDetail["errorKind"];
  lastActivityAt?: number;
}): WorkItemDetail {
  return {
    workItem: {
      id: "w",
      title: "x",
      titleSource: null,
      status: p.status,
      reason: p.reason ?? null,
      estimated: false,
      sources: [],
      repoRoot: "/w/app",
      branch: "feat/x",
      prRef: null,
      aiMs: 0,
      youMs: 0,
      idleMs: 0,
      turns: p.turns.length,
      carriedFrom: null,
      groupKey: "g",
      manualDoneAt: null,
      hidden: false,
      firstActivityAt: 0,
      lastActivityAt: p.lastActivityAt ?? 0,
    },
    turns: p.turns,
    artifacts: p.artifacts ?? [],
    followUps: [],
    waits: p.waits ?? [],
    breakdown: {
      aiMs: 50 * M,
      youMs: 0,
      idleMs: 6 * M,
      graceMs: 0,
      excludedMs: { closed: 0, away: 0, event: 0, snoozed: 0, no_task: 0, scheduled: 0 },
      expiredMs: 0,
      wallMs: 0,
    },
    open: { resume: true, pr: null, folder: true },
    permissionKind: p.permissionKind ?? null,
    errorKind: p.errorKind ?? null,
    graceMs: 15 * M,
    today: "2026-10-02",
    displayToday: "2026-10-02",
    now: 0,
    rev: 0,
    tz: "UTC",
    dayBoundary: 0,
  } as WorkItemDetail;
}

describe("見出し（D-116）", () => {
  test("自分の番（返答待ち）: 長さは今の待ち、猶予の残り", () => {
    const d = detail({
      status: "your_turn",
      reason: "question",
      turns: [turn(at(13, 5), at(13, 34))],
      waits: [wait("k", "grace", at(13, 34), at(13, 40), { open: true })],
    });
    const h = aiHeadOf(d, at(13, 40), fmt);
    expect([h.head, h.sub, h.durMs]).toEqual(["status.your_turn", "queue.kind.reply", 6 * M]);
    expect(h.todo.key).toBe("ai.todo.reply");
    expect(h.hint).toEqual({ key: "ai.hint.grace", params: { time: "9m" } });
    expect(h.primary).toBe("ai.primary.reply");
  });
  test("Stop の hook で終わり中身がまだ分からない（hook:stop）: 「AI 完了 · 確認待ち」、長さは終わってから", () => {
    const d = detail({
      status: "your_turn",
      reason: "hook:stop",
      turns: [turn(at(13, 5), at(13, 34))],
    });
    const h = aiHeadOf(d, at(13, 36), fmt);
    expect([h.head, h.sub, h.durMs]).toEqual(["ai.head.aiDone", "ai.sub.check", 2 * M]);
    expect(h.todo.key).toBe("ai.todo.ended");
    expect(h.hint).toEqual({ key: "ai.hint.ended", params: { time: "13:34" } });
    expect(h.primary).toBe("ai.primary.check");
    expect(h.status).toBe("your_turn");
  });

  test("ブロック中（許可待ち）: 何の許可かを文に入れ、状態の面を琥珀に。種類が無ければ種類なしの文", () => {
    const base = {
      status: "needs_input" as const,
      reason: "hook:permission_request",
      turns: [turn(at(14, 20), at(14, 58), true)],
      waits: [wait("k", "grace", at(14, 46), at(14, 58), { open: true })],
    };
    const h = aiHeadOf(detail({ ...base, permissionKind: "command" }), at(14, 58), fmt);
    expect([h.head, h.sub, h.durMs, h.blocked]).toEqual([
      "status.needs_input",
      "board.needsPermission",
      12 * M,
      true,
    ]);
    expect(h.todo).toEqual({
      key: "ai.todo.permissionKind",
      keyParams: { kind: "ai.perm.command" },
    });
    expect(aiHeadOf(detail(base), at(14, 58), fmt).todo.key).toBe("ai.todo.permission");
  });
  test("エラー: エラーの種類を文に入れる", () => {
    const h = aiHeadOf(
      detail({
        status: "error",
        reason: "hook:stop_failure",
        errorKind: "rate_limit",
        turns: [turn(at(12, 38), at(13))],
        waits: [wait("k", "idle", at(13, 15), at(13, 30), { open: true })],
      }),
      at(14),
      fmt,
    );
    expect([h.head, h.sub]).toEqual(["status.error", "ai.sub.stopped"]);
    expect(h.todo).toEqual({ key: "ai.todo.errorKind", keyParams: { kind: "ai.err.rate_limit" } });
    expect(h.primary).toBe("ai.primary.resume");
  });
  test("上限待ち（done・rate_limit）: 「利用上限」、琥珀の面。明けた後の再開は「再開できる」", () => {
    const h = aiHeadOf(
      detail({
        status: "done",
        reason: "rate_limit",
        errorKind: "rate_limit",
        turns: [turn(at(12, 38), at(13))],
        waits: [wait("k", "excluded", at(13), at(14), { open: true, excludedBy: "no_task" })],
      }),
      at(14),
      fmt,
    );
    expect([h.status, h.head, h.durMs, h.blocked]).toEqual([
      "needs_input",
      "board.limit",
      60 * M,
      true,
    ]);
    expect(h.todo.key).toBe("ai.todo.limit");
    const back = aiHeadOf(
      detail({ status: "your_turn", reason: "resume_limit", turns: [turn(at(12, 38), at(13))] }),
      at(15),
      fmt,
    );
    expect([back.head, back.sub, back.todo.key, back.primary]).toEqual([
      "status.your_turn",
      "turn.why.resume_limit",
      "ai.todo.limitReset",
      "ai.primary.resume",
    ]);
  });
  test("エラーの状態（1 時間）の後の再開待ち（your_turn・resume_error）: エラーの種類の文で再開", () => {
    const h = aiHeadOf(
      detail({
        status: "your_turn",
        reason: "resume_error",
        errorKind: "server_error",
        turns: [turn(at(12, 38), at(13))],
      }),
      at(15),
      fmt,
    );
    expect([h.head, h.sub, h.primary]).toEqual([
      "status.your_turn",
      "ai.sub.stopped",
      "ai.primary.resume",
    ]);
    expect(h.todo).toEqual({
      key: "ai.todo.errorKind",
      keyParams: { kind: "ai.err.server_error" },
    });
  });
  test("PR を確認する前は「AI 完了 · PR の確認待ち」。長さは終わってから、主ボタンは PR を開く", () => {
    const h = aiHeadOf(
      detail({
        status: "your_turn",
        reason: "pr_open",
        turns: [turn(at(10, 2), at(10, 20)), turn(at(10, 40), at(10, 51))],
        artifacts: [
          {
            kind: "pr",
            ref: "o/r#142",
            url: null,
            title: "t",
            state: "open",
            reviewDecision: "review_required",
            stateChangedAt: null,
          },
        ],
      }),
      at(14, 58),
      fmt,
    );
    expect([h.head, h.sub, h.durMs]).toEqual([
      "ai.head.aiDone",
      "ai.sub.prReview",
      at(14, 58) - at(10, 51),
    ]);
    expect(h.hint).toEqual({ key: "ai.hint.ended", params: { time: "10:51" } });
    expect([h.primary, h.primaryPr]).toEqual(["ai.primary.pr", true]);
  });
  test("完了（マージ済み）: することは無い、マージの時刻", () => {
    const h = aiHeadOf(
      detail({
        status: "done",
        turns: [turn(at(11, 5), at(11, 38))],
        artifacts: [
          {
            kind: "pr",
            ref: "o/r#139",
            url: null,
            title: "t",
            state: "merged",
            reviewDecision: "approved",
            stateChangedAt: at(13, 20),
          },
        ],
      }),
      at(14),
      fmt,
    );
    expect([h.head, h.sub, h.durMs, h.todo.key]).toEqual([
      "status.done",
      "ai.sub.merged",
      null,
      "ai.todo.none",
    ]);
    expect(h.hint).toEqual({ key: "ai.hint.merged", params: { time: "13:20" } });
  });
  test("PR の状態は日本語の言葉（レビューの判定を含める）", () => {
    const pr = (
      state: string,
      reviewDecision: WorkItemDetail["artifacts"][number]["reviewDecision"],
    ) => prStateKey({ state, reviewDecision });
    expect(pr("open", null)).toBe("ai.pr.review");
    expect(pr("open", "approved")).toBe("ai.pr.approved");
    expect(pr("open", "changes_requested")).toBe("ai.pr.changes");
    expect(pr("draft", null)).toBe("ai.pr.draft");
    expect(pr("merged", "approved")).toBe("ai.pr.merged");
  });
});

describe("この項目の流れ（D-116）", () => {
  // 案の B: 前に3区間、稼働 → 猶予 → 放置 → 会議中 → 放置（今）
  const b = detail({
    status: "your_turn",
    reason: "question",
    turns: [turn(at(11), at(11, 40)), turn(at(13, 5), at(13, 35))],
    waits: [
      wait("k1", "grace", at(11, 40), at(11, 55)),
      wait("k1", "idle", at(11, 55), at(13, 5)),
      wait("k2", "grace", at(13, 35), at(13, 50), { open: true }),
      wait("k2", "excluded", at(13, 50), at(13, 50) + 5000, {
        open: true,
        excludedBy: "no_task",
      }),
      wait("k2", "idle", at(13, 50), at(14), { open: true }),
      wait("k2", "excluded", at(14), at(14, 45), { open: true, excludedBy: "event" }),
      wait("k2", "idle", at(14, 45), at(14, 50), { open: true }),
    ],
  });
  const now = at(14, 58);
  test("項目全体を時刻順に。会議の区間は「会議中」（集計外と出さない）。1分に満たない区間は出さない", () => {
    const f = itemFlow(b, now);
    expect(f.rows.map((r) => r.kind)).toEqual([
      "run",
      "grace",
      "idle",
      "run",
      "grace",
      "idle",
      "event",
      "idle",
    ]);
    // 開いている待ちは最後の区間だけ今まで伸ばし、今の区間の印
    expect(f.rows.at(-1)).toEqual({ kind: "idle", start: at(14, 45), end: now, now: true });
    expect(f.rows.filter((r) => r.now)).toHaveLength(1);
    expect(f.doneAt).toBeNull();
  });
  test("直近だけ出す（最後の5区間を稼働から）。古い区間は「それより前 N 区間 · AI」", () => {
    const { shown, earlier } = foldFlow(itemFlow(b, now).rows);
    expect(shown.map((r) => r.kind)).toEqual(["run", "grace", "idle", "event", "idle"]);
    expect(shown).toHaveLength(FLOW_VISIBLE);
    expect(earlier).toEqual({ count: 3, aiMs: 40 * M });
  });
  test("合計: 開いている待ちがあれば、待ちとうち放置はその待ちの分（最後の区間だけ今まで）", () => {
    expect(flowTotals(b, now)).toEqual({
      aiMs: 50 * M,
      waitMs: now - at(13, 35),
      idleMs: 10 * M + 13 * M,
    });
  });
  test("ブロック中の実行は待ちの始まりで切る。完了はマージの時刻に印", () => {
    const c = detail({
      status: "needs_input",
      reason: "hook:permission_request",
      turns: [turn(at(14, 20), at(14, 58), true)],
      waits: [wait("k", "grace", at(14, 46), at(14, 58), { open: true })],
    });
    expect(itemFlow(c, at(14, 58)).rows).toEqual([
      { kind: "run", start: at(14, 20), end: at(14, 46), now: false },
      { kind: "grace", start: at(14, 46), end: at(14, 58), now: true },
    ]);
    const f = detail({
      status: "done",
      turns: [turn(at(11, 5), at(11, 38))],
      waits: [wait("k", "idle", at(11, 38), at(13, 15))],
      artifacts: [
        {
          kind: "pr",
          ref: "o/r#1",
          url: null,
          title: null,
          state: "merged",
          reviewDecision: null,
          stateChangedAt: at(13, 20),
        },
      ],
    });
    expect(itemFlow(f, at(14)).doneAt).toBe(at(13, 20));
  });
});

describe("AI の線のホバー（D-116）", () => {
  test("詳細パネルの見出しと同じ言葉（状態 · 待ちの種類 長さ、うち放置 · AI、リポジトリ · ブランチ）", () => {
    const h = aiHoverOf(
      {
        title: "料金ページの A/B テスト",
        status: "your_turn",
        reason: "question",
        estimated: false,
        repoRoot: "/w/storefront",
        branch: "exp/pricing-ab",
        aiMs: 70 * M,
        runs: [{ turnId: "t", start: at(13, 5), end: at(13, 34), open: false }],
        waits: [
          { start: at(13, 34), end: at(13, 49), waitKey: "k", idle: false, open: true },
          { start: at(13, 49), end: at(14), waitKey: "k", idle: true, open: true },
          { start: at(14, 45), end: at(14, 50), waitKey: "k", idle: true, open: true },
        ],
      },
      at(14, 58),
    );
    expect(h).toMatchObject({
      head: "status.your_turn",
      sub: "queue.kind.reply",
      durMs: at(14, 58) - at(13, 34),
      idleMs: 11 * M + 13 * M,
      aiMs: 70 * M,
      where: "storefront · exp/pricing-ab",
    });
  });
  test("実行中は今の稼働の長さだけ（うち放置の行は無い）", () => {
    const h = aiHoverOf(
      {
        title: "x",
        status: "running",
        reason: null,
        estimated: false,
        repoRoot: null,
        branch: null,
        aiMs: 0,
        runs: [
          { turnId: "a", start: at(13, 12), end: at(13, 33), open: false },
          { turnId: "b", start: at(13, 54), end: at(14, 23), open: true },
        ],
        waits: [],
      },
      at(14, 23),
    );
    expect([h.head, h.durMs, h.idleMs]).toEqual(["status.running", 29 * M, null]);
  });
});

describe("出さないもの（D-115）", () => {
  const SRC = join(import.meta.dir, "../src");
  test("パネルと吹き出しにターンの一覧・ツール呼び出しの数・取り込み元の札・壁時計を出さない", () => {
    for (const f of ["panel/AiPanel.tsx", "components/AiHoverCard.tsx", "components/Flow.tsx"]) {
      const src = readFileSync(join(SRC, f), "utf8");
      expect(src).not.toContain('"ai.tools"');
      expect(src).not.toContain('"ai.turns"');
      expect(src).not.toContain("SourceBadges");
      expect(src).not.toContain("wallMs");
      expect(src).not.toContain("toolCalls");
    }
    // デイビューの線のホバーは title 属性（ターン・AI・自分・放置の羅列）をやめて吹き出しに
    const day = readFileSync(join(SRC, "day/DayView.tsx"), "utf8");
    expect(day).toContain(
      'aiHoverProps({ ...aiHoverOf(item, now, t("ai.scratch")), title: subject, hint })',
    );
  });
});
