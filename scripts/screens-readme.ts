/**
 * README の画面写真（M6-2、D-114）を dev-board（一時 HOME・偽の時計・ダミーデータ）だけで撮る。
 * 実データ・オーナーのデーモン（7317）・launchd・実のカレンダー・通知には触れない。
 *
 *   bun run build:web && bun scripts/screens-readme.ts [出力ディレクトリ] [--only board,your-turn,ai-detail]
 *
 * 出力（既定は docs/assets/）: board.png（3日ボード）、your-turn.png（自分の番）、ai-detail.png（AI の詳細パネル）。
 * 英語 UI・ライト・1440×900・2倍。dev-board の --design のダミーデータ（架空のリポジトリ名・題名）を使う。
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { type Browser, chromium, type Page } from "playwright";

const ROOT = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
const out = resolve(args[0] && !args[0].startsWith("--") ? args[0] : "docs/assets");
const onlyIdx = args.indexOf("--only");
const only = onlyIdx >= 0 ? (args[onlyIdx + 1] ?? "").split(",") : null;
const want = (k: string) => !only || only.includes(k);
mkdirSync(out, { recursive: true });
const shot = (n: string) => resolve(out, `${n}.png`);

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

/** dev-board を起動する（scripts/screens-fold.ts と同じ） */
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
  const deadline = Date.now() + 60_000;
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
const FULL = { width: 1440, height: 900 };

/**
 * README 用の言い換え（架空の題名を別の架空の題名に）。dev-board のダミーデータは確定デザインの画像（D-114）と同じ題名で、
 * 製品名の repo に付いた「Pricing」の題名が README には向かないので、表示だけ置き換える
 */
const RENAME: [string, string][] = [
  ["Pricing page A/B test", "Signup page A/B test"],
  ["Pricing page copy", "Signup page copy"],
  ["exp/pricing-ab", "exp/signup-ab"],
];

async function rename(page: Page) {
  // scripts の tsconfig は DOM の型を持たないので、ブラウザ側の処理は文字列で渡す（screens-fold.ts と同じ）
  await page.evaluate(`(() => {
    const pairs = ${JSON.stringify(RENAME)};
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const n of nodes) {
      let s = n.data;
      for (const [from, to] of pairs) s = s.split(from).join(to);
      if (s !== n.data) n.data = s;
    }
  })()`);
  await page.waitForTimeout(200);
}

async function open(b: Board, path: string): Promise<Page> {
  await b.api("PUT", "/settings/ui", { theme: "light", language: "en" });
  const page = await browser.newPage({
    viewport: FULL,
    deviceScaleFactor: 2,
    colorScheme: "light",
    timezoneId: "Asia/Tokyo",
  });
  await page.goto(b.url.replace(/next=[^&]*/, `next=${encodeURIComponent(path)}`));
  await page.waitForSelector('[data-testid="week-board"], [data-testid="day-view"], h1', {
    timeout: 15000,
  });
  await page.waitForTimeout(900);
  return page;
}

/** 3日ボード（前の稼働日・今日・次の稼働日） */
async function board() {
  const b = await startBoard(["--design", "board", "--lang", "en"]);
  try {
    const page = await open(b, "/board");
    await rename(page);
    await page.screenshot({ path: shot("board") });
    await page.close();
  } finally {
    await b.stop();
  }
}

/** 自分の番（AI が待っている瞬間の一覧） */
async function yourTurn() {
  const b = await startBoard(["--design", "queue", "--lang", "en"]);
  try {
    const page = await open(b, "/queue");
    await rename(page);
    await page.screenshot({ path: shot("your-turn") });
    await page.close();
  } finally {
    await b.stop();
  }
}

/** AI の詳細パネル（デイビューで AI の項目を選ぶ） */
async function aiDetail() {
  const b = await startBoard(["--design", "ai", "--lang", "en"]);
  try {
    const page = await open(b, "/board");
    // AI 完了で PR の確認待ちの項目（結果・CI・差分・流れが揃う）
    const ai = page.locator('[data-kind="ai"]', { hasText: "Split the day view" }).first();
    await ai.waitFor({ timeout: 5000 });
    await ai.click({ force: true });
    await page.waitForSelector('[data-testid="ai-panel"]', { timeout: 5000 });
    await page.mouse.move(0, 0);
    await page.waitForTimeout(900);
    await rename(page);
    await page.screenshot({ path: shot("ai-detail") });
    await page.close();
  } finally {
    await b.stop();
  }
}

browser = await chromium.launch();
try {
  if (want("board")) await board();
  if (want("your-turn")) await yourTurn();
  if (want("ai-detail")) await aiDetail();
} finally {
  await browser.close();
}
console.log(`wrote ${out}`);
