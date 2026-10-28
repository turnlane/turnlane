/**
 * 次の指示（Issue #9）の E2E: AI の詳細パネルの「最後の返答」の下の入力欄から送る（偽の届け先。dev-board の偽の OS が記録し、
 * Claude が受け取った形を記録に書く）、送った後の知らせと印、終わったセッションでは入力欄の代わりに理由と「端末で開く」。
 *
 * dev-board --design instruct --lang en: 今は 2026-10-02（金）17:10 JST。tmux の中で動いていてターンの終わった
 * セッション（Three-day board column widths）と、プロセスの終わったセッション（Deploy guide）
 */
import type { Ctx, Suite } from "./harness.ts";

const A = "Three-day board column widths";
const B = "Deploy guide";

async function run(t: Ctx) {
  const { page, board } = t;
  await page.goto(board.url.replace(/next=[^&]*/, "next=%2Fboard"));
  const days = await board.api<{ days: { items: { id: string; title: string | null }[] }[] }>(
    "GET",
    "/work-items",
  );
  const idOf = (title: string) =>
    days.days.flatMap((d) => d.items).find((x) => x.title === title)?.id ?? "";
  const open = async (title: string) => {
    const card = page.locator(`[data-kind="ai"][data-id="${idOf(title)}"]`).first();
    await card.waitFor({ timeout: 15000 });
    await card.click({ force: true });
    await page.getByTestId("ai-panel").waitFor({ timeout: 10000 });
  };

  // 終わったセッション: 入力欄を出さず、理由と「端末で開く」
  await open(B);
  const blocked = page.getByTestId("ai-instruct-blocked");
  await blocked.waitFor({ timeout: 10000 }).catch(() => {});
  const why = (await blocked.count()) > 0 ? await blocked.innerText() : "";
  t.check(
    "an ended session says so instead of a text box",
    why.includes("This session has ended"),
    why || (await page.getByTestId("ai-panel").innerText()).slice(0, 400),
  );
  t.check("it offers Open in terminal", (await page.getByTestId("ai-instruct-open").count()) === 1);
  t.check(
    "there is no instruction box for an ended session",
    (await page.getByTestId("ai-instruct-input").count()) === 0,
  );
  await page.keyboard.press("Escape");

  // 動いていてターンの終わったセッション: 最後の返答（Markdown）の下に入力欄と「Send · Ghostty · main:1.0」
  await open(A);
  const reply = page.getByTestId("ai-last-reply-text");
  await reply.waitFor({ timeout: 10000 });
  t.check(
    "the last reply is shown with Markdown",
    (await reply.locator("strong").innerText()).includes("Tests pass."),
  );
  const input = page.getByTestId("ai-instruct-input");
  await input.waitFor({ timeout: 10000 });
  const send = page.getByTestId("ai-instruct-send");
  t.check(
    "Send names the terminal tab like Answer",
    (await send.innerText()).includes("Ghostty · main:1.0"),
    await send.innerText(),
  );
  const [ib, rb] = await Promise.all([input.boundingBox(), reply.boundingBox()]);
  t.check("the box is under the last reply", !!ib && !!rb && ib.y > rb.y);
  await input.fill("Now do the same for the week view");
  await page.keyboard.press("Meta+Enter");
  const sent = page.getByTestId("ai-instruct-sent");
  await sent.waitFor({ timeout: 10000 }).catch(() => {});
  const toast = page.getByText("Sent · Ghostty · main:1.0").first();
  await toast.waitFor({ timeout: 10000 }).catch(() => {});
  t.check("a toast says it was sent to the tab", (await toast.count()) > 0);
  // 送った文は画面に残さない
  t.check(
    "the text box is cleared after sending",
    (await input.count()) === 0 || (await input.inputValue()) === "",
  );
  // 取り込みの後は動作中になる（もう送れない）
  const running = page.locator(
    '[data-testid="ai-instruct-blocked"] [data-reason="turn_in_progress"]',
  );
  await running.waitFor({ timeout: 10000 }).catch(() => {});
  t.check(
    "after the agent picks it up, the panel says it's working",
    (await running.count()) === 1,
  );
}

export const instructSuite: Suite = {
  name: "instruct",
  args: ["--design", "instruct", "--lang", "en"],
  run,
};
