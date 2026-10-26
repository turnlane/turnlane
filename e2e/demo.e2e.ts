/**
 * デモ動画（M6-30）の場面の E2E: 3 本の AI が実行中のボードで、合図（--demo-notify）の後に C だけが Bash の許可待ちになり、
 * 自分の番の帯に件名と理由（ツール・説明・コマンド）が出る。新しいセッションは足さない。
 *
 * dev-board --design demo --demo-notify 10: 今は 2026-10-02（金）15:20 JST。A web-app · feat/board-width、
 * B docs-site · docs/deploy、C api-gateway · fix/auth-refresh が実行中
 */
import type { Ctx, Suite } from "./harness.ts";

async function run(t: Ctx) {
  const { page, board } = t;
  await page.goto(board.url.replace(/next=[^&]*/, "next=%2Fboard"));
  await page.getByTestId("week-board").waitFor({ timeout: 15000 });
  await page.waitForFunction(`document.querySelectorAll('[data-kind="ai"]').length >= 3`, null, {
    timeout: 15000,
  });
  const ai = page.locator('[data-kind="ai"]');
  const titles = async () => (await ai.allInnerTexts()).join(" | ").replace(/\s+/g, " ");
  const before = await titles();
  t.check(
    "three AI runs are on the board, with their first instruction as the title",
    (await ai.count()) === 3 &&
      before.includes("Fix the three-day board column widths") &&
      before.includes("Tidy up the deploy guide") &&
      before.includes("Fix the 401 on token refresh"),
    before,
  );
  t.check(
    "nothing waits before the signal",
    (await page.getByText("Run the auth tests").count()) === 0 &&
      !before.includes("Needs approval"),
    before,
  );
  // 合図（起動の 10 秒後）を待つ
  await page.getByText("Run the auth tests").first().waitFor({ timeout: 20000 });
  await page.waitForTimeout(500);
  const after = await titles();
  t.check(
    "after the signal the third run waits for approval, and no new run is added",
    (await ai.count()) === 3 && after.includes("Needs approval"),
    after,
  );
  const row = page.getByText("bun test src/auth").first();
  t.check("the Your turn row names the tool and the command", await row.isVisible());
  const body = (await page.locator("body").innerText()).replace(/\s+/g, " ");
  t.check(
    "the wait is fresh (<1m), not a since-time",
    body.includes("<1m") && !/since \d+:\d+/.test(body),
  );
}

export const demoSuite: Suite = {
  name: "demo",
  args: ["--design", "demo", "--lang", "en", "--demo-notify", "10"],
  run,
};
