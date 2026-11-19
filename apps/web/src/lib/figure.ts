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
 * - 案の図は「図の大きさ」（figureCanvas。書いてある幅と高さ、SVG の viewBox、無ければ 480×320）の文書として描き、枠ごと
 *   CSS の transform で置き場所に合わせて拡大・縮小する（components/FigureFrame.tsx。240×160 で描いた固定の px の図も
 *   広げた画面のカードの幅いっぱいに大きくなる）。説明の頁は枠の幅で流れて中でスクロールする
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

/** 図を描く大きさの既定（スキル・ツールの説明の案内と同じ 480×320。3:2） */
export const FIGURE_CANVAS = { width: 480, height: 320 } as const;

/**
 * 図の大きさ（図を描いた大きさ。枠はこの大きさで描いてから、置き場所の大きさに合わせて拡大・縮小する）。root は図の一番外の
 * 要素が SVG か。from: size（幅と高さを書いてある）・viewBox（SVG の viewBox の縦横比で、幅は既定）・default（分からない）
 */
export interface FigureCanvas {
  width: number;
  height: number;
  root: "svg" | "html";
  from: "size" | "viewBox" | "default";
}

const MIN_SIDE = 16;
const MAX_SIDE = 4000;

/** 長さ（px か単位なし）。% や em などは分からない（null） */
function px(v: string | undefined, unitless: boolean): number | null {
  if (v === undefined) return null;
  const m = (unitless ? /^\s*(\d+(?:\.\d+)?)\s*(px)?\s*$/i : /^\s*(\d+(?:\.\d+)?)\s*px\s*$/i).exec(
    v,
  );
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** 宣言の並び（style 属性・CSS の規則の中身）から width と height（px） */
function declSize(decls: string): { w: number | null; h: number | null } {
  const get = (name: string) =>
    px(new RegExp(`(?:^|[;{\\s])${name}\\s*:\\s*([^;}!]+)`, "i").exec(decls)?.[1], false);
  return { w: get("width"), h: get("height") };
}

function attrsOf(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of raw.matchAll(/([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>"']+))/g)) {
    const k = (m[1] ?? "").toLowerCase();
    if (!(k in out)) out[k] = m[3] ?? m[4] ?? m[5] ?? "";
  }
  return out;
}

/**
 * 図の大きさを中身の文字から読む（純粋関数。図の枠は sandbox でスクリプトも同じオリジンも無いので、描いた後の大きさは親から
 * 測れない）。一番外の要素（doctype・コメント・head・style・meta は飛ばす）の幅と高さを、style 属性 → `<style>` の規則
 * （その要素の名前・class・id だけの単純なセレクタ。body の規則も見る）→ 属性（width・height）の順に見る。
 * SVG で幅か高さが無ければ viewBox の縦横比を使う。どれも無ければ既定（480×320）。幅だけなら高さは 3:2
 */
export function figureCanvas(html: string): FigureCanvas {
  const css = Array.from(html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi), (m) => m[1] ?? "")
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  const rest = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(style|title|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<\/?(html|head|body)\b[^>]*>/gi, (all) =>
      all.toLowerCase().startsWith("<body") ? all : "",
    )
    .replace(/<[!?][^>]*>/g, "")
    .replace(/<meta\b[^>]*>/gi, "");
  const body = /<body\b([^>]*)>/i.exec(rest);
  const first = /<([a-zA-Z][\w-]*)\b([^>]*)>/.exec(rest.replace(/<body\b[^>]*>/gi, ""));
  const tag = (first?.[1] ?? "").toLowerCase();
  const root: FigureCanvas["root"] = tag === "svg" ? "svg" : "html";
  const fallback: FigureCanvas = { ...FIGURE_CANVAS, root, from: "default" };
  if (!first) return fallback;
  const a = attrsOf(first[2] ?? "");
  // 規則（後のものが勝つ）
  const rules = (selectors: string[]) => {
    let w: number | null = null;
    let h: number | null = null;
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const sels = (m[1] ?? "").split(",").map((x) => x.trim().toLowerCase());
      if (!sels.some((x) => selectors.includes(x))) continue;
      const d = declSize(m[2] ?? "");
      w = d.w ?? w;
      h = d.h ?? h;
    }
    return { w, h };
  };
  const classes = (a.class ?? "").split(/\s+/).filter(Boolean);
  const sels = [tag, ...classes.flatMap((c) => [`.${c}`, `${tag}.${c}`])];
  if (a.id) sels.push(`#${a.id}`, `${tag}#${a.id}`);
  const fromCss = rules(sels.map((x) => x.toLowerCase()));
  const inline = declSize(a.style ?? "");
  let w = inline.w ?? fromCss.w ?? px(a.width, true);
  let h = inline.h ?? fromCss.h ?? px(a.height, true);
  if (w === null && h === null) {
    const b = declSize(attrsOf(body?.[1] ?? "").style ?? "");
    const br = rules(["body"]);
    w = b.w ?? br.w;
    h = b.h ?? br.h;
  }
  let from: FigureCanvas["from"] = "size";
  if (root === "svg" && (w === null || h === null)) {
    const vb = (a.viewbox ?? "")
      .trim()
      .split(/[\s,]+/)
      .map(Number);
    const [, , vw, vh] = vb;
    if (vb.length === 4 && vw !== undefined && vh !== undefined && vw > 0 && vh > 0) {
      if (w !== null) h = (w * vh) / vw;
      else if (h !== null) w = (h * vw) / vh;
      else {
        w = FIGURE_CANVAS.width;
        h = (w * vh) / vw;
        from = "viewBox";
      }
    }
  }
  if (w !== null && h === null) h = (w * FIGURE_CANVAS.height) / FIGURE_CANVAS.width;
  if (h !== null && w === null) w = (h * FIGURE_CANVAS.width) / FIGURE_CANVAS.height;
  if (w === null || h === null) return fallback;
  const clamp = (n: number) => Math.round(Math.min(MAX_SIDE, Math.max(MIN_SIDE, n)));
  return { width: clamp(w), height: clamp(h), root, from };
}

/**
 * 図の大きさを置き場所に収める（縦横比を保って、はみ出さない一番大きい倍率。真ん中に置く）。置き場所の大きさが 0 なら null
 */
export function fitCanvas(
  box: { width: number; height: number },
  canvas: { width: number; height: number },
): { scale: number; x: number; y: number } | null {
  if (box.width <= 0 || box.height <= 0) return null;
  const scale = Math.min(box.width / canvas.width, box.height / canvas.height);
  return {
    scale,
    x: (box.width - canvas.width * scale) / 2,
    y: (box.height - canvas.height * scale) / 2,
  };
}

/** 枠に入れる文書（CSP の meta を先頭に、色と文字の変数、図の中身） */
export function figureSrcdoc(
  html: string,
  theme: FigureTheme = currentFigureTheme(),
  opts: { canvas?: FigureCanvas } = {},
): string {
  const vars = Object.entries(theme.vars)
    .map(([k, v]) => `${k}:${v.replace(/[;{}<>]/g, "")}`)
    .join(";");
  const c = opts.canvas;
  // 図（canvas）: 図の大きさの文書。余白を付けず、はみ出しは切る。一番外の SVG はその大きさいっぱいに描く（viewBox で伸びる）。
  // 説明の頁: 枠の幅で流れて中でスクロールする
  const layout = c
    ? `html,body{width:${c.width}px;height:${c.height}px;overflow:hidden}body{padding:0}` +
      (c.root === "svg"
        ? "body>svg:first-of-type{display:block;width:100%;height:100%;max-width:none}"
        : "")
    : "body{padding:8px}svg{max-width:100%;height:auto}";
  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${FIGURE_CSP}">` +
    `<style>:root{${vars};color-scheme:${theme.scheme}}` +
    "html,body{margin:0;background:transparent;color:var(--tl-text);font:13px/1.5 var(--tl-font)}" +
    "a{pointer-events:none}" +
    layout +
    "</style>" +
    `</head><body>${sanitizeFigure(html)}</body></html>`
  );
}
