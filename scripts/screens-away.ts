/**
 * 離れていた間のまとめ（D-214 (2)、ux-mvp 4.13）の画像を dev-board（一時 HOME・偽の時計・ダミーデータ）だけで撮る。
 * 実データ・オーナーのデーモン（7317）・launchd・実のカレンダー・通知には触れない。
 *
 *   bun run build:web && bun scripts/screens-away.ts <出力ディレクトリ> [--lang ja,en] [--theme light,dark]
 *
 * 場面: 01 メニューバー（畳んだ 1 行）、02 メニューバー（開いた一覧）、03 今日の列の帯の見出し（畳んだ・開いた）、
 * 04 デイビュー（離席の区間の背景と、その間に変わった線）、05 夜をまたいだ離席（メニューバー・帯）、06 設定の切り替え。
 * WebKit（デスクトップアプリの WKWebView と同じエンジン）・2倍
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { type Browser, type Page, webkit } from "playwright";

const ROOT = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
const out = resolve(args[0] && !args[0].startsWith("--") ? args[0] : "out/away");
const list = (k: string, d: string) => {
  const i = args.indexOf(k);
  return (i >= 0 ? (args[i + 1] ?? d) : d).split(",");
};
const LANGS = list("--lang", "ja,en") as ("ja" | "en")[];
const THEMES = list("--theme", "light") as ("light" | "dark")[];
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

/** dev-board を起動する（scripts/screens-readme.ts と同じ） */
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

async function open(
  b: Board,
  path: string,
  o: { lang: "ja" | "en"; theme: "light" | "dark"; width: number; height: number },
): Promise<Page> {
  await b.api("PUT", "/settings/ui", { theme: o.theme, language: o.lang });
  const page = await browser.newPage({
    viewport: { width: o.width, height: o.height },
    deviceScaleFactor: 2,
    colorScheme: o.theme,
    timezoneId: "Asia/Tokyo",
  });
  await page.goto(b.url.replace(/next=[^&]*/, `next=${encodeURIComponent(path)}`));
  await page.waitForSelector(
    '[data-testid="away-line"], [data-testid="away-shade"], [data-testid="settings-search"], h1',
    {
      timeout: 20000,
    },
  );
  await page.waitForTimeout(1500);
  await page.mouse.move(0, 0);
  return page;
}

const name = (n: string, lang: string, theme: string) => resolve(out, `${n}-${lang}-${theme}.png`);

async function expand(page: Page) {
  await page.locator('[data-testid="away-line"]').first().click();
  await page.waitForTimeout(400);
  await page.mouse.move(0, 0);
}

async function day(lang: "ja" | "en") {
  const b = await startBoard(["--design", "away", "--lang", lang]);
  try {
    for (const theme of THEMES) {
      const o = { lang, theme };
      let p = await open(b, "/tray", { ...o, width: 360, height: 560 });
      await p.screenshot({ path: name("01-menubar-collapsed", lang, theme) });
      await expand(p);
      await p.screenshot({ path: name("02-menubar-expanded", lang, theme) });
      await p.close();
      p = await open(b, "/board", { ...o, width: 1440, height: 900 });
      await p.screenshot({ path: name("03-band-collapsed", lang, theme) });
      await expand(p);
      await p.screenshot({ path: name("03-band-expanded", lang, theme) });
      await p.close();
      p = await open(b, "/day", { ...o, width: 1440, height: 900 });
      // 離席の区間（17:14〜17:48）が見える位置まで
      await p
        .locator('[data-testid="away-shade"]')
        .first()
        .evaluate((el) =>
          (el as unknown as { scrollIntoView(o: unknown): void }).scrollIntoView({
            block: "center",
          }),
        );
      await p.waitForTimeout(400);
      await p.screenshot({ path: name("04-day-shade", lang, theme) });
      await p.close();
      p = await open(b, "/settings#turn", { ...o, width: 1440, height: 900 });
      await p.screenshot({ path: name("06-settings-turn", lang, theme) });
      await p.close();
    }
  } finally {
    await b.stop();
  }
}

async function night(lang: "ja" | "en") {
  const b = await startBoard(["--design", "away-night", "--lang", lang]);
  try {
    for (const theme of THEMES) {
      const o = { lang, theme };
      let p = await open(b, "/tray", { ...o, width: 360, height: 560 });
      await expand(p);
      await p.screenshot({ path: name("05-overnight-menubar", lang, theme) });
      await p.close();
      p = await open(b, "/board", { ...o, width: 1440, height: 900 });
      await p.screenshot({ path: name("05-overnight-band", lang, theme) });
      await p.close();
    }
  } finally {
    await b.stop();
  }
}

browser = await webkit.launch();
try {
  for (const lang of LANGS) {
    await day(lang);
    await night(lang);
  }
} finally {
  await browser.close();
}
console.log(`wrote ${out}`);
