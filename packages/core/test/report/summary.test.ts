import { describe, expect, test } from "bun:test";
import { validateConfig } from "../../src/config.ts";
import {
  buildSummaryInput,
  checkSummaryOutput,
  renderSummarySection,
  withSummary,
} from "../../src/report/summary.ts";
import { readAiSummary } from "../../src/settings.ts";

describe("日報の AI 要約（M4-6）", () => {
  test("stdin の全文はプロンプトと日報だけ（言語の指定を含む）", () => {
    const s = buildSummaryInput("## Fri 10/2\nTime: You 1h\n\n", "ja");
    expect(s).toContain("Write 2-3 sentences in Japanese");
    expect(s.endsWith("<daily-report>\n## Fri 10/2\nTime: You 1h\n</daily-report>\n")).toBe(true);
  });

  test("出力の検証（空・長すぎ・先頭の見出し）", () => {
    expect(checkSummaryOutput("  \n")).toEqual({ ok: false, reason: "empty" });
    expect(checkSummaryOutput("a".repeat(2001))).toEqual({ ok: false, reason: "too_long" });
    expect(checkSummaryOutput("あ".repeat(2000))).toEqual({ ok: true, text: "あ".repeat(2000) });
    expect(checkSummaryOutput("## Summary\n\nShipped it.\r\n")).toEqual({
      ok: true,
      text: "Shipped it.",
    });
  });

  test("Summary の節（見出しは UI の言語、末尾に作ったツール）", () => {
    expect(renderSummarySection(null, null, "en")).toBe("");
    expect(withSummary("## Fri 10/2\n", "Calm.", "codex", "en")).toBe(
      "## Summary\nCalm.\n\n(summary by codex)\n\n## Fri 10/2\n",
    );
    expect(withSummary("## 金 10/2\n", "静かな日。", "claude_code", "ja")).toBe(
      "## 要約\n静かな日。\n\n（claude による要約）\n\n## 金 10/2\n",
    );
    expect(withSummary("## Fri\n", "Mine.", null, "en")).toBe("## Summary\nMine.\n\n## Fri\n");
  });

  test("設定 report.ai_summary（既定オフ、壊れた値は既定）", () => {
    expect(readAiSummary(undefined)).toEqual({
      enabled: false,
      tool: "claude_code",
      bin: null,
      claudeConfigDir: null,
      timeoutMs: 90_000,
    });
    expect(
      readAiSummary({ enabled: true, tool: "codex", bin: "relative", timeout_sec: 5 }),
    ).toMatchObject({ enabled: true, tool: "codex", bin: null, timeoutMs: 90_000 });
    expect(validateConfig("report.ai_summary", { enabled: true }).ok).toBe(true);
    expect(validateConfig("report.ai_summary", { enabled: true, bin: "claude" }).ok).toBe(false);
    expect(validateConfig("report.ai_summary", { other: 1 }).ok).toBe(false);
  });
});
