/**
 * 既知の残り（D-138〜D-140）の回帰テスト:
 * - 日付の見出しの小さなカレンダー（今日・選んでいる日の印、稼働日でない日は薄く、‹ › と PageDown で月を移り、キーで日を選ぶ）
 * - ○ はマウスを乗せたとき・選んでいるときだけ（D-139 (4)）: Inbox の行・ボードのカード・自分の番の行（✓ はホバーのボタン）
 * - 予定の詳細パネル（D-138）: 頭・状態の1行・主のボタン（集中）・参加する・⋯、値は文字のボタン（時刻のポップオーバー・
 *   カレンダーのメニュー）、読み取りだけの予定は文字、終わった予定には集中を出さない
 * 部品の作り（○ の有無・OS の select を使わない・⋯ の位置）は単体（hover-check・task-panel）で見る（D-196）
 * - 完了の「元に戻す」（D-139 (3)）: Inbox で完了 → その場に残り「今日閉じた」へ移る → ⌘Z で戻る。畳みの ✓ でも戻る。
 *   自分の番の ✓ → 知らせ → ⌘Z で開き直す
 *
 * - タスクの詳細パネルのメモ: 行数に合わせて伸び、上限で止まって中でスクロールする（幅 1280px、高さ 900px と 700px）
 *
 * 言語は「自動」なのでエンジンによって英語か日本語で出る（文言は両方を受ける）。
 * dev-board の既定のデータ（--event-detail 付き）: 今は 2026-10-02（金）13:20 JST
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "playwright";
import type {
  BoardResponse,
  CalendarEventDetail,
  InboxResponse,
  QueueResponse,
  TaskDetailResponse,
  TaskWriteResponse,
} from "../packages/core/src/api/index.ts";
import type { Ctx, Suite } from "./harness.ts";

const TODAY = "2026-10-02";

async function settle(page: Page, ms = 250) {
  await page.waitForTimeout(ms);
}

/** cond が true になるまで待つ（最大 ms）。最後の値を返す */
async function until<T>(f: () => Promise<T>, ok: (v: T) => boolean, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  let v = await f();
  while (!ok(v) && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 150));
    v = await f();
  }
  return v;
}

/** 読み込み中の要求が終わってから移る（WebKit は移動で取り消した fetch を pageerror に出す） */
async function go(page: Page, url: string) {
  await settle(page, 300);
  await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
  await page.goto(url);
}

async function closeAll(page: Page) {
  for (let i = 0; i < 3; i++) await page.keyboard.press("Escape");
  await settle(page, 150);
}

/** 日付の見出しの小さなカレンダー（D-113 で後にした分） */
async function miniCalendar(t: Ctx) {
  const { page, board } = t;
  await go(page, `${board.base}/day`);
  await page.waitForSelector(`[data-grid="${TODAY}"]`);
  await page.getByTestId("period").click();
  const cal = page.getByTestId("mini-calendar");
  await cal.waitFor({ timeout: 2000 });
  t.check(
    "date header: opens a month calendar (not a native date input)",
    (await page.locator('input[type="date"]').count()) === 0 &&
      (await cal.getAttribute("data-month")) === "2026-10",
  );
  const todayCell = cal.locator(`[data-date="${TODAY}"]`);
  t.check(
    "calendar: today is marked and selected, and has focus",
    (await todayCell.getAttribute("aria-current")) === "date" &&
      (await todayCell.getAttribute("aria-pressed")) === "true" &&
      (await todayCell.evaluate((e) => e === document.activeElement)),
  );
  t.check(
    "calendar: non-working days are dimmed (Sat/Sun), working days are not",
    (await cal.locator('[data-date="2026-10-03"]').getAttribute("data-off")) === "" &&
      (await cal.locator('[data-date="2026-10-04"]').getAttribute("data-off")) === "" &&
      (await cal.locator('[data-date="2026-10-05"]').getAttribute("data-off")) === null,
  );
  // 祝日カレンダーの祝日（dev-board の Example Holiday = 10/6）も薄くする
  const holiday = await until(
    () => cal.locator('[data-date="2026-10-06"]').getAttribute("data-off"),
    (v) => v === "",
  );
  t.check("calendar: holidays are dimmed", holiday === "");
  // ‹ › で月を移る
  await page.getByTestId("mini-calendar-next").click();
  const next = await cal.getAttribute("data-month");
  await page.getByTestId("mini-calendar-prev").click();
  const back = await cal.getAttribute("data-month");
  t.check(
    "calendar: ‹ › change the month",
    next === "2026-11" && back === "2026-10",
    `${next} ${back}`,
  );
  // キー: → で翌日、↓ で1週間後、PageDown で次の月、⏎ でその日へ
  await todayCell.focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("PageDown");
  const month = await cal.getAttribute("data-month");
  const focused = await page.evaluate(() => document.activeElement?.getAttribute("data-date"));
  await page.keyboard.press("Enter");
  await settle(page, 300);
  const closed = (await cal.count()) === 0;
  const shown = await until(
    () => page.locator('[data-grid="2026-11-10"]').count(),
    (n) => n > 0,
  );
  t.check(
    "calendar: arrows/PageDown move the day, ⏎ goes to it and closes",
    month === "2026-11" && focused === "2026-11-10" && closed && shown > 0,
    `${month} ${focused} ${closed} ${shown}`,
  );
  // クリックでも行ける（3日ボード）
  await go(page, `${board.base}/board`);
  await page.waitForSelector(`[data-grid="${TODAY}"]`);
  await page.getByTestId("period").click();
  await cal.waitFor({ timeout: 2000 });
  await cal.locator('[data-date="2026-10-07"]').click();
  const moved = await until(
    () => page.locator('[data-grid="2026-10-07"]').count(),
    (n) => n > 0,
  );
  t.check("calendar: clicking a day moves the board", moved > 0);
  // 「今日」に戻す
  await closeAll(page);
  await page.getByRole("button", { name: /^(今日|Today)$/ }).click();
  await settle(page);
}

const opacity = (l: Locator) => l.evaluate((e) => Number(getComputedStyle(e).opacity));
const toastText = (page: Page) =>
  page
    .locator('[role="status"]')
    .allInnerTexts()
    .then((xs) => xs.join(" | "));
const undoKey = async (page: Page) => {
  // 入力欄にフォーカスがあると画面のキーに届かないので、地をクリックしてから押す
  await page.mouse.click(700, 880);
  await page.keyboard.press("Meta+z");
};

/** Inbox: ○ はホバーで出る。完了はその場に残ってから「今日閉じた」へ。⌘Z と畳みの ✓ で戻る */
async function inboxDone(t: Ctx) {
  const { page, board } = t;
  const mk = (title: string) =>
    board.api<TaskWriteResponse>("POST", "/tasks", { title }).then((r) => r.task?.id as string);
  const a = await mk("Panels undo A");
  const b = await mk("Panels undo B");
  await go(page, `${board.base}/inbox`);
  const row = page.locator(`[data-testid="inbox-list"] [data-kind="task"][data-id="${a}"]`);
  await row.waitFor({ timeout: 5000 });
  const ids = () =>
    page
      .locator('[data-testid="inbox-list"] [data-kind="task"]')
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-id")));
  const before = (await ids()).indexOf(a);
  const check = row.locator('[role="checkbox"]');
  const rest = await opacity(check);
  await row.hover();
  const hovered = await opacity(check);
  t.check(
    "inbox: ○ is invisible at rest but present for AT, and shows on hover",
    rest === 0 && hovered === 1 && (await check.getAttribute("aria-label")) !== null,
    `${rest} → ${hovered}`,
  );
  const toolbar = await row
    .locator('[data-testid="hover-toolbar"] [data-action]')
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-action")));
  t.check(
    "inbox: hover buttons are “place on a day”, “ask AI” and ⋯",
    JSON.stringify(toolbar) === JSON.stringify(["move", "askAi", "more"]),
    JSON.stringify(toolbar),
  );
  await check.click();
  await settle(page, 400);
  const lingering = await row.getAttribute("data-lingering");
  const sub = (await row.locator('[data-kind="task-sub"]').textContent()) ?? "";
  const toast = await toastText(page);
  t.check(
    "inbox: the completed row stays in place with ✓ and “moving to Closed today”",
    lingering === "" &&
      /Closed today|今日閉じた/.test(sub) &&
      (await check.getAttribute("aria-checked")) === "true",
    `${lingering} ${sub}`,
  );
  t.check(
    "inbox: the toast says “Completed.” with Undo",
    /(Completed\.|完了にしました。)\s*(Undo|元に戻す)/.test(toast),
    toast,
  );
  // 数秒後に「今日閉じた」へ
  const moved = await until(
    () => row.count(),
    (n) => n === 0,
    8000,
  );
  const fold = page.getByTestId("inbox-closed");
  t.check(
    "inbox: after a few seconds the row moves into “Closed today”",
    moved === 0 &&
      (await fold.isVisible()) &&
      /Closed today 1|今日閉じた 1/.test(await fold.innerText()),
    await fold.innerText().catch(() => "no fold"),
  );
  // ⌘Z で元の場所へ戻る
  await undoKey(page);
  const back = await until(
    () => row.count(),
    (n) => n === 1,
  );
  // 元の位置（作成の新しい順）。偽の時計では作成の時刻が同じタスクが並ぶので、サーバーの並びと同じ位置かで見る
  const inbox = await board.api<InboxResponse>("GET", "/inbox");
  const want = inbox.tasks.map((x) => x.id).indexOf(a);
  const after = await until(
    async () => (await ids()).indexOf(a),
    (i) => i === want,
  );
  t.check(
    "inbox: ⌘Z brings it back to its place as not done",
    back === 1 && after === want && Math.abs(after - before) <= 1 && inbox.closed.length === 0,
    `${back} ${before} → ${after} (server ${want}) closed ${inbox.closed.length}`,
  );
  // もう一度完了 → 畳みの中の ✓ で戻す
  await row.hover();
  await check.click();
  await until(
    () => row.count(),
    (n) => n === 0,
    8000,
  );
  await settle(page, 300);
  const foldBtn = fold.locator("button[aria-expanded]");
  if ((await foldBtn.getAttribute("aria-expanded")) !== "true") await foldBtn.click();
  const closedRow = fold.locator(`[data-kind="task"][data-id="${a}"]`);
  await closedRow.waitFor({ timeout: 3000 });
  const filled = await opacity(closedRow.locator('[role="checkbox"]'));
  await closedRow.locator('[role="checkbox"]').click();
  const reopened = await until(
    () => board.api<InboxResponse>("GET", "/inbox").then((r) => r.tasks.some((x) => x.id === a)),
    (v) => v,
  );
  const inList = await until(
    () => row.count(),
    (n) => n === 1,
  );
  t.check(
    "inbox: the filled ✓ in “Closed today” is visible and undoes it",
    filled === 1 && reopened && inList === 1,
    `${filled} ${reopened} ${inList}`,
  );
  await board.api("DELETE", `/tasks/${a}`);
  await board.api("DELETE", `/tasks/${b}`);
}

/** ボードのカード: ふだんは ○ を出さず、選ぶと出る */
async function boardCard(t: Ctx) {
  const { page, board } = t;
  const r = await board.api<TaskWriteResponse>("POST", "/tasks", {
    title: "Panels card",
    date: TODAY,
  });
  const id = r.task?.id as string;
  await go(page, `${board.base}/board`);
  const card = page.locator(`[data-grid="${TODAY}"] [data-kind="task"][data-id="${id}"]`).first();
  const card2 = page.locator(`[data-kind="task"][data-id="${id}"]`).first();
  const c = (await card.count()) > 0 ? card : card2;
  await c.waitFor({ timeout: 5000 });
  await page.mouse.move(5, 5);
  const check = c.locator('[role="checkbox"]');
  const rest = await opacity(check);
  await c.click();
  await page.mouse.move(5, 5);
  await settle(page, 200);
  const sel = await c.getAttribute("data-selected");
  const shown = await opacity(check);
  // 時間軸のカードのホバーのボタンは →| と ⋯ だけ（T4）。今日へ・1日後へ・時間に置く・AI に頼むは ⋯ の中
  await board.api("POST", "/time-blocks", {
    taskId: id,
    startAt: Date.parse(`${TODAY}T11:00:00+09:00`),
    endAt: Date.parse(`${TODAY}T11:30:00+09:00`),
  });
  await go(page, `${board.base}/board`);
  const tl = page.locator(`[data-grid="${TODAY}"] [data-kind="task"][data-id="${id}"]`).first();
  await tl.waitFor({ timeout: 5000 });
  await tl.scrollIntoViewIfNeeded();
  await tl.hover();
  const tlButtons = await tl
    .locator('[data-testid="hover-toolbar"] [data-action]')
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-action")));
  await tl.locator('[data-testid="hover-toolbar"] [data-action="more"]').click();
  const more = await page
    .locator('[data-testid="context-menu"] [data-menu-id]')
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-menu-id")));
  await closeAll(page);
  t.check(
    "timeline card (30m): hover shows ✓ →| ⋯; today/later/place/ask AI are in ⋯",
    JSON.stringify(tlButtons) === JSON.stringify(["complete", "move", "more"]) &&
      ["today", "later", "place", "askAi"].every((x) => more.includes(x)),
    `${JSON.stringify(tlButtons)} ${JSON.stringify(more)}`,
  );
  // 時間軸のカードは左の ○ を持たず、題名はカードの左の余白（予定と同じ 8px）から始まる（D-148）
  await page.mouse.move(5, 5);
  await settle(page, 200);
  const cardBox = await tl.boundingBox();
  const titleBox = await tl.locator("span.font-medium").first().boundingBox();
  const inset = cardBox && titleBox ? titleBox.x - cardBox.x : -1;
  t.check(
    "timeline card: no ○ on the left; the title starts at the card's left padding",
    (await tl.locator('[role="checkbox"]').count()) === 0 && inset >= 6 && inset <= 12,
    `inset ${inset}`,
  );
  // ✓ で完了（元に戻すの知らせ）。完了済みのカードは塗った ✓ で未完了に戻す
  await tl.hover();
  await tl.locator('[data-testid="hover-toolbar"] [data-action="complete"]').click();
  const doneNow = await until(
    () => board.api<TaskDetailResponse>("GET", `/tasks/${id}`).then((d) => d.task.status),
    (st) => st === "done",
  );
  const toast = await until(
    () => toastText(page),
    (x) => x.length > 0,
  );
  t.check(
    "timeline card: ✓ completes the task and shows “Completed.” with Undo",
    doneNow === "done" && /(Completed\.|完了にしました。)\s*(Undo|元に戻す)/.test(toast),
    `${doneNow} ${toast}`,
  );
  const doneCard = page
    .locator(`[data-grid="${TODAY}"] [data-kind="task"][data-id="${id}"]`)
    .first();
  await doneCard.waitFor({ timeout: 5000 });
  await doneCard.hover();
  const doneButtons = await doneCard
    .locator('[data-testid="hover-toolbar"] [data-action]')
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-action")));
  const filled = await doneCard
    .locator('[data-testid="hover-toolbar"] [data-action="complete"]')
    .getAttribute("data-filled");
  await doneCard.locator('[data-testid="hover-toolbar"] [data-action="complete"]').click();
  const reopened = await until(
    () => board.api<TaskDetailResponse>("GET", `/tasks/${id}`).then((d) => d.task.status),
    (st) => st !== "done",
  );
  t.check(
    "timeline card (done): hover shows a filled ✓ and ⋯; the ✓ marks it not done",
    JSON.stringify(doneButtons) === JSON.stringify(["complete", "more"]) &&
      filled === "" &&
      reopened !== "done",
    `${JSON.stringify(doneButtons)} filled=${filled} ${reopened}`,
  );
  t.check(
    "board card: ○ is hidden at rest and shown while selected (no hover)",
    rest === 0 && sel === "" && shown === 1,
    `${rest} ${sel} ${shown}`,
  );
  await closeAll(page);
  await board.api("DELETE", `/tasks/${id}`);
}

/** 自分の番: Space で完了 → 知らせ → ⌘Z で開き直す（✓ はホバーのボタンから … と右クリックと Space へ。D-214 の §4） */
async function turnDone(t: Ctx) {
  const { page, board } = t;
  await go(page, `${board.base}/queue`);
  const row = page.locator('[data-kind="turn"]').first();
  await row.waitFor({ timeout: 5000 });
  const wid = (await row.getAttribute("data-id")) ?? "";
  // 選んでいる行（マウスなし）はホバーのボタンを出さない（理由・待ちを隠さない）
  const sel = page.locator('[data-kind="turn"][data-selected]').first();
  if ((await sel.count()) > 0) {
    await page.mouse.move(5, 5);
    const shown = await sel
      .locator('[data-testid="hover-toolbar"] button')
      .evaluateAll((els) => els.filter((e) => e.getBoundingClientRect().width > 0).length);
    t.check(
      "your turn: the selected row shows no hover buttons without hover",
      shown === 0,
      `${shown}`,
    );
  }
  await row.click();
  await page.keyboard.press("Space");
  const gone = await until(
    () => page.locator(`[data-kind="turn"][data-id="${wid}"]`).count(),
    (n) => n === 0,
  );
  const toast = await until(
    () => toastText(page),
    (x) => /Completed\.|完了にしました。/.test(x),
  );
  await undoKey(page);
  const back = await until(
    () =>
      board
        .api<QueueResponse>("GET", "/queue")
        .then((q) =>
          q.items.some((x) => x.workItemId === wid && x.followUps.some((f) => f.status === "open")),
        ),
    (v) => v,
  );
  t.check(
    "your turn: Space completes with a toast, ⌘Z reopens it",
    gone === 0 && /Completed\.|完了にしました。/.test(toast) && back,
    `${gone} ${toast} ${back}`,
  );
}

/**
 * 帯（D-214 の §4）: ホバーのボタンは 開く・対応不要・… の 3 つで、理由の文と待ちを隠さない。
 * 「ほか N 件」はボードの詳細パネルを閉じてから自分の番へ移る（詳細が 2 枚にならず、一覧が狭くならない）
 */
async function bandHoverAndMore(t: Ctx) {
  const { page, board } = t;
  await go(page, `${board.base}/board`);
  const band = page.locator(`[data-kind="turn"]`);
  await band.first().waitFor({ timeout: 5000 });
  const row = band.first();
  await row.hover();
  await settle(page, 200);
  const buttons = await row
    .locator('[data-testid="hover-toolbar"] [data-action]')
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-action")));
  const bar = await row.getByTestId("hover-toolbar").boundingBox();
  const why = row.locator('[data-kind="turn-why-inline"], [data-kind="turn-why"]').first();
  const whyBox = (await why.count()) > 0 ? await why.boundingBox() : null;
  const wait = await row.locator('[data-kind="turn-wait"]').first().boundingBox();
  const clear = (b: { x: number; width: number } | null) =>
    !b || !bar || b.width === 0 || b.x + b.width <= bar.x + 1;
  t.check(
    "band row hover: open / (answer) / not needed / ⋯ only; the reason and wait stay left of the buttons",
    [
      JSON.stringify(["open", "dismiss", "more"]),
      // 問い・許可・エラーの待ちは「答える」も（D-238）
      JSON.stringify(["open", "answer", "dismiss", "more"]),
    ].includes(JSON.stringify(buttons)) &&
      !!whyBox &&
      whyBox.width > 40 &&
      clear(whyBox) &&
      clear(wait),
    `${JSON.stringify(buttons)} why ${whyBox ? `${whyBox.x}+${whyBox.width}` : "-"} wait ${
      wait ? `${wait.x}+${wait.width}` : "-"
    } bar ${bar?.x ?? "-"}`,
  );
  await page.mouse.move(5, 5);
  // 帯の行を押してボードの詳細を開いてから「ほか N 件」
  await row.click();
  await page.getByTestId("ai-panel").waitFor({ timeout: 5000 });
  const more = page.getByTestId("band-more");
  if ((await more.count()) === 0) {
    t.check("band: “+N more” is shown with the default data", false, "no band-more");
    return;
  }
  await more.click();
  await page.waitForURL(/\/queue/, { timeout: 5000 });
  await page.locator('[data-kind="turn"]').first().waitFor({ timeout: 5000 });
  await settle(page, 300);
  const aiPanels = await page.getByTestId("ai-panel").count();
  const details = await page.getByTestId("queue-detail").count();
  const list = await page.locator('[data-kind="turn"]').first().boundingBox();
  t.check(
    "band “+N more”: closes the board detail and opens the queue with one detail panel",
    aiPanels === 0 && details <= 1 && !!list && list.width >= 600,
    `ai-panel ${aiPanels} queue-detail ${details} list ${list?.width ?? "-"}`,
  );
  await closeAll(page);
}

async function clickBox(page: Page, item: Locator) {
  await item.scrollIntoViewIfNeeded();
  const b = await item.boundingBox();
  if (!b) throw new Error("no box");
  await page.mouse.click(b.x + Math.min(8, b.width / 2), b.y + Math.min(8, b.height / 2));
}

async function eventOf(board: Ctx["board"], title: string) {
  const b = await board.api<BoardResponse>("GET", `/board?from=${TODAY}&to=${TODAY}`);
  return b.days[0]?.events.find((e) => e.title === title);
}

/** 3日ボードの今日の予定を押して詳細パネルを開く */
async function openEventPanel(page: Page, title: string) {
  await closeAll(page);
  const ev = page.locator(`[data-grid="${TODAY}"] [data-kind="event"]`, { hasText: title }).first();
  await ev.waitFor({ timeout: 5000 });
  await settle(page, 200);
  await clickBox(page, ev);
  const panel = page.getByTestId("event-panel");
  await panel.getByTestId("event-state").waitFor({ timeout: 3000 });
  return panel;
}

/** 予定の詳細パネル（D-138） */
async function eventPanel(t: Ctx) {
  const { page, board } = t;
  await go(page, `${board.base}/board`);
  await page.waitForSelector(`[data-grid="${TODAY}"]`);
  // 編集できる予定（参加者なし・場所とリンク付き）
  let panel = await openEventPanel(page, "Pairing with Kim");
  const state = (await panel.getByTestId("event-state").innerText()).replace(/\s+/g, " ");
  const first = panel.getByTestId("event-actions").locator("button, a").first();
  t.check(
    "event panel: big title, state line “Today 16:00–16:45 · 45m · Work”",
    (await panel.locator("textarea").first().inputValue()) === "Pairing with Kim" &&
      /(Today|今日) 16:00–16:45 · 45m · Work/.test(state),
    state,
  );
  t.check(
    "event panel: focus is the primary button right under the state line; Join and ⋯ in the row",
    (await first.getAttribute("data-testid")) === "event-focus" &&
      (await first.getAttribute("data-primary")) === "" &&
      (await panel.getByTestId("event-join").getAttribute("href")) ===
        "https://meet.example.com/pair-kim" &&
      (await panel.getByTestId("event-more").count()) === 1,
  );
  // 時刻: 文字のボタン → 開始と長さのポップオーバー
  await panel.getByTestId("event-time").click();
  const start = page.getByTestId("time-start");
  await start.waitFor({ timeout: 2000 });
  await start.fill("16:30");
  await page.getByTestId("time-place").click();
  const moved = await until(
    () => eventOf(board, "Pairing with Kim"),
    (e) => e !== undefined && new Date(e.start).toISOString().endsWith("07:30:00.000Z"),
  );
  t.check(
    "event panel: the time button opens start/length and saves",
    moved !== undefined && moved.end - moved.start === 45 * 60_000,
    moved ? new Date(moved.start).toISOString() : "none",
  );
  // カレンダー: 色の点の一覧（✓ が今の値）から移す
  await panel.getByTestId("event-calendar").click();
  const menu = page.getByTestId("context-menu");
  await menu.waitFor({ timeout: 2000 });
  const checked = await menu.locator('[aria-checked="true"]').innerText();
  await menu.locator("[data-menu-id]", { hasText: "Personal" }).click();
  const evId = (await eventOf(board, "Pairing with Kim"))?.id ?? "";
  const cal = await until(
    () => board.api<CalendarEventDetail>("GET", `/calendar-events/${evId}`),
    (e) => e.calendarName === "Personal",
  );
  t.check(
    "event panel: the calendar menu shows ✓ on the current one and moves the event",
    /Work/.test(checked) && cal.calendarName === "Personal",
    `${checked} → ${cal.calendarName}`,
  );
  // 集中: 押すと設定、もう一度で取り消す
  const focus = panel.getByTestId("event-focus");
  await focus.click();
  const on = await until(
    () => focus.getAttribute("data-on"),
    (v) => v === "true",
  );
  await focus.click();
  const off = await until(
    () => focus.getAttribute("data-on"),
    (v) => v === "false",
  );
  t.check("event panel: focus toggles on and off", on === "true" && off === "false");

  // 読み取りだけの予定（参加者あり）: 値は文字、理由を1行
  panel = await openEventPanel(page, "Design review");
  t.check(
    "event panel (read-only): values are plain text, title is not editable, reason shown",
    (await panel.locator("textarea").count()) === 0 &&
      (await panel.getByTestId("event-time").evaluate((e) => e.tagName)) === "SPAN" &&
      (await panel.getByTestId("event-calendar").evaluate((e) => e.tagName)) === "SPAN" &&
      (await panel.getByTestId("event-readonly").count()) === 1 &&
      (await panel.getByTestId("event-join").count()) === 1,
  );
  // 終わった予定: 集中は出さない。⋯ は右クリックと同じ並び（集中なし）
  panel = await openEventPanel(page, "Weekly sync");
  await panel.getByTestId("event-more").click();
  const ids = await page
    .locator('[data-testid="context-menu"] [data-menu-id]')
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-menu-id")));
  t.check(
    "event panel (ended): no focus button; ⋯ has open, colour and hide calendar only",
    (await panel.getByTestId("event-focus").count()) === 0 &&
      JSON.stringify(ids) === JSON.stringify(["eventOpen", "calColor", "hideCalendar"]) &&
      (await panel.getByTestId("event-open").count()) === 1,
    JSON.stringify(ids),
  );
  await closeAll(page);
}

/** タスクの詳細パネルのメモは行数に合わせて伸び、上限で止まって中でスクロールする（右下のつまみはそのまま） */
async function taskNotes(t: Ctx) {
  const { page, board } = t;
  const shots = process.env.TURNLANE_E2E_SHOTS;
  if (shots) mkdirSync(shots, { recursive: true });
  const r = await board.api<TaskWriteResponse>("POST", "/tasks", {
    title: "Notes grow",
    date: TODAY,
  });
  const id = r.task?.id as string;
  for (const height of [900, 700]) {
    await page.setViewportSize({ width: 1280, height });
    await go(page, `${board.base}/board`);
    const card = page.locator(`[data-kind="task"][data-id="${id}"]`).first();
    await card.waitFor({ timeout: 5000 });
    await card.scrollIntoViewIfNeeded();
    await card.click();
    const notes = page.locator('[data-testid="task-notes"] textarea');
    await notes.waitFor({ timeout: 5000 });
    const size = () =>
      notes.evaluate((el: HTMLTextAreaElement) => ({
        h: el.offsetHeight,
        scrolls: el.scrollHeight > el.clientHeight + 1,
        resize: getComputedStyle(el).resize,
      }));
    await notes.fill("");
    await settle(page, 100);
    const empty = await size();
    await notes.focus();
    await page.keyboard.insertText(
      Array.from({ length: 10 }, (_, i) => `memo line ${i + 1}`).join("\n"),
    );
    await settle(page, 100);
    const ten = await size();
    t.check(
      `task notes: pasting 10 lines grows the field (height ${height})`,
      ten.h > empty.h + 60 && !ten.scrolls && ten.resize === "vertical",
      JSON.stringify({ empty, ten }),
    );
    await notes.fill(Array.from({ length: 8 }, (_, i) => `memo line ${i + 1}`).join("\n"));
    await settle(page, 100);
    if (shots && height === 900) {
      await page.screenshot({ path: join(shots, "task-notes-8-lines.png") });
    }
    await notes.fill(Array.from({ length: 60 }, (_, i) => `memo line ${i + 1}`).join("\n"));
    await settle(page, 100);
    const big = await size();
    t.check(
      `task notes: past the limit it scrolls inside (height ${height})`,
      big.scrolls && big.h > ten.h,
      JSON.stringify(big),
    );
    await notes.fill("");
    await settle(page, 100);
    t.check(
      `task notes: deleting shrinks back to the minimum (height ${height})`,
      (await size()).h === empty.h,
    );
    await notes.evaluate((el: HTMLTextAreaElement) => el.blur());
    await closeAll(page);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

async function run(t: Ctx) {
  await t.page.goto(t.board.url.replace(/next=[^&]*/, "next=%2Fday"));
  await t.page.waitForSelector(`[data-grid="${TODAY}"]`);
  await miniCalendar(t);
  await inboxDone(t);
  await boardCard(t);
  await turnDone(t);
  await bandHoverAndMore(t);
  await eventPanel(t);
  await taskNotes(t);
}

export const panelsSuite: Suite = { name: "panels", args: ["--event-detail"], run };
