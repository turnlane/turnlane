/** 自動生成タスクの題名（phase0-plan 3.3、D-046）: 種類とパラメータから英語・日本語で組み立てる */
import { describe, expect, test } from "bun:test";
import {
  formatTaskTitle,
  parseTaskTitleParams,
  type TaskTitleParams,
  taskDisplayTitle,
  taskTitleKeyFor,
} from "../../src/i18n/task-title.ts";

const P: TaskTitleParams = {
  title: "Fix login",
  repo: "repo-a",
  branch: "feat/login",
  pr: 12,
  prTitle: "Login fix",
};

describe("自動生成タスクの題名（D-046）", () => {
  test.each([
    ["reply", "Reply: Fix login", "返答: Fix login"],
    ["approve", "Approve: Fix login", "許可: Fix login"],
    ["review_pr", "Review PR #12: Login fix", "PR #12 をレビュー: Login fix"],
    ["resume_error", "Resume: Fix login", "再開: Fix login"],
    ["check_changes", "Check changes: Fix login", "変更を確認: Fix login"],
  ] as const)("%s", (kind, en, ja) => {
    const key = taskTitleKeyFor(kind);
    expect(formatTaskTitle(key, P, "en")).toBe(en);
    expect(formatTaskTitle(key, P, "ja")).toBe(ja);
  });

  test("既定は英語（CLI）", () => {
    expect(formatTaskTitle("followup.reply", P)).toBe("Reply: Fix login");
  });

  test("AI のタイトルが無ければ repo#branch、それも無ければ AI work", () => {
    const none = { ...P, title: null, prTitle: null };
    expect(formatTaskTitle("followup.reply", none)).toBe("Reply: repo-a#feat/login");
    expect(formatTaskTitle("followup.review_pr", none, "ja")).toBe(
      "PR #12 をレビュー: repo-a#feat/login",
    );
    const empty = { title: null, repo: null, branch: null, pr: null, prTitle: null };
    expect(formatTaskTitle("followup.resume_error", empty)).toBe("Resume: AI work");
    expect(formatTaskTitle("followup.resume_error", empty, "ja")).toBe("再開: AI の作業");
  });

  test("パラメータは JSON から読む（壊れていれば空として扱う）", () => {
    expect(parseTaskTitleParams(JSON.stringify(P))).toEqual(P);
    expect(parseTaskTitleParams("{")).toEqual({
      title: null,
      repo: null,
      branch: null,
      pr: null,
      prTitle: null,
    });
    expect(parseTaskTitleParams(null).title).toBeNull();
  });

  test("title_key が無いタスク（人が付けた題名）はそのまま出す", () => {
    expect(taskDisplayTitle({ title: "Write report", titleKey: null, titleParams: null })).toBe(
      "Write report",
    );
    expect(
      taskDisplayTitle(
        { title: "", titleKey: "followup.reply", titleParams: JSON.stringify(P) },
        "ja",
      ),
    ).toBe("返答: Fix login");
  });
});
