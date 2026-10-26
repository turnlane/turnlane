/**
 * 待っている件の見え方（D-207、spec-glance §9）の比較画像を dev-board（一時 HOME・偽の時計・ダミーデータ）だけで撮る。
 * 実データ・オーナーのデーモン（7317）・launchd・実のカレンダー・通知には触れない。
 *
 *   bun run build:web && bun scripts/screens-glance.ts <出力ディレクトリ> [--lang ja,en] [--theme light,dark]
 *
 * 場面（ファイル名の頭の番号は spec-glance §9 の表）: 01 帯 1 行（1440）、02 帯 2 行（1024 と 1200 でパネルを開いた状態）、
 * 03 週表示の今日の列、04 自分の番の画面と詳細（許可待ち・回答待ち・エラー）、05 メニューバー（360）、06 ホバーの文
 * （OS のツールチップは画像に写らないので、行の title を文字で書き出す）、07 伏せ字と長いもの、08 読めなかったとき
 * （記録が消えた・Codex）、09 設定。WebKit（デスクトップアプリの WKWebView と同じエンジン）・2倍。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { type Browser, type Page, webkit } from "playwright";

const ROOT = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
const out = resolve(args[0] && !args[0].startsWith("--") ? args[0] : "out/glance");
const list = (k: string, d: string) => {
  const i = args.indexOf(k);
  return (i >= 0 ? (args[i + 1] ?? d) : d).split(",");
};
const LANGS = list("--lang", "ja,en") as ("ja" | "en")[];
const THEMES = list("--theme", "light,dark") as ("light" | "dark")[];
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
  o: { lang: "ja" | "en"; theme: "light" | "dark"; width: number; height: number; week?: boolean },
): Promise<Page> {
  await b.api("PUT", "/settings/ui", { theme: o.theme, language: o.lang });
  const page = await browser.newPage({
    viewport: { width: o.width, height: o.height },
    deviceScaleFactor: 2,
    colorScheme: o.theme,
    timezoneId: "Asia/Tokyo",
  });
  if (o.week) await page.addInitScript(`localStorage.setItem("turnlane.board.mode", "week")`);
  await page.goto(b.url.replace(/next=[^&]*/, `next=${encodeURIComponent(path)}`));
  await page.waitForSelector('[data-kind="turn"], [data-testid="settings-search"], h1', {
    timeout: 20000,
  });
  // 行が見えてから中身を読む（glance）。読み終わるまで待つ
  await page.waitForTimeout(1500);
  await page.mouse.move(0, 0);
  return page;
}

const name = (n: string, lang: string, theme: string) => resolve(out, `${n}-${lang}-${theme}.png`);

/** 自分の番の画面で行を選んで詳細を出す（件名の一部の文字で選ぶ） */
async function pick(page: Page, text: string) {
  await page.locator('[data-kind="turn"]', { hasText: text }).first().click();
  await page.waitForTimeout(900);
  await page.mouse.move(0, 0);
}

async function basic(lang: "ja" | "en") {
  const b = await startBoard(["--design", "glance", "--lang", lang]);
  const L = (ja: string, en: string) => (lang === "ja" ? ja : en);
  try {
    for (const theme of THEMES) {
      const o = { lang, theme };
      let p = await open(b, "/board", { ...o, width: 1440, height: 900 });
      await p.screenshot({ path: name("01-board-1line", lang, theme) });
      await p.close();
      p = await open(b, "/board", { ...o, width: 1024, height: 768 });
      await p.screenshot({ path: name("02-board-2line-1024", lang, theme) });
      await p.close();
      p = await open(b, "/board", { ...o, width: 1200, height: 800 });
      await p.locator('[data-kind="turn"]').first().dblclick();
      await p.waitForTimeout(900);
      await p.mouse.move(0, 0);
      await p.screenshot({ path: name("02-board-2line-1200-panel", lang, theme) });
      await p.close();
      p = await open(b, "/board", { ...o, width: 1440, height: 900, week: true });
      await p.screenshot({ path: name("03-week", lang, theme) });
      await p.close();
      p = await open(b, "/queue", { ...o, width: 1440, height: 900 });
      await pick(p, L("リフレッシュトークン", "refresh token"));
      await p.screenshot({ path: name("04-queue-approve", lang, theme) });
      await pick(p, L("デプロイの手順", "deploy steps"));
      await p.screenshot({ path: name("04-queue-answer", lang, theme) });
      await pick(p, L("締め日", "closing-date"));
      await p.screenshot({ path: name("04-queue-error", lang, theme) });
      await pick(p, L("列幅を直して", "column widths"));
      await p.screenshot({ path: name("04-queue-reply", lang, theme) });
      if (theme === THEMES[0]) {
        // 06 ホバーの文（OS のツールチップは画像に写らない）
        const titles = await p.locator('[data-kind="turn"]').evaluateAll(
          // scripts の tsconfig は DOM の型を持たない
          (els) => els.map((e) => (e as unknown as { title: string }).title),
        );
        writeFileSync(resolve(out, `06-hover-${lang}.txt`), `${titles.join("\n\n")}\n`);
      }
      await p.close();
      p = await open(b, "/tray", { ...o, width: 360, height: 520 });
      await p.screenshot({ path: name("05-menubar", lang, theme) });
      await p.close();
      p = await open(b, "/settings#turn", { ...o, width: 1440, height: 900 });
      await p.screenshot({ path: name("09-settings-turn", lang, theme) });
      await p.close();
      p = await open(b, "/settings#notify", { ...o, width: 1440, height: 900 });
      await p.screenshot({ path: name("09-settings-notify", lang, theme) });
      await p.close();
    }
  } finally {
    await b.stop();
  }
}

async function edge(lang: "ja" | "en") {
  const b = await startBoard(["--design", "glance-edge", "--lang", lang]);
  const L = (ja: string, en: string) => (lang === "ja" ? ja : en);
  try {
    for (const theme of THEMES) {
      const o = { lang, theme };
      let p = await open(b, "/queue", { ...o, width: 1440, height: 900 });
      await pick(p, L("課金 API", "charge API"));
      await p.screenshot({ path: name("07-masked-queue", lang, theme) });
      await pick(p, L("マイグレーション", "migration"));
      await p.screenshot({ path: name("07-long-command", lang, theme) });
      await pick(p, L("デプロイの設定", "deploy config"));
      await p.screenshot({ path: name("07-long-path", lang, theme) });
      // 記録が消えたので件名は自動の題名（ai-title）に落ちる
      await pick(p, "Docs links");
      await p.screenshot({ path: name("08-missing-queue", lang, theme) });
      if (theme === THEMES[0]) {
        const titles = await p
          .locator('[data-kind="turn"]')
          .evaluateAll((els) => els.map((e) => (e as unknown as { title: string }).title));
        writeFileSync(resolve(out, `06-hover-edge-${lang}.txt`), `${titles.join("\n\n")}\n`);
      }
      await p.close();
      p = await open(b, "/tray", { ...o, width: 360, height: 560 });
      await p.screenshot({ path: name("07-08-menubar", lang, theme) });
      await p.close();
      p = await open(b, "/board", { ...o, width: 1440, height: 900 });
      await p.screenshot({ path: name("07-08-board", lang, theme) });
      await p.close();
    }
  } finally {
    await b.stop();
  }
}

browser = await webkit.launch();
try {
  for (const lang of LANGS) {
    await basic(lang);
    await edge(lang);
  }
} finally {
  await browser.close();
}
console.log(`wrote ${out}`);
