/** グルーピング（phase0-plan 3.3。S3 の調整を含む）の表駆動テスト */
import { describe, expect, test } from "bun:test";
import {
  type GroupPrInput,
  type GroupTurnInput,
  groupTurns,
  prRepoOf,
  prRepoRoot,
  sessionCardRepoRoot,
} from "../../src/derive/index.ts";

const isDefault = (_repo: string, branch: string | null) =>
  !branch || ["main", "master", "develop", "HEAD"].includes(branch);

function t(p: Partial<GroupTurnInput> & { turnId: string; startedAt: number }): GroupTurnInput {
  return {
    sessionId: "s1",
    tool: "claude_code",
    sessionExternalId: "S1",
    parentSessionId: null,
    repoRoot: "/r",
    branch: "feat/a",
    existingKey: null,
    ...p,
  };
}

function prIn(
  p: Partial<GroupPrInput> & { ref: string; number: number; firstSeenAt: number },
): GroupPrInput {
  return { repoRoot: "/r", headRef: null, firstTurnId: null, stateChangedAt: null, ...p };
}

describe("groupTurns", () => {
  test("ブランチごとにカード。既定ブランチと git 管理外はセッションのカード", () => {
    const r = groupTurns(
      [
        t({ turnId: "1", startedAt: 1, branch: "feat/a" }),
        t({ turnId: "2", startedAt: 2, branch: "main" }),
        t({ turnId: "3", startedAt: 3, branch: "feat/b" }),
        t({ turnId: "4", startedAt: 4, repoRoot: null, branch: null }),
      ],
      [],
      isDefault,
    );
    expect([...r.turnKeys.values()]).toEqual([
      "branch:/r#feat/a",
      "session:claude_code:S1",
      "branch:/r#feat/b",
      "session:claude_code:S1",
    ]);
    expect(r.cards.get("branch:/r#feat/a")).toMatchObject({
      kind: "branch",
      repoRoot: "/r",
      branch: "feat/a",
    });
  });

  test("cwd が消えて解決できないターンは同じセッションの直前の repo を引き継ぐ。引き継げなければ既存の割り当てを保つ", () => {
    const r = groupTurns(
      [
        t({ turnId: "1", startedAt: 1, repoRoot: "/r", branch: "feat/a" }),
        t({ turnId: "2", startedAt: 2, repoRoot: undefined, branch: "feat/a" }),
        t({
          turnId: "3",
          startedAt: 1,
          sessionId: "s2",
          sessionExternalId: "S2",
          repoRoot: undefined,
          existingKey: "branch:/old#feat/z",
        }),
        t({
          turnId: "4",
          startedAt: 1,
          sessionId: "s3",
          sessionExternalId: "S3",
          repoRoot: undefined,
        }),
      ],
      [],
      isDefault,
    );
    expect(r.turnKeys.get("2")).toBe("branch:/r#feat/a");
    expect(r.turnKeys.get("3")).toBe("branch:/old#feat/z");
    expect(r.turnKeys.get("4")).toBe("session:claude_code:S3");
  });

  test("サブエージェントのターンは親セッションのその時点のターンのカードに入る", () => {
    const r = groupTurns(
      [
        t({ turnId: "p1", startedAt: 10, branch: "feat/a" }),
        t({ turnId: "p2", startedAt: 20, branch: "feat/b" }),
        t({
          turnId: "c1",
          startedAt: 25,
          sessionId: "child",
          sessionExternalId: "C",
          parentSessionId: "s1",
          repoRoot: null,
        }),
      ],
      [],
      isDefault,
    );
    expect(r.turnKeys.get("c1")).toBe("branch:/r#feat/b");
  });

  test("PR は head ブランチのカードに付ける。カードが無ければ PR を起点に作る。head が分からなければ初出ターンのカード", () => {
    const r = groupTurns(
      [
        t({ turnId: "1", startedAt: 1, branch: "feat/a" }),
        t({ turnId: "2", startedAt: 2, branch: "main" }),
      ],
      [
        prIn({ ref: "o/r#1", number: 1, firstSeenAt: 2, headRef: "feat/a", firstTurnId: "2" }),
        prIn({ ref: "o/r#2", number: 2, firstSeenAt: 3, headRef: "feat/new" }),
        prIn({ ref: "o/r#3", number: 3, firstSeenAt: 4, headRef: null, firstTurnId: "2" }),
      ],
      isDefault,
    );
    expect(r.prKeys.get("o/r#1")).toBe("branch:/r#feat/a");
    expect(r.prKeys.get("o/r#2")).toBe("branch:/r#feat/new");
    expect(r.cards.get("branch:/r#feat/new")).toMatchObject({
      prRefs: ["o/r#2"],
      firstActivityAt: 3,
    });
    expect(r.prKeys.get("o/r#3")).toBe("session:claude_code:S1");
  });

  test("同じブランチで2本目の PR が出たら、前の PR が閉じた後のターンは #pr<n> のカード", () => {
    const r = groupTurns(
      [
        t({ turnId: "1", startedAt: 1 }),
        t({ turnId: "2", startedAt: 5 }),
        t({ turnId: "3", startedAt: 12 }),
      ],
      [
        prIn({ ref: "o/r#7", number: 7, firstSeenAt: 2, headRef: "feat/a", stateChangedAt: 10 }),
        prIn({ ref: "o/r#9", number: 9, firstSeenAt: 13, headRef: "feat/a" }),
      ],
      isDefault,
    );
    expect(r.turnKeys.get("2")).toBe("branch:/r#feat/a");
    expect(r.turnKeys.get("3")).toBe("branch:/r#feat/a#pr9");
    expect(r.prKeys.get("o/r#9")).toBe("branch:/r#feat/a#pr9");
    expect(r.cards.get("branch:/r#feat/a#pr9")).toMatchObject({ kind: "branch", branch: "feat/a" });
  });
});

describe("sessionCardRepoRoot（既定ブランチの session カードの repo_root。D-061）", () => {
  test.each([
    {
      name: "最後に解決できたターンのリポジトリ（名前を変える前の消えた cwd は undefined）",
      turns: [undefined, undefined, "/w/strategy", undefined],
      sessions: [null],
      want: "/w/strategy",
    },
    {
      name: "別のリポジトリへ移ったら後のもの",
      turns: ["/w/a", "/w/b"],
      sessions: [],
      want: "/w/b",
    },
    {
      name: "どのターンも解決できなければ、取り込み時に解決できていたセッションの repo_root",
      turns: [undefined, undefined],
      sessions: [null, "/w/old-name"],
      want: "/w/old-name",
    },
    { name: "git 管理外は null", turns: [null, null], sessions: [null], want: null },
    { name: "何も無ければ null", turns: [], sessions: [], want: null },
  ])("$name", ({ turns, sessions, want }) => {
    expect(sessionCardRepoRoot(turns, sessions)).toBe(want);
  });
});

describe("prRepoRoot（PR のカードのリポジトリは PR の属するリポジトリ）", () => {
  const remotes: Record<string, string[]> = {
    "/w/plans": [],
    "/w/site": ["example/site"],
    "/w/site-fork": ["me/site", "Example/Site"],
    "/w/other": ["example/other"],
    "/w/loose/site": [],
  };
  const of = (r: string) => remotes[r] ?? [];
  test.each([
    {
      name: "セッションのリポジトリのリモートが PR のリポジトリならそれ",
      pr: "example/other",
      session: "/w/other",
      candidates: ["/w/site"],
      want: "/w/other",
    },
    {
      name: "別のディレクトリのセッション: リモートが一致する手元のクローン（パスの順で最初、大文字小文字を区別しない）",
      pr: "example/site",
      session: "/w/plans",
      candidates: ["/w/site-fork", "/w/site", "/w/other"],
      want: "/w/site",
    },
    {
      name: "リモートが一致しなければ、リモートを持たない同じ名前のリポジトリ",
      pr: "example/site",
      session: "/w/plans",
      candidates: ["/w/loose/site", "/w/other"],
      want: "/w/loose/site",
    },
    {
      name: "リモートを持たないセッションのリポジトリでも名前が同じならそれ（今までどおり）",
      pr: "example/plans",
      session: "/w/plans",
      candidates: [],
      want: "/w/plans",
    },
    {
      name: "見つからなければ owner/repo（セッションの cwd にしない）",
      pr: "example/site",
      session: "/w/plans",
      candidates: ["/w/other"],
      want: "example/site",
    },
    {
      name: "セッションのリポジトリが無くても PR のリポジトリ",
      pr: "example/site",
      session: null,
      candidates: ["/w/site"],
      want: "/w/site",
    },
    {
      name: "PR の参照が読めなければセッションのリポジトリ",
      pr: null,
      session: "/w/plans",
      candidates: ["/w/site"],
      want: "/w/plans",
    },
  ])("$name", ({ pr, session, candidates, want }) => {
    expect(prRepoRoot(pr, session, candidates, of)).toBe(want);
  });

  test("prRepoOf", () => {
    expect(prRepoOf("example/site#8")).toBe("example/site");
    expect(prRepoOf("Example/Site.js#12")).toBe("Example/Site.js");
    expect(prRepoOf("#8")).toBeNull();
    expect(prRepoOf("no-slash#8")).toBeNull();
  });

  test("owner/repo の PR のカードは owner/repo のキー（表示の名前は repo）", () => {
    const r = groupTurns(
      [],
      [
        prIn({
          ref: "example/site#8",
          number: 8,
          firstSeenAt: 1,
          repoRoot: "example/site",
          headRef: "fix/a",
        }),
      ],
      isDefault,
    );
    expect(r.prKeys.get("example/site#8")).toBe("branch:example/site#fix/a");
    expect(r.cards.get("branch:example/site#fix/a")).toMatchObject({
      repoRoot: "example/site",
      branch: "fix/a",
    });
  });
});
