/**
 * 最後の返答（ADR 0019 の Decision 10）: 記録の末尾から AI の最後の発言を取り出す。本文はすべて合成のダミー
 * （ファイルを使うものは匿名化したフィクスチャ）
 */
import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { readTailRecords } from "../src/glance.ts";
import { claudeLastReply, codexLastReply } from "../src/last-reply.ts";

const FIX = join(import.meta.dir, "fixtures");

/** 古い順に書いて、関数には新しい順で渡す */
const newestFirst = (rs: object[]) => [...rs].reverse();

const human = (text = "(prompt)") => ({
  type: "user",
  origin: { kind: "human" },
  message: { role: "user", content: text },
});
const assistant = (id: string, content: object[], extra: object = {}) => ({
  type: "assistant",
  message: { id, role: "assistant", content },
  ...extra,
});
const txt = (text: string) => ({ type: "text", text });
const toolUse = (id: string, name = "Bash") => ({ type: "tool_use", id, name, input: {} });
const toolResult = (id: string) => ({
  type: "user",
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "(out)" }] },
});

describe("claudeLastReply", () => {
  test("完了: ツール呼び出しより後の文だけ。同じメッセージが別のレコードに分かれた text はつなぐ", () => {
    const rs = newestFirst([
      human(),
      assistant("m1", [txt("(narration A)")]),
      assistant("m1", [toolUse("tu1")]),
      toolResult("tu1"),
      assistant("m2", [{ type: "thinking", thinking: "(thinking)" }]),
      assistant("m2", [txt("(summary 1)")]),
      assistant("m2", [txt("(summary 2)")]),
      { type: "system", subtype: "turn_duration", durationMs: 1000 },
    ]);
    expect(claudeLastReply(rs)).toBe("(summary 1)\n\n(summary 2)");
  });

  test("1 つのレコードに text と tool_use が並ぶ形も、tool_use の後の文だけ", () => {
    const rs = newestFirst([
      human(),
      assistant("m1", [txt("(before)"), toolUse("tu1"), txt("(after)")]),
    ]);
    expect(claudeLastReply(rs)).toBe("(after)");
  });

  test("動作中（ツールの結果を待っている）: その前の文", () => {
    const rs = newestFirst([
      human(),
      assistant("m1", [txt("(first)")]),
      assistant("m1", [toolUse("tu1")]),
      toolResult("tu1"),
      assistant("m2", [txt("(running now)")]),
      assistant("m2", [toolUse("tu2")]),
    ]);
    expect(claudeLastReply(rs)).toBe("(running now)");
  });

  test("ターンに文がまだ無ければ null（前のターンの文は出さない）。thinking・サブエージェントは数えない", () => {
    const rs = newestFirst([
      human(),
      assistant("m1", [txt("(previous turn)")]),
      human("(next)"),
      assistant("m2", [{ type: "thinking", thinking: "(t)" }]),
      assistant("m3", [txt("(sidechain)")], { isSidechain: true }),
      assistant("m2", [toolUse("tu1")]),
    ]);
    expect(claudeLastReply(rs)).toBeNull();
    expect(claudeLastReply([])).toBeNull();
  });

  test("task-notification で始まるターンも境界", () => {
    const rs = newestFirst([
      human(),
      assistant("m1", [txt("(old)")]),
      { type: "user", origin: { kind: "task-notification" }, message: { content: "(n)" } },
      assistant("m2", [txt("(new)")]),
    ]);
    expect(claudeLastReply(rs)).toBe("(new)");
  });

  test("匿名化したフィクスチャ（問いで終わったターン）: 最後の問いの文", () => {
    const dir = join(FIX, "claude_code/2.1.x/question-end/projects/-fixture-repo-a");
    const f = readdirSync(dir).find((x) => x.endsWith(".jsonl")) as string;
    const tail = readTailRecords(join(dir, f));
    if (!tail.ok) throw new Error(tail.reason);
    expect(claudeLastReply(tail.records)).toBe("どちらの案にしますか？");
  });

  test("記録が無い: readTailRecords が missing（呼び出し元は gone にする）", () => {
    expect(readTailRecords(join(FIX, "claude_code/none.jsonl"))).toEqual({
      ok: false,
      reason: "missing",
    });
  });
});

const ev = (payload: object) => ({ type: "event_msg", payload });
const item = (type: string, extra: object = {}) =>
  ev({ type: "item_completed", turn_id: "t1", item: { type, ...extra } });
const agent = (text: string) => item("AgentMessage", { content: [{ type: "Text", text }] });

describe("codexLastReply", () => {
  test("完了: 最後のツール呼び出しより後の AgentMessage。Reasoning は数えない", () => {
    const rs = newestFirst([
      ev({ type: "task_started", turn_id: "t0" }),
      item("UserMessage"),
      agent("(previous turn)"),
      ev({ type: "task_complete", turn_id: "t0", last_agent_message: "(previous turn)" }),
      ev({ type: "task_started", turn_id: "t1" }),
      item("UserMessage"),
      agent("(narration)"),
      item("CommandExecution"),
      item("Reasoning"),
      agent("(summary 1)"),
      agent("(summary 2)"),
      ev({ type: "task_complete", turn_id: "t1", last_agent_message: "(summary 2)" }),
    ]);
    expect(codexLastReply(rs)).toBe("(summary 1)\n\n(summary 2)");
  });

  test("動作中: その時点の最新の発言（ツールの後に文が無ければ、その前の文）", () => {
    const rs = newestFirst([
      ev({ type: "task_started", turn_id: "t1" }),
      item("UserMessage"),
      agent("(looking)"),
      item("FileChange"),
      agent("(now testing)"),
      item("CommandExecution"),
    ]);
    expect(codexLastReply(rs)).toBe("(now testing)");
  });

  test("AgentMessage に文が無い形（匿名化したフィクスチャ）: task_complete の last_agent_message", () => {
    const dir = join(FIX, "codex/0.147.x/cli-git/sessions/2026/09/01");
    const f = readdirSync(dir).find((x) => x.startsWith("rollout-")) as string;
    const tail = readTailRecords(join(dir, f));
    if (!tail.ok) throw new Error(tail.reason);
    expect(codexLastReply(tail.records)).toBe("done.");
  });

  test("response_item の形（item_completed が無い版）: assistant の output_text。ツールの呼び出しで区切る", () => {
    const msg = (role: string, text: string) => ({
      type: "response_item",
      payload: {
        type: "message",
        role,
        content: [{ type: role === "user" ? "input_text" : "output_text", text }],
      },
    });
    const rs = newestFirst([
      ev({ type: "task_started", turn_id: "t1" }),
      msg("user", "(prompt)"),
      msg("assistant", "(before)"),
      { type: "response_item", payload: { type: "function_call", name: "shell" } },
      { type: "response_item", payload: { type: "function_call_output" } },
      msg("assistant", "(after)"),
    ]);
    expect(codexLastReply(rs)).toBe("(after)");
  });

  test("ターンに発言がまだ無ければ null", () => {
    const rs = newestFirst([
      ev({ type: "task_started", turn_id: "t0" }),
      agent("(old)"),
      ev({ type: "task_started", turn_id: "t1" }),
      item("UserMessage"),
      item("Reasoning"),
    ]);
    expect(codexLastReply(rs)).toBeNull();
  });
});
