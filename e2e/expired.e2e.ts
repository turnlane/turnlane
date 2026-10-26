/**
 * 見出しの「期限切れ N」（R79）の E2E: ホバーとキーのフォーカスで期限切れになった件の件名と閉じた時刻を出し、押すとデイビューの
 * 「今日閉じた」の期限切れの行へ送って強調する。デイビューの上部の集計も同じ。放置のホバーも同じ部品（定義と内訳）。
 *
 * dev-board --design day --more-expired: 今は 2026-10-02（金）17:10 JST。期限切れは 9:00（turnlane の chore/prune-branches）と
 * 13:20（billing の chore/rename-config）の 2 件。件名は「今日閉じた」の行と同じ（直近の指示）
 */
import type { Ctx, Suite } from "./harness.ts";

async function tipText(t: Ctx): Promise<string> {
  const tip = t.page.getByTestId("tooltip");
  await tip.waitFor({ timeout: 3000 }).catch(() => {});
  return (await tip.count()) > 0 ? await tip.innerText() : "";
}

/** ホバーの内訳の行（定義の行を除く）を [件名, 時刻] に */
function tipItems(tip: string): [string, string][] {
  return tip
    .split("\n")
    .slice(1)
    .map((l) => {
      const i = l.lastIndexOf(" · ");
      return [l.slice(0, i), l.slice(i + 3)] as [string, string];
    });
}

async function run(t: Ctx) {
  const { page, board } = t;
  await page.goto(board.url.replace(/next=[^&]*/, "next=%2Fboard"));
  const item = page.locator('[data-testid="totals"] [data-totals="totals.expired"]').first();
  await item.waitFor({ timeout: 15000 });
  t.check("the board header shows Expired 2", (await item.innerText()).includes("Expired 2"));

  // ホバー: 定義の下に件名と閉じた時刻を 1 件 1 行
  await item.hover();
  const hover = await tipText(t);
  t.check(
    "hovering lists the expired items with the time they closed",
    JSON.stringify(tipItems(hover).map((x) => x[1])) === JSON.stringify(["9:00", "13:20"]) &&
      tipItems(hover).every((x) => x[0].length > 0),
    hover,
  );
  t.check(
    "the hover keeps the definition on the first line",
    hover.split("\n")[0]?.includes("expired after 72 hours") === true,
    hover,
  );
  await page.mouse.move(0, 0);

  // キーのフォーカスでも出す（a11y）。WebKit の Tab はボタンに止まらない（macOS の既定）ので、キーを押した後に
  // フォーカスを移す（:focus-visible になる）
  await page
    .locator("body")
    .click({ position: { x: 1, y: 1 } })
    .catch(() => {});
  await page.keyboard.press("Shift");
  await item.focus();
  const focused = await tipText(t);
  t.check("keyboard focus shows the same list", focused === hover, focused);

  // 押すとデイビューの「今日閉じた」の期限切れの行へ
  await item.click();
  await page.waitForURL(/\/day/, { timeout: 5000 }).catch(() => {});
  const rows = page.locator('[data-testid="closed-today"] [data-closed="expired"]');
  await rows
    .first()
    .waitFor({ timeout: 10000 })
    .catch(() => {});
  t.check("clicking opens the day view", new URL(page.url()).pathname === "/day", page.url());
  t.check("the closed list shows the 2 expired rows", (await rows.count()) === 2);
  const flashed = await rows.evaluateAll(
    (xs) => xs.filter((x) => x.classList.contains("dl-flash")).length,
  );
  t.check("the expired rows are highlighted", flashed === 2, String(flashed));
  const inView = await rows.first().evaluate((el) => {
    const r = el.getBoundingClientRect();
    return r.top >= 0 && r.bottom <= window.innerHeight;
  });
  t.check("the first expired row is scrolled into view", inView);
  t.check("the query is cleared", !page.url().includes("closed="), page.url());
  // 件名は「今日閉じた」の行と同じ（ホバーは 40 文字で … に切る）
  const rowSubjects = await rows.evaluateAll((xs) =>
    xs.map((x) => (x.querySelector(".truncate") as HTMLElement | null)?.innerText ?? ""),
  );
  const same = tipItems(hover).every((x, i) =>
    (rowSubjects[i] ?? "").startsWith(x[0].replace(/…$/, "")),
  );
  t.check(
    "the hover subjects match the closed rows",
    same,
    `${JSON.stringify(tipItems(hover))} / ${JSON.stringify(rowSubjects)}`,
  );

  // デイビューの上部の集計も同じホバーとクリック
  const dayItem = page.locator('[data-testid="day-totals"] [data-totals="totals.expired"]');
  await dayItem.hover();
  const dayHover = await tipText(t);
  t.check("the day view summary shows the same list", dayHover === hover, dayHover);
  await page.waitForTimeout(1700);
  await dayItem.click();
  await page.waitForTimeout(200);
  const again = await rows.evaluateAll(
    (xs) => xs.filter((x) => x.classList.contains("dl-flash")).length,
  );
  t.check("clicking in the day view highlights the rows again", again === 2, String(again));

  // 放置も同じ部品（定義と、デイビューではリポジトリ別の内訳）
  const idle = page.locator('[data-testid="day-totals"] [data-totals="totals.idle"]');
  if ((await idle.count()) > 0) {
    await idle.hover();
    const idleHover = await tipText(t);
    t.check(
      "the idle hover uses the same tooltip with the definition and a breakdown",
      idleHover.includes("grace period") && idleHover.split("\n").length >= 2,
      idleHover,
    );
  } else t.check("the day view shows Idle", false);
}

export const expiredSuite: Suite = {
  name: "expired",
  args: ["--design", "day", "--more-expired", "--lang", "en"],
  run,
};
