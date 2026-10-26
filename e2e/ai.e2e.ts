/**
 * AI の画面（ux-mvp 4.19）の E2E。dev-board --launch --scratch --live（偽の git・端末・CLI。完了した Claude Code のセッション
 * 1 本のプロセスが動いている扱い。今は 2026-10-02（金）13:20 JST）:
 *
 * 1. サイドバーの「AI」（件数は出さない）と `g a` で /ai へ。上部バーの題名の右に `動いている N · 止まっている N`
 * 2. 節は 自分の番 → 動いている → 止まっている → 片付けが残っている の順（0 件の節は出さない）。1 つの項目は 1 か所だけ
 * 3. 自分の番の数はサイドバーの「自分の番 N」と同じ
 * 4. 札: 止まっている（Claude Code のプロセスあり = 完了 · プロセスが残っている、Codex = ~ 止まった、利用上限で止まった =
 *    利用上限 · 見込み 17:40。「完了」と出さない）、片付け（worktree が残っている）
 * 5. j / k で選び、1 クリックで AI 詳細パネル。節の見出しで畳むと行が消える（ブラウザに覚える）
 * 6. 片付けの行の Space: タスクが未完了なので完了のシート（Esc で取り消すと何もしない）
 * 7. 最後の動きが 1 日より前でプロセスが残っているだけの 2 件は、末尾の畳んだ「プロセスが残っている 2」（既定で畳む。
 *    開くと同じ行。上部バーの「止まっている N」に含めない）
 * 8. 行の右端の時間は、幅 400 / 800 / 1500 のどれでも行の中のほかの要素（件名・場所・札・サブ・PR・ソースバッジ・ホバーの
 *    ボタン）と重ならない（getBoundingClientRect）。TURNLANE_E2E_SHOTS=<dir> なら 3 幅のスクリーンショットを保存する
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright";
import type { QueueResponse } from "../packages/core/src/api/index.ts";
import type { Ctx, Suite } from "./harness.ts";

async function run(c: Ctx): Promise<void> {
  const { page, check, board } = c;
  await page.goto(board.url);
  await page.waitForSelector('[data-testid="sidebar"]');

  // 1. サイドバーの「AI」（件数なし）
  const link = page.locator('[data-testid="sidebar"] a[href="/ai"]');
  check("the sidebar has an AI row", (await link.count()) === 1);
  check(
    "the AI row has no count",
    ((await link.innerText()).trim() || "") === "AI",
    await link.innerText(),
  );
  // g a で移る
  await page
    .locator("body")
    .click({ position: { x: 1, y: 1 } })
    .catch(() => {});
  await page.keyboard.press("g");
  await page.keyboard.press("a");
  await page.waitForURL(/\/ai$/, { timeout: 5000 }).catch(() => {});
  check("g a opens the AI screen", new URL(page.url()).pathname === "/ai", page.url());
  await page.waitForSelector('[data-kind="ai-row"]', { timeout: 15000 });
  await page.waitForTimeout(500);

  const summary = page.getByTestId("ai-summary");
  check(
    "the top bar shows running and stopped counts",
    (await summary.count()) === 1 &&
      /動いている \d+ · 止まっている \d+/.test(await summary.innerText()),
    (await summary.count()) ? await summary.innerText() : "",
  );

  // 2. 節の順と 1 か所
  const sections = await page
    .locator('[data-testid="ai-section"]')
    .evaluateAll((xs) => xs.map((x) => x.getAttribute("data-section")));
  check(
    "sections are in order and empty ones are hidden",
    JSON.stringify(sections) === JSON.stringify(["turn", "running", "stopped", "cleanup", "stale"]),
    JSON.stringify(sections),
  );
  const ids = await page
    .locator('[data-kind="ai-row"]')
    .evaluateAll((xs) => xs.map((x) => x.getAttribute("data-id")));
  check("each item appears once", new Set(ids).size === ids.length, JSON.stringify(ids));

  // 3. 自分の番の数（サイドバー・API と同じ）
  const q = await board.api<QueueResponse>("GET", "/queue");
  const open = q.items.filter((x) => x.followUps.some((f) => f.status === "open")).length;
  const turnRows = await page.locator('[data-kind="ai-row"][data-section="turn"]').count();
  const navCount = await page
    .locator('[data-testid="sidebar"] a[href="/queue"]')
    .innerText()
    .then((x) => Number(/(\d+)\s*$/.exec(x.trim())?.[1] ?? "-1"));
  check(
    "the Your turn section matches the sidebar count",
    turnRows === open && navCount === open,
    `${turnRows} / ${navCount} / ${open}`,
  );

  // 4. 札
  const label = (section: string) =>
    page
      .locator(`[data-kind="ai-row"][data-section="${section}"] [data-kind="ai-label"]`)
      .allInnerTexts();
  const stopped = await label("stopped");
  check(
    "stopped shows a Claude Code session with its process still running and an estimated Codex session",
    stopped.includes("完了 · プロセスが残っている") && stopped.includes("~ 止まった"),
    JSON.stringify(stopped),
  );
  // 利用上限で止まった項目（後でを対応不要にした。done · rate_limit）は「完了」と出さない
  const capped = await page
    .locator('[data-kind="ai-row"]')
    .filter({ hasText: "fix/usage-cap" })
    .locator('[data-kind="ai-label"]')
    .allInnerTexts();
  check(
    "a row stopped at the usage limit is labeled with the limit, never as done",
    capped.length === 1 && capped[0] === "利用上限 · 見込み 17:40",
    JSON.stringify(capped),
  );
  const cleanup = await label("cleanup");
  check(
    "needs cleanup shows the leftover worktree",
    cleanup.length >= 1 && cleanup.every((x) => x.startsWith("worktree")),
    JSON.stringify(cleanup),
  );
  const running = await label("running");
  check(
    "running rows are labeled",
    running.length >= 1 && running.every((x) => x.startsWith("実行中")),
  );

  // 7. プロセスが残っているだけの古い項目（既定で畳む。上部バーの止まっているの数に含めない）
  const staleHead = page.locator('[data-section="stale"] [data-testid="ai-section-head"]');
  check(
    "stale items are folded into one line at the end",
    (await staleHead.count()) === 1 &&
      (await staleHead.innerText()).includes("プロセスが残っている 2（最後の動きが 1 日より前）") &&
      (await staleHead.getAttribute("aria-expanded")) === "false" &&
      (await page.locator('[data-kind="ai-row"][data-section="stale"]').count()) === 0,
    (await staleHead.count()) ? await staleHead.innerText() : "",
  );
  const stoppedRows = await page.locator('[data-kind="ai-row"][data-section="stopped"]').count();
  const stoppedCount = Number(/止まっている (\d+)/.exec(await summary.innerText())?.[1] ?? "-1");
  check(
    "the top bar's stopped count leaves out the stale items",
    stoppedCount === stoppedRows,
    `${stoppedCount} / ${stoppedRows}`,
  );
  await staleHead.click();
  await page.waitForTimeout(100);
  const staleLabels = await label("stale");
  check(
    "opening it shows the same rows",
    staleLabels.length === 2 && staleLabels.every((x) => x === "完了 · プロセスが残っている"),
    JSON.stringify(staleLabels),
  );
  await staleHead.click();
  await page.waitForTimeout(100);
  check(
    "it folds again",
    (await page.locator('[data-kind="ai-row"][data-section="stale"]').count()) === 0,
  );

  // 8. 右端の時間が重ならない（幅 400 / 800 / 1500。行を選んだ・ホバーした状態も）
  const shots = process.env.TURNLANE_E2E_SHOTS;
  if (shots) mkdirSync(shots, { recursive: true });
  // 開いた状態で測る（プロセスが残っているの行も）
  await staleHead.click();
  await page.waitForTimeout(100);
  for (const width of [400, 800, 1500]) {
    await page.setViewportSize({ width, height: 900 });
    // 400px はサイドバーを畳む（開いたままでは画面の残りが 200px を切る。アプリの最小の幅は 1024px）
    const folded = (await page.locator('[data-testid="sidebar"]').count()) === 0;
    if ((width === 400) !== folded) await page.keyboard.press("Meta+Backslash");
    await page.waitForTimeout(300);
    const hit = await overlaps(page);
    if (width === 400) {
      // 件名は数文字は読める幅を残す（選んでいる行も）。畳んだ行の見出しは括弧の中を落として 1 行
      const narrow = await page
        .locator('[data-kind="ai-row"] [data-kind="ai-title"]')
        .evaluateAll((xs) => xs.map((x) => Math.round(x.getBoundingClientRect().width)));
      check(
        "at 400px every title keeps at least 40px",
        narrow.every((w) => w >= 40),
        JSON.stringify(narrow),
      );
      const head = await staleHead.evaluate((x) => ({
        text: (x as HTMLElement).innerText.trim(),
        h: x.getBoundingClientRect().height,
      }));
      check(
        "at 400px the folded line's heading is one line without the note",
        head.text === "プロセスが残っている 2" && head.h <= 30,
        JSON.stringify(head),
      );
    }
    check(
      `at ${width}px the time never overlaps other parts of the row`,
      hit.length === 0,
      hit.join(" | "),
    );
    // ホバーしたとき（ボタンが出て右を空ける）
    const row = page.locator('[data-kind="ai-row"][data-section="turn"]').first();
    await row.hover();
    await page.waitForTimeout(150);
    const hovered = await overlaps(page);
    check(
      `at ${width}px a hovered row keeps the time clear`,
      hovered.length === 0,
      hovered.join(" | "),
    );
    if (shots) await page.screenshot({ path: join(shots, `ai-${width}.png`), fullPage: true });
    await page.mouse.move(1, 1);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await staleHead.click();
  await page.waitForTimeout(100);

  // 5. j / k と 1 クリックの詳細パネル
  const selectedId = () =>
    page.locator('[data-kind="ai-row"][data-selected]').first().getAttribute("data-id");
  const first = await selectedId();
  await page.keyboard.press("j");
  await page.waitForTimeout(100);
  const second = await selectedId();
  check("j moves the selection", first !== null && second !== null && first !== second);
  await page.keyboard.press("k");
  await page.waitForTimeout(100);
  check("k moves it back", (await selectedId()) === first);
  await page.locator('[data-kind="ai-row"][data-section="running"]').first().click();
  await page
    .getByTestId("ai-panel")
    .waitFor({ timeout: 5000 })
    .catch(() => {});
  check("a click opens the AI detail panel", (await page.getByTestId("ai-panel").count()) === 1);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);

  // 畳む
  const head = page.locator('[data-section="stopped"] [data-testid="ai-section-head"]');
  await head.click();
  await page.waitForTimeout(100);
  check(
    "folding a section hides its rows",
    (await page.locator('[data-kind="ai-row"][data-section="stopped"]').count()) === 0,
  );
  await head.click();
  await page.waitForTimeout(100);

  // 6. 片付けの行の Space → 完了のシート（タスクが未完了）。Esc で取り消す
  await page.locator('[data-kind="ai-row"][data-section="cleanup"]').first().click();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  await page.keyboard.press("Space");
  const sheet = page.getByTestId("finish-sheet");
  await sheet.waitFor({ timeout: 5000 }).catch(() => {});
  check(
    "Space on a cleanup row opens the finish sheet",
    (await sheet.count()) === 1 && (await sheet.getAttribute("data-mode")) === "complete",
  );
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  check("Esc closes the sheet", (await sheet.count()) === 0);
  check(
    "the cleanup row is still there after cancelling",
    (await page.locator('[data-kind="ai-row"][data-section="cleanup"]').count()) >= 1,
  );
}

/** 行ごとに、右端の時間がほかの要素（見えているもの）と交わる・行からはみ出すものを返す */
function overlaps(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const visible = (r: DOMRect) => r.width > 0.5 && r.height > 0.5;
    for (const row of document.querySelectorAll<HTMLElement>('[data-kind="ai-row"]')) {
      const time = row.querySelector<HTMLElement>('[data-kind="ai-time"]');
      if (!time || !time.textContent?.trim()) continue;
      const t = time.getBoundingClientRect();
      const box = row.getBoundingClientRect();
      const id = row.getAttribute("data-id") ?? "?";
      if (t.left < box.left - 0.5 || t.right > box.right + 0.5) out.push(`${id}: time outside row`);
      const parts = [
        ...row.querySelectorAll<HTMLElement>(
          '[data-kind="ai-title"], [data-kind="ai-where"], [data-kind="ai-label"], [data-kind="ai-sub"], [data-kind="ai-pr"], [data-kind="ai-sources"], [data-testid="hover-toolbar"]',
        ),
      ];
      for (const el of parts) {
        if (getComputedStyle(el).display === "none") continue;
        const r = el.getBoundingClientRect();
        if (!visible(r)) continue;
        const cross = r.left < t.right - 0.5 && r.right > t.left + 0.5;
        if (cross)
          out.push(
            `${id}: ${el.getAttribute("data-kind") ?? el.getAttribute("data-testid")} ${Math.round(r.left)}-${Math.round(r.right)} x time ${Math.round(t.left)}-${Math.round(t.right)}`,
          );
      }
    }
    return out;
  });
}

export const aiSuite: Suite = {
  name: "ai",
  args: ["--launch", "--scratch", "--live", "--lang", "ja"],
  run,
};
