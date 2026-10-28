/**
 * AI の詳細パネルの「最後の返答」の節（Issue #8）。応答はキャッシュに置いた合成の値（デーモンには行かない）
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { LastReplyResponse } from "@turnlane/core/web";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LastReplySection } from "../src/components/LastReply.tsx";
import { lastReplyKey } from "../src/data/last-reply.ts";
import { I18nProvider } from "../src/i18n/index.tsx";

const ID = "wi-1";
const V = "done|1";

function html(locale: "ja" | "en", r: Partial<LastReplyResponse> | null) {
  const client = new QueryClient({
    defaultOptions: { queries: { gcTime: Number.POSITIVE_INFINITY } },
  });
  if (r) client.setQueryData([...lastReplyKey(ID), V], { workItemId: ID, readAt: 0, ...r });
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client },
      createElement(
        I18nProvider,
        { locale } as Parameters<typeof I18nProvider>[0],
        createElement(LastReplySection, { workItemId: ID, version: V }),
      ),
    ),
  );
}

describe("最後の返答の節", () => {
  test("文は Markdown で出す（HTML は文字のまま）。切っていなければ「開く」は出さない", () => {
    const out = html("ja", {
      state: "ok",
      text: "直しました。\n\n- **幅**を揃えた\n- <script>x</script>",
      truncated: false,
      masked: false,
    });
    expect(out).toContain("最後の返答");
    expect(out).toContain("<strong>幅</strong>");
    expect(out).toContain("&lt;script&gt;x&lt;/script&gt;");
    expect(out).not.toContain('data-testid="ai-last-reply-open"');
  });

  test("2,000 字で切ったら「続きは端末で」と「開く」。伏せ字の印", () => {
    const out = html("en", { state: "ok", text: "x", truncated: true, masked: true });
    expect(out).toContain("The rest is in the terminal.");
    expect(out).toContain('data-testid="ai-last-reply-open"');
    expect(out).toContain("Some parts are hidden");
  });

  test("記録が消えている: 日本語・英語の文", () => {
    expect(html("ja", { state: "gone" })).toContain("記録が消えていて読めません");
    expect(html("en", { state: "gone" })).toContain("The session log is gone");
    expect(html("en", { state: "none" })).toContain("No reply yet");
  });

  test("設定でオフなら節ごと出さない。読む前は「読んでいます」", () => {
    expect(html("ja", { state: "off" })).toBe("");
    expect(html("ja", null)).toContain("読んでいます");
  });

  test("パネル: 答えている間の問い（許可待ち以外）は「答える」の節が出すので、最後の返答は出さない", () => {
    const src = readFileSync(join(import.meta.dir, "../src/panel/AiPanel.tsx"), "utf8");
    expect(src).toMatch(
      /answering && wait\?\.kind !== "permission" \? null : \(\s*<LastReplySection/,
    );
  });
});
