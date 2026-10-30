/**
 * 外の作業の報告（ADR 0021）の E2E。dev-board --reports --lang en: 今は 2026-10-02（金）13:20 JST。
 * myscript の Nightly export（プロジェクト Reports）は 11:52 から問いで待っている（開く先 https://example.com/runs/42）、
 * nightly の Backup は 12:30 から実行中。
 * - 待ちの報告が自分の番の行に出る（リポジトリの欄は `myscript · Reports`、バッジは汎用の MY）。実行中の報告は出ない
 * - 行のホバーの「開く」で報告の URL が開く先に決まる（偽の OS。何も起動しない）
 * - 「答える」の中身は読めるだけ（問いと選択肢。答えは myscript で）
 */
import type { Page } from "playwright";
import type { QueueResponse, WaitResponse } from "../packages/core/src/api/index.ts";
import type { Ctx, Suite } from "./harness.ts";

async function settle(page: Page, ms = 250) {
  await page.waitForTimeout(ms);
}

async function run(t: Ctx) {
  const { page, board } = t;
  const q = await board.api<QueueResponse>("GET", "/queue");
  const open = q.items.filter((x) => x.followUps.some((f) => f.status === "open"));
  const mine = open.find((x) => x.sources.some((s) => s.tool === "myscript"));
  t.check(
    "API: the waiting report is on Your turn as a reply",
    mine?.followUps.some((f) => f.kind === "reply" && f.status === "open") === true,
    JSON.stringify(mine?.followUps ?? null),
  );
  t.check(
    "API: the running report is not on Your turn",
    !open.some((x) => x.sources.some((s) => s.tool === "nightly")),
  );
  if (!mine) return;
  t.check(
    "API: the badge knows it is a report from myscript in Reports",
    mine.sources.some((s) => s.tool === "myscript" && s.report === true && s.project === "Reports"),
    JSON.stringify(mine.sources),
  );

  await page.goto(board.url.replace(/next=[^&]*/, "next=%2Fqueue"));
  await page.waitForSelector('[data-kind="turn"]', { timeout: 15000 });
  await settle(page, 400);
  const row = page.locator(`[data-kind="turn"][data-id="${mine.workItemId}"]`).first();
  t.check("queue: the report row is shown", (await row.count()) === 1);
  const text = await row.innerText();
  t.check("queue: the row reads “myscript · Reports”", text.includes("myscript · Reports"), text);
  t.check("queue: the row's title is the reported one", text.includes("Nightly export"), text);

  // 開く: ホバーの「開いて対応」→ POST /api/open が報告の URL で開く
  await row.hover();
  await settle(page);
  const resp = page.waitForResponse(
    (r) => r.url().endsWith("/api/open") && r.request().method() === "POST",
    { timeout: 5000 },
  );
  await row.locator('[data-action="open"]').first().click();
  const r = await resp.catch(() => null);
  const body = r ? ((await r.json()) as { action?: string; outcome?: string }) : null;
  t.check(
    "open: the reported link is opened (report_url)",
    body?.action === "report_url" && body.outcome === "opened",
    JSON.stringify(body),
  );

  // 答える: 中身は読めるだけ
  const w = await board.api<WaitResponse>("GET", `/work-items/${mine.workItemId}/wait`);
  t.check(
    "answer: the question and its options can be read, and the answer goes to myscript",
    w.question?.text === "Overwrite last night's file?" &&
      w.options?.map((o) => o.label).join("|") === "Overwrite|Keep both" &&
      w.delivery.deliverable === false &&
      w.delivery.reason === "report" &&
      w.delivery.terminal === "myscript",
    JSON.stringify(w),
  );
}

export const reportSuite: Suite = {
  name: "report",
  args: ["--reports", "--lang", "en"],
  run,
};
