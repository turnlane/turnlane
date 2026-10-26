/**
 * 自分の番の画面の「後で」（ux-mvp 4.6）の E2E: スヌーズの「時刻を指定…」と、時間に置いた自分の番。
 *
 * dev-board --place-reply 15:00 --lang en: 今は 2026-10-02（金）13:20 JST。「Reply: draft pricing」は 9:00 に今日の
 * 15:00〜15:30 へ置いてある（開始の前なので帯から外れて後でに出る）。
 * - `s` → 4（Pick a time…）→ 読めない・過ぎた時刻は赤く示して確定しない → `16:45` ⏎ で後でへ（`Snoozed · back at 16:45`）
 * - 時間に置いた自分の番は `at 15:00`。帯・デイビューの左パネル・メニューバーの件数には出ない。自分レーンのブロックはそのまま
 * - デイビューの自分レーンのブロックを選んで `p` → 1 で置き直しても後でのまま（右端の時刻が変わる）
 * - 今やる: スヌーズは帯に戻る。時間に置いたものは時間ブロックを外して帯に戻る
 * TURNLANE_E2E_SHOTS=<dir> なら後での節に 2 種類の行が出ている状態のスクリーンショットを残す
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright";
import type { QueueResponse, QueueSummaryResponse } from "../packages/core/src/api/index.ts";
import type { Ctx, Suite } from "./harness.ts";

const TZ = "Asia/Tokyo";
const jst = (hm: string) => Date.parse(`2026-10-02T${hm}:00+09:00`);

async function settle(page: Page, ms = 250) {
  await page.waitForTimeout(ms);
}

async function until<T>(f: () => Promise<T>, ok: (v: T) => boolean, ms = 4000): Promise<T> {
  const end = Date.now() + ms;
  let v = await f();
  while (!ok(v) && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 150));
    v = await f();
  }
  return v;
}

async function go(page: Page, url: string, ready: string) {
  await settle(page, 300);
  await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
  await page.goto(url);
  await page.waitForSelector(ready, { timeout: 15000 });
  await settle(page, 300);
}

const laterRow = (page: Page, id: string) =>
  page.locator(`[data-testid="queue-later"] [data-kind="turn"][data-id="${id}"]`);
const listRow = (page: Page, id: string) =>
  page.locator(`[data-kind="turn"][data-id="${id}"]:not([data-later])`);

async function run(t: Ctx) {
  const { page, board } = t;
  const queue = () => board.api<QueueResponse>("GET", "/queue");
  const summary = () => board.api<QueueSummaryResponse>("GET", "/queue/summary");
  await page.goto(board.url.replace(/next=[^&]*/, "next=%2Fqueue"));
  await page.waitForSelector('[data-kind="turn"]', { timeout: 15000 });
  await settle(page, 400);

  const q0 = await queue();
  const placed = q0.items.find((x) => x.followUps.some((f) => f.status === "scheduled"));
  const placedFu = placed?.followUps.find((f) => f.status === "scheduled");
  t.check(
    "API: the reply placed at 15:00 is scheduled with scheduledAt = 15:00",
    placedFu?.scheduledAt === jst("15:00"),
    JSON.stringify(placedFu ?? null),
  );
  if (!placed || !placedFu) return;
  const count0 = (await summary()).count;
  t.check(
    "API: the scheduled one is not in the menu bar count",
    count0 === q0.items.filter((x) => x.followUps.some((f) => f.status === "open")).length,
    String(count0),
  );

  // ---------- 時間に置いた自分の番は後でに `at 15:00` ----------
  const pRow = laterRow(page, placed.workItemId);
  t.check("queue: the placed reply is in Later", (await pRow.count()) === 1);
  t.check(
    "queue: its right edge reads “at 15:00”",
    (await pRow.locator('[data-kind="later-back"]').innerText()) === "at 15:00",
    await pRow
      .locator('[data-kind="later-back"]')
      .innerText()
      .catch(() => ""),
  );
  t.check("queue: it is not in the list", (await listRow(page, placed.workItemId).count()) === 0);

  // ---------- s → 時刻を指定… ----------
  const target = q0.items.find(
    (x) => x.workItemId !== placed.workItemId && x.followUps.some((f) => f.status === "open"),
  );
  if (!target) {
    t.check("queue: there is an open row to snooze", false);
    return;
  }
  await listRow(page, target.workItemId).click();
  await settle(page);
  await page.keyboard.press("s");
  const pick = page.getByRole("button", { name: /Pick a time…/ });
  await pick.waitFor({ timeout: 3000 }).catch(() => {});
  t.check("s: the menu has a 4th choice “Pick a time…”", (await pick.count()) === 1);
  await page.keyboard.press("4");
  const input = page.getByTestId("snooze-pick-input");
  await input.waitFor({ timeout: 3000 }).catch(() => {});
  t.check("4: the menu turns into a one-line input", (await input.count()) === 1);
  const note = page.getByTestId("snooze-pick-note");
  await input.fill("25:00");
  await page.keyboard.press("Enter");
  await settle(page);
  t.check(
    "an unreadable time is shown in red and not submitted",
    (await note.innerText()) === "Can't read this time" &&
      (await input.getAttribute("aria-invalid")) === "true" &&
      (await input.count()) === 1,
    await note.innerText().catch(() => ""),
  );
  await input.fill("10/1 9:00");
  await page.keyboard.press("Enter");
  await settle(page);
  t.check(
    "a past time is shown in red and not submitted",
    (await note.innerText()) === "This time has passed" && (await input.count()) === 1,
    await note.innerText().catch(() => ""),
  );
  await input.fill("16:45");
  t.check(
    "a good time previews when it comes back",
    (await note.innerText()) === "Back at 16:45",
    await note.innerText().catch(() => ""),
  );
  await page.keyboard.press("Enter");
  const snoozedRow = laterRow(page, target.workItemId);
  await snoozedRow.waitFor({ timeout: 4000 }).catch(() => {});
  t.check("⏎: the row moves to Later", (await snoozedRow.count()) === 1);
  t.check(
    "its right edge reads “Snoozed · back at 16:45”",
    (await snoozedRow
      .locator('[data-kind="later-back"]')
      .innerText()
      .catch(() => "")) === "Snoozed · back at 16:45",
  );
  const q1 = await until(queue, (q) =>
    q.items.some((x) =>
      x.followUps.some((f) => f.status === "snoozed" && f.snoozeUntil === jst("16:45")),
    ),
  );
  t.check(
    "API: snoozed until 16:45 (epoch ms)",
    q1.items.some((x) =>
      x.followUps.some((f) => f.status === "snoozed" && f.snoozeUntil === jst("16:45")),
    ),
  );
  // 戻る早い順（15:00 の時間に置いた → 16:45 のスヌーズ）
  const order = await page
    .locator('[data-testid="queue-later"] [data-kind="turn"]')
    .evaluateAll((xs) => xs.map((x) => x.getAttribute("data-id")));
  t.check(
    "Later is sorted by when rows come back (15:00 placed, then 16:45 snoozed)",
    order.indexOf(placed.workItemId) >= 0 &&
      order.indexOf(placed.workItemId) < order.indexOf(target.workItemId),
    JSON.stringify(order),
  );
  const shots = process.env.TURNLANE_E2E_SHOTS;
  if (shots) {
    mkdirSync(shots, { recursive: true });
    await page.mouse.move(0, 0);
    await settle(page, 300);
    await page.screenshot({ path: join(shots, "later-two-kinds.png") });
    await page
      .getByTestId("queue-later")
      .screenshot({ path: join(shots, "later-two-kinds-section.png") });
  }

  // ---------- 今やる（スヌーズ） ----------
  await snoozedRow.hover();
  await snoozedRow.locator('[data-action="wake"]').click();
  await listRow(page, target.workItemId)
    .waitFor({ timeout: 4000 })
    .catch(() => {});
  t.check(
    "Do now (snoozed): the row goes back to the list",
    (await listRow(page, target.workItemId).count()) === 1 &&
      (await laterRow(page, target.workItemId).count()) === 0,
  );

  // ---------- デイビュー: 自分レーンには描くが、左パネルの帯には出さない ----------
  const taskId = placedFu.taskId ?? "";
  await go(page, `${board.base}/day`, "[data-day-list]");
  t.check(
    "day view: the placed reply is not in the YOUR TURN panel",
    (await page
      .locator(`[data-day-list] [data-kind="turn"][data-id="${placed.workItemId}"]`)
      .count()) === 0,
  );
  const block = page.locator(`[data-kind="task"][data-id="${taskId}"]`).first();
  await block.waitFor({ timeout: 5000 }).catch(() => {});
  t.check("day view: its block stays on the Me lane", (await block.count()) === 1, taskId);

  // ---------- p で置き直す（後でのまま、右端の時刻が変わる） ----------
  if ((await block.count()) === 1) {
    await block.click();
    await settle(page);
    await page.keyboard.press("p");
    await page
      .getByTestId("palette-input")
      .waitFor({ timeout: 3000 })
      .catch(() => {});
    await settle(page, 300);
    await page.keyboard.press("1");
    const q2 = await until(queue, (q) =>
      q.items.some((x) =>
        x.followUps.some(
          (f) => f.id === placedFu.id && f.status === "scheduled" && f.scheduledAt !== jst("15:00"),
        ),
      ),
    );
    const moved = q2.items
      .flatMap((x) => x.followUps)
      .find((f) => f.id === placedFu.id && f.status === "scheduled");
    t.check(
      "p → 1: re-placed to a free slot, still scheduled (in Later)",
      moved !== undefined && moved.scheduledAt !== jst("15:00"),
      JSON.stringify(moved ?? null),
    );
    await page.keyboard.press("Escape");
    await go(page, `${board.base}/queue`, '[data-testid="queue-later"]');
    if (moved?.scheduledAt !== undefined) {
      const hm = new Intl.DateTimeFormat("en-GB", {
        timeZone: TZ,
        hour: "numeric",
        minute: "2-digit",
      })
        .format(moved.scheduledAt)
        .replace(/^0/, "");
      const label = await laterRow(page, placed.workItemId)
        .locator('[data-kind="later-back"]')
        .innerText()
        .catch(() => "");
      t.check(
        `queue: the right edge follows the new start (at ${hm})`,
        label === `at ${hm}`,
        label,
      );
    }
  } else await go(page, `${board.base}/queue`, '[data-testid="queue-later"]');

  // ---------- 今やる（時間に置いた）: 時間ブロックを外して帯に戻す ----------
  const row = laterRow(page, placed.workItemId);
  await row.hover();
  await row.locator('[data-action="wake"]').click();
  await listRow(page, placed.workItemId)
    .waitFor({ timeout: 4000 })
    .catch(() => {});
  t.check(
    "Do now (placed): the row goes back to the list",
    (await listRow(page, placed.workItemId).count()) === 1 &&
      (await laterRow(page, placed.workItemId).count()) === 0,
  );
  const q3 = await until(queue, (q) =>
    q.items.some((x) => x.followUps.some((f) => f.id === placedFu.id && f.status === "open")),
  );
  t.check(
    "API: open again, without scheduledAt",
    q3.items.some((x) =>
      x.followUps.some(
        (f) => f.id === placedFu.id && f.status === "open" && f.scheduledAt === undefined,
      ),
    ),
  );
  t.check("API: the menu bar count is back up by one", (await summary()).count === count0 + 1);
  await go(page, `${board.base}/day`, "[data-day-list]");
  t.check(
    "day view: the block is gone from the Me lane and the row is in YOUR TURN",
    (await page.locator(`[data-kind="task"][data-id="${taskId}"]`).count()) === 0 &&
      (await page
        .locator(`[data-day-list] [data-kind="turn"][data-id="${placed.workItemId}"]`)
        .count()) === 1,
  );
}

export const laterSuite: Suite = {
  name: "later",
  args: ["--place-reply", "15:00", "--lang", "en"],
  run,
};
