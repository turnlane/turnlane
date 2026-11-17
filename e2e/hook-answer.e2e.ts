/**
 * hook で答える（ADR 0023）の E2E。dev-board --design hook --lang en（今は 17:10。端末の無いセッションの許可待ちと
 * AskUserQuestion。Agent SDK のアプリの形で、端末には送れない）。hook の代わりにテストが POST /api/hook-waits を呼び、
 * GET /api/hook-waits/:id/result で答えを待つ（本物の hook と同じ呼び方）。
 * - hook が待つ前: 許可待ちは「この端末には送れません」
 * - hook が待つと: 「許可する」と、届け先が hook だという説明。押すと hook に allow が届き、知らせは「Claude Code · hook」
 * - AskUserQuestion: 選択肢を選んで「送る」。押すまで何も届かない。hook には選んだ番号が届く
 */
import { join } from "node:path";
import type { HookWaitOpenResponse, HookWaitResult } from "../packages/core/src/api/index.ts";
import type { Ctx, Suite } from "./harness.ts";

/** dev-board の --design hook の session_id（scripts/dev-board.ts の HOOK_DESIGN_SESSIONS と同じ） */
const PERMISSION_SID = "00000000-0000-4000-8000-00000000a001";
const ASK_SID = "00000000-0000-4000-8000-00000000a002";
const P = "Write the migration";
const A = "Pick the delivery channel";

async function run(t: Ctx) {
  const { page, board } = t;
  const shots = process.env.TURNLANE_E2E_SHOTS;
  await page.goto(board.url.replace(/next=[^&]*/, "next=%2Fboard"));
  const row = (s: string) => page.locator('[data-kind="turn"]').filter({ hasText: s }).first();
  await row(P).waitFor({ timeout: 15000 });
  const section = page.getByTestId("answer");

  // hook が待つ前: 端末の無いセッションには送れない
  await row(P).click();
  await page.waitForTimeout(300);
  await page.keyboard.press("a");
  await section.waitFor({ timeout: 10000 });
  await page.getByTestId("answer-cant").waitFor({ timeout: 10000 });
  t.check(
    "before a hook waits, a session with no terminal can't be answered (Open only)",
    (await page.getByTestId("answer-allow").count()) === 0,
  );
  await page.keyboard.press("Escape");

  // hook が待つ（PermissionRequest の hook の代わり）
  const open = await board.api<HookWaitOpenResponse>("POST", "/hook-waits", {
    session: PERMISSION_SID,
    tool: "Bash",
    entrypoint: "t3-code",
  });
  t.check("the hook is told to wait", open.wait === true, JSON.stringify(open));
  if (!open.wait) return;
  let got: HookWaitResult | null = null;
  // hook の long-poll（答えが来るまで open を受けては聞き直す）
  const poll = (async () => {
    for (let i = 0; i < 20; i++) {
      const r = await board.api<HookWaitResult>("GET", `/hook-waits/${open.id}/result?wait=3000`);
      if (r.state !== "open") return r;
    }
    return null;
  })()
    .then((r) => {
      got = r;
    })
    .catch(() => {});

  await row(P).click();
  await page.waitForTimeout(300);
  await page.keyboard.press("a");
  await page.getByTestId("answer-permission").waitFor({ timeout: 10000 });
  if (shots) await page.screenshot({ path: join(shots, "hook-allow.png") });
  const hint = await page.getByTestId("answer-allow-hint").innerText();
  t.check(
    "with a hook waiting, Allow is offered and says it goes through the hook (no always-allow)",
    hint.includes("through the hook") && hint.includes("this one call"),
    hint,
  );
  t.check("nothing reached the hook before the click", got === null);
  await page.getByTestId("answer-allow").click();
  await poll;
  t.check(
    "clicking Allow returns allow for this one call to the hook",
    JSON.stringify(got) === JSON.stringify({ state: "allow" }),
    JSON.stringify(got),
  );
  const toast = page.getByText(/^Sent( ·|, but couldn't confirm)/).first();
  await toast.waitFor({ timeout: 10000 }).catch(() => {});
  const toastText = (await toast.count()) > 0 ? await toast.innerText() : "";
  t.check(
    "the toast says it went to Claude Code through the hook",
    toastText.includes("Claude Code · hook"),
    toastText,
  );
  await page.keyboard.press("Escape");

  // AskUserQuestion（単一選択）: 選んで「送る」
  const ask = await board.api<HookWaitOpenResponse>("POST", "/hook-waits", {
    session: ASK_SID,
    tool: "AskUserQuestion",
  });
  if (!ask.wait) {
    t.check("the hook waits for the question", false, JSON.stringify(ask));
    return;
  }
  let answer: HookWaitResult | null = null;
  const poll2 = (async () => {
    for (let i = 0; i < 20; i++) {
      const r = await board.api<HookWaitResult>("GET", `/hook-waits/${ask.id}/result?wait=3000`);
      if (r.state !== "open") return r;
    }
    return null;
  })()
    .then((r) => {
      answer = r;
    })
    .catch(() => {});
  await page.goto(board.url.replace(/next=[^&]*/, "next=%2Fboard"));
  await row(A).waitFor({ timeout: 15000 });
  await row(A).click();
  await page.waitForTimeout(300);
  await page.keyboard.press("a");
  await page.getByTestId("answer-hook-ask").waitFor({ timeout: 10000 });
  const q = await page.getByTestId("answer-hook-question").first().innerText();
  t.check(
    "the question and its choices are shown",
    q.includes("Which channel should it ship to?") && q.includes("beta") && q.includes("stable"),
    q,
  );
  const send = page.getByTestId("answer-send");
  t.check("Send is disabled until a choice is made", await send.isDisabled());
  await page.getByTestId("answer-hook-option").filter({ hasText: "stable" }).click();
  await page.waitForTimeout(200);
  if (shots) await page.screenshot({ path: join(shots, "hook-ask.png") });
  t.check("choosing an option sends nothing by itself", answer === null);
  await send.click();
  await poll2;
  t.check(
    "Send returns the chosen option's number to the hook",
    JSON.stringify(answer) ===
      JSON.stringify({ state: "answer", count: 1, answers: [{ options: [1] }] }),
    JSON.stringify(answer),
  );
}

export const hookAnswerSuite: Suite = {
  name: "hook-answer",
  args: ["--design", "hook", "--lang", "en"],
  run,
};
