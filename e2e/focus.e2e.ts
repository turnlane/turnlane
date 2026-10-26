/**
 * 会議前に聞く集中モード（D-097。ux-mvp 4.15）の E2E: デスクトップアプリが無いとき、画面上部の帯で同じ問いを出し、
 * 「集中する」で集中中の藍の帯（題名・終わり・残り・終了のボタン）になる。帯は自分の番・Inbox・日の画面、サイドバーを
 * 畳んだとき、メニューバーのポップオーバーの一番上にも出る。⌘K から手動で始める・終える。設定の通知の節に項目がある。
 *
 * dev-board の既定のデータ: 今は 2026-10-02（金）13:20 JST。13:40–14:10 に予定を作り、対象を「予定ありのすべて」・
 * 何分前を30分にして、今すぐ問いが出るようにする。
 */
import type { FocusView } from "../packages/core/src/api/index.ts";
import type { Ctx, Suite } from "./harness.ts";

async function run(t: Ctx) {
  const { page, board } = t;
  await page.goto(board.url.replace(/next=[^&]*/, "next=%2Fboard"));
  await page.waitForSelector('[data-grid="2026-10-02"]');

  // 問い（帯）
  await board.api("PUT", "/settings/ui", { focusLeadMin: 30, focusTarget: "busy" });
  await board.api("POST", "/calendar-events", {
    title: "Team sync",
    start: Date.parse("2026-10-02T13:40:00+09:00"),
    end: Date.parse("2026-10-02T14:10:00+09:00"),
  });
  const prompt = page.getByTestId("focus-prompt");
  const shown = await prompt
    .waitFor({ timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  t.check("without the desktop app, the question shows in the bar at the top", shown);
  const label = shown ? await prompt.innerText() : "";
  t.check(
    "the bar asks about the meeting (time, title)",
    label.includes("13:40 Team sync · Focus during this meeting?"),
    label,
  );
  const v0 = await board.api<FocusView>("GET", "/focus");
  t.check("the question goes to the bar (channel band)", v0.channel === "band");

  // 集中する
  if (shown) await page.getByTestId("focus-yes").click();
  const active = page.getByTestId("focus-active");
  await active.waitFor({ timeout: 3000 }).catch(() => {});
  const activeText = (await active.count()) > 0 ? await active.innerText() : "";
  t.check(
    "Focus: the band shows “Focus · during Team sync · until 14:10 · 50m left” with an End button",
    /Focus · during Team sync · until 14:10 · \d+m left/.test(activeText.replace(/\s+/g, " ")) &&
      (await page.getByTestId("focus-end").count()) === 1,
    activeText,
  );
  t.check(
    "the band says notifications are paused (none held yet)",
    activeText.includes("Your-turn notifications are paused"),
    activeText,
  );
  // 藍の面（ふだんの地と違う色）
  const colors = await active.evaluate((el) => {
    const cs = getComputedStyle(el as Element);
    return { band: cs.backgroundColor, body: getComputedStyle(document.body).backgroundColor };
  });
  t.check("the band has its own ground color", colors.band !== colors.body, JSON.stringify(colors));
  // どの画面でも、サイドバーを畳んでも同じ帯
  for (const path of ["/queue", "/inbox", "/day"]) {
    await page.goto(board.url.replace(/next=[^&]*/, `next=${encodeURIComponent(path)}`));
    const there = await active
      .waitFor({ timeout: 5000 })
      .then(() => true)
      .catch(() => false);
    t.check(`the band shows on ${path}`, there);
  }
  await page.mouse.click(5, 5);
  await page.keyboard.press("Meta+Backslash");
  await page.waitForTimeout(300);
  t.check("the band stays with the sidebar folded", (await active.count()) === 1);
  await page.keyboard.press("Meta+Backslash");
  // メニューバーのポップオーバー（/tray）の一番上にも同じ帯
  await page.goto(board.url.replace(/next=[^&]*/, "next=%2Ftray"));
  const trayBand = page.getByTestId("tray-focus-active");
  const inTray = await trayBand
    .waitFor({ timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  const trayTop = inTray ? await trayBand.boundingBox() : null;
  t.check("the popover shows the band at the very top", inTray && (trayTop?.y ?? 99) < 2);
  await page.goto(board.url.replace(/next=[^&]*/, "next=%2Fboard"));
  await active.waitFor({ timeout: 5000 }).catch(() => {});
  t.check("the question is gone", (await prompt.count()) === 0);
  const q = await board.api<{ focus: { until: number } | null }>("GET", "/queue");
  t.check("the queue tells the browser to hold notifications", q.focus !== null);

  // 終了
  await page.getByTestId("focus-end").click();
  await page.waitForTimeout(500);
  t.check("End removes the bar", (await page.getByTestId("focus-bar").count()) === 0);

  // ⌘K から手動で始める
  await page.mouse.click(5, 5);
  await page.keyboard.press("Meta+k");
  const input = page.locator('[cmdk-input], [data-testid="palette-input"]').first();
  await input.waitFor({ timeout: 2000 }).catch(() => {});
  // 開いた直後は入力欄にまだフォーカスが来ていないことがあるので、欄に直接入れる
  await input.fill("focus 30");
  // 入力から新規タスクの行も出るので、行を選んで実行する
  const row30 = page.getByRole("option").filter({ hasText: "Focus: 30 min" }).first();
  await row30.waitFor({ timeout: 3000 }).catch(() => {});
  const options30 = (await page.getByRole("option").allInnerTexts())
    .join(" | ")
    .replace(/\s+/g, " ");
  if ((await row30.count()) > 0) await row30.click();
  await active.waitFor({ timeout: 5000 }).catch(() => {});
  const manual = (await active.count()) > 0 ? await active.innerText() : "";
  t.check(
    "⌘K “Focus: 30 min” starts focus until 13:50",
    manual.replace(/\s+/g, " ").includes("until 13:50 · 30m left"),
    `${manual} / ${options30}`,
  );

  // ⌘K から終える
  await page.keyboard.press("Meta+k");
  await input.waitFor({ timeout: 2000 }).catch(() => {});
  await input.fill("end focus");
  // 「Focus: until the next event ends」も当たるので、行を選んで実行する
  const endRow = page.getByRole("option").filter({ hasText: "End focus" }).first();
  await endRow.waitFor({ timeout: 3000 }).catch(() => {});
  const options = (await page.getByRole("option").allInnerTexts()).join(" | ").replace(/\s+/g, " ");
  if ((await endRow.count()) > 0) await endRow.click();
  await active.waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
  t.check("⌘K “End focus” ends focus", (await active.count()) === 0, options);

  // 設定の通知の節
  await page.goto(board.url.replace(/next=[^&]*/, "next=%2Fsettings%23notify"));
  await page.waitForTimeout(800);
  const body = await page.locator("body").innerText();
  t.check(
    "settings › notifications has the focus items",
    body.includes("Ask to focus before meetings") &&
      body.includes("Focus automatically if you don't answer") &&
      body.includes("Approval requests while focusing"),
  );
}

export const focusSuite: Suite = { name: "focus", args: ["--lang", "en"], run };
