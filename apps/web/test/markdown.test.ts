/**
 * AI の文の小さな Markdown の描画器（Issue #8）。HTML を解釈しない・http(s) 以外のリンクを作らないことを含める。
 * 文はすべて合成のダミー
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown, parseMarkdown, safeHref } from "../src/components/Markdown.tsx";

const html = (text: string) => renderToStaticMarkup(createElement(Markdown, { text }));
/** class などの属性を落とした形（構造だけを見る） */
const bare = (text: string) =>
  html(text)
    .replace(/ (class|target|rel)="[^"]*"/g, "")
    .replace(/^<div>|<\/div>$/g, "");

describe("ブロック", () => {
  test("見出し（# 〜 ###。#### 以下は ### と同じ）と段落。#の後に空白の無い行は見出しにしない", () => {
    expect(parseMarkdown("# A\n## B\n### C\n#### D\n#tag")).toEqual([
      { k: "heading", level: 1, text: "A" },
      { k: "heading", level: 2, text: "B" },
      { k: "heading", level: 3, text: "C" },
      { k: "heading", level: 3, text: "D" },
      { k: "para", text: "#tag" },
    ]);
  });

  test("段落の中の 1 つの改行はそのまま（pre-wrap）、空行で段落を分ける", () => {
    expect(bare("一行目\n二行目\n\n次の段落")).toBe("<p>一行目\n二行目</p><p>次の段落</p>");
  });

  test("箇条書き（- *）と番号付き。段落の直後のリストも拾う。入れ子は字下げで", () => {
    expect(bare("どれにしますか:\n1. 同じ幅\n2. そのまま\n   - 補足")).toBe(
      "<p>どれにしますか:</p><ol><li><p>同じ幅</p></li><li><p>そのまま</p><ul><li><p>補足</p></li></ul></li></ol>",
    );
    expect(bare("- a\n* b")).toBe("<ul><li><p>a</p></li><li><p>b</p></li></ul>");
    expect(bare("3. c\n4. d")).toBe('<ol start="3"><li><p>c</p></li><li><p>d</p></li></ol>');
  });

  test("空行を挟んだ項目は同じリスト。字下げの無い行が来たら終わる", () => {
    expect(bare("- a\n\n- b\n\n終わり")).toBe(
      "<ul><li><p>a</p></li><li><p>b</p></li></ul><p>終わり</p>",
    );
  });

  test("フェンスのコードブロック（言語名は無視、中は解釈しない）と引用・区切り線", () => {
    expect(bare("```ts\nconst a = **1**;\n<b>x</b>\n```\n> 引用の **太字**\n\n---")).toBe(
      "<pre><code>const a = **1**;\n&lt;b&gt;x&lt;/b&gt;</code></pre><blockquote><p>引用の <strong>太字</strong></p></blockquote><hr/>",
    );
  });

  test("閉じていないフェンスは最後までコード", () => {
    expect(parseMarkdown("```\na\nb")).toEqual([{ k: "code", text: "a\nb" }]);
  });
});

describe("インライン", () => {
  test("太字・斜体・インラインコード", () => {
    expect(bare("**太** と *斜* と _斜_ と __太__ と `a*b*c`")).toBe(
      "<p><strong>太</strong> と <em>斜</em> と <em>斜</em> と <strong>太</strong> と <code>a*b*c</code></p>",
    );
  });

  test("単語の中の _ と、空白に挟まれた * は強調にしない。\\ でエスケープ", () => {
    expect(bare("snake_case_name と 2 * 3 * 4 と \\*そのまま\\*")).toBe(
      "<p>snake_case_name と 2 * 3 * 4 と *そのまま*</p>",
    );
  });

  test("リンク: [text](url) と素の URL は http(s) だけ。末尾の句読点は URL に含めない", () => {
    expect(bare("[PR](https://example.com/pull/8) と https://example.com/a_b.")).toBe(
      '<p><a href="https://example.com/pull/8">PR</a> と <a href="https://example.com/a_b">https://example.com/a_b</a>.</p>',
    );
    expect(bare("(see https://example.com/x)")).toBe(
      '<p>(see <a href="https://example.com/x">https://example.com/x</a>)</p>',
    );
  });

  test("javascript: などほかのスキームは素の文字のまま", () => {
    const out = html(
      "[押して](javascript:alert(1)) と [d](data:text/html,x) と javascript:alert(1)",
    );
    expect(out).not.toContain("<a");
    expect(out).toContain("[押して](javascript:alert(1))");
    expect(out).toContain("[d](data:text/html,x)");
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("JAVASCRIPT:alert(1)")).toBeNull();
    expect(safeHref("https://example.com/")).toBe("https://example.com/");
  });

  test("HTML のタグは解釈せず文字として出す（<script> も）", () => {
    const out = html('<script>alert("x")</script> <img src=x onerror=alert(1)> **<b>太</b>**');
    expect(out).not.toContain("<script");
    expect(out).not.toContain("<img");
    expect(out).not.toContain("<b>");
    expect(out).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(out).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(out).toContain("<strong>&lt;b&gt;太&lt;/b&gt;</strong>");
  });

  test("画像は読み込まない（alt のリンクにする）", () => {
    expect(bare("![図](https://example.com/a.png)")).toBe(
      '<p><a href="https://example.com/a.png">図</a></p>',
    );
  });
});

describe("作り", () => {
  test("dangerouslySetInnerHTML を使わない", () => {
    const src = readFileSync(join(import.meta.dir, "../src/components/Markdown.tsx"), "utf8");
    expect(src).not.toContain("dangerouslySetInnerHTML");
  });
});

describe("表（GFM の pipe table）", () => {
  const count = (out: string, tag: string) =>
    (out.match(new RegExp(`<${tag}[ >]`, "g")) ?? []).length;

  test("見出し行と区切り行で表。thead / tbody / th / td の数", () => {
    const out = html("| 指摘 | 対応 | 確認結果 |\n|---|---|---|\n| a | b | c |\n| d | e | f |");
    expect(count(out, "table")).toBe(1);
    expect(count(out, "thead")).toBe(1);
    expect(count(out, "tbody")).toBe(1);
    expect(count(out, "th")).toBe(3);
    expect(count(out, "td")).toBe(6);
    expect(out).toContain("指摘");
    expect(out).not.toContain("|---|");
  });

  test("両端のパイプは省略できる", () => {
    expect(parseMarkdown("a | b\n--- | ---\n1 | 2")).toEqual([
      { k: "table", align: ["none", "none"], head: ["a", "b"], rows: [["1", "2"]] },
    ]);
  });

  test("区切り行のコロンで揃え", () => {
    const out = html("| l | c | r | n |\n|:--|:-:|--:|---|\n| 1 | 2 | 3 | 4 |");
    expect(parseMarkdown("| l | c | r | n |\n|:--|:-:|--:|---|")[0]).toMatchObject({
      align: ["left", "center", "right", "none"],
    });
    const tds = [...out.matchAll(/<td class="([^"]*)"/g)].map((m) => m[1] as string);
    expect(tds.map((c) => c.match(/text-(left|center|right)/)?.[1])).toEqual([
      "left",
      "center",
      "right",
      "left",
    ]);
  });

  test("列数が合わなければ表にしない（段落のまま）。区切り行だけも段落", () => {
    expect(parseMarkdown("| a | b |\n|---|---|---|\n| 1 | 2 |")).toEqual([
      { k: "para", text: "| a | b |\n|---|---|---|\n| 1 | 2 |" },
    ]);
    expect(parseMarkdown("|---|---|")).toEqual([{ k: "para", text: "|---|---|" }]);
  });

  test("\\| はセルの中の |", () => {
    expect(parseMarkdown("| 式 | 意味 |\n|---|---|\n| a \\| b | または |")[0]).toMatchObject({
      rows: [["a | b", "または"]],
    });
  });

  test("セルが足りない行は空で埋め、多い行は切る", () => {
    expect(parseMarkdown("| a | b |\n|---|---|\n| 1 |\n| 2 | 3 | 4 |")[0]).toMatchObject({
      rows: [
        ["1", ""],
        ["2", "3"],
      ],
    });
  });

  test("セルの中のリンク・コード・強調は効く（http(s) 以外のリンクは文字のまま）", () => {
    const out = html(
      "| 項目 | 内容 |\n|---|---|\n| [PR](https://example.com/pull/8) | `bun test` と **通過** |\n| x | [y](javascript:alert(1)) |",
    );
    expect(out).toContain('<a href="https://example.com/pull/8"');
    expect(out).toContain(">bun test</code>");
    expect(out).toContain("<strong>通過</strong>");
    expect(out).toContain("[y](javascript:alert(1))");
    expect(out).not.toContain('href="javascript');
  });

  test("表の直後に段落・箇条書きが続く。段落の直後の表も拾う", () => {
    expect(
      parseMarkdown("結果です:\n| a | b |\n|---|---|\n| 1 | 2 |\n- 次へ\n\n終わり").map((b) => b.k),
    ).toEqual(["para", "table", "list", "para"]);
  });

  test("狭いパネル向け: 幅いっぱい・上揃え・横スクロールの保険", () => {
    const out = html("| a |\n|---|\n| 1 |");
    expect(out).toContain('<div class="overflow-x-auto"><table class="w-full');
    expect(out).toMatch(/<td class="[^"]*align-top[^"]*break-words/);
  });
});
