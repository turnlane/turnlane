import { describe, expect, test } from "bun:test";
import { matchesAll, matchRanges, matchScore, searchTokens } from "../../src/search/match.ts";

describe("searchTokens / matchesAll", () => {
  test.each([
    ["pr 142", "Day lane DnD turnlane feat/day-view PR #142 #142", true],
    ["#142", "PR #142", true],
    ["PR   #142", "pr #142", true],
    ["day 143", "Day lane PR #142", false],
    ["認証", "認証トークン更新", true],
    ["", "anything", true],
  ])("%p in %p → %p", (q, h, want) => {
    expect(matchesAll(h, searchTokens(q))).toBe(want);
  });

  test("先頭の # を外し、空の語は捨てる", () => {
    expect(searchTokens("  #142  ## Auth ")).toEqual(["142", "auth"]);
  });
});

describe("matchScore", () => {
  test("先頭 > 語の頭 > 途中、一致しなければ -1", () => {
    const t = searchTokens("in");
    const head = matchScore("Inbox", t);
    const word = matchScore("Go to inbox", t);
    const mid = matchScore("Plan the day ... going", searchTokens("oin"));
    expect(head).toBeGreaterThan(word);
    expect(word).toBeGreaterThan(mid);
    expect(matchScore("Week", t)).toBe(-1);
  });
});

describe("matchRanges", () => {
  test("重なる範囲はまとめ、複数の出現を拾う", () => {
    expect(matchRanges("PR #142 and 142", searchTokens("142 14"))).toEqual([
      [4, 7],
      [12, 15],
    ]);
  });
});
