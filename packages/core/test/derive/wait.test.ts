/**
 * 答える対象の待ち（D-240。derive/wait.ts）の表駆動テスト: 開いているフォローアップ → 無ければセッションの待ち。
 * 猶予（reply.delay_minutes）の間も問いに答えられること、猶予の意味（返答タスクを作る時刻）は変えないことを確かめる
 */
import { describe, expect, test } from "bun:test";
import {
  type DeriveTiming,
  deriveStatus,
  desiredFollowUps,
  followUpWaitKind,
  openWaitOf,
  sessionWaitOf,
  type WorkItemFacts,
} from "../../src/derive/index.ts";
import {
  aiEnd,
  at,
  facts,
  followUp,
  hook,
  MIN,
  pr,
  SETTINGS,
  session,
  shuffled,
  TIMING,
  turn,
} from "./helpers.ts";

const sw = (f: WorkItemFacts, now: number, timing: DeriveTiming = TIMING, settings = SETTINGS) => {
  const st = deriveStatus(f, now, settings, timing);
  const a = sessionWaitOf(f, st, now, settings, timing);
  expect(sessionWaitOf(shuffled(f), st, now, settings, timing)).toEqual(a);
  return a;
};
const replies = (
  f: WorkItemFacts,
  now: number,
  timing: DeriveTiming = TIMING,
  settings = SETTINGS,
) =>
  desiredFollowUps(f, deriveStatus(f, now, settings, timing), now, settings, timing).filter(
    (d) => d.kind === "reply",
  );

describe("セッションの待ち（sessionWaitOf）", () => {
  const q = aiEnd(at("10:00"), { endedWith: "question" });
  const f = facts({ turns: [q] });

  test("在席中の問い: 猶予（15 分）の間は返答タスクが無いが、待ちはある（question）", () => {
    expect(replies(f, at("10:01"))).toEqual([]);
    expect(sw(f, at("10:01"))).toEqual({ kind: "question", turnId: q.id, sessionId: "s1" });
    // 猶予の後は返答タスクができる。待ちは同じ
    expect(replies(f, at("10:15")).map((d) => d.triggerTurnId)).toEqual([q.id]);
    expect(sw(f, at("10:15"))).toEqual({ kind: "question", turnId: q.id, sessionId: "s1" });
  });

  test("離席中に止まった問いも同じ（返答タスクはすぐ。待ちもすぐ）", () => {
    const away = { ...TIMING, awayAt: () => true };
    expect(replies(f, at("10:01"), away)).toHaveLength(1);
    expect(sw(f, at("10:01"), away)?.kind).toBe("question");
  });

  test("猶予の長さを変えても待ちの開く時刻は変わらない（猶予は見ない）", () => {
    const long = { ...SETTINGS, replyDelayMs: 60 * MIN };
    expect(replies(f, at("10:30"), TIMING, long)).toEqual([]);
    expect(sw(f, at("10:30"), TIMING, long)?.kind).toBe("question");
  });

  test("返答タスクの種類がオフでも待ちはある（答えるのは返答タスクと別。設定 turn.answer はデーモンが見る）", () => {
    const off = { ...SETTINGS, followUpKinds: { ...SETTINGS.followUpKinds, reply: false } };
    expect(replies(f, at("10:20"), TIMING, off)).toEqual([]);
    expect(sw(f, at("10:20"), TIMING, off)?.kind).toBe("question");
  });

  test("人の入力が来たら閉じる。締めの決まり文句・問いでない終わり・返答タスクを閉じたターンは待ちではない", () => {
    const g = facts({ turns: [q, turn({ start: at("10:05"), end: null })] });
    expect(sw(g, at("10:06"))).toBeNull();
    expect(sw(facts({ turns: [aiEnd(at("10:00"))] }), at("10:01"))).toBeNull();
    expect(
      sw(
        facts({ turns: [aiEnd(at("10:00"), { endedWith: "question", closingQuestion: true })] }),
        at("10:01"),
      ),
    ).toBeNull();
    const dismissed = followUp({
      kind: "reply",
      triggerAt: at("10:00"),
      triggerTurnId: q.id,
      status: "dismissed",
      closedAt: at("10:20"),
    });
    expect(sw(facts({ turns: [q], followUps: [dismissed] }), at("10:21"))).toBeNull();
  });

  test("許可待ち（hooks・live:idle）は permission、AskUserQuestion は ask", () => {
    const hooked = facts({
      turns: [turn({ start: at("10:00"), end: null })],
      sessions: [session({ lastActivityAt: at("10:01") })],
      hooks: [hook("UserPromptSubmit", at("10:00")), hook("PermissionRequest", at("10:01"))],
    });
    expect(sw(hooked, at("10:02"))?.kind).toBe("permission");
    const idle = facts({
      turns: [turn({ start: at("10:00"), end: null })],
      sessions: [
        session({ lastActivityAt: at("10:01"), liveStatus: "idle", liveCheckedAt: at("10:02") }),
      ],
    });
    expect(sw(idle, at("10:02"))?.kind).toBe("permission");
    const ask = facts({ turns: [turn({ start: at("10:00"), end: null, pendingQuestion: true })] });
    expect(sw(ask, at("10:02"))?.kind).toBe("ask");
  });

  test("エラー・PR の確認・終わったカードは対象外", () => {
    const err = facts({ turns: [turn({ start: at("10:00"), end: at("10:01"), status: "error" })] });
    expect(sw(err, at("10:02"))).toBeNull();
    const prOnly = facts({ turns: [aiEnd(at("10:00"))], prs: [pr({ firstSeenAt: at("10:00") })] });
    expect(deriveStatus(prOnly, at("10:02"), SETTINGS, TIMING).reason).toBe("pr_open");
    expect(sw(prOnly, at("10:02"))).toBeNull();
    const done = facts({ turns: [q], manualDoneAt: at("10:03") });
    expect(sw(done, at("10:04"))).toBeNull();
  });

  test("2 つのセッション: 許可待ちのセッションを問いより先に。問い同士は新しく止まった方", () => {
    const a = aiEnd(at("10:00"), { endedWith: "question", sessionId: "s1" });
    const b = aiEnd(at("10:05"), { endedWith: "question", sessionId: "s2" });
    const two = facts({
      turns: [a, b],
      sessions: [
        session({ id: "s1", externalId: "ext-s1", lastActivityAt: at("10:00") }),
        session({ id: "s2", externalId: "ext-s2", lastActivityAt: at("10:05") }),
      ],
    });
    expect(sw(two, at("10:06"))).toEqual({ kind: "question", turnId: b.id, sessionId: "s2" });
    const p = turn({ start: at("10:06"), end: null, sessionId: "s1" });
    const perm = facts({
      turns: [a, b, p],
      sessions: [
        session({ id: "s1", externalId: "ext-s1", lastActivityAt: at("10:07") }),
        session({ id: "s2", externalId: "ext-s2", lastActivityAt: at("10:05") }),
      ],
      hooks: [hook("PermissionRequest", at("10:07"))],
    });
    expect(sw(perm, at("10:08"))).toEqual({ kind: "permission", turnId: p.id, sessionId: "s1" });
  });
});

describe("答える対象（openWaitOf）", () => {
  const s = { kind: "question" as const, turnId: "t9", sessionId: "s1" };
  test("開いているフォローアップがあればそれ（許可・エラー・返答・回答）", () => {
    expect(openWaitOf({ id: "f1", kind: "approve", artifactRef: "t1", turnId: "t1" }, s)).toEqual({
      kind: "permission",
      turnId: "t1",
      followUpId: "f1",
    });
    expect(
      openWaitOf({ id: "f2", kind: "resume_error", artifactRef: "t1", turnId: "t1" }, null),
    ).toEqual({ kind: "error", turnId: "t1", followUpId: "f2" });
    expect(
      openWaitOf({ id: "f3", kind: "reply", artifactRef: "t1:ask", turnId: "t1" }, null)?.kind,
    ).toBe("ask");
  });
  test("無ければセッションの待ち（フォローアップは null）。PR の確認は対象にしない", () => {
    expect(openWaitOf(null, s)).toEqual({ kind: "question", turnId: "t9", followUpId: null });
    expect(
      openWaitOf({ id: "f4", kind: "review_pr", artifactRef: "org/repo#1", turnId: null }, s),
    ).toEqual({ kind: "question", turnId: "t9", followUpId: null });
    expect(
      openWaitOf({ id: "f4", kind: "review_pr", artifactRef: "org/repo#1", turnId: null }, null),
    ).toBeNull();
    expect(openWaitOf(null, null)).toBeNull();
    expect(followUpWaitKind("check_changes", "t1")).toBeNull();
  });
});
