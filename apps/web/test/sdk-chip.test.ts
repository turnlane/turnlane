/** プログラム経由（entrypoint が sdk-*）の AI 項目の「SDK 経由」の札（AI のレーンの行・AI の詳細パネル） */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AiRunBlock } from "../src/components/items.tsx";
import { I18nProvider } from "../src/i18n/index.tsx";

const block = (locale: "ja" | "en", sdk: boolean) =>
  renderToStaticMarkup(
    createElement(
      I18nProvider,
      { locale } as Parameters<typeof I18nProvider>[0],
      createElement(AiRunBlock, {
        title: "Fixture work",
        status: "done",
        estimated: false,
        sources: [{ tool: "claude_code", profile: null, ...(sdk ? { sdk: true as const } : {}) }],
        right: "12m",
      } as Parameters<typeof AiRunBlock>[0]),
    ),
  );

describe("SDK 経由の札", () => {
  test("レーンの行: プログラム経由なら札（日本語・英語）、端末のセッションには出さない。詳細パネルも同じ札を使う", () => {
    expect(block("ja", true)).toContain('data-testid="via-sdk">SDK 経由</span>');
    expect(block("en", true)).toContain(">via SDK</span>");
    expect(block("ja", false)).not.toContain("via-sdk");
    const panel = readFileSync(join(import.meta.dir, "../src/panel/AiPanel.tsx"), "utf8");
    expect(panel).toContain('viaSdk(d.workItem.sources) ? <SdkChip label={t("ai.viaSdk")} />');
  });
});
