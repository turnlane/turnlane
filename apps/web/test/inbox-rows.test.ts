/**
 * Inbox の行（Inbox のレビュー v1）: 出どころは利用者の言葉（内部の名前・括弧を出さない。手で入れたものは出さない）、
 * 7日以上残ったものは `N日前`、行は自分の番の画面と同じ部品（面・選択の枠・2行の行）を使う。
 */
import { describe, expect, test } from "bun:test";

import { readFileSync } from "node:fs";

import { join } from "node:path";

import type { TaskView } from "@turnlane/core/web";

import { staleDays } from "../src/components/InboxRow.tsx";

import { originLabel, viaLabel } from "../src/components/items.tsx";

import { translate } from "../src/i18n/index.tsx";

type Origin = TaskView["origin"];
const o = (p: Partial<Origin>): Origin => ({
  source: "manual",
  client: null,
  externalSource: null,
  externalUrl: null,
  ...p,
});
const ja = (k: Parameters<typeof translate>[1], p?: Record<string, string | number>) =>
  translate("ja", k, p);
const en = (k: Parameters<typeof translate>[1], p?: Record<string, string | number>) =>
  translate("en", k, p);

describe("originLabel", () => {
  test("MCP は Claude Code / Codex の言葉（内部の名前・括弧を出さない）", () => {
    expect(originLabel(o({ source: "mcp", client: "claude-code" }), ja)).toBe("Claude Code から");
    expect(originLabel(o({ source: "mcp", client: "codex" }), ja)).toBe("Codex から");
    expect(originLabel(o({ source: "mcp", client: "claude-code" }), en)).toBe("from Claude Code");
    expect(originLabel(o({ source: "mcp", client: "cursor" }), ja)).toBe("cursor から");
    for (const x of [ja, en]) {
      const s = originLabel(o({ source: "mcp", client: "claude-code" }), x) ?? "";
      expect(s).not.toMatch(/MCP|claude-code|[()（）]/);
    }
  });

  test("外部の出どころは製品名、CLI は CLI", () => {
    expect(originLabel(o({ externalSource: "github" }), ja)).toBe("GitHub");
    expect(
      originLabel(o({ source: "mcp", client: "claude-code", externalSource: "github" }), en),
    ).toBe("GitHub");
    expect(originLabel(o({ source: "cli" }), ja)).toBe("CLI");
  });

  test("手で入れたもの（クイック入力を含む）と AI のカードから作ったものは出さない", () => {
    for (const source of ["manual", "desktop", "ai", "calendar"] as const)
      expect(originLabel(o({ source }), ja)).toBeNull();
  });
});

describe("viaLabel（タスクの詳細パネルの経由）", () => {
  test("行と同じ言葉。外部の出どころは製品名（手入力・等幅の札にしない）", () => {
    expect(viaLabel(o({ externalSource: "github", externalUrl: "https://x.invalid/1" }), ja)).toBe(
      "GitHub",
    );
    expect(viaLabel(o({ source: "mcp", client: "claude-code" }), ja)).toBe("Claude Code から");
    expect(viaLabel(o({ source: "mcp", client: "codex" }), en)).toBe("from Codex");
    expect(viaLabel(o({ source: "cli" }), ja)).toBe("CLI");
    expect(viaLabel(o({ source: "manual" }), ja)).toBe("手入力");
    expect(viaLabel(o({ source: "desktop" }), ja)).toBe("クイック入力");
  });

  test("パネルは viaLabel を使い、出どころの札（Chip）と MCP の内部の名前を出さない", () => {
    const panel = readFileSync(join(import.meta.dir, "../src/panel/TaskPanel.tsx"), "utf8");
    const via = panel.slice(
      panel.indexOf("function Via("),
      panel.indexOf("function TaskAiSection("),
    );
    expect(via).toContain("viaLabel(");
    expect(via).not.toContain("<Chip");
    expect(via).not.toContain("inbox.via.mcp");
    expect(via).toContain("ExternalLink");
  });
});

describe("staleDays", () => {
  const D = 86_400_000;
  test("7日未満は null、7日以上は日数", () => {
    expect(staleDays(0, 6 * D + D - 1)).toBeNull();
    expect(staleDays(0, 7 * D)).toBe(7);
    expect(staleDays(0, 9 * D + 5)).toBe(9);
    expect(translate("ja", "inbox.age", { count: 9 })).toBe("9日前");
    expect(translate("en", "inbox.age", { count: 9 })).toBe("9d ago");
  });
});

describe("Inbox の画面", () => {
  const src = (p: string) => readFileSync(join(import.meta.dir, "../src", p), "utf8");
  test("行は自分の番の画面の部品（2行の行・面・選択の枠）を使い、旗のアイコン・枠付きのカードを使わない", () => {
    const row = src("components/InboxRow.tsx");
    expect(row).toContain("QUEUE_ROW");
    expect(row).toContain("rowSurface(");
    // ホバーのボタンは 日に置く・AI に頼む・⋯（T4。D-139 (4)）
    expect(row).toContain("HoverToolbar");
    expect(row).toContain('id: "move"');
    expect(row).toContain('id: "askAi"');
    const page = src("routes/InboxPage.tsx");
    expect(page).toContain("<InboxRow");
    expect(page).not.toContain("TaskCard");
    expect(page).not.toContain("Flag");
    expect(page).not.toContain("max-w-[760px]");
    // 選択の枠は、キーで動かした後か詳細パネルを開いている間だけ（開いた直後は出さない）
    expect(page).toContain("selected={i === cur && (navigated || panelTaskId === x.id)}");
  });
});
