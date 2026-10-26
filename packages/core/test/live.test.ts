/**
 * AI の画面の判定（ux-mvp 4.19）: 生きているの判定（Claude Code のプロセスの生死、Codex は最後の動きから 6 時間、
 * 片付けが残っている）と、節への振り分け（1 つの項目は 1 か所。上の節が勝つ。最後の動きが 1 日より前でプロセスが
 * 残っているだけの項目は末尾の stale）
 */
import { describe, expect, test } from "bun:test";
import type { LiveItem, LiveLaunch } from "../src/api/live.ts";
import type { QueueFollowUp, QueueItem } from "../src/api/queue.ts";
import {
  cleanupKind,
  isLiveCandidate,
  itemProcess,
  LIVE_FRESH_MS,
  type LiveSessionFact,
  liveSections,
  needsCleanup,
  processLive,
  runningKind,
  runStartOf,
  STALE_AFTER_MS,
  sessionAlive,
  stoppedKind,
  UNKNOWN_PROCESS_MS,
} from "../src/live.ts";

const MIN = 60_000;
const H = 60 * MIN;
const NOW = Date.UTC(2026, 9, 23, 8, 0);

const session = (p: Partial<LiveSessionFact> = {}): LiveSessionFact => ({
  tool: "claude_code",
  liveStatus: "idle",
  livePid: 4242,
  liveCheckedAt: NOW - 5_000,
  lastActivityAt: NOW - 10 * MIN,
  ...p,
});

const live = (id: string, p: Partial<LiveItem> = {}): LiveItem => ({
  id,
  title: id,
  titleSource: null,
  status: "done",
  reason: null,
  estimated: false,
  sources: [{ tool: "claude_code", profile: null }],
  repoRoot: "/w/app",
  branch: `feat/${id}`,
  prRef: null,
  lastActivityAt: NOW - 10 * MIN,
  runStartedAt: null,
  process: "gone",
  liveSessions: 0,
  subagentsRunning: 0,
  launch: null,
  ...p,
});

const launch = (p: Partial<LiveLaunch> = {}): LiveLaunch => ({
  launchId: "l1",
  taskId: "t1",
  taskDone: false,
  aiRunning: false,
  worktree: { path: "/w/app-wt/x", branch: "tl/x", state: "clean" },
  ...p,
});

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
  taskDate: "2026-10-23",
  task: null,
  ...p,
});
const qi = (id: string, followUps: QueueFollowUp[], p: Partial<QueueItem> = {}): QueueItem => ({
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

describe("Claude Code のプロセスの生死", () => {
  test("busy / idle で確かめが 2 分以内なら動いている", () => {
    expect(sessionAlive(session(), NOW)).toBe(true);
    expect(sessionAlive(session({ liveStatus: "busy" }), NOW)).toBe(true);
    expect(sessionAlive(session({ liveCheckedAt: NOW - LIVE_FRESH_MS }), NOW)).toBe(true);
  });

  test("gone・未確認・確かめが古い・pid が無いものは動いていない", () => {
    expect(sessionAlive(session({ liveStatus: "gone" }), NOW)).toBe(false);
    expect(sessionAlive(session({ liveStatus: null }), NOW)).toBe(false);
    expect(sessionAlive(session({ liveCheckedAt: NOW - LIVE_FRESH_MS - 1 }), NOW)).toBe(false);
    expect(sessionAlive(session({ liveCheckedAt: null }), NOW)).toBe(false);
    expect(sessionAlive(session({ livePid: null }), NOW)).toBe(false);
    expect(sessionAlive(session({ livePid: 1 }), NOW)).toBe(false);
  });

  test("項目のプロセス: 1 つでも動いていれば alive（数を返す）", () => {
    expect(itemProcess([session(), session({ liveStatus: "busy" })], NOW)).toEqual({
      process: "alive",
      liveSessions: 2,
    });
    expect(itemProcess([session({ liveStatus: "gone" }), session()], NOW)).toEqual({
      process: "alive",
      liveSessions: 1,
    });
  });

  test("動いていなければ、最後に動いたセッションで gone（Claude Code）か unknown（Codex・Claude Desktop）", () => {
    expect(itemProcess([session({ liveStatus: "gone" })], NOW).process).toBe("gone");
    expect(
      itemProcess(
        [
          session({ liveStatus: "gone", lastActivityAt: NOW - 2 * H }),
          session({ tool: "codex", liveStatus: null, lastActivityAt: NOW - H }),
        ],
        NOW,
      ).process,
    ).toBe("unknown");
    expect(itemProcess([session({ tool: "claude_desktop", liveStatus: null })], NOW).process).toBe(
      "unknown",
    );
    // セッションの無いカード（PR だけ）
    expect(itemProcess([], NOW)).toEqual({ process: "gone", liveSessions: 0 });
  });
});

describe("生きているの判定", () => {
  test("Codex（プロセスが分からない）は最後の動きから 6 時間まで", () => {
    const at = (ago: number) => live("c", { process: "unknown", lastActivityAt: NOW - ago });
    expect(processLive(at(H), NOW)).toBe(true);
    expect(processLive(at(UNKNOWN_PROCESS_MS), NOW)).toBe(true);
    expect(processLive(at(UNKNOWN_PROCESS_MS + 1), NOW)).toBe(false);
  });

  test("Claude Code はプロセスで決める（最後の動きの古さは見ない）", () => {
    expect(processLive(live("a", { process: "alive", lastActivityAt: NOW - 30 * H }), NOW)).toBe(
      true,
    );
    expect(processLive(live("a", { process: "gone", lastActivityAt: NOW - MIN }), NOW)).toBe(false);
  });

  test("片付けが残っている: worktree が残っているか、AI のプロセスが動いている", () => {
    expect(needsCleanup(launch())).toBe(true);
    expect(needsCleanup(launch({ worktree: null, aiRunning: true }))).toBe(true);
    expect(needsCleanup(launch({ worktree: null, aiRunning: false }))).toBe(false);
    expect(needsCleanup(null)).toBe(false);
  });

  test("候補: running / プロセス / 片付け のどれか。終わってプロセスも片付けも無いものは出さない", () => {
    expect(isLiveCandidate(live("r", { status: "running" }), NOW)).toBe(true);
    expect(isLiveCandidate(live("p", { process: "alive" }), NOW)).toBe(true);
    expect(isLiveCandidate(live("w", { launch: launch() }), NOW)).toBe(true);
    expect(isLiveCandidate(live("x"), NOW)).toBe(false);
    expect(
      isLiveCandidate(live("c", { process: "unknown", lastActivityAt: NOW - 7 * H }), NOW),
    ).toBe(false);
  });
});

describe("今のひと続きの作業の始まり", () => {
  test("30 分未満の間でつながるターンを遡る", () => {
    const turns = [
      { start: NOW - 5 * H, end: NOW - 4 * H },
      { start: NOW - 3 * H, end: NOW - 2 * H },
      { start: NOW - 2 * H + 10 * MIN, end: NOW - H },
      { start: NOW - H + 29 * MIN, end: NOW },
    ];
    expect(runStartOf(turns)).toBe(NOW - 3 * H);
    expect(runStartOf([])).toBeNull();
    expect(runStartOf([{ start: NOW - MIN, end: NOW }])).toBe(NOW - MIN);
  });
});

describe("節への振り分け", () => {
  test("節に分け、1 つの項目は 1 か所だけ（上の節が勝つ）", () => {
    const queue = {
      items: [
        qi("turn", [fu("f1")]),
        qi("snoozed", [fu("f2", { status: "snoozed", snoozeUntil: NOW + H })]),
      ],
      grace: [],
      limitWaits: [
        qi("limit", [], {
          status: "done",
          limitWait: { since: 0, until: NOW + H, untilKnown: true },
        }),
      ],
    };
    const items = [
      // 自分の番にもある（プロセスも生きている）→ 自分の番だけ
      live("turn", { process: "alive" }),
      // 後でにもある（worktree も残る）→ 後でだけ
      live("limit", { launch: launch() }),
      live("run", { status: "running", runStartedAt: NOW - 20 * MIN, launch: launch() }),
      live("stop", { process: "alive", launch: launch() }),
      live("codex", { process: "unknown", lastActivityAt: NOW - 2 * H }),
      live("clean", { launch: launch() }),
      // 何にも当たらない（画面の時計が進んで 6 時間を過ぎた Codex）
      live("old", { process: "unknown", lastActivityAt: NOW - 7 * H }),
    ];
    const s = liveSections(queue, items, NOW);
    expect(s.turn.map((x) => x.workItemId)).toEqual(["turn"]);
    expect(s.later.map((x) => x.workItemId)).toEqual(["snoozed", "limit"]);
    expect(s.running.map((x) => x.id)).toEqual(["run"]);
    expect(s.stopped.map((x) => x.id)).toEqual(["stop", "codex"]);
    expect(s.cleanup.map((x) => x.id)).toEqual(["clean"]);
    const all = [
      ...s.turn.map((x) => x.workItemId),
      ...s.later.map((x) => x.workItemId),
      ...[...s.running, ...s.stopped, ...s.cleanup].map((x) => x.id),
    ];
    expect(new Set(all).size).toBe(all.length);
  });

  test("自分の番の数は自分の番の画面と同じ（items の open なものと猶予中の問い）", () => {
    const queue = {
      items: [qi("a", [fu("f1")]), qi("b", [fu("f2")])],
      grace: [qi("g", [], { grace: { until: NOW + MIN } })],
    };
    expect(liveSections(queue, [], NOW).turn.map((x) => x.workItemId)).toEqual(["a", "b", "g"]);
  });

  test("節の中の順: 動いている = 始まりの古い順、止まっている = 新しい順、片付け = 古い順", () => {
    const s = liveSections(
      undefined,
      [
        live("r2", { status: "running", runStartedAt: NOW - 10 * MIN }),
        live("r1", { status: "running", runStartedAt: NOW - 40 * MIN }),
        live("s1", { process: "alive", lastActivityAt: NOW - 3 * H }),
        live("s2", { process: "alive", lastActivityAt: NOW - H }),
        live("c2", { launch: launch(), lastActivityAt: NOW - H }),
        live("c1", { launch: launch(), lastActivityAt: NOW - 30 * H }),
      ],
      NOW,
    );
    expect(s.running.map((x) => x.id)).toEqual(["r1", "r2"]);
    expect(s.stopped.map((x) => x.id)).toEqual(["s2", "s1"]);
    expect(s.cleanup.map((x) => x.id)).toEqual(["c1", "c2"]);
  });
});

describe("プロセスが残っているだけの古い項目（stale）", () => {
  test("最後の動きが 1 日より前で、running でも自分の番・後で・片付けでもない、プロセスが生きているだけの項目は stale", () => {
    const queue = {
      items: [qi("turn-old", [fu("f1")])],
      grace: [],
      limitWaits: [],
    };
    const items = [
      live("fresh", { process: "alive", lastActivityAt: NOW - 23 * H }),
      live("old1", { process: "alive", lastActivityAt: NOW - 25 * H }),
      live("old2", { process: "alive", lastActivityAt: NOW - 30 * 24 * H, status: "error" }),
      // 自分の番にあれば古くても自分の番
      live("turn-old", { process: "alive", lastActivityAt: NOW - 40 * H }),
      // running は古くても動いている
      live("run-old", { status: "running", process: "alive", lastActivityAt: NOW - 40 * H }),
      // 片付けが残っていれば止まっているのまま（片付けの手がかりを隠さない）
      live("wt-old", { process: "alive", lastActivityAt: NOW - 40 * H, launch: launch() }),
      // プロセスが無く片付けだけなら今までどおり片付け
      live("clean-old", { lastActivityAt: NOW - 40 * H, launch: launch() }),
    ];
    const s = liveSections(queue, items, NOW);
    expect(s.stopped.map((x) => x.id)).toEqual(["fresh", "wt-old"]);
    expect(s.stale.map((x) => x.id)).toEqual(["old1", "old2"]);
    expect(s.turn.map((x) => x.workItemId)).toEqual(["turn-old"]);
    expect(s.running.map((x) => x.id)).toEqual(["run-old"]);
    expect(s.cleanup.map((x) => x.id)).toEqual(["clean-old"]);
  });

  test("境目はちょうど 24 時間（24 時間ちょうどは止まっている、それより前は stale）", () => {
    const s = liveSections(
      undefined,
      [
        live("edge", { process: "alive", lastActivityAt: NOW - STALE_AFTER_MS }),
        live("past", { process: "alive", lastActivityAt: NOW - STALE_AFTER_MS - 1 }),
      ],
      NOW,
    );
    expect(s.stopped.map((x) => x.id)).toEqual(["edge"]);
    expect(s.stale.map((x) => x.id)).toEqual(["past"]);
  });
});

describe("行の札", () => {
  test("動いている: サブエージェントだけ", () => {
    expect(runningKind(live("a", { reason: "subagent:running" }))).toBe("subOnly");
    expect(runningKind(live("a", { reason: "turn_open" }))).toBe("running");
  });

  test("止まっている: 推定・エラー・完了でプロセスが残っている・入力待ち", () => {
    expect(stoppedKind(live("a", { process: "unknown" }))).toBe("estimated");
    expect(stoppedKind(live("a", { process: "alive", status: "error" }))).toBe("error");
    expect(stoppedKind(live("a", { process: "alive", status: "done" }))).toBe("done");
    expect(stoppedKind(live("a", { process: "alive", status: "your_turn" }))).toBe("input");
  });

  test("片付け: 未マージ・未コミット・worktree・タブ", () => {
    const wt = (state: "clean" | "unmerged" | "dirty") =>
      launch({ worktree: { path: "/w/x", branch: "tl/x", state } });
    expect(cleanupKind(live("a", { launch: wt("unmerged") }))).toBe("unmerged");
    expect(cleanupKind(live("a", { launch: wt("dirty") }))).toBe("dirty");
    expect(cleanupKind(live("a", { launch: wt("clean") }))).toBe("worktree");
    expect(cleanupKind(live("a", { launch: launch({ worktree: null, aiRunning: true }) }))).toBe(
      "tab",
    );
  });
});
