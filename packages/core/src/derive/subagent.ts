/**
 * サブエージェント（Claude Code の Agent ツール。`subagents/agent-<id>.jsonl`）と親のセッションの状態（ai-session-ingestion 4.2・4.3）。
 *
 * 親がサブエージェントに作業を渡して待っていると、親の番（ターン）は Stop で閉じる。サブエージェントが終わると
 * task-notification の user レコードで親が自動で再開する（initiator='system'。人の入力ではない）。この間、親はまだ働いている:
 * - 動いているサブエージェント（終わっていない・最後の活動が runningStale の中・親がその後に再開していない）があれば、
 *   親のセッションは running（理由 `subagent:running`）。自分の番の候補にしない
 * - サブエージェントの許可待ち（hook の agentId 付き。agentId の無い古い spool は、親のターンが閉じた後の許可待ち）は
 *   親の needs_input。サブエージェントのトランスクリプトに後の活動・終わり・親の再開・入力で閉じる
 * - 待ち（your_turn）の始まりは、サブエージェントと、その完了で親が再開したターン（人の入力でないもの）が終わった時刻
 * サブエージェントの hook は親の session_id で届く。親の Stop などはサブエージェントの許可待ちを閉じない。
 */
import { isClearingHook, isPermissionHook } from "./hook-kinds.ts";
import {
  type DeriveTiming,
  type HookFact,
  isHumanTurn,
  type SessionFact,
  type SubagentFact,
  type TurnFact,
  type WorkItemFacts,
} from "./types.ts";

/** サブエージェントが終わってから、親が task-notification で再開するまでの間（これより遅い再開は別の作業） */
export const SUBAGENT_RESUME_GAP_MS = 60_000;

const staleOf = (timing: DeriveTiming | undefined, tool: string) =>
  timing?.runningStaleMs[tool] ?? 5 * 60_000;

/** セッション s を親に持つサブエージェント */
export function subagentsOf(f: Pick<WorkItemFacts, "subagents">, s: SessionFact): SubagentFact[] {
  return (f.subagents ?? []).filter((x) => x.parentId === s.id);
}

/** 親とサブエージェントの最後の活動（親のトランスクリプトが止まっていてもサブエージェントが進めば活動がある） */
export function activityOf(f: Pick<WorkItemFacts, "subagents">, s: SessionFact): number {
  let at = s.lastActivityAt;
  for (const x of subagentsOf(f, s)) at = Math.max(at, x.lastActivityAt);
  return at;
}

/** セッションのターンのうち、時刻 at より後に始まった最初のもの */
function turnAfter(f: WorkItemFacts, s: SessionFact, at: number): TurnFact | undefined {
  return (f.sessionTurns.get(s.id) ?? []).find((t) => t.startedAt > at);
}

/**
 * hook の持ち主: 親（"parent"）、サブエージェント、サブエージェントだが分からない（null）。agentId があればサブエージェント。
 * agentId の無い許可待ちでも、その時点の親のターンが閉じた後に出たもので、その時に動いていたサブエージェントがあれば
 * そのサブエージェントのもの（親は止まっているので許可を求めない）
 */
export function hookOwner(
  f: WorkItemFacts,
  s: SessionFact,
  h: HookFact,
): SubagentFact | null | "parent" {
  const subs = subagentsOf(f, s);
  if (h.agentId) return subs.find((x) => x.agentId === h.agentId) ?? null;
  if (subs.length === 0 || !isPermissionHook(h)) return "parent";
  const at = h.occurredAt;
  const turn = [...(f.sessionTurns.get(s.id) ?? [])].reverse().find((t) => t.startedAt <= at);
  if (!turn || turn.endedAt === null || turn.endedAt >= at) return "parent";
  const cand = subs
    .filter(
      (x) =>
        x.startedAt <= at &&
        (x.endedAt === null || x.endedAt >= at) &&
        x.lastActivityAt >= turn.startedAt,
    )
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0];
  return cand ?? "parent";
}

export function isParentHook(f: WorkItemFacts, s: SessionFact, h: HookFact): boolean {
  return hookOwner(f, s, h) === "parent";
}

/** サブエージェントがまだ動いているか（終わっていない・最後の活動が runningStale の中・その後に親が再開していない） */
export function subagentRunning(
  f: WorkItemFacts,
  s: SessionFact,
  sub: SubagentFact,
  now: number,
  timing?: DeriveTiming,
): boolean {
  if (sub.endedAt !== null) return false;
  if (now - sub.lastActivityAt > staleOf(timing, s.tool)) return false;
  return turnAfter(f, s, sub.lastActivityAt) === undefined;
}

/** 動いているサブエージェント（最後の活動が新しいもの）。無ければ null */
export function subagentRunningOf(
  f: WorkItemFacts,
  s: SessionFact,
  now: number,
  timing?: DeriveTiming,
): SubagentFact | null {
  return (
    subagentsOf(f, s)
      .filter((x) => subagentRunning(f, s, x, now, timing))
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0] ?? null
  );
}

/**
 * サブエージェントの許可待ち（hook h）が閉じた時刻（開いていれば null）: サブエージェントのトランスクリプトの後の活動
 * （上限）・終わり、親の次のターンの始まり、親の入力（UserPromptSubmit）・終了（SessionEnd）の早いもの
 */
export function subagentPermissionEnd(
  f: WorkItemFacts,
  s: SessionFact,
  h: HookFact,
  owner: SubagentFact | null,
): number | null {
  const at = h.occurredAt;
  const c: number[] = [];
  if (owner) {
    if (owner.lastActivityAt > at + 1000) c.push(owner.lastActivityAt);
    if (owner.endedAt !== null && owner.endedAt >= at) c.push(owner.endedAt);
  } else {
    const act = activityOf(f, s);
    if (act > at + 1000) c.push(act);
  }
  const next = turnAfter(f, s, at);
  if (next) c.push(next.startedAt);
  const clear = f.hooks.find(
    (x) =>
      x.sessionExternalId === s.externalId &&
      x.occurredAt > at &&
      isClearingHook(x) &&
      x.name !== "Stop" &&
      x.name !== "StopFailure" &&
      !x.agentId,
  );
  if (clear) c.push(clear.occurredAt);
  return c.length > 0 ? Math.min(...c) : null;
}

/** 開いているサブエージェントの許可待ち（since 以後の hook のうち新しいもの）。無ければ null */
export function openSubagentPermission(
  f: WorkItemFacts,
  s: SessionFact,
  since: number,
): HookFact | null {
  const hooks = f.hooks.filter(
    (h) => h.sessionExternalId === s.externalId && h.occurredAt >= since && isPermissionHook(h),
  );
  for (const h of [...hooks].reverse()) {
    const owner = hookOwner(f, s, h);
    if (owner === "parent") continue;
    if (subagentPermissionEnd(f, s, h, owner) === null) return h;
  }
  return null;
}

/** 親のセッション s のサブエージェントが動いているか、許可を待っているか（親のターン last の始まりより後の許可待ち） */
export function subagentBusy(
  f: WorkItemFacts,
  s: SessionFact,
  last: TurnFact,
  now: number,
  timing?: DeriveTiming,
): boolean {
  return (
    subagentRunningOf(f, s, now, timing) !== null ||
    openSubagentPermission(f, s, last.startedAt - 1000) !== null
  );
}

/**
 * ターン t の後に AI が働き終えた時刻（待ちの始まり）。t が閉じた時刻に動いていたサブエージェントの終わり、続いて
 * その完了で親が再開したターン（人の入力でないもの。サブエージェントの終わりから SUBAGENT_RESUME_GAP_MS 以内に
 * 始まったもの）の終わりまで延ばす。まだ働いていれば null。サブエージェントが無ければ t の終わりのまま
 */
export function settledAfter(
  f: WorkItemFacts,
  t: TurnFact,
  now: number,
  timing?: DeriveTiming,
): number | null {
  const base = t.endedAt ?? t.startedAt;
  const s = f.sessions.find((x) => x.id === t.sessionId);
  if (!s || subagentsOf(f, s).length === 0) return base;
  let end = base;
  let cur = t;
  for (let i = 0; i < 50; i++) {
    const subs = subagentsOf(f, s).filter((x) => x.startedAt <= end && x.lastActivityAt > end);
    if (subs.length === 0) break;
    if (subs.some((x) => subagentRunning(f, s, x, now, timing))) return null;
    if (openSubagentPermission(f, s, cur.startedAt - 1000) !== null) return null;
    end = Math.max(end, ...subs.map((x) => x.endedAt ?? x.lastActivityAt));
    const next = (f.sessionTurns.get(s.id) ?? []).find(
      (x) =>
        x.startedAt > cur.startedAt &&
        x.startedAt <= end + SUBAGENT_RESUME_GAP_MS &&
        !isHumanTurn(x),
    );
    if (!next) break;
    if (next.endedAt === null) {
      if (next.status === "running" && now - s.lastActivityAt <= staleOf(timing, s.tool))
        return null;
      end = Math.max(end, next.startedAt, s.lastActivityAt);
    } else end = Math.max(end, next.endedAt);
    cur = next;
  }
  return end;
}
