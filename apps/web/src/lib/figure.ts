/**
 * AI が書いた図（図つきの問い。ADR 0022）の枠に入れる文書を作る（部品は components/FigureFrame.tsx）。図は静的な HTML / SVG / CSS だけで、枠の中からは何も外に出られない:
 *
 * - `<iframe sandbox>`（allow-scripts も allow-same-origin も付けない。スクリプト・フォーム・ポップアップ・上の窓の移動を止め、
 *   中身は親の画面・クッキー・API に触れない）に `srcdoc` で入れる
 * - 先頭に CSP の meta（`default-src 'none'; style-src 'unsafe-inline'; img-src data:`）を入れる。外の画像・文字・スタイル・
 *   接続はすべて止まる。図の中に meta を足しても CSP は足し合わせなので緩まない
 * - 念のため、外へ移る口（script・base・meta の http-equiv・外を指す href / src など・イベントの属性）を取り除く。リンクを
 *   押して枠そのものが外のページへ移ることもない（`#` と `data:image/` だけ残す）
 * - Turnlane の今の色と文字を CSS 変数（`--tl-*`。core の ASK_FIGURE_VARS）で渡す。明暗どちらでも読める
 *
 * アプリ全体の CSP はここでは足さない（この枠だけ）。
 */
import { ASK_FIGURE_VARS } from "@turnlane/core/web";

export const FIGURE_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:";

/** --tl-* → Turnlane の CSS 変数（styles.css の --dl-*）か、文字の並び */
const SOURCES: Record<(typeof ASK_FIGURE_VARS)[number], { from?: string; value?: string }> = {
  "--tl-bg": { from: "--dl-bg" },
  "--tl-surface": { from: "--dl-raised" },
  "--tl-sunken": { from: "--dl-sunken" },
  "--tl-border": { from: "--dl-border" },
  "--tl-text": { from: "--dl-text-1" },
  "--tl-text-2": { from: "--dl-text-2" },
  "--tl-text-3": { from: "--dl-text-3" },
  "--tl-accent": { from: "--dl-running" },
  "--tl-warn": { from: "--dl-needs" },
  "--tl-bad": { from: "--dl-error" },
  "--tl-font": { value: '"Inter", "Noto Sans JP", system-ui, -apple-system, sans-serif' },
  "--tl-mono": { value: '"JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace' },
};

/** 読めないとき（テスト・描画の前）の値（暗いテーマ） */
const FALLBACK: Record<string, string> = {
  "--dl-bg": "#0e0f11",
  "--dl-raised": "#18191c",
  "--dl-sunken": "#141518",
  "--dl-border": "#26282c",
  "--dl-text-1": "#e8e9eb",
  "--dl-text-2": "#9a9da3",
  "--dl-text-3": "#686c73",
  "--dl-running": "#4c8dff",
  "--dl-needs": "#f5a524",
  "--dl-error": "#f2555a",
};

export interface FigureTheme {
  scheme: "light" | "dark";
  vars: Record<string, string>;
}

/** 今の画面の色と文字（document が無ければ暗いテーマの既定） */
export function currentFigureTheme(): FigureTheme {
  const doc = typeof document === "undefined" ? null : document.documentElement;
  const cs = doc && typeof getComputedStyle === "function" ? getComputedStyle(doc) : null;
  const read = (name: string) => cs?.getPropertyValue(name).trim() || FALLBACK[name] || "";
  const vars: Record<string, string> = {};
  for (const k of ASK_FIGURE_VARS) {
    const s = SOURCES[k];
    vars[k] = s.value ?? read(s.from ?? "");
  }
  return { scheme: doc?.dataset.theme === "light" ? "light" : "dark", vars };
}

const URL_ATTRS =
  "href|xlink:href|src|srcset|action|formaction|ping|background|poster|data|codebase|cite";
const ATTR_RE = new RegExp(`\\s(${URL_ATTRS})\\s*=\\s*("[^"]*"|'[^']*'|[^\\s>]+)`, "gi");

/**
 * 外へ移る口を取り除く（念のため。止めるのは sandbox と CSP）。script・noscript・base・iframe・object・embed・meta の
 * http-equiv を消し、URL の属性は `#` と `data:image/` で始まるものだけ残す。イベントの属性（on…）も消す
 */
export function sanitizeFigure(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<(script|noscript|base|iframe|frame|object|embed|link|portal)\b[^>]*>/gi, "")
    .replace(/<\/(noscript|iframe|frame|object|portal)\s*>/gi, "")
    .replace(/<meta\b[^>]*http-equiv[^>]*>/gi, "")
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(ATTR_RE, (all, _name: string, raw: string) => {
      const v = raw
        .replace(/^["']|["']$/g, "")
        .trim()
        .toLowerCase();
      return v.startsWith("#") || v.startsWith("data:image/") ? all : "";
    });
}

/** 枠に入れる文書（CSP の meta を先頭に、色と文字の変数、図の中身） */
export function figureSrcdoc(html: string, theme: FigureTheme = currentFigureTheme()): string {
  const vars = Object.entries(theme.vars)
    .map(([k, v]) => `${k}:${v.replace(/[;{}<>]/g, "")}`)
    .join(";");
  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${FIGURE_CSP}">` +
    `<style>:root{${vars};color-scheme:${theme.scheme}}` +
    "html,body{margin:0;background:transparent;color:var(--tl-text);font:13px/1.5 var(--tl-font)}" +
    "body{padding:8px}svg{max-width:100%;height:auto}a{pointer-events:none}</style>" +
    `</head><body>${sanitizeFigure(html)}</body></html>`
  );
}
