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

describe("次の指示の欄（Issue #9）", () => {
  const ok = {
    ok: true,
    via: "tmux",
    terminal: "Ghostty",
    landing: "Ghostty · main:1.0",
    multiline: true,
  } as const;
  const reply = { state: "ok", text: "直しました。", truncated: false, masked: false } as const;

  test("送れる: 返答の下に入力欄と「送る · 届け先」（⌘⏎）", () => {
    const out = html("ja", { ...reply, instruct: ok });
    expect(out.indexOf("直しました。")).toBeLessThan(out.indexOf('data-testid="ai-instruct"'));
    expect(out).toContain("次の指示");
    expect(out).toContain('data-testid="ai-instruct-input"');
    expect(out).toContain("送る · Ghostty · main:1.0");
    expect(out).toContain("⌘⏎ で送る · ⏎ で改行");
  });

  test.each([
    ["session_ended", "このセッションは終わっています", "ai-instruct-open"],
    ["process_unknown", "このセッションが動いているか確かめられません", "ai-instruct-open"],
    ["turn_in_progress", "動作中です", null],
    ["wait_open", "待ちがあります", "ai-instruct-answer"],
    ["unsupported", "この端末には送れません", null],
    ["not_found", "このセッションの端末のタブが見つかりません", null],
  ] as const)("送れない %s: 1 行の理由と導線。入力欄は出さない", (reason, line, button) => {
    const out = html("ja", { ...reply, instruct: { ok: false, reason, terminal: null } });
    expect(out).toContain(line);
    expect(out).not.toContain('data-testid="ai-instruct-input"');
    if (button) expect(out).toContain(`data-testid="${button}"`);
  });

  test("英語: 終わったセッション", () => {
    const out = html("en", {
      ...reply,
      instruct: { ok: false, reason: "session_ended", terminal: null },
    });
    expect(out).toContain("This session has ended");
    expect(out).toContain("Open in terminal");
  });

  test("設定「Turnlane から答える」がオフなら欄を出さない。「行に中身を出す」がオフでも欄は出す（返答は出さない）", () => {
    expect(
      html("ja", { ...reply, instruct: { ok: false, reason: "off", terminal: null } }),
    ).not.toContain('data-testid="ai-instruct"');
    const off = html("ja", { state: "off", instruct: ok });
    expect(off).toContain('data-testid="ai-instruct-input"');
    expect(off).not.toContain("最後の返答");
    expect(
      html("ja", { state: "off", instruct: { ok: false, reason: "off", terminal: null } }),
    ).toBe("");
  });
});
