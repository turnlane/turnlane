/**
 * 予定を取り込む範囲（7 日前〜90 日後。0.8.2）: dev-board の固定データでは 84 日後に Quarterly review がある。
 * 範囲の中の 84 日後は予定が出て 1 行は無い。範囲の外（91 日後・14 日前）は「まだ取り込んでいません」の 1 行が出る
 */
import type { Page } from "playwright";
import type { BoardResponse } from "../packages/core/src/api/index.ts";
import type { Ctx, Suite } from "./harness.ts";

const TODAY = "2026-10-02";

function addDays(d: string, n: number): string {
  const t = new Date(`${d}T00:00:00Z`).getTime() + n * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

async function press(page: Page, key: string, n: number) {
  for (let i = 0; i < n; i++) await page.keyboard.press(key);
  await page.waitForTimeout(800);
}

async function run(t: Ctx) {
  const { page, board } = t;
  const st = await board.api<{
    window: { from: string; to: string; pastDays: number; futureDays: number };
  }>("GET", "/calendar/status");
  t.check(
    "status: the synced range is 7 days back to 90 days ahead",
    st.window.from === addDays(TODAY, -7) &&
      st.window.to === addDays(TODAY, 90) &&
      st.window.pastDays === 7 &&
      st.window.futureDays === 90,
    JSON.stringify(st.window),
  );
  const far = addDays(TODAY, 84);
  const b = await board.api<BoardResponse>("GET", `/board?from=${far}&to=${far}`);
  t.check(
    "API: an event 84 days ahead is synced",
    (b.days[0]?.events ?? []).some((e) => e.title === "Quarterly review"),
  );

  await page.goto(board.url.replace(/next=[^&]*/, "next=%2Fday"));
  await page.getByTestId("day-title").waitFor({ timeout: 15000 });
  await page.mouse.click(5, 5);
  t.check("today: no note", (await page.getByTestId("sync-range-note").count()) === 0);
  // ] / [ はデイビューで 1 週ずつ
  await press(page, "]", 12);
  const shown84 = await page
    .locator('[data-kind="event"]', { hasText: "Quarterly review" })
    .first()
    .waitFor({ timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  t.check(
    "day view 84 days ahead: the event is shown and there is no note",
    shown84 && (await page.getByTestId("sync-range-note").count()) === 0,
  );
  await press(page, "]", 1);
  const note = page.getByTestId("sync-range-note").first();
  const text = await note.innerText().catch(() => "");
  t.check(
    "day view 91 days ahead: the note says events aren't synced, with the range",
    text === "Events aren't synced for this day (synced range: 7 days back to 90 days ahead)" &&
      (await note.getAttribute("data-date")) === addDays(TODAY, 91),
    text,
  );
  await page.keyboard.press("t");
  await page.waitForTimeout(500);
  await press(page, "[", 2);
  t.check(
    "day view 14 days back: the same note",
    (await page.getByTestId("sync-range-note").count()) === 1,
  );
  // 3 日ボード: 範囲の外の列だけ
  await page.goto(board.url.replace(/next=[^&]*/, "next=%2Fboard"));
  await page.waitForSelector(`[data-grid="${TODAY}"]`);
  t.check("3-day board today: no note", (await page.getByTestId("sync-range-note").count()) === 0);
}

export const syncWindowSuite: Suite = {
  name: "sync-window",
  args: ["--lang", "en"],
  run,
};
