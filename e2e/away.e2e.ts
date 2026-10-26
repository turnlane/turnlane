/**
 * 離れていた間のまとめ（D-214 (2)、ux-mvp 4.13）の E2E: 今日の列の帯の見出しの右とメニューバーに 1 行、押すと件が開き、
 * 件を開くとまとめが閉じる（同じ離席ではもう出ない）。PR の終わった件の行に変更の量。
 *
 * dev-board --design away: 今は 2026-10-02（金）17:50 JST。17:14〜17:48 に離席し、その間に 完了 1 · PR 1 · 新しい待ち 1
 */
import type { AwayResponse } from "../packages/core/src/api/index.ts";
import type { Ctx, Suite } from "./harness.ts";

/**
 * デイビューの AI レーンの文字（題名・待ちの札・在席の札）が互いに重ならず、今の線にも重ならない（lane-labels）。
 * 離れていた間の網掛け（D-224）の上で 会議中・タスクなし・離席 · 数えない・放置 が重なっていた
 */
async function laneLabels(t: Ctx) {
  const { page, board } = t;
  await page.goto(board.url.replace(/next=[^&]*/, "next=%2Fday"));
  const lane = page.locator('[data-lane="ai"]');
  await lane.waitFor({ timeout: 15000 });
  await page.getByTestId("now-line").first().scrollIntoViewIfNeeded();
  await page.waitForTimeout(800);
  const boxes = await lane.evaluate((el) =>
    [...el.querySelectorAll('[data-label="ai"], [data-wait-label]')].map((x) => {
      const r = x.getBoundingClientRect();
      return { text: (x as HTMLElement).innerText.replace(/\s+/g, " "), r };
    }),
  );
  const nowBox = await page.getByTestId("now-line").first().boundingBox();
  const hit = (a: DOMRect, b: DOMRect) =>
    a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  const pairs: string[] = [];
  for (const [i, a] of boxes.entries())
    for (const b of boxes.slice(i + 1)) if (hit(a.r, b.r)) pairs.push(`${a.text} × ${b.text}`);
  t.check(
    "the AI lane labels do not overlap",
    boxes.length >= 3 && pairs.length === 0,
    pairs.join(" | "),
  );
  const ny = nowBox ? nowBox.y : -1;
  const onNow = boxes.filter((b) => b.r.top < ny && ny < b.r.bottom).map((b) => b.text);
  t.check(
    "no label sits on the now line",
    nowBox !== null && onNow.length === 0,
    onNow.join(" | "),
  );
  t.check(
    "labels with no room are left to the hover",
    (await lane.locator('[data-wait="excluded-hover"]').count()) > 0,
  );
}

async function run(t: Ctx) {
  const { page, board } = t;
  await laneLabels(t);
  const before = await board.api<AwayResponse>("GET", "/away");
  t.check(
    "the API returns 17:14–17:48 with 1 done · 1 PR · 1 new wait",
    JSON.stringify(before.digest?.counts) === JSON.stringify({ done: 1, pr: 1, wait: 1, error: 0 }),
    JSON.stringify(before.digest?.counts),
  );

  // 帯の見出し
  await page.goto(board.url.replace(/next=[^&]*/, "next=%2Fboard"));
  const band = page.locator('[data-testid="away"][data-variant="band"]');
  await band.waitFor({ timeout: 10000 }).catch(() => {});
  const line = band.getByTestId("away-line");
  const text = (await line.count()) > 0 ? await line.innerText() : "";
  t.check(
    "the band shows the line next to Your turn",
    text.includes("17:14–17:48") && text.includes("1 done · 1 PR · 1 new wait"),
    text,
  );
  await line.click();
  const items = band.getByTestId("away-item");
  await items
    .first()
    .waitFor({ timeout: 3000 })
    .catch(() => {});
  const rows = await items.allInnerTexts();
  t.check("expanding lists the 3 items", rows.length === 3, rows.join(" | "));
  t.check(
    "the PR item says what happened with the change size and CI",
    rows.some(
      (r) => r.includes("Opened PR #190") && r.includes("+120 −8") && r.includes("CI passed"),
    ),
    rows.join(" | "),
  );
  t.check(
    "the question item says when it stopped",
    rows.some((r) => r.includes("Question · 17:41")),
    rows.join(" | "),
  );
  const change = await page.locator('[data-kind="turn-change"]').allInnerTexts();
  t.check(
    "the PR row in Your turn shows the change size",
    change.some((c) => c.includes("4 files")),
    change.join(" | "),
  );

  // メニューバー（同じ 1 行）
  await page.setViewportSize({ width: 360, height: 560 });
  await page.goto(`${board.base}/tray`);
  const tline = page.locator('[data-testid="away"][data-variant="tray"]').getByTestId("away-line");
  await tline.waitFor({ timeout: 10000 }).catch(() => {});
  const ttext = (await tline.count()) > 0 ? await tline.innerText() : "";
  t.check("the menu bar shows the same line", ttext.includes("1 done · 1 PR · 1 new wait"), ttext);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${board.base}/board`);
  await line.waitFor({ timeout: 10000 }).catch(() => {});
  await line.click();
  await items
    .first()
    .waitFor({ timeout: 3000 })
    .catch(() => {});

  // 件を開くとまとめが閉じる
  await items.filter({ hasText: "Opened PR #190" }).first().click();
  await page.waitForTimeout(800);
  t.check("opening an item hides the line", (await page.getByTestId("away").count()) === 0);
  const after = await board.api<AwayResponse>("GET", "/away");
  t.check("the same away is not shown again", after.digest === null);
}

export const awaySuite: Suite = {
  name: "away",
  args: ["--design", "away", "--lang", "en"],
  run,
};
