/**
 * 0.8 の小物の E2E（dev-board --lang en。今は 2026-10-02（金）13:20 JST）。
 * - snooze-pick: AI の詳細パネルの ⋯ › スヌーズ › 「Pick a time…」で時刻を指定してスヌーズする（Issue #4）
 * - calendar-hide: 設定 › カレンダーの「Hide」で、その予定をデイビューに描かない。会議の長さ・空き枠は変わらない（Issue #5）
 */
import type { Page } from "playwright";
import type { DayResponse, QueueResponse } from "../packages/core/src/api/index.ts";
import type { Ctx, Suite } from "./harness.ts";

const TODAY = "2026-10-02";
const jst = (hm: string) => Date.parse(`${TODAY}T${hm}:00+09:00`);

async function settle(page: Page, ms = 300) {
  await page.waitForTimeout(ms);
}

async function until<T>(f: () => Promise<T>, ok: (v: T) => boolean, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  let v = await f();
  while (!ok(v) && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 150));
    v = await f();
  }
  return v;
}

async function snoozePick(t: Ctx) {
  const { page, board } = t;
  const queue = () => board.api<QueueResponse>("GET", "/queue");
  const q = await queue();
  const it = q.items.find((x) => x.followUps.some((f) => f.status === "open"));
  const fu = it?.followUps.find((f) => f.status === "open");
  t.check("API: an open Your turn item to snooze", !!it && !!fu);
  if (!it || !fu) return;
  await page.goto(
    board.url.replace(/next=[^&]*/, `next=${encodeURIComponent(`/board?panel=${it.workItemId}`)}`),
  );
  await page.getByTestId("ai-more").waitFor({ timeout: 15000 });
  await settle(page);
  await page.getByTestId("ai-more").click();
  await page.locator('[data-testid="context-menu"] [data-menu-id="snooze"]').click();
  const pick = page.locator('[data-testid="context-menu"] [data-menu-id="snooze-pick"]');
  await pick.waitFor({ timeout: 3000 });
  t.check(
    "panel: the snooze menu has “Pick a time…”",
    (await pick.innerText()).includes("Pick a time"),
  );
  await pick.click();
  const input = page.getByTestId("snooze-pick-input");
  await input.waitFor({ timeout: 3000 });
  await input.fill("16:45");
  await settle(page, 150);
  t.check(
    "panel: the note says when it comes back",
    (await page.getByTestId("snooze-pick-note").innerText()).includes("16:45"),
  );
  await input.press("Enter");
  const after = await until(queue, (x) =>
    x.items.some((y) => y.followUps.some((f) => f.id === fu.id && f.status === "snoozed")),
  );
  const snoozed = after.items.flatMap((x) => x.followUps).find((f) => f.id === fu.id);
  t.check(
    "API: snoozed until 16:45",
    snoozed?.status === "snoozed" && snoozed.snoozeUntil === jst("16:45"),
    JSON.stringify(snoozed ?? null),
  );
}

async function calendarHide(t: Ctx) {
  const { page, board } = t;
  const day = () => board.api<DayResponse>("GET", `/day/${TODAY}`);
  const before = (await day()).day;
  t.check("API: today has events", before.events.length > 0);
  await page.goto(board.url.replace(/next=[^&]*/, "next=%2Fsettings%23calendar"));
  // 今日の予定のカレンダーを表示しない
  const calId = before.events[0]?.calendarId ?? "";
  const box = page.locator(`[data-calendar-id="${calId}"] [data-testid="settings-calendar-hide"]`);
  await box.waitFor({ timeout: 15000 });
  await settle(page);
  await box.click();
  const after = (await until(day, (x) => x.day.events.every((e) => e.calendarId !== calId), 5000))
    .day;
  t.check(
    "API: the hidden calendar's events are not drawn",
    after.events.every((e) => e.calendarId !== calId) &&
      before.events.some((e) => e.calendarId === calId),
  );
  t.check(
    "API: meetings, free slots and busy time do not change",
    after.totals.meetingsMs === before.totals.meetingsMs &&
      JSON.stringify(after.freeSlots) === JSON.stringify(before.freeSlots) &&
      after.totals.eventsMs === before.totals.eventsMs,
  );
  await page.goto(board.url.replace(/next=[^&]*/, "next=%2Fday"));
  await page.waitForSelector('[data-kind="event"], [data-testid="day-view"]', { timeout: 15000 });
  await settle(page, 600);
  const shown = await page.locator(`[data-kind="event"][data-calendar-id="${calId}"]`).count();
  const anyHiddenTitle = before.events
    .filter((e) => e.calendarId === calId)
    .map((e) => e.title)
    .filter(Boolean);
  const text = await page.locator("body").innerText();
  t.check(
    "day view: the hidden calendar's events are gone",
    shown === 0 && anyHiddenTitle.every((x) => !text.includes(x as string)),
    anyHiddenTitle.join(", "),
  );
  // 戻すとまた描く
  await page.goto(board.url.replace(/next=[^&]*/, "next=%2Fsettings%23calendar"));
  await page.getByTestId("settings-calendar-hide").first().waitFor({ timeout: 15000 });
  await settle(page);
  await page
    .locator(`[data-calendar-id="${calId}"] [data-testid="settings-calendar-hide"]`)
    .click();
  const back = (await until(day, (x) => x.day.events.length === before.events.length)).day;
  t.check("API: unhiding draws them again", back.events.length === before.events.length);
}

export const snoozePickSuite: Suite = {
  name: "snooze-pick",
  args: ["--lang", "en"],
  run: snoozePick,
};
export const calendarHideSuite: Suite = {
  name: "calendar-hide",
  args: ["--lang", "en"],
  run: calendarHide,
};
