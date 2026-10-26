import { describe, expect, test } from "bun:test";
import { cardTitle, type TitleInput, type TitleSource } from "../src/derive/titles.ts";

describe("カードの題名（ai-session-ingestion 4.4、D-066 (3)）", () => {
  const base: TitleInput = {
    kind: "branch",
    branch: "feat/add-login",
    repoRoot: "/w/app",
    prTitles: ["Add login form"],
    sessionTitles: [{ title: "Fix the login validation", source: null }],
  };
  const codex = [{ title: "Plan Q4", source: "thread_name" }];
  const cases: [string, Partial<TitleInput>, string, TitleSource][] = [
    [
      "branch・またがらない: 要約が PR より先",
      { exclusive: true },
      "Fix the login validation",
      "ai_title",
    ],
    ["branch・またがる: PR", { exclusive: false }, "Add login form", "pr"],
    [
      "branch・またがる・PR なし: ブランチ名",
      { exclusive: false, prTitles: [] },
      "add login",
      "branch",
    ],
    [
      "branch・またがらない・要約なし: PR",
      { exclusive: true, sessionTitles: [] },
      "Add login form",
      "pr",
    ],
    [
      "session・またがらない: Codex の thread_name",
      { kind: "session", branch: "main", exclusive: true, sessionTitles: codex },
      "Plan Q4",
      "thread_name",
    ],
    [
      "session・またがる: PR → 要約",
      { kind: "session", branch: "main", exclusive: false },
      "Add login form",
      "pr",
    ],
  ];
  for (const [name, p, title, source] of cases) {
    test(name, () => expect(cardTitle({ ...base, ...p })).toEqual({ title, source }));
  }
});

describe("カードの題名: 空同然のツール生成の題名は次の候補に落ちる", () => {
  const junk = (title: string) => [{ title, source: null }];
  const cases: [string, TitleInput, string | null, TitleSource | null][] = [
    [
      "branch・またがらない・相づちだけ: PR",
      {
        kind: "branch",
        branch: "feat/add-login",
        repoRoot: "/w/app",
        prTitles: ["Add login form"],
        sessionTitles: junk("OK"),
        exclusive: true,
      },
      "Add login form",
      "pr",
    ],
    [
      "branch・またがらない・貼り付けの印・PR なし: ブランチ名",
      {
        kind: "branch",
        branch: "feat/add-login",
        repoRoot: "/w/app",
        prTitles: [],
        sessionTitles: junk('<pasted_content id="c7b5">'),
        exclusive: true,
      },
      "add login",
      "branch",
    ],
    [
      "session・既定ブランチ・相づちだけ: リポジトリ名（既定ブランチは使わない）",
      {
        kind: "session",
        branch: "main",
        repoRoot: "/w/app",
        prTitles: [],
        sessionTitles: junk("はい"),
        exclusive: true,
      },
      "app",
      "repo",
    ],
    [
      "session・既定でないブランチ・記号だけ: ブランチ名",
      {
        kind: "session",
        branch: "fix/date-picker",
        repoRoot: "/w/app",
        prTitles: [],
        sessionTitles: junk("..."),
        exclusive: false,
      },
      "date picker",
      "branch",
    ],
    [
      "保存済みの相づち＋本文: 相づちをはがした題名",
      {
        kind: "session",
        branch: "main",
        repoRoot: "/w/app",
        prTitles: [],
        sessionTitles: junk("OK。コミットしておいて"),
        exclusive: true,
      },
      "コミットしておいて",
      "ai_title",
    ],
    [
      "候補が何も無い",
      {
        kind: "session",
        branch: null,
        repoRoot: null,
        prTitles: [],
        sessionTitles: junk("OK"),
        exclusive: true,
      },
      null,
      null,
    ],
  ];
  for (const [name, input, title, source] of cases) {
    test(name, () => expect(cardTitle(input)).toEqual({ title, source }));
  }
});
