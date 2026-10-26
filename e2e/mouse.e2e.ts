/**
 * マウスだけで主要な6つの流れを完了できること（UX 監査 2026-10 の (a)、D-099「マウスで全ての操作ができる」）の回帰テスト。
 * ショートカットのキーは押さない。文字の入力（題名）だけは入力欄に書く（確定は「作成」のボタン）。⌘ クリックは修飾付きのクリック。
 *
 * 1. 今日を見る: 1クリックで選択して詳細パネル（予定・タスク・自分の番・AI のどれでも同じ）、パネルは選択に追従する
 * 2. タスクを足して時間に置く: 列の「+ 追加」→ 作成、ホバーのボタン「時間に置く」→ 候補をクリック。⌘ クリックの複数選択と一括操作
 * 3. AI の待ちに対応する: 自分の番の行のホバーのボタン（明日へ）・右クリックメニュー（対応不要）・ホバーのボタンの ✓（完了。D-139 (4)）
 * 4. 予定を作る: 空き枠のクリック → 「予定」のタブ → 作成（空き枠の右クリックのメニューにも「ここに予定を作る」）
 * 5. 記録を見る: 上部の「日」→ 上部の「記録」→ 右のパネル（Markdown をコピー）。一日を閉じるは D-192 で廃止
 * 6. 設定を変える: サイドバーの設定 → テーマを「ダーク」
 *
 * dev-board の既定のデータ: 今は 2026-10-02（金）13:20 JST。次の稼働日は 10/5（月）。自分の番が4件
 */
import type { Page } from "playwright";
import type { BoardResponse, QueueResponse } from "../packages/core/src/api/index.ts";
import type { Board, Ctx, Suite } from "./harness.ts";

const TODAY = "2026-10-02";
const NEXT = "2026-10-05";
const hm = (ms: number) =>
  new Date(ms + 9 * 3_600_000).toISOString().slice(11, 16).replace(/^0/, "");

async function day(board: Board, date: string) {
  const b = await board.api<BoardResponse>("GET", `/board?from=${date}&to=${date}`);
  return b.days[0];
}

const titleOf = (x: { title: { t: string; text?: string } }) =>
  x.title.t === "text" ? (x.title.text ?? "") : "";

/** 時間軸のその時刻の画面座標（自分のレーンの中ほど）。時刻が画面の中ほどに来るよう縦にスクロールしてから測る */
async function slotPoint(page: Page, date: string, hhmm: string) {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  const frac = (h * 60 + m + 5) / 1440;
  return page
    .evaluate(
      ({ date, frac }) => {
        const g = document.querySelector<HTMLElement>(`[data-grid="${date}"]`);
        if (!g) throw new Error(`no grid for ${date}`);
        const s = document.querySelector<HTMLElement>('[data-testid="board-scroll"]');
        if (s) {
          const r0 = g.getBoundingClientRect();
          const sr = s.getBoundingClientRect();
          s.scrollTop += r0.top + r0.height * frac - (sr.top + sr.height / 2);
        }
        const r = g.getBoundingClientRect();
        return { x: r.left + r.width * 0.5, y: r.top + r.height * frac };
      },
      { date, frac },
    )
    .then(async (pt) => {
      // スクロールの通知（メニューを閉じる）が届いてから押す
      await page.waitForTimeout(200);
      return pt;
    });
}

/** 詳細パネルのどれが開いているか */
async function openPanel(page: Page): Promise<string> {
  for (const id of ["ai-panel", "task-panel", "event-panel"])
    if ((await page.getByTestId(id).count()) > 0) return id;
  return "none";
}

async function run(t: Ctx) {
  const { page, board } = t;
  const keys: string[] = [];
  // ショートカットのキーを押していないことを確かめる（入力欄への文字の入力は数えない）
  await page.exposeFunction("__dlKey", (k: string) => keys.push(k));
  await page.addInitScript(() => {
    window.addEventListener(
      "keydown",
      (e) => {
        const el = e.target as HTMLElement | null;
        if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return;
        // ⌘ クリックの修飾キーは数えない
        if (["Meta", "Shift", "Control", "Alt"].includes(e.key)) return;
        (window as unknown as { __dlKey: (k: string) => void }).__dlKey(e.key);
      },
      true,
    );
  });
  await page.goto(board.url.replace(/next=[^&]*/, "next=%2Fboard"));
  await page.waitForSelector(`[data-grid="${TODAY}"]`);
  await page.waitForTimeout(800);

  // ---------- 1. 今日を見る ----------
  await page.locator('[data-kind="event"]').first().click();
  await page.waitForTimeout(300);
  t.check(
    "1 view: clicking an event opens the event panel",
    (await openPanel(page)) === "event-panel",
  );
  const turn0 = page.locator('[data-kind="turn"]').first();
  await turn0.click();
  await page.waitForTimeout(300);
  t.check(
    "1 view: clicking a your-turn row opens the AI panel (same rule as tasks and AI)",
    (await openPanel(page)) === "ai-panel",
  );
  await page.locator('[data-kind="ai"]').first().click();
  await page.waitForTimeout(300);
  t.check(
    "1 view: clicking an AI block keeps the AI panel",
    (await openPanel(page)) === "ai-panel",
  );
  // AI の詳細パネル（D-116）: 状態とすること・主のボタン・流れ。ターンの一覧は出さない。⋯ のメニューに非表示
  {
    const panel = page.getByTestId("ai-panel");
    t.check(
      "1 view: the AI panel answers state, action and flow (no turn list)",
      (await panel.getByTestId("ai-state").count()) === 1 &&
        (await panel.getByTestId("ai-todo").innerText()).length > 0 &&
        (await panel.getByTestId("ai-primary").count()) === 1 &&
        (await panel.getByTestId("flow").count()) === 1 &&
        !/tool call|ツール呼び出し/.test(await panel.innerText()),
    );
    await panel.getByTestId("ai-more").click();
    await page.waitForTimeout(200);
    t.check(
      "1 view: the AI panel ⋯ menu has Hide",
      (await page.locator('[data-testid="context-menu"] [data-menu-id="hide"]').count()) === 1,
    );
    // 外側を押して閉じる（このスイートはキーを押さない）
    await panel.getByTestId("ai-todo").click();
    await page.waitForTimeout(200);
  }
  await page.locator('[data-kind="task"]').first().click();
  await page.waitForTimeout(300);
  t.check(
    "1 view: the panel follows the selection (a task opens the task panel)",
    (await openPanel(page)) === "task-panel",
  );
  const count = await page.getByTestId("count-needs_input").innerText();
  t.check(
    "1 view: the top bar shows the counts with words",
    /\d/.test(count) && /Blocked on you|ブロック中/.test(count),
    count,
  );
  // 凡例
  await page.getByTestId("legend-button").click();
  t.check("1 view: the legend opens", await page.getByTestId("legend").isVisible());
  await page.getByTestId("legend-button").click();

  // ---------- 2. タスクを足して時間に置く ----------
  const addToday = page.locator(`[data-testid="column-add"][data-date="${TODAY}"]`);
  for (const title of ["Mouse task A", "Mouse task B"]) {
    await addToday.click();
    await page.getByTestId("prompt-input").fill(title);
    await page.getByTestId("prompt-create").click();
    await page.waitForTimeout(600);
  }
  const d1 = await day(board, TODAY);
  const a = d1?.tasks.find((x) => titleOf(x) === "Mouse task A");
  const b = d1?.tasks.find((x) => titleOf(x) === "Mouse task B");
  t.check("2 task: “+ Add” in the column creates tasks for that day", !!a && !!b);
  if (a) {
    const card = page.locator(`[data-kind="task"][data-id="${a.id}"]`);
    await card.hover();
    await card.locator('[data-action="place"]').click();
    const row = page.locator('[data-row-index="0"]');
    const shown = await row
      .waitFor({ timeout: 3000 })
      .then(() => true)
      .catch(() => false);
    t.check("2 task: the hover button “Schedule” shows the free slots", shown);
    if (shown) await row.click();
    await page.waitForTimeout(800);
    const d2 = await day(board, TODAY);
    t.check(
      "2 task: picking a slot puts the task on the timeline",
      !!d2?.timeBlocks.some((x) => x.taskId === a.id),
    );
  }
  // ⌘ クリックの複数選択と一括操作のバー
  if (a && b) {
    await page.locator(`[data-kind="task"][data-id="${a.id}"]`).first().click();
    await page
      .locator(`[data-kind="task"][data-id="${b.id}"]`)
      .first()
      .click({ modifiers: ["Meta"] });
    const bar = page.getByTestId("bulk-bar");
    const barShown = await bar
      .waitFor({ timeout: 2000 })
      .then(() => true)
      .catch(() => false);
    t.check("2 task: ⌘-click selects two tasks and shows the bulk bar", barShown);
    if (barShown) await bar.locator('[data-action="later"]').click();
    await page.waitForTimeout(800);
    // 1日後（10/3）へ
    const next = await day(board, "2026-10-03");
    const moved = (next?.tasks ?? []).filter((x) => x.id === a.id || x.id === b.id).length;
    t.check("2 task: the bulk bar moves both one day later", moved === 2, `moved ${moved}`);
    if (barShown) await bar.getByRole("button").last().click();
  }

  // ---------- 3. AI の待ちに対応する ----------
  await page.locator(`[data-testid="mode-three"]`).click();
  await page.waitForTimeout(500);
  const q0 = await board.api<QueueResponse>("GET", "/queue");
  const visible = () =>
    board
      .api<QueueResponse>("GET", "/queue")
      .then((q) => q.items.filter((x) => x.followUps.some((f) => f.status === "open")));
  const n0 = (await visible()).length;
  const rows = page.locator('[data-kind="turn"]');
  // 左に ○ は出さない。ホバーのボタンは 開く・対応不要・…（D-214 の §4。完了・明日へは … と右クリック）
  await rows.first().hover();
  const firstAction = await rows
    .first()
    .locator('[data-testid="hover-toolbar"] [data-action]')
    .first()
    .getAttribute("data-action");
  t.check(
    "3 turn: no ○ on the row; hovering shows “open” first in the hover buttons",
    (await rows.first().locator('[role="checkbox"]').count()) === 0 && firstAction === "open",
    `${firstAction}`,
  );
  // 明日へ（ホバーの … のメニュー）
  const r1 = rows.first();
  const id1 = await r1.getAttribute("data-id");
  await r1.hover();
  await r1.locator('[data-action="more"]').click();
  await page.getByTestId("context-menu").locator('[data-menu-id="move"]').click();
  await page.waitForTimeout(800);
  t.check(
    "3 turn: “Tomorrow” from the hover ⋯ moves it to the next workday",
    (await page.locator(`[data-kind="turn"][data-id="${id1}"]`).count()) === 0,
  );
  // 対応不要（右クリックメニュー）
  const r2 = rows.first();
  const id2 = await r2.getAttribute("data-id");
  await r2.click({ button: "right" });
  const menu = page.getByTestId("context-menu");
  const menuText = (await menu.count()) > 0 ? await menu.innerText() : "";
  t.check(
    "3 turn: the right-click menu lists the actions with their keys",
    /e\b/.test(menuText) && /Space/.test(menuText),
    menuText.replace(/\n/g, " | "),
  );
  await menu.locator('[data-menu-id="dismiss"]').click();
  await page.waitForTimeout(800);
  t.check(
    "3 turn: “Not needed” from the menu closes it",
    (await page.locator(`[data-kind="turn"][data-id="${id2}"]`).count()) === 0,
  );
  // 完了（右クリックのメニュー）
  const r3 = rows.first();
  const id3 = await r3.getAttribute("data-id");
  await r3.click({ button: "right" });
  await page.getByTestId("context-menu").locator('[data-menu-id="complete"]').click();
  await page.waitForTimeout(800);
  t.check(
    "3 turn: “Complete” from the menu completes it",
    (await page.locator(`[data-kind="turn"][data-id="${id3}"]`).count()) === 0,
  );
  t.check(
    "3 turn: three items handled with the mouse",
    (await visible()).length === n0 - 3,
    `${n0} → ${(await visible()).length} (all ${q0.items.length})`,
  );

  // ---------- 4. 予定を作る ----------
  const p = await slotPoint(page, NEXT, "15:00");
  await page.mouse.click(p.x, p.y);
  const opened = await page
    .getByTestId("prompt-input")
    .waitFor({ timeout: 2000 })
    .then(() => true)
    .catch(() => false);
  t.check("4 event: clicking an empty slot opens the create input", opened);
  if (opened) {
    t.check(
      "4 event: the default is a task, with Task / Event tabs",
      (await page.locator('[data-kind-option="task"][aria-selected="true"]').count()) === 1,
    );
    await page.locator('[data-kind-option="event"]').click();
    await page.getByTestId("prompt-input").fill("Mouse meeting");
    await page.getByTestId("prompt-create").click();
    await page.waitForTimeout(800);
  }
  const ev = (await day(board, NEXT))?.events.find((x) => x.title === "Mouse meeting");
  t.check(
    "4 event: creates an event 15:00–15:30 on that day",
    !!ev && `${hm(ev.start)}–${hm(ev.end)}` === "15:00–15:30",
    ev ? `${hm(ev.start)}–${hm(ev.end)}` : "none",
  );
  const p2 = await slotPoint(page, NEXT, "17:00");
  await page.mouse.click(p2.x, p2.y, { button: "right" });
  const slotMenu = page.getByTestId("context-menu");
  t.check(
    "4 event: right-clicking an empty slot offers “New event here”",
    (await slotMenu.locator('[data-menu-id="newEvent"]').count()) === 1,
  );
  if ((await slotMenu.count()) > 0) {
    await slotMenu.locator('[data-menu-id="newEvent"]').click();
    await page.getByTestId("prompt-input").fill("Mouse meeting 2");
    await page.getByTestId("prompt-create").click();
    await page.waitForTimeout(800);
  }
  const ev2 = (await day(board, NEXT))?.events.find((x) => x.title === "Mouse meeting 2");
  t.check(
    "4 event: the slot menu creates an event at that time",
    !!ev2 && hm(ev2.start) === "17:00",
    ev2 ? hm(ev2.start) : "none",
  );
  // ＋ 新規 → 予定 はデイビューで開く・ボードの新規予定の入力
  await page.getByTestId("new-button").click();
  t.check(
    "4 event: the “+ New” button offers Task and Event",
    (await page.getByTestId("new-task").count()) === 1 &&
      (await page.getByTestId("new-event").count()) === 1,
  );
  await page.getByTestId("new-button").click();

  // ---------- 5. 記録を見る（D-192） ----------
  await page.goto(board.base + "/board");
  await page.waitForSelector(`[data-grid="${TODAY}"]`);
  await page.locator('a[href="/day"]').first().click();
  await page.waitForSelector('[data-testid="day-view"]');
  await page.getByTestId("open-record").click();
  const record = page.getByTestId("record-panel");
  const visibleRecord = await record
    .waitFor({ timeout: 5000 })
    .then(() => record.isVisible())
    .catch(() => false);
  t.check("5 record: the Daily note button opens the record panel on the right", visibleRecord);
  if (visibleRecord) {
    await record
      .locator("text=/Time: You|時間: 自分/")
      .first()
      .waitFor({ timeout: 10000 })
      .catch(() => {});
    const text = await record.innerText();
    t.check(
      "5 record: the panel shows today's figures and sections",
      /Time: You|時間: 自分/.test(text) && /What I did|やったこと|AI/.test(text),
      text.slice(0, 200),
    );
    await page.getByTestId("record-copy").click();
    await page.waitForTimeout(300);
    t.check(
      "5 record: Copy Markdown reports a toast",
      (await page.locator('[role="status"]').count()) > 0,
    );
    await record
      .getByRole("button", { name: /close|閉じる/i })
      .first()
      .click();
    await page.waitForTimeout(200);
    t.check("5 record: × closes the panel", (await record.count()) === 0);
  }

  // ---------- 6. 設定を変える ----------
  await page.goto(board.base + "/board");
  await page.waitForSelector(`[data-grid="${TODAY}"]`);
  await page.locator('a[href="/settings"]').first().click();
  const theme = page.locator('[data-setting="theme"] [role="radio"]');
  await theme.first().waitFor({ timeout: 5000 });
  t.check(
    "6 settings: the top bar hides date navigation outside the board",
    (await page.getByTestId("period").count()) === 0 &&
      (await page.getByTestId("mode-three").count()) === 0,
  );
  await theme.nth(2).click();
  await page.waitForTimeout(800);
  const ui = await board.api<{ theme: string }>("GET", "/settings/ui");
  t.check("6 settings: choosing Dark saves the theme", ui.theme === "dark", ui.theme);

  t.check("no shortcut keys were pressed", keys.length === 0, keys.join(","));
}

export const mouseSuite: Suite = { name: "mouse", args: [], run };
