/**
 * 報告（ADR 0021）のセッションの判定: report アダプタが出す形（system のターン・pendingQuestion・許可待ちの hook）が、
 * 既存の 5 状態と自分の番にそのまま乗る
 */
import { describe, expect, test } from "bun:test";
import {
  deriveStatus,
  desiredFollowUps,
  isReportSession,
  runningStaleOf,
} from "../../src/derive/index.ts";
import {
  at,
  compute,
  facts,
  followUp,
  hook,
  MIN,
  SETTINGS,
  session,
  TIMING,
  turn,
} from "./helpers.ts";

const ON = {
  ...SETTINGS,
  followUpKinds: {
    ...SETTINGS.followUpKinds,
    reply: true,
    approve: true,
    resume_error: true,
  },
};
const T = { runningStaleMs: { ...TIMING.runningStaleMs, report: 24 * 60 * MIN } };
const S = (lastActivityAt: number) =>
  session({ tool: "myscript", externalId: "job-1", entrypoint: "report", lastActivityAt });
const rt = (p: Parameters<typeof turn>[0]) =>
  turn({ initiator: "system", gitBranch: null, cwd: null, ...p });
const H = (name: string, t: number) =>
  hook(name, t, { tool: "myscript", sessionExternalId: "job-1" });

const judge = (f: ReturnType<typeof facts>, now: number) => {
  const st = deriveStatus(f, now, ON, T);
  return { st, fus: desiredFollowUps(f, st, now, ON, T).map((x) => x.kind) };
};

describe("報告のセッション", () => {
  test("isReportSession と、実行中の鮮度（最後の報告から 1 日）", () => {
    expect(isReportSession({ entrypoint: "report" })).toBe(true);
    expect(isReportSession({ entrypoint: "cli" })).toBe(false);
    expect(runningStaleOf(T, S(0))).toBe(24 * 60 * MIN);
    expect(runningStaleOf(TIMING, S(0))).toBe(24 * 60 * MIN);
    expect(runningStaleOf(T, session())).toBe(5 * MIN);
  });

  test.each([
    {
      name: "started: 実行中（5 分を過ぎても）",
      turns: [rt({ start: at("10:00"), end: null })],
      hooks: [],
      last: at("10:00"),
      now: at("12:00"),
      status: "running",
      fus: [],
    },
    {
      name: "waiting(question): すぐ自分の番（needs_input、返答タスク）",
      turns: [rt({ start: at("10:00"), end: null, pendingQuestion: true })],
      hooks: [],
      last: at("10:05"),
      now: at("10:06"),
      status: "needs_input",
      fus: ["reply"],
    },
    {
      name: "waiting(permission): 許可待ち（needs_input、許可のタスク）",
      turns: [rt({ start: at("10:00"), end: null })],
      hooks: [H("PermissionRequest", at("10:05"))],
      last: at("10:05"),
      now: at("10:06"),
      status: "needs_input",
      fus: ["approve"],
    },
    {
      name: "waiting(permission) の後の running: 先に進んだので待ちは外れる",
      turns: [rt({ start: at("10:00"), end: null })],
      hooks: [H("PermissionRequest", at("10:05"))],
      last: at("10:09"),
      now: at("10:10"),
      status: "running",
      fus: [],
    },
    {
      name: "done: 完了（自分の番にしない）",
      turns: [rt({ start: at("10:00"), end: at("10:12") })],
      hooks: [],
      last: at("10:12"),
      now: at("10:30"),
      status: "done",
      fus: [],
    },
    {
      name: "error: エラー（再開のタスク）",
      turns: [rt({ start: at("10:00"), end: at("10:12"), status: "error", endedWith: "error" })],
      hooks: [],
      last: at("10:12"),
      now: at("10:13"),
      status: "error",
      fus: ["resume_error"],
    },
    {
      name: "done の後の started: 同じ項目の新しいターンで実行中",
      turns: [rt({ start: at("10:00"), end: at("10:12") }), rt({ start: at("11:00"), end: null })],
      hooks: [],
      last: at("11:00"),
      now: at("11:01"),
      status: "running",
      fus: [],
    },
  ])("$name", ({ turns, hooks, last, now, status, fus }) => {
    const f = facts({
      turns: [...turns],
      hooks: [...hooks],
      sessions: [S(last)],
      nonGit: true,
      kind: "session",
    });
    const r = judge(f, now);
    expect(r.st.status).toBe(status as never);
    expect(r.fus).toEqual(fus as never);
  });
});

describe("報告の待ちには猶予を付けない（自分の番はすぐ出るので、区間も最初から放置）", () => {
  test("問い（返答タスク <turn>:ask）・許可待ちの hook", () => {
    const t1 = rt({ start: at("10:00"), end: null, pendingQuestion: true });
    const ask = followUp({
      kind: "reply",
      triggerAt: at("10:05"),
      triggerTurnId: t1.id,
      artifactRef: `${t1.id}:ask`,
    });
    const f = facts({ turns: [t1], followUps: [ask], sessions: [S(at("10:05"))], nonGit: true });
    const kinds = compute(f, at("10:40"), { presence: [[at("09:00"), at("11:00")]] }).segments.map(
      (x) => x.kind,
    );
    expect(kinds).not.toContain("grace");
    expect(kinds).toContain("idle");
    const t2 = rt({ start: at("10:00"), end: null });
    const g = facts({
      turns: [t2],
      hooks: [H("PermissionRequest", at("10:05"))],
      sessions: [S(at("10:05"))],
      nonGit: true,
    });
    expect(
      compute(g, at("10:40"), { presence: [[at("09:00"), at("11:00")]] }).segments.some(
        (x) => x.kind === "grace",
      ),
    ).toBe(false);
  });
});
