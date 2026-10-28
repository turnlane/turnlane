/**
 * 次の指示を送ってよいか（ADR 0019 の Decision 11）: 記録の末尾がターンの終わりか、と最後の人の指示の目印。合成のダミー
 */
import { describe, expect, test } from "bun:test";
import { claudeLastReply, claudeTurnEnd, codexTurnEnd, lastPromptMark } from "../src/last-reply.ts";

const newestFirst = (rs: object[]) => [...rs].reverse();
const human = (uuid: string) => ({
  type: "user",
  uuid,
  origin: { kind: "human" },
  message: { content: "(prompt)" },
});
const assistant = (stop: string | null, content: object[] = [{ type: "text", text: "(t)" }]) => ({
  type: "assistant",
  message: { stop_reason: stop, content },
});
const toolResult = {
  type: "user",
  message: { content: [{ type: "tool_result", tool_use_id: "x" }] },
};
const turnDuration = { type: "system", subtype: "turn_duration", durationMs: 1 };

describe("claudeTurnEnd", () => {
  test.each([
    ["end_turn の後に turn_duration", [human("u1"), assistant("end_turn"), turnDuration], "ended"],
    ["end_turn だけ（turn_duration の前）", [human("u1"), assistant("end_turn")], "ended"],
    [
      "turn_duration の後のほかの system・ファイルの履歴は飛ばす",
      [
        human("u1"),
        assistant(null),
        turnDuration,
        { type: "system", subtype: "stop_hook_summary" },
        { type: "file-history-snapshot" },
      ],
      "ended",
    ],
    [
      "API エラーで終わった",
      [human("u1"), { type: "assistant", isApiErrorMessage: true, message: {} }],
      "ended",
    ],
    [
      "中断の印",
      [
        human("u1"),
        assistant("tool_use"),
        {
          type: "user",
          message: { content: [{ type: "text", text: "[Request interrupted by user]" }] },
        },
      ],
      "ended",
    ],
    [
      "ツールの呼び出しの途中（結果待ち）",
      [human("u1"), assistant("tool_use", [{ type: "tool_use", id: "x" }])],
      "running",
    ],
    ["ツールの結果の後（AI の番）", [human("u1"), assistant("tool_use"), toolResult], "running"],
    ["人の指示の直後", [human("u1"), assistant("end_turn"), turnDuration, human("u2")], "running"],
    [
      "サブエージェントの終わりは数えない",
      [human("u1"), assistant("tool_use"), { ...assistant("end_turn"), isSidechain: true }],
      "running",
    ],
    ["何も無い", [], "unknown"],
  ] as const)("%s", (_name, rs, want) => {
    expect(claudeTurnEnd(newestFirst([...rs]))).toBe(want);
  });
});

const ev = (payload: object) => ({ type: "event_msg", payload });

describe("codexTurnEnd", () => {
  test.each([
    [
      "task_complete の後の token の記録は飛ばす",
      [
        ev({ type: "task_started" }),
        ev({ type: "task_complete" }),
        { type: "token_usage_record" },
        ev({ type: "token_count" }),
      ],
      "ended",
    ],
    ["turn_aborted", [ev({ type: "task_started" }), ev({ type: "turn_aborted" })], "ended"],
    [
      "動作中（ツールの item）",
      [
        ev({ type: "task_started" }),
        ev({ type: "item_completed", item: { type: "CommandExecution" } }),
      ],
      "running",
    ],
    [
      "新しいターンが始まった",
      [ev({ type: "task_complete" }), ev({ type: "task_started" })],
      "running",
    ],
    ["何も無い", [{ type: "session_meta" }], "unknown"],
  ] as const)("%s", (_name, rs, want) => {
    expect(codexTurnEnd(newestFirst([...rs]))).toBe(want);
  });
});

describe("lastPromptMark", () => {
  test("Claude Code: 最後の人の指示の uuid（ツールの結果・メタは飛ばす）。Codex: 最後の task_started の turn_id", () => {
    expect(
      lastPromptMark(
        "claude_code",
        newestFirst([human("u1"), assistant("end_turn"), human("u2"), toolResult]),
      ),
    ).toBe("u2");
    expect(lastPromptMark("claude_code", [])).toBeNull();
    expect(
      lastPromptMark(
        "codex",
        newestFirst([
          ev({ type: "task_started", turn_id: "t1" }),
          ev({ type: "task_complete" }),
          ev({ type: "task_started", turn_id: "t2" }),
        ]),
      ),
    ).toBe("t2");
  });
});

describe("自動圧縮の要約（isCompactSummary）は指示ではない", () => {
  /** 実機で見た末尾の形（古い順）。本文はダミー */
  const compacted = [
    human("u1"),
    {
      type: "assistant",
      uuid: "a1",
      message: { stop_reason: null, content: [{ type: "text", text: "(final reply)" }] },
    },
    turnDuration,
    { type: "system", subtype: "away_summary" },
    { type: "system", subtype: "compact_boundary", compactMetadata: {}, logicalParentUuid: "a1" },
    {
      type: "user",
      uuid: "cs1",
      promptId: "p-cs1",
      isCompactSummary: true,
      isVisibleInTranscriptOnly: true,
      message: { role: "user", content: "(compact summary)" },
    },
    ...Array.from({ length: 12 }, () => ({ type: "attachment", attachment: { type: "x" } })),
    { type: "system", subtype: "informational" },
    ...["frame-link", "atis-latch", "permission-mode", "mode", "ai-title", "last-prompt"].map(
      (type) => ({ type }),
    ),
  ];

  test("圧縮の後に何も続いていなければターンの終わり（ended）", () => {
    expect(claudeTurnEnd(newestFirst(compacted))).toBe("ended");
  });

  test("圧縮の直後に AI が続いていれば running のまま", () => {
    expect(
      claudeTurnEnd(
        newestFirst([...compacted, assistant("tool_use", [{ type: "tool_use", id: "x" }])]),
      ),
    ).toBe("running");
    expect(claudeTurnEnd(newestFirst([...compacted, human("u2")]))).toBe("running");
  });

  test("origin の無い文字列の user（指示ではない）も読み飛ばす", () => {
    expect(
      claudeTurnEnd(
        newestFirst([
          human("u1"),
          assistant("end_turn"),
          { type: "user", message: { content: "(note)" } },
        ]),
      ),
    ).toBe("ended");
  });

  test("lastPromptMark は圧縮の要約の uuid・promptId を返さない", () => {
    expect(lastPromptMark("claude_code", newestFirst(compacted))).toBe("u1");
  });

  test("claudeLastReply は圧縮の後も最後の返答を返す", () => {
    expect(claudeLastReply(newestFirst(compacted))).toBe("(final reply)");
  });
});
