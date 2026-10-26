/**
 * ⌘K のパレットが画面を落とさないこと（ux-mvp 6.1）。dev-board --launch --scratch --live --keep-limit（利用上限の上限待ちが
 * 「後で」に残る。プロセスが残っているだけの行もある。今は 2026-10-02（金）13:20 JST）:
 *
 * 1. ボード・デイビュー・自分の番・AI の画面のそれぞれで、選択なしと選択ありで ⌘K を押すとパレットが開き、画面は落ちない
 *    （選択ありは Selected の区分が出る。自分の番と AI の画面は先頭の行に常にカーソルがあるので、選択なしは開いた直後の状態）
 * 2. AI の画面の各区分（自分の番・後で〈上限待ち〉・動いている・止まっている・片付け・プロセスが残っている）の行を選んで ⌘K
 * 3. 最近（ブラウザに保存した行）に古い形が残っていても開く: 今は無いアイコン・画面への移動、欠けた項目、壊れた値は出さない
 */
import type { Page } from "playwright";
import type { QueueResponse } from "../packages/core/src/api/index.ts";
import type { Ctx, Suite } from "./harness.ts";

const RECENT_KEY = "turnlane.palette.recent";

/** ⌘K を押してパレットが開き、アプリが落ちていないか。開いたら Esc で閉じる */
async function openPalette(page: Page): Promise<{ ok: boolean; selected: number; note: string }> {
  await page.keyboard.press("Meta+k");
  const pal = page.getByTestId("command-palette");
  await pal.waitFor({ timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(200);
  const open = (await pal.count()) === 1;
  const shell = (await page.locator('[data-testid="sidebar"]').count()) === 1;
  const selected = await page.locator('[data-row-id^="sel:"]').count();
  const note = open
    ? (await page.getByRole("option").allInnerTexts()).slice(0, 6).join(" | ")
    : (await page.locator("body").innerText()).slice(0, 200);
  if (open) {
    await page.keyboard.press("Escape");
    await pal.waitFor({ state: "detached", timeout: 2000 }).catch(() => {});
  }
  return { ok: open && shell, selected, note };
}

async function go(c: Ctx, path: string, ready: string): Promise<void> {
  const { page, board } = c;
  await page.goto(board.url.replace(/next=[^&]*/, `next=${encodeURIComponent(path)}`));
  await page.waitForSelector('[data-testid="sidebar"]');
  await page.waitForSelector(ready, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(400);
}

/** 画面の空いたところを押して選択を外し、キーを画面に向ける */
async function clearSelection(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
}

async function run(c: Ctx): Promise<void> {
  const { page, check, board } = c;
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`${e.name}: ${e.message}`.slice(0, 200)));
  /** wantSelected: null は確かめない（自分の番・AI の画面は先頭の行に常にカーソルがある） */
  const step = async (name: string, wantSelected: boolean | null) => {
    const before = errors.length;
    const r = await openPalette(page);
    check(`⌘K opens: ${name}`, r.ok, r.note);
    if (wantSelected !== null)
      check(
        `⌘K Selected ${wantSelected ? "shown" : "hidden"}: ${name}`,
        wantSelected ? r.selected > 0 : r.selected === 0,
        `${r.selected} / ${r.note}`,
      );
    check(`no errors: ${name}`, errors.length === before, errors.slice(before).join(" / "));
  };

  // 前提: 上限待ちが limitWaits に中身を持つ
  const q = await board.api<QueueResponse>("GET", "/queue");
  const waits = (q as { limitWaits?: unknown[] }).limitWaits ?? [];
  check("the queue has a limit wait", waits.length > 0, JSON.stringify(waits).slice(0, 200));

  // 1. 4 画面 × 選択なし / あり
  // cursor: 選択を外せない画面（先頭の行に常にカーソルがある）
  const screens: { name: string; path: string; row: string; cursor: boolean }[] = [
    { name: "board", path: "/board", row: '[data-kind="task"]', cursor: false },
    { name: "day", path: "/day", row: '[data-kind="task"]', cursor: false },
    { name: "queue", path: "/queue", row: '[data-kind="turn"]', cursor: true },
    { name: "ai", path: "/ai", row: '[data-kind="ai-row"]', cursor: true },
  ];
  for (const s of screens) {
    await go(c, s.path, s.row);
    await clearSelection(page);
    await step(`${s.name} without selection`, s.cursor ? null : false);
    const row = page.locator(s.row).first();
    if ((await row.count()) === 0) {
      check(`${s.name} has a row to select`, false);
      continue;
    }
    await row.click();
    await page.waitForTimeout(200);
    await step(`${s.name} with selection`, true);
  }

  // 2. AI の画面の各区分の行
  await go(c, "/ai", '[data-kind="ai-row"]');
  // 畳んだ区分（プロセスが残っている）も開いておく
  for (const h of await page
    .locator('[data-testid="ai-section"] button[aria-expanded="false"]')
    .all())
    await h.click().catch(() => {});
  const sections = await page
    .locator('[data-testid="ai-section"]')
    .evaluateAll((xs) => xs.map((x) => x.getAttribute("data-section") ?? ""));
  for (const want of ["later", "stale"])
    check(
      `the AI screen has the ${want} section`,
      sections.includes(want),
      JSON.stringify(sections),
    );
  for (const s of sections) {
    const row = page.locator(`[data-kind="ai-row"][data-section="${s}"]`).first();
    if ((await row.count()) === 0) {
      check(`AI ${s} has a row`, false);
      continue;
    }
    await row.click();
    await page.waitForTimeout(200);
    await step(`AI ${s} row selected`, true);
  }

  // 3. 最近に古い形が残っている（今は無いアイコン・画面、欠けた項目、壊れた値）
  await page.evaluate(
    ([k]) =>
      localStorage.setItem(
        k as string,
        JSON.stringify([
          {
            id: "goto:morning",
            section: "goto",
            label: "Plan the day",
            icon: { t: "glyph", name: "morning" },
            run: { t: "nav", to: "/morning" },
          },
          {
            id: "cmd:closeToday",
            section: "commands",
            label: "Close today",
            icon: { t: "glyph", name: "close" },
            run: { t: "nav", to: "/shutdown" },
          },
          { id: "cmd:reopenToday", section: "commands", label: "Reopen", run: { t: "reopenDay" } },
          null,
          { id: 3, label: { x: 1 } },
          {
            id: "goto:inbox",
            section: "goto",
            label: "Inbox",
            icon: { t: "glyph", name: "inbox" },
            run: { t: "nav", to: "/inbox" },
          },
        ]),
      ),
    [RECENT_KEY],
  );
  for (const s of screens) {
    await go(c, s.path, s.row);
    await clearSelection(page);
    const before = errors.length;
    const r = await openPalette(page);
    check(`⌘K opens with old recent rows: ${s.name}`, r.ok, r.note);
    check(
      `no errors with old recent rows: ${s.name}`,
      errors.length === before,
      errors.slice(before).join(" / "),
    );
  }
  // 古い行は出さず、今も使える行は出す
  await page.keyboard.press("Meta+k");
  await page
    .getByTestId("command-palette")
    .waitFor({ timeout: 3000 })
    .catch(() => {});
  const recentIds = await page
    .locator('[data-row-id^="recent:"]')
    .evaluateAll((xs) => xs.map((x) => x.getAttribute("data-row-id")));
  check(
    "only the still-valid recent row is shown",
    JSON.stringify(recentIds) === JSON.stringify(["recent:goto:inbox"]),
    JSON.stringify(recentIds),
  );
  await page.keyboard.press("Escape");
}

export const paletteSuite: Suite = {
  name: "palette",
  args: ["--launch", "--scratch", "--live", "--keep-limit", "--lang", "ja"],
  run,
};
