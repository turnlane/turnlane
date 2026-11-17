/**
 * 図の枠（図つきの問い。ADR 0022）: sandbox（allow-scripts も allow-same-origin も無し）、srcdoc の先頭の CSP、色と文字の
 * 変数、外へ移る口を取り除くこと。図はすべて合成のダミー
 */
import { describe, expect, test } from "bun:test";
import { ASK_FIGURE_VARS } from "@turnlane/core/web";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  FIGURE_CSP,
  FigureFrame,
  type FigureTheme,
  figureSrcdoc,
  sanitizeFigure,
} from "../src/components/FigureFrame.tsx";

const theme: FigureTheme = {
  scheme: "light",
  vars: Object.fromEntries(
    ASK_FIGURE_VARS.map((k) => [k, k.includes("font") ? "Inter" : "#123456"]),
  ),
};

/** srcdoc を取り出す（属性の実体参照を戻す） */
function srcdocOf(markup: string): string {
  const m = /srcDoc="([^"]*)"|srcdoc="([^"]*)"/.exec(markup);
  return (m?.[1] ?? m?.[2] ?? "")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

describe("枠", () => {
  const markup = renderToStaticMarkup(
    createElement(FigureFrame, { html: "<svg><rect/></svg>", title: "Figure for A" }),
  );

  test("sandbox は空（スクリプト・同じオリジン・フォーム・ポップアップ・上の窓の移動を許さない）", () => {
    expect(markup).toContain('sandbox=""');
    expect(markup).not.toContain("allow-scripts");
    expect(markup).not.toContain("allow-same-origin");
    expect(markup).not.toMatch(/\ssrc="/);
    expect(markup).toContain('referrerPolicy="no-referrer"');
    expect(markup).toContain('title="Figure for A"');
  });

  test("srcdoc の head の先頭に CSP（default-src 'none'・style は inline だけ・画像は data: だけ）", () => {
    const doc = srcdocOf(markup);
    expect(FIGURE_CSP).toBe("default-src 'none'; style-src 'unsafe-inline'; img-src data:");
    expect(doc.startsWith('<!doctype html><html><head><meta charset="utf-8">')).toBe(true);
    const csp = doc.indexOf(`<meta http-equiv="Content-Security-Policy" content="${FIGURE_CSP}">`);
    expect(csp).toBeGreaterThan(0);
    // 図の中身より前
    expect(csp).toBeLessThan(doc.indexOf("<svg>"));
  });
});

describe("色と文字", () => {
  test("--tl-* の変数と color-scheme を :root に入れる", () => {
    const doc = figureSrcdoc("<p>x</p>", theme);
    for (const k of ASK_FIGURE_VARS) expect(doc).toContain(`${k}:`);
    expect(doc).toContain("color-scheme:light");
    expect(doc).toContain("--tl-text:#123456");
  });

  test("枠いっぱいに収める style は fit のときだけ（CSP は同じ）", () => {
    const plain = figureSrcdoc("<svg/>", theme);
    const fit = figureSrcdoc("<svg/>", theme, { fit: true });
    expect(plain).not.toContain("svg:only-child");
    expect(fit).toContain("body>svg:only-child{display:block;width:100%;height:100%");
    for (const d of [plain, fit]) expect(d).toContain(`content="${FIGURE_CSP}"`);
  });

  test("変数の値から ; { } < > を除く（style を抜け出せない）", () => {
    const doc = figureSrcdoc("", {
      scheme: "dark",
      vars: { "--tl-bg": "red;}</style><script>x()</script>" },
    });
    expect(doc).not.toContain("<script>");
    expect(doc).toContain("--tl-bg:red/stylescriptx()/script");
  });
});

describe("外へ移る口を取り除く", () => {
  test.each([
    ["script", '<p>a</p><script>fetch("https://x.example")</script><p>b</p>', "<p>a</p><p>b</p>"],
    ["自己終了の script", '<script src="https://x.example/a.js"/>ok', "ok"],
    ["base", '<base href="https://x.example/">ok', "ok"],
    ["meta refresh", '<meta http-equiv="refresh" content="0;url=https://x.example">ok', "ok"],
    ["iframe", '<iframe src="https://x.example"></iframe>ok', "ok"],
    ["link の stylesheet", '<link rel="stylesheet" href="https://x.example/a.css">ok', "ok"],
    ["外へのリンク", '<a href="https://x.example">go</a>', "<a>go</a>"],
    ["外の画像", "<img src='https://x.example/a.png'>", "<img>"],
    [
      "SVG の外の参照",
      '<svg><image xlink:href="http://x.example/a.png"/></svg>',
      "<svg><image/></svg>",
    ],
    [
      "form の action",
      '<form action="https://x.example"><button formaction="https://y.example">b</button></form>',
      "<form><button>b</button></form>",
    ],
    ["イベントの属性", '<rect onload="alert(1)" onclick=\'x()\' width="4"/>', '<rect width="4"/>'],
  ])("%s", (_name, input, out) => {
    expect(sanitizeFigure(input)).toBe(out);
  });

  test("文書の中の参照（#）と data:image は残す", () => {
    const svg =
      '<svg><defs><g id="d"/></defs><use href="#d"/><image href="data:image/png;base64,AAAA"/></svg>';
    expect(sanitizeFigure(svg)).toBe(svg);
    expect(sanitizeFigure('<a href="data:text/html,x">x</a>')).toBe("<a>x</a>");
  });
});
