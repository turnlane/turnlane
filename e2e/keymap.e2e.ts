/**
 * キーの割り当ての変更（D-077。ux-mvp 6.2）の E2E: 設定のキーボードで記録するとすぐ保存して効く。
 * - 「Inbox へ」の g i を外して g n、「AI へ」に v を足すと、保存のボタンを押さずに別の画面で効き、元のキーは効かない
 * - 設定に戻っても、ページを読み直しても残る（保存先はデーモンの設定 `ui.keybindings`）
 * - 衝突するキー（g b は「ボードへ」）は保存せず、行の横に相手を出す
 */
import type { Ctx, Suite } from "./harness.ts";

const flat = (s: string) => s.replace(/\s+/g, " ");
type Prefs = { keybindings: Record<string, string[]> };

async function run(t: Ctx) {
  const { page, board } = t;
  const at = (path: string) => board.url.replace(/next=[^&]*/, `next=${encodeURIComponent(path)}`);
  /** その画面で keys を押して、URL が re になるか */
  const goesTo = async (keys: string[], re: RegExp) => {
    for (const k of keys) await page.keyboard.press(k);
    return page
      .waitForURL(re, { timeout: 2500 })
      .then(() => true)
      .catch(() => false);
  };
  const inbox = page.getByTestId("key-goInbox");
  const ai = page.getByTestId("key-goAi");
  const openKeyboard = async () => {
    await page.locator('[data-section="keyboard"]').first().click();
    await inbox.waitFor({ timeout: 10_000 });
  };

  await page.goto(at("/settings#keyboard"));
  await inbox.waitFor({ timeout: 10_000 });

  // 記録するとすぐ保存する（保存のボタンは無い）
  await inbox.getByRole("button", { name: "Remove g i" }).click();
  await page.getByTestId("record-goInbox").click();
  await page.keyboard.press("g");
  await page.keyboard.press("n");
  await page.getByTestId("record-goAi").click();
  await page.keyboard.press("v");
  await page.waitForTimeout(1500);
  const rows = `${flat(await inbox.innerText())} | ${flat(await ai.innerText())}`;
  t.check(
    "recording shows the new keys in the rows",
    rows.includes("g n") && !rows.includes("g i") && /\bv\b/.test(rows),
    rows,
  );
  t.check(
    "there is no Save button",
    (await page.getByRole("button", { name: "Save", exact: true }).count()) === 0,
  );
  const saved = await board.api<Prefs>("GET", "/settings/ui");
  t.check(
    "the change is stored in the daemon right away",
    JSON.stringify(saved.keybindings) === JSON.stringify({ goInbox: ["g n"], goAi: ["g a", "v"] }),
    JSON.stringify(saved.keybindings),
  );

  // 別の画面で効く・元のキーは効かない
  await page.keyboard.press("g");
  await page.keyboard.press("y");
  await page.waitForURL(/\/queue/, { timeout: 3000 }).catch(() => {});
  t.check("the old key g i no longer works", !(await goesTo(["g", "i"], /\/inbox/)), page.url());
  t.check("the new key g n works on another screen", await goesTo(["g", "n"], /\/inbox/));
  t.check("the new single key v works", await goesTo(["v"], /\/ai/), page.url());

  // 設定に戻っても残る
  await page.keyboard.press("g");
  await page.keyboard.press("s");
  await page.waitForURL(/\/settings/, { timeout: 3000 }).catch(() => {});
  await openKeyboard();
  const back = flat(await inbox.innerText());
  t.check("after leaving settings and coming back the change is kept", back.includes("g n"), back);

  // 読み直しても残る
  await page.goto(at("/queue"));
  await page.waitForTimeout(800);
  t.check("after reload the new key still works", await goesTo(["g", "n"], /\/inbox/), page.url());
  await page.goto(at("/settings#keyboard"));
  await inbox.waitFor({ timeout: 10_000 });
  await page.waitForTimeout(500);
  const reloaded = flat(await inbox.innerText());
  t.check("after reload the settings show the change", reloaded.includes("g n"), reloaded);

  // 衝突: g b（ボードへ）は保存しない。行の横に相手を出す
  await page.getByTestId("record-goInbox").click();
  await page.keyboard.press("g");
  await page.keyboard.press("b");
  await page.waitForTimeout(500);
  const conflictRow = flat(await inbox.innerText());
  t.check(
    "a conflicting key shows the other action next to the row",
    conflictRow.includes("g b is also “Go to Board”"),
    conflictRow,
  );
  const after = await board.api<Prefs>("GET", "/settings/ui");
  t.check(
    "a conflicting key is not saved",
    JSON.stringify(after.keybindings.goInbox) === JSON.stringify(["g n"]),
    JSON.stringify(after.keybindings),
  );
}

export const keymapSuite: Suite = { name: "keymap", args: ["--lang", "en"], run };
