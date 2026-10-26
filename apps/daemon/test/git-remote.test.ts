/** リモートの URL → owner/repo と、worktree の一覧の読み取り（fix-pr-card-repo） */
import { expect, test } from "bun:test";
import { remoteSlug } from "../src/ingest/git.ts";
import { parseWorktreeFor } from "../src/open/system.ts";

test.each([
  ["https://github.com/example/site.git", "example/site"],
  ["https://github.com/Example/Site", "example/site"],
  ["git@github.com:example/site.git", "example/site"],
  ["ssh://git@github.example.invalid/team/site.js.git", "team/site.js"],
  ["https://github.com/example/site/", "example/site"],
  ["/local/path/bare.git", "path/bare"],
  ["", null],
])("remoteSlug(%p)", (url, want) => {
  expect(remoteSlug(url)).toBe(want);
});

test("parseWorktreeFor: ブランチを取り出している worktree のパス", () => {
  const out = [
    "worktree /w/site",
    "HEAD 1111111111111111111111111111111111111111",
    "branch refs/heads/main",
    "",
    "worktree /w/site-wt/lp",
    "HEAD 2222222222222222222222222222222222222222",
    "branch refs/heads/fix/lp-notify-wording",
    "",
    "worktree /w/site-wt/detached",
    "HEAD 3333333333333333333333333333333333333333",
    "detached",
    "",
  ].join("\n");
  expect(parseWorktreeFor(out, "fix/lp-notify-wording")).toBe("/w/site-wt/lp");
  expect(parseWorktreeFor(out, "main")).toBe("/w/site");
  expect(parseWorktreeFor(out, "fix/lp")).toBeNull();
});
