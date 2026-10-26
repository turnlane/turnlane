/**
 * PR をマージした後に同じセッションで別の作業を頼んだときの件名（fix-stale-title）の比較画像を、dev-board（一時 HOME・
 * 偽の時計・ダミーデータ）だけで撮る。実データ・オーナーのデーモン（7317）・launchd・実のカレンダー・通知には触れない。
 *
 *   bun run build:web && bun scripts/screens-stale-title.ts <出力ディレクトリ> [--prefix before] [--lang ja] [--design pr-question]
 *
 * `--design pr-question` は PR のあるブランチで別のセッションが問いで止まった場面（fix-pr-link）。`--design pr-subject` は
 * 件名が PR の題名になる場面（ターンの無い PR のカード。fix-subject-pr）。
 *
 * 場面: panel（AI の詳細パネル）、lane-hover（3日ボードの AI の線のホバー）、day-hover（デイビューの AI の線のホバー）、
 * queue（自分の番の画面と詳細）、tray（メニューバー）
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { type Page, webkit } from "playwright";

const ROOT = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
const out = resolve(args[0] && !args[0].startsWith("--") ? args[0] : "out/stale-title");
const opt = (k: string, d: string) => {
  const i = args.indexOf(k);
  return i >= 0 ? (args[i + 1] ?? d) : d;
};
const prefix = opt("--prefix", "after");
const lang = opt("--lang", "ja") as "ja" | "en";
const design = opt("--design", "stale-title");
mkdirSync(out, { recursive: true });

function freePort(): number {
  const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const p = s.port;
  s.stop(true);
  return p;
}

const port = freePort();
const proc = Bun.spawn(
  ["bun", "scripts/dev-board.ts", "--port", String(port), "--design", design, "--lang", lang],
  { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
);
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
const boardUrl = url;

const browser = await webkit.launch();
const shot = (n: string) => resolve(out, `${prefix}-${n}.png`);
async function open(path: string, width = 1440, height = 900): Promise<Page> {
  const page = await browser.newPage({
    viewport: { width, height },
    deviceScaleFactor: 2,
    colorScheme: "light",
    timezoneId: "Asia/Tokyo",
  });
  await page.goto(boardUrl.replace(/next=[^&]*/, `next=${encodeURIComponent(path)}`));
  await page.waitForSelector('[data-kind="turn"], [data-kind="ai"], h1', { timeout: 20000 });
  await page.waitForTimeout(1500);
  await page.mouse.move(0, 0);
  return page;
}
const lane = (p: Page) => p.locator('[data-kind="ai"]', { hasText: "" }).last();
try {
  let p = await open("/board");
  // AI の線（docs-site の項目は最後に動いたもの）
  const bar = p.locator('[data-kind="ai"]').last();
  await bar.hover();
  await p.waitForTimeout(500);
  const tip = await p.locator('[data-testid="ai-hover"]').boundingBox();
  if (tip)
    await p.screenshot({
      path: shot("lane-hover"),
      clip: { x: tip.x - 40, y: tip.y - 20, width: tip.width + 80, height: tip.height + 40 },
    });
  await p.mouse.move(0, 0);
  await bar.click();
  await p.waitForTimeout(1200);
  const panel = await p.locator('[data-testid="ai-panel"]').boundingBox();
  if (panel)
    await p.screenshot({
      path: shot("panel"),
      clip: { x: panel.x, y: panel.y, width: panel.width, height: Math.min(panel.height, 620) },
    });
  await p.screenshot({ path: shot("board") });
  await p.close();
  p = await open("/day");
  const dbar = lane(p);
  await dbar.hover();
  await p.waitForTimeout(500);
  const dtip = await p.locator('[data-testid="ai-hover"]').boundingBox();
  if (dtip)
    await p.screenshot({
      path: shot("day-hover"),
      clip: { x: dtip.x - 40, y: dtip.y - 20, width: dtip.width + 80, height: dtip.height + 40 },
    });
  await p.close();
  p = await open("/queue");
  await p.locator('[data-kind="turn"]').first().click();
  await p.waitForTimeout(900);
  await p.mouse.move(0, 0);
  await p.screenshot({ path: shot("queue") });
  await p.close();
  p = await open("/tray", 360, 420);
  await p.screenshot({ path: shot("tray") });
  await p.close();
} finally {
  await browser.close();
  proc.kill("SIGTERM");
  await proc.exited;
}
console.log(`wrote ${out}`);
