/**
 * デイビューの右の一覧の E2E: 並びは 自分の番 → 未定 → 今日閉じたもの（3日ボードの列と同じく未定を上に）。今日閉じたものは
 * 既定で 1 行の要約（種類ごとの件数と返事までの中央値）に畳み、見出しを押すか ⏎ で全行を開く。開いた状態はその日のあいだ
 * ブラウザに覚える。`j` / `k` は畳んでいるときは見出しだけを通る。
 *
 * dev-board --design day --many-closed: 今は 2026-10-02（金）。今日閉じたものは 12 件（返答 9・解決（推定）1・対応不要 1・
 * 期限切れ 1）。未定のタスクがある
 */
import type { Ctx, Suite } from "./harness.ts";

const SUMMARY = '[data-testid="closed-summary"]';
const ROWS = '[data-testid="closed-today"] [data-closed]';
const SELECTED = "shadow-[inset_0_0_0_1.5px_var(--dl-accent)]";

async function run(t: Ctx) {
  const { page, board } = t;
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(board.url.replace(/next=[^&]*/, "next=%2Fday"));
  const summary = page.locator(SUMMARY);
  await summary.waitFor({ timeout: 15000 });

  // 要約の行の文面（0 の種類は出さない）
  const text = (await summary.innerText()).replace(/\s+/g, " ").trim();
  t.check(
    "the closed summary shows counts per kind and the median time to reply",
    /^今日閉じたもの 12 · 返答 9 · ~ 解決（推定） 1 · 対応不要 1 · 期限切れ 1 · 返事まで \d+m$/.test(
      text,
    ),
    text,
  );
  t.check("the closed list starts folded", (await page.locator(ROWS).count()) === 0);
  t.check(
    "the summary is collapsed (aria-expanded=false)",
    (await summary.getAttribute("aria-expanded")) === "false",
  );

  // 並び: 自分の番 → 未定 → 今日閉じたもの
  const order = await page.evaluate(() => {
    const list = document.querySelector("[data-day-list]");
    if (!list) return null;
    const y = (sel: string) => list.querySelector(sel)?.getBoundingClientRect().top ?? -1;
    return {
      turn: y('[data-testid="day-your-turn-empty"], [data-kind="turn"]'),
      add: y('[data-testid="column-add"]'),
      closed: y('[data-testid="closed-summary"]'),
    };
  });
  t.check(
    "the list is ordered your turn → unscheduled → closed today",
    order !== null && order.turn >= 0 && order.turn < order.add && order.add < order.closed,
    JSON.stringify(order),
  );
  // 畳んだ状態では未定（と「+ 追加」）が画面の中に見える
  const addInView = await page
    .locator('[data-day-list] [data-testid="column-add"]')
    .evaluate((el) => el.getBoundingClientRect().bottom <= window.innerHeight);
  t.check("with the closed list folded, unscheduled stays in view", addInView);

  // 押すと全行が開き、もう一度で畳む。開いた状態は再読み込みしても残る（その日のあいだ）
  await summary.click();
  t.check("clicking the summary shows all 12 rows", (await page.locator(ROWS).count()) === 12);
  await page.reload();
  await summary.waitFor({ timeout: 15000 });
  await page
    .locator(ROWS)
    .first()
    .waitFor({ timeout: 5000 })
    .catch(() => {});
  t.check("the open state is remembered for the day", (await page.locator(ROWS).count()) === 12);
  await summary.click();
  t.check("clicking again folds the rows", (await page.locator(ROWS).count()) === 0);

  // キー: 畳んでいるときは見出しだけを通る。⏎ で開き、開いたら j で行へ
  await page
    .locator("body")
    .click({ position: { x: 1, y: 1 } })
    .catch(() => {});
  // 見出しを押したときに選んだ見出しを外して、先頭から j で進む
  await page.keyboard.press("Escape");
  let reached = false;
  for (let i = 0; i < 40 && !reached; i++) {
    await page.keyboard.press("j");
    reached = ((await summary.getAttribute("class")) ?? "").includes(SELECTED);
  }
  t.check("j reaches the closed summary after the unscheduled tasks", reached);
  await page.keyboard.press("j");
  const passed = !((await summary.getAttribute("class")) ?? "").includes(SELECTED);
  t.check(
    "while folded, j moves past the summary (no hidden rows in between)",
    passed && (await page.locator(ROWS).count()) === 0,
  );
  await page.keyboard.press("k");
  await page.keyboard.press("Enter");
  t.check("⏎ on the summary opens the rows", (await page.locator(ROWS).count()) === 12);
  await page.keyboard.press("j");
  const firstSel = ((await page.locator(ROWS).first().getAttribute("class")) ?? "").includes(
    SELECTED,
  );
  t.check("when open, j moves into the first closed row", firstSel);
  await page.keyboard.press("k");
  await page.keyboard.press("Enter");
  t.check("⏎ on the summary folds the rows again", (await page.locator(ROWS).count()) === 0);
}

export const dayListSuite: Suite = {
  name: "day-list",
  args: ["--design", "day", "--many-closed", "--lang", "ja"],
  run,
};
