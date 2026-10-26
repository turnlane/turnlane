/**
 * E2E の実行（D-092）。`bun run e2e` が Web をビルドしてからこれを呼ぶ。
 *
 *   bun e2e/run.ts [--engine chromium|webkit] [--suite board-dnd|ime|events|focus|mouse|launch|actions|actions-scratch|ext|ext-none|panels|panel-resize|away|expired|answer|answer-grace|answer-lane|onboarding|onboarding-app|onboarding-calendar-fail|boot|editing|demo|ai|palette|later]
 *
 * 既定は全スイートを WebKit だけで走らせる（アプリの殻は WKWebView。D-196。スイートごとに新しい dev-board）。
 * Chromium は `--engine chromium` を指定したときだけ。
 * ブラウザが無ければ `bunx playwright install webkit`（Chromium も使うなら `chromium webkit`）で入れる。
 */
import { actionsScratchSuite, actionsSuite } from "./actions.e2e.ts";
import { aiSuite } from "./ai.e2e.ts";
import { answerGraceSuite, answerLaneSuite, answerSuite } from "./answer.e2e.ts";
import { awaySuite } from "./away.e2e.ts";
import { boardDnd } from "./board-dnd.e2e.ts";
import { bootSuite } from "./boot.e2e.ts";
import { dayListSuite } from "./day-list.e2e.ts";
import { demoSuite } from "./demo.e2e.ts";
import { editingSuite } from "./editing.e2e.ts";
import { eventsSuite } from "./events.e2e.ts";
import { expiredSuite } from "./expired.e2e.ts";
import { buildExtWeb, extNoneSuite, extSuite } from "./ext.e2e.ts";
import { focusSuite } from "./focus.e2e.ts";
import { type Engine, type Result, runSuite, type Suite } from "./harness.ts";
import { imeSuite } from "./ime.e2e.ts";
import { keymapSuite } from "./keymap.e2e.ts";
import { laterSuite } from "./later.e2e.ts";
import { launchSuite } from "./launch.e2e.ts";
import { mouseSuite } from "./mouse.e2e.ts";
import {
  onboardingAppSuite,
  onboardingCalendarFailSuite,
  onboardingSuite,
} from "./onboarding.e2e.ts";
import { paletteSuite } from "./palette.e2e.ts";
import { panelResizeSuite } from "./panel-resize.e2e.ts";
import { panelsSuite } from "./panels.e2e.ts";

const SUITES: Suite[] = [
  boardDnd,
  imeSuite,
  eventsSuite,
  focusSuite,
  keymapSuite,
  mouseSuite,
  launchSuite,
  actionsSuite,
  actionsScratchSuite,
  extSuite,
  extNoneSuite,
  panelsSuite,
  panelResizeSuite,
  editingSuite,
  awaySuite,
  expiredSuite,
  dayListSuite,
  answerSuite,
  answerGraceSuite,
  answerLaneSuite,
  onboardingSuite,
  onboardingAppSuite,
  onboardingCalendarFailSuite,
  bootSuite,
  demoSuite,
  aiSuite,
  paletteSuite,
  laterSuite,
];
const args = process.argv.slice(2);
const opt = (k: string) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : undefined;
};
const engines: Engine[] = opt("--engine") ? [opt("--engine") as Engine] : ["webkit"];
const suites = opt("--suite") ? SUITES.filter((s) => s.name === opt("--suite")) : SUITES;
if (suites.length === 0) throw new Error(`unknown suite: ${opt("--suite")}`);

// 拡張点（ADR 0015）: テスト用の拡張を組み込んだ Web を別のディレクトリにビルドする（apps/web/dist は拡張なしのまま）
if (suites.includes(extSuite)) buildExtWeb();

const results: Result[] = [];
for (const s of suites)
  for (const e of engines) {
    const r = await runSuite(s, e);
    for (const x of r)
      console.log(
        `${x.ok ? "PASS" : "FAIL"} [${x.suite}/${x.engine}] ${x.name}${x.note && !x.ok ? ` (${x.note})` : ""}`,
      );
    results.push(...r);
  }
const fail = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - fail} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
