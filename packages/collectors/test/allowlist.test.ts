import { describe, expect, test } from "bun:test";
import { pickAllowed } from "../src/allowlist.ts";

const SENTINEL = "SENTINEL_BODY_allowlist";

describe("pickAllowed（ADR 0005）", () => {
  test("宣言したキーだけを残す（入れ子・配列）", () => {
    const rec = {
      type: "assistant",
      timestamp: "t",
      message: {
        model: "m",
        usage: { input_tokens: 1, output_tokens: 2, other: 3 },
        content: [
          { type: "text", text: SENTINEL },
          { type: "tool_use", id: "x", name: "Edit", input: { file_path: SENTINEL } },
        ],
      },
      extra: SENTINEL,
    };
    const out = pickAllowed(rec, [
      "type",
      "timestamp",
      "message.model",
      "message.usage.input_tokens",
      "message.content[].type",
      "message.content[].name",
    ]);
    expect(out).toEqual({
      type: "assistant",
      timestamp: "t",
      message: {
        model: "m",
        usage: { input_tokens: 1 },
        content: [{ type: "text" }, { type: "tool_use", name: "Edit" }],
      },
    });
    expect(JSON.stringify(out)).not.toContain(SENTINEL);
  });

  test("葉の位置にオブジェクトや配列があれば落とす（本文を入れ物ごと持ち出せない）", () => {
    const out = pickAllowed({ message: { content: [{ text: SENTINEL }] }, cwd: { x: SENTINEL } }, [
      "message.content",
      "cwd",
    ]);
    expect(out).toEqual({});
  });

  test("同じパスを葉と枝の両方に書ける（文字列なら葉、オブジェクトなら枝）", () => {
    const keys = ["payload.source", "payload.source.subagent.other"];
    expect(pickAllowed({ payload: { source: "cli" } }, keys)).toEqual({
      payload: { source: "cli" },
    });
    expect(
      pickAllowed({ payload: { source: { subagent: { other: "guardian", x: SENTINEL } } } }, keys),
    ).toEqual({ payload: { source: { subagent: { other: "guardian" } } } });
  });

  test("配列でない値に [] のキー、プロトタイプのキーは無視する", () => {
    expect(pickAllowed({ a: "x" }, ["a[].b"])).toEqual({});
    expect(pickAllowed(Object.create({ inherited: 1 }), ["inherited"])).toEqual({});
    expect(pickAllowed(null, ["a"])).toEqual({});
    expect(pickAllowed("s", ["a"])).toEqual({});
  });

  test("null と真偽値・数値は葉として残す", () => {
    expect(pickAllowed({ a: null, b: false, c: 0 }, ["a", "b", "c"])).toEqual({
      a: null,
      b: false,
      c: 0,
    });
  });
});
