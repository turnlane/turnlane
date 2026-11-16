/**
 * 図つきの問い（ADR 0022）の本文の検証: 上限を超えた文は切らずに項目名で断る。大きすぎる図は断らずに「読めない図」にする
 */
import { describe, expect, test } from "bun:test";
import {
  ASK_CONTEXT_MAX,
  ASK_FILE_MAX,
  ASK_QUESTION_MAX,
  parseAskAnswer,
  parseAskInput,
} from "../src/ask.ts";

const opt = (label: string, p: Record<string, unknown> = {}) => ({
  label,
  description: `${label} の説明`,
  ...p,
});
const base = { question: "Where should the save button go?", options: [opt("A"), opt("B")] };

describe("parseAskInput", () => {
  test("最小の形（問いと 2 案）", () => {
    const r = parseAskInput(base);
    expect(r).toEqual({
      ok: true,
      value: { question: base.question, options: [opt("A"), opt("B")] },
    });
  });

  test.each([
    ["question が無い", { ...base, question: undefined }, "question"],
    ["question が空白だけ", { ...base, question: "   " }, "question"],
    ["question が 121 文字", { ...base, question: "q".repeat(ASK_QUESTION_MAX + 1) }, "question"],
    ["context が 601 文字", { ...base, context: "c".repeat(ASK_CONTEXT_MAX + 1) }, "context"],
    ["案が 1 つ", { ...base, options: [opt("A")] }, "options"],
    ["案が 5 つ", { ...base, options: ["A", "B", "C", "D", "E"].map((x) => opt(x)) }, "options"],
    ["案の名前が重なる", { ...base, options: [opt("A"), opt("A")] }, "options[1].label"],
    ["説明が無い", { ...base, options: [opt("A"), { label: "B" }] }, "options[1].description"],
    [
      "recommended が真偽値でない",
      { ...base, options: [opt("A", { recommended: "yes" }), opt("B")] },
      "options[0].recommended",
    ],
    ["図の形が違う", { ...base, explain: { path: "/tmp/x.html" } }, "explain"],
  ])("%s → 断る（%s）", (_name, input, field) => {
    expect(parseAskInput(input)).toEqual({ ok: false, field: field as string });
  });

  test("context の上限ちょうど・推奨・図を通す。pid・cwd・client は形が合うときだけ", () => {
    const r = parseAskInput({
      ...base,
      context: "c".repeat(ASK_CONTEXT_MAX),
      options: [opt("A", { recommended: true, figure: { html: "<svg></svg>" } }), opt("B")],
      explain: { error: "unreadable" },
      pid: 4242,
      cwd: "/fixture/repo-a",
      client: "claude-code",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.options[0]).toEqual({
      label: "A",
      description: "A の説明",
      recommended: true,
      figure: { html: "<svg></svg>" },
    });
    expect(r.value.explain).toEqual({ error: "unreadable" });
    expect([r.value.pid, r.value.cwd, r.value.client]).toEqual([
      4242,
      "/fixture/repo-a",
      "claude-code",
    ]);
    const bad = parseAskInput({ ...base, pid: -1, cwd: "relative/dir", client: "a b" });
    expect(bad.ok && [bad.value.pid, bad.value.cwd, bad.value.client]).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });

  test("200 KB を超える図は断らずに too_large（UTF-8 のバイトで数える）", () => {
    const big = "あ".repeat(Math.ceil(ASK_FILE_MAX / 3) + 1);
    const r = parseAskInput({ ...base, explain: { html: big } });
    expect(r.ok && r.value.explain).toEqual({ error: "too_large" });
    const ok = parseAskInput({ ...base, explain: { html: "x".repeat(ASK_FILE_MAX) } });
    expect(ok.ok && "html" in (ok.value.explain ?? {})).toBe(true);
  });
});

describe("parseAskAnswer", () => {
  const labels = ["A", "B"];
  test("案だけ・メモだけ・両方", () => {
    expect(parseAskAnswer({ choice: "B" }, labels)).toEqual({ ok: true, value: { choice: "B" } });
    expect(parseAskAnswer({ note: "  why not C?  " }, labels)).toEqual({
      ok: true,
      value: { note: "why not C?" },
    });
    expect(parseAskAnswer({ choice: "A", note: "ok" }, labels)).toEqual({
      ok: true,
      value: { choice: "A", note: "ok" },
    });
  });
  test("知らない案・どちらも無い・長すぎるメモは断る", () => {
    expect(parseAskAnswer({ choice: "C" }, labels)).toEqual({ ok: false, field: "choice" });
    expect(parseAskAnswer({ note: "  " }, labels)).toEqual({ ok: false, field: "choice" });
    expect(parseAskAnswer({ note: "x".repeat(4001) }, labels)).toEqual({
      ok: false,
      field: "note",
    });
  });
});
