/**
 * 図つきの問い（ADR 0022。ux-mvp 4.23）の広げた画面の画像を dev-board（一時 HOME・偽の時計・ダミーデータ）だけで撮る。
 * 実データ・オーナーのデーモン（7317）・launchd には触れない。問いは e2e と同じく HTTP で開く（図はすべて合成のダミー）。
 *
 *   bun run build:web && bun scripts/screens-ask.ts <出力ディレクトリ> [--lang ja,en] [--theme light,dark]
 *
 * 場面（幅 1700 と 1000 で）:
 * - ask3-full: 3 案（固定の px の HTML の画面の図 240×160・SVG の viewBox の図・width と height の付いた SVG）と説明の頁
 * - ask3-full-bottom: 同じ問いを下までスクロール（メモと返すボタンは下に固定のまま）
 * - ask2-full / ask4-full: 2 案・4 案
 * - ask3-panel: パネルの節（小さな図と右下の「大きく」の印）。ask3-figure: 案の図 1 枚
 * WebKit（デスクトップアプリの WKWebView と同じエンジン）・2倍
 */
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Page, webkit } from "playwright";

const ROOT = resolve(import.meta.dir, "..");

interface Board {
  url: string;
  api: <T>(method: string, path: string, body?: unknown) => Promise<T>;
  stop: () => Promise<void>;
}

/** dev-board を起動する（scripts/screens-answer.ts と同じ） */
async function startBoard(extra: string[]): Promise<Board> {
  const sock = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = sock.port;
  sock.stop(true);
  const proc = Bun.spawn(["bun", "scripts/dev-board.ts", "--port", String(port), ...extra], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = proc.stdout.getReader();
  const dec = new TextDecoder();
  let text = "";
  let url: string | null = null;
  const deadline = Date.now() + 90_000;
  while (!url) {
    if (Date.now() > deadline) throw new Error(`dev-board did not start:\n${text}`);
    const { value, done } = await reader.read();
    if (done) throw new Error(`dev-board exited:\n${text}`);
    text += dec.decode(value);
    url = /^(http:\/\/127\.0\.0\.1:\d+\/auth\?t=\S+)$/m.exec(text)?.[1] ?? null;
  }
  void (async () => {
    while (!(await reader.read()).done);
  })().catch(() => {});
  void new Response(proc.stderr).text().catch(() => {});
  const u = new URL(url);
  const token = u.searchParams.get("t") ?? "";
  const api = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const r = await fetch(`${u.origin}/api${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!r.ok) throw new Error(`${method} ${path}: ${r.status}`);
    return (await r.json()) as T;
  };
  return {
    url,
    api,
    stop: async () => {
      proc.kill("SIGTERM");
      await proc.exited;
    },
  };
}

const args = process.argv.slice(2);
const out = resolve(args[0] && !args[0].startsWith("--") ? args[0] : "out/ask");
const opt = (k: string) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : undefined;
};
const LANGS = (opt("--lang") ?? "ja").split(",") as ("ja" | "en")[];
const THEMES = (opt("--theme") ?? "dark,light").split(",") as ("light" | "dark")[];
const WIDTHS = [
  { width: 1700, height: 1000 },
  { width: 1000, height: 760 },
];
mkdirSync(out, { recursive: true });

const row = (y: number, w: number) =>
  `<div style="position:absolute;left:12px;top:${y}px;width:${w}px;height:10px;border-radius:3px;background:var(--tl-sunken);border:1px solid var(--tl-border)"></div>`;

/** 固定の px（240×160）の HTML で描いた画面の図（ボタン＋右のドロワー） */
const drawer = `<!doctype html><meta charset="utf-8"><style>.s{position:relative;width:240px;height:160px;box-sizing:border-box;border:1px solid var(--tl-border);border-radius:8px;background:var(--tl-surface);overflow:hidden;font:9px/1.3 var(--tl-font);color:var(--tl-text-2)}</style>
<div class="s"><div style="height:20px;border-bottom:1px solid var(--tl-border);display:flex;align-items:center;gap:6px;padding:0 8px"><b style="color:var(--tl-text)">一覧</b><span style="margin-left:auto;background:var(--tl-accent);color:#fff;border-radius:4px;padding:1px 5px">取り込む</span></div>
${row(30, 120)}${row(46, 120)}${row(62, 120)}${row(78, 120)}
<div style="position:absolute;right:0;top:20px;bottom:0;width:96px;border-left:2px solid var(--tl-accent);background:var(--tl-bg);padding:6px;box-sizing:border-box"><b style="color:var(--tl-text)">ドロワー</b><div style="margin-top:6px">① ファイル</div><div>② 照合</div><div style="color:var(--tl-warn)">③ 差分</div><div>④ 反映</div></div></div>`;

/** SVG の viewBox だけ（240×160 の座標）で描いた 2 画面と矢印 */
const pages = `<svg viewBox="0 0 240 160" xmlns="http://www.w3.org/2000/svg" font-family="var(--tl-font)">
<rect x="4" y="20" width="96" height="120" rx="6" fill="var(--tl-surface)" stroke="var(--tl-border)"/>
<rect x="12" y="30" width="60" height="10" rx="3" fill="var(--tl-text-3)"/>
<rect x="12" y="48" width="80" height="8" rx="3" fill="var(--tl-sunken)" stroke="var(--tl-border)"/>
<rect x="12" y="62" width="80" height="8" rx="3" fill="var(--tl-sunken)" stroke="var(--tl-border)"/>
<path d="M106 80 h24" stroke="var(--tl-accent)" stroke-width="3" marker-end="url(#a)"/>
<defs><marker id="a" viewBox="0 0 6 6" refX="3" refY="3" markerWidth="4" markerHeight="4" orient="auto"><path d="M0 0L6 3L0 6z" fill="var(--tl-accent)"/></marker></defs>
<rect x="140" y="12" width="96" height="136" rx="6" fill="var(--tl-surface)" stroke="var(--tl-accent)" stroke-width="2"/>
<text x="148" y="28" font-size="9" fill="var(--tl-text)">別ページ</text>
<rect x="148" y="38" width="80" height="22" rx="3" fill="var(--tl-sunken)"/>
<rect x="148" y="66" width="80" height="22" rx="3" fill="var(--tl-sunken)"/>
<rect x="148" y="94" width="80" height="22" rx="3" fill="var(--tl-sunken)"/>
</svg>`;

/** width・height（240×160）付きの SVG: 一覧の行に印と、右の詳細パネル */
const panel = `<svg width="240" height="160" viewBox="0 0 240 160" xmlns="http://www.w3.org/2000/svg">
<rect x="1" y="1" width="238" height="158" rx="8" fill="var(--tl-surface)" stroke="var(--tl-border)"/>
<g fill="var(--tl-sunken)" stroke="var(--tl-border)">
<rect x="10" y="20" width="130" height="16" rx="3"/><rect x="10" y="42" width="130" height="16" rx="3"/>
<rect x="10" y="64" width="130" height="16" rx="3"/><rect x="10" y="86" width="130" height="16" rx="3"/></g>
<rect x="100" y="45" width="34" height="10" rx="5" fill="var(--tl-warn)"/>
<rect x="148" y="10" width="84" height="140" rx="6" fill="var(--tl-bg)" stroke="var(--tl-accent)" stroke-width="2"/>
<rect x="156" y="22" width="56" height="8" rx="3" fill="var(--tl-text-2)"/>
<rect x="156" y="40" width="68" height="40" rx="3" fill="var(--tl-sunken)"/>
<rect x="176" y="128" width="48" height="14" rx="4" fill="var(--tl-accent)"/>
</svg>`;

/** 480×320 で描いた図（新しい案内どおり。大きな形を少し、小さな文字なし） */
const big = (accent: string) => `<svg viewBox="0 0 480 320" xmlns="http://www.w3.org/2000/svg">
<rect x="8" y="8" width="464" height="304" rx="16" fill="var(--tl-surface)" stroke="var(--tl-border)" stroke-width="2"/>
<rect x="32" y="36" width="200" height="28" rx="8" fill="var(--tl-text-3)"/>
<rect x="32" y="92" width="260" height="190" rx="12" fill="var(--tl-sunken)" stroke="var(--tl-border)" stroke-width="2"/>
<rect x="316" y="92" width="132" height="190" rx="12" fill="${accent}" opacity=".85"/>
</svg>`;

const explain = `<!doctype html><meta charset="utf-8"><div style="padding:16px 20px;max-width:900px">
<h2 style="margin:0 0 8px;font-size:18px">取り込みの入口と画面の流れ</h2>
<p style="color:var(--tl-text-2)">どの案でも「取り込み → 照合 → 差分を確認 → 反映」の流れは同じです。違うのは入口と、照合・差分を見せる場所です。</p>
<table style="border-collapse:collapse;width:100%;font-size:13px">
<tr><th style="text-align:left;padding:6px;border-bottom:1px solid var(--tl-border)"></th><th style="text-align:left;padding:6px;border-bottom:1px solid var(--tl-border)">A</th><th style="text-align:left;padding:6px;border-bottom:1px solid var(--tl-border)">B</th><th style="text-align:left;padding:6px;border-bottom:1px solid var(--tl-border)">C</th></tr>
<tr><td style="padding:6px">入口</td><td>ボタン</td><td>別ページ</td><td>行の印</td></tr>
<tr><td style="padding:6px">作る量</td><td>少ない</td><td>多い</td><td>中</td></tr>
</table>
<h3>おすすめ: A</h3><p style="color:var(--tl-text-2)">既存のドロワーをそのまま使え、差分の確認を 1 ステップ足すだけで済みます。</p>
${"<p style='color:var(--tl-text-3)'>（長い説明の頁の続き）</p>".repeat(12)}</div>`;

const ASKS = {
  ask3: {
    question: "取り込みの入口と画面の流れは、どの案で進めますか？",
    context:
      "流れはどの案でも「取り込み → 照合 → 差分を確認 → 反映」です。違うのは入口と、照合・差分を見せる場所です。",
    options: [
      {
        label: "A. ボタン＋右ドロワー",
        description: "ヘッダーのボタンから右ドロワーを開き、取り込み → 照合 → 差分 → 反映と進む。",
        recommended: true,
        figure: { html: drawer },
      },
      {
        label: "B. 受信一覧の別ページ",
        description: "届いた予定から別ページへ。1 件ずつ照合と差分を見て反映。",
        figure: { html: pages },
      },
      {
        label: "C. 一覧の行と詳細パネル",
        description: "届いた予定がある行に印を付け、詳細パネルで今の予定と比べて反映。",
        figure: { html: panel },
      },
    ],
    explain: { html: explain },
    cwd: "/fixture/elsewhere/import-flow",
  },
  ask2: {
    question: "設定画面の保存ボタンはどちらに置きますか？",
    context: "設定のフォームは 14 項目で、スマートフォンでは 3 画面ぶんの長さです。",
    options: [
      {
        label: "下に固定",
        description: "どこまでスクロールしても押せる。",
        recommended: true,
        figure: { html: big("var(--tl-accent)") },
      },
      {
        label: "右上（今のまま）",
        description: "画面の外に出る。",
        figure: { html: big("var(--tl-text-3)") },
      },
    ],
    explain: { html: explain },
    cwd: "/fixture/elsewhere/settings-save",
  },
  ask4: {
    question: "一覧の並べ方はどれにしますか？",
    context: "1 日に 40 件ほど届きます。",
    options: [
      {
        label: "新しい順",
        description: "届いた順。",
        recommended: true,
        figure: { html: big("var(--tl-accent)") },
      },
      { label: "利用者ごと", description: "利用者でまとめる。", figure: { html: pages } },
      {
        label: "未照合を先に",
        description: "照合が要るものを上に。",
        figure: { html: big("var(--tl-warn)") },
      },
      { label: "図なし", description: "図の無い案（文字だけのカード）。" },
    ],
    explain: { html: explain },
    cwd: "/fixture/elsewhere/list-order",
  },
} as const;

async function settle(page: Page, ms = 300) {
  await page.waitForTimeout(ms);
}

async function openAsk(board: Board, page: Page, workItemId: string) {
  await page.goto(board.url.replace(/next=[^&]*/, "next=%2Fqueue"));
  await page.waitForSelector('[data-kind="turn"]', { timeout: 15000 });
  await settle(page, 400);
  await page.locator(`[data-kind="turn"][data-id="${workItemId}"]`).first().click();
  await page.waitForSelector('[data-testid="ask"][data-state="open"]', { timeout: 5000 });
  await settle(page, 600);
}

const browser = await webkit.launch();
try {
  for (const lang of LANGS)
    for (const theme of THEMES) {
      const board = await startBoard(["--reports", "--lang", lang, "--theme", theme]);
      try {
        const ids: Record<string, string> = {};
        for (const [k, body] of Object.entries(ASKS)) {
          const c = await board.api<{ workItemId: string }>("POST", "/asks", body);
          ids[k] = c.workItemId;
        }
        for (const size of WIDTHS) {
          const page = await browser.newPage({
            viewport: size,
            deviceScaleFactor: 2,
            colorScheme: theme,
          });
          const tag = `${lang}-${theme}-${size.width}`;
          for (const k of Object.keys(ASKS)) {
            await openAsk(board, page, ids[k] ?? "");
            if (k === "ask3") await page.screenshot({ path: join(out, `${k}-panel-${tag}.png`) });
            await page.locator("body").click({ position: { x: 5, y: 5 } });
            await page.keyboard.press("1");
            await page.keyboard.press("f");
            await page.waitForSelector('[data-testid="ask-overlay"][data-view="full"]', {
              timeout: 3000,
            });
            await settle(page, 900);
            await page.screenshot({ path: join(out, `${k}-full-${tag}.png`) });
            if (k === "ask3") {
              await page
                .locator('[data-testid="ask-full-scroll"]')
                .evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
              await settle(page, 300);
              await page.screenshot({ path: join(out, `${k}-full-bottom-${tag}.png`) });
              await page
                .locator('[data-testid="ask-full-scroll"]')
                .evaluate((el) => el.scrollTo({ top: 0 }));
              await page
                .locator('[data-testid="ask-overlay"] [data-testid="ask-option-zoom"]')
                .first()
                .click();
              await page.waitForSelector('[data-testid="ask-overlay"][data-view="figure"]', {
                timeout: 3000,
              });
              await settle(page, 700);
              await page.screenshot({ path: join(out, `${k}-figure-${tag}.png`) });
              await page.keyboard.press("Escape");
            }
            await page.keyboard.press("Escape");
            await settle(page, 200);
          }
          await page.close();
        }
      } finally {
        await board.stop();
      }
    }
} finally {
  await browser.close();
}
console.log(out);
