/**
 * 問い返し（Issue #3）: この項目の流れの「問い返し: …」と、自分の番に戻す（`u`・ホバー・右クリック）を置く行
 */
import { describe, expect, test } from "bun:test";
import type { WorkItemDetail } from "@turnlane/core/web";
import { en } from "../src/i18n/en.ts";
import { ja } from "../src/i18n/ja.ts";
import { findConflicts, KEYMAP, keysOf } from "../src/keys/keymap.ts";
import { canBackToTurn, itemFlow } from "../src/panel/flow.ts";

const M = 60_000;
const at = (h: number, m = 0) => (h * 60 + m) * M;

const turn = (s: number, e: number, p: { instruction?: string; askedBack?: true } = {}) => ({
  turnId: `t${s}`,
  start: s,
  end: e,
  open: false,
  toolCalls: 1,
  editedFiles: 0,
  inputTokens: null,
  outputTokens: null,
  endedWith: null,
  tool: "claude_code",
  ...p,
});

const src = (turns: ReturnType<typeof turn>[]) =>
  ({
    workItem: { status: "your_turn" },
    turns,
    waits: [],
    artifacts: [],
  }) as unknown as Pick<WorkItemDetail, "turns" | "waits" | "artifacts"> & {
    workItem: Pick<WorkItemDetail["workItem"], "status">;
  };

describe("この項目の流れの問い返し", () => {
  test("問い返した稼働に印。ほかの稼働は今までどおり「頼んだ」", () => {
    const f = itemFlow(
      src([
        turn(at(9), at(9, 5), { instruction: "書き出しの機能を足して" }),
        turn(at(9, 25), at(9, 28), { instruction: "違いを教えて", askedBack: true }),
      ]),
      at(10),
    );
    expect(f.rows.map((r) => [r.asked, r.askedBack ?? false])).toEqual([
      ["書き出しの機能を足して", false],
      ["違いを教えて", true],
    ]);
  });
  test("指示を保存していない稼働には印を付けない", () => {
    const f = itemFlow(src([turn(at(9), at(9, 5), { askedBack: true })]), at(10));
    expect(f.rows[0]?.askedBack).toBeUndefined();
  });
  test("言葉は日英どちらにもある", () => {
    expect(ja["flow.askedBack"]).toBe("問い返し: {text}");
    expect(en["flow.askedBack"]).toBe("Asked back: {text}");
  });
});

describe("自分の番に戻す", () => {
  test("閉じた行・期限切れ・問い返した稼働に置く。開いている自分の番があれば置かない", () => {
    expect(canBackToTurn({ kind: "closed" }, false)).toBe(true);
    expect(canBackToTurn({ kind: "expired" }, false)).toBe(true);
    expect(canBackToTurn({ kind: "run", askedBack: true }, false)).toBe(true);
    expect(canBackToTurn({ kind: "run" }, false)).toBe(false);
    expect(canBackToTurn({ kind: "idle" }, false)).toBe(false);
    expect(canBackToTurn({ kind: "closed" }, true)).toBe(false);
  });
  test("キーは u。既定の割り当てで衝突しない", () => {
    expect(KEYMAP.find((k) => k.id === "backToTurn")?.scope).toBe("list");
    expect(keysOf("backToTurn")).toEqual(["u"]);
    expect(findConflicts({})).toEqual([]);
    expect(ja["keys.backToTurn"]).toBeTruthy();
    expect(en["keys.backToTurn"]).toBeTruthy();
  });
});
