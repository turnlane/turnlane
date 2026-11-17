import { describe, expect, test } from "bun:test";
import {
  HOOK_WAIT_STALE_MS,
  HOOK_WAIT_UNSEEN_MS,
  hookWaitWithdrawal,
  matchHookWait,
  parseAskChoices,
} from "../src/hook-wait.ts";
import {
  CLAUDE_ANSWER_TIMEOUT_S,
  claudePlan,
  codexPlan,
  install,
  shapeOutdated,
  status,
  uninstall,
} from "../src/hooks/index.ts";

const S = "sess-1";

describe("matchHookWait（カードの待ちと hook の対応。ADR 0023）", () => {
  const e = (session: string, tool: string, agentId: string | null = null) => ({
    session,
    tool,
    agentId,
  });
  test.each([
    ["許可: 同じセッション・同じツールが 1 つ", [e(S, "Bash")], "permission", "Bash", 0],
    [
      "許可: ツールの名前が分からなければセッションの許可 1 つ",
      [e(S, "Write")],
      "permission",
      null,
      0,
    ],
    ["許可: 違うツールは対応させない", [e(S, "Write")], "permission", "Bash", null],
    [
      "許可: AskUserQuestion の hook は許可にしない",
      [e(S, "AskUserQuestion")],
      "permission",
      null,
      null,
    ],
    ["問い: AskUserQuestion の hook", [e(S, "Bash"), e(S, "AskUserQuestion")], "ask", null, 1],
    ["別のセッションは対応させない", [e("other", "Bash")], "permission", "Bash", null],
    [
      "並んだサブエージェントの同じツールが 2 つ: 決まらないので null（hook では送らない）",
      [e(S, "Bash", "a"), e(S, "Bash", "b")],
      "permission",
      "Bash",
      null,
    ],
    [
      "サブエージェントでもツールの名前で 1 つに決まれば対応させる",
      [e(S, "Bash", "a"), e(S, "Write", "b")],
      "permission",
      "Write",
      1,
    ],
  ] as const)("%s", (_n, entries, kind, tool, want) => {
    const r = matchHookWait(entries, { session: S, kind, tool });
    expect(r).toBe(want === null ? null : (entries[want] ?? null));
  });
});

describe("hookWaitWithdrawal（取り下げ。偽の時計）", () => {
  const T = 1_000_000;
  const base = { agentId: null, openedAt: T, lastPollAt: T, seen: false };
  test.each([
    ["何も無ければ続ける", base, { now: T + 5_000, open: false, later: [] }, null],
    ["聞かれなくなった", base, { now: T + HOOK_WAIT_STALE_MS + 1, open: true, later: [] }, "gone"],
    [
      "SessionEnd",
      { ...base, agentId: "sub" },
      { now: T + 1, open: true, later: [{ name: "SessionEnd", agentId: null, at: T + 1 }] },
      "session_end",
    ],
    [
      "本体の待ち: その後の Stop",
      base,
      { now: T + 1, open: true, later: [{ name: "Stop", agentId: null, at: T + 1 }] },
      "turn_moved",
    ],
    [
      "本体の待ち: その後の UserPromptSubmit",
      base,
      { now: T + 1, open: true, later: [{ name: "UserPromptSubmit", agentId: null, at: T + 1 }] },
      "turn_moved",
    ],
    [
      "待ちを開く前の Stop は見ない",
      base,
      { now: T + 1, open: true, later: [{ name: "Stop", agentId: null, at: T - 1 }] },
      null,
    ],
    [
      "サブエージェントの待ちは本体の Stop では取り下げない",
      { ...base, agentId: "sub" },
      { now: T + 1, open: true, later: [{ name: "Stop", agentId: null, at: T + 1 }] },
      null,
    ],
    ["見えた後に閉じた", { ...base, seen: true }, { now: T + 1, open: false, later: [] }, "closed"],
    [
      "まだ見えない（取り込みの遅れ）間は続ける",
      base,
      { now: T + HOOK_WAIT_UNSEEN_MS - 1, open: false, later: [] },
      null,
    ],
    [
      "一度も見えないまま",
      base,
      { now: T + HOOK_WAIT_UNSEEN_MS + 1, open: false, later: [] },
      "unseen",
    ],
  ] as const)("%s", (_n, e, f, want) => {
    expect(hookWaitWithdrawal(e, f)).toBe(want);
  });
});

describe("parseAskChoices（AskUserQuestion の答えの検証）", () => {
  const single = { multiSelect: false, options: 2 };
  const multi = { multiSelect: true, options: 3 };
  test("単一選択は 1 つ、複数選択は 1 つ以上（並べ替える）、自由な文は 1 行に畳む", () => {
    expect(
      parseAskChoices(
        [single, multi, single],
        [{ options: [1] }, { options: [2, 0] }, { text: " a\nb\u001b " }],
      ),
    ).toEqual([{ options: [1] }, { options: [0, 2] }, { text: "a b" }]);
  });
  test.each([
    ["問いの数が違う", [single], []],
    ["単一選択に 2 つ", [single], [{ options: [0, 1] }]],
    ["範囲外", [single], [{ options: [2] }]],
    ["負の番号", [single], [{ options: [-1] }]],
    ["小数", [single], [{ options: [0.5] }]],
    ["重なり", [multi], [{ options: [1, 1] }]],
    ["空の選択", [multi], [{ options: [] }]],
    ["空の文", [single], [{ text: "  \n " }]],
    ["キーが 2 つ", [single], [{ options: [0], text: "x" }]],
    ["配列でない", [single], { options: [0] }],
  ] as const)("だめ: %s", (_n, qs, input) => {
    expect(parseAskChoices(qs, input)).toBeNull();
  });
});

describe("hooks のインストール: PermissionRequest に hook で答えるハンドラ（ADR 0023）", () => {
  const CLI = "/Users/someone/.local/bin/turnlane";
  test("Claude Code の PermissionRequest は spool（async）と答える（同期・長い timeout）の 2 つ。冪等。uninstall で両方消える", () => {
    const { next, report } = install({}, claudePlan(CLI));
    expect(report.added).toContain("PermissionRequest");
    const pr = (next.hooks as Record<string, { hooks: unknown[] }[]>).PermissionRequest;
    expect(pr).toEqual([
      {
        hooks: [
          {
            type: "command",
            command: `'${CLI}' hook --tool claude_code --managed-by turnlane`,
            timeout: 5,
            async: true,
          },
          {
            type: "command",
            command: `'${CLI}' hook --tool claude_code --answer --managed-by turnlane`,
            timeout: CLAUDE_ANSWER_TIMEOUT_S,
          },
        ],
      },
    ]);
    // ほかのイベントは 1 つのまま
    const stop = (next.hooks as Record<string, { hooks: unknown[] }[]>).Stop;
    expect(stop?.[0]?.hooks).toHaveLength(1);
    const again = install(next, claudePlan(CLI));
    expect(again.report.added).toEqual([]);
    expect(again.report.updated).toEqual([]);
    expect(status(next, claudePlan(CLI)).state).toBe("installed");
    const un = uninstall(next);
    expect(un.next.hooks).toBeUndefined();
    expect(un.removed).toContain("PermissionRequest");
  });

  test("前の版の hooks（答えるハンドラが無い）: status は outdated、shapeOutdated は場所によらず PermissionRequest。入れ直すと揃う", () => {
    const old = {
      hooks: Object.fromEntries(
        claudePlan(CLI).events.map((ev) => [
          ev,
          [
            {
              hooks: [
                {
                  type: "command",
                  command: `'${CLI}' hook --tool claude_code --managed-by turnlane`,
                  timeout: 5,
                  async: true,
                },
              ],
            },
          ],
        ]),
      ),
    };
    expect(status(old, claudePlan(CLI))).toMatchObject({
      state: "outdated",
      outdated: ["PermissionRequest"],
    });
    // デーモンは場所の分からない名前（turnlane）で比べる
    expect(shapeOutdated(old, claudePlan("turnlane"))).toEqual(["PermissionRequest"]);
    const { next, report } = install(old, claudePlan(CLI));
    expect(report.updated).toEqual(["PermissionRequest"]);
    expect(shapeOutdated(next, claudePlan("turnlane"))).toEqual([]);
    // 引用符を含む場所でも形で比べる
    const q = "/Users/o'neil/bin/turnlane";
    expect(shapeOutdated(install({}, claudePlan(q)).next, claudePlan("turnlane"))).toEqual([]);
  });

  test("Codex は変えない（答えるハンドラは入れない）", () => {
    const { next } = install({}, codexPlan(CLI));
    const pr = (next.hooks as Record<string, { hooks: unknown[] }[]>).PermissionRequest;
    expect(pr?.[0]?.hooks).toHaveLength(1);
    expect(JSON.stringify(next)).not.toContain("--answer");
  });
});
