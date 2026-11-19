/**
 * 図の枠（図つきの問い。ADR 0022）: sandbox（allow-scripts も allow-same-origin も無し）、srcdoc の先頭の CSP、色と文字の
 * 変数、外へ移る口を取り除くこと。図はすべて合成のダミー
 */
import { describe, expect, test } from "bun:test";
import { ASK_FIGURE_VARS } from "@turnlane/core/web";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  FIGURE_CANVAS,
  FIGURE_CSP,
  FigureFrame,
  type FigureTheme,
  figureCanvas,
  figureSrcdoc,
  fitCanvas,
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
    // 名前は aria-label（title 属性は WKWebView でずれた位置のツールチップになった）
    expect(markup).toContain('aria-label="Figure for A"');
    expect(markup).not.toMatch(/\stitle="/);
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

  test("図（canvas）は図の大きさの文書で余白なし・はみ出しは切る。説明の頁は流れる（CSP は同じ）", () => {
    const page = figureSrcdoc("<svg/>", theme);
    const svg = figureSrcdoc("<svg/>", theme, {
      canvas: { width: 480, height: 320, root: "svg", from: "viewBox" },
    });
    const html = figureSrcdoc("<div/>", theme, {
      canvas: { width: 240, height: 160, root: "html", from: "size" },
    });
    expect(page).toContain("body{padding:8px}");
    expect(page).not.toContain("overflow:hidden");
    expect(svg).toContain("html,body{width:480px;height:320px;overflow:hidden}body{padding:0}");
    expect(svg).toContain("body>svg:first-of-type{display:block;width:100%;height:100%");
    expect(html).toContain("html,body{width:240px;height:160px;overflow:hidden}");
    expect(html).not.toContain("svg:first-of-type");
    for (const d of [page, svg, html]) expect(d).toContain(`content="${FIGURE_CSP}"`);
  });

  test("Turnlane は図の中身の前後に文字を足さない（body は図の中身だけ）", () => {
    const fig = '<svg viewBox="0 0 480 320"><rect width="480" height="320"/></svg>';
    for (const canvas of [undefined, figureCanvas(fig)]) {
      const doc = figureSrcdoc(fig, theme, canvas ? { canvas } : {});
      expect(/<body>([\s\S]*)<\/body><\/html>$/.exec(doc)?.[1]).toBe(fig);
      // head は meta と style だけ（文字として出るものが無い）
      const head = /<head>([\s\S]*)<\/head>/.exec(doc)?.[1] ?? "";
      expect(head.replace(/<meta[^>]*>|<style>[^<]*<\/style>/g, "")).toBe("");
    }
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

describe("図の大きさ（figureCanvas）", () => {
  test.each([
    [
      "SVG の viewBox だけ → 幅 480・縦横比は viewBox",
      '<svg viewBox="0 0 240 160"><rect/></svg>',
      480,
      320,
      "svg",
      "viewBox",
    ],
    ["SVG の viewBox（縦長）", '<svg viewBox="0 0 100 200"></svg>', 480, 960, "svg", "viewBox"],
    [
      "SVG の width・height（px）",
      '<svg width="240" height="160"><rect/></svg>',
      240,
      160,
      "svg",
      "size",
    ],
    [
      "SVG の width と viewBox → 高さは viewBox の比",
      '<svg width="300" viewBox="0 0 60 40"></svg>',
      300,
      200,
      "svg",
      "size",
    ],
    [
      "SVG の width が % なら viewBox",
      '<svg width="100%" viewBox="0 0 60 40"></svg>',
      480,
      320,
      "svg",
      "viewBox",
    ],
    [
      "固定の px の HTML（style 属性）",
      '<div style="width:240px;height:160px;background:var(--tl-surface)"><p>x</p></div>',
      240,
      160,
      "html",
      "size",
    ],
    [
      "固定の px の HTML（<style> の class の規則）。doctype・meta・コメントは飛ばす",
      '<!doctype html><meta charset="utf-8"><!-- a --><style>.screen{position:relative;width:240px;height:160px;max-width:999px}</style><div class="screen card"><b>x</b></div>',
      240,
      160,
      "html",
      "size",
    ],
    [
      "文書まるごと（html・head・body）。body の規則の大きさ",
      "<!doctype html><html><head><style>body{margin:0;width:320px;height:200px}</style></head><body><div>a</div><div>b</div></body></html>",
      320,
      200,
      "html",
      "size",
    ],
    ["幅だけ → 高さは 3:2", '<div style="width:300px">x</div>', 300, 200, "html", "size"],
    ["大きさが分からない HTML → 既定", "<p>Just text</p>", 480, 320, "html", "default"],
    ["空 → 既定", "", 480, 320, "html", "default"],
    [
      "XML 宣言の付いた SVG",
      '<?xml version="1.0"?>\n<svg viewBox="0 0 30 20"/>',
      480,
      320,
      "svg",
      "viewBox",
    ],
  ])("%s", (_name, html, width, height, root, from) => {
    expect(figureCanvas(html)).toEqual({ width, height, root, from } as ReturnType<
      typeof figureCanvas
    >);
  });

  test("極端な大きさは 16〜4000 に収める", () => {
    expect(figureCanvas('<svg width="2" height="99999"/>')).toMatchObject({
      width: 16,
      height: 4000,
    });
  });

  test("既定はスキルの案内と同じ 480×320", () => {
    expect(FIGURE_CANVAS).toEqual({ width: 480, height: 320 });
  });
});

describe("置き場所に収める（fitCanvas）", () => {
  test("240×160 の図を 520 幅・3:2 の置き場所へ → 2.17 倍で隙間なし", () => {
    const f = fitCanvas({ width: 520, height: 520 * (2 / 3) }, { width: 240, height: 160 });
    expect(f?.scale).toBeCloseTo(520 / 240, 5);
    expect(f?.x).toBeCloseTo(0, 5);
    expect(f?.y).toBeCloseTo(0, 5);
  });
  test("縦横比が違えば小さい方の倍率で真ん中に", () => {
    const f = fitCanvas({ width: 600, height: 200 }, { width: 480, height: 320 });
    expect(f?.scale).toBeCloseTo(200 / 320, 5);
    expect(f?.x).toBeCloseTo((600 - 480 * (200 / 320)) / 2, 5);
    expect(f?.y).toBe(0);
  });
  test("パネルの 112×80 には縮めて全体を収める", () => {
    const f = fitCanvas({ width: 112, height: 80 }, { width: 480, height: 320 });
    expect(f?.scale).toBeCloseTo(112 / 480, 5);
  });
  test("置き場所が 0 なら測れていない（null）", () => {
    expect(fitCanvas({ width: 0, height: 80 }, { width: 480, height: 320 })).toBeNull();
  });
});

describe("案の図の枠（canvas）", () => {
  test("箱の中に図の大きさの枠。マウスを受けず Tab で入らない。sandbox と CSP は同じ", () => {
    const m = renderToStaticMarkup(
      createElement(FigureFrame, {
        html: '<div style="width:240px;height:160px">x</div>',
        title: "Figure for A",
        mode: "canvas",
        className: "h-20 w-28",
        testId: "f",
      }),
    );
    expect(m).toMatch(
      /<div class="relative overflow-hidden h-20 w-28" data-testid="f-box"><iframe/,
    );
    expect(m).toContain('sandbox=""');
    expect(m).not.toContain("allow-");
    expect(m).toContain('tabindex="-1"');
    expect(m).toContain("width:240px;height:160px");
    expect(m).toContain("pointer-events:none");
    expect(m).toContain('data-canvas="240x160"');
    expect(srcdocOf(m)).toContain(`content="${FIGURE_CSP}"`);
  });
});
