/**
 * 図つきの問い（MCP の ask_user。ADR 0022）の E2E。dev-board --reports --lang en。MCP のプロセスと同じ HTTP の呼び方で
 * 問いを開き（作業ディレクトリに AI のカードが無いので自分のカード）、自分の番の画面で選んで返し、long-poll の結果に戻るまで。
 * - 案のカード（番号・名前・推奨・説明・図）、読めない図は 1 行、説明は狭いと下・広いと右
 * - 図の枠は sandbox が空で、srcdoc の先頭に CSP
 * - 2 で選び、メモを書き、⌘⏎ で返す → 結果は { choice, note }。画面は「Sent at」、行は回答待ちから外れる
 */
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

  // 選ぶ（2）・メモ・⌘⏎ で返す。MCP のプロセスと同じ long-poll で待つ
  const result = board.api<AskResultResponse>("GET", `/asks/${c.id}/result?wait=20000`);
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("2");
  await settle(page, 150);
  t.check(
    "keys: 2 selects the second card",
    (await page.locator('[data-testid="ask-option"]').nth(1).getAttribute("data-on")) === "1",
  );
  await page.locator('[data-testid="ask-note"]').fill("Keep it small on desktop");
  await page.keyboard.press("Meta+Enter");
  const r = await result;
  t.check(
    "result: the choice and the note go back to the AI",
    r.state === "answered" && r.choice === "Top right" && r.note === "Keep it small on desktop",
    JSON.stringify(r),
  );
  await settle(page, 600);
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
  await board.api("PUT", "/settings/ui", { panelWidth: null });
}

export const askSuite: Suite = {
  name: "ask",
  args: ["--reports", "--lang", "en"],
  run,
};
