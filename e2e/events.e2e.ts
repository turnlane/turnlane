/**
 * 予定の作成・移動・伸縮・削除と、タスク / 予定の作り分け（D-093。ux-mvp 7章）の回帰テスト。偽のカレンダー（dev-board の
 * Work = Calendar.app のデフォルト）に対して、実際のポインタとキーの操作で行い、API の結果（時刻・題名）で確かめる。
 * - デイビュー: 予定のレーンの範囲選択 → 予定、ドラッグで移動、下端で伸縮、パネルで題名・削除。参加者のいる会議はつかめない
 * - ⌘Z で移動・伸縮・題名を戻す。外部で変わっていたら戻さない。削除は確認（Esc / ⏎）してから（D-096）
 * - 3日ボード: 範囲選択の入力欄で Tab → 予定（既定はタスク）、⇧C の新規予定（入力の時刻）
 *
 * dev-board の既定のデータ: 今は 2026-10-02（金）13:20 JST。Work に Weekly sync 10:00–10:45・Design review 14:00–15:00（参加者あり）。
 */
import type { Page } from "playwright";
import type { BoardResponse, CalendarEventView } from "../packages/core/src/api/index.ts";
import type { Board, Ctx, Suite } from "./harness.ts";

const TODAY = "2026-10-02";
const hm = (ms: number) =>
  new Date(ms + 9 * 3_600_000).toISOString().slice(11, 16).replace(/^0/, "");

async function events(board: Board): Promise<CalendarEventView[]> {
  const b = await board.api<BoardResponse>("GET", `/board?from=${TODAY}&to=${TODAY}`);
  return b.days.flatMap((d) => d.events);
}

/** 題名の予定の「開始–終了」（無ければ none） */
async function slot(board: Board, title: string): Promise<string> {
  const e = (await events(board)).find((x) => x.title === title);
  return e ? `${hm(e.start)}–${hm(e.end)}` : "none";
}

async function taskTitles(board: Board): Promise<string[]> {
  const b = await board.api<BoardResponse>("GET", `/board?from=${TODAY}&to=${TODAY}`);
  return b.days.flatMap((d) => d.tasks.map((x) => (x.title.t === "text" ? x.title.text : "")));
}

/**
 * 時間軸のその時刻の画面座標。lane は x を取る要素（自分レーン = data-grid、予定のレーン = data-evgrid）。
 * 時刻が画面の中ほどに来るよう縦にスクロールしてから測る
 */
async function point(
  page: Page,
  hhmm: string,
  { lane = "grid", scroll = true }: { lane?: "grid" | "evgrid"; scroll?: boolean } = {},
): Promise<{ x: number; y: number; hourPx: number }> {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  const frac = (h * 60 + m) / 1440;
  return page.evaluate(
    ({ date, frac, lane, scroll }) => {
      const g = document.querySelector<HTMLElement>(`[data-grid="${date}"]`);
      const l = document.querySelector<HTMLElement>(`[data-${lane}="${date}"]`);
      if (!g || !l) throw new Error(`no ${lane} for ${date}`);
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
      const lr = l.getBoundingClientRect();
      return { x: lr.left + lr.width * 0.5, y: r.top + r.height * frac, hourPx: r.height / 24 };
    },
    { date: TODAY, frac, lane, scroll },
  );
}

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x, from.y + 8, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await page.waitForTimeout(100);
  await page.mouse.up();
  await page.waitForTimeout(500);
}

/** 空白を from〜to で範囲選択して入力欄を開く（開いたら true） */
async function select(page: Page, lane: "grid" | "evgrid", from: string, to: string) {
  const a = await point(page, from, { lane });
  const b = await point(page, to, { lane, scroll: false });
  const off = a.hourPx / 20;
  await drag(page, { x: a.x, y: a.y + off }, { x: b.x, y: b.y + off });
  return page
    .getByTestId("prompt-input")
    .waitFor({ timeout: 2000 })
    .then(() => true)
    .catch(() => false);
}

async function eventBox(page: Page, board: Board, title: string) {
  const e = (await events(board)).find((x) => x.title === title);
  if (!e) return null;
  return page.locator(`[data-drag="event:${e.id}"]`).first().boundingBox();
}

async function run(t: Ctx) {
  const { page, board } = t;

  // ---------- デイビュー: 予定のレーン ----------
  await page.goto(board.url.replace(/next=[^&]*/, "next=%2Fday"));
  await page.waitForSelector(`[data-evgrid="${TODAY}"]`);
  await page.waitForTimeout(500);
  const opened = await select(page, "evgrid", "17:00", "18:00");
  t.check("day view: dragging on the events lane opens the input", opened);
  if (opened) {
    const kind = await page.getByTestId("prompt-kind").innerText();
    // 予定のレーンの空き枠は「予定」を選んだ作成のポップオーバー（タスクにも切り替えられる。確定デザインのデイビュー）
    const eventTab = await page.locator('[data-kind-option="event"][aria-selected="true"]').count();
    t.check(
      "day view: the input opens on the Event tab (Task / Event switch)",
      /Event/.test(kind) && eventTab > 0,
      kind,
    );
    const colored = (await page.getByTestId("prompt-input").getAttribute("data-event")) !== null;
    t.check("day view: the event input uses the calendar color", colored);
    await page.getByTestId("prompt-input").fill("E2E event");
    await page.getByTestId("prompt-input").press("Enter");
    await page.waitForTimeout(800);
  }
  t.check(
    "day view: creates an event 17:00–18:00",
    (await slot(board, "E2E event")) === "17:00–18:00",
  );
  t.check(
    "day view: creating an event does not create a task",
    !(await taskTitles(board)).includes("E2E event"),
  );
  const created = (await events(board)).find((x) => x.title === "E2E event");
  const detail = created
    ? await board.api<{ createdByTurnlane: boolean; calendarName: string; editable: boolean }>(
        "GET",
        `/calendar-events/${created.id}`,
      )
    : null;
  t.check(
    "day view: the event goes to Calendar.app's default calendar (Work), marked as Turnlane's",
    detail?.calendarName === "Work" && detail.createdByTurnlane && detail.editable,
    JSON.stringify(detail),
  );

  // 移動（1時間後へ）→ ⌘Z で戻す → もう一度動かす（D-096）
  const v = await point(page, "17:30", { lane: "evgrid" });
  const moveDown = async () => {
    const box = await eventBox(page, board, "E2E event");
    if (!box) return;
    const from = { x: box.x + box.width / 2, y: box.y + 4 };
    await drag(page, from, { x: from.x, y: from.y + v.hourPx });
  };
  await moveDown();
  t.check(
    "day view: dragging the event moves it to 18:00–19:00",
    (await slot(board, "E2E event")) === "18:00–19:00",
    await slot(board, "E2E event"),
  );
  const undo = async () => {
    await page.keyboard.press("Meta+z");
    await page.waitForTimeout(800);
  };
  await undo();
  t.check(
    "⌘Z moves the event back to 17:00–18:00",
    (await slot(board, "E2E event")) === "17:00–18:00",
    await slot(board, "E2E event"),
  );
  await moveDown();

  // 伸縮（30分のばす）→ ⌘Z
  const resize = async () => {
    await point(page, "18:30", { lane: "evgrid" });
    const handle = created
      ? await page
          .locator(`[data-drag="event:${created.id}"]`)
          .getByTestId("event-resize-handle")
          .boundingBox()
      : null;
    if (!handle) return;
    const from = { x: handle.x + handle.width / 2, y: handle.y + handle.height - 1 };
    await drag(page, from, { x: from.x, y: from.y + v.hourPx / 2 });
  };
  await resize();
  t.check(
    "day view: the bottom edge resizes it to 18:00–19:30",
    (await slot(board, "E2E event")) === "18:00–19:30",
    await slot(board, "E2E event"),
  );
  await undo();
  t.check(
    "⌘Z undoes the resize (18:00–19:00)",
    (await slot(board, "E2E event")) === "18:00–19:00",
    await slot(board, "E2E event"),
  );
  await resize();

  // 参加者のいる会議はつかめない
  const meeting = (await events(board)).find((x) => x.title === "Design review");
  t.check(
    "a meeting with attendees is read-only (cannot be dragged)",
    meeting?.editable === false &&
      (await page.locator(`[data-drag="event:${meeting.id}"]`).count()) === 0,
  );

  // パネルで題名を変える → ⌘Z で戻す
  const openPanel = async (title: string) => {
    const box = await eventBox(page, board, title);
    if (box) await page.mouse.click(box.x + box.width / 2, box.y + 6);
    // 枠（event-panel）は詳細の取得より先に出る。中身（event-fields）が出るまで待つ（負荷の高い全体実行では取得が遅い）
    await page
      .getByTestId("event-panel")
      .getByTestId("event-fields")
      .waitFor({ timeout: 5000 })
      .catch(() => {});
  };
  await openPanel("E2E event");
  const panel = page.getByTestId("event-panel");
  const title = panel.locator("textarea").first();
  if ((await title.count()) > 0) {
    await title.fill("E2E event renamed");
    await title.press("Enter");
    await page.waitForTimeout(800);
  }
  t.check("panel: renames the event", (await slot(board, "E2E event renamed")) === "18:00–19:30");
  await page.keyboard.press("Escape");
  await undo();
  t.check(
    "⌘Z restores the title",
    (await slot(board, "E2E event")) === "18:00–19:30" &&
      (await slot(board, "E2E event renamed")) === "none",
  );

  // 動かした後に外部で変わったら、⌘Z は戻さない（API で別の時刻へ。Calendar.app での変更の代わり）
  await moveDown();
  const now = (await events(board)).find((x) => x.title === "E2E event");
  if (created && now) {
    await board.api("PATCH", `/calendar-events/${created.id}`, {
      start: now.start + 3_600_000,
      end: now.end + 3_600_000,
    });
    await page.waitForTimeout(500);
  }
  const elsewhere = await slot(board, "E2E event");
  await undo();
  t.check(
    "⌘Z does not undo when the event changed elsewhere",
    elsewhere === "20:00–21:30" && (await slot(board, "E2E event")) === "20:00–21:30",
    `${elsewhere} → ${await slot(board, "E2E event")}`,
  );
  t.check(
    "⌘Z tells why it didn't undo",
    (await page.getByText("changed in your calendar").count()) > 0,
  );

  // 削除は確認してから（Esc で取り消し、⏎ で削除）
  await openPanel("E2E event");
  // 削除はパネルの「⋯」のメニュー（D-138。右クリックと同じ並び）
  const del = async () => {
    const more = page.getByTestId("event-more");
    if ((await more.count()) === 0) return;
    await more.click();
    await page.locator('[data-menu-id="eventDelete"]').click({ timeout: 2000 });
  };
  await del();
  const dialog = page.getByTestId("confirm-dialog");
  t.check("panel: delete asks for confirmation", await dialog.isVisible().catch(() => false));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
  t.check(
    "panel: Esc cancels the delete",
    (await dialog.count()) === 0 && (await slot(board, "E2E event")) === "20:00–21:30",
  );
  await del();
  await dialog.waitFor({ timeout: 2000 }).catch(() => {});
  await page.keyboard.press("Enter");
  await page.waitForTimeout(800);
  t.check("panel: ⏎ deletes the event", (await slot(board, "E2E event")) === "none");

  // ---------- 3日ボード: タスク / 予定 の切り替え ----------
  await page.goto(board.url.replace(/next=[^&]*/, "next=%2Fboard"));
  await page.waitForSelector(`[data-grid="${TODAY}"]`);
  await page.waitForTimeout(500);
  if (await select(page, "grid", "20:00", "21:00")) {
    const taskFirst = await page.locator('[data-kind-option="task"][aria-selected="true"]').count();
    t.check("3-day: the input starts as a task", taskFirst === 1);
    await page.getByTestId("prompt-input").press("Tab");
    const eventNow = await page.locator('[data-kind-option="event"][aria-selected="true"]').count();
    const colored = (await page.getByTestId("prompt-input").getAttribute("data-event")) !== null;
    t.check("3-day: Tab switches to an event (calendar color)", eventNow === 1 && colored);
    await page.getByTestId("prompt-input").fill("E2E board event");
    await page.getByTestId("prompt-input").press("Enter");
    await page.waitForTimeout(800);
  } else t.check("3-day: dragging opens the input", false);
  t.check(
    "3-day: creates an event 20:00–21:00",
    (await slot(board, "E2E board event")) === "20:00–21:00",
  );
  t.check("3-day: the event is not a task", !(await taskTitles(board)).includes("E2E board event"));
  if (await select(page, "grid", "21:30", "22:00")) {
    await page.getByTestId("prompt-input").fill("E2E board task");
    await page.getByTestId("prompt-input").press("Enter");
    await page.waitForTimeout(800);
  }
  t.check(
    "3-day: without Tab it creates a task (not an event)",
    (await taskTitles(board)).includes("E2E board task") &&
      (await slot(board, "E2E board task")) === "none",
  );

  // ⇧C: 新しい予定（入力の時刻）
  await page.mouse.click(5, 5);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Shift+C");
  const keyed = await page
    .getByTestId("prompt-input")
    .waitFor({ timeout: 2000 })
    .then(() => true)
    .catch(() => false);
  t.check("⇧C opens the new event input", keyed);
  if (keyed) {
    await page.getByTestId("prompt-input").fill("E2E keyed 16:00 30m");
    await page.getByTestId("prompt-input").press("Enter");
    await page.waitForTimeout(800);
  }
  t.check(
    "⇧C: creates the event at the typed time",
    (await slot(board, "E2E keyed")) === "16:00–16:30",
    await slot(board, "E2E keyed"),
  );

  // ---------- 予定の書き先の選択（書き込めるカレンダーが Work と Personal の2つ） ----------
  type Detail = { calendarName: string; calendarId: string; createdByTurnlane: boolean };
  const detailOf = async (title: string) => {
    const e = (await events(board)).find((x) => x.title === title);
    return e ? board.api<Detail>("GET", `/calendar-events/${e.id}`) : null;
  };
  await page.mouse.click(5, 5);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Shift+C");
  await page.getByTestId("prompt-input").waitFor({ timeout: 2000 });
  const pickerBtn = page.getByTestId("event-calendar-picker");
  t.check(
    "picker: the new event input shows the calendar choice, starting at the default (Work)",
    (await pickerBtn.count()) === 1 && (await pickerBtn.innerText()).includes("Work"),
  );
  t.check(
    "picker: the focus stays in the title input",
    await page.getByTestId("prompt-input").evaluate((el) => el === document.activeElement),
  );
  await page.getByTestId("prompt-input").fill("E2E picked 17:30 30m");
  // キーボードだけで: ⇧⇥ で選択へ（⇥ はタスク / 予定の切り替え）、⏎ で開き、↓ で Personal、⏎ で選ぶ（入力欄へ戻る）→ ⏎ で作る
  await page.keyboard.press("Shift+Tab");
  const onPicker = await pickerBtn.evaluate((el) => el === document.activeElement);
  t.check("picker: ⇧Tab moves to the calendar choice", onPicker);
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(200);
  t.check(
    "picker: choosing Personal shows it and returns to the input",
    (await pickerBtn.innerText()).includes("Personal") &&
      (await page.getByTestId("prompt-input").evaluate((el) => el === document.activeElement)),
  );
  await page.keyboard.press("Enter");
  await page.waitForTimeout(800);
  const picked = await detailOf("E2E picked");
  t.check(
    "picker: the event goes to the chosen calendar (Personal) at the typed time",
    picked?.calendarName === "Personal" && (await slot(board, "E2E picked")) === "17:30–18:00",
    JSON.stringify(picked),
  );
  const status = await board.api<{ events: { calendar: { name: string } | null } }>(
    "GET",
    "/calendar/status",
  );
  t.check(
    "picker: the default calendar in settings is unchanged (Work)",
    status.events.calendar?.name === "Work",
  );
  // 次に開いたときは設定の書き先に戻る。タスクのときは選択を出さない
  await page.keyboard.press("Shift+C");
  await page.getByTestId("prompt-input").waitFor({ timeout: 2000 });
  t.check(
    "picker: the next new event starts at the default again",
    (await pickerBtn.innerText()).includes("Work"),
  );
  await page.keyboard.press("Escape");
  if (await select(page, "grid", "22:30", "23:00")) {
    const onTask = await pickerBtn.count();
    await page.getByTestId("prompt-input").press("Tab");
    const onEvent = await pickerBtn.count();
    t.check(
      "picker: shown only for an event (not a task) in the Task / Event input",
      onTask === 0 && onEvent === 1,
    );
    await page.keyboard.press("Escape");
  }

  // 詳細パネルで別のカレンダーへ移す（Turnlane で作った予定）
  await page.goto(board.url.replace(/next=[^&]*/, "next=%2Fday"));
  await page.waitForSelector(`[data-evgrid="${TODAY}"]`);
  await page.waitForTimeout(500);
  await point(page, "17:45", { lane: "evgrid" });
  await openPanel("E2E picked");
  // 移す選択はカレンダーの一覧が届いてから button になる（それまでは文字だけ）。button になるまで待つ
  const calBtn = page.getByTestId("event-panel").locator('button[data-testid="event-calendar"]');
  const ready = await calBtn
    .waitFor({ timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  let wrote = "no calendar button";
  if (ready) {
    await calBtn.click();
    const cals = await board.api<{ calendars: { id: string; name: string }[] }>(
      "GET",
      "/calendars",
    );
    const work = cals.calendars.find((c) => c.name === "Work")?.id;
    const write = page.waitForResponse(
      (r) => r.url().includes("/calendar-events/") && r.request().method() !== "GET",
      { timeout: 5000 },
    );
    await page.locator(`[data-menu-id="cal-${work}"]`).click({ timeout: 2000 });
    wrote = await write.then(
      (r) => `${r.request().method()} ${r.status()}`,
      () => "no write",
    );
  }
  // 書き込みの応答の時点で予定の行は移っている（events.ts の update が返す前に保存する）
  const back = await detailOf("E2E picked");
  t.check(
    "panel: moves the event to another calendar (Work)",
    back?.calendarName === "Work" && back.createdByTurnlane,
    `${wrote} ${JSON.stringify(back)}`,
  );
}

export const eventsSuite: Suite = { name: "events", args: ["--lang", "en"], run };
