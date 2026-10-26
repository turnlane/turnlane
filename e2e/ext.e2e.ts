/**
 * 拡張点（ADR 0015）の E2E。テスト用の拡張（test/ext-fixture）を組み込んだ dev-board（--ext）と Web（e2e/run.ts が
 * .build/web-ext-test にビルドする）で、拡張点が画面までつながることを確かめる。ext-none は拡張なしの dev-board と
 * 通常の apps/web/dist で、拡張の分が何も出ないことを確かめる（公開のビルドの動作が変わらないこと）。
 *
 * 1. 設定の目次に拡張の節が「データ」の前に出て、開くと拡張のルート（/api/ext/test/ping）の値を出す。検索にも出る
 * 2. 今日の列の先頭行の知らせ（todayNotices）: 3日ボードの今日の列とデイビューの右の一覧の先頭に1行。押すと拡張の画面
 * 3. タスクの右クリックに拡張の項目が出て、押すと拡張のルートを呼ぶ
 * 4. タスクの詳細パネルに拡張の節
 * 5. ⌘K のコマンドに拡張のコマンド
 * 6. AI に頼むの入力に拡張の行。オンにすると拡張が依頼を引き受け、今すぐの起動をしない
 * 7. 拡張の画面（/ext/test と枠なしの /ext/test/bare）。拡張が ext-host の useKeys で j/k・⌘↑↓・⌫ を受ける
 * 8. 行を自分で並べる欄（launchFields の layout: "rows"）: 本体と同じラベルの列に行が出て、値で行が増える
 * 9. 時間軸の印（timelineMarks）: 3日ボードの今日の AI レーンとデイビューの AI レーンに、中を塗らない実線の枠と時計の
 *    アイコン・題名・時刻・2行目で出る。押すとタスクの詳細パネル
 * 10. （一日を閉じるの手順は D-192 で廃止）
 * 11. サイドバーの行（sidebarItems）: 取り込みの知らせ・設定の上に1行。押すと拡張の画面。畳んだサイドバーではアイコンと、状態があれば点
 * 12. メニューバーのポップオーバーの行（trayItems）: 下の操作の先頭（集中の行の上）に、本体の行と同じ高さで1行
 * 13. 経路の題名（routes の title・titleAside）が上部バーに出る。ext-host の StatusIcon・Icon
 * 14. ext-host の navigate（本体の画面へ）・openAiPanel（枠の中はその場、枠なしは週ボードへ移って開く）・openAi（本体の開き方）
 * 15. ⌘K の選択中のタスクに拡張のメニューの項目（右クリックと同じ）
 * 16. 拡張が作ったタスクと時間ブロック（tasks.create・timeBlocks.create）: ボードの時間軸に出て、出どころは拡張の言葉
 *     （taskOrigins）。詳細パネルの経由の右の移動で拡張の画面へ。出どころの主ボタン（primary）で拡張の画面へ
 */
import { resolve } from "node:path";
import type { BoardResponse, TaskView } from "../packages/core/src/api/index.ts";
import { runWebBuild } from "../scripts/build.ts";
import { readExtManifests, writeExtLists } from "../scripts/ext-manifest.ts";
import type { Ctx, Suite } from "./harness.ts";

const ROOT = resolve(import.meta.dir, "..");
export const EXT_FIXTURE = resolve(ROOT, "test/ext-fixture");
export const EXT_WEB_DIST = resolve(ROOT, ".build/web-ext-test");
const TODAY = "2026-10-02";

/** テスト用の拡張を組み込んだ Web を .build/web-ext-test に作る（run.ts が ext スイートの前に1回だけ呼ぶ） */
export function buildExtWeb(): void {
  const ms = readExtManifests([EXT_FIXTURE]);
  const lists = writeExtLists(resolve(ROOT, ".build/e2e-ext"), ms);
  runWebBuild(lists.web, EXT_WEB_DIST, [resolve(ROOT, "apps/web/test/ext-fixture")]);
}

const nav = (c: Ctx, path: string) =>
  c.page.goto(c.board.url.replace(/next=[^&]*/, `next=${encodeURIComponent(path)}`));

async function firstTodo(c: Ctx): Promise<TaskView | undefined> {
  const b = await c.board.api<BoardResponse>("GET", `/board?from=${TODAY}&to=${TODAY}`);
  return b.days[0]?.tasks.find((t) => t.status !== "done" && t.title.t === "text" && !t.ai);
}

const titleOf = (t: TaskView) => (t.title.t === "text" ? t.title.text : "");

async function toastText(c: Ctx, has: string): Promise<boolean> {
  const loc = c.page.locator('[role="status"]', { hasText: has }).first();
  await loc.waitFor({ timeout: 3000 }).catch(() => {});
  return (await loc.count()) > 0;
}

/** 右クリックの「Ask AI…」から AI に頼むのポップオーバーを開く */
async function openAskAi(c: Ctx, card: ReturnType<Ctx["page"]["locator"]>): Promise<void> {
  await card.scrollIntoViewIfNeeded();
  await card.click({ button: "right" });
  await c.page.locator('[role="menuitem"]', { hasText: "Ask AI" }).first().click();
  await c.page.waitForSelector('[data-testid="ai-fields"]');
}

/** 拡張の一覧のキー: j で次、⌘↓ で下へ、k で前、⌫ で外す（並びは data-order、選択は data-sel） */
async function keyList(c: Ctx, testId: string, where: string): Promise<void> {
  const { page, check } = c;
  const list = page.getByTestId(testId);
  await list.waitFor({ timeout: 5000 }).catch(() => {});
  const state = async () =>
    `${await list.getAttribute("data-order")}:${await list.getAttribute("data-sel")}`;
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  check(`${where}: 最初は a を選ぶ`, (await state()) === "abc:a", await state());
  await page.keyboard.press("j");
  check(`${where}: j で次`, (await state()) === "abc:b", await state());
  await page.keyboard.press("Meta+ArrowDown");
  check(`${where}: ⌘↓ で下へ`, (await state()) === "acb:b", await state());
  await page.keyboard.press("Meta+ArrowUp");
  await page.keyboard.press("Meta+ArrowUp");
  check(`${where}: ⌘↑ で上へ`, (await state()) === "bac:b", await state());
  await page.keyboard.press("j");
  await page.keyboard.press("k");
  check(`${where}: k で前`, (await state()) === "bac:b", await state());
  await page.keyboard.press("Backspace");
  check(`${where}: ⌫ で外す`, (await state()) === "ac:a", await state());
}

async function runWith(c: Ctx): Promise<void> {
  const { page, check } = c;

  // 1. 設定
  await nav(c, "/settings");
  await page.waitForSelector('[data-testid="settings-nav"]');
  const sections = await page
    .locator('[data-testid="settings-nav"] [data-section]')
    .evaluateAll((xs) => xs.map((x) => x.getAttribute("data-section")));
  check(
    "設定の目次: 拡張の節がデータの前",
    sections.at(-2) === "ext-test-main" && sections.at(-1) === "data",
    sections.join(","),
  );
  await page.locator('[data-section="ext-test-main"]').click();
  const ping = page.getByTestId("ext-test-ping");
  await page.waitForFunction(
    () => /\d/.test(document.querySelector('[data-testid="ext-test-ping"]')?.textContent ?? ""),
    undefined,
    { timeout: 5000 },
  );
  check(
    "設定の節: 拡張のルートの値",
    /1 ping/.test(await ping.innerText()),
    await ping.innerText(),
  );
  check("設定の節の見出し", (await page.locator("h1").innerText()).includes("Test extension"));
  check("設定の節の見出しの右", (await page.getByTestId("ext-test-aside").count()) === 1);
  await page.getByTestId("settings-search").fill("ping");
  const hits = await page.getByTestId("settings-hits").innerText();
  check("設定の検索に拡張の項目", hits.includes("Ping") && hits.includes("Test extension"), hits);

  // 2. 今日の列の先頭行の知らせ（todayNotices）
  await nav(c, "/board");
  await page.waitForSelector('[data-kind="task"]');
  const notice = page.getByTestId("ext-test-today");
  await notice.waitFor({ timeout: 5000 }).catch(() => {});
  check(
    "今日の列の先頭行: 拡張の知らせ（文・色・→）",
    (await notice.count()) === 1 &&
      (await notice.innerText()).includes("Test extension · 2 to review") &&
      (await notice.getAttribute("data-tone")) === "needs",
    await notice.innerText().catch(() => ""),
  );
  const noticeOrder = await page
    .locator(`[data-date="${TODAY}"][id^="top:"], [data-kind="today-notice"], [aria-label]`)
    .first()
    .evaluate(() => {
      const top = document.querySelector('[data-kind="today-notice"]');
      const band = top?.parentElement?.querySelector("h2");
      return top && band
        ? top.compareDocumentPosition(band) & Node.DOCUMENT_POSITION_FOLLOWING
          ? "notice-first"
          : "band-first"
        : "none";
    })
    .catch(() => "none");
  check("今日の列の先頭行: 自分の番の帯より上", noticeOrder === "notice-first", noticeOrder);
  await notice.click();
  await page.waitForSelector('[data-testid="ext-test-page"]', { timeout: 5000 }).catch(() => {});
  check("知らせを押すと拡張の画面", (await page.getByTestId("ext-test-page").count()) === 1);
  await nav(c, "/day");
  const dayNotice = page.locator('[data-day-list] [data-testid="ext-test-today"]');
  await dayNotice.waitFor({ timeout: 5000 }).catch(() => {});
  check("デイビューの右の一覧の先頭にも同じ知らせ", (await dayNotice.count()) === 1);

  // 3. タスクの右クリック
  await nav(c, "/board");
  await page.waitForSelector('[data-kind="task"]');
  await page.waitForTimeout(400);
  const todo = await firstTodo(c);
  check("未完了のタスクがある", !!todo);
  if (!todo) return;
  const card = page.locator(`[data-kind="task"][data-id="${todo.id}"]`).first();
  await card.scrollIntoViewIfNeeded();
  await card.click({ button: "right" });
  const item = page.locator('[role="menuitem"]', { hasText: "Test action" });
  check("右クリックに拡張の項目", (await item.count()) === 1);
  await item.first().click();
  check("拡張の項目が拡張のルートを呼ぶ", await toastText(c, `${todo.id}: ok`));

  // 4. 詳細パネル
  await card.click();
  await page.waitForSelector('[data-testid="task-panel"]');
  await page
    .getByTestId("ext-test-panel")
    .waitFor({ timeout: 3000 })
    .catch(() => {});
  check("詳細パネルに拡張の節", (await page.getByTestId("ext-test-panel").count()) === 1);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);

  // 5. パレット
  await page.mouse.click(5, 5);
  await page.keyboard.press("Meta+k");
  const input = page.locator('[cmdk-input], [data-testid="palette-input"]').first();
  await input.waitFor({ timeout: 2000 }).catch(() => {});
  await input.fill("run test command");
  const row = page.getByRole("option").filter({ hasText: "Run test command" }).first();
  await row.waitFor({ timeout: 3000 }).catch(() => {});
  check("パレットに拡張のコマンド", (await row.count()) > 0);
  if ((await row.count()) > 0) await row.click();
  check("拡張のコマンドを実行", await toastText(c, "ext-test-palette"));

  // 6. AI に頼むの入力の行
  await openAskAi(c, card);
  check("AI に頼むに拡張の行", (await page.locator('[data-ext-field="test:later"]').count()) === 1);
  await page.getByTestId("ext-test-later").click();
  await page.getByTestId("ai-launch").click();
  check("拡張が依頼を引き受ける", await toastText(c, "ext-test-held"));
  await page.waitForTimeout(500);
  const after = (
    await c.board.api<BoardResponse>("GET", `/board?from=${TODAY}&to=${TODAY}`)
  ).days[0]?.tasks.find((t) => t.id === todo.id);
  check("今すぐの起動はしない", !after?.ai, `${titleOf(todo)} ${JSON.stringify(after?.ai)}`);

  // 15. ⌘K の選択中のタスクに拡張のメニューの項目
  await nav(c, "/board");
  await page.waitForSelector('[data-kind="task"]');
  await page.waitForTimeout(400);
  await page.locator(`[data-kind="task"][data-id="${todo.id}"]`).first().click();
  await page.waitForSelector('[data-testid="task-panel"]');
  await page.keyboard.press("Meta+k");
  await input.waitFor({ timeout: 2000 }).catch(() => {});
  const selRow = page.getByRole("option").filter({ hasText: "Test action" }).first();
  await selRow.waitFor({ timeout: 3000 }).catch(() => {});
  const selSection = await page
    .locator("h3", { hasText: "Selected" })
    .first()
    .innerText()
    .catch(() => "");
  check(
    "⌘K: 選択中のタスクに拡張の項目",
    (await selRow.count()) > 0 && /selected/i.test(selSection),
    `${await selRow.count()} ${selSection}`,
  );
  if ((await selRow.count()) > 0) await selRow.click();
  check("⌘K の拡張の項目が選んだタスクで動く", await toastText(c, `${todo.id}: ok`));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);

  // 16. 拡張が作ったタスクと時間ブロック、出どころの言葉と移動
  const made = await c.board.api<{ task: TaskView | null; block: { id: string } | null }>(
    "POST",
    "/ext/test/tasks",
    { title: "Ext made task", date: TODAY, estimateMin: 15 },
  );
  check("拡張のタスクと時間ブロックを作れる", !!made.task && !!made.block, JSON.stringify(made));
  if (made.task) {
    await nav(c, "/board");
    await page.waitForSelector('[data-kind="task"]');
    const card = page.locator(`[data-kind="task"][data-id="${made.task.id}"]`).first();
    await card.waitFor({ timeout: 5000 }).catch(() => {});
    check("拡張のタスクがボードに出る", (await card.count()) === 1);
    await card.click();
    await page.waitForSelector('[data-testid="task-panel"]');
    // 詳細を読み終えてから（経由の行は詳細の応答で描く）
    await page
      .getByTestId("task-via-open")
      .waitFor({ timeout: 5000 })
      .catch(() => {});
    const panel = await page.getByTestId("task-panel").innerText();
    check(
      "詳細パネルの経由は拡張の言葉",
      panel.includes("Test list") && !panel.includes("ext.test"),
      panel.slice(0, 400),
    );
    // 出どころの主ボタン（ExtTaskOrigin.primary。D-192 §5.4 (3)）
    const primary = page.getByTestId("task-primary");
    check(
      "詳細パネルの主ボタンは拡張の文言",
      (await primary.count()) === 1 && (await primary.innerText()).includes("Open the test list"),
      await primary.innerText().catch(() => ""),
    );
    // ボードの読み込み（時間軸の印など）が終わってから移る（WebKit は途中で切れた fetch をページのエラーにする）
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.getByTestId("task-via-open").click();
    await page.waitForLoadState("networkidle").catch(() => {});
    check("経由の移動で拡張の画面へ", new URL(page.url()).pathname === "/ext/test", page.url());
  }

  // 7. 拡張の画面（キー: j/k・⌘↑↓・⌫。枠の中と枠なし）
  await nav(c, "/ext/test");
  await page.waitForSelector('[data-testid="ext-test-page"]', { timeout: 5000 }).catch(() => {});
  check("拡張の画面", (await page.getByTestId("ext-test-page").count()) === 1);
  await keyList(c, "ext-test-list", "拡張の画面");

  // 13. 上部バーの題名・アイコン
  const title = page.getByTestId("page-title");
  check(
    "上部バー: 拡張の画面の題名と右の部品",
    (await title.count()) === 1 &&
      (await title.innerText()).includes("Test page") &&
      (await title.getByTestId("ext-test-title-aside").count()) === 1,
    await title.innerText().catch(() => ""),
  );
  const icons = page.getByTestId("ext-test-icons");
  check(
    "ext-host の状態アイコンと線のアイコン",
    (await icons.locator('[data-status="running"] svg').count()) === 1 &&
      (await icons.locator('[data-status="needs_input"] svg').count()) === 1 &&
      (await icons.locator('svg[data-icon="circle-pause"]').count()) === 1,
  );

  // 14. 画面の移動・AI の詳細パネル・本体の開き方
  const board0 = await c.board.api<BoardResponse>("GET", `/board?from=${TODAY}&to=${TODAY}`);
  const wi = (board0.days[0]?.aiLane ?? []).find((x) => !x.scratch && x.sources.length > 0)?.id;
  check("AI の作業がある", !!wi);
  await page.getByTestId("ext-test-nav").click();
  await page.waitForURL(/\/inbox/, { timeout: 3000 }).catch(() => {});
  check("navigate: 本体の画面へ移る", new URL(page.url()).pathname === "/inbox", page.url());
  if (wi) {
    await nav(c, `/ext/test?wi=${wi}`);
    await page.getByTestId("ext-test-panel-open").click();
    const panel = page.getByTestId("ai-panel");
    await panel.waitFor({ timeout: 3000 }).catch(() => {});
    check(
      "openAiPanel: 枠の中ではその場で AI 詳細パネル",
      (await panel.count()) === 1 && new URL(page.url()).pathname === "/ext/test",
      page.url(),
    );
    // パネルの読み込み（開き方・確認支援）が済んでから閉じる（途中で移ると WebKit が取り消しをエラーに数える）
    await page
      .getByTestId("ai-open-with")
      .waitFor({ timeout: 3000 })
      .catch(() => {});
    await page.waitForTimeout(500);
    await page.keyboard.press("Escape");
    await page.getByTestId("ext-test-open-ai").click();
    check(
      "openAi: 本体の開き方で端末で開く（トースト）",
      (await toastText(c, "Resume command")) && !(await toastText(c, "Couldn't open")),
    );
    await nav(c, `/ext/test/bare?wi=${wi}`);
    await page.getByTestId("ext-test-panel-open").click();
    await page
      .getByTestId("ai-panel")
      .waitFor({ timeout: 3000 })
      .catch(() => {});
    check(
      "openAiPanel: 枠なしの画面からは週ボードへ移って開く",
      new URL(page.url()).pathname === "/board" &&
        (await page.getByTestId("ai-panel").count()) === 1,
      page.url(),
    );
    await page
      .getByTestId("ai-open-with")
      .waitFor({ timeout: 3000 })
      .catch(() => {});
    await page.waitForTimeout(500);
  }

  await nav(c, "/ext/test/bare");
  await page.waitForSelector('[data-testid="ext-test-bare"]', { timeout: 5000 }).catch(() => {});
  check(
    "枠なしの拡張の画面",
    (await page.getByTestId("ext-test-bare").count()) === 1 &&
      (await page.getByTestId("sidebar").count()) === 0,
  );
  await keyList(c, "ext-test-bare-list", "枠なしの拡張の画面");

  // 8. 行を自分で並べる欄
  await nav(c, "/board");
  await page.waitForSelector('[data-kind="task"]');
  await page.waitForTimeout(400);
  const card2 = page.locator(`[data-kind="task"][data-id="${todo.id}"]`).first();
  await openAskAi(c, card2);
  const rows = page.locator('[data-ext-field="test:rows"]');
  check("行を並べる欄: 本体の行の外枠を作らない", (await rows.count()) === 1);
  const labelW = async (text: string) =>
    page
      .locator('[data-testid="ai-fields"] span', { hasText: new RegExp(`^${text}$`) })
      .first()
      .evaluate((e) => Math.round(e.getBoundingClientRect().width));
  check(
    "行を並べる欄: ラベルの幅が本体の行と同じ",
    (await labelW("Rows")) === (await labelW("Repository")),
    `${await labelW("Rows")} ${await labelW("Repository")}`,
  );
  check("行を並べる欄: 既定は1行", (await page.getByTestId("ext-test-rows-extra").count()) === 0);
  await page.getByTestId("ext-test-rows").click();
  check(
    "行を並べる欄: 値で行が増える",
    (await page.getByTestId("ext-test-rows-extra").count()) === 1,
  );
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);

  // 9. 時間軸の印
  const mark = page.locator('[data-lane="ai"] [data-kind="planned"]').first();
  await mark.waitFor({ timeout: 5000 }).catch(() => {});
  check("3日ボード: 今日の AI レーンに印", (await mark.count()) === 1);
  if ((await mark.count()) === 1) {
    const txt = await mark.innerText();
    check(
      "印: 題名・時刻・2行目",
      /Planned: test/.test(txt) && /\d{1,2}:\d{2}/.test(txt) && txt.includes("repo · test"),
      txt,
    );
    const frame = await mark.locator('[data-bar="planned"]').evaluate((e) => {
      const cs = getComputedStyle(e);
      return {
        style: cs.borderLeftStyle,
        bg: cs.backgroundColor,
        w: Math.round(e.getBoundingClientRect().width),
      };
    });
    check(
      "印: 中を塗らない 6px の実線の枠",
      frame.style === "solid" && /rgba\(0, 0, 0, 0\)|transparent/.test(frame.bg) && frame.w === 6,
      JSON.stringify(frame),
    );
    check("印: 時計のアイコン", (await mark.locator("svg").count()) === 1);
    await mark.click();
    await page.waitForSelector('[data-testid="task-panel"]', { timeout: 3000 }).catch(() => {});
    check("印を押すとタスクの詳細パネル", (await page.getByTestId("task-panel").count()) === 1);
    await page.keyboard.press("Escape");
  }
  await nav(c, "/day");
  const dmark = page.locator('[data-kind="planned"]').first();
  await dmark.waitFor({ timeout: 5000 }).catch(() => {});
  check(
    "デイビュー: AI レーンに印",
    (await dmark.count()) === 1 && /Planned: test/.test(await dmark.innerText()),
  );

  // 11. サイドバーの行
  await nav(c, "/board");
  await page.waitForSelector('[data-testid="sidebar"]');
  const side = page.getByTestId("ext-test-sidebar");
  check(
    "サイドバー: 拡張の行が設定の上に出る",
    (await side.count()) === 1 &&
      (await side.innerText()).includes("Test extension · 2 of 5 running") &&
      (await side.getAttribute("data-tone")) === "running",
  );
  const order = await page
    .getByTestId("sidebar")
    .locator('a[data-kind="ext-sidebar"], a[href="/settings"]')
    .evaluateAll((xs) => xs.map((x) => x.getAttribute("data-kind") ?? "settings"));
  check(
    "サイドバー: 拡張の行 → 設定 の順",
    order.join(",") === "ext-sidebar,settings",
    order.join(),
  );
  await side.click();
  await page.waitForSelector('[data-testid="ext-test-page"]', { timeout: 5000 }).catch(() => {});
  check("サイドバー: 押すと拡張の画面", (await page.getByTestId("ext-test-page").count()) === 1);
  await page.keyboard.press("Meta+Backslash");
  await page.waitForSelector('[data-testid="sidebar-rail"]', { timeout: 3000 }).catch(() => {});
  const railItem = page.getByTestId("sidebar-rail").getByTestId("ext-test-sidebar");
  check(
    "畳んだサイドバー: アイコンと点（tone が running なので点あり）",
    (await railItem.count()) === 1 &&
      (await railItem.locator("svg").count()) === 1 &&
      (await railItem.getByTestId("ext-sidebar-mark").count()) === 1,
  );
  check(
    "畳んだサイドバー: 今いる拡張の画面は本体の項目と同じく active",
    ((await railItem.getAttribute("class")) ?? "").split(" ").includes("active"),
  );
  check(
    "サイドバーの行のアイコンに一時停止",
    ((await railItem.locator("svg").getAttribute("class")) ?? "").includes("circle-pause"),
    (await railItem
      .locator("svg")
      .getAttribute("class")
      .catch(() => "")) ?? "",
  );
  await page.keyboard.press("Meta+Backslash");

  // 12. メニューバーのポップオーバーの行
  await page.goto(`${c.board.base}/tray`);
  const tray = page.getByTestId("ext-test-tray");
  await tray.waitFor({ timeout: 5000 }).catch(() => {});
  check(
    "ポップオーバー: 拡張の行（文と右の値）",
    (await tray.count()) === 1 && /Test extension · running\s*2\/5/.test(await tray.innerText()),
    await tray.innerText().catch(() => ""),
  );
  const below = await page
    .locator('[data-kind="ext-tray"], [data-testid="tray-focus-start"], [data-testid="tray-add"]')
    .evaluateAll((xs) =>
      xs.map((x) => x.getAttribute("data-kind") ?? x.getAttribute("data-testid")),
    );
  check(
    "ポップオーバー: 集中の行・タスクを追加の上",
    below[0] === "ext-tray" && below.includes("tray-add"),
    below.join(","),
  );
  const heights = await page
    .locator('[data-kind="ext-tray"], [data-testid="tray-add"]')
    .evaluateAll((xs) => xs.map((x) => Math.round(x.getBoundingClientRect().height)));
  check("ポップオーバー: 本体の行と同じ高さ", heights[0] === heights[1], heights.join(","));
}

async function runWithout(c: Ctx): Promise<void> {
  const { page, check } = c;
  const h = await c.board.api<{ extensions: string[] }>("GET", "/health");
  check("health の extensions は空", h.extensions.length === 0, JSON.stringify(h.extensions));
  await nav(c, "/settings");
  await page.waitForSelector('[data-testid="settings-nav"]');
  const sections = await page
    .locator('[data-testid="settings-nav"] [data-section]')
    .evaluateAll((xs) => xs.map((x) => x.getAttribute("data-section")));
  check(
    "設定の目次は本体の節だけ",
    !sections.some((s) => s?.startsWith("ext-")) && sections.at(-1) === "data",
    sections.join(","),
  );
  await nav(c, "/board");
  await page.waitForSelector('[data-kind="task"]');
  await page.waitForTimeout(400);
  check(
    "今日の列に知らせの行が無い",
    (await page.locator('[data-kind="today-notice"]').count()) === 0,
  );
  const todo = await firstTodo(c);
  if (todo) {
    const card = page.locator(`[data-kind="task"][data-id="${todo.id}"]`).first();
    await card.scrollIntoViewIfNeeded();
    await card.click({ button: "right" });
    const items = await page.locator('[role="menuitem"]').allInnerTexts();
    check("右クリックに拡張の項目が無い", !items.some((x) => x.includes("Test")), items.join("|"));
    await page.keyboard.press("Escape");
    await openAskAi(c, card);
    check("AI に頼むに拡張の行が無い", (await page.locator("[data-ext-field]").count()) === 0);
    await page.keyboard.press("Escape");
  }
  check("3日ボードに時間軸の印が無い", (await page.locator('[data-kind="planned"]').count()) === 0);
  await nav(c, "/day");
  await page.waitForSelector("[data-day]").catch(() => {});
  await page.waitForTimeout(300);
  check(
    "デイビューに時間軸の印が無い",
    (await page.locator('[data-kind="planned"]').count()) === 0,
  );
  // 廃止した画面（/shutdown・/morning・/daily-note）はボードへ（D-192）
  await nav(c, "/shutdown");
  await page.waitForURL(/\/board/, { timeout: 5000 }).catch(() => {});
  check("古い /shutdown はボードへ", new URL(page.url()).pathname === "/board", page.url());
  await nav(c, "/inbox");
  await page.waitForSelector('[data-testid="page-title"]');
  check(
    "上部バーの題名は本体のまま（Inbox）",
    (await page.getByTestId("page-title").innerText()).startsWith("Inbox"),
  );
  await nav(c, "/board");
  await page.waitForSelector('[data-kind="task"]');
  await page.waitForTimeout(300);
  const todo2 = await firstTodo(c);
  if (todo2) {
    await page.locator(`[data-kind="task"][data-id="${todo2.id}"]`).first().click();
    await page.waitForSelector('[data-testid="task-panel"]');
    await page.keyboard.press("Meta+k");
    await page
      .getByRole("option")
      .first()
      .waitFor({ timeout: 3000 })
      .catch(() => {});
    const opts = await page.getByRole("option").allInnerTexts();
    check("⌘K の選択中に拡張の項目が無い", !opts.some((x) => x.includes("Test")), opts.join("|"));
    await page.keyboard.press("Escape");
  }
  await nav(c, "/board");
  await page.waitForSelector('[data-testid="sidebar"]');
  check(
    "サイドバーに拡張の行が無い",
    (await page.locator('[data-kind="ext-sidebar"]').count()) === 0,
  );
  await page.goto(`${c.board.base}/tray`);
  await page
    .getByTestId("tray-add")
    .waitFor({ timeout: 5000 })
    .catch(() => {});
  check(
    "ポップオーバーに拡張の行が無い",
    (await page.locator('[data-kind="ext-tray"]').count()) === 0,
  );
  const token = new URL(c.board.url).searchParams.get("t") ?? "";
  const r = await fetch(`${c.board.base}/api/ext/test/ping`, {
    headers: { authorization: `Bearer ${token}` },
  });
  check("/api/ext/test/ping は 404", r.status === 404, String(r.status));
}

export const extSuite: Suite = {
  name: "ext",
  args: ["--lang", "en", "--ext", EXT_FIXTURE, "--web-dist", EXT_WEB_DIST],
  run: runWith,
};

export const extNoneSuite: Suite = { name: "ext-none", args: ["--lang", "en"], run: runWithout };
