/**
 * IME の変換確定の ⏎ を、Chrome 型・WebKit 型のイベント列で再現して各入力欄を確かめる（lib/ime.ts）。
 * 変換確定の ⏎ で登録・実行・移動せず、その後の ⏎ で登録することを見る。画面は日本語（--lang ja）。
 * あわせて、題名の編集（詳細パネル・r）で変換確定の直後に ⏎ / 欄を離れて保存しても末尾の文字が欠けないこと
 * （変換中に欄を離れ、確定が後から届く場合を含む）を、保存された題名で確かめる
 */
import type { Page } from "playwright";
import type { Ctx, Suite } from "./harness.ts";

type Seq = "chrome" | "webkit229" | "webkit13" | "chromeEsc";

async function ime(page: Page, seq: Seq) {
  await page.evaluate((seq) => {
    const el = document.activeElement as HTMLElement;
    const comp = (type: string) =>
      el.dispatchEvent(new CompositionEvent(type, { bubbles: true, data: "てすと" }));
    const key = (key: string, keyCode: number, isComposing: boolean) => {
      const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, isComposing });
      Object.defineProperty(e, "keyCode", { get: () => keyCode });
      Object.defineProperty(e, "which", { get: () => keyCode });
      el.dispatchEvent(e);
    };
    if (seq === "chrome") {
      key("Process", 229, false);
      comp("compositionstart");
      key("Process", 229, true);
      key("Enter", 229, true);
      comp("compositionend");
    } else if (seq === "chromeEsc") {
      comp("compositionstart");
      key("Escape", 229, true);
      comp("compositionend");
    } else {
      comp("compositionstart");
      comp("compositionend");
      key("Enter", seq === "webkit229" ? 229 : 13, false);
    }
  }, seq);
  await page.waitForTimeout(250);
}

type CommitThen = "none" | "blur" | "blurBeforeCommit";

/**
 * 末尾に変換中の文字（add）を入れて確定する。DOM の値を変えて input（isComposing）を送り、Chrome 型 / WebKit 型の順で
 * compositionend と keydown を送る。then = blur は確定の直後に同じ打鍵で欄を離れる。blurBeforeCommit は変換中に
 * 欄を離れ、確定（最後の文字の input と compositionend）が後から届く
 */
async function composeCommit(
  page: Page,
  add: string,
  order: "chrome" | "webkit",
  then: CommitThen,
) {
  await page.evaluate(
    async ({ add, order, then }) => {
      const el = document.activeElement as HTMLInputElement | HTMLTextAreaElement;
      const proto =
        el instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
      const set = Object.getOwnPropertyDescriptor(proto, "value")?.set as (v: string) => void;
      const base = el.value;
      const input = (text: string, isComposing: boolean) => {
        set.call(el, base + text);
        el.dispatchEvent(
          new InputEvent("input", {
            bubbles: true,
            isComposing,
            inputType: isComposing ? "insertCompositionText" : "insertFromComposition",
            data: text,
          }),
        );
      };
      const key = (keyCode: number, isComposing: boolean) => {
        const e = new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
          isComposing,
        });
        Object.defineProperty(e, "keyCode", { get: () => keyCode });
        el.dispatchEvent(e);
      };
      const end = () =>
        el.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: add }));
      el.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
      if (then === "blurBeforeCommit") {
        input(add.slice(0, -1), true);
        el.blur();
        await new Promise((r) => setTimeout(r, 30));
        input(add, false);
        end();
        return;
      }
      input(add, true);
      if (order === "chrome") {
        key(229, true);
        end();
      } else {
        end();
        key(229, false);
      }
      if (then === "blur") el.blur();
    },
    { add, order, then },
  );
}

async function tasksNamed(page: Page, title: string): Promise<number> {
  return page.locator(`[data-kind="task"]`, { hasText: title }).count();
}

async function run(t: Ctx) {
  const { engine, page } = t;
  const base = t.board.base;
  const check = (name: string, ok: boolean, note?: string) => t.check(name, ok, note);
  await page.goto(t.board.url);
  await page.waitForURL(/\/board/);
  await page.waitForTimeout(800);

  // 1) Inbox の + Add
  for (const seq of ["chrome", "webkit229", "webkit13"] as const) {
    await page.goto(`${base}/inbox`);
    const add = page.getByRole("textbox", { name: "+ 追加" });
    await add.click();
    const title = `IME追加-${engine}-${seq}`;
    await add.fill(title);
    await ime(page, seq);
    const kept = (await add.inputValue()) === title;
    const created = await tasksNamed(page, title);
    check(`Inbox + Add / ${seq}: 変換確定で登録しない`, kept && created === 0);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(600);
    check(
      `Inbox + Add / ${seq}: その後の ⏎ で登録する`,
      (await add.inputValue()) === "" && (await tasksNamed(page, title)) === 1,
    );
  }

  // 2) c の新規タスク（ポップオーバー）と変換中の Esc
  await page.goto(`${base}/board`);
  await page.waitForTimeout(600);
  for (const seq of ["chrome", "webkit229", "webkit13"] as const) {
    await page.locator("body").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("c");
    const box = page.getByPlaceholder(/新しいタスク/);
    await box.waitFor();
    const title = `IME新規-${engine}-${seq}`;
    await box.fill(title);
    await ime(page, seq);
    check(
      `c 新規タスク / ${seq}: 変換確定で登録しない`,
      (await box.count()) === 1 && (await box.inputValue()) === title,
    );
    if (seq === "chrome") {
      await ime(page, "chromeEsc");
      check("c 新規タスク: 変換中の Esc でポップオーバーを閉じない", (await box.count()) === 1);
    }
    await page.keyboard.press("Enter");
    await page.waitForTimeout(600);
    check(
      `c 新規タスク / ${seq}: その後の ⏎ で登録する`,
      (await box.count()) === 0 && (await tasksNamed(page, title)) >= 1,
    );
  }

  // 3) ⌘K（新規タスクのモードを含むパレット）
  await page.keyboard.press("Meta+k");
  const pal = page.getByTestId("command-palette");
  await pal.waitFor();
  await page.keyboard.insertText("しんき");
  for (const seq of ["chrome", "webkit229", "webkit13"] as const) {
    await ime(page, seq);
    check(`⌘K / ${seq}: 変換確定で実行しない`, (await pal.count()) === 1);
  }
  await page.keyboard.press("Escape");

  // 4) クイック入力
  for (const seq of ["chrome", "webkit229", "webkit13"] as const) {
    await page.goto(`${base}/quick-add`);
    const q = page.locator("input").first();
    await q.click();
    const title = `IMEクイック-${engine}-${seq}`;
    await q.fill(title);
    await ime(page, seq);
    check(`クイック入力 / ${seq}: 変換確定で登録しない`, (await q.inputValue()) === title);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(400);
    check(`クイック入力 / ${seq}: その後の ⏎ で登録する`, (await q.inputValue()) === "");
  }

  // 5) 設定の検索（⏎ で最初の候補へ移る）
  for (const seq of ["chrome", "webkit229", "webkit13"] as const) {
    await page.goto(`${base}/settings`);
    const s = page.getByTestId("settings-search");
    await s.click();
    await s.fill("カレンダー");
    await page.waitForTimeout(200);
    const before = page.url();
    await ime(page, seq);
    check(
      `設定の検索 / ${seq}: 変換確定で移動しない`,
      page.url() === before && (await s.inputValue()) === "カレンダー",
    );
  }

  // 6) タスクの詳細パネルの題名（⏎ で確定して欄を離れる）
  await page.goto(`${base}/inbox`);
  await page.waitForTimeout(500);
  const row = page.locator(`[data-kind="task"]`, { hasText: `IME追加-${engine}-chrome` }).first();
  await row.click();
  await page.keyboard.press("ArrowRight");
  const ta = page.locator("textarea").first();
  await ta.waitFor({ timeout: 3000 }).catch(() => {});
  if ((await ta.count()) > 0) {
    for (const seq of ["chrome", "webkit229", "webkit13"] as const) {
      await ta.click();
      await ime(page, seq);
      const focused = await ta.evaluate((el) => document.activeElement === el);
      check(`詳細パネルの題名 / ${seq}: 変換確定で欄を離れない`, focused);
    }
    await page.keyboard.press("Enter");
    await page.waitForTimeout(200);
    check(
      "詳細パネルの題名: その後の ⏎ で確定して欄を離れる",
      !(await ta.evaluate((el) => document.activeElement === el)),
    );
  } else check("詳細パネルの題名", false, "パネルが開かなかった");

  // 7) 題名の編集で、変換確定の直後に ⏎ / 欄を離れて保存しても末尾が欠けない（保存された題名で見る）
  type Created = { task: { id: string } };
  type Detail = { task: { title: { t: string; text?: string } } };
  const saved = async (id: string) =>
    (await t.board.api<Detail>("GET", `/tasks/${id}`)).task.title.text ?? "";
  const cases: [string, "chrome" | "webkit", CommitThen][] = [
    ["chrome-enter", "chrome", "none"],
    ["webkit-enter", "webkit", "none"],
    ["chrome-blur", "chrome", "blur"],
    ["webkit-blur", "webkit", "blur"],
    ["blur-before-commit", "webkit", "blurBeforeCommit"],
  ];
  for (const [name, order, then] of cases) {
    // 詳細パネルの題名
    const orig = `末尾-${engine}-${name}-ドメインを取得`;
    const { task } = await t.board.api<Created>("POST", "/tasks", { raw: orig });
    await page.goto(`${base}/inbox`);
    await page.waitForTimeout(400);
    await page.locator(`[data-kind="task"]`, { hasText: orig }).first().click();
    await page.keyboard.press("ArrowRight");
    const area = page.locator("textarea").first();
    await area.waitFor({ timeout: 3000 });
    await area.click();
    await area.evaluate((el: HTMLTextAreaElement) =>
      el.setSelectionRange(el.value.length, el.value.length),
    );
    await composeCommit(page, "する", order, then);
    if (then === "none") {
      await page.waitForTimeout(150);
      await page.keyboard.press("Enter");
    }
    await page.waitForTimeout(700);
    const p = await saved(task.id);
    check(`詳細パネルの題名 / ${name}: 末尾が欠けない`, p === `${orig}する`, p);
    // r の題名の変更（⏎ で確定。欄を離れると閉じるだけなので ⏎ の場合だけ）
    if (then !== "none") continue;
    const base2 = `末尾r-${engine}-${name}-ドメインを取得`;
    const r2 = await t.board.api<Created>("POST", "/tasks", { raw: base2 });
    await page.goto(`${base}/inbox`);
    await page.waitForTimeout(400);
    await page.locator(`[data-kind="task"]`, { hasText: base2 }).first().click();
    await page.keyboard.press("r");
    const box = page.getByTestId("prompt-input");
    await box.waitFor();
    await box.evaluate((el: HTMLInputElement) =>
      el.setSelectionRange(el.value.length, el.value.length),
    );
    await composeCommit(page, "する", order, "none");
    await page.waitForTimeout(150);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(700);
    const q = await saved(r2.task.id);
    check(`r の題名 / ${name}: 末尾が欠けない`, q === `${base2}する`, q);
  }
}

export const imeSuite: Suite = { name: "ime", args: ["--lang", "ja"], run };
