/** 報告の項目（ADR 0021）のリポジトリの欄と汎用のバッジ */
import { describe, expect, test } from "bun:test";
import { sourceBadgeText } from "../src/components/ui.tsx";
import { whereName } from "../src/lib/where.ts";

describe("報告の項目", () => {
  test("リポジトリの欄は `出どころ · プロジェクト`（プロジェクトが無ければ出どころ）", () => {
    const r = { tool: "myscript", report: true as const };
    expect(whereName({ repoRoot: null, sources: [{ ...r, project: "Reports" }] }, "Scratch")).toBe(
      "myscript · Reports",
    );
    expect(whereName({ repoRoot: null, sources: [r] }, "Scratch")).toBe("myscript");
    // リポジトリのある項目・報告でない項目は今までどおり
    expect(whereName({ repoRoot: "/w/app", sources: [r] }, "Scratch")).toBe("app");
    expect(whereName({ repoRoot: null, sources: [{ tool: "claude_code" }] }, "Scratch")).toBeNull();
  });
  test("知らない出どころは先頭 2 文字の汎用バッジ", () => {
    expect(sourceBadgeText({ tool: "myscript", profile: null })).toBe("MY");
    expect(sourceBadgeText({ tool: "claude_code", profile: null })).toBe("CC");
  });
});
