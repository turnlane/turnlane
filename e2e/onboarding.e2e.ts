/**
 * オンボーディング O2〜O8（onboarding.md 3・4章、M6-21〜M6-26）の E2E。dev-onboarding（一時 HOME・偽の時計・偽の
 * カレンダー・偽のアプリ・同意の前の新しい利用者）で、ボードを開くと O2 に回され、直近7日を取り込み、カレンダーの許可・
 * hooks・MCP・計画の目安・通知を通って、O8 の「ボードを開く」でボードに着く（state=done）。
 * D-184（O2 に戻るが無い、全部外したら主ボタンを押せない）と D-181（主ボタンの文言、本文は保存も送信もしない）、
 * D-192（O8 の主ボタンは常にボード）も見る。hooks と MCP は一時 HOME の設定ファイルにだけ書く
 */
import type { OnboardingView } from "../packages/core/src/api/index.ts";
import type { Ctx, Suite } from "./harness.ts";

async function run(t: Ctx) {
  const { page, board } = t;
  await page.goto(board.url.replace(/next=[^&]*/, "next=%2Fboard"));
  await page.waitForSelector("[data-source]");
  t.check(
    "a new user is sent to the onboarding (O2)",
    new URL(page.url()).pathname === "/onboarding",
  );
  const body = await page.locator("body").innerText();
  t.check(
    "O2 copy: 7 days only, no Cowork, no 30 days",
    body.includes("Import the last 7 days") &&
      body.includes("84 sessions in 7 days") &&
      !body.includes("Cowork") &&
      !/30 days/.test(body),
  );
  t.check("O2 has no Back (D-184)", (await page.getByTestId("onb-back").count()) === 0);
  const boxes = page.locator('[data-source] [role="checkbox"]');
  t.check("three sources are found", (await boxes.count()) === 3);
  for (const b of await boxes.all()) await b.click();
  t.check(
    "all unchecked: the primary is disabled and the line says Not now skips (D-184)",
    (await page.getByTestId("onb-import").isDisabled()) &&
      (await page.locator('[data-part="note"]').innerText()).startsWith("Nothing selected."),
  );
  for (const b of await boxes.all()) await b.click();

  // ⏎ で取り込む → O3
  await page.keyboard.press("Enter");
  await page.waitForSelector('[data-part="columns"]');
  const v = await board.api<OnboardingView>("GET", "/onboarding");
  t.check("consent is recorded and the step is import", v.consented && v.step === "import");
  t.check(
    "the step bar marks Sources done and Import current",
    (await page.locator('[data-step="sources"]').getAttribute("data-mark")) === "done" &&
      (await page.locator('[data-step="import"]').getAttribute("data-mark")) === "current",
  );
  const days = await page
    .locator("[data-day]")
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-day")));
  t.check(
    "newest day on the left",
    days[0] === "2026-10-02" && days[6] === "2026-09-26",
    days.join(","),
  );
  await page.waitForSelector('[data-part="days-done"] svg', { timeout: 20_000 });
  await page.waitForSelector('[data-part="summary"] span');
  const summary = await page.locator('[data-part="summary"]').innerText();
  t.check(
    "the summary line shows after all days are done",
    summary.startsWith("Last 7 days:"),
    summary,
  );
  t.check(
    "after done, Skip the rest is disabled and Continue is enabled",
    (await page.getByTestId("onb-skip-rest").isDisabled()) &&
      !(await page.getByTestId("onb-continue").isDisabled()),
  );
  t.check(
    "conversation text is never saved or sent",
    (await page.locator("body").innerText()).includes("Conversation text is never saved or sent."),
  );

  // ⌘[ で O2 に戻り、もう一度取り込むと O3
  await page.keyboard.press("Meta+BracketLeft");
  await page.waitForSelector("[data-source]");
  t.check("⌘[ goes back to Sources", (await page.getByTestId("onb-import").count()) === 1);
  await page.getByTestId("onb-import").click();
  await page.waitForSelector('[data-part="columns"]');

  // Continue → O4 カレンダー
  await page.getByTestId("onb-continue").click();
  await page.waitForSelector('[data-testid="onb-calendar-primary"]');
  t.check(
    "O3 Continue goes to O4 (calendar), with Back",
    (await board.api<OnboardingView>("GET", "/onboarding")).step === "calendar" &&
      (await page.getByTestId("onb-back").count()) === 1,
  );
  // ⌘[ で O3 に戻り、Continue でまた O4
  await page.keyboard.press("Meta+BracketLeft");
  await page.waitForSelector('[data-testid="onb-continue"]');
  await page.getByTestId("onb-continue").click();
  await page.waitForSelector('[data-testid="onb-calendar-primary"]');
  // 許可（偽のヘルパが許可を返す）→ カレンダー数が出て Continue
  await page.getByTestId("onb-calendar-primary").click();
  await page.waitForSelector('[data-testid="onb-calendar-granted"]', { timeout: 20_000 });
  const granted = await page.getByTestId("onb-calendar-granted").innerText();
  t.check(
    "O4 shows the calendars found and the default",
    /3 calendars found/.test(granted) && /is your default/.test(granted),
    granted,
  );
  t.check("after access, Not now is gone", (await page.getByTestId("onb-not-now").count()) === 0);
  await page.getByTestId("onb-calendar-primary").click();

  // O5 hooks: 差分 → 入れる → Claude は installed、Codex は承認待ち → Continue
  await page.waitForSelector('[data-target][data-state="plan"]');
  const plan = await page.locator('[data-part="targets"]').innerText();
  t.check(
    "O5 lists each config folder with the entries to add",
    (await page.locator("[data-target]").count()) === 3 &&
      /adds \d+ entries to settings\.json/.test(plan),
    plan,
  );
  await page.getByTestId("onb-show-changes").click();
  t.check(
    "Show changes lists the files and the command",
    /--managed-by turnlane/.test(await page.locator('[data-part="changes"]').innerText()),
  );
  await page.getByTestId("onb-hooks-primary").click();
  await page.waitForSelector('[data-target][data-state="pending"]', { timeout: 20_000 });
  t.check(
    "after install: Claude Code installed, Codex waiting for /hooks approval",
    (await page.locator('[data-target][data-state="installed"]').count()) === 2 &&
      (await page.locator('[data-target][data-state="pending"]').count()) === 1,
  );
  await page.getByTestId("onb-hooks-primary").click();

  // O5a AI tools（MCP）: 登録 → Continue
  await page.waitForSelector('[data-target][data-state="plan"]');
  t.check(
    "O5a lists the MCP targets",
    (await page.locator("[data-target]").count()) === 3 &&
      (await board.api<OnboardingView>("GET", "/onboarding")).step === "mcp",
  );
  await page.getByTestId("onb-mcp-primary").click();
  await page.waitForSelector('[data-target][data-state="installed"] [data-mark="done"]', {
    timeout: 20_000,
  });
  await page.getByTestId("onb-mcp-primary").click();

  // O6 計画の目安: 土曜を稼働日にして Continue
  await page.waitForSelector('[data-part="hours"]');
  t.check(
    "O6 shows holidays from the calendar and no working-hours wording",
    /Japan Holidays/.test(await page.locator('[data-part="holidays"]').innerText()) &&
      !/working hours/i.test(await page.locator("body").innerText()),
  );
  await page.locator('[data-day="sat"]').click();
  await page.waitForTimeout(300);
  const weekdays = await board.api<{ value: number[] }>("GET", "/config/workdays.weekdays");
  t.check(
    "toggling Saturday saves the workdays",
    weekdays.value.includes(6),
    weekdays.value.join(","),
  );
  await page.getByTestId("onb-hours-continue").click();

  // O7 通知: 偽のアプリが許可を返す → Continue
  await page.waitForSelector('[data-testid="onb-notify-primary"]');
  await page.getByTestId("onb-notify-primary").click();
  await page.waitForSelector('[data-testid="onb-notify-on"]', { timeout: 20_000 });
  await page.getByTestId("onb-notify-primary").click();

  // O8: 行と主ボタン（常に「ボードを開く」。朝の計画は無い。D-192）
  await page.waitForSelector('[data-part="summary-rows"] [data-row="notifications"]');
  const marks = Object.fromEntries(
    await page
      .locator("[data-row]")
      .evaluateAll((els) =>
        els.map((e) => [e.getAttribute("data-row"), e.getAttribute("data-mark")]),
      ),
  );
  t.check(
    "O8 rows: import done, calendar done, hooks waiting (Codex), mcp done, notifications done",
    marks.import === "done" &&
      marks.calendar === "done" &&
      marks.hooks === "waiting" &&
      marks.mcp === "done" &&
      marks.notifications === "done",
    JSON.stringify(marks),
  );
  const o8 = await page.locator("body").innerText();
  t.check(
    "O8: no Install ▸ for the developer install (M6-15)",
    (await page.getByTestId("onb-install-cli").count()) === 0,
  );
  t.check(
    "O8 has one primary (Open the board) and no Plan today",
    o8.includes("Open the board") && !/Plan today/.test(o8),
  );
  await page.getByTestId("onb-open-board").click();
  await page.waitForURL(/\/board/);
  const done = await board.api<OnboardingView>("GET", "/onboarding");
  t.check("Open the board finishes the flow (state=done)", done.state === "done");
}

export const onboardingSuite: Suite = {
  name: "onboarding",
  script: "scripts/dev-onboarding.ts",
  args: ["--state", "o2", "--lang", "en", "--calendar", "granted", "--desktop", "ask-grant"],
  run,
};

/**
 * 配布版（install.json の app。M6-15）: O8 の Install ▸ で ~/.local/bin/turnlane のリンクを作る（一時 HOME）。
 * O2 の Choose a folder… はアプリの IPC（desktop_setup の chooseFolder）で選んだフォルダを足す（偽の IPC）
 */
async function runApp(t: Ctx) {
  const { page, board } = t;
  await page.goto(board.url);
  await page.waitForSelector('[data-testid="onb-install-cli"]');
  await page.getByTestId("onb-install-cli").click();
  await page.waitForSelector('[data-cli="installed"]');
  const st = await board.api<{ cli: { localBin: { linked: boolean; inPath: boolean } } }>(
    "GET",
    "/install",
  );
  t.check(
    "O8 Install ▸ links ~/.local/bin/turnlane to the app's turnlane",
    st.cli.localBin.linked && st.cli.localBin.inPath,
  );
  t.check(
    "O8 shows installed in ~/.local/bin",
    (await page.locator('[data-part="cli"]').innerText()).includes("installed in ~/.local/bin"),
  );
}

export const onboardingAppSuite: Suite = {
  name: "onboarding-app",
  script: "scripts/dev-onboarding.ts",
  args: ["--state", "o8", "--lang", "en", "--install", "app", "--desktop", "granted"],
  run: runApp,
};

/**
 * O4 で許可のダイアログを出せなかった（authorize が 1 で終わった。2026-10-21 の Neo）: 待ち続けずに理由と
 * Try again・Open System Settings・Not now を出す。Try again でもう一度始め、Not now で O5 へ
 */
async function runCalendarFail(t: Ctx) {
  const { page, board } = t;
  await page.goto(board.url);
  await page.waitForSelector('[data-testid="onb-calendar-primary"]');
  await page.getByTestId("onb-calendar-primary").click();
  await page.waitForSelector('[data-testid="onb-calendar-failed"]', { timeout: 15_000 });
  const box = await page.getByTestId("onb-calendar-failed").innerText();
  t.check(
    "O4 shows the reason from turnlane calendar authorize instead of waiting",
    box.includes("Couldn't show the macOS permission dialog") &&
      box.includes("macOS did not show the calendar access dialog"),
    box,
  );
  t.check(
    "O4 failure offers Open System Settings, Try again and Not now",
    (await page.getByTestId("onb-calendar-open-settings").count()) === 1 &&
      (await page.getByTestId("onb-calendar-primary").innerText()).includes("Try again") &&
      (await page.getByTestId("onb-not-now").innerText()).includes("Not now"),
  );
  await page.getByTestId("onb-calendar-primary").click();
  await page.waitForSelector('[data-testid="onb-calendar-failed"]', { state: "detached" });
  await page.waitForSelector('[data-testid="onb-calendar-failed"]', { timeout: 15_000 });
  t.check("Try again starts again and fails the same way", true);
  await page.getByTestId("onb-not-now").click();
  await page.waitForFunction(
    async () => (await (await fetch("/api/onboarding")).json()).step !== "calendar",
    undefined,
    { timeout: 10_000 },
  );
  const v = await board.api<OnboardingView>("GET", "/onboarding");
  t.check(
    "Not now skips the calendar step",
    v.steps.calendar === "skipped",
    JSON.stringify(v.steps),
  );
}

export const onboardingCalendarFailSuite: Suite = {
  name: "onboarding-calendar-fail",
  script: "scripts/dev-onboarding.ts",
  args: ["--state", "o4", "--lang", "en", "--calendar", "authorize-fail"],
  run: runCalendarFail,
};
