/**
 * オンボーディング O1〜O8 の実装の画像を撮り、確定画像（docs/design/onboarding-v1/）と左右に並べた比較画像を作る
 * （M6-29、D-114）。O2〜O8 は dev-onboarding（一時 HOME・偽の時計・ダミーデータ・偽のカレンダーとアプリ）、O1 は同梱の
 * boot ページを偽の IPC で開く。O4〜O8 には確定画像が無いので、実装の画像だけを並べる（PO が画像で確かめる）。
 * 実データ・オーナーのデーモン（7317）・launchd・実のカレンダー・通知には触れない。
 *
 *   bun run build:web && bun scripts/screens-onboarding.ts [出力ディレクトリ] [--port 27610] [--only O1,O2,O3,O4,O5,O5a,O6,O7,O8,M6]
 *
 * 出力: <出力>/shots/*.png（実装、2倍）、<出力>/*.png（比較画像。左が確定画像、右が実装）
 */
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type Browser, chromium, type Page } from "playwright";

const ROOT = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
const out = resolve(args[0] && !args[0].startsWith("--") ? args[0] : "out/onboarding-compare");
const opt = (k: string, d: string) => {
  const i = args.indexOf(k);
  return i >= 0 ? (args[i + 1] ?? d) : d;
};
let port = Number(opt("--port", "27610"));
const only = args.includes("--only") ? opt("--only", "").split(",") : null;
const want = (k: string) => !only || only.includes(k);
const designDir = resolve(ROOT, "docs/design/onboarding-v1");
const shots = resolve(out, "shots");
mkdirSync(shots, { recursive: true });
const shot = (n: string) => resolve(shots, `${n}.png`);

interface Dev {
  url: string;
  stop: () => Promise<void>;
}

async function dev(
  state: string,
  lang: "en" | "ja",
  theme: "light" | "dark",
  extra: string[] = [],
): Promise<Dev> {
  port++;
  const proc = Bun.spawn(
    [
      "bun",
      "scripts/dev-onboarding.ts",
      "--port",
      String(port),
      "--state",
      state,
      "--lang",
      lang,
      "--theme",
      theme,
      ...extra,
    ],
    { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
  );
  const reader = proc.stdout.getReader();
  const dec = new TextDecoder();
  let text = "";
  let url: string | null = null;
  const deadline = Date.now() + 60_000;
  while (!url) {
    if (Date.now() > deadline) throw new Error(`dev-onboarding did not start:\n${text}`);
    const { value, done } = await reader.read();
    if (done)
      throw new Error(`dev-onboarding exited:\n${text}\n${await new Response(proc.stderr).text()}`);
    text += dec.decode(value);
    url = /^(http:\/\/127\.0\.0\.1:\d+\/auth\?t=\S+)$/m.exec(text)?.[1] ?? null;
  }
  void (async () => {
    while (!(await reader.read()).done);
  })().catch(() => {});
  return {
    url,
    stop: async () => {
      proc.kill("SIGTERM");
      await proc.exited;
    },
  };
}

let browser: Browser;

async function open(
  d: Dev,
  size: { width: number; height: number },
  theme: "light" | "dark",
): Promise<Page> {
  const page = await browser.newPage({
    viewport: size,
    deviceScaleFactor: 2,
    colorScheme: theme,
    timezoneId: "Asia/Tokyo",
  });
  await page.goto(d.url);
  await page.waitForSelector('[data-kind="onboarding"], [data-lane="ai"]');
  await page.waitForTimeout(600);
  return page;
}

const FULL = { width: 1280, height: 800 };
const MIN_WIN = { width: 960, height: 600 };

async function sceneO2() {
  for (const [name, lang, theme, size] of [
    ["O2-sources-light", "en", "light", FULL],
    ["O2-sources-dark", "en", "dark", FULL],
    ["O2-sources-ja-light", "ja", "light", FULL],
    ["O2-sources-min-light", "en", "light", MIN_WIN],
  ] as const) {
    const d = await dev("o2", lang, theme);
    try {
      const page = await open(d, size, theme);
      await page.waitForSelector("[data-source]");
      await page.screenshot({ path: shot(name) });
      if (name === "O2-sources-light") {
        // 全部外した（D-184）
        for (const b of await page.locator('[data-source] [role="checkbox"]').all())
          await b.click();
        await page.screenshot({ path: shot("O2-nothing-light") });
        // 保存するもののポップオーバー
        for (const b of await page.locator('[data-source] [role="checkbox"]').all())
          await b.click();
        await page.getByTestId("onb-see-all").click();
        await page.waitForTimeout(200);
        await page.screenshot({ path: shot("O2-popover-light") });
      }
      await page.close();
    } finally {
      await d.stop();
    }
  }
  const d = await dev("o2-empty", "en", "light");
  try {
    const page = await open(d, FULL, "light");
    await page.screenshot({ path: shot("O2-empty-light") });
    await page.close();
  } finally {
    await d.stop();
  }
  const b = await dev("board", "en", "light");
  try {
    const page = await open(b, FULL, "light");
    await page.waitForSelector('[data-part="import-empty"]');
    await page.screenshot({ path: shot("O2-after-not-now-light") });
    await page.close();
  } finally {
    await b.stop();
  }
}

async function sceneO3() {
  for (const [name, state, lang, theme, size] of [
    ["O3-importing-light", "o3-importing", "en", "light", FULL],
    ["O3-importing-dark", "o3-importing", "en", "dark", FULL],
    ["O3-importing-min-light", "o3-importing", "en", "light", MIN_WIN],
    ["O3-done-light", "o3-done", "en", "light", FULL],
    ["O3-done-dark", "o3-done", "en", "dark", FULL],
    ["O3-done-ja-light", "o3-done", "ja", "light", FULL],
  ] as const) {
    const d = await dev(state, lang, theme);
    try {
      const page = await open(d, size, theme);
      await page.waitForSelector('[data-part="columns"] [data-item]');
      if (state === "o3-done") await page.waitForSelector('[data-part="days-done"] svg');
      await page.waitForTimeout(400);
      await page.screenshot({ path: shot(name) });
      if (name === "O3-done-light") {
        await page.locator('[data-day="2026-10-01"] [data-item]').first().hover();
        await page.waitForTimeout(200);
        await page.screenshot({ path: shot("O3-hover-light") });
      }
      await page.close();
    } finally {
      await d.stop();
    }
  }
}

/** O1（boot ページ）。偽の IPC（初回の起動）で開く */
async function sceneO1() {
  const boot = resolve(ROOT, "apps/desktop/boot/index.html");
  for (const [name, lang, theme, state] of [
    ["O1-welcome-light", "en", "light", null],
    ["O1-welcome-dark", "en", "dark", null],
    ["O1-welcome-ja-light", "ja", "light", null],
    ["O1-starting-light", "en", "light", "starting"],
    ["O1-b1-light", "en", "light", "b1"],
    ["O1-b2-light", "en", "light", "b2"],
    ["O1-b4-light", "en", "light", "b4"],
  ] as const) {
    const page = await browser.newPage({
      viewport: FULL,
      deviceScaleFactor: 2,
      colorScheme: theme,
      locale: lang === "ja" ? "ja-JP" : "en-US",
    });
    await page.addInitScript((st) => {
      const s = {
        online: false,
        port: 7317,
        firstRun: true,
        background: st === "b1" ? "requiresApproval" : "notRegistered",
        translocated: st === "b4",
      };
      const g = globalThis as unknown as Record<string, unknown>;
      g.__TAURI_INTERNALS__ = {
        invoke: (cmd: string) => Promise.resolve(cmd === "boot_state" ? s : null),
      };
      g.__turnlaneBootPreview = st;
    }, state);
    await page.goto(`file://${boot}`);
    await page.waitForTimeout(300);
    await page.screenshot({ path: shot(name) });
    await page.close();
  }
}

type Size = { width: number; height: number };

/** 1 つの段の、ライト・ダーク・日本語・最小の窓の 4 枚（O4〜O8 の共通） */
async function basicShots(
  prefix: string,
  state: string,
  ready: string,
  extra: string[] = [],
  after?: (page: Page, name: string) => Promise<void>,
) {
  for (const [suffix, lang, theme, size] of [
    ["light", "en", "light", FULL],
    ["dark", "en", "dark", FULL],
    ["ja-light", "ja", "light", FULL],
    ["min-light", "en", "light", MIN_WIN],
  ] as const) {
    const d = await dev(state, lang, theme, extra);
    try {
      const page = await open(d, size as Size, theme);
      await page.waitForSelector(ready);
      await page.waitForTimeout(300);
      await page.screenshot({ path: shot(`${prefix}-${suffix}`) });
      if (after) await after(page, suffix);
      await page.close();
    } finally {
      await d.stop();
    }
  }
}

/** 1 枚だけ（状態の画像） */
async function oneShot(
  name: string,
  state: string,
  ready: string,
  extra: string[],
  act?: (page: Page) => Promise<void>,
  size: Size = FULL,
) {
  const d = await dev(state, "en", "light", extra);
  try {
    const page = await open(d, size, "light");
    await page.waitForSelector(ready);
    await page.waitForTimeout(300);
    if (act) await act(page);
    await page.screenshot({ path: shot(name) });
    await page.close();
  } finally {
    await d.stop();
  }
}

/** O4 カレンダー: 説明・許可済み・許可待ち・拒否・0件・起動しない・ダイアログを出せない */
async function sceneO4() {
  await basicShots("O4-calendar", "o4", '[data-testid="onb-calendar-primary"]');
  const press = (sel: string) => async (page: Page) => {
    await page.getByTestId("onb-calendar-primary").click();
    await page.waitForSelector(sel, { timeout: 20_000 });
    await page.waitForTimeout(500);
  };
  await oneShot(
    "O4-granted-light",
    "o4",
    '[data-testid="onb-calendar-primary"]',
    ["--calendar", "granted"],
    press('[data-testid="onb-calendar-granted"]'),
  );
  await oneShot(
    "O4-waiting-light",
    "o4",
    '[data-testid="onb-calendar-primary"]',
    ["--calendar", "slow"],
    async (page) => {
      await page.getByTestId("onb-calendar-primary").click();
      await page.waitForTimeout(800);
    },
  );
  await oneShot(
    "O4-denied-light",
    "o4",
    '[data-testid="onb-calendar-primary"]',
    ["--calendar", "denied"],
    press('[data-testid="onb-calendar-denied"]'),
  );
  await oneShot(
    "O4-none-light",
    "o4",
    '[data-testid="onb-calendar-primary"]',
    ["--calendar", "none"],
    press('[data-testid="onb-calendar-none"]'),
  );
  await oneShot(
    "O4-failed-light",
    "o4",
    '[data-testid="onb-calendar-primary"]',
    ["--calendar", "fail"],
    press('[data-testid="onb-calendar-failed"]'),
  );
  // 許可のダイアログを出せなかった（authorize が 1 で終わった。2026-10-21 の Neo）: 理由と Try again・Open System Settings・Not now
  await oneShot(
    "O4-dialog-failed-light",
    "o4",
    '[data-testid="onb-calendar-primary"]',
    ["--calendar", "authorize-fail"],
    press('[data-testid="onb-calendar-failed"]'),
  );
}

/** O5 hooks: 説明・変更を見る・入れた後（Codex は承認待ち）・一部失敗 */
async function sceneO5() {
  await basicShots("O5-hooks", "o5", "[data-target][data-state]");
  await oneShot("O5-changes-light", "o5", "[data-target][data-state]", [], async (page) => {
    await page.getByTestId("onb-show-changes").click();
    await page.waitForTimeout(200);
  });
  await oneShot("O5-done-light", "o5", "[data-target][data-state]", [], async (page) => {
    await page.getByTestId("onb-hooks-primary").click();
    await page.waitForSelector('[data-target][data-state="installed"]', { timeout: 20_000 });
    await page.waitForTimeout(400);
  });
  await oneShot(
    "O5-failed-light",
    "o5",
    "[data-target][data-state]",
    ["--hooks", "broken"],
    async (page) => {
      await page.getByTestId("onb-hooks-primary").click();
      await page.waitForSelector('[data-target][data-state="error"] [data-mark]', {
        timeout: 20_000,
      });
      await page.waitForTimeout(400);
    },
  );
}

/** O5a AI tools（MCP）: 説明・変更を見る・登録した後 */
async function sceneO5a() {
  await basicShots("O5a-mcp", "o5a", "[data-target][data-state]");
  await oneShot("O5a-changes-light", "o5a", "[data-target][data-state]", [], async (page) => {
    await page.getByTestId("onb-show-changes").click();
    await page.waitForTimeout(200);
  });
  await oneShot("O5a-done-light", "o5a", "[data-target][data-state]", [], async (page) => {
    await page.getByTestId("onb-mcp-primary").click();
    await page.waitForSelector('[data-target][data-state="installed"] [data-mark]', {
      timeout: 20_000,
    });
    await page.waitForTimeout(400);
  });
}

/** O6 計画の目安: 既定・曜日ごと・カレンダーなし（祝日 None） */
async function sceneO6() {
  await basicShots("O6-hours", "o6", '[data-part="hours"]');
  await oneShot("O6-per-day-light", "o6", '[data-part="hours"]', [], async (page) => {
    await page.getByTestId("onb-hours-per-day").click();
    await page.waitForTimeout(200);
  });
  await oneShot("O6-no-calendar-light", "o6", '[data-part="hours"]', ["--calendar", "denied"]);
}

/** O7 通知: ブラウザ・アプリ（未設定・オン・オフ） */
async function sceneO7() {
  await basicShots("O7-notify", "o7", '[data-testid="onb-notify-primary"]', [
    "--desktop",
    "ask-grant",
  ]);
  await oneShot("O7-browser-light", "o7", '[data-testid="onb-notify-primary"]', []);
  await oneShot(
    "O7-granted-light",
    "o7",
    '[data-testid="onb-notify-primary"]',
    ["--desktop", "ask-grant"],
    async (page) => {
      await page.getByTestId("onb-notify-primary").click();
      await page.waitForSelector('[data-testid="onb-notify-on"]', { timeout: 20_000 });
      await page.waitForTimeout(300);
    },
  );
  await oneShot(
    "O7-denied-light",
    "o7",
    '[data-testid="onb-notify-primary"]',
    ["--desktop", "ask-deny"],
    async (page) => {
      await page.getByTestId("onb-notify-primary").click();
      await page.waitForSelector('[data-testid="onb-notify-denied"]', { timeout: 20_000 });
      await page.waitForTimeout(300);
    },
  );
}

/** O8 はじめる: 全部済み（アプリあり）・全部飛ばした（ブラウザ） */
async function sceneO8() {
  await basicShots("O8-start", "o8", '[data-part="summary-rows"] [data-row="notifications"]', [
    "--desktop",
    "granted",
  ]);
  await oneShot("O8-skipped-light", "o8", '[data-part="summary-rows"] [data-row="notifications"]', [
    "--skipped",
  ]);
}

/**
 * 配布版の配置（M6-14・M6-15）で変わった状態: O1 の B4（移せなかった）、O8 の Install ▸（押す前・後）。
 * 比較画像は作らず shots/ にだけ出す（確定画像が無い。PO が画像で確かめる）
 */
async function sceneM6() {
  const boot = resolve(ROOT, "apps/desktop/boot/index.html");
  for (const [name, lang, theme, state] of [
    ["M6-O1-b4-light", "en", "light", "b4"],
    ["M6-O1-b4-failed-light", "en", "light", "b4-failed"],
    ["M6-O1-b4-failed-ja-light", "ja", "light", "b4-failed"],
    ["M6-O1-b4-failed-dark", "en", "dark", "b4-failed"],
  ] as const) {
    const page = await browser.newPage({
      viewport: FULL,
      deviceScaleFactor: 2,
      colorScheme: theme,
      locale: lang === "ja" ? "ja-JP" : "en-US",
    });
    await page.addInitScript((st) => {
      const s = {
        online: false,
        port: 7317,
        firstRun: true,
        background: "notRegistered",
        translocated: true,
      };
      const g = globalThis as unknown as Record<string, unknown>;
      g.__TAURI_INTERNALS__ = {
        invoke: (cmd: string) => Promise.resolve(cmd === "boot_state" ? s : null),
      };
      g.__turnlaneBootPreview = st;
    }, state);
    await page.goto(`file://${boot}`);
    await page.waitForTimeout(300);
    await page.screenshot({ path: shot(name) });
    await page.close();
  }
  const ready = '[data-part="summary-rows"] [data-row="notifications"]';
  for (const [suffix, lang, theme] of [
    ["light", "en", "light"],
    ["dark", "en", "dark"],
    ["ja-light", "ja", "light"],
  ] as const) {
    const d = await dev("o8", lang, theme, ["--desktop", "granted", "--install", "app"]);
    try {
      const page = await open(d, FULL, theme);
      await page.waitForSelector('[data-testid="onb-install-cli"]');
      await page.waitForSelector(ready);
      await page.waitForTimeout(300);
      await page.screenshot({ path: shot(`M6-O8-install-${suffix}`) });
      await page.getByTestId("onb-install-cli").click();
      await page.waitForSelector('[data-cli="installed"]');
      await page.waitForTimeout(300);
      await page.screenshot({ path: shot(`M6-O8-installed-${suffix}`) });
      await page.close();
    } finally {
      await d.stop();
    }
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
    ? `<div class="c"><div>確定画像（docs/design/onboarding-v1/${design}）</div><img src="${dataUrl(resolve(designDir, design))}"></div>`
    : "";
  const html = `<!doctype html><meta charset="utf-8"><style>
    body{margin:0;background:#c9c9c4;font:600 22px -apple-system,sans-serif;color:#222}
    .w{display:flex;gap:24px;padding:24px;align-items:flex-start}
    .c{display:flex;flex-direction:column;gap:12px;width:1176px}
    .c img{width:1176px;border:1px solid #888;background:#fff}
    .c img.m{width:882px}
    .n{font-weight:400;font-size:18px;padding:0 24px 24px;white-space:pre-wrap}
  </style><div class="w">${left}
  <div class="c"><div>実装（dev-onboarding / boot ページ）</div>${impl
    .map((p) => `<img ${/min/.test(p) ? 'class="m"' : ""} src="${dataUrl(shot(p))}">`)
    .join("")}</div></div>
  <div class="n">${note}</div>`;
  await page.setContent(html);
  await page.waitForLoadState("load");
  await page.waitForTimeout(300);
  await page.screenshot({ path: resolve(out, `${name}.png`), fullPage: true });
  await page.close();
}

browser = await chromium.launch();
try {
  if (want("O1")) await sceneO1();
  if (want("O2")) await sceneO2();
  if (want("O3")) await sceneO3();
  if (want("O4")) await sceneO4();
  if (want("O5")) await sceneO5();
  if (want("O5a")) await sceneO5a();
  if (want("O6")) await sceneO6();
  if (want("O7")) await sceneO7();
  if (want("O8")) await sceneO8();
  if (want("M6")) await sceneM6();
  if (want("O1")) {
    await compare(
      "O1-welcome-light",
      "onb-O1-welcome-light.png",
      ["O1-welcome-light"],
      "O1 通常（英語・ライト）",
    );
    await compare(
      "O1-welcome-dark",
      "onb-O1-welcome-dark.png",
      ["O1-welcome-dark"],
      "O1 通常（英語・ダーク）",
    );
    await compare(
      "O1-welcome-ja-light",
      "onb-O1-welcome-ja-light.png",
      ["O1-welcome-ja-light"],
      "O1 通常（日本語）",
    );
    await compare(
      "O1-states",
      null,
      ["O1-starting-light", "O1-b1-light", "O1-b2-light", "O1-b4-light"],
      "O1 の状態（起動中・B1・B2・B4）。確定画像は onb-O1-states.png（縦に長いので並べていない）",
    );
  }
  if (want("O2")) {
    await compare(
      "O2-sources-light",
      "onb-O2-sources-light.png",
      ["O2-sources-light"],
      "O2（英語・ライト）",
    );
    await compare(
      "O2-sources-dark",
      "onb-O2-sources-dark.png",
      ["O2-sources-dark"],
      "O2（英語・ダーク）",
    );
    await compare(
      "O2-sources-ja-light",
      "onb-O2-sources-ja-light.png",
      ["O2-sources-ja-light"],
      "O2（日本語）",
    );
    await compare(
      "O2-sources-min-light",
      "onb-O2-sources-min-light.png",
      ["O2-sources-min-light"],
      "O2 最小の窓（960×600）",
    );
    await compare(
      "O2-states",
      null,
      ["O2-empty-light", "O2-nothing-light", "O2-popover-light", "O2-after-not-now-light"],
      "O2 の状態（0件・全部外した・保存するもののポップオーバー・Not now の後のボード）。確定画像は onb-O2-states.png",
    );
  }
  if (want("O3")) {
    await compare(
      "O3-importing-light",
      "onb-O3-importing-light.png",
      ["O3-importing-light"],
      "O3 取り込み中（英語・ライト）",
    );
    await compare(
      "O3-importing-dark",
      "onb-O3-importing-dark.png",
      ["O3-importing-dark"],
      "O3 取り込み中（英語・ダーク）",
    );
    await compare(
      "O3-importing-min-light",
      "onb-O3-importing-min-light.png",
      ["O3-importing-min-light"],
      "O3 取り込み中・最小の窓（960×600）",
    );
    await compare(
      "O3-done-light",
      "onb-O3-done-light.png",
      ["O3-done-light"],
      "O3 完了（英語・ライト）",
    );
    await compare(
      "O3-done-dark",
      "onb-O3-done-dark.png",
      ["O3-done-dark"],
      "O3 完了（英語・ダーク）",
    );
    await compare(
      "O3-done-ja-light",
      "onb-O3-done-ja-light.png",
      ["O3-done-ja-light"],
      "O3 完了（日本語）",
    );
    await compare(
      "O3-hover",
      null,
      ["O3-hover-light"],
      "O3 のホバー（確定画像は onb-O3-states.png の 5）",
    );
  }
  // O4〜O8（確定画像は無い。実装の画像だけ）
  const basic = async (id: string, prefix: string, label: string) => {
    await compare(`${prefix}-light`, null, [`${prefix}-light`], `${label}（英語・ライト）`);
    await compare(`${prefix}-dark`, null, [`${prefix}-dark`], `${label}（英語・ダーク）`);
    await compare(`${prefix}-ja-light`, null, [`${prefix}-ja-light`], `${label}（日本語）`);
    await compare(
      `${prefix}-min-light`,
      null,
      [`${prefix}-min-light`],
      `${label} 最小の窓（960×600）`,
    );
    void id;
  };
  if (want("O4")) {
    await basic("O4", "O4-calendar", "O4 カレンダー");
    await compare(
      "O4-states",
      null,
      [
        "O4-granted-light",
        "O4-waiting-light",
        "O4-denied-light",
        "O4-none-light",
        "O4-failed-light",
      ],
      "O4 の状態（許可済み・許可待ち・拒否・カレンダー 0 件・ヘルパが起動しない）",
    );
  }
  if (want("O5")) {
    await basic("O5", "O5-hooks", "O5 hooks");
    await compare(
      "O5-states",
      null,
      ["O5-changes-light", "O5-done-light", "O5-failed-light"],
      "O5 の状態（変更を見る・入れた後（Codex は承認待ち）・一部失敗）",
    );
  }
  if (want("O5a")) {
    await basic("O5a", "O5a-mcp", "O5a AI tools（MCP）");
    await compare(
      "O5a-states",
      null,
      ["O5a-changes-light", "O5a-done-light"],
      "O5a の状態（変更を見る・登録した後）",
    );
  }
  if (want("O6")) {
    await basic("O6", "O6-hours", "O6 計画の目安と稼働日");
    await compare(
      "O6-states",
      null,
      ["O6-per-day-light", "O6-no-calendar-light"],
      "O6 の状態（曜日ごと・カレンダーなし）",
    );
  }
  if (want("O7")) {
    await basic("O7", "O7-notify", "O7 通知（アプリ・未設定）");
    await compare(
      "O7-states",
      null,
      ["O7-browser-light", "O7-granted-light", "O7-denied-light"],
      "O7 の状態（ブラウザ・許可済み・拒否）",
    );
  }
  if (want("O8")) {
    await basic("O8", "O8-start", "O8 はじめる（全部済み・アプリあり）");
    await compare("O8-states", null, ["O8-skipped-light"], "O8 の状態（全部飛ばした・ブラウザ）");
  }
} finally {
  await browser.close();
}
console.log(`compare: ${out}`);
