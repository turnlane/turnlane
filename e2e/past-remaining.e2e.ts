/**
 * 「過去から N 件」（0.8.2）: dev-board の固定データでは、昨日に 2 件（Draft newsletter は時間ブロックに置いたまま、
 * Clean up downloads は未定）、3 週間前に 2 件（Renew the domain・Order a new keyboard）が残っている。
 * デイビューと 3 日ボードの今日の「未定」の直下に 1 行で出て、開くと日付ごと（新しい順）に並ぶ。「すべて今日へ」で今日の
 * 未定へ移り、元に戻せる。0 件なら行ごと出ない
 */
import type { Page } from "playwright";
import type { BoardResponse } from "../packages/core/src/api/index.ts";
import type { Ctx, Suite } from "./harness.ts";

async function settle(page: Page, ms = 300) {
  await page.waitForTimeout(ms);
}

async function run(t: Ctx) {
  const { page, board } = t;
  const today = (await board.api<{ today: string }>("GET", "/inbox")).today;
  const col = async () =>
    (await board.api<BoardResponse>("GET", `/board?from=${today}&to=${today}`)).days[0];
  const before = (await col())?.pastRemaining ?? [];
  t.check(
    "API: today's column lists the tasks left on earlier days, newest date first",
    before.length === 2 &&
      before[0]?.tasks.map((x) => x.title.t === "text" && x.title.text).join(",") ===
        "Draft newsletter,Clean up downloads" &&
      (before[1]?.tasks.length ?? 0) === 2 &&
      (before[0]?.date ?? "") > (before[1]?.date ?? ""),
    JSON.stringify(before.map((g) => [g.date, g.tasks.length])),
  );

  for (const [name, path] of [
    ["day view", "/day"],
    ["3-day board", "/board"],
  ] as const) {
    await page.goto(board.url.replace(/next=[^&]*/, `next=${encodeURIComponent(path)}`));
    const row = page.getByTestId("past-remaining").first();
    await row.waitFor({ timeout: 15000 });
    await settle(page);
    const text = await row.innerText();
    // デイビューで開く前は畳んでいる（3 日ボードはデイビューで開いた状態を引き継ぐ）
    const folded = (await page.getByTestId("past-remaining-day").count()) === 0;
    t.check(
      `${name}: “4 from earlier days” and “Move all to today”${name === "day view" ? ", folded" : ""}`,
      text.includes("4 from earlier days") &&
        text.includes("Move all to today") &&
        (name === "day view" ? folded : true),
      text,
    );
    if (name === "day view") {
      await page.getByTestId("past-remaining-toggle").first().click();
      await settle(page);
      const days = page.getByTestId("past-remaining-day");
      const dates = await days.evaluateAll((els) => els.map((e) => e.getAttribute("data-date")));
      const first = await days.first().innerText();
      t.check(
        "day view: opened, one heading per date (newest first) with the tasks under it",
        dates.length === 2 &&
          (dates[0] ?? "") > (dates[1] ?? "") &&
          first.includes("Draft newsletter") &&
          first.includes("Clean up downloads"),
        `${JSON.stringify(dates)} ${first.replace(/\s+/g, " ")}`,
      );
      // 開いたままの状態はセッションの中で保つ（3 日ボードでも開いている）
    } else {
      t.check(
        "3-day board: stays open in the same session",
        (await page.getByTestId("past-remaining-day").count()) === 2,
      );
    }
  }

  // すべて今日へ → 今日の未定へ。元に戻す
  await page.getByTestId("past-remaining-carry").first().click();
  const toast = page.getByRole("status").filter({ hasText: "today" }).first();
  await toast.waitFor({ timeout: 5000 }).catch(() => {});
  await settle(page, 600);
  const after = await col();
  const unscheduled = (after?.tasks ?? []).filter(
    (x) =>
      x.title.t === "text" && ["Renew the domain", "Clean up downloads"].includes(x.title.text),
  );
  t.check(
    "Move all to today: they are in today's Unscheduled and the row is gone",
    (after?.pastRemaining ?? []).length === 0 &&
      unscheduled.length === 2 &&
      (await page.getByTestId("past-remaining").count()) === 0,
    JSON.stringify(after?.pastRemaining?.length),
  );
  const toastText = await toast.innerText().catch(() => "");
  t.check(
    "toast: “4 moved to today” with Undo",
    /4/.test(toastText) && /Undo/.test(toastText),
    toastText,
  );
  await toast.getByRole("button", { name: "Undo" }).click();
  await settle(page, 800);
  const back = (await col())?.pastRemaining ?? [];
  t.check(
    "Undo: back on their own dates",
    JSON.stringify(back.map((g) => [g.date, g.tasks.length])) ===
      JSON.stringify(before.map((g) => [g.date, g.tasks.length])),
    JSON.stringify(back.map((g) => [g.date, g.tasks.length])),
  );
  await page.getByTestId("past-remaining").first().waitFor({ timeout: 5000 });
  t.check("the row is back", (await page.getByTestId("past-remaining").count()) > 0);
}

export const pastRemainingSuite: Suite = {
  name: "past-remaining",
  args: ["--lang", "en"],
  run,
};
