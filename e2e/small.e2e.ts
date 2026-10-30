/**
 * 0.8 の小物の E2E（dev-board --lang en。今は 2026-10-02（金）13:20 JST）。
 * - snooze-pick: AI の詳細パネルの ⋯ › スヌーズ › 「Pick a time…」で時刻を指定してスヌーズする（Issue #4）
 * - calendar-hide: 上部バーの「Calendars ▾」のポップオーバーでカレンダーを表示しない・戻す。会議の長さ・空き枠は変わらない（Issue #5）
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
  const calId = before.events[0]?.calendarId ?? "";
  const titles = before.events
    .filter((e) => e.calendarId === calId)
    .map((e) => e.title)
    .filter((x): x is string => !!x);
  // デイビューの上部バーの「Calendars ▾」→ ポップオーバーのチェックを外す
  await page.goto(board.url.replace(/next=[^&]*/, "next=%2Fday"));
  const btn = page.getByTestId("calendars-button");
  await btn.waitFor({ timeout: 15000 });
  await settle(page, 600);
  t.check("bar: the Calendars button", (await btn.innerText()).includes("Calendars"));
  await btn.click();
  const check = page.locator(
    `[data-testid="calendars-item"][data-calendar-id="${calId}"] [data-testid="calendars-check"]`,
  );
  await check.waitFor({ timeout: 3000 });
  t.check("popover: the calendar is listed and checked", await check.isChecked());
  // Space で切り替え（最初のカレンダーに focus がある。↓ で移れる）
  await check.focus();
  await page.keyboard.press("Space");
  const gone = await until(
    async () => {
      const text = await page.locator("main, body").first().innerText();
      return titles.every((x) => !text.includes(x));
    },
    (v) => v,
  );
  t.check("day view: its events disappear right away", gone, titles.join(", "));
  await page.keyboard.press("Escape");
  await settle(page);
  t.check(
    "bar: the button says how many are hidden",
    (await btn.innerText()).includes("1 hidden"),
    await btn.innerText(),
  );
  const after = (await until(day, (x) => x.day.events.every((e) => e.calendarId !== calId))).day;
  t.check(
    "API: meetings, free slots and busy time do not change",
    after.totals.meetingsMs === before.totals.meetingsMs &&
      JSON.stringify(after.freeSlots) === JSON.stringify(before.freeSlots) &&
      after.totals.eventsMs === before.totals.eventsMs,
  );
  // 3 日ボードでも消えている（同じ設定）
  await page.goto(board.url.replace(/next=[^&]*/, "next=%2Fboard"));
  await page.getByTestId("calendars-button").waitFor({ timeout: 15000 });
  await settle(page, 600);
  const boardText = await page.locator("body").innerText();
  t.check(
    "board: hidden there too",
    titles.every((x) => !boardText.includes(x)),
  );
  // 設定 › カレンダーの行には印だけ
  await page.goto(board.url.replace(/next=[^&]*/, "next=%2Fsettings%23calendar"));
  const mark = page.locator(
    `[data-testid="settings-calendar-row"][data-calendar-id="${calId}"] [data-testid="settings-calendar-hidden"]`,
  );
  await mark.waitFor({ timeout: 15000 });
  t.check(
    "settings: the row says it is hidden and where to show it again",
    (await mark.innerText()).includes("Calendars on the board"),
  );
  // ポップオーバーから戻す
  await page.goto(board.url.replace(/next=[^&]*/, "next=%2Fday"));
  await page.getByTestId("calendars-button").click({ timeout: 15000 });
  await check.waitFor({ timeout: 3000 });
  await check.click();
  const back = (await until(day, (x) => x.day.events.length === before.events.length)).day;
  t.check(
    "popover: checking it again draws the events again",
    back.events.length === before.events.length,
  );
}

/** 設定 › 一般の「更新」: 今すぐ確認を押すと行が変わる（dev-board は確認しないので、/api/update は偽の応答） */
async function updateCheckNow(t: Ctx) {
  const { page, board } = t;
  const checkedAt = Date.parse(`${TODAY}T16:02:00+09:00`);
  const base = {
    enabled: true,
    configured: true,
    current: "0.8.0",
    build: "0.8.0+e820ba7",
    latest: {
      version: "0.8.0",
      url: "https://github.com/o/r/releases/download/v0.8.0/x.zip",
      sha256: null,
    },
    available: false,
    checkedAt,
    error: null,
    result: "up_to_date",
    channel: "download",
    upgradeCommand: null,
    releasesUrl: "https://github.com/o/r/releases/latest",
    dismissed: null,
    off: null,
    downloadEnabled: true,
    download: { state: "idle", version: null, path: null, error: null, at: 0 },
  };
  let status: Record<string, unknown> = base;
  let posted = 0;
  await page.route(
    (u) => u.pathname === "/api/update" || u.pathname === "/api/update/check",
    async (route) => {
      if (route.request().method() === "POST") {
        posted++;
        status = {
          ...base,
          latest: {
            version: "0.8.1",
            url: "https://github.com/o/r/releases/download/v0.8.1/x.zip",
            sha256: null,
          },
          available: true,
          result: "available",
          checkedAt: checkedAt + 25 * 60_000,
          download: { state: "ready", version: "0.8.1", path: "/tmp/x", error: null, at: 0 },
        };
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(status),
      });
    },
  );
  await page.goto(board.url.replace(/next=[^&]*/, "next=%2Fsettings%23general"));
  const row = page.getByTestId("settings-update-line");
  await row.waitFor({ timeout: 15000 });
  await settle(page, 400);
  t.check(
    "settings: the line shows the version, the last check and up to date",
    (await row.innerText()) === "v0.8.0+e820ba7 · Last checked 16:02 · Up to date",
    await row.innerText(),
  );
  await page.getByTestId("settings-update-check-now").click();
  await until(
    () => row.innerText(),
    (x) => x.includes("0.8.1 is available"),
  );
  t.check("settings: Check now asks the daemon", posted === 1);
  t.check(
    "settings: the line changes to the new version",
    (await row.innerText()) === "v0.8.0+e820ba7 · Last checked 16:27 · 0.8.1 is available",
    await row.innerText(),
  );
  t.check(
    "settings: the same flow as the bar (ready → Restart to update) is here too",
    (await page.getByTestId("settings-update-install").count()) === 1 &&
      (await page.getByTestId("settings-update-notice").innerText()).includes("0.8.1 is ready"),
  );
}

export const updateCheckSuite: Suite = {
  name: "update-check",
  args: ["--lang", "en"],
  run: updateCheckNow,
};

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
