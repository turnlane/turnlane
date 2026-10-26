/**
 * 入力欄の中の編集のキー（記録のメモで ⌘Z が効かなかった不具合の回帰テスト）:
 * - 記録のパネルのメモで、文を入れる → 一部を消す → ⌘Z で戻る → ⇧⌘Z でまた消える
 * - デスクトップアプリの Edit メニューの取り消し・やり直し（Rust が呼ぶ `window.__turnlaneEdit`）でも同じに動く
 * - 入力中は画面のキー（a・g の2打鍵・?・⌘⌫ など）が画面を切り替えず、文字の編集になる。Esc と少数の画面のキー
 *   （⌘K・⌘1〜3・⌘\）だけは画面が受ける
 * - メモにフォーカスしたまま Esc でパネルを閉じても、書いた文が保存される
 *
 * dev-board の既定のデータ: 今は 2026-10-02（金）13:20 JST
 */
import type { Locator } from "playwright";
import type { Ctx, Suite } from "./harness.ts";

const TODAY = "2026-10-02";

async function selectRange(el: Locator, start: number, end: number) {
  await el.evaluate((n, r) => (n as HTMLInputElement).setSelectionRange(r.start, r.end), {
    start,
    end,
  });
}

/**
 * メモに保存済みの文（取り消しの履歴の外）を置いてから記録のパネルを開き、メモにフォーカスする。
 * Playwright の WebKit は ⌘Z を1回押すと取り消しを2回行うので、履歴を1段にしてから確かめる
 */
async function openMemo(t: Ctx, note: string) {
  const { page, board } = t;
  await board.api("PUT", `/daily-notes/${TODAY}`, { note: note || null });
  await page.goto(`${board.base}/day`);
  await page.waitForSelector('[data-testid="day-view"]');
  await page.getByTestId("open-record").click();
  const memo = page.getByTestId("record-memo");
  await memo.waitFor({ timeout: 10000 });
  await page.waitForFunction(
    (v) => (document.querySelector('[data-testid="record-memo"]') as HTMLInputElement)?.value === v,
    note,
  );
  await memo.click();
  return memo;
}

async function memoUndo(t: Ctx) {
  const { page } = t;
  const memo = await openMemo(t, "alpha beta gamma");
  // 最後の語を選んで ⌫ で消す → ⌘Z で戻る → ⇧⌘Z でまた消える
  await selectRange(memo, 11, 16);
  await page.keyboard.press("Backspace");
  const deleted = await memo.inputValue();
  await page.keyboard.press("Meta+z");
  const undone = await memo.inputValue();
  await page.keyboard.press("Meta+Shift+z");
  const redone = await memo.inputValue();
  t.check(
    "memo: ⌘Z brings back the deleted text, ⇧⌘Z deletes it again",
    deleted === "alpha beta " && undone === "alpha beta gamma" && redone === "alpha beta ",
    JSON.stringify({ deleted, undone, redone }),
  );
  // ⌘⌫（行頭まで消す）も欄の中の編集（一覧の「削除」に取られない）で、⌘Z で戻る
  await page.keyboard.press("Meta+Backspace");
  const cleared = await memo.inputValue();
  await page.keyboard.press("Meta+z");
  const back = await memo.inputValue();
  t.check(
    "memo: ⌘⌫ deletes to the line start and ⌘Z brings the text back",
    cleared === "" && back.startsWith("alpha beta"),
    JSON.stringify({ cleared, back }),
  );
}

/** デスクトップアプリの Edit メニュー（WKWebView ではメニューのキーが先に取るので、Rust が __turnlaneEdit を呼ぶ） */
async function menuUndo(t: Ctx) {
  const { page } = t;
  const memo = await openMemo(t, "one two three");
  await selectRange(memo, 8, 13);
  await page.keyboard.press("Backspace");
  const edit = (cmd: "undo" | "redo") =>
    page.evaluate(
      (cmd) => (window as unknown as { __turnlaneEdit: (c: string) => void }).__turnlaneEdit(cmd),
      cmd,
    );
  await edit("undo");
  const undone = await memo.inputValue();
  await edit("redo");
  const redone = await memo.inputValue();
  t.check(
    "memo: the Edit menu's Undo / Redo (desktop app) undo and redo the typing",
    undone === "one two three" && redone === "one two ",
    JSON.stringify({ undone, redone }),
  );
}

/** 入力中の画面のキーは素通り（Esc と ⌘K などの少数の画面のキーだけ画面が受ける） */
async function typingKeys(t: Ctx) {
  const { page } = t;
  const memo = await openMemo(t, "");
  await page.keyboard.type("a g b ? w");
  await page.waitForTimeout(300);
  const path = new URL(page.url()).pathname;
  t.check(
    "typing: a / g b / ? / w in the memo do not change the screen",
    path === "/day" &&
      (await memo.inputValue()) === "a g b ? w" &&
      (await page.getByTestId("record-panel").count()) === 1 &&
      (await page.locator('[role="dialog"]').count()) === 0 &&
      (await page.locator("[data-grid]").first().getAttribute("data-grid")) === TODAY,
    JSON.stringify({ path, v: await memo.inputValue() }),
  );
  // ⌘A は欄の中の全選択
  await page.keyboard.press("Meta+a");
  const sel = await memo.evaluate((el) => {
    const i = el as HTMLInputElement;
    return [i.selectionStart, i.selectionEnd, i.value.length];
  });
  t.check("typing: ⌘A selects the memo's text", sel[0] === 0 && sel[1] === sel[2], String(sel));
  // ⌘K は入力中でもコマンドパレットを開く（Esc で閉じる）
  await page.keyboard.press("Meta+k");
  const palette = await page
    .getByTestId("command-palette")
    .waitFor({ timeout: 2000 })
    .then(() => true)
    .catch(() => false);
  t.check("typing: ⌘K in the memo opens the command palette", palette);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  // Esc は画面が受ける（パネルを閉じる）
  await memo.click();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  t.check(
    "typing: Esc still reaches the screen (closes the record panel)",
    (await page.getByTestId("record-panel").count()) === 0,
  );
}

/** メモにフォーカスしたまま Esc でパネルを閉じても、書いた文は保存されている（開き直すと残っている） */
async function memoSavedOnClose(t: Ctx) {
  const { page, board } = t;
  await openMemo(t, "");
  await page.keyboard.type("keep this line");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  const closed = (await page.getByTestId("record-panel").count()) === 0;
  await page.getByTestId("open-record").click();
  const memo = page.getByTestId("record-memo");
  await memo.waitFor({ timeout: 10000 });
  const kept = await page
    .waitForFunction(
      () =>
        (document.querySelector('[data-testid="record-memo"]') as HTMLInputElement)?.value ===
        "keep this line",
      undefined,
      { timeout: 5000 },
    )
    .then(() => true)
    .catch(() => false);
  const saved = await board.api<{ report: { note: string | null } }>(
    "GET",
    `/reports/daily/${TODAY}?lang=en`,
  );
  t.check(
    "memo: typing then Esc (closing the panel with the memo focused) keeps the text",
    closed && kept && saved.report.note === "keep this line",
    JSON.stringify({ closed, v: await memo.inputValue(), note: saved.report.note }),
  );
}

async function run(t: Ctx) {
  await t.page.goto(t.board.url);
  await t.page.waitForSelector(`[data-grid="${TODAY}"]`);
  await memoUndo(t);
  await menuUndo(t);
  await typingKeys(t);
  await memoSavedOnClose(t);
}

export const editingSuite: Suite = { name: "editing", args: [], run };
