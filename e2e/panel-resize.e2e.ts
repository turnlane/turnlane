/**
 * 右の詳細パネルの幅（ux-mvp 4.12.1）:
 * - 左の縁のホバーで線と col-resize のカーソル。つまむ所はパネルの内側だけ（左のボードの当たりを奪わない）
 * - ドラッグで幅が変わる。離すまで保存しない。ドラッグ中は文字を選ばない
 * - 最小 320px・最大（パネルの左に 640px を残す）で止まる。窓を狭めると収め、広げれば戻る
 * - ダブルクリックで既定（380px）に戻す
 * - 幅は1つだけ（AI・タスク・予定・自分の番のパネル、全画面で共通）。再読み込みしても保たれる
 * - 縁は role="separator"。←/→ で変わる
 *
 * dev-board の既定のデータ: 今は 2026-10-02（金）13:20 JST
 */
import type { Page } from "playwright";
import type { Ctx, Suite } from "./harness.ts";

const TODAY = "2026-10-02";
const MIN = 320;
const DEFAULT = 380;
const MAIN_MIN = 640;

async function settle(page: Page, ms = 250) {
  await page.waitForTimeout(ms);
}

async function until<T>(f: () => Promise<T>, ok: (v: T) => boolean, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  let v = await f();
  while (!ok(v) && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 100));
    v = await f();
  }
  return v;
}

async function go(page: Page, url: string) {
  await settle(page, 300);
  await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
  await page.goto(url);
}

const frameWidth = (page: Page) =>
  page.getByTestId("panel-frame").evaluate((e) => Math.round(e.getBoundingClientRect().width));
/** パネルとその左の領域を合わせた幅 */
const rowWidth = (page: Page) =>
  page
    .getByTestId("panel-frame")
    .evaluate((e) => Math.round((e.parentElement as HTMLElement).clientWidth));
const saved = async (t: Ctx) =>
  (await t.board.api<{ panelWidth: number | null }>("GET", "/settings/ui")).panelWidth;

/** 縁を dx だけ動かす（負で左 = 広く）。up=false なら押したままにする */
async function drag(page: Page, dx: number, up = true) {
  const box = await page.getByTestId("panel-resize").boundingBox();
  if (!box) throw new Error("no resize edge");
  const x = box.x + box.width / 2;
  const y = box.y + 300;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y, { steps: 8 });
  if (up) await page.mouse.up();
  await settle(page, 200);
}

async function openAiOnBoard(page: Page) {
  await page.waitForSelector('[data-kind="ai"][data-id]');
  await page.locator('[data-kind="ai"][data-id]').last().click({
    force: true,
  });
  await page.getByTestId("ai-panel").waitFor({ timeout: 3000 });
  await settle(page, 300);
}

async function run(t: Ctx) {
  const { page, board } = t;
  await page.goto(t.board.url.replace(/next=[^&]*/, "next=%2Fboard"));
  await openAiOnBoard(page);

  // 既定の幅
  const edge = page.getByTestId("panel-resize");
  t.check(
    "default: 380px, separator with aria-valuenow",
    (await frameWidth(page)) === DEFAULT &&
      (await edge.getAttribute("role")) === "separator" &&
      (await edge.getAttribute("aria-valuenow")) === String(DEFAULT) &&
      (await saved(t)) === null,
  );

  // ホバー: 線とカーソル。当たりはパネルの内側だけ
  const box = await edge.boundingBox();
  const frameBox = await page.getByTestId("panel-frame").boundingBox();
  await page.mouse.move((box?.x ?? 0) + 2, (box?.y ?? 0) + 300);
  await settle(page, 200);
  const hover = await edge.evaluate((e) => ({
    cursor: getComputedStyle(e).cursor,
    line: getComputedStyle(e.firstElementChild as Element).opacity,
  }));
  const outside = await page.evaluate(
    ([x, y]) =>
      document
        .elementFromPoint(x as number, y as number)
        ?.closest('[data-testid="panel-resize"]') !== null,
    [(frameBox?.x ?? 0) - 2, (box?.y ?? 0) + 300],
  );
  t.check(
    "hover: col-resize cursor and a line; hit area stays inside the panel",
    hover.cursor === "col-resize" &&
      hover.line === "1" &&
      (box?.x ?? -1) >= (frameBox?.x ?? 0) - 0.5 &&
      (box?.width ?? 99) <= 8 &&
      !outside,
    `${JSON.stringify(hover)} ${box?.x} ${frameBox?.x} ${box?.width} ${outside}`,
  );

  // ドラッグ: 押している間は保存しない、離したら保存する、文字は選ばれない
  await drag(page, -100, false);
  const mid = await frameWidth(page);
  const midSaved = await saved(t);
  await page.mouse.up();
  const after = await until(
    () => saved(t),
    (v) => v !== null,
  );
  const selected = await page.evaluate(() => window.getSelection()?.toString() ?? "");
  t.check(
    "drag: width follows the pointer, saved only on release, no text selection",
    mid === DEFAULT + 100 &&
      midSaved === null &&
      after === DEFAULT + 100 &&
      (await frameWidth(page)) === DEFAULT + 100 &&
      (await edge.getAttribute("aria-valuenow")) === String(DEFAULT + 100) &&
      selected === "",
    `${mid} ${midSaved} ${after} ${JSON.stringify(selected.slice(0, 40))}`,
  );

  // 範囲で止まる
  const max = (await rowWidth(page)) - MAIN_MIN;
  await drag(page, -1200);
  const atMax = await frameWidth(page);
  const savedMax = await until(
    () => saved(t),
    (v) => v === max,
  );
  await drag(page, 1200);
  const atMin = await frameWidth(page);
  const savedMin = await until(
    () => saved(t),
    (v) => v === MIN,
  );
  t.check(
    "range: stops at min 320 and at max (leaves 640px to the left)",
    atMax === max && savedMax === max && atMin === MIN && savedMin === MIN,
    `max ${atMax}/${max} saved ${savedMax}; min ${atMin} saved ${savedMin}`,
  );

  // ダブルクリックで既定に戻す
  await edge.dblclick();
  const reset = await until(
    () => saved(t),
    (v) => v === null,
  );
  const resetW = await until(
    () => frameWidth(page),
    (v) => v === DEFAULT,
  );
  // 前の保存の取り直しが追いついても既定のまま
  await settle(page, 600);
  t.check(
    "double-click: back to the default 380px",
    reset === null && resetW === DEFAULT && (await frameWidth(page)) === DEFAULT,
    `${reset} ${resetW} ${await frameWidth(page)}`,
  );

  // キー: ←で広く、→で狭く。止まってから保存
  await edge.focus();
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowRight");
  const keyW = await frameWidth(page);
  const keySaved = await until(
    () => saved(t),
    (v) => v === DEFAULT + 16,
  );
  t.check(
    "keyboard: ←/→ change the width and it is saved",
    keyW === DEFAULT + 16 &&
      keySaved === DEFAULT + 16 &&
      (await page.getByTestId("ai-panel").count()) === 1,
    `${keyW} ${keySaved}`,
  );

  // 窓の幅: 狭めると収め、広げれば保存した幅に戻る
  await drag(page, -(max - keyW));
  await until(
    () => saved(t),
    (v) => v === max,
  );
  await page.setViewportSize({ width: 1280, height: 900 });
  await settle(page, 300);
  const narrowMax = (await rowWidth(page)) - MAIN_MIN;
  const narrow = await frameWidth(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await settle(page, 300);
  t.check(
    "window resize: clamps to the new max and restores when widened",
    narrow === narrowMax && (await frameWidth(page)) === max && (await saved(t)) === max,
    `${narrow}/${narrowMax} ${await frameWidth(page)}/${max}`,
  );

  // 1つの幅を全画面・全種類のパネルで共通に使い、再読み込みしても保つ
  await drag(page, max - 456);
  await until(
    () => saved(t),
    (v) => v === 456,
  );
  await go(page, `${board.base}/inbox`);
  const row = page.locator('[data-kind="task"][data-id]').first();
  await row.waitFor({ timeout: 5000 });
  await row.click();
  await page.getByTestId("task-panel").waitFor({ timeout: 3000 });
  const taskW = await frameWidth(page);
  await page.reload();
  await page.locator('[data-kind="task"][data-id]').first().click();
  await page.getByTestId("task-panel").waitFor({ timeout: 3000 });
  const reloadW = await frameWidth(page);
  await go(page, `${board.base}/day`);
  await page.waitForSelector(`[data-grid="${TODAY}"]`);
  await page.locator('[data-kind="event"][data-id]').first().click({ force: true });
  await page.getByTestId("event-panel").waitFor({ timeout: 3000 });
  const eventW = await frameWidth(page);
  await page.keyboard.press("Escape");
  await go(page, `${board.base}/queue`);
  await page.locator('[data-kind="turn"][data-id]').first().click();
  await page.getByTestId("queue-detail").waitFor({ timeout: 3000 });
  const queueW = await frameWidth(page);
  t.check(
    "one width for every panel and screen, kept after reload",
    taskW === 456 && reloadW === 456 && eventW === 456 && queueW === 456,
    `task ${taskW} reload ${reloadW} event ${eventW} queue ${queueW}`,
  );
  await board.api("PUT", "/settings/ui", { panelWidth: null });
  await settle(page, 300);
}

export const panelResizeSuite: Suite = { name: "panel-resize", args: [], run };
