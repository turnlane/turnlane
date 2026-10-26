/**
 * タスクから AI に頼む（D-107・M5-B）の回帰テスト。dev-board --launch（偽の git・端末・CLI。worktree を作らず、端末を開かず、
 * claude / codex を起動しない）。
 *
 * 1. 頼んだタスクのカードの状態（AI を起動中・実行中・AI 完了 · 確認・起動できなかった）
 * 2. 既存のタスクのホバーのボタン「AI に頼む」→ ポップオーバー → 依頼 → カードが「AI を起動中」になる
 * 3. 右クリックの「AI に頼む…」
 * 4. 作成のポップオーバー: スイッチで「AI に頼む」を出し、作成して依頼 → 新しいタスクが頼んだ状態になる
 * 5. タスクの詳細の AI の節と確認支援（変更・テスト通過・作業場所）
 * 6. AI の詳細パネルの成果（CI 通過・変更の量）
 * 7. Claude のアカウント（D-122）: 設定ディレクトリが2つ（main・sandbox）なので「アカウント」の行が出て、選んだものが次の既定になる
 * 8. 完了のシート（片付け）: worktree の残る依頼のタスクを完了にするとシートが出る。Esc で取り消すと完了にしない。「完了」で
 *    worktree を消してから完了。取り込まれていないブランチは赤字で、「片付けずに完了」なら worktree を残す。設定の節がある
 * 9. 指示の欄の大きさ: 行数に合わせて伸び、画面に収まる高さで止まって中でスクロールする（幅 1280px、高さ 900px と 700px）。
 *    つまみで手で広げた高さより縮めない。TURNLANE_E2E_SHOTS にディレクトリを渡すとスクリーンショットを残す
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright";
import type {
  AiLaunchOptions,
  BoardResponse,
  QueueResponse,
  TaskView,
} from "../packages/core/src/api/index.ts";
import type { Ctx, Suite } from "./harness.ts";

const TODAY = "2026-10-02";

async function tasks(c: Ctx): Promise<TaskView[]> {
  const b = await c.board.api<BoardResponse>("GET", `/board?from=${TODAY}&to=${TODAY}`);
  return b.days[0]?.tasks ?? [];
}
const text = (t: TaskView) => (t.title.t === "text" ? t.title.text : "");

async function run(c: Ctx): Promise<void> {
  const { page, check, board } = c;
  await page.goto(board.url);
  await page.waitForSelector('[data-kind="task"]');
  await page.waitForTimeout(500);
  // 今日の列の未定は先頭 3 件だけ出す（B-2。D-193）。頼んだタスクのカードを全部見るために「ほか N 件 ▸」で開く
  const more = page.locator(`[data-testid="unscheduled-more"][data-date="${TODAY}"]`);
  if ((await more.count()) > 0) {
    await more.click();
    await page.waitForTimeout(300);
  }

  // 1. カードの状態
  const all = await tasks(c);
  const st = (title: string) => all.find((t) => text(t) === title)?.ai?.state ?? null;
  const states = Object.fromEntries(all.map((t) => [text(t), t.ai?.state ?? null]));
  check(
    "頼んだタスクの状態",
    st("依存関係の更新") === "failed" &&
      st("README の手順を更新") === "done_check" &&
      st("日表示のレーン幅を直す") === "running" &&
      st("ログのローテーションを直す") === "starting",
    JSON.stringify(states),
  );
  const readmeCard = page.locator('[data-kind="task"]', { hasText: "README の手順を更新" }).first();
  await readmeCard.scrollIntoViewIfNeeded();
  check(
    "カードに AI 完了 · 確認",
    (await readmeCard.locator('[data-testid="task-ai"]').getAttribute("data-state")) ===
      "done_check",
  );

  // 2. ホバーのボタン → ポップオーバー → 依頼
  const csv = page.locator('[data-kind="task"]', { hasText: "請求書CSVの列名を英語に" }).first();
  await csv.scrollIntoViewIfNeeded();
  await csv.hover();
  await csv.locator('[data-action="askAi"]').click();
  await page.waitForSelector('[data-testid="ai-fields"]');
  check(
    "エージェントは入っている Claude Code だけ（選ばせない）",
    (await page.locator('[data-testid="ai-tool-only"]').count()) === 1,
  );
  check(
    "worktree が既定でオン",
    (await page.locator('[data-testid="ai-worktree"]').getAttribute("aria-checked")) === "true",
  );
  // 7. アカウントの行（ラベル左・値右のボタン型メニュー）。既定は先頭（main）→ sandbox を選ぶ
  const account = page.locator('[data-testid="ai-account"]');
  check("アカウントの行が出る（2つ以上）", (await account.count()) === 1);
  check("アカウントの既定は main", (await account.innerText()).includes("main"));
  await account.click();
  await page.locator('[role="option"]', { hasText: "sandbox" }).click();
  check("アカウントを sandbox に変えた", (await account.innerText()).includes("sandbox"));
  await page.locator('[data-testid="ai-instruction"]').fill("列名の対応表も更新して");
  await page.locator('[data-testid="ai-launch"]').click();
  await page.waitForTimeout(800);
  const csvTask = (await tasks(c)).find((t) => text(t) === "請求書CSVの列名を英語に");
  check("ホバーから頼むと起動中", csvTask?.ai?.state === "starting", JSON.stringify(csvTask?.ai));
  check(
    "カードに AI を起動中",
    (await csv.locator('[data-testid="task-ai"]').getAttribute("data-state")) === "starting",
  );

  const opts = await board.api<AiLaunchOptions>("GET", "/ai/launch-options");
  check(
    "選んだアカウントが次の既定（前回のもの）",
    opts.defaultClaudeAccount?.endsWith("/.claude-sandbox") === true,
    String(opts.defaultClaudeAccount),
  );

  // 3. 右クリックの「AI に頼む…」（別のタスク）
  const run1 = page.locator('[data-kind="task"]', { hasText: "日表示のレーン幅を直す" }).first();
  await run1.scrollIntoViewIfNeeded();
  await run1.click({ button: "right" });
  const item = page.locator('[role="menuitem"]', { hasText: "AI に頼む" });
  check("右クリックに AI に頼む…", (await item.count()) === 1);
  await item.first().click();
  await page.waitForSelector('[data-testid="ai-fields"]');
  check("右クリックからポップオーバー", true);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);

  // 4. 作成のポップオーバー
  await page.locator('[data-testid="column-add"]').nth(1).click();
  await page.waitForSelector('[data-testid="prompt-input"]');
  await page.locator('[data-testid="prompt-input"]').fill("ログの集計を速くする");
  await page.locator('[data-testid="ai-switch"]').click();
  await page.waitForSelector('[data-testid="ai-fields"]');
  check(
    "作成して依頼のボタン",
    (await page.locator('[data-testid="prompt-create"]').innerText()).includes("作成して依頼"),
  );
  await page.locator('[data-testid="prompt-create"]').click();
  let created: TaskView | undefined;
  for (let i = 0; i < 30 && !created?.ai; i++) {
    await page.waitForTimeout(200);
    created = (await tasks(c)).find((t) => text(t) === "ログの集計を速くする");
  }
  check(
    "作成して依頼したタスクは起動中",
    created?.ai?.state === "starting",
    JSON.stringify(created?.ai),
  );

  // 5. タスクの詳細の AI の節
  await readmeCard.scrollIntoViewIfNeeded();
  await readmeCard.click();
  await page.waitForSelector('[data-testid="task-ai-section"]');
  await page.waitForSelector('[data-testid="ai-checks"]');
  const diff = await page.locator('[data-testid="check-diff"]').innerText();
  const test = await page.locator('[data-testid="check-test"]').innerText();
  check("確認支援: 変更の量", diff.includes("+51") && diff.includes("3"), diff);
  check("確認支援: テスト通過", test.includes("通過"), test);
  check(
    "確認支援: 作業場所",
    (await page.locator('[data-testid="check-worktree"]').innerText()).includes("blog-wt"),
  );
  await page.keyboard.press("Escape");

  // 6. AI の詳細パネル（PR を開いて AI 完了）
  const q = await board.api<QueueResponse>("GET", "/queue");
  const wi = q.items.find((x) => x.title === "設定画面の文言をそろえる")?.workItemId;
  check("PR の確認待ちは頼んだタスクの題名で自分の番に出る", !!wi);
  if (wi) {
    await page.goto(
      board.url.replace("next=%2Fboard", `next=${encodeURIComponent(`/board?panel=${wi}`)}`),
    );
    await page.waitForSelector('[data-testid="ai-checks"]');
    const ci = await page.locator('[data-testid="check-ci"]').innerText();
    check("AI の詳細に CI 通過", ci.includes("通過"), ci);
  }

  // 7. 設定 > プロジェクトのアカウント（D-123 の OS の select をメニューのボタンにした。D-138）
  await page.goto(`${board.base}/settings#projects`);
  const acct = page.getByTestId("settings-project-account").first();
  await acct.waitFor({ timeout: 5000 });
  check("設定に OS の select が無い", (await page.locator("select").count()) === 0);
  await acct.click();
  const menu = page.getByTestId("context-menu");
  await menu.waitFor({ timeout: 2000 });
  const choices = await menu.locator("[data-menu-id]").allInnerTexts();
  const lastChecked = (await menu.locator('[aria-checked="true"]').innerText()).trim();
  await menu.locator("[data-menu-id]").nth(1).click();
  let picked: string | null = null;
  for (let i = 0; i < 20 && !picked; i++) {
    await page.waitForTimeout(150);
    picked = await acct.getAttribute("data-value");
  }
  const cfg = await board
    .api<Record<string, unknown>>("GET", "/config/ai.claude_account_by_project")
    .catch(() => ({}) as Record<string, unknown>);
  check(
    "プロジェクトのアカウントはメニューで選ぶ（今の値に ✓、選ぶと保存）",
    choices.length >= 3 &&
      lastChecked.includes("前回") &&
      !!picked &&
      JSON.stringify(cfg).includes(picked ?? "-"),
    `${choices.join(" | ")} / ${lastChecked} / ${picked}`,
  );
}

/** 完了のシート（8） */
async function finishSheet(c: Ctx): Promise<void> {
  const { page, check, board } = c;
  await page.goto(board.url);
  await page.waitForSelector('[data-kind="task"]');
  await page.waitForTimeout(500);
  const more = page.locator(`[data-testid="unscheduled-more"][data-date="${TODAY}"]`);
  if ((await more.count()) > 0) {
    await more.click();
    await page.waitForTimeout(300);
  }
  const sheet = page.getByTestId("finish-sheet");
  const complete = async (title: string) => {
    if ((await more.count()) > 0 && (await more.isVisible())) {
      await more.click();
      await page.waitForTimeout(300);
    }
    const card = page.locator('[data-kind="task"]', { hasText: title }).first();
    await card.scrollIntoViewIfNeeded();
    await card.hover();
    await card.locator('[role="checkbox"]').first().click();
    await sheet.waitFor({ timeout: 5000 });
  };
  const status = async (title: string) =>
    (await tasks(c)).find((t) => text(t) === title)?.status ?? null;
  const readme = "README の手順を更新";
  await complete(readme);
  check(
    "完了のシート: 2 つのチェック（既定オン）。取り込み済みなら赤字なし",
    (await page.getByTestId("finish-close-terminal").isChecked()) &&
      (await page.getByTestId("finish-remove-worktree").isChecked()) &&
      (await page.getByTestId("finish-risky").count()) === 0,
  );
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  check(
    "Esc で取り消すと完了にしない",
    (await sheet.count()) === 0 && (await status(readme)) === "todo",
  );
  await complete(readme);
  await page.getByTestId("finish-confirm").click();
  let st: string | null = null;
  for (let i = 0; i < 40 && st !== "done"; i++) {
    await page.waitForTimeout(150);
    st = await status(readme);
  }
  const toasts = await page.locator('[role="status"]').allInnerTexts();
  check(
    "「完了」で worktree を消してから完了（タブは偽の端末なので閉じられない旨）",
    st === "done" &&
      toasts.some((x) => x.includes("worktree を消しました")) &&
      toasts.some((x) => x.includes("タブは閉じられませんでした")),
    `${st} / ${toasts.join(" | ")}`,
  );
  const lane = "日表示のレーン幅を直す";
  await complete(lane);
  const risky = await page.getByTestId("finish-risky").innerText();
  check(
    "取り込まれていないブランチは赤字",
    risky.includes("ブランチの変更が消えます") && risky.includes("tl/lane-widths-1186"),
    risky,
  );
  await page.getByTestId("finish-skip").click();
  st = null;
  for (let i = 0; i < 40 && st !== "done"; i++) {
    await page.waitForTimeout(150);
    st = await status(lane);
  }
  const plan = await board.api<{ launches: unknown[] }>(
    "GET",
    `/ai/finish-plan?taskIds=${(await tasks(c)).find((t) => text(t) === lane)?.id ?? ""}`,
  );
  check(
    "「片付けずに完了」は完了にして worktree を残す",
    st === "done" && plan.launches.length === 1,
    `${st} / ${JSON.stringify(plan)}`,
  );
  await page.goto(`${board.base}/settings#ai`);
  const sec = page.getByTestId("settings-finish");
  await sec.waitFor({ timeout: 5000 });
  check(
    "設定 › AI に頼む に「完了したとき」の既定（両方オン）",
    (await page.getByTestId("settings-finish-close").isChecked()) &&
      (await page.getByTestId("settings-finish-worktree").isChecked()),
  );
}

/** 指示の欄の大きさ（ポップオーバーの中の高さと位置） */
async function instructionBox(page: Page) {
  return page.evaluate(() => {
    const el = document.querySelector<HTMLTextAreaElement>('[data-testid="ai-instruction"]');
    const box = el?.closest<HTMLElement>('[role="dialog"]');
    const btn = document.querySelector<HTMLElement>('[data-testid="ai-launch"]');
    if (!el || !box || !btn) return null;
    const b = box.getBoundingClientRect();
    const k = btn.getBoundingClientRect();
    return {
      h: el.offsetHeight,
      scrolls: el.scrollHeight > el.clientHeight + 1,
      overflowY: getComputedStyle(el).overflowY,
      resize: getComputedStyle(el).resize,
      boxTop: b.top,
      boxBottom: b.bottom,
      btnTop: k.top,
      btnBottom: k.bottom,
      vh: window.innerHeight,
    };
  });
}

/** 右クリックの「AI に頼む…」でポップオーバーを開く */
async function openAskAi(page: Page, title: string) {
  const card = page.locator('[data-kind="task"]', { hasText: title }).first();
  await card.scrollIntoViewIfNeeded();
  await card.click({ button: "right" });
  await page.locator('[role="menuitem"]', { hasText: "AI に頼む" }).first().click();
  await page.waitForSelector('[data-testid="ai-instruction"]');
  await page.waitForTimeout(150);
}

const lines = (n: number) =>
  Array.from({ length: n }, (_, i) => `手順 ${i + 1} を確かめる`).join("\n");

/** 9. 指示の欄は行数に合わせて伸び、画面に収まる高さで止まって中でスクロールする。つまみで手でも広げられる */
async function instructionGrow(c: Ctx): Promise<void> {
  const { page, check, board } = c;
  const shots = process.env.TURNLANE_E2E_SHOTS;
  if (shots) mkdirSync(shots, { recursive: true });
  const target = "請求書CSVの列名を英語に";
  for (const height of [900, 700]) {
    await page.setViewportSize({ width: 1280, height });
    await page.goto(board.url);
    await page.waitForSelector('[data-kind="task"]');
    await page.waitForTimeout(400);
    const more = page.locator(`[data-testid="unscheduled-more"][data-date="${TODAY}"]`);
    if ((await more.count()) > 0) {
      await more.click();
      await page.waitForTimeout(300);
    }
    await openAskAi(page, target);
    const box = page.locator('[data-testid="ai-instruction"]');
    await box.fill(lines(2));
    await page.waitForTimeout(100);
    const two = await instructionBox(page);
    if (shots && height === 900) await page.screenshot({ path: join(shots, "ask-ai-2-lines.png") });
    // 貼り付け（insertText は貼り付けと同じ input を1回だけ出す）
    await box.fill("");
    await box.focus();
    await page.keyboard.insertText(lines(10));
    await page.waitForTimeout(100);
    const ten = await instructionBox(page);
    check(
      `指示の欄: 10 行貼り付けると高さが伸びる（高さ ${height}）`,
      !!two && !!ten && ten.h > two.h + 100 && (height === 700 || !ten.scrolls),
      JSON.stringify({ two, ten }),
    );
    await box.fill(lines(12));
    await page.waitForTimeout(100);
    if (shots && height === 900)
      await page.screenshot({ path: join(shots, "ask-ai-12-lines.png") });
    if (shots && height === 700)
      await page.screenshot({ path: join(shots, "ask-ai-12-lines-h700.png") });
    await box.fill(lines(60));
    await page.waitForTimeout(150);
    const big = await instructionBox(page);
    check(
      `指示の欄: 上限を超えると中でスクロール（高さ ${height}）`,
      !!big && big.scrolls && big.overflowY === "auto" && big.boxBottom <= big.vh + 0.5,
      JSON.stringify(big),
    );
    check(
      `ポップオーバーの送るボタンが画面内（高さ ${height}）`,
      !!big && big.boxTop >= 0 && big.btnTop >= 0 && big.btnBottom <= big.vh,
      JSON.stringify(big),
    );
    // 削除で縮む
    await box.fill("");
    await page.waitForTimeout(100);
    const empty = await instructionBox(page);
    check(
      `指示の欄: 消すと最小の高さに戻る（高さ ${height}）`,
      !!empty && !!two && empty.h === two.h && !empty.scrolls,
      JSON.stringify({ empty, two }),
    );
    if (height === 900) {
      // 右下のつまみで手で広げる → 消しても縮まない
      const r = await box.boundingBox();
      if (r) {
        await page.mouse.move(r.x + r.width - 3, r.y + r.height - 3);
        await page.mouse.down();
        await page.mouse.move(r.x + r.width - 3, r.y + r.height + 120, { steps: 6 });
        await page.mouse.up();
      }
      await page.waitForTimeout(150);
      const dragged = await instructionBox(page);
      await box.fill(lines(1));
      await page.waitForTimeout(100);
      await box.fill("");
      await page.waitForTimeout(100);
      const after = await instructionBox(page);
      check(
        "指示の欄: つまみで手で広げられ、消しても手の高さより縮まない",
        !!empty &&
          !!dragged &&
          !!after &&
          dragged.resize === "vertical" &&
          dragged.h > empty.h + 60 &&
          Math.abs(after.h - dragged.h) <= 1,
        JSON.stringify({ empty, dragged, after }),
      );
    }
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

export const launchSuite: Suite = {
  name: "launch",
  args: ["--launch", "--lang", "ja"],
  run: async (c) => {
    await run(c);
    await finishSheet(c);
    await instructionGrow(c);
  },
};
