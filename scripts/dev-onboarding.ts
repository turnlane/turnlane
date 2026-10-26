/**
 * 開発用: オンボーディング（O2〜O8）を確定デザインと同じダミーデータで動かす（M6-29。D-114 の見比べ用）。
 *
 *   bun run build:web && bun scripts/dev-onboarding.ts [--port 27318]
 *     [--state o2|o2-empty|o3-importing|o3-done|o4|o5|o5a|o6|o7|o8|board]
 *     [--lang en|ja] [--theme dark|light]
 *     [--calendar granted|slow|denied|none|fail|authorize-fail|hang]
 *                                                  O4 の主ボタンの結果（偽のヘルパ。既定 granted）。authorize-fail: ヘルパは
 *                                                  つながるがダイアログが出ずに authorize が 1 で終わる（2026-10-21 の Neo）。
 *                                                  hang: つながったまま決まらない（30 秒で失敗の案内）
 *     [--hooks none|broken]                        O5 の前の設定ファイル（broken: acme の settings.json が壊れている）
 *     [--desktop off|granted|denied|ask-grant|ask-deny]  デスクトップアプリの真似（O7・O8。既定 off = ブラウザ）
 *     [--skipped]                                  o8: カレンダー・hooks・AI tools・通知を全部飛ばした状態
 *     [--install dev|app]                          配置の方式（M6-15）。app は一時 HOME の中の偽の Turnlane.app で
 *                                                  動いている扱い（O8 の Install ▸ を出す。リンクは一時 HOME にだけ作る）
 *
 * - 一時 HOME（mkdtemp）に合成のセッションのファイルを書き、偽の時計（金 10/2 10:20、Asia/Tokyo）・偽の git・偽の
 *   カレンダーでデーモンを起動する。オンボーディングは済んでいない（新しい利用者と同じ）。実データ・launchd・
 *   ネットワーク・実のカレンダー・通知には触れない。hooks と MCP は一時 HOME の設定ファイルにだけ書く
 * - 取り込み元（確定画像のとおり）: ~/.claude（既定。直近7日で84件、最終は今日）、~/.claude-acme（12件、最終は3日前）、
 *   ~/.codex（18件、最終は昨日）。Claude Desktop がある扱い。リポジトリ・題名はすべて架空の値
 * - O3 の列の作業（題名・リポジトリ・ブランチ・長さ・PR）は確定画像の列に見えているものと同じ。それ以外のファイルは
 *   中身の無いセッション（検出の件数にだけ数わる）
 * - --state: o2 = 同意の前、o2-empty = 取り込み元が無い、o3-importing = 同意の後で日曜の取り込みの途中（Codex の
 *   月曜より前のファイルを読まずに止める。確定画像の 5 of 7 days）、o3-done = 7日分の後、o4〜o8 = その段から
 *   （前の段は済み。o6 以降はカレンダーを許可済み、o8 は hooks と MCP も入れた後）、board = Not now の後のボード
 * - --desktop: アプリの代わりにこのスクリプトが SSE（client=desktop）につなぎ、通知の許可の状態を知らせる。
 *   ask-grant / ask-deny は「未設定」から始め、画面の「通知をオンにする」で許可 / 拒否を返す
 * 起動後に表示する URL（/auth?t=...）をブラウザで開く。Ctrl-C で止めると一時 HOME を消す。
 */
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CalendarConnectError } from "../apps/daemon/src/calendar/connect.ts";
import { FakeCalendarProvider, type HelperEvent } from "../apps/daemon/src/calendar/provider.ts";
import { assetsFromDir } from "../apps/daemon/src/http/static.ts";
import { FakeGit } from "../apps/daemon/src/ingest/git.ts";
import { startDaemon } from "../apps/daemon/src/main.ts";
import { claudeTranscript } from "../apps/daemon/test/helpers/transcript.ts";
import {
  builtinAdapters,
  nullLogger,
  type SourceAdapter,
} from "../packages/collectors/src/index.ts";
import {
  addDays,
  dayStartMs,
  FakeClock,
  type OnboardingStep,
  putSetting,
  resolvePaths,
  toLocalDate,
  wallToEpoch,
} from "../packages/core/src/index.ts";

const TZ = "Asia/Tokyo";
const ROOT = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
const opt = (k: string) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : undefined;
};
const PORT = Number(opt("--port") ?? 27318);
const STATE = opt("--state") ?? "o2";
const STATES = [
  "o2",
  "o2-empty",
  "o3-importing",
  "o3-done",
  "o4",
  "o5",
  "o5a",
  "o6",
  "o7",
  "o8",
  "board",
];
if (!STATES.includes(STATE)) throw new Error(`unknown --state: ${STATE}`);
const CALENDAR = opt("--calendar") ?? "granted";
if (!["granted", "slow", "denied", "none", "fail", "authorize-fail", "hang"].includes(CALENDAR))
  throw new Error(`unknown --calendar: ${CALENDAR}`);
const HOOKS = opt("--hooks") ?? "none";
const DESKTOP = opt("--desktop") ?? "off";
if (!["off", "granted", "denied", "ask-grant", "ask-deny"].includes(DESKTOP))
  throw new Error(`unknown --desktop: ${DESKTOP}`);
const SKIPPED = args.includes("--skipped");
const INSTALL = opt("--install") ?? "dev";
if (!["dev", "app"].includes(INSTALL)) throw new Error(`unknown --install: ${INSTALL}`);
const NOW = Date.parse("2026-10-02T10:20:00+09:00");
const TODAY = toLocalDate(NOW, TZ, 240);
const MIN = 60_000;

/** "13:20" と日数（今日からの差）→ epoch ms */
function at(hhmm: string, day = 0): number {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  const [y, mo, d] = addDays(TODAY, day).split("-").map(Number) as [number, number, number];
  return wallToEpoch(y, mo, d, h * 60 + m, TZ);
}

const home = mkdtempSync(join(tmpdir(), "turnlane-devonb-"));
const claude = join(home, ".claude");
const acme = join(home, ".claude-acme");
const codex = join(home, ".codex");
const git = new FakeGit();
const repo = (name: string) => `/w/${name}`;
for (const r of ["acme-web", "acme-api", "docs-site"]) {
  git.repos.set(repo(r), repo(r));
  git.defaults.set(repo(r), "main");
}

let n = 0;
const sid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
const touch = (path: string, t: number) => utimesSync(path, new Date(t), new Date(t));

interface Work {
  title: string;
  repo: string;
  branch: string;
  pr?: number;
}
const W = {
  login: { title: "Investigate slow login on Safari", repo: "acme-web", branch: "main" },
  review: { title: "Review PR #138", repo: "acme-api", branch: "feat/rate-limit" },
  flaky: { title: "Fix flaky checkout e2e test", repo: "acme-web", branch: "fix/checkout-e2e" },
  csv: {
    title: "Add CSV export for invoices",
    repo: "acme-api",
    branch: "feat/invoice-csv",
    pr: 142,
  },
  docs: {
    title: "Rewrite the getting-started page",
    repo: "docs-site",
    branch: "docs/getting-started",
  },
  deps: { title: "Update the dependency report", repo: "acme-api", branch: "chore/deps" },
  lint: { title: "Bump the lint config", repo: "acme-web", branch: "chore/lint" },
} satisfies Record<string, Work>;
const JA: Record<string, string> = {
  [W.login.title]: "Safari でログインが遅い原因を調べる",
  [W.review.title]: "PR #138 をレビューする",
  [W.flaky.title]: "チェックアウトの e2e テストの不安定さを直す",
  [W.csv.title]: "請求書の CSV 出力を足す",
  [W.docs.title]: "はじめにのページを書き直す",
  [W.deps.title]: "依存関係のレポートを更新する",
  [W.lint.title]: "lint の設定を上げる",
};
const title = (w: Work) => (opt("--lang") === "ja" ? (JA[w.title] ?? w.title) : w.title);

/** その日の AI の作業: [作業, 始まり（時刻）, 長さ（分）]。列に見えるのは確定画像の作業（長い順） */
const DAYS: [number, [Work, string, number][]][] = [
  [
    0,
    [
      [W.login, "08:40", 47],
      [W.review, "09:40", 18],
    ],
  ],
  [
    -1,
    [
      [W.csv, "09:10", 125],
      [W.flaky, "11:30", 100],
      [W.docs, "13:30", 50],
      [W.deps, "14:30", 25],
      [W.login, "15:10", 22],
      [W.review, "16:00", 18],
    ],
  ],
  [
    -2,
    [
      [W.csv, "09:00", 150],
      [W.login, "11:40", 72],
      [W.flaky, "13:10", 65],
      [W.docs, "14:30", 40],
      [W.deps, "15:20", 15],
      [W.review, "15:50", 12],
      [W.lint, "16:10", 8],
    ],
  ],
  [
    -3,
    [
      [W.flaky, "09:20", 100],
      [W.docs, "11:10", 50],
      [W.deps, "13:00", 25],
      [W.review, "13:40", 18],
      [W.login, "14:10", 10],
    ],
  ],
  [
    -4,
    [
      [W.csv, "09:00", 125],
      [W.login, "11:20", 72],
      [W.docs, "13:00", 50],
      [W.deps, "14:00", 25],
      [W.review, "14:40", 20],
      [W.flaky, "15:10", 15],
    ],
  ],
  // 日曜: 1件（ファイルの更新時刻は Codex の日曜のファイルより後。止めた取り込みで既定の元を済みにする）
  [-5, [[W.deps, "19:00", 40]]],
];

const designed: string[] = [];
if (STATE !== "o2-empty") {
  for (const [day, works] of DAYS) {
    for (const [w, hhmm, mins] of works) {
      const id = sid();
      const tx = claudeTranscript(claude, { sid: id, cwd: repo(w.repo), branch: w.branch });
      const start = at(hhmm, day);
      const end = start + mins * MIN;
      tx.human(start);
      tx.aiTitle(start + 1000, title(w));
      if (w.pr) tx.prLink(end - 2 * MIN, `acme/${w.repo}`, w.pr);
      tx.assistantEnd(end, "Should I also update the docs?", { durationMs: mins * MIN });
      touch(tx.path, end);
      designed.push(tx.path);
    }
  }
  // 中身の無いセッション（検出の件数だけ）: 既定は合わせて84件（月〜金）、acme は12件（月・火）、Codex は18件（土〜木）
  const empty = (root: string, dir: string, t: number, prefix = "") => {
    const p = join(root, dir, `${prefix}${sid()}.jsonl`);
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(p, "");
    touch(p, t);
  };
  for (let i = designed.length; i < 84; i++)
    empty(claude, "projects/-w-acme-web", at("08:10", -(i % 5)) - (i % 7) * MIN);
  for (let i = 0; i < 12; i++) empty(acme, "projects/-w-acme-api", at("10:00", -3 - (i % 2)));
  for (let i = 0; i < 18; i++) {
    const day = -1 - (i % 6);
    const date = addDays(TODAY, day);
    empty(
      codex,
      `sessions/${date.replaceAll("-", "/")}`,
      at("09:00", day),
      `rollout-${date}T00-00-00-`,
    );
  }
  // Claude Desktop がある扱い（Code タブのセッションは ~/.claude に入る）
  mkdirSync(join(home, "Library/Application Support/Claude"), { recursive: true });
  // O5 の前の設定ファイル: 既定の Claude には他の項目がある（Turnlane はそれに触らない）。broken なら acme が壊れている
  writeFileSync(join(claude, "settings.json"), '{\n  "theme": "dark"\n}\n');
  if (HOOKS === "broken") writeFileSync(join(acme, "settings.json"), "{ not json\n");
}

/** o3-importing: Codex の月曜より前のファイルを読まずに止める（日曜が取り込み中、土曜が待機中） */
const holdBefore = STATE === "o3-importing" ? at("04:00", -4) : null;
const adapters: SourceAdapter[] = builtinAdapters.map((a) =>
  holdBefore === null || a.tool !== "codex"
    ? a
    : {
        ...a,
        read: async (stream, cursor, ctx) => {
          let m = 0;
          try {
            m = statSync(stream.path).mtimeMs;
          } catch {}
          if (m < holdBefore) await new Promise(() => {});
          return a.read(stream, cursor, ctx);
        },
      },
);

// ---------- 偽のカレンダー（O4 の許可の結果。実のヘルパ・カレンダーには触れない） ----------
let evSeq = 0;
const event = (
  title: string,
  start: number,
  end: number,
  p: { calendarId?: string; allDay?: string } = {},
): HelperEvent => ({
  calendarId: p.calendarId ?? "dev-team",
  externalId: `ev-${++evSeq}`,
  occurrenceStart: start,
  title,
  start: p.allDay ? dayStartMs(p.allDay, TZ, 0) : start,
  end: p.allDay ? dayStartMs(addDays(p.allDay, 1), TZ, 0) - 1000 : end,
  tz: TZ,
  allDay: Boolean(p.allDay),
  startDate: p.allDay ?? null,
  endDate: p.allDay ? addDays(p.allDay, 1) : null,
  status: "confirmed",
  availability: p.allDay ? "free" : "busy",
  selfResponse: p.allDay ? null : "accepted",
  eventId: `dev-ev-${evSeq}`,
  url: null,
  location: null,
  conferenceUrl: null,
  hasAttendees: !p.allDay,
  recurring: false,
});
const L = (ja: string, en: string) => (opt("--lang") === "ja" ? ja : en);
const calendarProvider = new FakeCalendarProvider({
  connected: false,
  authorization: "notDetermined",
  calendars:
    CALENDAR === "none"
      ? []
      : [
          {
            id: "dev-team",
            title: L("チーム", "Team"),
            sourceTitle: "Example",
            colorHex: "#6b8cc7",
            allowsModify: true,
            type: "calDAV",
          },
          {
            id: "dev-home",
            title: L("自宅", "Home"),
            sourceTitle: "iCloud",
            colorHex: "#9b7cf0",
            allowsModify: true,
            type: "calDAV",
          },
          {
            id: "dev-holidays",
            title: L("日本の祝日", "Japan Holidays"),
            sourceTitle: "iCloud",
            colorHex: "#4fb3a9",
            allowsModify: false,
            type: "subscription",
          },
        ],
  events:
    CALENDAR === "none"
      ? []
      : [
          event(L("朝会", "Standup"), at("10:00"), at("10:15")),
          event(L("デザインレビュー", "Design review"), at("11:00", -1), at("12:00", -1)),
          event(L("1on1", "1:1"), at("14:00", -2), at("14:30", -2)),
          event(L("スポーツの日", "Sports Day"), 0, 0, {
            calendarId: "dev-holidays",
            allDay: addDays(TODAY, 10),
          }),
          event(L("文化の日", "Culture Day"), 0, 0, {
            calendarId: "dev-holidays",
            allDay: addDays(TODAY, 32),
          }),
        ],
});
calendarProvider.defaultCalendarId = CALENDAR === "none" ? null : "dev-team";
/** O4 の主ボタン（POST /api/onboarding/calendar/connect）: 許可の結果を --calendar のとおりに返す */
const connectCalendar = async () => {
  if (CALENDAR === "fail") throw new Error("helper did not start");
  if (CALENDAR === "authorize-fail" || CALENDAR === "hang") {
    calendarProvider.setConnected(true);
    calendarProvider.setAuthorization("notDetermined");
    if (CALENDAR === "hang") return new Promise<void>(() => {});
    await Bun.sleep(2000);
    throw new CalendarConnectError(
      "authorize",
      1,
      "macOS did not show the calendar access dialog; access is still not decided",
    );
  }
  if (CALENDAR === "slow") await Bun.sleep(3000);
  calendarProvider.setConnected(true);
  calendarProvider.setAuthorization(CALENDAR === "denied" ? "denied" : "fullAccess");
};

const dataDir = join(home, "Library/Application Support/turnlane");
const paths = resolvePaths({ HOME: home, TURNLANE_DATA_DIR: dataDir }, home);
const clock = new FakeClock(NOW);
const dist = resolve(ROOT, "apps/web/dist");
const d = await startDaemon({
  paths,
  logger: nullLogger,
  assets: await assetsFromDir(dist),
  clock,
  port: PORT,
  ingest: { vars: {}, git, gh: null, noWatch: true, adapters },
  calendar: { provider: calendarProvider, connect: connectCalendar },
  // hooks・MCP に書く turnlane のパス（一時 HOME の中。実行はしない）
  launch: { cliPath: join(home, ".local", "bin", "turnlane") },
  // システム設定は開かない（開いた回数だけ数える）
  openSettings: async (pane) => {
    console.log(`open-settings: ${pane}`);
    return true;
  },
  summary: false,
  ...(INSTALL === "app"
    ? {
        install: {
          mode: "app" as const,
          appPath: fakeApp(),
          pathVar: `/usr/bin:/bin:${join(home, ".local", "bin")}`,
          homebrewCandidates: [],
          readBuild: () => "dev",
        },
      }
    : {}),
});
putSetting(d.mutateCtx, "tz", TZ);
const lang = opt("--lang");
if (lang === "en" || lang === "ja") putSetting(d.mutateCtx, "ui.language", lang);
const theme = opt("--theme");
if (theme === "dark" || theme === "light") putSetting(d.mutateCtx, "ui.theme", theme);

/** 同意して取り込みを始める。waitDone なら 7 日分が終わるまで待つ */
async function consentAll(waitDone: boolean) {
  const det = await d.onboarding.detect();
  await d.onboarding.consent(det.sources.map((s) => s.id));
  if (waitDone) {
    for (let i = 0; i < 600 && d.onboarding.progress().doneAt === null; i++) await Bun.sleep(20);
  } else {
    for (let i = 0; i < 600; i++) {
      const p = d.onboarding.progress();
      if (p.days.filter((x) => x.state === "done").length >= 5) break;
      await Bun.sleep(20);
    }
  }
  d.ai?.runner.runOnce();
}

if (STATE === "o3-importing" || STATE === "o3-done") await consentAll(STATE === "o3-done");
if (STATE === "board") {
  d.onboarding.setStep("sources", "skipped");
  d.onboarding.setStep("import", "skipped");
  d.onboarding.setStep("start", "done");
}

// O4 以降: 前の段を済みにする。o6 以降はカレンダーを許可済み（--calendar denied / none ならその状態）、
// o8 は hooks と MCP も入れた後（--skipped なら O4〜O7 を全部飛ばした状態）
const ORDER: OnboardingStep[] = ["calendar", "hooks", "mcp", "hours", "notifications", "start"];
const STEP_OF: Record<string, OnboardingStep> = {
  o4: "calendar",
  o5: "hooks",
  o5a: "mcp",
  o6: "hours",
  o7: "notifications",
  o8: "start",
};
const upto = STEP_OF[STATE] ? ORDER.indexOf(STEP_OF[STATE] as OnboardingStep) : -1;
if (upto >= 0) {
  await consentAll(STATE === "o8");
  d.onboarding.setStep("import", "done");
  for (const step of ORDER.slice(0, upto)) {
    if (SKIPPED) {
      // 計画の目安は飛ばせない（初期値のまま済み）
      d.onboarding.setStep(step, step === "hours" ? "done" : "skipped");
      continue;
    }
    if (step === "calendar") {
      if (CALENDAR !== "hang") await connectCalendar().catch(() => {});
      await d.calendar?.service.whenIdle();
      if (d.calendar && calendarProvider.connected()) await d.calendar.deps.sync();
    }
    if (step === "hooks") await d.onboarding.installHooks(false);
    if (step === "mcp") d.onboarding.installMcp(false);
    d.onboarding.setStep(step, CALENDAR === "denied" && step === "calendar" ? "skipped" : "done");
  }
  await d.supervisor?.whenIdle();
  await d.supervisor?.reconcile();
}
// O5a・O6 の画面にも hooks の状態が要る（取り込みの検出で読む）
if (STATE === "o5a" || STATE === "o6") await d.supervisor?.reconcile();

// ---------- デスクトップアプリの真似（O7・O8）: SSE に client=desktop でつなぎ、通知の許可の状態を知らせる ----------
async function fakeDesktop() {
  let perm = DESKTOP === "granted" ? "granted" : DESKTOP === "denied" ? "denied" : "not_determined";
  const report = async () => {
    await fetch(`http://127.0.0.1:${PORT}/api/desktop/status`, {
      method: "POST",
      headers: { authorization: `Bearer ${d.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        version: "dev",
        notifications: perm,
        shortcut: { accelerator: "Alt+Shift+Space", registered: true },
      }),
    });
  };
  const res = await fetch(`http://127.0.0.1:${PORT}/api/events?client=desktop&lang=en-US`, {
    headers: { authorization: `Bearer ${d.token}` },
  });
  await report();
  const reader = res.body?.getReader();
  if (!reader) return;
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value);
    let i = buf.indexOf("\n\n");
    while (i >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      i = buf.indexOf("\n\n");
      const ev = /^event: (.+)$/m.exec(chunk)?.[1];
      const data = /^data: (.+)$/m.exec(chunk)?.[1] ?? "{}";
      if (ev !== "desktop_notifications") continue;
      const action = (JSON.parse(data) as { action?: string }).action;
      console.log(`desktop: ${action}`);
      if (action === "request") {
        // OS のダイアログの代わり: 少し待ってから答える
        await Bun.sleep(800);
        perm = DESKTOP === "ask-deny" ? "denied" : "granted";
        await report();
      }
    }
  }
}
if (DESKTOP !== "off") void fakeDesktop().catch(() => {});

const next = STATE === "board" ? "/board" : "/onboarding";

/** 偽の Turnlane.app（一時 HOME の中。中身は空の turnlane だけ） */
function fakeApp(): string {
  const app = join(home, "Applications", "Turnlane.app");
  mkdirSync(join(app, "Contents", "Helpers"), { recursive: true });
  writeFileSync(join(app, "Contents", "Helpers", "turnlane"), "#!/bin/sh\n");
  return app;
}
const url = `http://127.0.0.1:${PORT}/auth?t=${d.token}&next=${encodeURIComponent(next)}`;
console.log(`turnlane dev onboarding (${STATE}, now = ${new Date(NOW).toISOString()})`);
console.log(`HOME: ${home}`);
console.log(url);

const stop = () => {
  // o3-importing は読み取りを止めたままなので、デーモンの終わりを待たない
  void d.stop().catch(() => {});
  rmSync(home, { recursive: true, force: true });
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
