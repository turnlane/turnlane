/**
 * 集中モード中の帯（ux-mvp 4.15、design README R18・WD4）の画像を dev-board（一時 HOME・偽の時計・ダミーデータ）だけで撮る。
 * 実データ・オーナーのデーモン（7317）・launchd・実のカレンダー・通知には触れない。
 *
 *   bun run build:web && bun scripts/screens-focus.ts <出力ディレクトリ> [--lang ja,en] [--theme light,dark]
 *
 * 場面（今は 10/2（金）13:20 の dev-board の既定のデータ）:
 * - 01 会議由来の集中（13:30–14:00 のダミーの予定。問いに「集中する」で答える）の 3 日ボード、02 同じ状態のメニューバー
 *   （/tray）。起動の 15 秒後に許可待ちを 1 件足す（--demo-notify）ので、止めた通知が 1 件になる
 * - 03 手動の集中（1時間）の 3 日ボード、04 同じ状態のメニューバー（止めた通知は 0 件）、05 サイドバーを畳んだ 3 日ボード
 * WebKit（デスクトップアプリの WKWebView と同じエンジン）・2倍
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { type Browser, type Page, webkit } from "playwright";
import type { FocusView } from "../packages/core/src/api/index.ts";

const ROOT = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
const out = resolve(args[0] && !args[0].startsWith("--") ? args[0] : "out/focus");
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

/** dev-board を起動する（scripts/screens-away.ts と同じ） */
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
  await page.waitForSelector('[data-testid="focus-bar"], [data-testid="tray-focus-active"]', {
    timeout: 20000,
  });
  await page.waitForTimeout(1500);
  await page.mouse.move(0, 0);
  return page;
}

const name = (n: string, lang: string, theme: string) => resolve(out, `${n}-${lang}-${theme}.png`);

async function until<T>(f: () => Promise<T>, ok: (v: T) => boolean, ms = 20000): Promise<T> {
  const end = Date.now() + ms;
  let v = await f();
  while (!ok(v) && Date.now() < end) {
    await Bun.sleep(300);
    v = await f();
  }
  return v;
}

async function shoot(b: Board, lang: "ja" | "en", prefix: [string, string], rail = false) {
  for (const theme of THEMES) {
    const o = { lang, theme };
    let p = await open(b, "/board", { ...o, width: 1440, height: 900 });
    await p.screenshot({
      path: name(prefix[0], lang, theme),
      clip: { x: 0, y: 0, width: 1440, height: 420 },
    });
    if (rail) {
      await p.keyboard.press("Meta+Backslash");
      await p.waitForTimeout(500);
      await p.screenshot({
        path: name("05-board-rail", lang, theme),
        clip: { x: 0, y: 0, width: 1440, height: 420 },
      });
      await p.keyboard.press("Meta+Backslash");
      await p.waitForTimeout(300);
    }
    await p.close();
    p = await open(b, "/tray", { ...o, width: 360, height: 560 });
    await p.screenshot({ path: name(prefix[1], lang, theme) });
    await p.close();
  }
}

async function run(lang: "ja" | "en") {
  const b = await startBoard(["--lang", lang, "--demo-notify", "15"]);
  try {
    // 会議由来: 問いを開いて「集中する」で答える
    await b.api("PUT", "/settings/ui", { focusLeadMin: 30, focusTarget: "busy" });
    await b.api("POST", "/calendar-events", {
      title: lang === "ja" ? "定例" : "Team sync",
      start: Date.parse("2026-10-02T13:30:00+09:00"),
      end: Date.parse("2026-10-02T14:00:00+09:00"),
    });
    const v = await until(
      () => b.api<FocusView>("GET", "/focus"),
      (x) => x.prompt !== null,
    );
    if (!v.prompt) throw new Error("no focus prompt");
    await b.api("POST", "/focus/prompt", { key: v.prompt.key, answer: "focus" });
    // 許可待ち（起動の 15 秒後）が集中中に止められるのを待つ
    await until(
      () => b.api<FocusView & { held?: number }>("GET", "/focus"),
      (x) => (x.held ?? 0) > 0,
      25000,
    );
    await shoot(b, lang, ["01-board-meeting", "02-tray-meeting"]);
    // 手動
    await b.api("POST", "/focus/end");
    await b.api("POST", "/focus/start", { minutes: 60 });
    await shoot(b, lang, ["03-board-manual", "04-tray-manual"], true);
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
