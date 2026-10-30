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

  // 詳細: リポジトリの欄は `myscript · Reports` で、端末・ブランチのアイコンは出さない
  await row.click();
  await page.waitForSelector('[data-testid="queue-detail"]', { timeout: 5000 });
  await settle(page, 400);
  const panelText = await page.locator('[data-testid="queue-detail"]').innerText();
  t.check(
    "panel: the row reads “myscript · Reports”",
    panelText.includes("myscript · Reports"),
    panelText.slice(0, 200),
  );
  const whereIcons = await page
    .locator('[data-testid="queue-detail"] span:has-text("myscript · Reports") > svg')
    .count();
  t.check("panel: no terminal or branch icon next to it", whereIcons === 0, String(whereIcons));

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

/** 予定（scheduled。0.8.1）: AI の項目にはならず、デイビューの AI のレーンに予定の帯、AI の画面の「後で」に `Planned · 22:00` */
async function planPanel(t: Ctx) {
  const { page, board } = t;
  await page.goto(board.url.replace(/next=[^&]*/, "next=%2Fday"));
  const band = page.getByTestId("ai-plan").first();
  await band.waitFor({ timeout: 15000 });
  const cursor = await band.evaluate((el) => getComputedStyle(el).cursor);
  await band.click();
  const panel = page.getByTestId("ai-panel");
  await panel.waitFor({ timeout: 15000 });
  await settle(page, 400);
  const text = await panel.innerText();
  t.check(
    "plan band click: the panel opens as a plan (title, source · project, Planned · 22:00, Open, one timeline row)",
    cursor === "pointer" &&
      text.includes("Weekly digest") &&
      (await page.getByTestId("ai-report-from").innerText()).includes("nightly · Reports") &&
      (await page.getByTestId("plan-label").innerText()) === "Planned · 22:00" &&
      (await page.getByTestId("ai-primary").innerText()).startsWith("Open") &&
      (await panel.locator('[data-flow="scheduled"]').count()) === 1 &&
      (await page.getByTestId("ai-last-reply").count()) === 0,
    `${cursor} ${text.replace(/\s+/g, " ").slice(0, 200)}`,
  );
  await page.getByTestId("ai-more").click();
  const ids = await page
    .locator('[data-testid="context-menu"] [data-menu-id]')
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-menu-id")));
  t.check(
    "plan panel ⋯: hide only",
    JSON.stringify(ids) === JSON.stringify(["hide"]),
    JSON.stringify(ids),
  );
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  // 3 日ボードの AI のレーンの帯も同じパネル
  await page.goto(board.url.replace(/next=[^&]*/, "next=%2Fboard"));
  const boardBand = page.getByTestId("ai-plan").first();
  await boardBand.waitFor({ timeout: 15000 });
  await boardBand.click();
  await page.getByTestId("plan-label").waitFor({ timeout: 15000 });
  t.check(
    "board plan band click: the same plan panel",
    (await page.getByTestId("ai-panel").innerText()).includes("Weekly digest"),
  );
  await page.keyboard.press("Escape");
  // AI の画面の「後で」の予定の行も同じパネル
  await page.goto(board.url.replace(/next=[^&]*/, "next=%2Fai"));
  const row = page.getByTestId("ai-plan-row").first();
  await row.waitFor({ timeout: 15000 });
  await row.click();
  await page.getByTestId("plan-label").waitFor({ timeout: 15000 });
  t.check(
    "AI screen plan row click: the same plan panel",
    (await page.getByTestId("ai-panel").innerText()).includes("Weekly digest"),
  );
  // started が来たら、開いているパネルはその AI の項目に切り替わる（SSE）
  await board.api("POST", "/ai/reports", {
    source: "nightly",
    id: "weekly-digest",
    state: "started",
  });
  const switched = await page
    .locator('[data-testid="ai-state"]:not([data-state="scheduled"])')
    .waitFor({ timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  t.check(
    "started while the plan panel is open: it switches to the AI item",
    switched && (await page.getByTestId("ai-plan-row").count()) === 0,
  );
  await page.keyboard.press("Escape");
}

async function planned(t: Ctx) {
  const { page, board } = t;
  const live = await board.api<{ items: { id: string }[]; plans?: { externalId: string }[] }>(
    "GET",
    "/ai/live",
  );
  t.check(
    "API: the scheduled report is a plan, not an AI item",
    (live.plans ?? []).some((p) => p.externalId === "weekly-digest"),
    JSON.stringify(live.plans ?? null),
  );
  await page.goto(board.url.replace(/next=[^&]*/, "next=%2Fday"));
  const band = page.getByTestId("ai-plan").first();
  await band.waitFor({ timeout: 15000 });
  const text = await band.innerText();
  t.check(
    "day view: a plan band on the AI lane with “Planned · 22:00” and source · project",
    text.includes("Weekly digest") &&
      text.includes("Planned · 22:00") &&
      text.includes("nightly · Reports"),
    text,
  );
  await page.goto(board.url.replace(/next=[^&]*/, "next=%2Fai"));
  const row = page.getByTestId("ai-plan-row").first();
  await row.waitFor({ timeout: 15000 });
  t.check(
    "AI screen: the plan is in Later with “Planned · 22:00”",
    (await row.innerText()).includes("Planned · 22:00") &&
      (await page
        .locator('[data-testid="ai-section"][data-section="later"] [data-testid="ai-plan-row"]')
        .count()) === 1,
  );
}

/** 報告の項目の詳細パネル（0.8.1）: 出どころ・開く・待ちの中身・流れだけ。セッションに戻る・他の開き方・最後の返答は出さない */
async function reportPanel(t: Ctx) {
  const { page, board } = t;
  const q = await board.api<QueueResponse>("GET", "/queue");
  const mine = q.items.find((x) => x.sources.some((s) => s.tool === "myscript"));
  if (!mine) return;
  await page.goto(
    board.url.replace(
      /next=[^&]*/,
      `next=${encodeURIComponent(`/board?panel=${mine.workItemId}`)}`,
    ),
  );
  const panel = page.getByTestId("ai-panel");
  await panel.waitFor({ timeout: 15000 });
  await settle(page, 600);
  const primary = await page
    .getByTestId("ai-primary")
    .innerText()
    .catch(() => "");
  t.check(
    "panel: source and project, Open (the reported link), no open-with, no last reply",
    (await page.getByTestId("ai-report-from").innerText()).includes("myscript · Reports") &&
      primary.startsWith("Open") &&
      (await page.getByTestId("ai-open-with").count()) === 0 &&
      (await page.getByTestId("ai-last-reply").count()) === 0,
    primary,
  );
  await page.getByTestId("ai-more").click();
  const ids = await page
    .locator('[data-testid="context-menu"] [data-menu-id]')
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-menu-id")));
  t.check(
    "panel ⋯: mark done and hide only",
    JSON.stringify(ids) === JSON.stringify(["done", "hide"]),
    JSON.stringify(ids),
  );
}

async function settingsRow(t: Ctx) {
  const { page, board } = t;
  // 設定 › AI の取り込みの「報告」の行: 説明と、報告してきた出どころ
  await page.goto(board.url.replace(/next=[^&]*/, "next=%2Fsettings%23ai"));
  await page.waitForSelector('[data-testid="report-sources"]', { timeout: 15000 });
  await settle(page, 300);
  const text = await page.locator('[data-testid="report-sources"]').innerText();
  t.check(
    "settings: the Reports row lists myscript and nightly",
    text.includes("turnlane ai report") &&
      text.includes("myscript (1)") &&
      text.includes("nightly (2)"),
    text,
  );
}

export const reportSuite: Suite = {
  name: "report",
  args: ["--reports", "--lang", "en"],
  run: async (t) => {
    await run(t);
    await settingsRow(t);
    await planned(t);
    await planPanel(t);
    await reportPanel(t);
  },
};
