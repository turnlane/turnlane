/**
 * 「Google カレンダーで招待」（0.8.2）: dev-board --google で Google のカレンダー（you@example.com、アカウント Google）と
 * その予定（今日 16:00 の Client check-in、外部 ID <id>@google.com）がある。
 * - 空き枠から作る予定で、書き先が Google のカレンダーのときだけ「Invite…」が出る（Work では出ない）
 * - 招待する人を入れて ⏎ で Google カレンダーの作成の画面を開く（window.open を差し替えて URL を見る）。Turnlane には作らない
 * - Google の予定のパネルの「⋯」に「Open in Google Calendar」（Work の予定には無い）
 */
import type { Page } from "playwright";
import type { BoardResponse, CalendarEventView } from "../packages/core/src/api/index.ts";
import type { Board, Ctx, Suite } from "./harness.ts";

const TODAY = "2026-10-02";

async function events(board: Board): Promise<CalendarEventView[]> {
  const b = await board.api<BoardResponse>("GET", `/board?from=${TODAY}&to=${TODAY}`);
  return b.days.flatMap((d) => d.events);
}

/** 予定のレーンの hh:mm の位置（スクロールして真ん中へ） */
async function point(page: Page, hhmm: string, scroll = true) {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  const frac = (h * 60 + m) / 1440;
  return page.evaluate(
    ({ date, frac, scroll }) => {
      const g = document.querySelector<HTMLElement>(`[data-grid="${date}"]`);
      const l = document.querySelector<HTMLElement>(`[data-evgrid="${date}"]`);
      if (!g || !l) throw new Error("no grid");
      let s: HTMLElement | null = g.parentElement;
      while (
        s &&
        !(s.scrollHeight > s.clientHeight && /auto|scroll/.test(getComputedStyle(s).overflowY))
      )
        s = s.parentElement;
      if (s && scroll) {
        const r0 = g.getBoundingClientRect();
        const sr = s.getBoundingClientRect();
        s.scrollTop += r0.top + r0.height * frac - (sr.top + sr.height / 2);
      }
      const r = g.getBoundingClientRect();
      const lr = l.getBoundingClientRect();
      return { x: lr.left + lr.width * 0.5, y: r.top + r.height * frac, hourPx: r.height / 24 };
    },
    { date: TODAY, frac, scroll },
  );
}

/** 予定のレーンの空き枠を from〜to で選んで作成の入力を開く */
async function select(page: Page, from: string, to: string): Promise<boolean> {
  const a = await point(page, from);
  const b = await point(page, to, false);
  const off = a.hourPx / 20;
  await page.mouse.move(a.x, a.y + off);
  await page.mouse.down();
  await page.mouse.move(a.x, a.y + off + 8, { steps: 4 });
  await page.mouse.move(b.x, b.y + off, { steps: 12 });
  await page.waitForTimeout(100);
  await page.mouse.up();
  await page.waitForTimeout(500);
  return page
    .getByTestId("prompt-input")
    .waitFor({ timeout: 3000 })
    .then(() => true)
    .catch(() => false);
}

const opened = (page: Page) =>
  page.evaluate(() => (window as unknown as { __opened?: string[] }).__opened ?? []);

async function run(t: Ctx) {
  const { page, board } = t;
  // 外の URL を開くのは window.open（デスクトップアプリは既定のブラウザへ渡す）。差し替えて URL だけ残す
  await page.addInitScript(() => {
    const w = window as unknown as { __opened: string[] };
    w.__opened = [];
    window.open = ((u?: string | URL) => {
      w.__opened.push(String(u));
      return null;
    }) as typeof window.open;
  });
  await page.goto(board.url.replace(/next=[^&]*/, "next=%2Fday"));
  await page.waitForSelector(`[data-evgrid="${TODAY}"]`);
  await page.waitForTimeout(500);

  // ---------- 作成の入力: Work では出ない、Google で出る ----------
  const ok = await select(page, "17:00", "18:00");
  t.check("the event input opens from a free slot", ok);
  if (!ok) return;
  t.check("Work (not Google): no Invite…", (await page.getByTestId("event-invite").count()) === 0);
  await page.getByTestId("event-calendar-picker").click();
  await page.locator('[role="option"]', { hasText: "you@example.com" }).first().click();
  await page.waitForTimeout(200);
  const invite = page.getByTestId("event-invite");
  t.check("Google calendar: Invite… appears", (await invite.count()) === 1);
  await page.getByTestId("prompt-input").fill("Plan & review");
  await invite.click();
  const guests = page.getByTestId("invite-guests");
  await guests.waitFor({ timeout: 2000 });
  const row = await page.getByTestId("invite-row").innerText();
  t.check(
    "invite row: only the guests field and the hint; the toggle reads Stop inviting",
    row.includes("Guests") &&
      row.includes("Not saved in Turnlane") &&
      !row.includes("Open in Google Calendar") &&
      (await invite.innerText()) === "Stop inviting",
    row,
  );
  t.check(
    "while the row is open, Create is gone and the main button is Open in Google Calendar (disabled)",
    (await page.getByTestId("prompt-create").count()) === 0 &&
      (await page.getByTestId("invite-open").innerText()).includes("Open in Google Calendar") &&
      (await page.getByTestId("invite-open").isDisabled()),
  );
  await guests.fill("not-an-email");
  t.check(
    "Open stays disabled until an entry looks like an email",
    await page.getByTestId("invite-open").isDisabled(),
  );
  const before = (await events(board)).length;
  // ⏎ in the title with no valid guest: moves to the guests field, creates nothing
  await page.getByTestId("prompt-input").press("Enter");
  await page.waitForTimeout(400);
  t.check(
    "⏎ in the title without a valid guest focuses the guests field and creates nothing",
    (await guests.evaluate((el) => el === document.activeElement)) &&
      (await events(board)).length === before &&
      (await opened(page)).length === 0,
  );
  // ⎋ closes the row, clears the guests and brings Create back (the input stays)
  await guests.press("Escape");
  await page.waitForTimeout(200);
  t.check(
    "Esc closes the row and restores Create",
    (await page.getByTestId("invite-row").count()) === 0 &&
      (await page.getByTestId("prompt-input").count()) === 1 &&
      (await page.getByTestId("prompt-create").count()) === 1 &&
      (await invite.innerText()) === "Invite…",
  );
  await invite.click();
  t.check("reopening starts with empty guests", (await guests.inputValue()) === "");
  // the toggle also closes
  await invite.click();
  await page.waitForTimeout(150);
  t.check(
    "Stop inviting closes the row and restores Create",
    (await page.getByTestId("invite-row").count()) === 0 &&
      (await page.getByTestId("prompt-create").count()) === 1,
  );
  await invite.click();
  await guests.fill("a@example.com, b+x@example.com");
  // ⏎ in the title (not only in the guests field) opens Google
  await page.getByTestId("prompt-input").press("Enter");
  await page.waitForTimeout(500);
  const urls = await opened(page);
  const u = urls.at(-1) ? new URL(urls.at(-1) as string) : null;
  t.check(
    "⏎ opens Google Calendar's event editor with title, time, time zone, guests and the account",
    !!u &&
      u.origin + u.pathname === "https://calendar.google.com/calendar/u/0/r/eventedit" &&
      u.searchParams.get("text") === "Plan & review" &&
      u.searchParams.get("dates") === "20261002T170000/20261002T180000" &&
      u.searchParams.get("ctz") === "Asia/Tokyo" &&
      u.searchParams.get("add") === "a@example.com,b+x@example.com" &&
      u.searchParams.get("authuser") === "you@example.com",
    urls.at(-1) ?? "none",
  );
  const toast = await page
    .getByRole("status")
    .filter({ hasText: "Opened Google Calendar" })
    .count();
  t.check(
    "the input closes, a toast says so, and nothing is created in Turnlane",
    (await page.getByTestId("prompt-input").count()) === 0 &&
      toast > 0 &&
      (await events(board)).length === before,
  );

  // ---------- 予定のパネルの ⋯ ----------
  const panelMenu = async (title: string) => {
    const e = (await events(board)).find((x) => x.title === title);
    if (!e) return [];
    await page.keyboard.press("Escape");
    const box = await page.locator(`[data-kind="event"][data-id="${e.id}"]`).first().boundingBox();
    if (box) await page.mouse.click(box.x + box.width / 2, box.y + 6);
    await page
      .getByTestId("event-panel")
      .getByTestId("event-fields")
      .waitFor({ timeout: 5000 })
      .catch(() => {});
    await page.getByTestId("event-more").click();
    await page.waitForTimeout(200);
    return page
      .locator('[data-testid="context-menu"] [data-menu-id]')
      .evaluateAll((els) => els.map((x) => x.getAttribute("data-menu-id")));
  };
  const googleIds = await panelMenu("Client check-in");
  t.check(
    "Google event: ⋯ has Open in Google Calendar right after Open in Calendar",
    googleIds.indexOf("eventOpenGoogle") === googleIds.indexOf("eventOpen") + 1 &&
      googleIds.includes("eventOpen"),
    JSON.stringify(googleIds),
  );
  await page.locator('[data-menu-id="eventOpenGoogle"]').click();
  await page.waitForTimeout(300);
  const last = (await opened(page)).at(-1) ?? "";
  const eid = last.slice(last.lastIndexOf("/") + 1);
  const decoded = Buffer.from(eid.replaceAll("-", "+").replaceAll("_", "/"), "base64").toString(
    "utf8",
  );
  t.check(
    "it opens the event's editor (eid = event id + calendar email)",
    last.startsWith("https://calendar.google.com/calendar/u/0/r/eventedit/") &&
      decoded === "7kq2c3m9g1v0p8r5example you@example.com",
    `${last} ${decoded}`,
  );
  await page.keyboard.press("Escape");
  const workIds = await panelMenu("Design review");
  t.check(
    "Work event: no Open in Google Calendar",
    workIds.length > 0 && !workIds.includes("eventOpenGoogle"),
    JSON.stringify(workIds),
  );
}

export const googleInviteSuite: Suite = {
  name: "google-invite",
  args: ["--lang", "en", "--google"],
  run,
};
