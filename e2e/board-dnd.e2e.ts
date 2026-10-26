/**
 * 時間軸のドラッグ操作の回帰テスト（M2-18・ux-mvp 7章）。デイビュー（自分レーン）・3日ボード（今日の Plan レーン）・週表示で
 * 空白の範囲選択による作成、タスクのドロップ（Unscheduled・Inbox トレイ）、ブロックの移動・伸縮を、実際のポインタ操作で行い、
 * API の結果（時刻・日付）で確かめる。最後に、時間ブロックをカレンダーに書かないこと（D-093。偽のカレンダーの予定の数が
 * 変わらない）と、同期の後もブロックが外れないことを見る。
 * 見た目の変更（背景・パネル・ホバーの要素）がポインタを奪ったら、ここで落ちる。
 *
 * dev-board の既定のデータ: 今は 2026-10-02（金）13:20 JST。今日に Write article outline 14:15–15:00、
 * Invoice template fix 15:30–15:45、10/5（月）に Research Raycast extension 10:00–10:30。Inbox に Read the OKR doc。
 */
import type { Page } from "playwright";
import type {
  BoardResponse,
  DayTotals,
  TaskView,
  TaskWriteResponse,
  TimeBlockView,
} from "../packages/core/src/api/index.ts";
import { fmtDuration } from "../packages/core/src/format.ts";
import type { Board, Ctx, Suite } from "./harness.ts";

const TODAY = "2026-10-02";
const MON = "2026-10-05";
const TUE = "2026-10-06";
const hm = (ms: number) =>
  new Date(ms + 9 * 3_600_000).toISOString().slice(11, 16).replace(/^0/, "");

interface Placed {
  task: TaskView;
  date: string | null;
  block: TimeBlockView | null;
}

/** 題名でタスクと時間ブロックを探す（10/1〜10/8 の列と Inbox） */
async function find(board: Board, title: string): Promise<Placed | null> {
  const b = await board.api<BoardResponse>("GET", "/board?from=2026-10-01&to=2026-10-08");
  for (const d of b.days) {
    const task = d.tasks.find((t) => t.title.t === "text" && t.title.text === title);
    if (task)
      return {
        task,
        date: d.date,
        block: d.timeBlocks.find((x) => x.taskId === task.id) ?? null,
      };
  }
  const inbox = await board.api<{ tasks: TaskView[] }>("GET", "/inbox");
  const task = inbox.tasks.find((t) => t.title.t === "text" && t.title.text === title);
  return task ? { task, date: null, block: null } : null;
}

/** 時間ブロックの「日付 開始–終了」（無ければ none） */
async function slot(board: Board, title: string): Promise<string> {
  const p = await find(board, title);
  if (!p) return "missing";
  if (!p.block) return `${p.date ?? "inbox"} none`;
  return `${p.date} ${hm(p.block.start)}–${hm(p.block.end)}`;
}

/**
 * 時間軸（data-grid の要素）の上の、その時刻の画面座標。時刻が画面の中ほどに来るよう縦にスクロールしてから測る。
 * xFrac はレーンの幅の中の位置（0〜1）
 */
async function point(
  page: Page,
  date: string,
  hhmm: string,
  { xFrac = 0.5, scroll = true }: { xFrac?: number; scroll?: boolean } = {},
): Promise<{ x: number; y: number; hourPx: number }> {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  const frac = (h * 60 + m) / 1440;
  return page.evaluate(
    ({ date, frac, xFrac, scroll }) => {
      const g = document.querySelector<HTMLElement>(`[data-grid="${date}"]`);
      if (!g) throw new Error(`no grid for ${date}`);
      let s: HTMLElement | null = g.parentElement;
      while (
        s &&
        !(s.scrollHeight > s.clientHeight && /auto|scroll/.test(getComputedStyle(s).overflowY))
      )
        s = s.parentElement;
      if (s && scroll) {
        const r0 = g.getBoundingClientRect();
        const sr = s.getBoundingClientRect();
        s.scrollTop += r0.top + r0.height * frac - (sr.top + sr.height / 2);
      }
      const r = g.getBoundingClientRect();
      return {
        x: r.left + r.width * xFrac,
        y: r.top + r.height * frac,
        hourPx: r.height / 24,
      };
    },
    { date, frac, xFrac, scroll },
  );
}

/**
 * ポインタで押して動かして離す（dnd-kit の開始距離 5px を越えるよう刻んで動かす）。
 * dropGhost: 時間軸へ落とすドラッグ（dnd-kit）は、前の操作の枠が消えてから始め、仮置きの枠が出てから離す。
 * 負荷が高いと（WebKit で他のスイートと並ぶときなど）描画が合成のポインタの動きに追いつかない。待つのは描画だけで、
 * 落とし先を上書きする競合（board/dnd.tsx の put）は待っても直らない（以前は3秒待っても枠が出なかった）
 */
async function drag(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
  during?: () => Promise<void>,
  { dropGhost = false }: { dropGhost?: boolean } = {},
) {
  const ghost = page.locator('[data-testid="drop-ghost"]');
  // 前の操作（範囲選択）の枠が消えてから始める（同じ印の枠を待つので）
  if (dropGhost)
    await ghost
      .first()
      .waitFor({ state: "detached", timeout: 2000 })
      .catch(() => {});
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x, from.y + 8, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await page.waitForTimeout(100);
  // 仮置きの枠が出てから離す（描画が遅いときに待つだけ。枠が出ないまま3秒たてば、そのまま離して落ちる）
  if (dropGhost)
    await ghost
      .first()
      .waitFor({ timeout: 3000 })
      .catch(() => {});
  await during?.();
  await page.mouse.up();
  await page.waitForTimeout(400);
}

/** 時間ブロックの「日付 開始–終了」が ok になるまで待つ（API の書き込みが遅いときのため。最大3秒）。最後の値を返す */
async function slotUntil(board: Board, title: string, ok: (s: string) => boolean): Promise<string> {
  const deadline = Date.now() + 3000;
  for (;;) {
    const s = await slot(board, title);
    if (ok(s) || Date.now() > deadline) return s;
    await Bun.sleep(100);
  }
}

/** 自分レーンの空白を from〜to の時刻で範囲選択し、出た入力欄に題名を入れて ⏎ */
async function rangeCreate(
  t: Ctx,
  label: string,
  date: string,
  from: string,
  to: string,
  title: string,
) {
  const { page } = t;
  const a = await point(page, date, from);
  const off = a.hourPx / 20; // 線の真上を避ける（スナップで丸まる）
  const b = await point(page, date, to, { scroll: false });
  let ghost = 0;
  await drag(page, { x: a.x, y: a.y + off }, { x: b.x, y: b.y + off }, async () => {
    ghost = await page.locator(`[data-range-ghost="${date}"]`).count();
  });
  t.check(`${label}: dragging shows the range`, ghost === 1);
  const input = page.locator("input:focus");
  const shown = await input
    .waitFor({ timeout: 2000 })
    .then(() => true)
    .catch(() => false);
  t.check(`${label}: the title prompt opens`, shown);
  if (!shown) return;
  await input.fill(title);
  await input.press("Enter");
  await page.waitForTimeout(800);
  const s = await slotUntil(t.board, title, (x) => x === `${date} ${from}–${to}`);
  t.check(`${label}: creates a task with a block`, s === `${date} ${from}–${to}`, s);
}

/** 時間軸のブロック（題名で探す）の矩形 */
async function blockBox(page: Page, title: string) {
  const r = await page.locator('[data-drag^="block:"]', { hasText: title }).first().boundingBox();
  if (!r) throw new Error(`no block: ${title}`);
  return r;
}

/**
 * ブロックを掴んで動かす。view（その時刻が画面の中ほどに来るようスクロール）→ 上端の少し下を掴み、
 * toDate の列へ hours 時間ずらして離す
 */
async function moveBlock(
  t: Ctx,
  label: string,
  title: string,
  view: [string, string],
  toDate: string,
  hours: number,
  expected: string,
) {
  const { page } = t;
  const v = await point(page, view[0], view[1]);
  const col = await point(page, toDate, view[1], { scroll: false });
  const r = await blockBox(page, title);
  // 題名のあたりをつかむ（右側はマウスを乗せると ✓ →| ⋯ のボタンになる。D-148）
  const from = { x: r.x + Math.min(30, r.width / 4), y: r.y + 3 };
  await drag(page, from, { x: col.x, y: from.y + hours * v.hourPx }, undefined, {
    dropGhost: true,
  });
  const s = await slotUntil(t.board, title, (x) => x === expected);
  t.check(label, s === expected, s);
}

/** 下端の伸縮のハンドルを hours 時間ぶん下へ */
async function resizeBlock(
  t: Ctx,
  label: string,
  title: string,
  view: [string, string],
  hours: number,
  expected: string,
) {
  const { page } = t;
  const v = await point(page, view[0], view[1]);
  const h = await page
    .locator('[data-drag^="block:"]', { hasText: title })
    .first()
    .getByTestId("resize-handle")
    .boundingBox();
  if (!h) {
    t.check(label, false, "no resize handle");
    return;
  }
  // ハンドルの下端（= ブロックの終わり）の少し上を掴む
  const from = { x: h.x + h.width / 2, y: h.y + h.height - 1 };
  await drag(page, from, { x: from.x, y: from.y + hours * v.hourPx });
  const s = await slotUntil(t.board, title, (x) => x === expected);
  t.check(label, s === expected, s);
}

/** カード（Unscheduled・Inbox トレイ）を時間軸の date の hhmm へ落とす */
async function dropCard(
  t: Ctx,
  label: string,
  card: ReturnType<Page["locator"]>,
  title: string,
  date: string,
  hhmm: string,
  expected: (s: string) => boolean,
) {
  const { page } = t;
  const to = await point(page, date, hhmm);
  const r = await card.boundingBox();
  if (!r) {
    t.check(label, false, "card is not listed");
    return;
  }
  await drag(page, { x: r.x + 20, y: r.y + r.height / 2 }, { x: to.x, y: to.y + 2 }, undefined, {
    dropGhost: true,
  });
  const s = await slotUntil(t.board, title, expected);
  t.check(label, expected(s), s);
}

/** 今日の集計（API の値） */
async function todayTotals(board: Board): Promise<DayTotals> {
  const b = await board.api<BoardResponse>("GET", `/board?from=${TODAY}&to=${TODAY}`);
  const d = b.days.find((x) => x.date === TODAY);
  if (!d) throw new Error("no today column");
  return d.totals;
}

/**
 * 3日ボードの今日の列の見出し（ux-mvp 4.4）: 大きな数字は「空き」、下の小さな行に残り。警告（三角・琥珀）は
 * 計画 − 空き > 0 のときだけで、ツールチップの時間はその差。小さな行から「空き」を省いても判定は本物の空きで行う
 */
async function todayFigure(t: Ctx) {
  const { page, board } = t;
  await page.goto(board.url);
  await page.getByRole("button", { name: "3 days", exact: true }).first().click();
  const fig = page.getByTestId("today-figure");
  await fig.waitFor({ timeout: 5000 });
  const planned = fig.locator('[data-totals="totals.planned"]');
  await planned.waitFor({ timeout: 3000 }).catch(() => {});
  const a = await todayTotals(board);
  t.check(
    "today figure: the fixture plans less than free",
    a.plannedMs > 0 && a.plannedMs < a.freeMs,
    `planned ${a.plannedMs} / free ${a.freeMs}`,
  );
  t.check(
    "today figure: the small line shows planned but not free",
    (await planned.count()) === 1 &&
      (await fig.locator('[data-totals="totals.free"]').count()) === 0,
  );
  t.check(
    "today figure: no over warning when planned < free",
    (await fig.getByTestId("totals-over").count()) === 0,
  );
  // 空きを 1h 超える見積の未定のタスクを足す（未定は空きを減らさない）
  const extra = Math.ceil((a.freeMs - a.plannedMs) / 60_000) + 60;
  const created = await board.api<TaskWriteResponse>("POST", "/tasks", {
    title: "E2E over free",
    date: TODAY,
    estimateMin: extra,
  });
  const over = fig.getByTestId("totals-over");
  const shown = await over
    .waitFor({ timeout: 3000 })
    .then(() => true)
    .catch(() => false);
  const b = await todayTotals(board);
  t.check(
    "today figure: over warning when planned > free",
    shown && b.plannedMs > b.freeMs,
    `planned ${b.plannedMs} / free ${b.freeMs}`,
  );
  const expected = fmtDuration(b.plannedMs - b.freeMs);
  const label = (await planned.getAttribute("aria-label")) ?? "";
  t.check(
    "today figure: the tooltip says planned − free",
    label.includes(`Over free time by ${expected}.`),
    `${expected} / ${label}`,
  );
  // 後のドラッグの確認に残さない
  if (created.task) await board.api("DELETE", `/tasks/${created.task.id}`);
  await over.waitFor({ state: "detached", timeout: 3000 }).catch(() => {});
}

/** 偽のカレンダーの予定の数（カレンダーごと） */
async function calendarEvents(board: Board): Promise<string> {
  await board.api("POST", "/calendar/sync");
  const r = await board.api<{ calendars: { name: string; events: number }[] }>("GET", "/calendars");
  return r.calendars.map((c) => `${c.name}:${c.events}`).join(",");
}

async function run(t: Ctx) {
  const { page, board } = t;
  const eventsBefore = await calendarEvents(board);
  await todayFigure(t);
  // Unscheduled のタスク（デイビューの左パネルから時間軸へ落とす）
  await board.api("POST", "/tasks", { title: "E2E unscheduled", date: TODAY, estimateMin: 30 });

  // ---------- デイビュー（自分レーン） ----------
  await page.goto(board.url.replace(/next=[^&]*/, "next=%2Fday"));
  await page.waitForSelector(`[data-grid="${TODAY}"]`);
  await page.waitForTimeout(500);
  await rangeCreate(t, "day view range", TODAY, "16:00", "17:00", "E2E day range");
  await dropCard(
    t,
    "day view drop: unscheduled task → 18:00",
    page.locator('[data-drag^="task:"]', { hasText: "E2E unscheduled" }).first(),
    "E2E unscheduled",
    TODAY,
    "18:00",
    (s) => s === `${TODAY} 18:00–18:30`,
  );
  await moveBlock(
    t,
    "day view move: block 15:30 → 18:30",
    "Invoice template fix",
    [TODAY, "17:00"],
    TODAY,
    3,
    `${TODAY} 18:30–18:45`,
  );
  await resizeBlock(
    t,
    "day view resize: end 15:00 → 15:30",
    "Write article outline",
    [TODAY, "15:00"],
    0.5,
    `${TODAY} 14:15–15:30`,
  );

  // ---------- 3日ボード（今日の Plan レーン） ----------
  await page.getByRole("button", { name: "3 days", exact: true }).first().click();
  await page.waitForSelector(`[data-grid="${TODAY}"][data-lane="plan"]`);
  await page.waitForTimeout(400);
  await rangeCreate(t, "3-day range", TODAY, "20:00", "21:00", "E2E 3day range");
  {
    const toggle = page.getByTitle("Show Inbox");
    if ((await toggle.count()) > 0) await toggle.first().click();
    const card = page
      .getByTestId("inbox-tray")
      .locator('[data-drag^="task:"]', { hasText: "Read the OKR doc" })
      .first();
    await card.waitFor({ timeout: 3000 });
    await dropCard(
      t,
      "3-day drop: inbox task → today 21:30",
      card,
      "Read the OKR doc",
      TODAY,
      "21:30",
      (s) => s.startsWith(`${TODAY} 21:30–`),
    );
  }
  await moveBlock(
    t,
    "3-day move: block 20:00 → 22:00",
    "E2E 3day range",
    [TODAY, "21:00"],
    TODAY,
    2,
    `${TODAY} 22:00–23:00`,
  );
  await resizeBlock(
    t,
    "3-day resize: end 23:00 → 23:30",
    "E2E 3day range",
    [TODAY, "22:00"],
    0.5,
    `${TODAY} 22:00–23:30`,
  );

  // ---------- 週表示 ----------
  await page.getByRole("button", { name: "Week", exact: true }).first().click();
  await page.waitForSelector(`[data-grid="${TUE}"]`);
  await page.waitForTimeout(400);
  await rangeCreate(t, "week range", MON, "11:00", "12:00", "E2E week range");
  await moveBlock(
    t,
    "week move: block to the next day 13:00",
    "Research Raycast extension",
    [MON, "11:30"],
    TUE,
    3,
    `${TUE} 13:00–13:30`,
  );
  await resizeBlock(
    t,
    "week resize: end 12:00 → 13:00",
    "E2E week range",
    [MON, "12:00"],
    1,
    `${MON} 11:00–13:00`,
  );

  // ---------- 書き戻しの後の同期でブロックが外れない ----------
  const titles = [
    "E2E day range",
    "E2E unscheduled",
    "Invoice template fix",
    "Write article outline",
    "E2E 3day range",
    "Read the OKR doc",
    "E2E week range",
    "Research Raycast extension",
  ];
  const before = await Promise.all(titles.map((x) => slot(board, x)));
  await page.waitForTimeout(1500);
  const eventsAfter = await calendarEvents(board);
  t.check(
    "time blocks are not written to the calendar (D-093)",
    eventsAfter === eventsBefore,
    `${eventsBefore} → ${eventsAfter}`,
  );
  for (let i = 0; i < 2; i++) {
    await board.api("POST", "/calendar/sync");
    await page.waitForTimeout(300);
  }
  const after = await Promise.all(titles.map((x) => slot(board, x)));
  const lost = titles.flatMap((x, i) =>
    after[i] === before[i] ? [] : [`${x}: ${before[i]} → ${after[i]}`],
  );
  t.check("blocks stay after syncing", lost.length === 0, lost.join(", "));
}

export const boardDnd: Suite = { name: "board-dnd", args: ["--lang", "en"], run };
