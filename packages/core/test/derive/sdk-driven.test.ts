/**
 * プログラム経由のセッション（Claude Code の entrypoint が `sdk-*`）: 問い・編集・Stop の終わりを自分の番にせず、返答・確認・
 * 許可のタスクを作らない（そのプログラムの仕事）。PR の確認（pr_open / review_pr）は人の作業なので今までどおり
 */
import { describe, expect, test } from "bun:test";
import { deriveStatus, desiredFollowUps, isProgramSession } from "../../src/derive/index.ts";
import { aiEnd, at, facts, hook, pr, SETTINGS, session, TIMING, turn } from "./helpers.ts";

const ON = {
  ...SETTINGS,
  followUpKinds: {
    ...SETTINGS.followUpKinds,
    reply: true,
    check_changes: true,
    approve: true,
    review_pr: true,
  },
};
const sess = (entrypoint: string | null, lastActivityAt = at("10:00")) =>
  session({ entrypoint, lastActivityAt });
const derive = (f: ReturnType<typeof facts>, now: number) => {
  const st = deriveStatus(f, now, ON, TIMING);
  return {
    st,
    kinds: desiredFollowUps(f, st, now, ON, TIMING)
      .map((x) => x.kind)
      .sort(),
  };
};

describe("プログラム経由の判定", () => {
  test("entrypoint が sdk- で始まるものだけ", () => {
    expect(isProgramSession({ entrypoint: "sdk-cli" })).toBe(true);
    expect(isProgramSession({ entrypoint: "sdk-ts" })).toBe(true);
    expect(isProgramSession({ entrypoint: "sdk-py" })).toBe(true);
    expect(isProgramSession({ entrypoint: "cli" })).toBe(false);
    expect(isProgramSession({ entrypoint: "claude-desktop" })).toBe(false);
    expect(isProgramSession({ entrypoint: null })).toBe(false);
    expect(isProgramSession({})).toBe(false);
  });
});

describe("自分の番とタスク", () => {
  const question = (ep: string | null) =>
    facts({ turns: [aiEnd(at("10:00"), { endedWith: "question" })], sessions: [sess(ep)] });
  const edits = (ep: string | null) =>
    facts({ turns: [aiEnd(at("10:00"), { editedFiles: 2 })], sessions: [sess(ep)] });
  const stopped = (ep: string | null) =>
    facts({
      turns: [turn({ start: at("09:58"), end: null })],
      sessions: [sess(ep, at("09:59"))],
      hooks: [hook("UserPromptSubmit", at("09:58")), hook("Stop", at("10:00"))],
    });

  test("sdk-cli: 問い・編集・Stop の終わりは done、返答・確認のタスクを作らない", () => {
    for (const f of [question("sdk-cli"), edits("sdk-cli"), stopped("sdk-cli")]) {
      const r = derive(f, at("10:30"));
      expect(r.st.status).toBe("done");
      expect(r.kinds).toEqual([]);
    }
  });

  test("cli・claude-desktop・不明は今までどおり（問い → 返答、編集 → 確認、Stop → 返答）", () => {
    for (const ep of ["cli", "claude-desktop", null]) {
      expect(derive(question(ep), at("10:30"))).toMatchObject({
        st: { status: "your_turn", reason: "question" },
        kinds: ["reply"],
      });
      expect(derive(edits(ep), at("10:30"))).toMatchObject({
        st: { status: "your_turn", reason: "edits" },
        kinds: ["check_changes"],
      });
      expect(derive(stopped(ep), at("10:30")).st).toMatchObject({
        status: "your_turn",
        reason: "hook:stop",
      });
    }
  });

  test("sdk-cli でも open な PR は pr_open のまま、review_pr は作る", () => {
    const f = facts({
      turns: [aiEnd(at("10:00"), { endedWith: "question", editedFiles: 1 })],
      sessions: [sess("sdk-cli")],
      prs: [pr({ firstSeenAt: at("09:59") })],
    });
    expect(derive(f, at("10:30"))).toMatchObject({
      st: { status: "your_turn", reason: "pr_open" },
      kinds: ["review_pr"],
    });
  });

  test("sdk-cli の許可待ち: 状態は needs_input のまま、approve は作らない（cli は作る）", () => {
    const perm = (ep: string) =>
      facts({
        turns: [turn({ start: at("10:00"), end: null })],
        sessions: [sess(ep, at("10:01"))],
        hooks: [hook("UserPromptSubmit", at("10:00")), hook("PermissionRequest", at("10:01"))],
      });
    expect(derive(perm("sdk-cli"), at("10:30"))).toMatchObject({
      st: { status: "needs_input" },
      kinds: [],
    });
    expect(derive(perm("cli"), at("10:30"))).toMatchObject({
      st: { status: "needs_input" },
      kinds: ["approve"],
    });
  });
});
