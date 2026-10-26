/**
 * デモ動画（M6-30）の場面 (1)(2) を dev-board（一時 HOME・偽の時計・ダミーデータ）だけで録る（docs/dev/demo-video.md）。
 * 実データ・オーナーのデーモン（7317）・launchd・実のカレンダー・通知には触れない。
 *
 *   bun run build:web && bun scripts/demo-record.ts --lang ja|en [--out <dir>] [--notify 15] [--fps 12]
 *
 * dev-board を `--design demo --theme dark --demo-notify <秒>` で起動し、Chromium（1440×900・2 倍）で 3日ボードを開く。
 * Playwright の recordVideo（VP8）は文字が甘くなるので、page.screenshot（2880×1800 の PNG）を一定の間隔で撮って並べる
 * （絵コンテ §6.2 の注記）。dev-board の `demo: added a new approval request` の行を受け取った時刻を合図とし、
 * 0.0 = 合図の 7.5 秒前 になるよう各フレームの時刻を付け直す。合図から 10.5 秒後（17.5 + 余り）まで撮る。
 *
 * 出力（既定 out/demo/rec/<lang>/。リポジトリの外に置くなら --out）: frames/NNNNN.png と timeline.json
 * （{ lang, fps, frames: [{ file, t }] }。t は 0.0 からの秒。0.0 より前のフレームも 1 枚残す）。
 * カーソルは出さない（page.mouse を使わない）。
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { SCENE12_END, SIGNAL_AT } from "./demo/plan.ts";

const ROOT = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
const opt = (k: string) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : undefined;
};
const lang = opt("--lang");
if (lang !== "ja" && lang !== "en") throw new Error("--lang ja|en");
const out = resolve(opt("--out") ?? join(ROOT, "out/demo/rec"), lang);
const notifyAfter = Number(opt("--notify") ?? 15);
const fps = Number(opt("--fps") ?? 12);
/** 合図の後に撮る秒（場面 (2) の終わり 17.5 に少し余りを足す） */
const AFTER = SCENE12_END - SIGNAL_AT + 0.5;

function freePort(): number {
  const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const p = s.port;
  s.stop(true);
  return p;
}

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "frames"), { recursive: true });

const port = freePort();
const proc = Bun.spawn(
  [
    "bun",
    "scripts/dev-board.ts",
    "--port",
    String(port),
    "--design",
    "demo",
    "--lang",
    lang,
    "--theme",
    "dark",
    "--demo-notify",
    String(notifyAfter),
  ],
  { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
);
void new Response(proc.stderr).text().catch(() => {});
let url: string | null = null;
/** 合図の時刻（performance.now()） */
let signalAt: number | null = null;
/** 合図の時刻を読む（コールバックで書き換わるので、読むたびに関数を通す） */
const signal = (): number | null => signalAt;
let text = "";
const ready = Promise.withResolvers<string>();
void (async () => {
  const reader = proc.stdout.getReader();
  const dec = new TextDecoder();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    text += dec.decode(value);
    if (!url) {
      url = /^(http:\/\/127\.0\.0\.1:\d+\/auth\?t=\S+)$/m.exec(text)?.[1] ?? null;
      if (url) ready.resolve(url);
    }
    if (signalAt === null && text.includes("demo: added a new approval request"))
      signalAt = performance.now();
  }
  ready.reject(new Error(`dev-board exited:\n${text}`));
})();

const browser = await chromium.launch();
try {
  const start = await Promise.race([
    ready.promise,
    Bun.sleep(60_000).then(() => {
      throw new Error("dev-board did not start");
    }),
  ]);
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: "dark",
    reducedMotion: "no-preference",
    timezoneId: "Asia/Tokyo",
  });
  const page = await ctx.newPage();
  await page.goto(start);
  await page.waitForSelector('[data-testid="week-board"]', { timeout: 15_000 });
  // AI のレーンのブロックが 3 つ見えるまで（読み込み中の表示が残らないように）
  await page.waitForFunction(`document.querySelectorAll('[data-kind="ai"]').length >= 3`, null, {
    timeout: 15_000,
  });
  // 時間軸をいちばん下までスクロール（0:00〜24:00 の 1200px なので上端は 10:20 ごろ。今の線 15:20 と AI の 3 本が
  // 帯の下に入る。scripts/demo/plan.ts の F2）。scripts の tsconfig は DOM の型を持たないので文字列で渡す
  await page.evaluate(`(() => {
    const sc = document.querySelector('[data-testid="board-scroll"]');
    sc.scrollTop = sc.scrollHeight;
  })()`);
  await page.waitForTimeout(800);
  if (signal() !== null)
    throw new Error("the signal came before the board was ready: raise --notify");

  const frames: { file: string; at: number }[] = [];
  const interval = 1000 / fps;
  let n = 0;
  for (;;) {
    const t0 = performance.now();
    const s = signal();
    if (s !== null && t0 > s + AFTER * 1000) break;
    const file = `frames/${String(n++).padStart(5, "0")}.png`;
    await page.screenshot({ path: join(out, file), caret: "hide" });
    frames.push({ file, at: t0 });
    const wait = interval - (performance.now() - t0);
    if (wait > 0) await Bun.sleep(wait);
  }
  const sig = signal();
  if (sig === null) throw new Error("no signal");
  const zero = sig - SIGNAL_AT * 1000;
  // 0.0 より前は直前の 1 枚だけ残す（0.0 の絵にする）
  const firstIn = frames.findIndex((f) => f.at >= zero);
  if (firstIn <= 0)
    throw new Error(
      `not enough lead-in before the signal (${((sig - (frames[0]?.at ?? sig)) / 1000).toFixed(1)}s): raise --notify`,
    );
  const kept = frames.slice(firstIn - 1);
  for (const f of frames.slice(0, firstIn - 1)) rmSync(join(out, f.file));
  const timeline = {
    lang,
    fps,
    size: { width: 2880, height: 1800 },
    frames: kept.map((f) => ({ file: f.file, t: Math.round(f.at - zero) / 1000 })),
  };
  writeFileSync(join(out, "timeline.json"), `${JSON.stringify(timeline, null, 1)}\n`);
  const span = (kept.at(-1)?.at ?? 0) - (kept[0]?.at ?? 0);
  console.log(
    `wrote ${kept.length} frames (${((kept.length - 1) / (span / 1000)).toFixed(1)} fps) to ${out}`,
  );
} finally {
  await browser.close();
  proc.kill("SIGTERM");
  await proc.exited;
}
