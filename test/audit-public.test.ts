/** 公開前の検査（scripts/audit-public.ts。phase0-plan M6-7、ADR 0015） */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDenyList, scanHistory, scanText, scanTree } from "../scripts/audit-public.ts";

describe("audit-public", () => {
  const rules = parseDenyList(
    ["# comment", "", "Secret Feature", "/\\bplan-[0-9]+\\b/i", "other-repo/path"].join("\n"),
  );

  test("一覧: コメントと空行を飛ばし、部分一致（大文字小文字を区別しない）と正規表現", () => {
    expect(rules.map((r) => r.label)).toEqual([
      "Secret Feature",
      "/\\bplan-[0-9]+\\b/i",
      "other-repo/path",
    ]);
    expect(scanText("a.md", "x\nthe secret feature is\nPLAN-12 y", rules)).toEqual([
      { where: "a.md:2", rule: "Secret Feature" },
      { where: "a.md:3", rule: "/\\bplan-[0-9]+\\b/i" },
    ]);
    expect(scanText("b.md", "planning 12", rules)).toEqual([]);
  });

  test("ツリーと履歴（消したファイル・コミットメッセージも）", () => {
    const dir = mkdtempSync(join(tmpdir(), "turnlane-audit-"));
    const git = (...a: string[]) =>
      Bun.spawnSync(["git", "-C", dir, ...a], {
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@example.invalid",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@example.invalid",
        },
      });
    try {
      git("init", "-q");
      writeFileSync(join(dir, "a.md"), "ok\n");
      writeFileSync(join(dir, "b.md"), "Secret Feature\n");
      git("add", "-A");
      git("commit", "-q", "-m", "add plan-3");
      git("rm", "-q", "b.md");
      git("commit", "-q", "-m", "remove");
      expect(scanTree(dir, rules)).toEqual([]);
      const h = scanHistory(dir, rules).map((x) => `${x.where.split(" ")[1]}|${x.rule}`);
      expect(h).toContain("b.md|Secret Feature");
      expect(h).toContain("(message)|/\\bplan-[0-9]+\\b/i");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
