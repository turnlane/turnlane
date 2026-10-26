/**
 * 初めての起動の boot ページ（apps/desktop/boot、onboarding.md 4.1・4.9）→ SPA の最初の描画の E2E。
 * 黒い（何も描かない）画面を出さないこと:
 * - アプリが渡す初めの状態（__turnlaneBootSeed）で、IPC が答えなくても Welcome を描く
 * - Get started の後は「常駐を起動しています」と経過の秒、つながったら「画面を読み込んでいます」。15秒つながらなければ B2、
 *   つながった後は B2 を出さない。デーモンがトークンを書いて firstRun が外れても Welcome のまま
 * - SPA（デーモンが配信する index.html）は、JS が届く前から背景と「Loading Turnlane…」を描き、React が描いたら消える
 * - JS が動かない・例外を投げても Welcome は見え（HTML の既定）、Get started は押せないまま、失敗の文を画面の下に出す。
 *   初期化の段（seed・boot_state）の失敗は段の名前を出し、Copy diagnostics に起動ページの状態を載せる
 * 偽の IPC と偽の時計（page.clock）で動かす。アプリ・launchd・SMAppService には触れない
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Ctx, Suite } from "./harness.ts";

const BOOT = resolve(new URL("..", import.meta.url).pathname, "apps/desktop/boot/index.html");

type Fake = {
  online: boolean;
  firstRun: boolean;
  hang: boolean;
  stateFails?: boolean;
  seedThrows?: boolean;
  blocked?: boolean;
};

async function openBoot(t: Ctx, fake: Fake, html?: string) {
  const browser = t.page.context().browser();
  if (!browser) throw new Error("no browser");
  const page = await browser.newPage({ locale: "en-US" });
  await page.clock.install();
  await page.addInitScript((f) => {
    const g = globalThis as unknown as Record<string, unknown>;
    const st = { ...f };
    g.__fake = st;
    const seed = {
      online: false,
      port: 7317,
      firstRun: true,
      background: null,
      translocated: false,
    };
    if (st.seedThrows)
      Object.defineProperty(globalThis, "__turnlaneBootSeed", {
        get() {
          throw new Error("seed unreadable");
        },
      });
    else g.__turnlaneBootSeed = seed;
    // Copy diagnostics の中身を見る
    g.__copied = null;
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: (s: string) => {
          g.__copied = s;
          return Promise.resolve();
        },
      },
    });
    g.__TAURI_INTERNALS__ = {
      invoke: (cmd: string) => {
        if (cmd === "boot_diagnostics") return Promise.resolve("desktop:\n  +0.1s main: loaded");
        if (cmd !== "boot_state") return Promise.resolve(null);
        if (st.stateFails) return Promise.reject(new Error("ipc unavailable"));
        // IPC がメインスレッドの仕事の後ろで待たされている（答えが来ない）
        if (st.hang) return new Promise(() => {});
        return Promise.resolve({
          online: st.online,
          port: 7317,
          firstRun: st.firstRun,
          background: "notRegistered",
          translocated: false,
          blocked: !!st.blocked,
        });
      },
    };
  }, fake);
  if (html === undefined) await page.goto(`file://${BOOT}`);
  else {
    // file:// のページはスクリプトの例外の中身が伏せられる（Script error.）ので、同じ origin の http で出す
    await page.route("http://boot.test/**", (r) =>
      r.fulfill({ body: html, contentType: "text/html" }),
    );
    await page.goto("http://boot.test/boot-broken.html");
  }
  return page;
}

/** 起動ページの写しで、本体のスクリプトの先頭で例外を投げる（JS が途中で止まった場合） */
function brokenBoot() {
  const html = readFileSync(BOOT, "utf8");
  const marker = "(() => {\n        const B = window.__turnlaneBoot";
  if (!html.includes(marker)) throw new Error("boot script marker not found");
  return html.replace(marker, `throw new Error("boom");\n      ${marker}`);
}

const progressText = (p: Awaited<ReturnType<typeof openBoot>>) =>
  p.locator("#progress").innerText();

async function run(t: Ctx) {
  // 1. IPC が答えなくても Welcome を描く
  {
    const p = await openBoot(t, { online: false, firstRun: true, hang: true });
    t.check(
      "boot page draws Welcome without waiting for IPC",
      (await p.locator("#welcome").isVisible()) && (await p.locator("#start").isVisible()),
    );
    t.check(
      "Get started is enabled once the script has run",
      await p.locator("#start").isEnabled(),
    );
    t.check("no error line when nothing failed", !(await p.locator("#boot-error").isVisible()));
    t.check(
      "the menu bar hint is hidden once the script has run",
      !(await p.locator("#nojs").isVisible()),
    );
    await p.close();
  }
  // 1b. JS が無い: Welcome は見え、Get started は押せない、メニューバーの案内を出す
  {
    const browser = t.page.context().browser();
    if (!browser) throw new Error("no browser");
    const ctx = await browser.newContext({ locale: "en-US", javaScriptEnabled: false });
    const p = await ctx.newPage();
    await p.goto(`file://${BOOT}`);
    t.check(
      "without JS: Welcome is visible, Get started is disabled, the menu bar hint is shown",
      (await p.locator("#welcome").isVisible()) &&
        (await p.locator("#start").isDisabled()) &&
        (await p.locator("#nojs").isVisible()) &&
        !(await p.locator("#offline").isVisible()),
    );
    await ctx.close();
  }
  // 1c. JS が例外を投げても Welcome が見え、失敗の文（ファイルと行）が画面の下に出る
  {
    const p = await openBoot(t, { online: false, firstRun: true, hang: false }, brokenBoot());
    t.check(
      "a script error leaves Welcome visible with Get started disabled",
      (await p.locator("#welcome").isVisible()) && (await p.locator("#start").isDisabled()),
    );
    const err = await p.locator("#boot-error-text").innerText();
    t.check(
      "the error is shown: Something went wrong while starting: <message> (<file>:<line>)",
      (await p.locator("#boot-error").isVisible()) &&
        /^Something went wrong while starting: (Uncaught )?(Error: )?boom \(boot-broken\.html:\d+\)$/.test(
          err,
        ) &&
        (await p.locator("#nojs").isVisible()),
      err,
    );
    await p.close();
  }
  // 1d. 初期化の段の失敗（seed の読み取り・boot_state）は段の名前を出し、Copy diagnostics に起動ページの状態を載せる
  {
    const p = await openBoot(t, {
      online: false,
      firstRun: true,
      hang: false,
      seedThrows: true,
      stateFails: true,
    });
    await p.clock.runFor(100);
    const err = await p.locator("#boot-error-text").innerText();
    t.check(
      "a failed step is named in the error line",
      err.includes("seed unreadable (step: seed)") &&
        err.includes("ipc unavailable (step: boot_state)"),
      err,
    );
    t.check("Welcome stays visible after a failed step", await p.locator("#welcome").isVisible());
    await p.locator("#boot-error-copy").click();
    await p.clock.runFor(100);
    const copied = String(
      await p.evaluate(() => (globalThis as unknown as { __copied: unknown }).__copied),
    );
    t.check(
      "Copy diagnostics includes the seed, __TAURI__ and __TAURI_INTERNALS__ and the steps",
      copied.includes("__turnlaneBootSeed: ") &&
        copied.includes("window.__TAURI__: missing") &&
        copied.includes("window.__TAURI_INTERNALS__: present") &&
        copied.includes("seed failed: seed unreadable") &&
        copied.includes("desktop:"),
      copied,
    );
    await p.close();
  }
  // 2. Get started → 常駐を起動しています（経過の秒）→ 15秒で B2
  {
    const p = await openBoot(t, { online: false, firstRun: true, hang: false });
    await p.locator("#start").click();
    const first = await progressText(p);
    t.check(
      "after Get started: Starting the background process…",
      first.startsWith("Starting the background process…"),
      first,
    );
    await p.clock.runFor(3_100);
    const later = await progressText(p);
    t.check("the elapsed seconds are shown", later.endsWith("3s"), later);
    // デーモンがトークンを書いた（firstRun が外れた）: つながらない画面に替えず、Welcome のまま
    await p.evaluate(() => {
      (globalThis as unknown as { __fake: Fake }).__fake.firstRun = false;
    });
    await p.clock.runFor(1_100);
    t.check(
      "stays on Welcome when the daemon writes its token",
      (await p.locator("#welcome").isVisible()) && !(await p.locator("#offline").isVisible()),
    );
    await p.clock.runFor(11_000);
    t.check("B2 after 15 seconds without an answer", await p.locator("#s-b2").isVisible());
    await p.close();
  }
  // 2b. 登録をやり直しても常駐が起きない（macOS が起動を拒んでいる）: 起動中をやめて B2 の「拒まれている」文
  {
    const p = await openBoot(t, { online: false, firstRun: true, hang: false });
    await p.locator("#start").click();
    await p.clock.runFor(2_100);
    await p.evaluate(() => {
      (globalThis as unknown as { __fake: Fake }).__fake.blocked = true;
    });
    await p.clock.runFor(1_100);
    t.check(
      "blocked by macOS: B2 says the background process is being blocked",
      (await p.locator("#s-b2").isVisible()) &&
        (await p.locator("#b2-blocked").isVisible()) &&
        !(await p.locator("#b2-plain").isVisible()) &&
        !(await p.locator("#progress").isVisible()),
      await p.locator("#s-b2").innerText(),
    );
    await p.close();
  }
  // 3. つながったら 画面を読み込んでいます、B2 は出さない
  {
    const p = await openBoot(t, { online: false, firstRun: true, hang: false });
    await p.locator("#start").click();
    await p.clock.runFor(2_100);
    await p.evaluate(() => {
      (globalThis as unknown as { __fake: Fake }).__fake.online = true;
    });
    await p.clock.runFor(1_100);
    const loadingText = await progressText(p);
    t.check("online: Loading Turnlane…", loadingText.startsWith("Loading Turnlane…"), loadingText);
    await p.clock.runFor(15_000);
    t.check("no B2 once the daemon answers", !(await p.locator("#s-b2").isVisible()));
    await p.close();
  }
  // 4. SPA: JS が届く前から読み込み中を描き、React が描いたら消える
  {
    const browser = t.page.context().browser();
    if (!browser) throw new Error("no browser");
    const page = await browser.newPage({ locale: "en-US", viewport: { width: 1440, height: 900 } });
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    await page.route(/\/assets\/index-[^/]+\.js$/, async (route) => {
      await held;
      await route.continue();
    });
    void page.goto(t.board.url.replace(/next=[^&]*/, "next=%2Fboard")).catch(() => {});
    const loading = page.getByTestId("boot-loading");
    await loading.waitFor({ state: "attached" });
    // 0.4 秒後に出る（速い読み込みでは出さない）
    const shown = await page
      .waitForFunction(
        () => {
          const e = document.getElementById("boot-loading");
          return !!e && getComputedStyle(e).visibility === "visible";
        },
        undefined,
        // rAF で見ない（JS を待っている間の WebKit は描画の更新を止めることがある）
        { timeout: 3_000, polling: 100 },
      )
      .then(() => true)
      .catch(() => false);
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const text = await loading.innerText();
    t.check(
      "SPA shows Loading Turnlane… on a painted background before its JS arrives",
      shown && text === "Loading Turnlane…" && bg !== "rgba(0, 0, 0, 0)",
      `${text} ${bg} shown=${shown}`,
    );
    release();
    await page.waitForSelector("[data-source]");
    t.check(
      "the placeholder is gone once O2 is drawn",
      (await page.getByTestId("boot-loading").count()) === 0,
    );
    await page.close();
  }
}

export const bootSuite: Suite = {
  name: "boot",
  script: "scripts/dev-onboarding.ts",
  args: ["--state", "o2", "--lang", "en", "--calendar", "granted", "--desktop", "ask-grant"],
  run,
};
