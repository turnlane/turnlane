/**
 * ホバーのボタンと `…`（右クリック）のメニューの全項目が、部品を使う全ての場所で実際に動くこと（2026-10-08 の不具合:
 * 3日ボードの左の Inbox のトレーのカードのボタンが何もしなかった）の回帰テスト。
 *
 * 場所: Inbox のトレー・Inbox の画面・3日ボードの未定と時間軸のカード・デイビューの未定のカード・自分の番の行（3日ボードの帯・
 * デイビュー・自分の番の画面・メニューバー）・3日ボードの AI の線（右クリック）・AI の詳細パネルの ⋯・3日ボードとデイビューの
 * 予定（右クリック。カレンダーの色 ▸ のパレットで色を選び、カレンダーの色に戻す。D-125。これからの予定の「この予定の間は
 * 集中する」を設定して ✓ で取り消す。D-130）・予定の詳細パネルの「この予定の間は集中する」・メニューバーの「集中する ▸」と
 * 「終了」（D-130）。
 * ボタンとメニューの項目は画面から読み、項目ごとに新しい対象で押して結果を確かめる（メニューに項目が増えたら、ここに確かめ方が
 * 無いので落ちる）。1項目につき1つの道（ボタンがあればボタン、無ければメニュー）で押す「通し」に絞り、項目の一覧・並び・
 * ○ の有無などの部品の規則は単体（apps/web/test の mouse-ops・hover-check・task-panel）で見る（D-196）。
 *
 * - タスクは API で作り（経由 CLI。題名 `Turnlane: …`）、結果は API で見る
 * - 自分の番・AI の書き込み（follow-ups・open・work-items）と AI に頼む依頼（ai/launches）は数に限りがあるか、外部の開き先
 *   （ターミナル・claude）を起動しうるので、ページの中で要求を記録して偽の応答を返す（デーモンには届かない）。結果は送った
 *   要求で見て、毎回ページを読み直す
 *
 * dev-board の既定のデータ: 今は 2026-10-02（金）13:20 JST。3日ボードは 10/1・10/2・10/5
 */
import type { Locator, Page } from "playwright";
import type {
  BoardResponse,
  QueueResponse,
  TaskDetailResponse,
  TaskView,
} from "../packages/core/src/api/index.ts";
import type { Board, Ctx, Suite } from "./harness.ts";

const TODAY = "2026-10-02";
const SAT = "2026-10-03";
const SUN = "2026-10-04";
const MON = "2026-10-05";
const TUE = "2026-10-06";
/** 日付の入力に打つ値（今日から4日後 = 10/6） */
const MOVE_INPUT = "+4";
const nextDay: Record<string, string> = { [TODAY]: SAT, [SAT]: SUN, [MON]: TUE };
const at = (date: string, hhmm: string) => Date.parse(`${date}T${hhmm}:00+09:00`);

/**
 * ページの中で止めて記録する書き込み（自分の番・AI の操作と外部の開き先、AI に頼む（端末・claude を起動しうる。D-107））
 */
const MOCK =
  /^\/api\/(follow-ups\/.+|open|work-items\/[^/]+(\/reply-task|\/back-to-turn)?|calendar-events\/[^/]+\/open|ai\/launches(\/.*)?)$/;

interface Sent {
  method: string;
  path: string;
  body: string;
}

const textOf = (x: TaskView) => (x.title.t === "text" ? x.title.text : "");

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

/** 読み込み中の API の要求の数（SSE を除く）。ページごとに数える */
const inflight = new WeakMap<Page, number>();

function trackRequests(page: Page) {
  inflight.set(page, 0);
  const isApi = (u: string) => {
    const p = new URL(u).pathname;
    return p.startsWith("/api/") && p !== "/api/events";
  };
  const add = (d: number) => (u: string) => {
    if (isApi(u)) inflight.set(page, Math.max(0, (inflight.get(page) ?? 0) + d));
  };
  page.on("request", (r) => add(1)(r.url()));
  page.on("requestfinished", (r) => add(-1)(r.url()));
  page.on("requestfailed", (r) => add(-1)(r.url()));
}

/**
 * 読み込み中の要求が終わってから移る（WebKit は移動で取り消した fetch を pageerror に出す）
 */
async function go(page: Page, url: string) {
  // 偽の応答の後の取り直し（optimistic の invalidate）が始まるのを待ってから、終わるのを待つ
  await settle(page, 300);
  await until(
    () => Promise.resolve(inflight.get(page) ?? 0),
    (n) => n === 0,
    3000,
  );
  await page.goto(url);
}

async function toolbarIds(item: Locator): Promise<string[]> {
  await item.hover();
  return item
    .locator('[data-testid="hover-toolbar"] [data-action]')
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-action") ?? ""));
}

/** `…` のボタン（無ければ右クリック）でメニューを開く */
async function openMenu(page: Page, item: Locator, rightClick: boolean): Promise<Locator> {
  if (rightClick) {
    // 位置で押す（locator の右クリックは要素を見える位置へスクロールし、メニューはスクロールで閉じる）。
    // AI の線は重なるので、ラベルの左上（状態アイコン）を押す
    await item.scrollIntoViewIfNeeded();
    await settle(page, 150);
    const label = item.locator('[data-label="ai"]');
    const b = await ((await label.count()) > 0 ? label : item).boundingBox();
    if (!b) throw new Error("no box");
    await page.mouse.click(b.x + Math.min(8, b.width / 2), b.y + Math.min(8, b.height / 2), {
      button: "right",
    });
  } else {
    await item.hover();
    await item.locator('[data-testid="hover-toolbar"] [data-action="more"]').click();
  }
  const menu = page.getByTestId("context-menu");
  await menu.waitFor({ timeout: 2000 });
  return menu;
}

async function menuIds(menu: Locator): Promise<string[]> {
  return menu
    .locator("[data-menu-id]")
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-menu-id") ?? ""));
}

/** 開いているメニュー・ポップオーバー・パネルを閉じる（画面の選択も外す） */
async function closeAll(page: Page) {
  for (let i = 0; i < 3; i++) await page.keyboard.press("Escape");
  await settle(page, 150);
}

async function panelOpen(page: Page, id: string): Promise<boolean> {
  return page
    .getByTestId(id)
    .waitFor({ timeout: 2000 })
    .then(() => true)
    .catch(() => false);
}

// ---------- タスク ----------

interface TaskPlace {
  name: string;
  /** 画面を開く（読み直しのあと） */
  open: (page: Page) => Promise<void>;
  /** 作るタスクの日付（null = Inbox） */
  date: string | null;
  /** 時間軸に置く（その日の 16:00–17:00） */
  placed?: boolean;
  /** 画面の中のカード */
  card: (page: Page, id: string) => Locator;
  /** 幅の狭いカード（ホバーのボタンを隠す。@max-[180px]）: 右クリックのメニューだけを確かめる */
  rightClick?: boolean;
}

async function detail(board: Board, id: string): Promise<TaskDetailResponse | null> {
  return board.api<TaskDetailResponse>("GET", `/tasks/${id}`).catch(() => null);
}

let seq = 0;
async function makeTask(board: Board, p: TaskPlace): Promise<string> {
  seq += 1;
  const r = await board.api<{ task: TaskView }>("POST", "/tasks", {
    title: `Turnlane: action check ${seq}`,
    date: p.date,
    source: "cli",
  });
  if (p.placed)
    await board.api("POST", "/time-blocks", {
      taskId: r.task.id,
      startAt: at(p.date ?? TODAY, "16:00"),
      endAt: at(p.date ?? TODAY, "17:00"),
    });
  return r.task.id;
}

/** 押したあとの続き（候補・入力）と、結果の確かめ。true か失敗の説明を返す */
async function taskOutcome(
  page: Page,
  board: Board,
  p: TaskPlace,
  id: string,
  action: string,
  before: TaskDetailResponse,
): Promise<true | string> {
  const get = () => detail(board, id);
  const want = async (ok: (d: TaskDetailResponse | null) => boolean, what: string) => {
    const d = await until(get, ok);
    return ok(d)
      ? (true as const)
      : `${what}: ${d ? `${d.task.scheduledDate} ${d.task.status} ${textOf(d.task)} blocks ${d.blocks.length}` : "gone"}`;
  };
  switch (action) {
    case "today":
      return want((d) => d?.task.scheduledDate === TODAY, "not moved to today");
    case "later": {
      const to = nextDay[p.date ?? TODAY] as string;
      return want((d) => d?.task.scheduledDate === to, `not moved to ${to}`);
    }
    case "complete":
      return want((d) => d?.task.status === "done", "not completed");
    case "delete":
      return want((d) => d === null, "not deleted");
    case "unblock":
      return want((d) => d?.blocks.length === 0, "block not removed");
    case "detail":
      return (await panelOpen(page, "task-panel")) ? true : "no task panel";
    case "move": {
      const input = page.getByTestId("prompt-input");
      if (
        !(await input.waitFor({ timeout: 2000 }).then(
          () => true,
          () => false,
        ))
      )
        return "no date input";
      await input.fill(MOVE_INPUT);
      await input.press("Enter");
      return want((d) => d?.task.scheduledDate === TUE, "not moved by the date input");
    }
    case "rename": {
      const input = page.getByTestId("prompt-input");
      if (
        !(await input.waitFor({ timeout: 2000 }).then(
          () => true,
          () => false,
        ))
      )
        return "no title input";
      const v = `Renamed ${id.slice(-6)}`;
      await input.fill(v);
      await input.press("Enter");
      return want((d) => !!d && textOf(d.task) === v, "not renamed");
    }
    case "place": {
      const row = page.locator('[data-row-index="0"]');
      if (
        !(await row.waitFor({ timeout: 3000 }).then(
          () => true,
          () => false,
        ))
      )
        return "no free slots";
      await row.click();
      const was = JSON.stringify(before.blocks.map((b) => [b.start, b.end]));
      return want(
        (d) =>
          !!d &&
          d.blocks.length > 0 &&
          JSON.stringify(d.blocks.map((b) => [b.start, b.end])) !== was,
        "not placed",
      );
    }
    case "askAi": {
      // AI に頼む（D-107）: 依頼のポップオーバー → 「頼む」で依頼を送る（偽の応答。端末も AI も起動しない）
      const launch = page.getByTestId("ai-launch");
      if (
        !(await launch.waitFor({ timeout: 3000 }).then(
          () => true,
          () => false,
        ))
      )
        return "no ask-AI popover";
      const m = mocked.get(page);
      if (!m) return "writes are not recorded";
      m.sent.length = 0;
      await until(
        () => launch.isEnabled(),
        (v) => v,
      );
      await launch.click({ timeout: 2000 });
      return (await sent(m, /^POST \/api\/ai\/launches$/, new RegExp(id)))
        ? true
        : `launch not sent (sent: ${m.sent.map((x) => `${x.method} ${x.path}`).join(", ") || "nothing"})`;
    }
    default:
      return `no check for “${action}”`;
  }
}

async function taskPlace(t: Ctx, p: TaskPlace) {
  const { page, board } = t;
  await p.open(page);
  // ボタンとメニューの項目を、1件目のカードから読む
  const probe = await makeTask(board, p);
  const card0 = p.card(page, probe);
  const shown = await card0.waitFor({ timeout: 5000 }).then(
    () => true,
    () => false,
  );
  t.check(`${p.name}: the card is shown`, shown);
  if (!shown) return;
  const rc = p.rightClick === true;
  const buttons = rc ? [] : (await toolbarIds(card0)).filter((x) => x !== "more");
  const menu = await openMenu(page, card0, rc).catch(() => null);
  const items = menu ? await menuIds(menu) : [];
  t.check(
    `${p.name}: ${rc ? "the right-click menu is" : "hover buttons and the … menu are"} there`,
    (rc || buttons.length > 0) && items.length > 0,
    `buttons [${buttons}] menu [${items}]`,
  );
  await closeAll(page);
  await board.api("DELETE", `/tasks/${probe}`).catch(() => {});
  // 1項目につき1つの道（ボタンがあればボタン、無ければメニュー）。項目の一覧そのものは単体（mouse-ops・hover-check）で見る（D-196）
  const runs: [string, string][] = [
    ...buttons.map((b): [string, string] => ["button", b]),
    ...items.filter((m) => !buttons.includes(m)).map((m): [string, string] => ["menu", m]),
  ];
  for (const [how, action] of runs) {
    const id = await makeTask(board, p);
    const card = p.card(page, id);
    let result: true | string;
    try {
      await card.waitFor({ timeout: 5000 });
      await settle(page, 300);
      const before = (await detail(board, id)) as TaskDetailResponse;
      if (how === "button") {
        await card.hover();
        await card
          .locator(`[data-testid="hover-toolbar"] [data-action="${action}"]`)
          .click({ timeout: 2000 });
      } else {
        const m = await openMenu(page, card, rc);
        await m.locator(`[data-menu-id="${action}"]`).click({ timeout: 2000 });
      }
      result = await taskOutcome(page, board, p, id, action, before);
    } catch (e) {
      result = String(e).split("\n")[0]?.slice(0, 200) ?? "error";
    }
    t.check(`${p.name}: ${how} “${action}” works`, result === true, result === true ? "" : result);
    await closeAll(page);
    await board.api("DELETE", `/tasks/${id}`).catch(() => {});
  }
}

/**
 * 時間軸の選んだカードを ✓（と ✓ にマウスを乗せたままの Space）で完了にした後（2026-10-16 の不具合: ツールチップ
 * 「完了 Space」が消えずに残り、カードも完了の薄さにならなかった）。完了でドラッグの入れ物が外れてカードが描き直されるので、
 * ✓ の mouseleave・blur が来ない
 */
async function laneComplete(t: Ctx, card: (pg: Page, id: string) => Locator) {
  const { page, board } = t;
  for (const how of ["button", "Space"] as const) {
    const id = await makeTask(board, {
      name: "",
      open: async () => {},
      date: MON,
      placed: true,
      card,
    });
    const c = card(page, id);
    let result: true | string = true;
    try {
      await c.waitFor({ timeout: 5000 });
      await settle(page, 300);
      await c.click();
      await c.hover();
      const btn = c.locator('[data-testid="hover-toolbar"] [data-action="complete"]');
      await btn.hover();
      await page.getByTestId("tooltip").waitFor({ timeout: 2000 });
      if (how === "button") await btn.click();
      else await page.keyboard.press("Space");
      const d = await until(
        () => detail(board, id),
        (x) => x?.task.status === "done",
      );
      await settle(page, 400);
      const tips = await page.getByTestId("tooltip").count();
      const cls = (await card(page, id).getAttribute("class")) ?? "";
      if (d?.task.status !== "done") result = `not completed: ${d?.task.status}`;
      else if (tips > 0) result = `tooltip left: ${await page.getByTestId("tooltip").innerText()}`;
      else if (!cls.includes("opacity-60")) result = `no done look: ${cls}`;
    } catch (e) {
      result = String(e).split("\n")[0]?.slice(0, 200) ?? "error";
    }
    t.check(
      `3-day board timeline: ${how} ✓ on a selected card closes the tooltip and shows it done`,
      result === true,
      result === true ? "" : result,
    );
    await closeAll(page);
    await board.api("DELETE", `/tasks/${id}`).catch(() => {});
  }
}

// ---------- 自分の番・AI（要求を記録する） ----------

interface Mocked {
  sent: Sent[];
}

const mocked = new WeakMap<Page, Mocked>();

async function mockWrites(page: Page): Promise<Mocked> {
  const m: Mocked = { sent: [] };
  mocked.set(page, m);
  await page.route(
    (u) => MOCK.test(u.pathname),
    async (route) => {
      const r = route.request();
      if (r.method() === "GET") return route.continue();
      m.sent.push({
        method: r.method(),
        path: new URL(r.url()).pathname,
        body: r.postData() ?? "",
      });
      await route.fulfill({ status: 200, contentType: "application/json", body: '{"rev":0}' });
    },
  );
  return m;
}

/** 要求が送られるまで待つ */
async function sent(m: Mocked, re: RegExp, body?: RegExp): Promise<boolean> {
  const hit = () =>
    Promise.resolve(
      m.sent.some((s) => re.test(`${s.method} ${s.path}`) && (!body || body.test(s.body))),
    );
  return until(hit, (v) => v);
}

/** 自分の番・AI の操作の続きと確かめ。fids はその項目の開いているフォローアップ */
async function writeOutcome(
  page: Page,
  m: Mocked,
  action: string,
  wid: string,
  fids: string[],
  opts: { detailPanel?: () => Promise<boolean> } = {},
): Promise<true | string> {
  const fu = `(${fids.join("|") || "none"})`;
  const expect = async (re: RegExp, what: string, body?: RegExp) =>
    (await sent(m, re, body))
      ? (true as const)
      : `${what} not sent (sent: ${m.sent.map((s) => `${s.method} ${s.path}`).join(", ") || "nothing"})`;
  const dialog = page.locator('[role="dialog"]').last();
  switch (action) {
    case "open":
      return expect(/^POST \/api\/open$/, "open", new RegExp(`${fu.slice(1, -1)}|${wid}`));
    case "openWith": {
      const first = dialog.locator("button").first();
      if (
        !(await first.waitFor({ timeout: 3000 }).then(
          () => true,
          () => false,
        ))
      )
        return "no open-with menu";
      await first.click();
      return expect(/^POST \/api\/(open|work-items\/[^/]+\/reply-task)$/, "open with");
    }
    case "detail":
      return (await (opts.detailPanel ?? (() => panelOpen(page, "ai-panel")))())
        ? true
        : "no AI panel";
    case "answer":
      // 答える（D-238）: 詳細の「答える」の節が開く（メニューバーはボードのパネルへ移って開く）
      return (await panelOpen(page, "answer")) ? true : "no answer section";
    case "complete":
      return expect(new RegExp(`^POST /api/follow-ups/${fu}/complete$`), "complete");
    case "move":
    case "tomorrow":
      return expect(new RegExp(`^POST /api/follow-ups/${fu}/defer$`), "defer");
    case "dismiss":
      return expect(new RegExp(`^POST /api/follow-ups/(${fu}/dismiss|bulk-dismiss)$`), "dismiss");
    case "snooze": {
      // 自分の番の行はポップオーバー、AI の詳細パネルは次のメニュー
      const sub = page.locator('[data-testid="context-menu"] [data-menu-id="snooze-30m"]');
      const pop = dialog.locator("button").first();
      const which = await Promise.race([
        sub.waitFor({ timeout: 3000 }).then(
          () => "menu",
          () => null,
        ),
        pop.waitFor({ timeout: 3000 }).then(
          () => "pop",
          () => null,
        ),
      ]);
      if (which === "menu") await sub.click();
      else if (which === "pop") await pop.click();
      else return "no snooze choices";
      return expect(new RegExp(`^POST /api/follow-ups/${fu}/snooze$`), "snooze");
    }
    case "replyTask":
    case "makeTask":
      return expect(new RegExp(`^POST /api/work-items/${wid}/reply-task$`), "reply task");
    case "backToTurn":
      return expect(new RegExp(`^POST /api/work-items/${wid}/back-to-turn$`), "back to turn");
    case "aiDone":
      return expect(new RegExp(`^PATCH /api/work-items/${wid}$`), "done", /manualDone":true/);
    case "done":
      return fids.length > 0
        ? expect(new RegExp(`^POST /api/follow-ups/${fu}/complete$`), "complete")
        : expect(new RegExp(`^PATCH /api/work-items/${wid}$`), "done", /manualDone":true/);
    case "undone":
      return expect(new RegExp(`^PATCH /api/work-items/${wid}$`), "undone", /manualDone":false/);
    case "aiHide":
    case "hide":
      return expect(new RegExp(`^PATCH /api/work-items/${wid}$`), "hide", /hidden":true/);
    default:
      return `no check for “${action}”`;
  }
}

async function openFollowUps(board: Board, wid: string): Promise<string[]> {
  const q = await board.api<QueueResponse>("GET", "/queue");
  const it = q.items.find((x) => x.workItemId === wid);
  return (it?.followUps ?? []).filter((f) => f.status === "open").map((f) => f.id);
}

interface RowPlace {
  name: string;
  /** 画面を開く（毎回。偽の応答で消えた行を戻す） */
  open: (page: Page) => Promise<void>;
  rows: (page: Page) => Locator;
  /** `…` のボタンが無い（メニューバー・AI の線）: 右クリックで開く */
  rightClick?: boolean;
  /** ホバーのボタンが無い（AI の線） */
  noButtons?: boolean;
  detailPanel?: (page: Page) => Promise<boolean>;
}

async function rowPlace(t: Ctx, m: Mocked, p: RowPlace) {
  const { page, board } = t;
  await p.open(page);
  const row0 = p.rows(page).first();
  const shown = await row0.waitFor({ timeout: 5000 }).then(
    () => true,
    () => false,
  );
  t.check(`${p.name}: a row is shown`, shown);
  if (!shown) return;
  const buttons = p.noButtons ? [] : (await toolbarIds(row0)).filter((x) => x !== "more");
  const menu = await openMenu(page, row0, p.rightClick === true).catch(() => null);
  const items = menu ? await menuIds(menu) : [];
  t.check(
    `${p.name}: ${p.noButtons ? "the menu is" : "hover buttons and the menu are"} there`,
    (p.noButtons || buttons.length > 0) && items.length > 0,
    `buttons [${buttons}] menu [${items}]`,
  );
  // 1項目につき1つの道（ボタンがあればボタン、無ければメニュー。D-196）
  const runs: [string, string][] = [
    ...buttons.map((b): [string, string] => ["button", b]),
    ...items.filter((x) => !buttons.includes(x)).map((x): [string, string] => ["menu", x]),
  ];
  for (const [how, action] of runs) {
    let result: true | string;
    try {
      await p.open(page);
      const row = p.rows(page).first();
      await row.waitFor({ timeout: 5000 });
      await settle(page, 300);
      const wid = (await row.getAttribute("data-id")) ?? "";
      const fids = await openFollowUps(board, wid);
      m.sent.length = 0;
      if (how === "button") {
        await row.hover();
        await row
          .locator(`[data-testid="hover-toolbar"] [data-action="${action}"]`)
          .click({ timeout: 2000 });
      } else {
        const mm = await openMenu(page, row, p.rightClick === true);
        await mm.locator(`[data-menu-id="${action}"]`).click({ timeout: 2000 });
      }
      result = await writeOutcome(page, m, action, wid, fids, {
        ...(p.detailPanel
          ? { detailPanel: () => (p.detailPanel as (pg: Page) => Promise<boolean>)(page) }
          : {}),
      });
    } catch (e) {
      result = String(e).split("\n")[0]?.slice(0, 200) ?? "error";
    }
    t.check(`${p.name}: ${how} “${action}” works`, result === true, result === true ? "" : result);
  }
}

interface EventPlace {
  name: string;
  /** 画面を開く（毎回） */
  open: (page: Page) => Promise<void>;
  /** 題名で予定を探す */
  event: (page: Page, title: string) => Locator;
  /** 右クリックする予定（既定は終わった会議の Weekly sync。これからの予定は「この予定の間は集中する」が出る） */
  title?: string;
  /** 押す項目を絞る（同じ画面の別の予定で既に押した項目は繰り返さない。D-196） */
  only?: string[];
}

/** 集中モードの今の状態（D-130 の予約を含む） */
async function focusOf(board: Board) {
  return board.api<{ active: { until: number } | null; reserved?: { eventId: string }[] }>(
    "GET",
    "/focus",
  );
}

/** その予定の今の Turnlane の中の色（D-125。週ボードの API で見る） */
async function colorKeyOf(board: Board, id: string): Promise<string | null | undefined> {
  const b = await board.api<BoardResponse>("GET", `/board?from=${TODAY}&to=${TODAY}`);
  return b.days.flatMap((d) => d.events).find((e) => e.id === id)?.calendarColorKey;
}

/** 予定の右クリックのメニューの全項目（D-070・D-093・D-125） */
async function eventPlace(t: Ctx, m: Mocked, p: EventPlace) {
  const { page, board } = t;
  const title = p.title ?? "Weekly sync";
  await p.open(page);
  const ev0 = p.event(page, title);
  const shown = await ev0.waitFor({ timeout: 5000 }).then(
    () => true,
    () => false,
  );
  t.check(`${p.name}: an event is shown`, shown);
  if (!shown) return;
  const menu0 = await openMenu(page, ev0, true).catch(() => null);
  const items = menu0 ? await menuIds(menu0) : [];
  t.check(`${p.name}: the event menu is there`, items.length > 0, `menu [${items}]`);
  await closeAll(page);
  for (const action of p.only ? items.filter((x) => p.only?.includes(x)) : items) {
    let result: true | string;
    try {
      await p.open(page);
      const ev = p.event(page, title);
      await ev.waitFor({ timeout: 5000 });
      await settle(page, 300);
      const id = (await ev.getAttribute("data-id")) ?? "";
      m.sent.length = 0;
      const mm = await openMenu(page, ev, true);
      const row = mm.locator(`[data-menu-id="${action}"]`);
      if (action === "calColor") {
        // ホバーで右にパレット。色を選ぶとそのカレンダーの予定の色が変わり、もう一度開くとチェック。戻すと null
        await row.hover();
        const sub = page.getByTestId("context-submenu");
        await sub.waitFor({ timeout: 2000 });
        await sub.locator('[data-cal-color="green"]').click({ timeout: 2000 });
        const k = await until(
          () => colorKeyOf(board, id),
          (v) => v === "green",
        );
        const style = await until(
          () => p.event(page, title).getAttribute("style"),
          (v) => (v ?? "").includes("--dl-cal-green"),
        );
        const mm2 = await openMenu(page, p.event(page, title), true);
        await mm2.locator('[data-menu-id="calColor"]').hover();
        const checked = await page
          .locator('[data-testid="context-submenu"] [data-cal-color="green"]')
          .getAttribute("aria-checked");
        await page
          .locator('[data-testid="context-submenu"] [data-cal-color="reset"]')
          .click({ timeout: 2000 });
        const back = await until(
          () => colorKeyOf(board, id),
          (v) => v === null,
        );
        result =
          k === "green" &&
          (style ?? "").includes("--dl-cal-green") &&
          checked === "true" &&
          back === null
            ? true
            : `key ${k} style ${style} checked ${checked} back ${back}`;
      } else {
        await row.click({ timeout: 2000 });
        if (action === "detail")
          result = (await panelOpen(page, "event-panel")) || "the event panel did not open";
        else if (action === "eventOpen")
          result =
            (await sent(m, new RegExp(`^POST /api/calendar-events/${id}/open$`))) ||
            "no open request";
        else if (action === "eventDelete") {
          // 確認を出すだけ（取り消す）
          result = (await panelOpen(page, "confirm-dialog")) || "no confirmation";
          await page.keyboard.press("Escape");
        } else if (action === "eventFocus") {
          // 予約される（これからの予定なのでまだ集中しない）。もう一度開くと ✓ で、選ぶと取り消す（D-130）
          const on = await until(
            () => focusOf(board),
            (f) => (f.reserved ?? []).some((r) => r.eventId === id),
          );
          const mm2 = await openMenu(page, p.event(page, title), true);
          const label = await mm2.locator('[data-menu-id="eventFocus"]').innerText();
          await mm2.locator('[data-menu-id="eventFocus"]').click({ timeout: 2000 });
          const off = await until(
            () => focusOf(board),
            (f) => !(f.reserved ?? []).some((r) => r.eventId === id),
          );
          result =
            (on.reserved ?? []).some((r) => r.eventId === id) &&
            on.active === null &&
            label.includes("✓") &&
            !(off.reserved ?? []).some((r) => r.eventId === id)
              ? true
              : `on ${JSON.stringify(on)} label ${label} off ${JSON.stringify(off)}`;
        } else if (action === "hideCalendar") {
          // このカレンダーを表示しない（Issue #5）: その予定は描かれなくなる。戻すのは上部バーの「カレンダー」（ここは API で）
          const gone = await until(
            () => p.event(page, title).count(),
            (n) => n === 0,
          );
          await board.api("PUT", "/config/calendar.hidden", { value: [] });
          const back = await until(
            async () => {
              await p.open(page);
              return p.event(page, title).count();
            },
            (n) => n > 0,
          );
          result = gone === 0 && back > 0 ? true : `gone ${gone} back ${back}`;
        } else result = `no check for “${action}”`;
      }
    } catch (e) {
      result = String(e).split("\n")[0]?.slice(0, 200) ?? "error";
    }
    t.check(`${p.name}: menu “${action}” works`, result === true, result === true ? "" : result);
    await closeAll(page);
  }
}

/** AI の詳細パネルの ⋯（状態ごとに項目が違うので、今日の AI の作業を全部見る） */
async function aiPanelMore(t: Ctx, m: Mocked) {
  const { page, board } = t;
  const b = await board.api<BoardResponse>("GET", `/board?from=${TODAY}&to=${TODAY}`);
  const ids = [...new Set((b.days[0]?.aiLane ?? []).map((x) => x.id))];
  t.check("AI panel ⋯: today has AI work", ids.length > 0);
  const seen = new Set<string>();
  for (const wid of ids) {
    const open = async () => {
      await go(page, `${board.base}/board?panel=${encodeURIComponent(wid)}`);
      await page.getByTestId("ai-more").waitFor({ timeout: 5000 });
      await settle(page, 300);
    };
    let items: string[] = [];
    try {
      await open();
      await page.getByTestId("ai-more").click();
      items = await menuIds(page.getByTestId("context-menu"));
    } catch (e) {
      t.check(`AI panel ⋯ (${wid.slice(-6)}): the menu opens`, false, String(e).slice(0, 200));
      continue;
    }
    const status = await page
      .getByTestId("ai-state")
      .innerText()
      .catch(() => "?");
    for (const action of items) {
      let result: true | string;
      try {
        await open();
        const fids = await openFollowUps(board, wid);
        m.sent.length = 0;
        await page.getByTestId("ai-more").click();
        await page
          .locator(`[data-testid="context-menu"] [data-menu-id="${action}"]`)
          .click({ timeout: 2000 });
        result = await writeOutcome(page, m, action, wid, fids);
      } catch (e) {
        result = String(e).split("\n")[0]?.slice(0, 200) ?? "error";
      }
      const name = `AI panel ⋯ (${status.split("\n")[0]}): “${action}” works`;
      if (seen.has(name) && result === true) continue;
      seen.add(name);
      t.check(name, result === true, result === true ? "" : result);
    }
  }
}

async function run(t: Ctx) {
  const { page, board } = t;
  trackRequests(page);
  const m = await mockWrites(page);
  const login = board.url.replace(/next=[^&]*/, "next=%2Fboard");
  await page.goto(login);
  await page.waitForSelector(`[data-grid="${TODAY}"]`);
  await settle(page, 600);

  const goto = (path: string, ready: string) => async (pg: Page) => {
    if (new URL(pg.url()).pathname !== path) {
      await go(pg, `${board.base}${path}`);
      await pg.waitForSelector(ready);
      await settle(pg, 500);
    }
  };
  const card = (scope: string) => (pg: Page, id: string) =>
    pg.locator(`${scope} [data-kind="task"][data-id="${id}"]`).first();
  /** Inbox のトレーの開閉（このブラウザの覚え）を変えて読み直す */
  const tray = async (open: boolean) => {
    await page.evaluate(
      (v) => localStorage.setItem("turnlane.board.inboxTray", v),
      open ? "1" : "0",
    );
    await go(page, `${board.base}/board`);
    await page.waitForSelector(`[data-grid="${MON}"]`);
    await settle(page, 500);
  };

  // ---------- タスクのカード ----------
  // 3日ボードの次の稼働日（10/5）の列: 今日へ・1日後へ・日付の入力の結果が今の日付と違う
  // 左右の列のカードは幅が 180px 未満だとボタンを隠す（1440px では隠れる）ので、広い窓で見る
  await page.setViewportSize({ width: 1920, height: 900 });
  await tray(false);
  await taskPlace(t, {
    name: "3-day board unscheduled",
    open: goto("/board", `[data-grid="${MON}"]`),
    date: MON,
    card: card('[data-testid="unscheduled-row"]'),
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await taskPlace(t, {
    name: "3-day board timeline",
    open: goto("/board", `[data-grid="${MON}"]`),
    date: MON,
    placed: true,
    card: card(`[data-grid="${MON}"]`),
  });
  await laneComplete(t, card(`[data-grid="${MON}"]`));
  // トレーを開くと左右の列が狭くなり、カードのボタンは隠れる（右クリックのメニューは使える）
  await tray(true);
  await taskPlace(t, {
    name: "Inbox tray",
    open: goto("/board", '[data-testid="inbox-tray"]'),
    date: null,
    card: card('[data-testid="inbox-tray"]'),
  });
  await taskPlace(t, {
    name: "3-day board narrow column (tray open)",
    open: goto("/board", `[data-grid="${MON}"]`),
    date: MON,
    card: card('[data-testid="unscheduled-row"]'),
    rightClick: true,
  });
  await taskPlace(t, {
    name: "Inbox page",
    open: goto("/inbox", "h1"),
    date: null,
    card: card("main"),
  });
  const openDay = async (pg: Page) => {
    if (new URL(pg.url()).pathname === "/day") return;
    await go(pg, `${board.base}/day`);
    await pg.getByTestId("day-view").waitFor();
    // 10/5（月）の日を開く（今日へ・1日後へ・日付の入力の結果が今の日付と違い、空き枠がある稼働日）
    for (let i = 0; i < 3; i++) {
      // 言語はブラウザに従う（WebKit は日本語のことがある）
      await pg.getByRole("button", { name: /^(Next|次へ)$/ }).click();
      await settle(pg, 200);
    }
    await settle(pg, 600);
  };
  await taskPlace(t, {
    name: "Day view unscheduled",
    open: openDay,
    date: MON,
    card: card("[data-day-list]"),
  });
  // デイビューの時間軸のカード（✓ →| ⋯。D-148）
  await taskPlace(t, {
    name: "Day view timeline",
    open: openDay,
    date: MON,
    placed: true,
    card: card(`[data-grid="${MON}"]`),
  });

  // ---------- 自分の番・AI（要求を記録する） ----------
  const reload = (path: string, ready: string) => async (pg: Page) => {
    await go(pg, `${board.base}${path}`);
    await pg.waitForSelector(ready);
    await settle(pg, 400);
  };
  await rowPlace(t, m, {
    name: "Your turn (3-day board)",
    open: reload("/board", '[data-kind="turn"]'),
    rows: (pg) => pg.locator('[data-kind="turn"]'),
  });
  await rowPlace(t, m, {
    name: "Your turn (day view)",
    open: reload("/day", '[data-day-list] [data-kind="turn"]'),
    rows: (pg) => pg.locator('[data-day-list] [data-kind="turn"]'),
  });
  await rowPlace(t, m, {
    name: "Your turn (queue page)",
    open: reload("/queue", '[data-kind="turn"]'),
    rows: (pg) => pg.locator('[data-kind="turn"]'),
    // 自分の番の画面の詳細は右の欄（全体の AI 詳細パネルは開かない）
    detailPanel: (pg) => panelOpen(pg, "queue-detail"),
  });
  await rowPlace(t, m, {
    name: "Menu bar",
    open: reload("/tray", '[data-kind="turn"]'),
    rows: (pg) => pg.locator('[data-kind="turn"]'),
    rightClick: true,
    // ブラウザでは同じタブで週ボードのパネルへ移る（デスクトップアプリは main ウインドウ）
    detailPanel: async (pg) =>
      (await panelOpen(pg, "ai-panel")) && new URL(pg.url()).pathname === "/board",
  });
  await rowPlace(t, m, {
    name: "AI block (3-day board)",
    open: reload("/board", '[data-kind="ai"]'),
    // ラベルのある線（題名の付いた最後の実行）
    rows: (pg) => pg.locator('[data-kind="ai"][data-id]:has([data-label="ai"])'),
    rightClick: true,
    noButtons: true,
  });
  await aiPanelMore(t, m);

  // ---------- 予定（右クリック。D-125 のカレンダーの色 ▸ を含む） ----------
  await eventPlace(t, m, {
    name: "Event (3-day board)",
    open: reload("/board", `[data-grid="${TODAY}"] [data-kind="event"]`),
    event: (pg, title) =>
      pg.locator(`[data-grid="${TODAY}"] [data-kind="event"]`, { hasText: title }).first(),
  });
  await eventPlace(t, m, {
    name: "Event (day view)",
    open: reload("/day", '[data-testid="day-view"] [data-kind="event"]'),
    event: (pg, title) =>
      pg.locator('[data-testid="day-view"] [data-kind="event"]', { hasText: title }).first(),
  });
  // これからの予定（Design review 14:00–15:00）: 「この予定の間は集中する」（D-130）
  // ほかの項目（詳細・開く・色・削除）は同じ画面の Weekly sync で押したので、ここは集中だけ
  await eventPlace(t, m, {
    name: "Upcoming event (3-day board)",
    title: "Design review",
    open: reload("/board", `[data-grid="${TODAY}"] [data-kind="event"]`),
    event: (pg, title) =>
      pg.locator(`[data-grid="${TODAY}"] [data-kind="event"]`, { hasText: title }).first(),
    only: ["eventFocus"],
  });
  await eventPlace(t, m, {
    name: "Upcoming event (day view)",
    title: "Design review",
    open: reload("/day", '[data-testid="day-view"] [data-kind="event"]'),
    event: (pg, title) =>
      pg.locator('[data-testid="day-view"] [data-kind="event"]', { hasText: title }).first(),
    only: ["eventFocus"],
  });
  await eventPanelFocus(t);
  await trayFocus(t);
  await calendarColorKeys(t);
  await calendarColorSettings(t);
}

/** 位置で押す（予定の上に重なる線・ラベルがあっても、その予定の左上を押す） */
async function clickBox(page: Page, item: Locator) {
  await item.scrollIntoViewIfNeeded();
  const b = await item.boundingBox();
  if (!b) throw new Error("no box");
  await page.mouse.click(b.x + Math.min(8, b.width / 2), b.y + Math.min(8, b.height / 2));
}

/** 予定の詳細パネルの「この予定の間は集中する」: 押すと設定（✓）、もう一度押すと取り消す。終わった予定には出ない（D-130） */
async function eventPanelFocus(t: Ctx) {
  const { page, board } = t;
  let result: true | string;
  try {
    await go(page, `${board.base}/board`);
    const done = page
      .locator(`[data-grid="${TODAY}"] [data-kind="event"]`, { hasText: "Weekly sync" })
      .first();
    await done.waitFor({ timeout: 5000 });
    await settle(page, 300);
    await clickBox(page, done);
    await page.getByTestId("event-panel").waitFor({ timeout: 2000 });
    await settle(page, 300);
    const hiddenForPast = (await page.getByTestId("event-focus").count()) === 0;
    await closeAll(page);
    const ev = page
      .locator(`[data-grid="${TODAY}"] [data-kind="event"]`, { hasText: "Design review" })
      .first();
    await go(page, `${board.base}/board`);
    await ev.waitFor({ timeout: 5000 });
    await settle(page, 300);
    const id = (await ev.getAttribute("data-id")) ?? "";
    await clickBox(page, ev);
    const btn = page.getByTestId("event-focus");
    await btn.waitFor({ timeout: 2000 });
    await btn.click();
    const on = await until(
      () => btn.getAttribute("data-on"),
      (v) => v === "true",
    );
    const reserved = (await focusOf(board)).reserved ?? [];
    await btn.click();
    const off = await until(
      () => btn.getAttribute("data-on"),
      (v) => v === "false",
    );
    result =
      hiddenForPast && on === "true" && reserved.some((r) => r.eventId === id) && off === "false"
        ? true
        : `past hidden ${hiddenForPast} on ${on} reserved ${JSON.stringify(reserved)} off ${off}`;
  } catch (e) {
    result = String(e).split("\n")[0]?.slice(0, 200) ?? "error";
  }
  t.check(
    "Event panel: “focus during this event” sets and cancels",
    result === true,
    result === true ? "" : result,
  );
  await closeAll(page);
}

/** メニューバーの「集中する ▸」（30分 / 1時間 / 次の予定の終わりまで）と、集中中の行の「終了」（D-130） */
async function trayFocus(t: Ctx) {
  const { page, board } = t;
  for (const action of ["focus30", "focus60", "focusEvent"]) {
    let result: true | string;
    try {
      await go(page, `${board.base}/tray`);
      const start = page.getByTestId("tray-focus-start");
      await start.waitFor({ timeout: 5000 });
      await start.click();
      const menu = page.getByTestId("context-menu");
      await menu.waitFor({ timeout: 2000 });
      const ids = await menuIds(menu);
      await menu.locator(`[data-menu-id="${action}"]`).click({ timeout: 2000 });
      const active = page.getByTestId("tray-focus-active");
      await active.waitFor({ timeout: 3000 });
      const f = await focusOf(board);
      await page.getByTestId("tray-focus-end").click();
      await start.waitFor({ timeout: 3000 });
      const after = await focusOf(board);
      result =
        ids.join() === "focus30,focus60,focusEvent" && f.active !== null && after.active === null
          ? true
          : `menu [${ids}] active ${JSON.stringify(f.active)} after ${JSON.stringify(after.active)}`;
    } catch (e) {
      result = String(e).split("\n")[0]?.slice(0, 200) ?? "error";
    }
    t.check(
      `Menu bar: “focus ▸ ${action}” and “end” work`,
      result === true,
      result === true ? "" : result,
    );
  }
}

/** キーだけで: ↓ で「カレンダーの色」へ、→ でパレット（先頭の色にフォーカス）、⏎ で選ぶ。← で行に戻る（D-125） */
async function calendarColorKeys(t: Ctx) {
  const { page, board } = t;
  let result: true | string;
  try {
    await go(page, `${board.base}/board`);
    const ev = page
      .locator(`[data-grid="${TODAY}"] [data-kind="event"]`, { hasText: "Weekly sync" })
      .first();
    await ev.waitFor({ timeout: 5000 });
    await settle(page, 300);
    const id = (await ev.getAttribute("data-id")) ?? "";
    const menu = await openMenu(page, ev, true);
    const ids = await menuIds(menu);
    for (let i = 0; i <= ids.indexOf("calColor"); i++) await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowRight");
    const sub = page.getByTestId("context-submenu");
    await sub.waitFor({ timeout: 2000 });
    const focused = await page.evaluate(() =>
      document.activeElement?.getAttribute("data-cal-color"),
    );
    // ← で行に戻り（サブメニューを閉じる）、→ で開き直して → で次の色（orange）を ⏎
    await page.keyboard.press("ArrowLeft");
    const closed = (await sub.count()) === 0;
    await page.keyboard.press("ArrowRight");
    await sub.waitFor({ timeout: 2000 });
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Enter");
    const k = await until(
      () => colorKeyOf(board, id),
      (v) => v === "orange",
    );
    const cal = (await board.api<BoardResponse>("GET", `/board?from=${TODAY}&to=${TODAY}`)).days
      .flatMap((d) => d.events)
      .find((e) => e.id === id)?.calendarId;
    if (cal) await board.api("PATCH", `/calendars/${cal}`, { colorKey: null });
    result =
      focused === "red" && closed && k === "orange"
        ? true
        : `focused ${focused} closed ${closed} key ${k}`;
  } catch (e) {
    result = String(e).split("\n")[0]?.slice(0, 200) ?? "error";
  }
  t.check(
    "Event menu: calendar color with keys only",
    result === true,
    result === true ? "" : result,
  );
  await closeAll(page);
}

/** 設定 > カレンダー の色の丸 → パレットで選ぶ・戻す（D-125） */
async function calendarColorSettings(t: Ctx) {
  const { page, board } = t;
  let result: true | string;
  try {
    await go(page, `${board.base}/settings#calendar`);
    const row = page.getByTestId("settings-calendar-row").first();
    await row.waitFor({ timeout: 5000 });
    const cal = (await row.getAttribute("data-calendar-id")) ?? "";
    const keyOf = async () =>
      (
        await board.api<{ calendars: { id: string; colorKey: string | null }[] }>(
          "GET",
          "/calendars",
        )
      ).calendars.find((c) => c.id === cal)?.colorKey;
    await row.getByTestId("cal-color-button").click();
    await page.locator('[data-testid="cal-palette"] [data-cal-color="blue"]').click();
    const k = await until(keyOf, (v) => v === "blue");
    // 開いている設定の色の丸も変わる
    const dot = await until(
      () => row.locator('[data-testid="cal-color-button"] span').getAttribute("style"),
      (v) => (v ?? "").includes("--dl-cal-blue"),
    );
    await row.getByTestId("cal-color-button").click();
    await page.locator('[data-testid="cal-palette"] [data-cal-color="reset"]').click();
    const back = await until(keyOf, (v) => v === null);
    result =
      k === "blue" && (dot ?? "").includes("--dl-cal-blue") && back === null
        ? true
        : `key ${k} dot ${dot} back ${back}`;
  } catch (e) {
    result = String(e).split("\n")[0]?.slice(0, 200) ?? "error";
  }
  t.check("Settings: calendar color palette", result === true, result === true ? "" : result);
}

export const actionsSuite: Suite = { name: "actions", args: [], run };

/**
 * 壁打ち（D-135。dev-board --scratch）: 自分の番の行と AI の詳細パネルにリポジトリの代わりに「壁打ち」、詳細パネルの
 * 「他の開き方」の新しい項目「Codex で開く」（CLI で始めた Codex の会話）が開く要求を送ること、設定の壁打ちのフォルダの
 * 足す・外す
 */
async function runScratch(t: Ctx) {
  const { page, board } = t;
  trackRequests(page);
  const m = await mockWrites(page);
  await page.goto(board.url.replace(/next=[^&]*/, "next=%2Fqueue"));
  const label = /^(壁打ち|Scratch)$/;
  let result: true | string;
  try {
    const q = await board.api<QueueResponse>("GET", "/queue");
    const item = q.items.find((x) => x.scratch);
    if (!item) throw new Error("no scratch item in the queue");
    const row = page.getByText(label).first();
    await row.waitFor({ timeout: 5000 });
    result = true;
  } catch (e) {
    result = String(e).split("\n")[0]?.slice(0, 200) ?? "error";
  }
  t.check("Scratch: your-turn row shows Scratch", result === true, result === true ? "" : result);

  try {
    const b = await board.api<BoardResponse>("GET", `/board?from=${TODAY}&to=${TODAY}`);
    const cli = (b.days[0]?.aiLane ?? []).find(
      (x) => x.scratch && x.sources.some((s) => s.tool === "codex") && x.status === "done",
    );
    if (!cli) throw new Error("no Codex CLI scratch item");
    await go(page, `${board.base}/day`);
    const block = page.locator(`[data-kind="ai"][data-id="${cli.id}"]`).first();
    await block.waitFor({ timeout: 5000 });
    await block.scrollIntoViewIfNeeded();
    await block.click({ force: true });
    const panel = page.getByTestId("ai-panel");
    await panel.waitFor({ timeout: 5000 });
    await panel.getByText(label).first().waitFor({ timeout: 3000 });
    await panel.getByTestId("ai-open-with").click();
    const entry = page.locator('[data-menu-id="open-codex_app"]');
    await entry.waitFor({ timeout: 3000 });
    // 同じ項目を2回出さない（リポジトリの無いカードでも Finder の項目は1つ。D-135 のレビュー）
    const labels = (
      await page.locator('[data-testid="context-menu"] [data-menu-id^="open-"]').allInnerTexts()
    ).map((x) => x.replace(/\s+/g, " ").trim());
    const finders = labels.filter((x) => /Finder/.test(x));
    if (new Set(labels).size !== labels.length || finders.length > 1)
      throw new Error(`duplicate open-with entries: ${JSON.stringify(labels)}`);
    // 日表示のブロックはクリックで詳細パネルだけ（ターンの内訳は出さない。D-116）
    if ((await page.getByTestId("turn-list").count()) > 0) throw new Error("turn list opened");
    await entry.click();
    result = (await sent(m, /^POST \/api\/open$/, /"action":"codex_app"/))
      ? true
      : `open not sent (sent: ${m.sent.map((x) => `${x.method} ${x.path}`).join(", ") || "nothing"})`;
  } catch (e) {
    result = String(e).split("\n")[0]?.slice(0, 200) ?? "error";
  }
  t.check(
    "Scratch: AI panel shows Scratch and Open with > Open in Codex (no duplicate entries, no turn list)",
    result === true,
    result === true ? "" : result,
  );
  await closeAll(page);

  try {
    await go(page, `${board.base}/settings#ai`);
    const sec = page.getByTestId("settings-scratch-dirs");
    await sec.waitFor({ timeout: 5000 });
    const dirs = async () =>
      (await board.api<{ value: string[] }>("GET", "/config/ai.scratch_dirs")).value;
    const before = await dirs();
    await page.getByTestId("settings-scratch-dir-input").fill("~/notes-scratch");
    await page.getByTestId("settings-scratch-dir-input").press("Enter");
    const added = await until(dirs, (v) => v.length === before.length + 1);
    const last = added.at(-1) ?? "";
    await sec
      .locator('[data-kind="scratch-dir"]', { hasText: "notes-scratch" })
      .getByRole("button")
      .click();
    const removed = await until(dirs, (v) => v.length === before.length);
    result =
      last.endsWith("/notes-scratch") && !last.startsWith("~") && removed.length === before.length
        ? true
        : `added ${JSON.stringify(added)} removed ${JSON.stringify(removed)}`;
  } catch (e) {
    result = String(e).split("\n")[0]?.slice(0, 200) ?? "error";
  }
  t.check(
    "Settings: scratch folders add and remove",
    result === true,
    result === true ? "" : result,
  );
}

export const actionsScratchSuite: Suite = {
  name: "actions-scratch",
  args: ["--scratch"],
  run: runScratch,
};
