import { describe, expect, test } from "bun:test";
import {
  branchSlug,
  builtinTemplates,
  claudeAccountDirName,
  claudeAccountEnv,
  composePrompt,
  countPorcelain,
  diffExcerpt,
  launchArgv,
  parseNumstat,
  parseNumstatFiles,
  summarizeChecks,
  taskAiState,
  worktreeBranch,
  worktreePathFor,
} from "../../src/launch/index.ts";

describe("依頼の型とプロンプト", () => {
  test("組み込みの4つ（ja / en）", () => {
    const ja = builtinTemplates("ja");
    expect(ja.map((t) => t.id)).toEqual([
      "builtin:implement",
      "builtin:research",
      "builtin:tests",
      "builtin:review",
    ]);
    expect(ja.filter((t) => t.readOnly).map((t) => t.id)).toEqual([
      "builtin:research",
      "builtin:review",
    ]);
    expect(builtinTemplates("en")[0]?.name).toBe("Implement");
  });

  test("題名・メモ・指示を差し込み、空のメモの行は詰める", () => {
    const body = builtinTemplates("ja")[0]?.body as string;
    expect(
      composePrompt(body, {
        title: "請求書CSVの列名を英語に",
        notes: null,
        repo: "billing",
        branch: null,
        instruction: "  テストも直して ",
      }),
    ).toBe(
      "タスク: 請求書CSVの列名を英語に\n\n終わったら変更点を3行でまとめてください。\n\nテストも直して",
    );
    expect(
      composePrompt("{title}\n{notes}\n{repo}#{branch}", {
        title: "a",
        notes: "メモ\n2行目",
        repo: "r",
        branch: "b",
        instruction: null,
      }),
    ).toBe("a\nメモ\n2行目\nr#b");
  });
});

describe("worktree", () => {
  test("ブランチ名は ASCII の slug（30字まで）と4桁", () => {
    expect(branchSlug("Fix the Day view lanes!")).toBe("fix-the-day-view-lanes");
    expect(branchSlug("請求書CSVの列名を英語に")).toBe("csv");
    expect(branchSlug("日本語だけ")).toBe("task");
    expect(branchSlug("a".repeat(40))).toHaveLength(30);
    expect(worktreeBranch("Add tests", 7)).toBe("tl/add-tests-0007");
    expect(worktreeBranch("x", 123456)).toBe("tl/x-3456");
  });

  test("置き場所の既定はリポジトリの親の <repo>-wt/<branch>（/ は -）。設定で親を変えられる", () => {
    expect(worktreePathFor("/w/turnlane", "tl/fix-0001", null)).toBe("/w/turnlane-wt/tl-fix-0001");
    expect(worktreePathFor("/w/turnlane/", "b", "/tmp/wt/")).toBe("/tmp/wt/turnlane-wt/b");
  });
});

describe("起動の引数", () => {
  test("Claude Code: --session-id と -n、読み取りのみは plan。自動承認は付けない", () => {
    const a = launchArgv({
      tool: "claude_code",
      prompt: "タスク: x",
      sessionUuid: "11111111-2222-4333-8444-555555555555",
      name: "x",
      readOnly: true,
      cwd: "/w/r",
    });
    expect(a).toEqual([
      "claude",
      "--session-id",
      "11111111-2222-4333-8444-555555555555",
      "-n",
      "x",
      "--permission-mode",
      "plan",
      "タスク: x",
    ]);
    expect(a.join(" ")).not.toContain("dangerously");
  });

  test("Codex: -C と、読み取りのみは -s read-only。先頭が - のプロンプトはオプションに読ませない", () => {
    expect(
      launchArgv({
        tool: "codex",
        prompt: "-rf",
        sessionUuid: null,
        name: "-x",
        readOnly: false,
        cwd: "/w/r",
      }),
    ).toEqual(["codex", "-C", "/w/r", " -rf"]);
    expect(
      launchArgv({
        tool: "codex",
        prompt: "p",
        sessionUuid: null,
        name: "n",
        readOnly: true,
        cwd: "/w/r",
      }),
    ).toEqual(["codex", "-C", "/w/r", "-s", "read-only", "p"]);
  });
});

describe("タスクから見た状態", () => {
  const linked = (
    status: "running" | "needs_input" | "your_turn" | "done" | "error",
    reason: string | null,
    fu: string | null = null,
  ) => taskAiState({ status: "linked", workItem: { status, reason }, openFollowUp: fu });
  test.each([
    [linked("running", "turn:open"), "running"],
    [linked("needs_input", "hook:permission"), "needs_input"],
    [linked("your_turn", "question"), "your_turn"],
    [linked("your_turn", "edits"), "done_check"],
    [linked("your_turn", "pr_open"), "done_check"],
    [linked("done", "ended"), "done_check"],
    [linked("error", "hook:stop_failure"), "error"],
    // 利用枠の上限待ちはエラーにしない。明けた後の再開は自分の番、エラーの状態（1 時間）の後の再開待ちはエラーのまま
    [linked("done", "rate_limit"), "limit"],
    [linked("your_turn", "resume_limit", "resume_error"), "your_turn"],
    [linked("your_turn", "resume_error", "resume_error"), "error"],
    [linked("running", null, "approve"), "needs_input"],
    [taskAiState({ status: "started", workItem: null, openFollowUp: null }), "starting"],
    [taskAiState({ status: "linked", workItem: null, openFollowUp: null }), "starting"],
    [taskAiState({ status: "unlinked", workItem: null, openFollowUp: null }), "unlinked"],
    [taskAiState({ status: "failed", workItem: null, openFollowUp: null }), "failed"],
  ])("%s → %s", (got, want) => expect(got).toBe(want as typeof got));
});

describe("確認支援", () => {
  test("numstat のファイルごと（バイナリは null、リネームは新しい側）", () => {
    expect(
      parseNumstatFiles("10\t2\tapps/a.ts\n-\t-\tdocs/x.png\n0\t0\t{old => apps}/c.ts\n"),
    ).toEqual([
      { path: "apps/a.ts", additions: 10, deletions: 2 },
      { path: "docs/x.png", additions: null, deletions: null },
      { path: "apps/c.ts", additions: 0, deletions: 0 },
    ]);
  });

  test("差分の抜粋: ファイルごとと全体の上限で行の途中では切らない。バイナリの塊は入れない", () => {
    const file = (name: string, n: number) =>
      `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -1 +1,${n} @@\n${Array.from(
        { length: n },
        (_, i) => `+line ${i}`,
      ).join("\n")}\n`;
    const bin = "diff --git a/x.png b/x.png\nBinary files a/x.png and b/x.png differ\n";
    const raw = file("a.ts", 3) + bin + file("b.ts", 200);
    const r = diffExcerpt(raw, { maxBytes: 400, perFile: 200 });
    expect(r.truncated).toBe(true);
    expect(r.excerpt).toContain("+line 2");
    expect(r.excerpt).not.toContain("Binary files");
    expect(r.excerpt).toContain("diff --git a/b.ts b/b.ts");
    expect(new TextEncoder().encode(r.excerpt).length).toBeLessThanOrEqual(400);
    expect(r.excerpt.endsWith("\n")).toBe(true);
    expect(diffExcerpt(file("a.ts", 2), { maxBytes: 4000, perFile: 4000 })).toEqual({
      excerpt: file("a.ts", 2),
      truncated: false,
    });
  });

  test("numstat を数え、ディレクトリごとにまとめる", () => {
    const r = parseNumstat(
      "10\t2\tapps/web/a.ts\n3\t0\tapps/web/b.ts\n-\t-\tdocs/x.png\n1\t1\tREADME.md\n0\t0\t{old => apps}/c.ts\n",
    );
    expect(r).toEqual({
      files: 5,
      additions: 14,
      deletions: 3,
      dirs: [
        { dir: "apps", files: 3 },
        { dir: ".", files: 1 },
        { dir: "docs", files: 1 },
      ],
    });
    expect(countPorcelain(" M a\n?? b\n\n")).toBe(2);
  });

  test("CI: 失敗 > 実行中 > 成功、無ければ none", () => {
    expect(summarizeChecks([])).toEqual({ state: "none", total: 0, failing: [] });
    expect(
      summarizeChecks([
        { name: "test", status: "COMPLETED", conclusion: "SUCCESS" },
        { context: "lint", state: "SUCCESS" },
        { name: "skip", status: "COMPLETED", conclusion: "SKIPPED" },
      ]),
    ).toEqual({ state: "pass", total: 3, failing: [] });
    expect(
      summarizeChecks([
        { name: "test", status: "IN_PROGRESS", conclusion: "" },
        { name: "e2e", status: "COMPLETED", conclusion: "FAILURE" },
      ]),
    ).toEqual({ state: "fail", total: 2, failing: ["e2e"] });
    expect(summarizeChecks([{ name: "test", status: "QUEUED" }]).state).toBe("pending");
  });
});

describe("Claude のアカウント（D-122）", () => {
  test("名前はディレクトリ名から。~/.claude は null（既定）", () => {
    expect(claudeAccountDirName("/h/.claude", "/h")).toBeNull();
    expect(claudeAccountDirName("/h/.claude/", "/h/")).toBeNull();
    expect(claudeAccountDirName("/h/.claude-acme", "/h")).toBe("acme");
    expect(claudeAccountDirName("/opt/cfg/team-a", "/h")).toBe("team-a");
    // ホーム以外の .claude はディレクトリ名のまま
    expect(claudeAccountDirName("/other/.claude", "/h")).toBe(".claude");
  });

  test("~/.claude 以外は CLAUDE_CONFIG_DIR を付ける。~/.claude は選べたときだけ消す", () => {
    expect(claudeAccountEnv("/h/.claude-acme", "/h", 2)).toEqual({
      set: { CLAUDE_CONFIG_DIR: "/h/.claude-acme" },
      unset: [],
    });
    expect(claudeAccountEnv("/h/.claude-acme", "/h", 1)).toEqual({
      set: { CLAUDE_CONFIG_DIR: "/h/.claude-acme" },
      unset: [],
    });
    expect(claudeAccountEnv("/h/.claude", "/h", 2)).toEqual({
      set: {},
      unset: ["CLAUDE_CONFIG_DIR"],
    });
    expect(claudeAccountEnv("/h/.claude", "/h", 1)).toEqual({ set: {}, unset: [] });
    expect(claudeAccountEnv(null, "/h", 0)).toEqual({ set: {}, unset: [] });
  });
});
