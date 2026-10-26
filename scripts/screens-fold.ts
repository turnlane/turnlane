/**
 * 儀式と日報をボードに溶かした後（D-192・D-193）の実装の画像を撮り、確定画像（docs/design/screens/redesign/）がある場面は左右に
 * 並べた比較画像を作る（D-114）。dev-board（一時 HOME・偽の時計・ダミーデータ）だけを使う。実データ・オーナーのデーモン（7317）・
 * launchd・実のカレンダー・通知には触れない。
 *
 *   bun run build:web && bun scripts/screens-fold.ts [出力ディレクトリ] [--only 1,2,3,4,5,6,7,8,11]
 *
 * 場面は非公開の仕様 §6 の番号。出力: <出力>/shots/*.png（実装、2倍）、<出力>/*.png（比較画像。左が確定画像、右が実装）。
 * 既定の出力は docs/dev/screens/fold-2026-10/（ダミーデータだけ。D-085）
 */
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type Browser, chromium, type Page } from "playwright";

const ROOT = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
const out = resolve(
  args[0] && !args[0].startsWith("--") ? args[0] : "docs/dev/screens/fold-2026-10",
);
const opt = (k: string, d: string) => {
  const i = args.indexOf(k);
  return i >= 0 ? (args[i + 1] ?? d) : d;
};
const only = args.includes("--only") ? opt("--only", "").split(",") : null;
const want = (k: string) => !only || only.includes(k);
const designDir = resolve(ROOT, "docs/design/screens/redesign");
const shots = resolve(out, "shots");
mkdirSync(shots, { recursive: true });
const shot = (n: string) => resolve(shots, `${n}.png`);

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

/** dev-board を起動する（e2e/harness.ts の startBoard と同じ。scripts から e2e は参照できないので写した） */
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
type Theme = "light" | "dark";
type Size = { width: number; height: number };
const FULL: Size = { width: 1440, height: 900 };

async function open(b: Board, path: string, size: Size, theme: Theme): Promise<Page> {
  const page = await browser.newPage({
    viewport: size,
    deviceScaleFactor: 2,
    colorScheme: theme,
    timezoneId: "Asia/Tokyo",
  });
  await page.goto(b.url.replace(/next=[^&]*/, `next=${encodeURIComponent(path)}`));
  await page.waitForSelector('[data-testid="week-board"], [data-testid="day-view"], h1', {
    timeout: 15000,
  });
  await page.waitForTimeout(700);
  return page;
}

async function ui(b: Board, theme: Theme, lang: "ja" | "en") {
  await b.api("PUT", "/settings/ui", { theme, language: lang });
}

const settle = (page: Page, ms = 400) => page.waitForTimeout(ms);

/** 1. 3日ボードの基本形（サイドバー・今日の列の上部） */
async function scene1() {
  const b = await startBoard(["--design", "board"]);
  try {
    for (const [name, theme, lang] of [
      ["1-board-light", "light", "ja"],
      ["1-board-dark", "dark", "ja"],
      ["1-board-en-light", "light", "en"],
    ] as const) {
      await ui(b, theme, lang);
      const page = await open(b, "/board", FULL, theme);
      await page.screenshot({ path: shot(name) });
      await page.close();
    }
  } finally {
    await b.stop();
  }
}

/** 2. 密な今日（上位 3 件・未定・ラベルの衝突）とデイビュー（待ちの札） */
async function scene2() {
  const b = await startBoard(["--dense", "--launch", "--codex", "--orca"]);
  try {
    await ui(b, "light", "ja");
    const page = await open(b, "/board", FULL, "light");
    await page.screenshot({ path: shot("2-dense-board-light") });
    await page.goto(b.url.replace(/next=[^&]*/, "next=%2Fday"));
    await page.waitForSelector('[data-testid="day-view"]');
    await settle(page, 700);
    await page.screenshot({ path: shot("2-dense-day-light") });
    await page.close();
  } finally {
    await b.stop();
  }
}

/** 3. 「↑ 上に N 件」（11:00 までスクロールしたレーンの見出しの行） */
async function scene3() {
  const b = await startBoard(["--dense", "--dense-ai"]);
  try {
    await ui(b, "light", "ja");
    const page = await open(b, "/board", FULL, "light");
    await page.evaluate(
      `document.querySelector('[data-testid="board-scroll"]').scrollTop = ${11 * 50}`,
    );
    await settle(page, 500);
    await page.screenshot({ path: shot("3-offscreen-light") });
    await page.close();
  } finally {
    await b.stop();
  }
}

/** 4. 朝（持ち越し・超過）: 残り N 件を今日へ、計画の琥珀、押した後、元に戻した後 */
async function scene4() {
  const b = await startBoard(["--morning"]);
  try {
    await ui(b, "light", "ja");
    const page = await open(b, "/board", FULL, "light");
    await page.screenshot({ path: shot("4-morning-light") });
    const over = page.getByTestId("totals-over").first();
    if ((await over.count()) > 0) {
      await over.hover();
      await settle(page, 900);
      await page.screenshot({ path: shot("4-morning-over-hover-light") });
    }
    const carry = page.getByTestId("carry-today").first();
    if ((await carry.count()) > 0) {
      await carry.click();
      await page.waitForSelector('[role="status"]', { timeout: 5000 }).catch(() => {});
      await settle(page, 600);
      await page.screenshot({ path: shot("4-morning-carried-light") });
      const undo = page.locator('[role="status"] button').first();
      if ((await undo.count()) > 0) await undo.click();
      await settle(page, 900);
      await page.screenshot({ path: shot("4-morning-undone-light") });
    }
    await page.close();
  } finally {
    await b.stop();
  }
}

/** 5. 初日の近似（空状態）: AI レーンの 1 行、デイビューの右の「自分の番」の 1 行 */
async function scene5() {
  const b = await startBoard(["--design", "empty", "--calendar-off"]);
  try {
    await ui(b, "light", "ja");
    const page = await open(b, "/board", FULL, "light");
    await page.screenshot({ path: shot("5-empty-board-light") });
    await page.goto(b.url.replace(/next=[^&]*/, "next=%2Fday"));
    await page.waitForSelector('[data-testid="day-view"]');
    await settle(page, 700);
    await page.screenshot({ path: shot("5-empty-day-light") });
    await page.close();
  } finally {
    await b.stop();
  }
}

/** 6. 記録のパネル: 今日（ライト・ダーク）、昨日（確定済み）、次の稼働日（空の日）、AI の要約、320px */
async function scene6() {
  const b = await startBoard(["--dense", "--summary"]);
  try {
    for (const theme of ["light", "dark"] as Theme[]) {
      await ui(b, theme, "ja");
      const page = await open(b, "/day", FULL, theme);
      await page.getByTestId("open-record").click();
      await page.waitForSelector('[data-testid="record-panel"]');
      await settle(page, 4500);
      await page.screenshot({ path: shot(`6-record-today-${theme}`) });
      if (theme === "light") {
        // 昨日（確定済み）
        await page.keyboard.press("h");
        await settle(page, 900);
        await page.screenshot({ path: shot("6-record-yesterday-light") });
        // 次の稼働日（空の日の文）
        await page.keyboard.press("l");
        await page.keyboard.press("l");
        await settle(page, 900);
        await page.screenshot({ path: shot("6-record-future-light") });
        await page.keyboard.press("h");
        await settle(page, 600);
        // 320px に縮めた見出し（ドラッグの代わりに設定で幅を 320 に）
        await b.api("PUT", "/settings/ui", { panelWidth: 320 });
        await settle(page, 900);
        await page.screenshot({ path: shot("6-record-320-light") });
        await b.api("PUT", "/settings/ui", { panelWidth: null });
      }
      await page.close();
    }
  } finally {
    await b.stop();
  }
}

/** 7. 自分の番の画面の見出し「処理 N 件（7日）· 平均応答」。1024 で縮めた形 */
async function scene7() {
  const b = await startBoard(["--dense"]);
  try {
    await ui(b, "light", "ja");
    const page = await open(b, "/queue", FULL, "light");
    await page.screenshot({ path: shot("7-queue-light") });
    await page.setViewportSize({ width: 1024, height: 768 });
    await settle(page, 800);
    await page.screenshot({ path: shot("7-queue-1024-light") });
    await page.close();
  } finally {
    await b.stop();
  }
}

/** 8. 狭い幅: 1024 パネルなし / 1024 パネル（帯・56px）/ 帯を広げた形 / 1199 パネル / 1200 パネル / 1024 デイビュー＋パネル */
async function scene8() {
  const b = await startBoard(["--dense"]);
  try {
    await ui(b, "light", "ja");
    const page = await open(b, "/board", { width: 1024, height: 768 }, "light");
    await page.screenshot({ path: shot("8a-1024-light") });
    const ai = page.locator('[data-kind="ai"]').first();
    await ai.waitFor({ timeout: 5000 }).catch(() => {});
    if ((await ai.count()) > 0) {
      await ai.click({ force: true });
      await page.waitForSelector('[data-testid="ai-panel"]', { timeout: 5000 }).catch(() => {});
      await settle(page, 900);
      await page.screenshot({ path: shot("8b-1024-panel-light") });
      const band = page.getByTestId("day-band").first();
      if ((await band.count()) > 0) {
        await band.click();
        await settle(page, 700);
        await page.screenshot({ path: shot("8c-1024-expanded-light") });
        const back = page.getByTestId("collapse-day").first();
        if ((await back.count()) > 0) await back.click();
      }
      await page.setViewportSize({ width: 1199, height: 800 });
      await settle(page, 900);
      await page.screenshot({ path: shot("8d-1199-panel-light") });
      await page.setViewportSize({ width: 1200, height: 800 });
      await settle(page, 900);
      await page.screenshot({ path: shot("8e-1200-panel-light") });
      await page.setViewportSize({ width: 1024, height: 768 });
      await page.goto(b.url.replace(/next=[^&]*/, "next=%2Fday"));
      await page.waitForSelector('[data-testid="day-view"]');
      await settle(page, 600);
      const dAi = page.locator('[data-kind="ai"]').first();
      if ((await dAi.count()) > 0) {
        await dAi.click({ force: true });
        await settle(page, 900);
      }
      await page.screenshot({ path: shot("8f-1024-day-panel-light") });
    }
    await page.close();
  } finally {
    await b.stop();
  }
}

/** 11. 開くの失敗の文（「起動できなかった」= not_claimed のタスクのパネルの AI の節） */
async function scene11() {
  const b = await startBoard(["--launch"]);
  try {
    await ui(b, "light", "ja");
    const page = await open(b, "/board", FULL, "light");
    const card = page.locator('[data-kind="task"]', { hasText: "依存関係の更新" }).first();
    await card.waitFor({ timeout: 5000 }).catch(() => {});
    if ((await card.count()) > 0) {
      await card.scrollIntoViewIfNeeded();
      await card.click();
      await page
        .waitForSelector('[data-testid="task-ai-section"]', { timeout: 5000 })
        .catch(() => {});
      await settle(page, 700);
      await page.screenshot({ path: shot("11-launch-failed-light") });
    }
    await page.close();
  } finally {
    await b.stop();
  }
}

function dataUrl(p: string): string {
  return `data:image/png;base64,${readFileSync(p).toString("base64")}`;
}

async function compare(name: string, design: string | null, impl: string[], note: string) {
  const page = await browser.newPage({
    viewport: { width: 2400, height: 800 },
    deviceScaleFactor: 1,
  });
  const left = design
    ? `<div class="c"><div>確定画像（docs/design/screens/redesign/${design}）</div><img src="${dataUrl(resolve(designDir, design))}"></div>`
    : "";
  const html = `<!doctype html><meta charset="utf-8"><style>
    body{margin:0;background:#c9c9c4;font:600 22px -apple-system,sans-serif;color:#222}
    .w{display:flex;gap:24px;padding:24px;align-items:flex-start}
    .c{display:flex;flex-direction:column;gap:12px;width:1176px}
    .c img{width:1176px;border:1px solid #888;background:#fff}
    .n{font-weight:400;font-size:18px;padding:0 24px 24px;white-space:pre-wrap}
  </style><div class="w">${left}
  <div class="c"><div>実装（dev-board）</div>${impl.map((p) => `<img src="${dataUrl(shot(p))}">`).join("")}</div></div>
  <div class="n">${note}</div>`;
  await page.setContent(html);
  await page.waitForLoadState("load");
  await page.waitForTimeout(300);
  await page.screenshot({ path: resolve(out, `${name}.png`), fullPage: true });
  await page.close();
}

browser = await chromium.launch();
try {
  if (want("1")) await scene1();
  if (want("2")) await scene2();
  if (want("3")) await scene3();
  if (want("4")) await scene4();
  if (want("5")) await scene5();
  if (want("6")) await scene6();
  if (want("7")) await scene7();
  if (want("8")) await scene8();
  if (want("11")) await scene11();
  const has = (n: string) => {
    try {
      readFileSync(shot(n));
      return true;
    } catch {
      return false;
    }
  };
  const pick = (xs: string[]) => xs.filter(has);
  if (want("1"))
    await compare(
      "1-board",
      "board-B1.png",
      pick(["1-board-light", "1-board-dark", "1-board-en-light"]),
      "3日ボードの基本形。サイドバーは 自分の番 N / Inbox / ボード（今日・日報・朝の計画・閉じる・Inbox の件数が無い）。今日の列の上部は 帯 3 件＋ほか・未定 3 件＋ほか、閉店の案内が無い。確定画像との差: 上部の件数の省き方と帯の行数（B-2）",
    );
  if (want("2"))
    await compare(
      "2-dense",
      "board-D1.png",
      pick(["2-dense-board-light", "2-dense-day-light"]),
      "密な今日（17:10）: 帯「ほか N 件 ▸」、未定 3 件＋ほか、AI レーンの並列のラベル（重なったら 2 行目を消す）。下はデイビュー（待ちの札は線の右）。確定画像 D1 と比べるのは札の位置だけ",
    );
  if (want("3"))
    await compare(
      "3-offscreen",
      null,
      pick(["3-offscreen-light"]),
      "11:00 までスクロールしたレーンの見出しの行の「↑ 上に N 件」（夜間と言わない。B-9）",
    );
  if (want("4"))
    await compare(
      "4-morning",
      null,
      pick([
        "4-morning-light",
        "4-morning-over-hover-light",
        "4-morning-carried-light",
        "4-morning-undone-light",
      ]),
      "朝（8:40）: 昨日の列の「残り N 件を今日へ」、今日の見出しの「計画」が琥珀（ホバーでツールチップ）、押した後の知らせ「N 件を今日へ移しました。元に戻す」と今日の未定、元に戻した後",
    );
  if (want("5"))
    await compare(
      "5-empty",
      null,
      pick(["5-empty-board-light", "5-empty-day-light"]),
      "初日の近似: 今日の AI レーンの 1 行「Claude Code / Codex のセッションがここに出ます」、今日の列に帯の見出しが無い、デイビューの右の「自分の番」の 1 行",
    );
  if (want("6"))
    await compare(
      "6-record",
      null,
      pick([
        "6-record-today-light",
        "6-record-today-dark",
        "6-record-yesterday-light",
        "6-record-future-light",
        "6-record-320-light",
      ]),
      "記録のパネル: 今日（ライト / ダーク。AI の要約あり）、昨日（日付区切りで確定）、次の稼働日（空の日の文）、320px に縮めた見出し（コピーがアイコンだけ）",
    );
  if (want("7"))
    await compare(
      "7-queue",
      "board-Queue.png",
      pick(["7-queue-light", "7-queue-1024-light"]),
      "自分の番の画面の見出し「処理 N 件（7日）· 平均応答 …」。下は 1024 で「処理 N · 応答 Xm」に縮め、タブの件数を省いた形",
    );
  if (want("8"))
    await compare(
      "8-narrow",
      null,
      pick([
        "8a-1024-light",
        "8b-1024-panel-light",
        "8c-1024-expanded-light",
        "8d-1199-panel-light",
        "8e-1200-panel-light",
        "8f-1024-day-panel-light",
      ]),
      "狭い幅: (a) 1024 パネルなし（上部バーの段 1〜3）(b) 1024 で AI の行をクリックしてパネル（側の列が 48px の帯、サイドバーが 56px）(c) 帯をクリックして昨日を広げた形 (d) 1199 パネルあり（帯）(e) 1200 パネルあり（帯なし）(f) 1024 のデイビュー＋パネル（右の一覧が隠れる）",
    );
  if (want("11"))
    await compare(
      "11-launch-failed",
      null,
      pick(["11-launch-failed-light"]),
      "起動できなかった（not_claimed）タスクのパネルの AI の節（既存の文のまま）",
    );
} finally {
  await browser.close();
}
console.log(`compare: ${out}`);
process.exit(0);
