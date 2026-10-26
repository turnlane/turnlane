/**
 * 見出しの「期限切れ N」の内訳（R79）の画像を dev-board（一時 HOME・偽の時計・ダミーデータ）だけで撮る。
 * 実データ・オーナーのデーモン（7317）・launchd・実のカレンダー・通知には触れない。
 *
 *   bun run build:web && bun scripts/screens-expired.ts <出力ディレクトリ> [--prefix after] [--web-dist <dir>]
 *     [--lang ja,en] [--theme light,dark]
 *
 * 場面（dev-board --design day --more-expired。今は 10/2（金）17:10、期限切れは 9:00 と 13:20 の 2 件）:
 * - 01 3日ボードの今日の列の見出しの「期限切れ 2」にマウスを乗せたところ
 * - 02 「期限切れ 2」を押した後（デイビューの右の一覧の「今日閉じた」の期限切れの行を強調）
 * - 03 デイビューの上部の「放置」にマウスを乗せたところ
 * 比べる前の画像は、前の版でビルドした Web を --web-dist に渡し --prefix before で撮る（前の版は押しても移らない）。
 * WebKit（デスクトップアプリの WKWebView と同じエンジン）・2倍
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { type Browser, type Page, webkit } from "playwright";

const ROOT = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
const out = resolve(args[0] && !args[0].startsWith("--") ? args[0] : "out/expired");
const opt = (k: string) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : undefined;
};
const list = (k: string, d: string) => (opt(k) ?? d).split(",");
const LANGS = list("--lang", "ja") as ("ja" | "en")[];
const THEMES = list("--theme", "light,dark") as ("light" | "dark")[];
const PREFIX = opt("--prefix") ?? "after";
const WEB = opt("--web-dist");
mkdirSync(out, { recursive: true });

interface Board {
  url: string;
  api: <T>(method: string, path: string, body?: unknown) => Promise<T>;
  stop: () => Promise<void>;
}

function freePort(): number {
  const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const p = s.port;
  s.stop(true);
  return p;
}

/** dev-board を起動する（scripts/screens-focus.ts と同じ） */
async function startBoard(extra: string[]): Promise<Board> {
  const port = freePort();
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
    if (done)
      throw new Error(`dev-board exited:\n${text}\n${await new Response(proc.stderr).text()}`);
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

let browser: Browser;

async function open(b: Board, path: string, theme: "light" | "dark"): Promise<Page> {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: theme,
    timezoneId: "Asia/Tokyo",
  });
  await page.goto(b.url.replace(/next=[^&]*/, `next=${encodeURIComponent(path)}`));
  await page.waitForSelector('[data-testid="totals"], [data-testid="day-totals"]', {
    timeout: 20000,
  });
  await page.waitForTimeout(1500);
  await page.mouse.move(0, 0);
  return page;
}

const name = (n: string, lang: string, theme: string) =>
  resolve(out, `${PREFIX}-${n}-${lang}-${theme}.png`);

/** 見出しの「期限切れ」（前の版は data-totals が無いので文字で探す） */
const expiredOf = (p: Page, scope: string, label: string) =>
  p.locator(`${scope} span, ${scope} button`).filter({ hasText: new RegExp(`^${label} \\d+$`) });

async function run(lang: "ja" | "en") {
  const b = await startBoard([
    "--design",
    "day",
    "--more-expired",
    "--lang",
    lang,
    ...(WEB ? ["--web-dist", WEB] : []),
  ]);
  const label = lang === "ja" ? "期限切れ" : "Expired";
  const idle = lang === "ja" ? "放置" : "Idle";
  try {
    for (const theme of THEMES) {
      await b.api("PUT", "/settings/ui", { theme, language: lang });
      const p = await open(b, "/board", theme);
      const item = expiredOf(p, '[data-testid="totals"]', label).last();
      await item.hover();
      await p.waitForTimeout(1200);
      await p.screenshot({
        path: name("01-board-hover", lang, theme),
        clip: { x: 0, y: 0, width: 1440, height: 420 },
      });
      await item.click();
      await p.waitForTimeout(500);
      await p.mouse.move(0, 0);
      await p.waitForTimeout(150);
      await p.screenshot({ path: name("02-after-click", lang, theme) });
      // デイビューの上部の「放置」
      if (!p.url().includes("/day")) {
        await p.goto(b.url.replace(/next=[^&]*/, "next=%2Fday"));
        await p.waitForSelector('[data-testid="day-totals"]', { timeout: 20000 });
        await p.waitForTimeout(1500);
      }
      await p.waitForTimeout(1700);
      const idleItem = p
        .locator('[data-testid="day-totals"] span, [data-testid="day-totals"] button')
        .filter({ hasText: new RegExp(`^${idle} `) })
        .last();
      await idleItem.hover();
      await p.waitForTimeout(1200);
      await p.screenshot({
        path: name("03-day-idle-hover", lang, theme),
        clip: { x: 0, y: 0, width: 1440, height: 420 },
      });
      await p.close();
    }
  } finally {
    await b.stop();
  }
}

browser = await webkit.launch();
try {
  for (const lang of LANGS) await run(lang);
} finally {
  await browser.close();
}
console.log(`wrote ${out}`);
