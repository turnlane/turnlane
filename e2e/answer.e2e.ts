/**
 * Turnlane から答える（D-238、R80）の E2E: 帯の行の「答える」で詳細パネルの節が開く、選択肢のボタンで入力欄に番号が入る、
 * 送れない端末では入力欄の代わりに「この端末には送れません」と「開く」、許可待ちは「許可する」「開いて決める」、`a` のキー、
 * 送った後の知らせ（偽の届け先。dev-board の偽の OS が記録し、Claude が受け取った形を記録に書く）。
 *
 * dev-board --design answer --lang en: 今は 2026-10-02（金）17:10 JST。3 行（tmux の中の問い・iTerm2 の許可待ち・
 * tmux の外の Warp の問い）と、猶予の間の問い（iTerm2。17:06 に止まった。自分の番の行はまだ無い。D-240）、
 * ターミナル.app の猶予の間の問い（tmux の外でも送れる。D-243）、Ghostty 1.3 の猶予の間の問い（tmux の外でも送れる。D-244）。
 * 猶予の間の問いは自分の番の行の末尾に薄く出る（D-245。answer-grace の組）。終わったセッション（Release notes。16:59〜17:05）は
 * 猶予の間の問い（Icon contrast。17:00〜17:06）と AI のレーンで重なり、問いが前に出る（D-246）
 */
import type { Ctx, Suite } from "./harness.ts";

const Q = "Three-day board column widths";
const P = "token refresh";
const G = "deploy guide";
/** AskUserQuestion のダイアログ（PermissionRequest。tool_use は記録に無い） */
const D = "Release channel";
/** 猶予の間の問い（D-240） */
const W = "Icon contrast";
/** ターミナル.app の問い（D-243。猶予の間） */
const T = "Empty state copy";
/** tmux の外の Ghostty の問い（D-244。猶予の間） */
const H = "Search box placement";

async function run(t: Ctx) {
  const { page, board } = t;
  // 狭いパネル（360px）: 操作の行の「…」は 1 行目の右端に留まり、ほかのボタンが左寄せで折り返す
  await board.api("PUT", "/settings/ui", { panelWidth: 360 });
  await page.goto(board.url.replace(/next=[^&]*/, "next=%2Fboard"));
  {
    const r = page.locator('[data-kind="turn"]').filter({ hasText: Q }).first();
    await r.waitFor({ timeout: 15000 });
    await r.click();
    await page.getByTestId("ai-answer").waitFor({ timeout: 10000 });
    const box = (id: string) => page.getByTestId(id).boundingBox();
    const [row, prim, more, withB] = await Promise.all([
      box("ai-actions"),
      box("ai-primary"),
      box("ai-more"),
      box("ai-open-with"),
    ]);
    const frame = await page.getByTestId("panel-frame").boundingBox();
    t.check(
      "narrow panel: ⋯ stays at the right end of the first row; other buttons wrap left-aligned",
      !!row &&
        !!prim &&
        !!more &&
        !!withB &&
        Math.round(frame?.width ?? 0) === 360 &&
        Math.abs(more.y + more.height / 2 - (prim.y + prim.height / 2)) <= 2 &&
        Math.abs(more.x + more.width - (row.x + row.width)) <= 1 &&
        withB.y > prim.y + prim.height - 1 &&
        Math.abs(withB.x - prim.x) <= 1,
      JSON.stringify({ row, prim, more, withB, w: frame?.width }),
    );
    await page.keyboard.press("Escape");
  }
  await board.api("PUT", "/settings/ui", { panelWidth: null });
  await page.goto(board.url.replace(/next=[^&]*/, "next=%2Fboard"));
  const row = (s: string) => page.locator('[data-kind="turn"]').filter({ hasText: s }).first();
  await row(Q).waitFor({ timeout: 15000 });
  const section = page.getByTestId("answer");

  // 帯の行のホバーのボタンに「答える」
  await row(Q).hover();
  const btn = row(Q).locator('[data-testid="hover-toolbar"] button[aria-label^="Answer"]');
  t.check("the waiting row has an Answer button on hover", (await btn.count()) === 1);
  await btn.click();
  await section.waitFor({ timeout: 10000 });
  t.check(
    "Answer opens the section in the detail panel",
    (await page.getByTestId("ai-panel").count()) === 1,
  );
  const q = await page.getByTestId("answer-question").innerText();
  t.check(
    "the full question is shown",
    q.includes("What should I do?") && q.includes("Leave it as is"),
    q,
  );
  // 問いの枠は右下のつまみで手で広げられる（自動では広げない）。広げても答えの欄と送るボタンは画面内
  {
    const qbox = page.getByTestId("answer-question");
    const before = await qbox.boundingBox();
    if (before) {
      await page.mouse.move(before.x + before.width - 3, before.y + before.height - 3);
      await page.mouse.down();
      await page.mouse.move(before.x + before.width - 3, before.y + before.height + 150, {
        steps: 8,
      });
      await page.mouse.up();
    }
    await page.waitForTimeout(250);
    const after = await qbox.boundingBox();
    const vh = page.viewportSize()?.height ?? 0;
    const input = await page.getByTestId("answer-input").boundingBox();
    const send = await page.getByTestId("answer-send").boundingBox();
    const resize = await qbox.evaluate((el) => getComputedStyle(el).resize);
    t.check(
      "the question box can be enlarged with the resize handle; the answer field and send stay on screen",
      !!before &&
        !!after &&
        !!input &&
        !!send &&
        resize === "vertical" &&
        after.height > before.height + 60 &&
        input.y >= 0 &&
        send.y + send.height <= vh,
      JSON.stringify({ before, after, input, send, vh }),
    );
  }
  const opts = page.getByTestId("answer-option");
  await opts
    .first()
    .waitFor({ timeout: 5000 })
    .catch(() => {});
  t.check("numbered choices become buttons", (await opts.count()) === 3);
  await opts.nth(1).click();
  const input = page.getByTestId("answer-input");
  t.check("a choice puts its number in the answer", (await input.inputValue()) === "2");
  const send = await page.getByTestId("answer-send").innerText();
  t.check("the send button names where it goes", send.includes("Send · Ghostty · main:1.0"), send);

  // 送れない端末: 入力欄を出さず、そう言って「開く」
  await row(G).hover();
  await row(G).locator('[data-testid="hover-toolbar"] button[aria-label^="Answer"]').click();
  await page.getByTestId("answer-cant").waitFor({ timeout: 10000 });
  t.check(
    "an unsupported terminal hides the input",
    (await page.getByTestId("answer-input").count()) === 0,
  );
  const cant = await page.getByTestId("answer-cant").innerText();
  t.check(
    "it says it can't send to this terminal and offers Open",
    cant.includes("Can't send to this terminal") && cant.includes("Open"),
    cant,
  );

  // 許可待ち（キーの a）: 許可する・開いて決める（今後も許可は出さない）
  await page.keyboard.press("Escape");
  await row(P).click();
  await page.waitForTimeout(300);
  await page.keyboard.press("a");
  await page.getByTestId("answer-permission").waitFor({ timeout: 10000 });
  const perm = await page.getByTestId("answer-permission").innerText();
  t.check(
    "a permission wait offers Allow and Open to decide only",
    perm.includes("Allow") &&
      perm.includes("Open to decide") &&
      !/always|don't ask again$/i.test(perm),
    perm,
  );

  // 送る（⌘⏎）と知らせ
  await row(Q).hover();
  await row(Q).locator('[data-testid="hover-toolbar"] button[aria-label^="Answer"]').click();
  await input.waitFor({ timeout: 10000 });
  await input.fill("Make it the same width\nplease");
  // 送った印（D-241）は待ちが閉じるまでの間だけ出る。送る前から待ち受ける
  const sentLine = page
    .getByTestId("answer-sent")
    .first()
    .waitFor({ state: "attached", timeout: 10000 })
    .then(() => page.getByTestId("answer-sent").first().innerText())
    .catch(() => "");
  await input.press("Meta+Enter");
  const toast = page.getByText(/^Sent( ·|, but couldn't confirm)/).first();
  await toast.waitFor({ timeout: 10000 }).catch(() => {});
  const toastText = (await toast.count()) > 0 ? await toast.innerText() : "";
  t.check(
    "after sending, a toast says where it went",
    toastText.includes("Ghostty · main:1.0"),
    toastText,
  );
  const status = page.getByRole("status").filter({ hasText: "Ghostty · main:1.0" }).first();
  t.check(
    "a confirmed send stays in Turnlane and the toast offers Open",
    (await status.getByRole("button", { name: "Open", exact: true }).count()) === 1,
  );
  const line = await sentLine;
  t.check(
    "the section keeps a sent line until the wait closes",
    /^Sent at \d{1,2}:\d{2} · (confirmed|couldn't confirm)$/.test(line),
    line,
  );
  await section.waitFor({ state: "detached", timeout: 15000 }).catch(() => {});
  t.check("the section goes away once the wait closes", (await section.count()) === 0);

  // 猶予の間の問い（D-240）: 自分の番の行はまだ無いが、AI のカードの詳細に「答える」が出て、送れる
  await page.goto(board.url.replace(/next=[^&]*/, "next=%2Fboard"));
  await row(P).waitFor({ timeout: 15000 });
  // D-245: 返答タスクはまだ無いが、自分の番の行の末尾に薄く出る（queue の grace。数と通知には入れない）
  {
    const q = await board.api<{
      items: { title: string | null }[];
      grace?: { title: string | null }[];
    }>("GET", "/queue");
    t.check(
      "a question still in its grace period is a grace row, not a your-turn task",
      (q.grace ?? []).some((x) => x.title === W) && !q.items.some((x) => x.title === W),
      JSON.stringify(q.grace?.map((x) => x.title)),
    );
  }
  // AI のレーンのカード（重なった束の中の 1 本）を id で選ぶ
  const days = await board.api<{ days: { items: { id: string; title: string | null }[] }[] }>(
    "GET",
    "/work-items",
  );
  const wid = days.days.flatMap((d) => d.items).find((x) => x.title === W)?.id ?? "";
  const card = page.locator(`[data-kind="ai"][data-id="${wid}"]`).first();
  await card.waitFor({ timeout: 10000 });
  await card.click();
  await page.getByTestId("ai-panel").waitFor({ timeout: 10000 });
  const answerBtn = page.getByTestId("ai-answer");
  await answerBtn.waitFor({ timeout: 10000 }).catch(() => {});
  t.check(
    "the detail of a question in its grace period has Answer",
    (await answerBtn.count()) === 1,
  );
  await page.keyboard.press("a");
  await section.waitFor({ timeout: 10000 });
  const gq = await page.getByTestId("answer-question").innerText();
  t.check("the grace-period question is shown in full", gq.includes("Which one?"), gq);
  await page
    .getByTestId("answer-option")
    .first()
    .waitFor({ timeout: 5000 })
    .catch(() => {});
  t.check(
    "its numbered choices become buttons",
    (await page.getByTestId("answer-option").count()) === 2,
  );
  const gsend = await page.getByTestId("answer-send").innerText();
  t.check("it can be sent to its terminal (iTerm2)", gsend.includes("iTerm2"), gsend);
  await page.getByTestId("answer-input").fill("Thicker strokes");
  await page.getByTestId("answer-input").press("Meta+Enter");
  const gtoast = page.getByText(/^Sent( ·|, but couldn't confirm)/).first();
  await gtoast.waitFor({ timeout: 10000 }).catch(() => {});
  const gtoastText = (await gtoast.count()) > 0 ? await gtoast.innerText() : "";
  t.check(
    "sending during the grace period is not refused as closed",
    gtoastText.includes("iTerm2"),
    gtoastText,
  );

  // ターミナル.app（tmux の外）の問い（D-243）: 送れる。送ると知らせに Terminal · tab
  {
    await page.goto(board.url.replace(/next=[^&]*/, "next=%2Fboard"));
    await row(P).waitFor({ timeout: 15000 });
    const items = await board.api<{ days: { items: { id: string; title: string | null }[] }[] }>(
      "GET",
      "/work-items",
    );
    const tid = items.days.flatMap((d) => d.items).find((x) => x.title === T)?.id ?? "";
    const tcard = page.locator(`[data-kind="ai"][data-id="${tid}"]`).first();
    await tcard.waitFor({ timeout: 10000 });
    await tcard.click();
    await page.getByTestId("ai-answer").waitFor({ timeout: 10000 });
    await page.keyboard.press("a");
    await section.waitFor({ timeout: 10000 });
    const tsend = await page.getByTestId("answer-send").innerText();
    t.check(
      "a Terminal.app session outside tmux can be sent to (Terminal · tab)",
      tsend.includes("Terminal · tab"),
      tsend,
    );
    await page.getByTestId("answer-input").fill("No events");
    await page.getByTestId("answer-input").press("Meta+Enter");
    const ttoast = page.getByText(/^Sent( ·|, but couldn't confirm)/).first();
    await ttoast.waitFor({ timeout: 10000 }).catch(() => {});
    const ttoastText = (await ttoast.count()) > 0 ? await ttoast.innerText() : "";
    t.check("sending to Terminal.app reports the tab", ttoastText.includes("Terminal"), ttoastText);
  }

  // Ghostty 1.3（tmux の外）の問い（D-244）: 送れる。届け先は Ghostty · tab（tmux の包みではない）
  {
    await page.goto(board.url.replace(/next=[^&]*/, "next=%2Fboard"));
    await row(P).waitFor({ timeout: 15000 });
    const items = await board.api<{ days: { items: { id: string; title: string | null }[] }[] }>(
      "GET",
      "/work-items",
    );
    const hid = items.days.flatMap((d) => d.items).find((x) => x.title === H)?.id ?? "";
    const hcard = page.locator(`[data-kind="ai"][data-id="${hid}"]`).first();
    await hcard.waitFor({ timeout: 10000 });
    await hcard.click();
    await page.getByTestId("ai-answer").waitFor({ timeout: 10000 });
    await page.keyboard.press("a");
    await section.waitFor({ timeout: 10000 });
    const hsend = await page.getByTestId("answer-send").innerText();
    t.check(
      "a Ghostty 1.3 session outside tmux can be sent to (Ghostty · tab)",
      hsend.includes("Ghostty · tab"),
      hsend,
    );
    await page.getByTestId("answer-input").fill("Right of the header");
    await page.getByTestId("answer-input").press("Meta+Enter");
    const htoast = page.getByText(/^Sent( ·|, but couldn't confirm)/).first();
    await htoast.waitFor({ timeout: 10000 }).catch(() => {});
    const htoastText = (await htoast.count()) > 0 ? await htoast.innerText() : "";
    t.check("sending to Ghostty reports the tab", htoastText.includes("Ghostty · tab"), htoastText);
  }

  // AskUserQuestion のダイアログで問いが読めない: 入力欄・送る・番号のボタンを出さず、端末で答えてもらう（開く）
  await page.goto(board.url.replace(/next=[^&]*/, "next=%2Fboard"));
  await row(D).waitFor({ timeout: 15000 });
  await row(D).hover();
  await row(D).locator('[data-testid="hover-toolbar"] button[aria-label^="Answer"]').click();
  const askNo = page.getByTestId("answer-ask-unreadable");
  await askNo.waitFor({ timeout: 10000 }).catch(() => {});
  const askText = (await askNo.count()) > 0 ? await askNo.innerText() : "";
  t.check(
    "an unreadable AskUserQuestion dialog sends nothing and offers Open only",
    askText.includes("Answer it in the terminal") &&
      (await askNo.getByTestId("answer-open").count()) === 1 &&
      (await page.getByTestId("answer-input").count()) === 0 &&
      (await page.getByTestId("answer-send").count()) === 0 &&
      (await page.getByTestId("answer-option").count()) === 0,
    askText,
  );
}

/**
 * 猶予の間の問いを自分の番の行に出す（D-245）。帯（3 件）を空けるため、先に普通の 3 行（Q・P・G）を対応不要にする（閉じた返答
 * タスクのあるターンは猶予の行にも戻らない）。行は件名が直近の指示に変わるので、queue の grace の id で探す
 */
async function runGrace(t: Ctx) {
  const { page, board } = t;
  type Q = {
    items: { workItemId: string; title: string | null; followUps: { id: string }[] }[];
    grace?: { workItemId: string; title: string | null }[];
  };
  const q0 = await board.api<Q>("GET", "/queue");
  await board.api("POST", "/follow-ups/bulk-dismiss", {
    ids: q0.items.flatMap((x) => x.followUps.map((f) => f.id)),
  });
  const q1 = await board.api<Q>("GET", "/queue");
  const gid = (s: string) => q1.grace?.find((x) => x.title === s)?.workItemId ?? "";
  t.check(
    "dismissed rows do not come back as grace rows; the three grace questions remain",
    q1.items.length === 0 && [W, T, H].every((x) => gid(x) !== ""),
    JSON.stringify(q1.grace?.map((x) => x.title)),
  );
  const row = (s: string) => page.locator(`[data-kind="turn"][data-id="${gid(s)}"]`).first();
  await page.goto(board.url.replace(/next=[^&]*/, "next=%2Fboard"));
  await row(W).waitFor({ timeout: 15000 });
  t.check(
    "grace-period questions are faded rows in today's band (D-245)",
    (await page.locator('[data-kind="turn"][data-grace]').count()) === 3 &&
      (await row(W).getAttribute("data-grace")) === "" &&
      (await row(W).evaluate((el) => el.className.includes("text-fg3"))),
  );
  const wait = await row(W).locator('[data-kind="turn-wait"]').first().innerText();
  t.check(
    "a grace row shows the time left instead of the wait",
    /^Grace · \d+m left$/.test(wait),
    wait,
  );
  await page
    .getByText("Which one?")
    .first()
    .waitFor({ timeout: 5000 })
    .catch(() => {});
  const text = await row(W).innerText();
  t.check("a grace row has the question line like a normal row", text.includes("Which one?"), text);
  const head = page.locator('section:has([data-kind="turn"][data-grace]) h2').first();
  t.check(
    "the band heading does not count grace rows",
    (await head.locator("span").count()) === 0,
    await head.innerText(),
  );
  // 行の操作: 答える・開く（ホバー）。対応不要は出さない。右クリックは 開く・答える・詳細 だけ
  await row(W).hover();
  const labels = await row(W)
    .locator('[data-testid="hover-toolbar"] button')
    .evaluateAll((xs) => xs.map((x) => x.getAttribute("aria-label") ?? ""));
  t.check(
    "a grace row's hover buttons are Open and Answer (no Not needed)",
    labels.some((x) => x.startsWith("Answer")) &&
      labels.some((x) => x.startsWith("Open")) &&
      !labels.some((x) => x.startsWith("Not needed")),
    JSON.stringify(labels),
  );
  await row(W).click({ button: "right" });
  const menu = page.getByRole("menu");
  await menu.waitFor({ timeout: 5000 });
  const items = await menu
    .locator("[data-menu-id]")
    .evaluateAll((xs) => xs.map((x) => x.getAttribute("data-menu-id") ?? ""));
  t.check(
    "a grace row's context menu has Open, Answer and Details only",
    JSON.stringify(items) === JSON.stringify(["open", "answer", "detail"]),
    JSON.stringify(items),
  );
  await page.keyboard.press("Escape");
  // a で答えるの節（詳細パネル）
  const section = page.getByTestId("answer");
  await row(W).click();
  await page.getByTestId("ai-panel").waitFor({ timeout: 10000 });
  await page.keyboard.press("a");
  await section.waitFor({ timeout: 10000 }).catch(() => {});
  const gq =
    (await section.count()) > 0 ? await page.getByTestId("answer-question").innerText() : "";
  t.check("a on a grace row opens Answer with the full question", gq.includes("Which one?"), gq);
  // ホバーの「答える」でも開く
  await page.goto(board.url.replace(/next=[^&]*/, "next=%2Fboard"));
  await row(T).waitFor({ timeout: 15000 });
  await row(T).hover();
  await row(T).locator('[data-testid="hover-toolbar"] button[aria-label^="Answer"]').click();
  await section.waitFor({ timeout: 10000 }).catch(() => {});
  const tq =
    (await section.count()) > 0 ? await page.getByTestId("answer-question").innerText() : "";
  t.check("Answer on a grace row's hover opens the section", tq.includes("No events"), tq);

  // 自分の番の画面とデイビューにも薄い行（数には含めない）
  await page.goto(board.url.replace(/next=[^&]*/, "next=%2Fqueue"));
  await row(W).waitFor({ timeout: 15000 });
  const tab = await page.locator('[data-filter="all"]').innerText();
  t.check(
    "the your-turn screen lists grace rows but its count leaves them out",
    (await page.locator('[data-kind="turn"][data-grace]').count()) === 3 && /0$/.test(tab.trim()),
    tab,
  );
  await page.goto(board.url.replace(/next=[^&]*/, "next=%2Fday"));
  await row(W).waitFor({ timeout: 15000 });
  t.check(
    "the day view lists grace rows too",
    (await page.locator('[data-kind="turn"][data-grace]').count()) === 3,
  );
  // メニューバー（ポップオーバー）: 薄い行は出し、見出しの数には含めない
  await page.goto(board.url.replace(/next=[^&]*/, "next=%2Ftray"));
  await row(W).waitFor({ timeout: 15000 });
  const trayTitle = await page.getByTestId("tray-title").innerText();
  t.check(
    "the menu bar lists grace rows but its count leaves them out",
    (await page.locator('[data-kind="turn"][data-grace]').count()) === 3 &&
      /0$/.test(trayTitle.trim()),
    trayTitle,
  );
}

export const answerGraceSuite: Suite = {
  name: "answer-grace",
  args: ["--design", "answer", "--lang", "en"],
  run: runGrace,
};

/**
 * AI のレーンで同じ時刻に重なる項目は対応が要るものを前に（D-246。dev-board --design lane）: 14:00 の完了と 14:01 の問い、
 * 16:49 の完了と 16:50 の猶予の間の問い。問いのラベルが場所を取り、完了は問いのラベルの「+1」に畳まれる
 */
async function runLane(t: Ctx) {
  const { page, board } = t;
  const all = await board.api<{ days: { items: { id: string; title: string | null }[] }[] }>(
    "GET",
    "/work-items",
  );
  const idOf = (s: string) => all.days.flatMap((d) => d.items).find((x) => x.title === s)?.id ?? "";
  const lane = (s: string) => page.locator(`[data-kind="ai"][data-id="${idOf(s)}"]`).last();
  const check = async (where: string) => {
    await lane("Fix the onboarding copy").waitFor({ timeout: 15000 });
    const q = await lane("Fix the onboarding copy").innerText();
    const done = await lane("Summarize the release notes").innerText();
    t.check(
      `${where}: a question's label wins over a done run that started first (D-246)`,
      q.includes("+1") && !done.includes("release notes"),
      JSON.stringify({ q, done }),
    );
    t.check(
      `${where}: the question's lane mark is your-turn (not ✓) with its wait`,
      (await lane("Fix the onboarding copy").locator('[data-status="your_turn"]').count()) > 0 &&
        /waiting \d+h\d+m/.test(q),
      q,
    );
    const g = await lane("Make the search box easier to find").innerText();
    const gdone = await lane("Tidy up the changelog").innerText();
    t.check(
      `${where}: a grace-period question also comes first and shows grace time`,
      /grace \d+m/.test(g) && g.includes("+1") && !gdone.includes("changelog"),
      JSON.stringify({ g, gdone }),
    );
  };
  await page.goto(board.url.replace(/next=[^&]*/, "next=%2Fboard"));
  await check("3-day board");
  await page.goto(board.url.replace(/next=[^&]*/, "next=%2Fday"));
  await check("day view");
}

export const answerLaneSuite: Suite = {
  name: "answer-lane",
  args: ["--design", "lane", "--lang", "en"],
  run: runLane,
};

export const answerSuite: Suite = {
  name: "answer",
  args: ["--design", "answer", "--lang", "en"],
  run,
};
