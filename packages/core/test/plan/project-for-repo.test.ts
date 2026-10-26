import { describe, expect, test } from "bun:test";
import { parseRepoPaths, projectForRepo } from "../../src/plan/project-for-repo.ts";

describe("プロジェクトとリポジトリの対応（m2-api.md 19章）", () => {
  const projects = [
    { id: "work", repoPaths: ["/w"] },
    { id: "app", repoPaths: ["/w/app/"] },
    { id: "blog", repoPaths: ["/home/me/blog", "/home/me/blog-theme"] },
  ];
  test.each([
    ["/w/app", "app"],
    ["/w/app/packages/x", "app"],
    ["/w/app2", "work"],
    ["/home/me/blog-theme", "blog"],
    ["/home/me/blogger", null],
    [null, null],
  ])("%s → %s", (repo, want) => {
    expect(projectForRepo(repo, projects)).toBe(want);
  });

  test("repo_paths_json の読み取り", () => {
    expect(parseRepoPaths('["/a", 1, ""]')).toEqual(["/a"]);
    expect(parseRepoPaths("broken")).toEqual([]);
    expect(parseRepoPaths(null)).toEqual([]);
  });
});
