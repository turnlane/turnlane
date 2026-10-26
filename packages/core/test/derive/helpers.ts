/** derive のシナリオテスト用の事実の組み立て（TZ=Asia/Tokyo、日付区切り 04:00、猶予15分、返答の期限72時間） */
import { addDays, toLocalDate, wallToEpoch } from "../../src/dates.ts";
import {
  type CalendarEventFact,
  classifyWait,
  type FollowUpFact,
  type HookFact,
  isBusyEvent,
  type PrFact,
  type SessionFact,
  type TurnFact,
  type WaitInterval,
  type WaitSegment,
  type WorkItemFacts,
  waitIntervals,
} from "../../src/derive/index.ts";
import { DEFAULT_SETTINGS, type TurnlaneSettings } from "../../src/settings.ts";

export const TZ = "Asia/Tokyo";
export const D = "2026-09-14";
export const SETTINGS: TurnlaneSettings = { ...DEFAULT_SETTINGS, tz: TZ, dayBoundary: 240 };
export const TIMING = { runningStaleMs: { claude_code: 5 * 60_000, codex: 10 * 60_000 } };

/** "10:00" → D の 10:00（day は D からの日数。"03:50" のような深夜も壁時計どおり） */
export function at(hhmm: string, day = 0): number {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  const [y, mo, d] = addDays(D, day).split("-").map(Number) as [number, number, number];
  return wallToEpoch(y, mo, d, h * 60 + m, TZ);
}

export const MIN = 60_000;

let seq = 0;
export function turn(p: Partial<TurnFact> & { start: number; end?: number | null }): TurnFact {
  const { start, end, ...rest } = p;
  const endedAt = end === undefined ? start + 60_000 : end;
  return {
    id: `t${++seq}`,
    sessionId: "s1",
    startedAt: start,
    endedAt,
    durationMs: endedAt === null ? null : endedAt - start,
    status: endedAt === null ? "running" : "completed",
    endedWith: "end_turn",
    initiator: "human",
    gitBranch: "feat/x",
    cwd: "/fixture/repo-a",
    editedFiles: 0,
    pendingQuestion: false,
    closingQuestion: false,
    localDate: toLocalDate(start, TZ, 240),
    ...rest,
  };
}

/** AI のターン終了（質問・編集など）。人間の入力で始まり、end に終わる */
export function aiEnd(end: number, p: Partial<TurnFact> = {}): TurnFact {
  return turn({ start: end - 5 * MIN, end, ...p });
}

/** 人間の入力（その時刻に始まって走っているターン） */
export function human(start: number, p: Partial<TurnFact> = {}): TurnFact {
  return turn({ start, end: start + 2 * MIN, ...p });
}

export function session(p: Partial<SessionFact> = {}): SessionFact {
  return {
    id: "s1",
    tool: "claude_code",
    externalId: "ext-s1",
    parentId: null,
    isSubagent: false,
    isNoise: false,
    archived: false,
    liveStatus: null,
    liveCheckedAt: null,
    lastActivityAt: 0,
    ...p,
  };
}

export function followUp(
  p: Partial<FollowUpFact> & { kind: FollowUpFact["kind"]; triggerAt: number },
): FollowUpFact {
  return {
    id: `f${++seq}`,
    artifactRef: p.triggerTurnId ?? "",
    dedupeKey: `wi|${p.kind}|${p.triggerTurnId ?? ""}`,
    triggerTurnId: null,
    status: "open",
    snoozeUntil: null,
    snoozes: [],
    engagedAt: null,
    closedAt: null,
    closeReason: null,
    ...p,
  };
}

export function pr(p: Partial<PrFact> & { firstSeenAt: number }): PrFact {
  return {
    ref: "org/repo#1",
    number: 1,
    state: "open",
    headRef: "feat/x",
    title: null,
    stateChangedAt: null,
    myReviewAt: null,
    ...p,
  };
}

export function hook(name: string, occurredAt: number, p: Partial<HookFact> = {}): HookFact {
  return {
    id: `h${++seq}`,
    sessionExternalId: "ext-s1",
    tool: "claude_code",
    name,
    notificationType: null,
    occurredAt,
    ...p,
  };
}

export function facts(p: Partial<WorkItemFacts> = {}): WorkItemFacts {
  const turns = p.turns ?? [];
  const sessions = p.sessions ?? [
    session({ lastActivityAt: Math.max(0, ...turns.map((t) => t.endedAt ?? t.startedAt)) }),
  ];
  const sessionTurns = new Map<string, TurnFact[]>();
  for (const t of turns)
    sessionTurns.set(t.sessionId, [...(sessionTurns.get(t.sessionId) ?? []), t]);
  return {
    workItemId: "wi",
    kind: "branch",
    nonGit: false,
    defaultBranchCard: false,
    turns,
    sessions,
    sessionTurns,
    hooks: [],
    prs: [],
    manualDoneAt: null,
    dirty: null,
    followUps: [],
    ...p,
  };
}

export interface DayInput {
  /**
   * 本人の操作。presence を渡さないとき、操作のある論理日ごとに最初の操作から最後の操作（今日は now）まで Mac を
   * 使っていた（在席）とみなす（人間入力のターンの開始は facts から自動で足す）。勤務時間（D-018）で書いた
   * シナリオを在席（D-105）に写すためのもの
   */
  ops?: number[];
  /** 在席の区間（D-105）。渡すと ops からは作らない */
  presence?: [number, number][];
  events?: CalendarEventFact[];
}

export function busyEvent(
  start: number,
  end: number,
  p: Partial<CalendarEventFact> = {},
): CalendarEventFact {
  return {
    startAt: start,
    endAt: end,
    status: "confirmed",
    availability: "busy",
    selfResponse: "accepted",
    isOwnTimeblock: false,
    calendarRole: "source",
    ...p,
  };
}

/** テストの在席: input.presence か、ops（と人間入力）から論理日ごとの [最初, 最後（今日は now）] */
export function presenceOf(f: WorkItemFacts, now: number, input: DayInput): [number, number][] {
  if (input.presence) return input.presence;
  const ops = [
    ...(input.ops ?? []),
    ...f.turns
      .filter((t) => t.initiator === "human" || t.initiator === "queued")
      .map((t) => t.startedAt),
  ].sort((a, b) => a - b);
  const today = toLocalDate(now, TZ, 240);
  const byDate = new Map<string, [number, number]>();
  for (const t of ops) {
    const d = toLocalDate(t, TZ, 240);
    const r = byDate.get(d);
    if (r) r[1] = t;
    else byDate.set(d, [t, t]);
  }
  const out: [number, number][] = [];
  for (const [d, r] of byDate) {
    const end = d === today ? Math.max(r[1], now) : r[1];
    if (end > r[0]) out.push([r[0], end]);
  }
  return out;
}

export interface Summary {
  [date: string]: {
    grace?: number;
    idle?: number;
    closed?: number;
    away?: number;
    event?: number;
    snoozed?: number;
    no_task?: number;
    scheduled?: number;
    expired?: number;
  };
}

/** 区間を分単位の日別集計にする（0 は出さない） */
export function summarize(segs: WaitSegment[]): Summary {
  const out: Summary = {};
  for (const s of segs) {
    const k = s.kind === "excluded" ? (s.excludedBy as string) : s.kind;
    const d = out[s.localDate] ?? {};
    out[s.localDate] = d;
    (d as Record<string, number>)[k] =
      ((d as Record<string, number>)[k] ?? 0) + (s.end - s.start) / MIN;
  }
  return out;
}

export function compute(
  f: WorkItemFacts,
  now: number,
  input: DayInput = {},
): { intervals: WaitInterval[]; segments: WaitSegment[]; summary: Summary } {
  const intervals = waitIntervals(f, now, SETTINGS);
  const ctx = {
    settings: SETTINGS,
    presence: presenceOf(f, now, input),
    busy: (input.events ?? [])
      .filter(isBusyEvent)
      .map((e) => [e.startAt, e.endAt] as [number, number]),
  };
  const segments = intervals.flatMap((iv) => classifyWait(iv, ctx));
  return { intervals, segments, summary: summarize(segments) };
}

/** 入力の並び順を入れ替えた事実（取り込みの順序が違っても同じ結果になることの確認用） */
export function shuffled(f: WorkItemFacts): WorkItemFacts {
  const rev = <T>(xs: T[]) => [...xs].reverse();
  const st = new Map<string, TurnFact[]>();
  for (const [k, v] of f.sessionTurns) st.set(k, rev(v));
  return {
    ...f,
    turns: rev(f.turns),
    hooks: rev(f.hooks),
    followUps: rev(f.followUps),
    prs: rev(f.prs),
    sessionTurns: st,
  };
}
