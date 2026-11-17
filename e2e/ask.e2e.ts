/**
 * 図つきの問い（MCP の ask_user。ADR 0022）の E2E。dev-board --reports --lang en。MCP のプロセスと同じ HTTP の呼び方で
 * 問いを開き（作業ディレクトリに AI のカードが無いので自分のカード）、自分の番の画面で選んで返し、long-poll の結果に戻るまで。
 * - 案のカード（番号・名前・推奨・説明・図）、読めない図は 1 行、説明は狭いと下・広いと右
 * - 図の枠は sandbox が空で、srcdoc の先頭に CSP
 * - 広げる: 1 で選んでから広げる（共有）、背景は inert、e は背景に届かない、Tab は中を回る、Esc でボタンへ戻る。f で広げ、
 *   案の図を押すとその図だけ大きく（案は選ばない）、Esc で全体へ。中で 2 を選びメモを書き、閉じてもパネルに残る
 * - 広げて ⌘⏎ で返す → 結果は { choice, note }。広げた画面は閉じ、画面は「Sent at」、行は回答待ちから外れる
 * - 広げている間に打ち切られた問いは「It's already moved on」、Esc で閉じる
 */
import { join } from "node:path";
import type { Page } from "playwright";
import type {
  AskCreateResponse,
  AskResultResponse,
  QueueResponse,
} from "../packages/core/src/api/index.ts";
import type { Ctx, Suite } from "./harness.ts";

async function settle(page: Page, ms = 250) {
  await page.waitForTimeout(ms);
}

const ASK = {
  question: "Where should the save button go?",
  context: "The settings form has 14 fields and is three screens long on a phone.",
  options: [
    {
      label: "Bottom, full width",
      description: "Pinned to the bottom. Reachable wherever you are in the form.",
      recommended: true,
      figure: {
        html: '<svg viewBox="0 0 60 40"><rect x="2" y="2" width="56" height="36" rx="4" fill="none" stroke="var(--tl-text-3)"/><rect x="6" y="30" width="48" height="6" rx="2" fill="var(--tl-text)"/></svg>',
      },
    },
    { label: "Top right", description: "As it is now. Leaves the screen on a phone." },
    {
      label: "Floating",
      description: "Takes no space but covers the last field.",
      figure: { error: "too_large" },
    },
  ],
  explain: {
    html: '<h3 style="margin:0">Why now</h3><p style="color:var(--tl-text-2)">70% of visits are on a phone.</p>',
  },
  cwd: "/fixture/elsewhere/shop-admin",
};

async function run(t: Ctx) {
  const { page, board } = t;
  const shots = process.env.TURNLANE_E2E_SHOTS;
  const c = await board.api<AskCreateResponse>("POST", "/asks", ASK);
  t.check(
    "API: the ask is open on a card of its own",
    c.ownCard && !!c.workItemId,
    JSON.stringify(c),
  );
  const q = await board.api<QueueResponse>("GET", "/queue");
  const item = q.items.find((x) => x.workItemId === c.workItemId);
  t.check(
    "API: the card waits for an answer (needs_input) with the ask's follow-up",
    item?.status === "needs_input" && item.followUps.some((f) => f.askUser === c.id),
    JSON.stringify(item ?? null).slice(0, 300),
  );
  t.check("API: the list carries no question text", !JSON.stringify(q).includes("save button"));

  await page.goto(board.url.replace(/next=[^&]*/, "next=%2Fqueue"));
  await page.waitForSelector('[data-kind="turn"]', { timeout: 15000 });
  await settle(page, 400);
  const row = page.locator(`[data-kind="turn"][data-id="${c.workItemId}"]`).first();
  t.check("queue: the ask's row is shown", (await row.count()) === 1);
  const rowText = await row.innerText();
  t.check(
    "queue: the row shows the question",
    rowText.includes("Where should the save button go?"),
    rowText,
  );
  await row.click();
  await page.waitForSelector('[data-testid="ask"][data-state="open"]', { timeout: 5000 });
  await settle(page, 400);
  const section = page.locator('[data-testid="ask"]');
  t.check(
    "panel: the question and its context",
    (await section.locator('[data-testid="ask-question"]').innerText()) === ASK.question &&
      (await section.locator('[data-testid="ask-context"]').innerText()) === ASK.context,
  );
  const cards = section.locator('[data-testid="ask-option"]');
  t.check("panel: three option cards", (await cards.count()) === 3);
  t.check(
    "panel: the recommended chip is on the first card only",
    (await cards.nth(0).locator('[data-testid="ask-recommended"]').count()) === 1 &&
      (await section.locator('[data-testid="ask-recommended"]').count()) === 1,
  );
  const first = await cards.nth(0).innerText();
  t.check(
    "panel: the card has its number, label and description",
    /1[\s\S]*Bottom, full width[\s\S]*Pinned/.test(first),
    first,
  );
  t.check(
    "panel: the unreadable figure is one line and the option stays selectable",
    (await cards.nth(2).locator('[data-testid="ask-figure-error"]').innerText()) ===
      "Couldn't read the figure",
  );
  t.check(
    "panel: no Answer (terminal) button on an ask",
    (await page.locator('[data-testid="queue-answer"]').count()) === 0,
  );

  // 図の枠: sandbox は空、srcdoc の先頭に CSP
  const frames = await page.$$eval('[data-testid="ask"] iframe', (els) =>
    els.map((e) => ({
      sandbox: e.getAttribute("sandbox"),
      src: e.getAttribute("src"),
      doc: e.getAttribute("srcdoc") ?? "",
    })),
  );
  t.check(
    "frame: two figures (one option, the explanation)",
    frames.length === 2,
    JSON.stringify(frames.map((f) => f.sandbox)),
  );
  t.check(
    "frame: empty sandbox, no src, CSP first",
    frames.every(
      (f) =>
        f.sandbox === "" &&
        f.src === null &&
        f.doc.indexOf(
          `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">`,
        ) > 0 &&
        f.doc.includes("--tl-text:"),
    ),
  );

  // 狭いと説明は下（既定のパネルの幅）
  const main = await section.locator('[data-testid="ask-main"]').boundingBox();
  const explain = await section.locator('[data-testid="ask-explain"]').boundingBox();
  t.check(
    "layout: narrow → the explanation is below the options",
    !!main && !!explain && explain.y >= main.y + main.height - 1,
    JSON.stringify({ main, explain }),
  );
  // 広いと右（パネルを広げる）
  await board.api("PUT", "/settings/ui", { panelWidth: 1000 });
  await page.reload();
  await page.waitForSelector('[data-kind="turn"]', { timeout: 15000 });
  await page.locator(`[data-kind="turn"][data-id="${c.workItemId}"]`).first().click();
  await page.waitForSelector('[data-testid="ask"][data-state="open"]', { timeout: 5000 });
  await settle(page, 400);
  const main2 = await page.locator('[data-testid="ask-main"]').boundingBox();
  const explain2 = await page.locator('[data-testid="ask-explain"]').boundingBox();
  t.check(
    "layout: wide → the explanation is a right column",
    !!main2 &&
      !!explain2 &&
      explain2.x >= main2.x + main2.width - 1 &&
      Math.abs(explain2.y - main2.y) < 4,
    JSON.stringify({ main2, explain2 }),
  );

  // 広げる（ux-mvp 4.23）: パネルで 1 を選んでから広げる → 同じ案が選ばれている。Esc で閉じてボタンへフォーカスが戻る
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("1");
  await settle(page, 150);
  const overlay = page.locator('[data-testid="ask-overlay"]');
  const expandBtn = page.locator('[data-testid="ask-expand"]');
  t.check(
    "expand: the button has an accessible name",
    (await expandBtn.getAttribute("aria-label")) === "Expand",
  );
  await expandBtn.click();
  await page.waitForSelector('[data-testid="ask-overlay"][data-view="full"]', { timeout: 3000 });
  await settle(page, 300);
  const box = await overlay.boundingBox();
  t.check(
    "expand: the overlay covers most of the window",
    !!box && box.width >= 1440 * 0.9 && box.height >= 900 * 0.9,
    JSON.stringify(box),
  );
  const oMain = await overlay.locator('[data-testid="ask-main"]').boundingBox();
  const oExplain = await overlay.locator('[data-testid="ask-explain-frame"]').boundingBox();
  t.check(
    "expand: question on the left, the explanation large on the right",
    !!oMain &&
      !!oExplain &&
      oExplain.x >= oMain.x + oMain.width - 1 &&
      oExplain.width > 600 &&
      oExplain.height > 600,
    JSON.stringify({ oMain, oExplain }),
  );
  t.check(
    "expand: the selection made in the panel is shared",
    (await overlay.locator('[data-testid="ask-option"]').nth(0).getAttribute("data-on")) === "1",
  );
  t.check(
    "expand: modal with the background inert",
    (await overlay.getAttribute("aria-modal")) === "true" &&
      (await page.evaluate(() => document.getElementById("root")?.hasAttribute("inert") ?? false)),
  );
  const oFrames = await page.$$eval('[data-testid="ask-overlay"] iframe', (els) =>
    els.map((e) => e.getAttribute("sandbox")),
  );
  t.check(
    "expand: frames keep the empty sandbox",
    oFrames.length === 2 && oFrames.every((x) => x === ""),
    JSON.stringify(oFrames),
  );
  t.check(
    "expand: the hint names esc",
    (await overlay.locator('[data-testid="ask-hint"]').innerText()).includes("esc to close"),
  );
  if (shots) await page.screenshot({ path: join(shots, "ask-expanded-1440.png") });
  // 画面のキーは背景に届かない（e = 対応不要 は問いを閉じない）
  await page.keyboard.press("e");
  await settle(page, 300);
  t.check(
    "expand: screen keys do not reach the background (e does not dismiss)",
    (await overlay.count()) === 1 &&
      (await board.api<{ state: string }>("GET", `/asks/${c.id}`)).state === "open",
  );
  // Tab は枠の中を回る
  let inside = true;
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Tab");
    inside &&= await page.evaluate(
      () =>
        document.querySelector('[data-testid="ask-overlay"]')?.contains(document.activeElement) ??
        false,
    );
  }
  t.check("expand: Tab stays inside the overlay", inside);
  // 大きな説明の枠を押してもフォーカスは枠の外に戻り、Esc が効く
  const ex = await overlay.locator('[data-testid="ask-explain-frame"]').boundingBox();
  if (ex) await page.mouse.click(ex.x + ex.width / 2, ex.y + ex.height / 2);
  await settle(page, 300);
  t.check(
    "expand: clicking the explanation frame leaves focus in the overlay",
    (await page.evaluate(() => document.activeElement?.tagName)) !== "IFRAME",
    String(await page.evaluate(() => document.activeElement?.tagName)),
  );
  await page.keyboard.press("Escape");
  await settle(page, 200);
  t.check(
    "expand: Esc closes and focus returns to the Expand button",
    (await overlay.count()) === 0 &&
      (await page.evaluate(() => document.activeElement?.getAttribute("data-testid"))) ===
        "ask-expand" &&
      (await page.locator('[data-testid="ask"][data-state="open"]').count()) === 1,
  );
  t.check(
    "expand: the panel's hint names f",
    (await page.locator('[data-testid="ask-hint"]').innerText()).includes("f to expand"),
  );

  // f で広げる → 案の図を押すとその図だけ大きく（案は選ばない）→ Esc で全体へ
  await page.keyboard.press("f");
  await page.waitForSelector('[data-testid="ask-overlay"][data-view="full"]', { timeout: 3000 });
  await settle(page, 200);
  await overlay.locator('[data-testid="ask-option-zoom"]').first().click();
  await page.waitForSelector('[data-testid="ask-overlay"][data-view="figure"]', { timeout: 3000 });
  await settle(page, 200);
  const big = await page.locator('[data-testid="ask-figure-frame"]').boundingBox();
  const bigSandbox = await page.locator('[data-testid="ask-figure-frame"]').getAttribute("sandbox");
  t.check(
    "figure: one figure scaled to the overlay, empty sandbox",
    !!big && big.width > 1200 && big.height > 700 && bigSandbox === "",
    JSON.stringify({ big, bigSandbox }),
  );
  await page.keyboard.press("Escape");
  await page.waitForSelector('[data-testid="ask-overlay"][data-view="full"]', { timeout: 3000 });
  const afterFigure = {
    on: await overlay.locator('[data-testid="ask-option"]').nth(0).getAttribute("data-on"),
    focus: await page.evaluate(() => document.activeElement?.getAttribute("data-testid")),
  };
  t.check(
    "figure: clicking the figure did not change the selection; Esc returns to the overlay",
    afterFigure.on === "1" && afterFigure.focus === "ask-option-zoom",
    JSON.stringify(afterFigure),
  );

  // 広げた画面の中で 2 で選び、メモを書く → 閉じてもパネルに残る
  await overlay.locator('[data-testid="ask-question"]').click();
  await page.keyboard.press("2");
  await settle(page, 150);
  t.check(
    "keys: 2 selects the second card in the overlay",
    (await overlay.locator('[data-testid="ask-option"]').nth(1).getAttribute("data-on")) === "1",
  );
  await overlay.locator('[data-testid="ask-note"]').fill("Keep it small on desktop");
  await page.keyboard.press("Escape");
  await settle(page, 200);
  t.check(
    "shared: the panel keeps the selection and the note after collapsing",
    (await overlay.count()) === 0 &&
      (await page.locator('[data-testid="ask-option"]').nth(1).getAttribute("data-on")) === "1" &&
      (await page.locator('[data-testid="ask-note"]').inputValue()) === "Keep it small on desktop",
  );
  // パネルの案の図を押す → その図だけ大きく、案は選ばない。Esc で閉じて図のボタンへ
  await page.locator('[data-testid="ask-option-zoom"]').first().click();
  await page.waitForSelector('[data-testid="ask-overlay"][data-view="figure"]', { timeout: 3000 });
  await page.keyboard.press("Escape");
  await settle(page, 200);
  t.check(
    "figure from the panel: no selection change, Esc closes back to the figure",
    (await overlay.count()) === 0 &&
      (await page.locator('[data-testid="ask-option"]').nth(0).getAttribute("data-on")) === null &&
      (await page.locator('[data-testid="ask-option"]').nth(1).getAttribute("data-on")) === "1" &&
      (await page.evaluate(() => document.activeElement?.getAttribute("data-testid"))) ===
        "ask-option-zoom",
  );

  // 広げて ⌘⏎ で返す。MCP のプロセスと同じ long-poll で待つ。返したら閉じる
  const result = board.api<AskResultResponse>("GET", `/asks/${c.id}/result?wait=20000`);
  await page.locator('[data-testid="ask-expand"]').click();
  await page.waitForSelector('[data-testid="ask-overlay"][data-view="full"]', { timeout: 3000 });
  await settle(page, 200);
  await page.keyboard.press("Meta+Enter");
  const r = await result;
  t.check(
    "result: the choice and the note go back to the AI",
    r.state === "answered" && r.choice === "Top right" && r.note === "Keep it small on desktop",
    JSON.stringify(r),
  );
  await settle(page, 600);
  t.check("expand: the overlay closes after sending", (await overlay.count()) === 0);
  const sent = page.locator('[data-testid="ask-sent"]');
  t.check(
    "panel: “Sent at” stays after sending (or the card has moved on)",
    (await sent.count()) > 0 ||
      (await page.locator(`[data-kind="turn"][data-id="${c.workItemId}"]`).count()) === 0,
  );
  const after = await board.api<QueueResponse>("GET", "/queue");
  t.check(
    "API: the card no longer waits for an answer",
    !after.items.some((x) => x.workItemId === c.workItemId),
  );

  // 広げている間に問いが AI 側で打ち切られる → 同じ言葉を出し、Esc で閉じる
  const c2 = await board.api<AskCreateResponse>("POST", "/asks", {
    question: "Which name reads better?",
    options: [
      { label: "Short", description: "One word." },
      { label: "Long", description: "Two words." },
    ],
    cwd: "/fixture/elsewhere/name-check",
  });
  await settle(page, 800);
  await page.locator(`[data-kind="turn"][data-id="${c2.workItemId}"]`).first().click();
  await page.waitForSelector('[data-testid="ask"][data-state="open"]', { timeout: 5000 });
  await page.locator('[data-testid="ask-expand"]').click();
  await page.waitForSelector('[data-testid="ask-overlay"][data-view="full"]', { timeout: 3000 });
  t.check(
    "expand: no explanation → one centered column",
    (await overlay.locator('[data-testid="ask-full"]').getAttribute("data-layout")) === "single",
  );
  await board.api("POST", `/asks/${c2.id}/cancel`);
  let closedShown = false;
  try {
    await page.waitForSelector('[data-testid="ask-overlay-closed"] [data-testid="ask-gone"]', {
      timeout: 8000,
    });
    closedShown = true;
  } catch {}
  t.check(
    "expand: an ask closed meanwhile shows “It's already moved on”",
    closedShown &&
      (await overlay.locator('[data-testid="ask-gone"]').innerText()) === "It's already moved on",
  );
  await page.keyboard.press("Escape");
  await settle(page, 200);
  t.check("expand: Esc dismisses the closed ask", (await overlay.count()) === 0);
  await board.api("PUT", "/settings/ui", { panelWidth: null });
}

export const askSuite: Suite = {
  name: "ask",
  args: ["--reports", "--lang", "en", "--theme", "dark"],
  run,
};
