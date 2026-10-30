/**
 * AI の画面（ux-mvp 4.19。m2-api 33章）の判定。純粋関数にしてテストする。
 *
 * - 「生きている」AI 項目: 自分の番・後でにある（queue）/ running / Claude Code のプロセスが動いている / プロセスの有無が
 *   分からない（Codex・Claude Desktop）で最後の動きから 6 時間以内（推定）/ 頼んだ起動の片付けが残っている
 * - 節は 自分の番 → 後で → 動いている → 止まっている → 片付けが残っている → プロセスが残っている（畳んだ行）。1 つの
 *   項目はこの画面の 1 か所にだけ出し、上の節が勝つ。上の 2 節は自分の番の画面と同じ行（turnRows・laterRows）
 *
 * デーモン（GET /api/ai/live の候補の絞り込み）と web（節への振り分け）が同じ関数を使う。
 */
import type { LiveItem, LiveLaunch, LiveProcess } from "./api/live.ts";
import type { QueueItem } from "./api/queue.ts";
import { AI_SPAN_GAP_MS } from "./layout/ai-lane.ts";
import { laterRows, turnRows } from "./notify/plan.ts";

/** プロセスが動いているとみなす確かめの新しさ（「開く」と同じ。探索は 5 秒ごと。PID の再利用に備える） */
export const LIVE_FRESH_MS = 2 * 60_000;
/** プロセスの有無が分からない取り込み元（Codex・Claude Desktop）の項目を出す、最後の動きからの長さ */
export const UNKNOWN_PROCESS_MS = 6 * 3_600_000;

/**
 * 「止まっている」から外して末尾の畳んだ行（開いたまま）に回す、最後の動きからの長さ。プロセスが残っているだけで
 * 何週間も動いていない項目で「止まっている」が埋まらないように
 */
export const STALE_AFTER_MS = 24 * 3_600_000;

/** プロセスの有無を確かめられる取り込み元（sessions/<pid>.json を読む） */
const PROBED_TOOLS = new Set(["claude_code"]);

/** セッション 1 つの、プロセスの判定に要る値 */
export interface LiveSessionFact {
  tool: string;
  liveStatus: "busy" | "idle" | "gone" | null;
  livePid: number | null;
  liveCheckedAt: number | null;
  lastActivityAt: number;
}

/** セッションのプロセスが動いている（busy / idle で、確かめが LIVE_FRESH_MS 以内） */
export function sessionAlive(s: LiveSessionFact, now: number): boolean {
  return (
    (s.liveStatus === "busy" || s.liveStatus === "idle") &&
    s.livePid !== null &&
    Number.isInteger(s.livePid) &&
    s.livePid > 1 &&
    s.liveCheckedAt !== null &&
    now - s.liveCheckedAt <= LIVE_FRESH_MS
  );
}

/**
 * AI 項目のプロセス（そのセッションたちから）: 1 つでも動いていれば alive。無ければ、最後に動いたセッションの取り込み元で
 * 確かめられるなら gone、確かめられない（Codex・Claude Desktop）なら unknown。セッションが無い（PR だけのカード）は gone
 */
export function itemProcess(
  sessions: readonly LiveSessionFact[],
  now: number,
): { process: LiveProcess; liveSessions: number } {
  const alive = sessions.filter((s) => sessionAlive(s, now)).length;
  if (alive > 0) return { process: "alive", liveSessions: alive };
  const last = [...sessions].sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0];
  if (!last) return { process: "gone", liveSessions: 0 };
  // 確かめられる取り込み元か、確かめた値がある（Codex は hooks の親の pid。Issue #10）なら gone。無ければ分からない
  return {
    process: PROBED_TOOLS.has(last.tool) || last.liveStatus !== null ? "gone" : "unknown",
    liveSessions: 0,
  };
}

/** プロセスが生きている（Claude Code）か、分からないが最後の動きから 6 時間以内（推定） */
export function processLive(x: Pick<LiveItem, "process" | "lastActivityAt">, now: number): boolean {
  if (x.process === "alive") return true;
  return x.process === "unknown" && now - x.lastActivityAt <= UNKNOWN_PROCESS_MS;
}

/** 片付けが残っている（worktree が残っているか、turnlane ai run が終わっていない） */
export function needsCleanup(l: LiveLaunch | null | undefined): l is LiveLaunch {
  return !!l && (l.worktree !== null || l.aiRunning);
}

/** 自分の番・後でを除いた「生きている」の候補（running / プロセス / 片付け） */
export function isLiveCandidate(
  x: Pick<LiveItem, "status" | "process" | "lastActivityAt" | "launch">,
  now: number,
): boolean {
  return x.status === "running" || processLive(x, now) || needsCleanup(x.launch);
}

/**
 * 今のひと続きの作業の始まり: 最後のターンから遡り、前のターンの終わりから次のターンの始まりまでが gapMs（30 分）未満の
 * あいだつなぐ（ボードの AI レーンのブロックと同じ規則）。ターンが無ければ null
 */
export function runStartOf(
  turns: readonly { start: number; end: number }[],
  gapMs = AI_SPAN_GAP_MS,
): number | null {
  const xs = [...turns].sort((a, b) => a.start - b.start);
  let i = xs.length - 1;
  const last = xs[i];
  if (!last) return null;
  let start = last.start;
  while (i > 0) {
    const prev = xs[i - 1] as { start: number; end: number };
    if (start - prev.end >= gapMs) break;
    start = Math.min(start, prev.start);
    i--;
  }
  return start;
}

export interface LiveSections {
  /** 自分の番（自分の番の画面の一覧と同じ。猶予中の問いは末尾） */
  turn: QueueItem[];
  /** 後で（自分の番の画面の「後で」と同じ。戻る早い順） */
  later: QueueItem[];
  /** 動いている（今のひと続きの作業が始まった古い順） */
  running: LiveItem[];
  /** 止まっている（プロセスが生きている・推定で 6 時間以内。止まった新しい順） */
  stopped: LiveItem[];
  /** 片付けが残っている（古い順） */
  cleanup: LiveItem[];
  /**
   * プロセスが残っているだけ（最後の動きが STALE_AFTER_MS より前・running でない・自分の番・後で・片付けのどれでもない）。
   * 「止まっている」から外し、画面の末尾の畳んだ 1 行に入れる。止まった新しい順
   */
  stale: LiveItem[];
}

/**
 * 節への振り分け（1 つの項目は 1 か所。上の節が勝つ）。queue は GET /api/queue、live は GET /api/ai/live の items。
 * 動いている > 止まっている > 片付け > プロセスが残っている（動いている・止まっている項目に worktree があっても片付けには
 * 出さない。最後の動きが 1 日より前でプロセスが残っているだけの項目は「止まっている」ではなく stale。片付けが残っていれば
 * 止まっているのまま）
 */
export function liveSections(
  queue:
    | {
        items?: readonly QueueItem[] | undefined;
        grace?: readonly QueueItem[] | undefined;
        limitWaits?: readonly QueueItem[] | undefined;
      }
    | undefined,
  live: readonly LiveItem[] | undefined,
  now: number,
): LiveSections {
  const turn = turnRows(queue?.items, queue?.grace);
  const later = laterRows(queue?.items, queue?.limitWaits);
  const taken = new Set([...turn, ...later].map((x) => x.workItemId));
  const running: LiveItem[] = [];
  const stopped: LiveItem[] = [];
  const cleanup: LiveItem[] = [];
  const stale: LiveItem[] = [];
  for (const x of live ?? []) {
    if (taken.has(x.id)) continue;
    taken.add(x.id);
    if (x.status === "running") running.push(x);
    else if (processLive(x, now))
      (isStale(x, now) && !needsCleanup(x.launch) && !isLimitStop(x) ? stale : stopped).push(x);
    else if (needsCleanup(x.launch)) cleanup.push(x);
  }
  const startOf = (x: LiveItem) => x.runStartedAt ?? x.lastActivityAt;
  running.sort((a, b) => startOf(a) - startOf(b) || a.id.localeCompare(b.id));
  stopped.sort((a, b) => b.lastActivityAt - a.lastActivityAt || a.id.localeCompare(b.id));
  cleanup.sort((a, b) => a.lastActivityAt - b.lastActivityAt || a.id.localeCompare(b.id));
  stale.sort((a, b) => b.lastActivityAt - a.lastActivityAt || a.id.localeCompare(b.id));
  return { turn, later, running, stopped, cleanup, stale };
}

/**
 * 利用上限で止まった（status done・reason rate_limit）。「後で」に入らない事情（対応不要にした等）があっても完了とは
 * 出さず、プロセスが残っているだけの古い項目（stale）にも落とさない
 */
export function isLimitStop(x: Pick<LiveItem, "status" | "reason">): boolean {
  return x.status === "done" && x.reason === "rate_limit";
}

/** 最後の動きが STALE_AFTER_MS より前（プロセスが残っているだけの項目を「止まっている」から外す） */
export function isStale(x: Pick<LiveItem, "lastActivityAt">, now: number): boolean {
  return now - x.lastActivityAt > STALE_AFTER_MS;
}

/** 動いている行の札: subOnly = 親のターンは終わり、サブエージェントだけが動いている */
export function runningKind(x: Pick<LiveItem, "reason">): "running" | "subOnly" {
  return x.reason === "subagent:running" ? "subOnly" : "running";
}

/**
 * 止まっている行の札: limit = 利用上限で止まっている（done · rate_limit。完了とは出さない）/
 * estimated = プロセスの有無が分からない（推定）/ error = エラーのまま（自分の番は対応不要にした）/
 * done = 完了でプロセスが残っている / input = 入力待ち（プロセスあり、自分の番なし）
 */
export function stoppedKind(
  x: Pick<LiveItem, "process" | "status"> & Partial<Pick<LiveItem, "reason">>,
): "limit" | "estimated" | "error" | "done" | "input" {
  if (x.status === "done" && x.reason === "rate_limit") return "limit";
  if (x.process !== "alive") return "estimated";
  if (x.status === "error") return "error";
  if (x.status === "done") return "done";
  return "input";
}

/**
 * 片付けの行の札: unmerged = worktree が取り込まれていない / dirty = worktree に未コミットの変更 / worktree = worktree が
 * 残っている（そのまま消せる）/ tab = AI のプロセスが残っている（turnlane ai run が終わっていない。worktree は無い）
 */
export function cleanupKind(
  x: Pick<LiveItem, "launch">,
): "unmerged" | "dirty" | "worktree" | "tab" {
  const wt = x.launch?.worktree ?? null;
  if (!wt) return "tab";
  if (wt.state === "unmerged") return "unmerged";
  if (wt.state === "dirty") return "dirty";
  return "worktree";
}
