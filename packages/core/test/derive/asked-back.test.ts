/**
 * 問い返し（Issue #3）と、手で自分の番に戻した行: AI の問い A に問いで返したら A を閉じず、AI の答えが問いでなければ
 * A を自分の番に戻し、新しい問いならそれが置き換える。手で戻した行は手で閉じるか新しい記録が来るまで残る
 */
import { describe, expect, test } from "bun:test";
import {
  askedBackOf,
  askedBackOfFollowUp,
  deriveStatus,
  desiredFollowUps,
  reconcileFollowUps,
} from "../../src/derive/index.ts";
import { aiEnd, at, facts, followUp, MIN, SETTINGS, TIMING, turn } from "./helpers.ts";

const ON = { ...SETTINGS, followUpKinds: { ...SETTINGS.followUpKinds, reply: true } };

/** 10:00 の問い A と、その返答タスク */
function asked() {
  const t1 = aiEnd(at("10:00"), { endedWith: "question" });
  const a = followUp({ kind: "reply", triggerAt: at("10:00"), triggerTurnId: t1.id });
  return { t1, a };
}
const reconcile = (f: ReturnType<typeof facts>, now: number) =>
  reconcileFollowUps(
    f,
    desiredFollowUps(f, deriveStatus(f, now, ON, TIMING), now, ON, TIMING),
    now,
    ON,
  );

describe("askedBackOf", () => {
  const h = (p: Partial<Parameters<typeof askedBackOf>[0][number]>) => ({
    status: "completed" as const,
    endedWith: "end_turn" as const,
    closingQuestion: false,
    instructionAsks: true,
    ...p,
  });
  test("no input, or an input that is not a question: not asked back", () => {
    expect(askedBackOf([])).toBeNull();
    expect(askedBackOf([h({ instructionAsks: false })])).toBeNull();
    expect(askedBackOf([h({}), h({ instructionAsks: false })])).toBeNull();
    expect(askedBackOf([h({ instructionAsks: undefined })])).toBeNull();
  });
  test("asking turn running → pending; ended not as a question (incl. interrupted / error) → returned; new question → replaced", () => {
    expect(askedBackOf([h({ status: "running", endedWith: null })])).toBe("pending");
    expect(askedBackOf([h({})])).toBe("returned");
    expect(askedBackOf([h({ status: "interrupted", endedWith: "aborted" })])).toBe("returned");
    expect(askedBackOf([h({ status: "error", endedWith: "error" })])).toBe("returned");
    expect(askedBackOf([h({ endedWith: "question" })])).toBe("replaced");
    // a closing question (Anything else?) is not a new question
    expect(askedBackOf([h({ endedWith: "question", closingQuestion: true })])).toBe("returned");
    expect(askedBackOf([h({}), h({ status: "running", endedWith: null })])).toBe("pending");
  });
});

describe("reconcile with an asked-back question", () => {
  test("an input that asks back does not close A; while the AI answers it is pending", () => {
    const { t1, a } = asked();
    const t2 = turn({ start: at("10:05"), end: null, instructionAsks: true });
    const f = facts({ turns: [t1, t2], followUps: [a] });
    expect(askedBackOfFollowUp(f, a)).toBe("pending");
    expect(reconcile(f, at("10:06"))).toEqual([]);
  });

  test("the AI's answer is not a question: A stays open (back on Your turn under its own title)", () => {
    const { t1, a } = asked();
    const t2 = turn({ start: at("10:05"), end: at("10:08"), instructionAsks: true });
    const f = facts({ turns: [t1, t2], followUps: [a] });
    expect(askedBackOfFollowUp(f, a)).toBe("returned");
    expect(reconcile(f, at("10:30"))).toEqual([]);
  });

  test("the AI's answer is a new question: A is replaced", () => {
    const { t1, a } = asked();
    const t2 = turn({
      start: at("10:05"),
      end: at("10:08"),
      instructionAsks: true,
      endedWith: "question",
    });
    const f = facts({ turns: [t1, t2], followUps: [a] });
    const acts = reconcile(f, at("10:09"));
    expect(acts).toContainEqual({
      type: "close",
      id: a.id,
      status: "superseded",
      reason: "auto:asked_back_replaced",
      at: at("10:09"),
    });
  });

  test("an answer afterwards closes A as before (the asking input is skipped)", () => {
    const { t1, a } = asked();
    const t2 = turn({ start: at("10:05"), end: at("10:08"), instructionAsks: true });
    const t3 = turn({ start: at("10:20"), end: null, instructionAsks: false });
    const f = facts({ turns: [t1, t2, t3], followUps: [a] });
    expect(reconcile(f, at("10:21"))).toContainEqual({
      type: "close",
      id: a.id,
      status: "done",
      reason: "auto:human_input",
      at: at("10:20"),
    });
  });

  test("without a stored first line nothing changes: the input closes A", () => {
    const { t1, a } = asked();
    const t2 = turn({ start: at("10:05"), end: null });
    const f = facts({ turns: [t1, t2], followUps: [a] });
    expect(reconcile(f, at("10:06"))).toContainEqual({
      type: "close",
      id: a.id,
      status: "done",
      reason: "auto:human_input",
      at: at("10:05"),
    });
  });
});

describe("a row put back on Your turn by hand", () => {
  test("stays open: no auto close by the old input, signals, state, or age", () => {
    const { t1 } = asked();
    const t2 = turn({ start: at("10:05"), end: at("10:08") });
    const back = followUp({
      kind: "reply",
      triggerAt: at("10:00"),
      triggerTurnId: t1.id,
      returnedAt: at("11:00"),
    });
    const f = facts({ turns: [t1, t2], followUps: [back] });
    expect(reconcile(f, at("11:01"))).toEqual([]);
    // 72 hours later still open
    expect(reconcile(f, at("11:00") + 80 * 60 * MIN)).toEqual([]);
  });

  test("a new turn after it was put back closes it (a new record came)", () => {
    const { t1 } = asked();
    const back = followUp({
      kind: "approve",
      triggerAt: at("10:00"),
      triggerTurnId: t1.id,
      returnedAt: at("11:00"),
    });
    const t3 = turn({ start: at("11:10"), end: null });
    const f = facts({ turns: [t1, t3], followUps: [back] });
    expect(reconcile(f, at("11:11"))).toContainEqual({
      type: "close",
      id: back.id,
      status: "done",
      reason: "auto:new_record",
      at: at("11:10"),
    });
  });
});
