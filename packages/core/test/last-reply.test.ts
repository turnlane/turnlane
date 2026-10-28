import { describe, expect, test } from "bun:test";
import { MASK } from "../src/glance/redact.ts";
import { LAST_REPLY_MAX, lastReplyOf, lastReplyState } from "../src/last-reply.ts";

/** 合成の鍵（本物ではない） */
const FAKE_SK = `sk-proj${"q1W2e3R4".repeat(4)}`;

describe("lastReplyOf（ADR 0019 の Decision 10）", () => {
  test("文はそのまま（前後の空白を落とす）。切っていない・伏せていない", () => {
    expect(lastReplyOf("  直しました。テストも通っています。\n")).toEqual({
      state: "ok",
      text: "直しました。テストも通っています。",
      truncated: false,
      masked: false,
    });
  });

  test("空・null は none", () => {
    expect(lastReplyOf(null)).toEqual({ state: "none" });
    expect(lastReplyOf(" \n ")).toEqual({ state: "none" });
    expect(lastReplyState("gone")).toEqual({ state: "gone" });
  });

  test("2,000 字で切って truncated（末尾は …）", () => {
    const r = lastReplyOf("あ".repeat(LAST_REPLY_MAX + 10));
    expect(r.truncated).toBe(true);
    expect(r.text?.length).toBe(LAST_REPLY_MAX);
    expect(r.text?.endsWith("…")).toBe(true);
    expect(lastReplyOf("い".repeat(LAST_REPLY_MAX)).truncated).toBe(false);
  });

  test("伏せ字は保存する行と同じ規則。切る前に通す（2,000 字の境目にかかる鍵も伏せる）", () => {
    const r = lastReplyOf(`設定しました: export OPENAI_API_KEY=${FAKE_SK}`);
    expect(r.masked).toBe(true);
    expect(r.text).not.toContain(FAKE_SK);
    expect(r.text).toContain(MASK);
    const edge = lastReplyOf(`${"x ".repeat(LAST_REPLY_MAX / 2 - 10)}TOKEN=${FAKE_SK}`);
    expect(edge.text).not.toContain(FAKE_SK.slice(0, 12));
    expect(edge.masked).toBe(true);
  });
});
