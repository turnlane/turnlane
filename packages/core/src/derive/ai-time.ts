/**
 * AI の時間（ターンの稼働区間。D-052 (4)、m2-api.md 11章）。
 *
 * 終わったターンは所要時間（duration_ms。無ければ ended_at − started_at）。終わっていないターン（status = running で
 * ended_at が無い）は、始まりから次の時刻までを数える:
 * - カードが running: now
 * - カードが needs_input で、ターンの後に開いた待ちがある: 待ちの始まり（許可待ち・質問で止まった時刻）
 * - それ以外（止まって見える。プロセスが落ちた等）: セッションの最後の活動
 * いずれも [始まり, now] に収める。work_item_daily（duration_ms の和）だけでは実行中・待ち中のカードが 0 になる。
 * 終わっていないターンでも hook で終わったとみなせる（openTurnHookEnd）ものは、読む側（デーモン）が ended_at をその時刻に
 * して渡す（終わったターンとして数える）。
 */

/** openTurnHookEnd が見る hook（親の hook。サブエージェントの hook は agentId 付き） */
export interface TurnEndHook {
  name: string;
  notificationType?: string | null;
  agentId?: string | null;
  occurredAt: number;
}

/**
 * 終わっていないターン（トランスクリプトに終わりが無い）が、hook で終わったとみなせる時刻。無ければ null。
 * ターンの hook の窓（始まりの 1 秒前から次のターンの始まりまで。turnStopOf と同じ）で、最後の再開（UserPromptSubmit・
 * quota_auto_resume_fired）の後の
 * - Stop（AI が応答を終えた。トランスクリプトの取り込みより先に届くことがある）→ その hook の時刻
 * - StopFailure（API のエラーでターンが終わった。Claude Code は Stop の代わりに出す）・quota_auto_resume_disabled / stale
 *   → その hook の時刻
 * - Notification の idle_prompt（応答を終えて約 60 秒、入力が無い）→ その前の最後の活動（無ければ hook の時刻）
 * のうち、その後にトランスクリプトの活動が無い（セッションの最後の活動が hook の 1 秒後まで）最初のもの。
 * トランスクリプトが正（ai_turn は書き換えない）。hook は「今まで伸ばさない」ための補助にだけ使う
 */
export function openTurnHookEnd(
  t: { startedAt: number; nextStartedAt: number | null; sessionLastActivityAt: number | null },
  hooks: readonly TurnEndHook[],
): number | null {
  return hookEnd(t, hooks, false);
}

/**
 * openTurnHookEnd のうち Stop だけで決まる終わり（状態の判定に使う。StopFailure・利用枠の通知は停止として別に判定し、
 * idle_prompt は状態に使わない）。最後の再開の後に Stop があり、その後にトランスクリプトの活動が無ければその時刻
 */
export function openTurnStopEnd(
  t: { startedAt: number; nextStartedAt: number | null; sessionLastActivityAt: number | null },
  hooks: readonly TurnEndHook[],
): number | null {
  return hookEnd(t, hooks, true);
}

function hookEnd(
  t: { startedAt: number; nextStartedAt: number | null; sessionLastActivityAt: number | null },
  hooks: readonly TurnEndHook[],
  stopOnly: boolean,
): number | null {
  const win = hooks
    .filter(
      (h) =>
        !h.agentId &&
        h.occurredAt >= t.startedAt - 1000 &&
        (t.nextStartedAt === null || h.occurredAt < t.nextStartedAt),
    )
    .sort((a, b) => a.occurredAt - b.occurredAt);
  const isNotice = (h: TurnEndHook, type: string) =>
    h.name === "Notification" && h.notificationType === type;
  let from = 0;
  for (let i = win.length - 1; i >= 0; i--) {
    const h = win[i] as TurnEndHook;
    if (h.name === "UserPromptSubmit" || isNotice(h, "quota_auto_resume_fired")) {
      from = i + 1;
      break;
    }
  }
  const last = t.sessionLastActivityAt ?? Number.NEGATIVE_INFINITY;
  for (const h of win.slice(from)) {
    const stop =
      h.name === "Stop" ||
      (!stopOnly &&
        (h.name === "StopFailure" ||
          isNotice(h, "quota_auto_resume_disabled") ||
          isNotice(h, "quota_auto_resume_stale")));
    const idle = !stopOnly && isNotice(h, "idle_prompt");
    if (!stop && !idle) continue;
    if (last > h.occurredAt + 1000) continue;
    const end = idle && Number.isFinite(last) ? Math.min(h.occurredAt, last) : h.occurredAt;
    return Math.max(t.startedAt, end);
  }
  return null;
}

export interface TurnTimeInput {
  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;
  status: string;
  /** ターンのセッションの最後の活動 */
  sessionLastActivityAt: number | null;
}

export interface CardTimeContext {
  /** カード（work_item）の状態 */
  status: string;
  /** カードの開いている待ちの始まり（無ければ null） */
  openWaitStart: number | null;
  now: number;
}

export function isOpenTurn(t: Pick<TurnTimeInput, "status" | "endedAt">): boolean {
  return t.status === "running" && t.endedAt === null;
}

/** ターンの稼働区間 [start, end] */
export function turnAiInterval(t: TurnTimeInput, c: CardTimeContext): [number, number] {
  const start = t.startedAt;
  if (!isOpenTurn(t)) {
    const end = t.endedAt ?? start + (t.durationMs ?? 0);
    return [start, Math.max(start, end)];
  }
  let end: number;
  if (c.status === "running") end = c.now;
  else if (c.status === "needs_input" && c.openWaitStart !== null && c.openWaitStart > start)
    end = c.openWaitStart;
  else end = t.sessionLastActivityAt ?? start;
  return [start, Math.max(start, Math.min(end, c.now))];
}

/** ターンの AI 時間。終わったターンは duration_ms を優先する（work_item_daily と同じ値） */
export function turnAiMs(t: TurnTimeInput, c: CardTimeContext): number {
  if (!isOpenTurn(t) && t.durationMs !== null) return Math.max(0, t.durationMs);
  const [s, e] = turnAiInterval(t, c);
  return e - s;
}

/** サブエージェントの稼働区間の入力（ai_session の行。ターンを持たない） */
export interface SubagentTimeInput {
  startedAt: number;
  lastActivityAt: number;
  /** トランスクリプトが最後の応答で終わった時刻（終わっていなければ null） */
  endedAt: number | null;
}

/**
 * サブエージェントの稼働区間 [始まり, 終わり]。動いている（open。親のカードが subagent:running）なら now まで、
 * それ以外は終わった時刻（無ければ最後の活動）まで
 */
export function subagentInterval(
  s: SubagentTimeInput,
  open: boolean,
  now: number,
): [number, number] {
  const end = open ? now : (s.endedAt ?? s.lastActivityAt);
  return [s.startedAt, Math.max(s.startedAt, Math.min(end, now))];
}

/**
 * サブエージェントだけが動いていた区間: サブエージェントの区間の和集合から、親のターンの区間を除いたもの。
 * 並列のサブエージェントの時間は親ターンに含まれるので二重に数えない（ai-session-ingestion 4.5）。親のターンが閉じた後も
 * サブエージェントが動いていた分だけを、親の AI の時間として 1 回だけ足す
 */
export function subagentOnlyRanges(
  turns: readonly [number, number][],
  subs: readonly [number, number][],
): [number, number][] {
  const union = (xs: readonly [number, number][]): [number, number][] => {
    const out: [number, number][] = [];
    for (const [a, b] of [...xs].filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0])) {
      const cur = out.at(-1);
      if (cur && a <= cur[1]) cur[1] = Math.max(cur[1], b);
      else out.push([a, b]);
    }
    return out;
  };
  const cover = union(turns);
  const out: [number, number][] = [];
  for (const [a0, b] of union(subs)) {
    let a = a0;
    for (const [c, d] of cover) {
      if (d <= a || c >= b) continue;
      if (c > a) out.push([a, c]);
      a = Math.max(a, d);
      if (a >= b) break;
    }
    if (a < b) out.push([a, b]);
  }
  return out;
}
