/**
 * Turnlane から答える（D-238、R80）の画像を dev-board（一時 HOME・偽の時計・偽の OS・ダミーデータ）だけで撮る。
 * 実データ・オーナーのデーモン（7317）・launchd・端末・カレンダー・通知には触れない（送る先は偽の OS が記録するだけ）。
 *
 *   bun run build:web && bun scripts/screens-answer.ts <出力ディレクトリ> [--lang ja,en] [--theme light,dark] [--grace | --lane | --after-send | --terminal | --ghostty]
 *
 * 場面（dev-board --design answer。今は 10/2（金）17:10）:
 * - 01 3日ボードの帯（問いの行にマウスを乗せ、ホバーのボタンに「答える」）
 * - 02 詳細パネルの「答える」の節（tmux の中の問い。全文・選択肢・入力欄・送る · Ghostty · main:1.0）。選択肢の 1 を押した後
 * - 03 許可待ちの節（許可する・開いて決める）
 * - 04 送れない端末（tmux の外の Warp）
 * - 05 メニューバーのポップオーバー（行にマウスを乗せて「答える」）
 * - 06 送った後（知らせ「送りました · Ghostty · main:1.0」と「開く」、節の「17:10 に送りました · 確認済み」。D-241: 確かめられたら
 *   タブを前に出さない。--after-send のときはこれだけ撮る）
 * - 07 自分の番の画面の詳細の節
 * - 08 幅の狭い詳細パネル（360px）: 操作の行の「…」は 1 行目の右端、ほかのボタンは左寄せで折り返す
 * - 09 猶予の間の問い（D-240・D-245。--grace のときはこれだけ撮る）: 17:06〜17:08 に止まった 3 件。返答タスクはまだ無いが、
 *   自分の番の行の末尾に薄く出る（`猶予 · あと 11m`。見出しの数には入れない）。帯を空けるため普通の 3 行は先に対応不要にする。
 *   猶予の行を選んで `a` で答えるの節を開く（iTerm2 に送れる）
 * - 12 AI のレーンの順（D-246。--lane のときはこれだけ撮る。dev-board --design lane）: 同じ時刻に重なる完了と問いで、問いの
 *   ラベルが前に出て完了は「+1」。問いの線の印は自分の番の →、右は「待ち 3h0m」「猶予 12m」
 * - 10 ターミナル.app の問い（D-243。--terminal のときはこれだけ撮る）: tmux の外のターミナル.app でも送れる
 *   （送る · ターミナル · タブ）。猶予の間の問いなので 09 と同じく AI のカードから開く
 * - 11 Ghostty の問い（D-244。--ghostty のときはこれだけ撮る）: tmux の外の Ghostty 1.3 でも送れる（送る · Ghostty · タブ）。
 *   猶予の間の問いなので 09 と同じく AI のカードから開く
 * WebKit（デスクトップアプリの WKWebView と同じエンジン）・2倍
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { type Browser, type Page, webkit } from "playwright";

const ROOT = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
const out = resolve(args[0] && !args[0].startsWith("--") ? args[0] : "out/answer");
const opt = (k: string) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : undefined;
};
const list = (k: string, d: string) => (opt(k) ?? d).split(",");
const LANGS = list("--lang", "ja") as ("ja" | "en")[];
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

/** dev-board を起動する（scripts/screens-expired.ts と同じ） */
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
  theme: "light" | "dark",
  size = { width: 1440, height: 900 },
): Promise<Page> {
  const page = await browser.newPage({
    viewport: size,
    deviceScaleFactor: 2,
    colorScheme: theme,
    timezoneId: "Asia/Tokyo",
  });
  await page.goto(b.url.replace(/next=[^&]*/, `next=${encodeURIComponent(path)}`));
  await page.waitForSelector('[data-kind="turn"]', { timeout: 20000 });
  await page.waitForTimeout(1500);
  await page.mouse.move(0, 0);
  return page;
}

const name = (n: string, lang: string, theme: string) => resolve(out, `${n}-${lang}-${theme}.png`);
const row = (p: Page, branchText: string) =>
  p.locator('[data-kind="turn"]').filter({ hasText: branchText }).first();

async function openAnswerOn(p: Page, subject: string) {
  const r = row(p, subject);
  await r.hover();
  await p.waitForTimeout(300);
  await r.locator('[data-testid="hover-toolbar"] button').nth(1).click();
  await p.waitForSelector('[data-testid="answer"]', { timeout: 10000 });
  await p.waitForTimeout(800);
}

async function run(lang: "ja" | "en") {
  const ja = lang === "ja";
  const Q = ja ? "3日ボードの列幅" : "Three-day board column widths";
  const P = ja ? "リフレッシュトークン" : "token refresh";
  const G = ja ? "デプロイの手順" : "deploy guide";
  for (const theme of THEMES) {
    // 送った後は行が閉じるので、テーマごとに起動し直す
    const b = await startBoard(["--design", "answer", "--lang", lang]);
    try {
      await b.api("PUT", "/settings/ui", { theme, language: lang });
      const p = await open(b, "/board", theme);
      await row(p, Q).hover();
      await p.waitForTimeout(1200);
      await p.screenshot({
        path: name("01-band-hover", lang, theme),
        clip: { x: 0, y: 0, width: 1440, height: 380 },
      });
      await openAnswerOn(p, Q);
      await p.locator('[data-testid="answer-option"]').first().click();
      await p.waitForTimeout(300);
      await p.screenshot({ path: name("02-detail-question", lang, theme) });
      await openAnswerOn(p, P);
      await p.screenshot({ path: name("03-detail-permission", lang, theme) });
      await openAnswerOn(p, G);
      await p.screenshot({ path: name("04-detail-cant-send", lang, theme) });
      // 送った後
      await openAnswerOn(p, Q);
      await p
        .locator('[data-testid="answer-input"]')
        .fill(ja ? "右の列も同じ幅にしてください" : "Make the right column the same width");
      await afterSend(p, lang, theme);
      await p.close();
      // 幅の狭い詳細パネル（360px）
      await b.api("PUT", "/settings/ui", { panelWidth: 360 });
      const np = await open(b, "/board", theme);
      await row(np, P).click();
      await np.waitForSelector('[data-testid="ai-actions"]', { timeout: 10000 });
      await np.waitForTimeout(800);
      await np.mouse.move(0, 0);
      await np.screenshot({ path: name("08-detail-narrow", lang, theme) });
      await np.close();
      await b.api("PUT", "/settings/ui", { panelWidth: null });
      // 自分の番の画面の詳細
      const qp = await open(b, "/queue", theme);
      await row(qp, P).click();
      await qp.waitForTimeout(500);
      await qp.keyboard.press("a");
      await qp.waitForSelector('[data-testid="answer"]', { timeout: 10000 });
      await qp.waitForTimeout(800);
      await qp.screenshot({ path: name("07-queue-permission", lang, theme) });
      await qp.close();
      // メニューバーのポップオーバー
      const tp = await open(b, "/tray", theme, { width: 360, height: 520 });
      await row(tp, P).hover();
      await tp.waitForTimeout(1200);
      await tp.screenshot({ path: name("05-tray-hover", lang, theme) });
      await tp.close();
    } finally {
      await b.stop();
    }
  }
}

/** 06 送った後: 知らせ（「開く」付き）と節の送った印が出ている間に撮る（dev-board は 1.5 秒後に待ちを閉じる） */
async function afterSend(p: Page, lang: "ja" | "en", theme: "light" | "dark") {
  await p.locator('[data-testid="answer-send"]').click();
  await p.waitForSelector('[data-testid="answer-sent"]', { timeout: 10000 });
  await p.mouse.move(0, 0);
  await p.waitForTimeout(200);
  await p.screenshot({ path: name("06-after-send", lang, theme) });
  // 待ちが閉じて節が消えるのを待つ（次の場面に残さない）
  await p.waitForSelector('[data-testid="answer"]', { state: "detached", timeout: 15000 });
}

/** 06 だけ（--after-send） */
async function runAfterSend(lang: "ja" | "en") {
  const ja = lang === "ja";
  const Q = ja ? "3日ボードの列幅" : "Three-day board column widths";
  for (const theme of THEMES) {
    const b = await startBoard(["--design", "answer", "--lang", lang]);
    try {
      await b.api("PUT", "/settings/ui", { theme, language: lang });
      const p = await open(b, "/board", theme);
      await openAnswerOn(p, Q);
      await p
        .locator('[data-testid="answer-input"]')
        .fill(ja ? "右の列も同じ幅にしてください" : "Make the right column the same width");
      await afterSend(p, lang, theme);
      await p.close();
    } finally {
      await b.stop();
    }
  }
}

/**
 * 10 ターミナル.app の問い（D-243）・11 Ghostty の問い（D-244）: AI のレーンのカード（束の中の 1 本）を id で選んで詳細を開き、
 * `a` で答えるの節を開く
 */
async function runGrace(lang: "ja" | "en", scene: "terminal" | "ghostty") {
  const titles = {
    terminal: { ja: "空の状態の文言", en: "Empty state copy", shot: "10-terminal-question" },
    ghostty: { ja: "検索欄の置き場所", en: "Search box placement", shot: "11-ghostty-question" },
  }[scene];
  const W = titles[lang];
  const shot = titles.shot;
  const b = await startBoard(["--design", "answer", "--lang", lang]);
  try {
    const days = await b.api<{ days: { items: { id: string; title: string | null }[] }[] }>(
      "GET",
      "/work-items",
    );
    const id = days.days.flatMap((d) => d.items).find((x) => x.title === W)?.id;
    if (!id) throw new Error(`no grace-period card: ${W}`);
    for (const theme of THEMES) {
      await b.api("PUT", "/settings/ui", { theme, language: lang });
      const p = await open(b, "/board", theme);
      await p.locator(`[data-kind="ai"][data-id="${id}"]`).first().click();
      await p.waitForSelector('[data-testid="ai-answer"]', { timeout: 10000 });
      await p.waitForTimeout(300);
      await p.keyboard.press("a");
      await p.waitForSelector('[data-testid="answer"]', { timeout: 10000 });
      await p.waitForTimeout(800);
      await p.mouse.move(0, 0);
      await p.screenshot({ path: name(shot, lang, theme) });
      await p.close();
    }
  } finally {
    await b.stop();
  }
}

/**
 * 09 猶予の間の問い（D-245）: 普通の 3 行を対応不要にして帯を空け、猶予の 3 行（薄い行）を出す。最初の猶予の行を選んで `a`
 */
async function runGraceRows(lang: "ja" | "en") {
  const W = { ja: "アイコンのコントラスト", en: "Icon contrast" }[lang];
  const b = await startBoard(["--design", "answer", "--lang", lang]);
  try {
    type Q = {
      items: { followUps: { id: string }[] }[];
      grace?: { workItemId: string; title: string | null }[];
    };
    const q = await b.api<Q>("GET", "/queue");
    await b.api("POST", "/follow-ups/bulk-dismiss", {
      ids: q.items.flatMap((x) => x.followUps.map((f) => f.id)),
    });
    const g = await b.api<Q>("GET", "/queue");
    const id = g.grace?.find((x) => x.title === W)?.workItemId;
    if (!id) throw new Error(`no grace row: ${W}`);
    for (const theme of THEMES) {
      await b.api("PUT", "/settings/ui", { theme, language: lang });
      const p = await open(b, "/board", theme);
      await p.locator(`[data-kind="turn"][data-id="${id}"]`).first().click();
      await p.waitForSelector('[data-testid="ai-panel"]', { timeout: 10000 });
      await p.waitForTimeout(300);
      await p.keyboard.press("a");
      await p.waitForSelector('[data-testid="answer"]', { timeout: 10000 });
      await p.waitForTimeout(800);
      await p.mouse.move(0, 0);
      await p.screenshot({ path: name("09-grace-question", lang, theme) });
      await p.close();
    }
  } finally {
    await b.stop();
  }
}

/** 12 AI のレーンの順（D-246。dev-board --design lane）: 3日ボードの今日の列 */
async function runLane(lang: "ja" | "en") {
  const b = await startBoard(["--design", "lane", "--lang", lang]);
  try {
    for (const theme of THEMES) {
      await b.api("PUT", "/settings/ui", { theme, language: lang });
      const p = await open(b, "/board", theme);
      await p.waitForSelector('[data-kind="ai"]', { timeout: 10000 });
      await p.waitForTimeout(800);
      await p.mouse.move(0, 0);
      await p.screenshot({ path: name("12-lane-order", lang, theme) });
      await p.close();
    }
  } finally {
    await b.stop();
  }
}

browser = await webkit.launch();
try {
  for (const lang of LANGS)
    await (args.includes("--grace")
      ? runGraceRows(lang)
      : args.includes("--lane")
        ? runLane(lang)
        : args.includes("--terminal")
          ? runGrace(lang, "terminal")
          : args.includes("--ghostty")
            ? runGrace(lang, "ghostty")
            : args.includes("--after-send")
              ? runAfterSend(lang)
              : run(lang));
} finally {
  await browser.close();
}
console.log(`wrote ${out}`);
