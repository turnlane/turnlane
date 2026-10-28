/**
 * 開発用: ダミーデータ（テスト用のシード）でデーモンと UI を動かす（M2 の目視確認・スクリーンショット用）。
 *
 *   bun run build:web && bun scripts/dev-board.ts [--port 27317] [--now 2026-10-02T13:20:00+09:00] [--place-reply 15:00]
 *     [--open /day?record=1] [--lang en|ja] [--theme dark|light] [--calendar-off] [--night]
 *
 * - 一時 HOME（mkdtemp）に合成のトランスクリプト・hooks の spool を書き、偽の時計・偽の git・偽の gh でデーモンを起動する
 * - 実データ（~/.claude*, ~/.codex, ~/Library/Application Support/turnlane）・launchd・ネットワークには触れない
 * - リポジトリ名・タイトルはすべて架空の値
 * - 予定は偽のカレンダー（FakeCalendarProvider。Work と祝日カレンダー）から同期する。EventKit・ヘルパには触れない。
 *   --calendar-off でヘルパ未接続（「カレンダー未接続」）の状態にする。Turnlane から作る予定は Calendar.app のデフォルト
 *   （偽のカレンダーでは Work）へ書く（D-093。実カレンダーには触れない）。会議（Work の時刻付きの予定）は参加者ありで
 *   読み取り専用、Dentist（10/6）は参加者なしで編集できる。以前の版が書いた時間ブロックの予定（dayline://timeblock/）を
 *   2件入れてある（設定 > カレンダー の削除の確認用。--no-timeblock-events で入れない）。
 *   --no-default-calendar でデフォルトカレンダーが無い状態（設定画面の案内）にする
 * - --demo-notify <秒>: 起動の <秒> 後に新しい許可待ち（needs_input）を足す。デーモンが `notify` を送るので、
 *   デスクトップアプリ（TURNLANE_PORT / TURNLANE_DATA_DIR をこのデーモンに向けたもの）の通知を確かめられる（desktop-shell.md）
 * - --ext <dir>: 拡張（ADR 0015。dir に extension.json）を組み込む。繰り返せる。Web は --web-dist <dir> に、拡張を組み込んで
 *   ビルドした dist を渡す（無ければ apps/web/dist = 拡張なし）。E2E の ext スイートはテスト用の拡張（test/ext-fixture）で使う
 * - --night: 深夜の状態（D-054）を足す。0:00 をまたいで続けた AI の作業（0:10〜0:50）と、23:30〜0:30 に置いたタスク。
 *   --now 2026-10-03T01:40:00+09:00 と組み合わせる（論理日は 10/2 のまま、週ボードの今日の列は 10/3）
 * - --morning: 朝の状態にする（D-192）。今は 8:40（--now で変えられる）。夜のあいだに AI が動いた結果（自分の番2件・
 *   許可待ち1件・エラー1件・完了3件）、昨日の列に残った 3 件（「残り 3 件を今日へ」）と 14 日以内の古い残り、
 *   計画が空きを超えた今日（見出しの「計画」が琥珀）
 * - --dense: 実データに近い密度（D-074 の確認用）。今日は AI を3本並列で回し（長い日本語の題名）、自分の番への返答が
 *   十数回、会議4件、長い日本語の題名のタスク。今は 17:10（--now で変えられる）。既定の今日の AI と予定・タスクは入れない
 * - --mcp all|main|old: 設定 > AI の取り込み の MCP の状態（D-145）。all は両方の取り込み元が登録済み、main は main だけ、
 *   old は main が別の turnlane を指す。無ければどちらも未登録
 * - --source-health L3 / L1,L1: 取り込み元（main, sandbox の順）の状態を推定（L1・L2）・停止（L3）にする（D-118 の確認用）
 * - --calendar-auth notDetermined|denied: 予定を取った後でカレンダーの権限が外れた状態にする（D-130 のサイドバーの
 *   「カレンダーの予定を取れていません」の確認用）
 * - --dense-ai: --dense に、AI のレーンの読みやすさの確認用（D-117）の実行を足す。夜間（0:40〜5:10）の実行6件と、
 *   短い作業（3〜9分）を繰り返すセッション2本。--dense と組み合わせる
 * - 日報の AI 要約（M4-6）は一時 HOME の偽の claude（固定の文を返すシェルスクリプト）だけを使う。実際の claude / codex は
 *   探さない・呼ばない。--summary で要約をオンにする（シャットダウンの Step 2 を開くと4秒後に届く）。
 *   --summary-fail で偽の claude を時間切れにする（要約の上限を10秒にする）。--summary-saved で今日の要約を保存済みにする
 * - --design board|day|queue|menubar|empty: 確定デザインの画像（docs/design/screens/redesign/）と同じ内容のダミーデータ
 *   （題名・時刻・状態・リポジトリ名。D-114 の見比べ用）。今は 10/2（金）17:10。画像ごとに自分の番の顔ぶれが違うので
 *   画面ごとに選ぶ: board = B1〜B3、day = D1〜D3、queue = 自分の番の画面（Q1・Q2）、menubar = メニューバー、
 *   empty = 自分の番が無い状態、ai = AI の詳細パネルの案（mock-ai-detail-v1。D-116）の状態 A〜F（実行中・自分の番・
 *   許可待ち・AI 完了で PR の確認待ち・エラー・マージ済みの完了。今は 14:58）。既定の AI・予定・タスクは入れない
 * - --launch: タスクから AI に頼んだ状態（D-107・M5-B）を足す。起動直後（AI を起動中）、紐づいた AI が実行中、質問で止まって
 *   自分の番（頼んだタスクに付く）、PR を開いて AI 完了（CI 通過）、編集して AI 完了 · 確認（差分・テスト通過の確認支援）、
 *   起動できなかった（ターミナルで実行されなかった）。時刻は今からの相対。--codex で Codex も入っている扱いにする。
 *   Claude のアカウントは一時 HOME の main と sandbox の2つ（D-122）。--orca で端末の選択肢に Orca を足す
 * - --event-detail: 予定の詳細パネルの確認用（D-138）。今日の Design review（参加者あり・読み取り専用）に会議のリンク、
 *   今日 16:00〜16:45 に参加者のいない Pairing with Kim（場所とリンク付き。編集できる）を足す
 * - --scratch: 壁打ち（D-135）の状態を足す。Codex のアプリのプロジェクト外の会話（質問で終わって自分の番）、CLI で
 *   ~/Documents/Codex の下で始めた会話、設定で印を付けたフォルダ（一時 HOME の ~/scratch）の Claude Code の会話。
 *   詳細パネルの開く先は偽の OS（Codex のアプリが入っている扱い。「Codex で開く」が出る。何も起動しない）
 * - AI に頼む（D-107）は偽の git・偽の端末・偽の CLI で動く（worktree を作らない・端末を開かない・claude / codex を起動しない）。
 *   ポップオーバーから頼むと「Ghostty の新しいタブで起動しました」と出るだけ
 * - --design away / away-night: 離れていた間のまとめ（D-214 (2)）。away は 17:14〜17:48 の離席の間に 完了 1 · PR 1 · 新しい待ち 1
 *   （今は 17:50）、away-night は昨日 19:02 から今朝 8:35 までに 完了 3 · 新しい待ち 2（今は 8:40）。画像は scripts/screens-away.ts
 * - --design pr-subject: 件名が PR の題名になる場面（fix-subject-pr）。計画のディレクトリ（既定のブランチ）のセッションが
 *   別のリポジトリに PR を 3 つ出し、PR のカードにはターンが無い（指示も ai-title も無い）。比べるために、ブランチで指示して
 *   PR を出したカード（件名は指示、理由の行は PR #180 題名）も入れる。画像は scripts/screens-stale-title.ts の --design
 *   PR のカードのリポジトリは PR の属するリポジトリ（storefront。計画のディレクトリではない。fix-pr-card-repo）
 * - --more-expired: --design（board 以外）に期限切れをもう 1 件足す（今日 9:00 と 13:20 の 2 件。見出しの「期限切れ 2」の
 *   ホバーと、押してデイビューの「今日閉じた」の期限切れの行へ移るのを確かめる。R79。画像は scripts/screens-expired.ts）
 * - --many-closed: --design day に、今日の昼までに質問で止まって返答した短い作業を 8 件足す（「今日閉じたもの」が多い日。
 *   右の一覧の要約の行と、畳んだ状態でも未定が見えることの確認用）
 * - --design answer: Turnlane から答える（D-238）の場面。AI の問い（tmux の中・選択肢つき。送れる）、許可待ち（iTerm2。許可する）、
 *   AI の問い（tmux の外の Warp。送れない）の 3 行。セッションは動いている扱い（一時 HOME の sessions/<pid>.json。pid は
 *   このスクリプトが起動した sleep）。居場所は偽の OS の ps・tmux の出力で作り、送ると偽の OS に記録して、Claude が答えを
 *   受け取った形（記録に自分の指示）を書く。端末には何も送らない。今は 17:10。画像は scripts/screens-answer.ts。
 *   4 つ目は猶予の間の問い（iTerm2。17:06 に止まり、在席中なので返答タスクの行はまだ無い。詳細パネルに「答える」が出る。
 *   D-240。画像は scripts/screens-answer.ts --grace）。6 つ目も猶予の間の問い（ターミナル.app。17:07 に止まった。tmux の外でも
 *   tty のタブに do script で送れる。D-243。画像は scripts/screens-answer.ts --terminal）。7 つ目も猶予の間の問い（tmux の外の
 *   Ghostty 1.3。17:08 に止まった。「開く」と同じ目印で選んだタブに input text で送れる。D-244。画像は
 *   scripts/screens-answer.ts --ghostty）。猶予の間の問い（4・6・7）は自分の番の行の末尾に薄く出る（D-245）
 * - --design lane: AI のレーンで同じ時刻に重なる完了と問い（D-246）。14:00〜14:12 の完了と 14:01〜14:10 の問い（返答タスク
 *   あり）、16:49〜16:57 の完了と 16:50〜16:58 の猶予の間の問い。問いのラベルが前に出て、完了は問いのラベルの「+1」に畳まれる。
 *   問いの線の印は自分の番の →、右は「待ち 3h0m」「猶予 12m」。今は 17:10。画像は scripts/screens-answer.ts --lane
 * - --design demo: デモ動画（M6-30。docs/dev/demo-video.md）の場面。今は 10/2（金）15:20。予定・タスクは --design に共通のもの
 *   （「価格ページの文言」だけ「申し込みページの文言」に替える）。
 *   AI は 3 本が実行中（A web-app · feat/board-width 13:20〜、B docs-site · docs/deploy 14:05〜（sandbox）、
 *   C api-gateway · fix/auth-refresh 14:50〜）。件名（最初の指示）と ai-title は同じ文。完了した AI の実行は入れない。
 *   --demo-notify <秒> は新しいセッションを足さず、C に Bash の toolUse（bun test src/auth）と PermissionRequest を書く
 *   （合図の行は同じ）。--demo-waiting で C を起動の時点で許可待ちにする（15:19:40 に止まった。実機の場面 (3) 用）。
 *   実機用に --real-open --demo-pid <pid> --demo-root <dir>: 「開く」に本物の OS（OpenSystem）を使い、C を動いている扱いに
 *   する（main の sessions/<pid>.json。pid は Ghostty のタブ 3 で動いているダミーの台本 scripts/demo/tab.sh）。リポジトリの
 *   場所 /w/<repo> を <dir>/<repo>（実在するダミーのフォルダ）に替える。Playwright の録画（scripts/demo-record.ts）では使わない
 * - --live: AI の画面（ux-mvp 4.19）の確認用。完了した Claude Code のセッション（infra · fix/log-parser）のプロセスが
 *   動いている扱いにする（一時 HOME の sessions/<pid>.json。pid はこのスクリプトが起動した sleep。止めるときに片付ける）。
 *   最後の動きが 1 日より前に終わったセッション 2 本（notes・ledger-app）もプロセスが残っている扱いにする（AI の画面の末尾の
 *   畳んだ「プロセスが残っている」）。既定のダミーデータ・--launch・--scratch と組み合わせると、AI の画面の節が揃う
 *   （--keep-limit を足すと、利用上限の上限待ちを対応不要にせず「後で」に残す）
 * - --stale-blocks: 前の日付の時間ブロックが残ったタスク（MCP の schedule_task で日付・時刻を何度か変えたもの）を足す。
 *   週ボードの明日・明後日の列で、置いたブロックと未定の出し分けを確かめる
 * 起動後に表示する URL（/auth?t=...）をブラウザで開く。Ctrl-C で止めると一時 HOME を消す。
 */
import { Database } from "bun:sqlite";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FakeCalendarProvider, type HelperEvent } from "../apps/daemon/src/calendar/provider.ts";
import { FakePower } from "../apps/daemon/src/ext/power.ts";
import type { DaemonExtensionFactory } from "../apps/daemon/src/ext/types.ts";
import type { GhClient } from "../apps/daemon/src/github/pr-poller.ts";
import { assetsFromDir } from "../apps/daemon/src/http/static.ts";
import { FakeGit } from "../apps/daemon/src/ingest/git.ts";
import { startDaemon } from "../apps/daemon/src/main.ts";
import { seedPresence } from "../apps/daemon/src/presence/service.ts";
import { FakeLaunchSystem } from "../apps/daemon/test/helpers/launch-system.ts";
import { FakeOpenSystem } from "../apps/daemon/test/helpers/open-system.ts";
import { claudeTranscript, codexRollout } from "../apps/daemon/test/helpers/transcript.ts";
import { nullLogger } from "../packages/collectors/src/index.ts";
import {
  addDays,
  dayStartMs,
  FakeClock,
  insertRow,
  orderKeyAfter,
  orderKeyBetween,
  putSetting,
  resolvePaths,
  schema,
  toLocalDate,
  updateRow,
  wallToEpoch,
} from "../packages/core/src/index.ts";
import { extArgs, readExtManifests } from "./ext-manifest.ts";

const TZ = "Asia/Tokyo";
const ROOT = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
const opt = (k: string) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : undefined;
};
const PORT = Number(opt("--port") ?? 27317);
const MORNING = args.includes("--morning");
/** AI の画面の確認用: 完了した Claude Code のセッションのプロセスが動いている扱い */
const LIVE = args.includes("--live");
let liveSid: string | null = null;
/** --live: 最後の動きが 1 日より前で、プロセスが残っているだけのセッション（AI の画面の末尾の「プロセスが残っている」） */
const staleSids: string[] = [];
/** --live: 利用上限で止まり、上限待ちを対応不要にしたセッション（プロセスは残る） */
let limitSid: string | null = null;
/** --live と一緒に: 利用上限の上限待ちを対応不要にせず残す（自分の番の「後で」と AI の画面の「後で」に上限待ちの行が出る） */
const KEEP_LIMIT = args.includes("--keep-limit");
const DENSE = args.includes("--dense");
/** 期限切れをもう 1 件足す（--design day / queue などと組み合わせる。見出しの「期限切れ 2」の確認用。R79） */
const MORE_EXPIRED = args.includes("--more-expired");
/** 今日閉じたものを 8 件足す（--design day と組み合わせる。右の一覧の要約の行の確認用） */
const MANY_CLOSED = args.includes("--many-closed");
/** 確定デザインの画像と同じダミーデータ（D-114）。どの画像に合わせるか */
const DESIGN = opt("--design") as
  | "board"
  | "day"
  | "queue"
  | "menubar"
  | "empty"
  | "ai"
  | "glance"
  | "glance-edge"
  | "stale-title"
  | "pr-question"
  | "pr-subject"
  | "away"
  | "away-night"
  | "answer"
  | "instruct"
  | "lane"
  | "demo"
  | undefined;
/** 待っている件の見え方（D-207、spec-glance §9）。glance = 基本の 5 件、glance-edge = 伏せ字・長いもの・読めないとき・Codex */
const GLANCE =
  DESIGN === "glance" ||
  DESIGN === "glance-edge" ||
  DESIGN === "stale-title" ||
  DESIGN === "pr-question" ||
  DESIGN === "pr-subject";
if (
  DESIGN &&
  ![
    "board",
    "day",
    "queue",
    "menubar",
    "empty",
    "ai",
    "glance",
    "glance-edge",
    "stale-title",
    "pr-question",
    "pr-subject",
    "away",
    "away-night",
    "answer",
    "instruct",
    "lane",
    "demo",
  ].includes(DESIGN)
)
  throw new Error(`unknown --design: ${DESIGN}`);
/** 離れていた間のまとめ（D-214 (2)）。away = 17:14〜17:48 の離席（今は 17:50）、away-night = 昨日 19:02 から今朝 8:35（今は 8:40） */
const AWAY = DESIGN === "away" || DESIGN === "away-night";
/** デモ動画の場面（M6-30）。実機用の --real-open は本物の OS で「開く」 */
const DEMO = DESIGN === "demo";
const REAL_OPEN = args.includes("--real-open");
const DEMO_ROOT = opt("--demo-root");
const DEMO_PID = opt("--demo-pid");
if (REAL_OPEN) {
  if (!DEMO) throw new Error("--real-open needs --design demo");
  if (!DEMO_PID || !/^\d+$/.test(DEMO_PID)) throw new Error("--real-open needs --demo-pid <pid>");
  if (!DEMO_ROOT?.startsWith("/")) throw new Error("--real-open needs --demo-root <absolute dir>");
}
/** --design の題名（英語の画面は英語の確定画像の題名） */
const L = (ja: string, en: string) => (opt("--lang") === "en" ? en : ja);
const NOW = Date.parse(
  opt("--now") ??
    (MORNING || DESIGN === "away-night"
      ? "2026-10-02T08:40:00+09:00"
      : DESIGN === "away"
        ? "2026-10-02T17:50:00+09:00"
        : DESIGN === "ai"
          ? "2026-10-02T14:58:00+09:00"
          : DEMO
            ? "2026-10-02T15:20:00+09:00"
            : DENSE || DESIGN
              ? "2026-10-02T17:10:00+09:00"
              : "2026-10-02T13:20:00+09:00"),
);
const TODAY = toLocalDate(NOW, TZ, 240);
const MIN = 60_000;

/** "13:20" と日数（今日からの差）→ epoch ms */
function at(hhmm: string, day = 0): number {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  const [y, mo, d] = addDays(TODAY, day).split("-").map(Number) as [number, number, number];
  return wallToEpoch(y, mo, d, h * 60 + m, TZ);
}

const home = mkdtempSync(join(tmpdir(), "turnlane-devboard-"));
/** 端末に入力する turnlane（偽）。MCP の登録が指しているべきパスにもなる */
const DEVBOARD_CLI = "/usr/local/bin/turnlane";
/** --scratch: 壁打ち（D-135）のダミーデータ。印を付けるフォルダ */
const SCRATCH = args.includes("--scratch");
/** 予定の詳細パネルの確認用（D-138）: 今日の会議にリンク、参加者のいない予定（場所とリンク付き。編集できる）を足す */
const EVENT_DETAIL = args.includes("--event-detail");
const SCRATCH_DIR = join(home, "scratch");
const dataDir = join(home, "data");
mkdirSync(join(dataDir, "spool"), { recursive: true });

// ---------- 取り込み元（2つの Claude アカウント） ----------
const main = join(home, ".claude-main");
const acme = join(home, ".claude-sandbox");
/**
 * --mcp all|main|old: 設定 > AI の取り込み の MCP の状態の確認用（D-145）。一時 HOME のプロファイルの .claude.json に
 * turnlane を登録しておく（all は両方、main は main だけ、old は main が別の turnlane を指す）。無ければどちらも未登録
 */
const MCP = opt("--mcp");
if (MCP) {
  const reg = (dir: string, command: string) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, ".claude.json"),
      `${JSON.stringify({ mcpServers: { turnlane: { type: "stdio", command, args: ["mcp"], env: {} } } }, null, 2)}\n`,
    );
  };
  reg(main, MCP === "old" ? "/usr/local/old/turnlane" : DEVBOARD_CLI);
  if (MCP === "all") reg(acme, DEVBOARD_CLI);
}
let sidSeq = 0;
const sid = () => `00000000-0000-4000-8000-${String(++sidSeq).padStart(12, "0")}`;
const repo = (name: string) => `${(DEMO_ROOT ?? "/w").replace(/\/+$/, "")}/${name}`;
const git = new FakeGit();
for (const r of [
  "turnlane",
  "blog",
  "api-gateway",
  "infra",
  "billing",
  "billing-api",
  "notes",
  "ledger-app",
  "storefront",
  "planner-web",
  "web-app",
  "docs-site",
  "planning",
]) {
  git.repos.set(repo(r), repo(r));
  git.defaults.set(repo(r), "main");
}

/** AskUserQuestion の未回答、許可待ちの hook を spool に */
function hook(
  name: string,
  s: string,
  root: string,
  t: number,
  extra: Record<string, string> = {},
) {
  appendFileSync(
    join(dataDir, "spool", `hooks-${TODAY.replaceAll("-", "")}.jsonl`),
    `${JSON.stringify({ v: 1, tool: "claude_code", received_at: t, config_root: root, hook_event_name: name, session_id: s, ...extra })}\n`,
  );
}

// 事実は時刻順に書き、偽の時計を進めながら取り込み・判定を回す（返答タスクが実際の時刻に作られ、放置が数えられる）
const steps: { at: number; run: () => void }[] = [];
const step = (t: number, run: () => void) => steps.push({ at: t, run });
const session = (root: string, r: string, branch: string) => {
  const id = sid();
  const w = claudeTranscript(root, { sid: id, cwd: repo(r), branch });
  // 文を書かない指示は、ダミーの件名になる文にする（記録の書き手の既定の "(prompt)" が件名に出ないように。D-214 (1)）
  const human = w.human;
  w.human = (at, o = {}) =>
    human(at, { text: L(`${r} の ${branch} を進めて`, `Continue ${branch} in ${r}`), ...o });
  return { id, w };
};

// 昨日の夜: 長い実行がブログの価格ページの質問で終わったまま（返答タスク。不在の間に始まった待ちは `since 22:51`）
if (!DESIGN) {
  const { w } = session(acme, "blog", "draft/pricing");
  step(at("18:35", -1), () => w.human(at("18:35", -1)));
  step(at("22:51", -1), () =>
    w.assistantEnd(at("22:51", -1), "Which pricing tier should the page lead with?", {
      durationMs: 256 * MIN,
    }),
  );
}
// 昨日: 週ボードの作業（完了）
if (!DESIGN) {
  const { w } = session(main, "turnlane", "feat/week-board");
  step(at("09:40", -1), () => w.human(at("09:40", -1)));
  step(at("11:05", -1), () => w.assistantEnd(at("11:05", -1), "Done.", { durationMs: 80 * MIN }));
  step(at("14:10", -1), () => w.human(at("14:10", -1)));
  step(at("15:25", -1), () => w.assistantEnd(at("15:25", -1), "Done.", { durationMs: 70 * MIN }));
  step(at("18:30", -1), () => w.human(at("18:30", -1)));
  step(at("18:40", -1), () => w.assistantEnd(at("18:40", -1), "Done.", { durationMs: 10 * MIN }));
}
if (!DENSE && !DESIGN) {
  // 今日: Date lane DnD（質問で終了 → 15分で返答タスク → 9:46 に返答。放置 11m）
  {
    const { w } = session(main, "turnlane", "feat/date-lane-dnd");
    step(at("08:42"), () => w.human(at("08:42")));
    step(at("09:20"), () =>
      w.assistantEnd(at("09:20"), "Should the drop target snap to 15 minutes?", {
        durationMs: 38 * MIN,
      }),
    );
    step(at("09:53"), () => w.human(at("09:53")));
    step(at("09:58"), () => w.assistantEnd(at("09:58"), "Done.", { durationMs: 5 * MIN }));
  }
  // 今日: Log parser fix（完了）
  {
    const { id, w } = session(main, "infra", "fix/log-parser");
    liveSid = id;
    step(at("10:50"), () => w.human(at("10:50")));
    step(at("11:35"), () => w.assistantEnd(at("11:35"), "Done.", { durationMs: 45 * MIN }));
  }
  // --live: 利用上限で止まった（12:40。明ける時刻は見込み）のを「後で」で対応不要にしたセッション。プロセスは残る
  // （AI の画面の「止まっている」に `利用上限 · 見込み 17:40` で出る。「完了」と出さない）
  if (LIVE) {
    const { id, w } = session(main, "billing-api", "fix/usage-cap");
    limitSid = id;
    step(at("12:10"), () => {
      w.human(at("12:10"));
      hook("UserPromptSubmit", id, main, at("12:10"));
    });
    step(at("12:40"), () => {
      w.apiError(at("12:40"), "rate_limit", { durationMs: 30 * MIN });
      hook("StopFailure", id, main, at("12:40"), { error: "rate_limit" });
    });
  }
  // --live: 何日も前に終わったのに、プロセスが残っているだけのセッション（AI の画面の末尾の畳んだ行に 2 件）
  if (LIVE) {
    for (const [r, branch, day] of [
      ["notes", "chore/tidy-links", -3],
      ["ledger-app", "spike/csv-import", -18],
    ] as const) {
      const { id, w } = session(main, r, branch);
      staleSids.push(id);
      step(at("16:10", day), () => w.human(at("16:10", day)));
      step(at("16:40", day), () =>
        w.assistantEnd(at("16:40", day), "Done.", { durationMs: 30 * MIN }),
      );
    }
  }
  // 今日: PR #142（12:55 に PR、13:16 から再び実行中）
  {
    const { w } = session(main, "turnlane", "feat/day-view");
    step(at("12:30"), () => w.human(at("12:30")));
    step(at("12:55"), () => {
      w.prLink(at("12:54"), "example/turnlane", 142);
      w.assistantEnd(at("12:55"), "Opened the PR.", { durationMs: 25 * MIN });
    });
    step(at("13:16"), () => w.human(at("13:16")));
  }
  // 今日: Auth token refresh（hooks の許可待ち 13:13）
  {
    const { id, w } = session(acme, "api-gateway", "fix/auth-refresh");
    step(at("13:08"), () => {
      w.human(at("13:08"));
      hook("UserPromptSubmit", id, acme, at("13:08"));
    });
    step(at("13:13"), () => hook("PermissionRequest", id, acme, at("13:13")));
  }
  // 今日: Billing schema（hooks なしの AskUserQuestion で止まっている。D-049）
  {
    const { w } = session(main, "billing", "feat/invoice-schema");
    step(at("12:58"), () => w.human(at("12:58")));
    step(at("13:02"), () => w.ask(at("13:02")));
  }
  // 今日: 既定ブランチで続けている計画の相談（W7、D-061）。バックグラウンドのタスク通知で始まる1分未満のターンが
  // 4〜9分おきに続く（ひと続きの作業として1ブロックにまとまる）
  {
    const { w } = session(main, "notes", "main");
    step(at("10:02"), () => {
      w.aiTitle(at("10:02"), "Plan the Q4 roadmap");
      w.human(at("10:02"));
    });
    step(at("10:14"), () => w.assistantEnd(at("10:14"), "Done.", { durationMs: 12 * MIN }));
    const gaps = [4, 6, 5, 9, 4, 7, 5, 8, 6, 4, 5];
    let t = at("10:18");
    for (const g of gaps) {
      const s = t;
      step(s, () => w.human(s, { origin: "task-notification" }));
      step(s + 40_000, () => w.assistantEnd(s + 40_000, "Noted.", { durationMs: 40_000 }));
      t += g * MIN;
    }
  }
  // 今日: 別々の短い完了の実行が続けて並ぶ（まとめ表示 `✓ 3 runs · 3m`。W7）
  for (const [r, b, s, title] of [
    ["blog", "fix/typo-footer", "11:40", "Fix footer typo"],
    ["infra", "chore/bump-node", "11:43", "Bump Node version"],
    ["billing", "fix/rounding", "11:47", "Rounding in totals"],
  ] as const) {
    const { w } = session(acme, r, b);
    step(at(s), () => {
      w.aiTitle(at(s), title);
      w.human(at(s));
    });
    step(at(s) + 70_000, () => w.assistantEnd(at(s) + 70_000, "Done.", { durationMs: 70_000 }));
  }
}
// 初日の近似（--design empty）: 取り込み元（Claude Code の設定ディレクトリ）はあるが今日の実行が 0 件（B-10 の AI レーンの 1 行）
if (DESIGN === "empty") mkdirSync(join(main, "projects"), { recursive: true });
// 確定デザインの画像と同じ AI の作業（--design。D-114）。hooks あり（推定でない）のセッション
/** 後で閉じる返答（[リポジトリ#ブランチ, 状態, 閉じた時刻, 理由]）。画像の「今日閉じた」 */
const designClose: [string, "done" | "dismissed" | "expired", number, string | null][] = [];
if (
  DESIGN &&
  DESIGN !== "empty" &&
  DESIGN !== "ai" &&
  DESIGN !== "answer" &&
  DESIGN !== "instruct" &&
  DESIGN !== "lane" &&
  !DEMO &&
  !GLANCE &&
  !AWAY
) {
  const withHooks = (root: string, r: string, branch: string, title: string, t: number) => {
    const s = session(root, r, branch);
    step(t, () => {
      s.w.aiTitle(t, title);
      s.w.human(t);
      hook("UserPromptSubmit", s.id, root, t);
    });
    return s;
  };
  const askEnd = (w: ReturnType<typeof claudeTranscript>, t: number, min: number) =>
    step(t, () => w.assistantEnd(t, "Which option should I take?", { durationMs: min * MIN }));
  const doneEnd = (w: ReturnType<typeof claudeTranscript>, t: number, min: number) =>
    step(t, () => w.assistantEnd(t, "Done.", { durationMs: min * MIN }));
  const board = DESIGN === "board";
  // 昨日: 認証の不具合修正（完了）と日表示の実装（17:40 に PR #142 を開いた。レビュー待ち 23h30m）
  if (board) {
    const a = withHooks(
      main,
      "api-gateway",
      "fix/auth-bug",
      L("認証の不具合修正", "Fix auth bug"),
      at("09:15", -1),
    );
    doneEnd(a.w, at("11:45", -1), 150);
  }
  if (DESIGN !== "day") {
    const b = withHooks(
      main,
      "turnlane",
      "feat/day-view",
      L("日表示の実装", "Build day view"),
      at("14:00", -1),
    );
    step(at("17:40", -1), () => {
      b.w.prLink(at("17:39", -1), "example/turnlane", 142);
      b.w.assistantEnd(at("17:40", -1), "Opened the PR.", { durationMs: 220 * MIN });
    });
  }
  // 昨日: 古いブランチの整理（質問で終わった返答。今日の 9:00 に期限切れ）
  if (DESIGN !== "board") {
    const c = withHooks(
      main,
      "turnlane",
      "chore/prune-branches",
      L("古いブランチの整理", "Clean up old branches"),
      at("11:00", -1),
    );
    askEnd(c.w, at("11:10", -1), 10);
    designClose.push(["turnlane#chore/prune-branches", "expired", at("09:00"), null]);
  }
  // --more-expired: 期限切れをもう 1 件（設定のキー名の変更。昨日 13:20 に質問で終わり、今日の 13:20 に期限切れ。R79）
  if (MORE_EXPIRED && DESIGN !== "board") {
    const c = withHooks(
      acme,
      "billing",
      "chore/rename-config",
      L("設定のキー名の変更", "Rename config keys"),
      at("13:00", -1),
    );
    askEnd(c.w, at("13:20", -1), 20);
    designClose.push(["billing#chore/rename-config", "expired", at("13:20"), null]);
  }
  if (DESIGN !== "board") {
    // 夜間: 依存関係の更新（2:10〜2:34。質問で終わり、8:50 に返した）
    const d = withHooks(
      acme,
      "api-gateway",
      "chore/deps",
      L("依存関係の更新", "Dependency update"),
      at("02:10"),
    );
    askEnd(d.w, at("02:34"), 24);
    step(at("08:50"), () => d.w.human(at("08:50")));
    doneEnd(d.w, at("08:51"), 1);
    // 認証の不具合修正（9:40〜10:30。質問で終わり、コミットで解決とみなした）
    const e = withHooks(
      main,
      "api-gateway",
      "fix/auth-bug",
      L("認証の不具合修正", "Fix auth bug"),
      at("09:40"),
    );
    askEnd(e.w, at("10:30"), 50);
    designClose.push(["api-gateway#fix/auth-bug", "done", at("10:52"), "auto:resolved:commit"]);
    // ログ出力の確認（昨日 16:20〜16:32。今日の 12:05 に対応不要にした）
    const f = withHooks(
      acme,
      "api-gateway",
      "chore/log-output",
      L("ログ出力の確認", "Check log output"),
      at("16:20", -1),
    );
    askEnd(f.w, at("16:32", -1), 12);
    designClose.push(["api-gateway#chore/log-output", "dismissed", at("12:05"), null]);
  }
  // --many-closed: 質問で止まって数分後に返答した短い作業 8 件（9:00 から 40 分おき。返事まで 25〜34 分）
  if (MANY_CLOSED && DESIGN !== "board") {
    const many: [string, string, string, string][] = [
      ["turnlane", "fix/typo-footer", "フッターの誤字の修正", "Fix footer typo"],
      ["turnlane", "chore/lint-rules", "lint の規則の整理", "Tidy lint rules"],
      ["billing-api", "fix/rounding", "端数処理の修正", "Fix rounding"],
      ["billing-api", "test/tax-cases", "税率のテストの追加", "Add tax test cases"],
      ["billing", "docs/setup", "導入手順の更新", "Update setup guide"],
      ["billing", "fix/broken-links", "リンク切れの修正", "Fix broken links"],
      ["api-gateway", "chore/timeouts", "タイムアウトの見直し", "Review timeouts"],
      ["api-gateway", "fix/retry-header", "再試行のヘッダの修正", "Fix retry header"],
    ];
    many.forEach(([r, branch, ja, en], i) => {
      const t0 = at("09:00") + i * 40 * MIN;
      const s = withHooks(main, r, branch, L(ja, en), t0);
      askEnd(s.w, t0 + 6 * MIN, 6);
      // 猶予（15 分）の後に返答タスクができるので、返答は 25〜34 分後
      const back = t0 + 6 * MIN + (25 + (i % 4) * 3) * MIN;
      step(back, () => s.w.human(back));
      doneEnd(s.w, back + MIN, 1);
    });
  }
  // 価格ページのA/Bテスト（13:05〜15:34。質問で止まり、返答待ち 1h36m・うち放置 36m）。メニューバーの画像には無い
  if (DESIGN !== "menubar") {
    const g = withHooks(
      main,
      "turnlane",
      "exp/pricing-ab",
      L("価格ページのA/Bテスト", "Pricing page A/B test"),
      at("13:05"),
    );
    askEnd(g.w, at("15:34"), 149);
  }
  // 請求書のCSVエクスポート（14:11 から実行中。2h59m）
  withHooks(
    main,
    "billing-api",
    "feat/invoice-csv",
    L("請求書のCSVエクスポート", "Invoice CSV export"),
    at("14:11"),
  );
  // 移行スクリプトの実行（15:32 から。16:58 に許可待ち）
  {
    const h = withHooks(
      acme,
      "billing-api",
      "fix/migrate-0042",
      L("移行スクリプトの実行", "Migration script check"),
      at("15:32"),
    );
    step(at("16:58"), () => hook("PermissionRequest", h.id, acme, at("16:58")));
  }
  // APIドキュメントの更新（15:50〜16:54。質問で止まり、猶予の後に返答タスク。待ち 15m）
  if (DESIGN !== "board") {
    const i = withHooks(
      main,
      "turnlane",
      "docs/api-v2",
      L("APIドキュメントの更新", "update API docs"),
      at("15:50"),
    );
    askEnd(i.w, at("16:54"), 64);
  }
  // エラー（16:10〜16:28。テストが失敗して止まった。待ち 42m）
  if (DESIGN === "queue") {
    const j = withHooks(
      acme,
      "api-gateway",
      "fix/auth-refresh",
      L("テストが失敗して止まりました", "Tests failed and stopped"),
      at("16:10"),
    );
    step(at("16:28"), () => j.w.apiError(at("16:28"), "api_error", { durationMs: 18 * MIN }));
  }
}
// AI の詳細パネルの案（--design ai。design/mock-ai-detail-v1.html の A〜F。D-116）。今は 14:58
if (DESIGN === "ai") {
  const start = (root: string, r: string, branch: string, title: string, t: number) => {
    const s = session(root, r, branch);
    step(t, () => {
      s.w.aiTitle(t, title);
      s.w.human(t);
      hook("UserPromptSubmit", s.id, root, t);
    });
    return s;
  };
  const reply = (s: ReturnType<typeof session>, root: string, t: number) =>
    step(t, () => {
      s.w.human(t);
      hook("UserPromptSubmit", s.id, root, t);
    });
  const ask = (s: ReturnType<typeof session>, t: number, min: number) =>
    step(t, () => s.w.assistantEnd(t, "Which option should I take?", { durationMs: min * MIN }));
  // A 実行中: 13:12〜13:33 の後に質問で止まり、猶予と放置の後 13:54 に返して実行中
  const a = start(
    main,
    "ledger-app",
    "feat/invoice-csv",
    L("請求書の CSV 出力を追加", "Add invoice CSV export"),
    at("13:12"),
  );
  ask(a, at("13:33"), 21);
  reply(a, main, at("13:54"));
  // B 自分の番（返答待ち）: 11:00〜11:40 と 13:05〜13:35 に動き、13:35 から返答待ち。14:00〜14:45 は会議中
  const b = start(
    main,
    "storefront",
    "exp/pricing-ab",
    L("料金ページの A/B テスト", "Pricing page A/B test"),
    at("11:00"),
  );
  ask(b, at("11:40"), 40);
  reply(b, main, at("13:05"));
  ask(b, at("13:35"), 30);
  // C ブロック中（許可待ち）: 14:20〜14:46、14:46 にシェルのコマンドの許可を求めた
  const c = start(
    acme,
    "billing-api",
    "fix/migrate-0042",
    L("移行スクリプトの実行", "Run the migration script"),
    at("14:20"),
  );
  step(at("14:46"), () =>
    hook("PermissionRequest", c.id, acme, at("14:46"), { tool_name: "Bash" }),
  );
  // D AI 完了 · PR の確認待ち: 10:02〜10:20、10:40〜10:51 に PR #142 を開いた（レビュー待ち）
  const d = start(
    main,
    "planner-web",
    "feat/day-lanes",
    L("日表示のレーン分け", "Split the day view into lanes"),
    at("10:02"),
  );
  ask(d, at("10:20"), 18);
  reply(d, main, at("10:40"));
  step(at("10:51"), () => {
    d.w.prLink(at("10:50"), "example/planner-web", 142);
    d.w.assistantEnd(at("10:51"), "Opened the PR.", { durationMs: 11 * MIN });
  });
  // E エラー: 12:38〜13:00、API の利用上限で止まった（StopFailure）。13:15〜13:28 は Mac を使っていない（離席）
  const e = start(
    acme,
    "api-gateway",
    "docs/api-v2",
    L("API ドキュメントの更新", "Update the API docs"),
    at("12:38"),
  );
  step(at("13:00"), () => {
    e.w.apiError(at("13:00"), "rate_limit", { durationMs: 22 * MIN });
    hook("StopFailure", e.id, acme, at("13:00"), { error_type: "rate_limit" });
  });
  // F 完了（マージ済み）: 11:05〜11:38、11:53〜12:01 に PR #139 を開き、13:20 にマージ
  const f = start(
    acme,
    "planner-web",
    "feat/search-date",
    L("検索の結果を日付で絞り込む", "Filter search results by date"),
    at("11:05"),
  );
  ask(f, at("11:38"), 33);
  reply(f, acme, at("11:53"));
  step(at("12:01"), () => {
    f.w.prLink(at("12:00"), "example/planner-web", 139);
    f.w.assistantEnd(at("12:01"), "Opened the PR.", { durationMs: 8 * MIN });
  });
}
// 実データに近い密度（--dense。D-074）: AI を3本並列で回し、質問で止まるたびに16〜25分後に返す（返答タスクが
// 猶予の後に作られ、返すと閉じる）。[実行の分, 待ちの分] の列。最後の1つは今の状態（許可待ち・稼働中・自分の番）
if (DENSE) {
  const cycles = (
    root: string,
    r: string,
    branch: string,
    title: string,
    start: string,
    xs: [number, number][],
  ) => {
    const s0 = session(root, r, branch);
    let t = at(start);
    const t0 = t;
    step(t0, () => {
      s0.w.aiTitle(t0, title);
      s0.w.human(t0);
    });
    for (const [run, wait] of xs) {
      const end = t + run * MIN;
      step(end, () =>
        s0.w.assistantEnd(end, "Which approach should I take?", { durationMs: run * MIN }),
      );
      const back = end + wait * MIN;
      step(back, () => s0.w.human(back));
      t = back;
    }
    return { ...s0, t };
  };
  // 許可待ちで止まっている（hooks の PermissionRequest）
  const a = cycles(
    acme,
    "api-gateway",
    "fix/token-refresh",
    "認証トークンの更新処理を見直してリトライとタイムアウトの扱いを整理する",
    "09:05",
    [
      [32, 17],
      [41, 22],
      [28, 16],
      [45, 19],
    ],
  );
  step(a.t, () => hook("UserPromptSubmit", a.id, acme, a.t));
  step(at("16:58"), () => hook("PermissionRequest", a.id, acme, at("16:58")));
  // 稼働中
  cycles(
    main,
    "turnlane",
    "feat/three-day-board",
    "3日ボードの列幅と今日のレーン配分を実データで調整する",
    "09:20",
    [
      [25, 18],
      [38, 16],
      [22, 25],
      [50, 17],
      [30, 20],
    ],
  );
  // 自分の番（質問で止まったまま）
  const c = cycles(
    main,
    "billing",
    "feat/invoice-export",
    "請求書のCSVエクスポートに税率ごとの小計を追加する",
    "10:10",
    [
      [40, 20],
      [27, 16],
      [33, 18],
      [44, 21],
    ],
  );
  step(c.t + 35 * MIN, () =>
    c.w.assistantEnd(c.t + 35 * MIN, "Should the subtotal include shipping?", {
      durationMs: 35 * MIN,
    }),
  );
}
// --dense-ai（D-117）: 夜間の実行6件と、短い作業の多いセッション（AI のレーンの読みやすさの確認用）
if (DENSE && args.includes("--dense-ai")) {
  // 夜間: 前の日の夕方に頼んだセッションが、夜にタスク通知で動き直す（本人の操作に数えない）
  const nightRun = (r: string, b: string, title: string, from: string, min: number) => {
    const { w } = session(acme, r, b);
    const asked = at("18:20", -1);
    step(asked, () => {
      w.aiTitle(asked, title);
      w.human(asked);
    });
    step(asked + MIN, () => w.assistantEnd(asked + MIN, "Queued.", { durationMs: MIN }));
    const t0 = at(from);
    step(t0, () => w.human(t0, { origin: "task-notification" }));
    step(t0 + min * MIN, () => w.assistantEnd(t0 + min * MIN, "Done.", { durationMs: min * MIN }));
  };
  nightRun("infra", "chore/nightly-1", "依存パッケージの更新を確認する", "00:40", 12);
  nightRun("infra", "chore/nightly-2", "古いブランチを整理する", "01:20", 6);
  nightRun("notes", "chore/nightly-3", "週次のメモを集計する", "02:05", 18);
  nightRun("api-gateway", "chore/nightly-4", "負荷試験の結果をまとめる", "02:50", 25);
  nightRun("blog", "chore/nightly-5", "リンク切れを調べる", "03:30", 8);
  nightRun("infra", "chore/nightly-6", "バックアップの検証", "05:10", 9);
  // 短い作業を繰り返す（8m など。点のような短い線にならないかの確認）
  const short = (
    root: string,
    r: string,
    branch: string,
    title: string,
    start: string,
    xs: [number, number][],
  ) => {
    const s0 = session(root, r, branch);
    let t = at(start);
    const t0 = t;
    step(t0, () => {
      s0.w.aiTitle(t0, title);
      s0.w.human(t0);
    });
    for (const [run, wait] of xs) {
      const end = t + run * MIN;
      step(end, () => s0.w.assistantEnd(end, "Done.", { durationMs: run * MIN }));
      const back = end + wait * MIN;
      step(back, () => s0.w.human(back));
      t = back;
    }
    const last = t + 4 * MIN;
    step(last, () => s0.w.assistantEnd(last, "Done.", { durationMs: 4 * MIN }));
  };
  short(main, "notes", "chore/lint", "lint の警告を直す", "11:30", [
    [8, 40],
    [5, 45],
    [9, 50],
    [3, 35],
  ]);
  short(acme, "infra", "fix/ci-cache", "CI のキャッシュが効かない原因を調べる", "13:40", [
    [6, 38],
    [8, 52],
    [4, 33],
  ]);
}
// 深夜（--night。D-054）: 0:00 を越えて続けた作業（ログの修正を 0:10〜0:50 に AI へ頼んだ）
const NIGHT = args.includes("--night");
if (NIGHT) {
  const { w } = session(main, "infra", "fix/log-rotation");
  step(at("00:10", 1), () => w.human(at("00:10", 1)));
  step(at("00:50", 1), () => w.assistantEnd(at("00:50", 1), "Done.", { durationMs: 40 * MIN }));
}
// 朝（--morning）: 昨日の夕方の後、夜のあいだに動いた AI（バックグラウンドの実行。本人の操作に数えない）
if (MORNING) {
  /**
   * 夜のバックグラウンドの実行: 昨日の夕方（閉店の前）に人が頼んだセッションが、夜にタスク通知で動き直す
   * （夜のターンは本人の操作に数えない）。後の書き込みは [分, 処理] で、その時刻の step に置く
   */
  let asked = at("18:00", -1);
  const night = (
    root: string,
    r: string,
    b: string,
    title: string,
    from: string,
    day: number,
    later: [number, (w: ReturnType<typeof claudeTranscript>, t: number) => void][],
  ) => {
    const { w } = session(root, r, b);
    asked += 5 * MIN;
    const h = asked;
    step(h, () => {
      w.aiTitle(h, title);
      w.human(h);
    });
    step(h + 2 * MIN, () => w.assistantEnd(h + 2 * MIN, "Queued.", { durationMs: 2 * MIN }));
    const t0 = at(from, day);
    step(t0, () => w.human(t0, { origin: "task-notification" }));
    for (const [m, run] of later) step(t0 + m * MIN, () => run(w, t0 + m * MIN));
  };
  const end =
    (min: number, edits = 0) =>
    (w: ReturnType<typeof claudeTranscript>, t: number) =>
      w.assistantEnd(t, "Done.", { durationMs: min * MIN, edits });
  // 22:10〜22:51 に動いて PR #151 を開いた（レビュー待ち）
  night(main, "turnlane", "feat/week-scroll", "Week scroll", "22:10", -1, [
    [40, (w, t) => w.prLink(t, "example/turnlane", 151)],
    [41, end(41, 3)],
  ]);
  // 22:53〜23:05 に動いて質問で止まった（AskUserQuestion）
  night(acme, "api-gateway", "chore/db-migrate", "Migration order", "22:53", -1, [
    [12, (w, t) => void w.ask(t)],
  ]);
  // 完了だけのもの（判断を求めない）
  night(acme, "api-gateway", "chore/deps", "Dependency update", "20:30", -1, [
    [20, (w, t) => w.prLink(t, "example/api-gateway", 138)],
    [22, end(22)],
  ]);
  night(main, "infra", "fix/log-rotation", "Log rotation fix", "23:30", -1, [[18, end(18)]]);
  night(acme, "blog", "docs/typos", "Docs typo sweep", "01:10", 0, [[9, end(9)]]);
  // 朝 6:58 に始めた定期の依存チェックが 7:00 に API エラー
  night(main, "infra", "chore/nightly-deps", "Nightly dependency check", "06:58", 0, [
    [2, (w, t) => w.apiError(t, "api_error", { durationMs: 2 * MIN })],
  ]);
}
// --scratch: 壁打ち（D-135）。Codex のアプリのプロジェクト外の会話（質問で終わって自分の番）、CLI で
// ~/Documents/Codex の下で始めた会話（完了）、Claude の Code を印のフォルダ（~/scratch）で使った会話（完了）。
// フォルダ名・題名は架空の値（Codex のフォルダ名は取り込みで日付までに切り落とされる）
if (SCRATCH) {
  const codexRoot = join(home, ".codex");
  const a = codexRollout(codexRoot, {
    sid: sid(),
    cwd: join(home, "Documents/Codex", TODAY, "offsite-agenda"),
    at: at("10:05"),
  });
  step(at("10:06"), () => {
    a.threadName(at("10:06"), L("合宿の議題を出す", "Offsite agenda ideas"));
    a.turn(at("10:06"), at("10:14"), "Which day should we keep free?");
  });
  const b = codexRollout(codexRoot, {
    sid: sid(),
    cwd: join(home, "Documents/Codex", TODAY, "name-ideas"),
    at: at("07:30"),
    originator: "codex_cli_rs",
  });
  step(at("07:31"), () => {
    b.threadName(at("07:31"), L("名前の候補を比べる", "Compare name ideas"));
    b.turn(at("07:31"), at("07:52"), "Here are five options.");
  });
  const c = claudeTranscript(main, { sid: sid(), cwd: SCRATCH_DIR, branch: "" });
  step(at("12:10"), () => {
    c.human(at("12:10"));
    c.aiTitle(at("12:10"), L("価格の考え方を整理する", "Think through pricing"));
  });
  step(at("12:40"), () => c.assistantEnd(at("12:40"), "Done.", { durationMs: 30 * MIN }));
}
// 待っている件の見え方（--design glance / glance-edge。D-207、spec-glance §9）。本文・コマンドはすべてダミー。今は 17:10
if (GLANCE) {
  const start = (
    root: string,
    r: string,
    branch: string,
    title: string,
    t: number,
    text: string,
  ) => {
    const s = session(root, r, branch);
    step(t, () => {
      s.w.aiTitle(t, title);
      s.w.human(t, { text });
      hook("UserPromptSubmit", s.id, root, t);
    });
    return s;
  };
  const askPermission = (
    s: ReturnType<typeof session>,
    root: string,
    t: number,
    name: string,
    input: Record<string, unknown>,
  ) =>
    step(t, () => {
      s.w.toolUse(t, name, input);
      hook("PermissionRequest", s.id, root, t, { tool_name: name });
    });
  if (DESIGN === "stale-title") {
    // PR をマージした後に、同じセッションで別の作業を頼んで許可待ち（件名が PR の題名に残らないこと。fix-stale-title）。
    // 朝に既定のブランチで 1 ターン（セッションが他のカードにまたがる = 自動の題名が PR の題名になる形）
    const id = sid();
    const onMain = claudeTranscript(main, { sid: id, cwd: repo("docs-site"), branch: "main" });
    const w = claudeTranscript(main, {
      sid: id,
      cwd: repo("docs-site"),
      branch: "docs/deploy-branch",
    });
    step(at("10:00"), () => {
      onMain.aiTitle(at("10:00"), L("デプロイの文書の整理", "Deploy docs cleanup"));
      onMain.human(at("10:00"), { text: L("README の誤字を直して", "Fix the README typos") });
      hook("UserPromptSubmit", id, main, at("10:00"));
    });
    step(at("10:05"), () => onMain.assistantEnd(at("10:05"), "Done.", { durationMs: 5 * MIN }));
    step(at("13:00"), () => {
      w.human(at("13:00"), {
        text: L(
          "本番のデプロイのブランチを main に一本化した運用を文書に反映して",
          "Update the docs for deploying production from main only",
        ),
      });
      hook("UserPromptSubmit", id, main, at("13:00"));
    });
    step(at("13:30"), () => {
      w.prLink(at("13:29"), "example/docs-site", 170);
      w.assistantEnd(at("13:30"), L("PR を開きました。", "Opened the PR."), {
        durationMs: 30 * MIN,
      });
      hook("Stop", id, main, at("13:30"));
    });
    // 15:00 に PR をマージ（PRS の 170）。16:50 に同じセッションで別の依頼
    step(at("16:50"), () => {
      w.human(at("16:50"), {
        text: L(
          "先月のクラウドの利用状況をまとめて\n\nサービスごとに分けてください。",
          "Summarize last month's cloud usage\n\nBreak it down by service.",
        ),
      });
      hook("UserPromptSubmit", id, main, at("16:50"));
    });
    step(at("16:58"), () => {
      w.toolUse(at("16:58"), "Bash", {
        command: "cloudcost report --month 2026-09 --group-by service",
        description: L("先月のコストをサービスごとに出す", "Get last month's cost by service"),
      });
      hook("PermissionRequest", id, main, at("16:58"), { tool_name: "Bash" });
    });
  } else if (DESIGN === "pr-question") {
    // 朝のセッションが PR を出したブランチで、昼に別のセッションが別の調査をして問いで止まる（fix-pr-link）。
    // PR はブランチのカードの成果に残るが、状態・主ボタン・件名は AI の問い（返答待ち）が先
    const a = sid();
    const wa = claudeTranscript(main, { sid: a, cwd: repo("web-app"), branch: "fix/issue-42" });
    step(at("10:00"), () => {
      wa.human(at("10:00"), {
        text: L("アラートの対象外の施設を足して", "Skip alerts for archived sites"),
      });
      hook("UserPromptSubmit", a, main, at("10:00"));
    });
    step(at("10:03"), () => {
      wa.prLink(at("10:02"), "example/web-app", 180);
      wa.assistantEnd(at("10:03"), L("PR を開きました。", "Opened the PR."), {
        durationMs: 3 * MIN,
      });
      hook("Stop", a, main, at("10:03"));
    });
    const b = sid();
    const wb = claudeTranscript(main, { sid: b, cwd: repo("web-app"), branch: "fix/issue-42" });
    step(at("13:10"), () => {
      wb.aiTitle(at("16:30"), L("予約データの取得エラーの条件", "Booking fetch error conditions"));
      wb.human(at("16:30"), {
        text: L("customer_id が -1 になる条件は？", "When does customer_id become -1?"),
      });
      hook("UserPromptSubmit", b, main, at("16:30"));
    });
    step(at("16:38"), () => {
      wb.assistantEnd(
        at("16:38"),
        L(
          "条件は分かりました。修正を Issue にするか、実装まで進めるか、どちらにしますか？",
          "Found the condition. Should I file an issue, or go ahead and implement the fix?",
        ),
        { durationMs: 8 * MIN },
      );
      hook("Stop", b, main, at("16:38"));
    });
  } else if (DESIGN === "pr-subject") {
    // 計画のディレクトリのセッションが別のリポジトリに PR を出す。PR は head のブランチのカードに付き、ターンが無い
    const p = sid();
    const wp = claudeTranscript(main, { sid: p, cwd: repo("planning"), branch: "main" });
    const prs: [string, number][] = [
      ["16:13", 8],
      ["16:21", 9],
      ["16:38", 10],
    ];
    step(at("16:05"), () => {
      wp.aiTitle(at("16:05"), L("今週の計画", "This week's plan"));
      wp.human(at("16:05"), { text: L("今週の作業を進めて", "Work through this week's tasks") });
      hook("UserPromptSubmit", p, main, at("16:05"));
    });
    for (const [t, n] of prs)
      step(at(t), () => {
        wp.prLink(at(t), "example/storefront", n);
      });
    step(at("16:40"), () => {
      wp.assistantEnd(at("16:40"), L("PR を 3 つ開きました。", "Opened three PRs."), {
        durationMs: 35 * MIN,
      });
      hook("Stop", p, main, at("16:40"));
    });
    // 比べる: ブランチで指示して PR を出したカード（件名は指示。理由の行に PR #180 題名）
    const a = sid();
    const wa = claudeTranscript(main, { sid: a, cwd: repo("web-app"), branch: "fix/issue-42" });
    step(at("15:00"), () => {
      wa.human(at("15:00"), {
        text: L("アラートの対象外の施設を足して", "Skip alerts for archived sites"),
      });
      hook("UserPromptSubmit", a, main, at("15:00"));
    });
    step(at("15:03"), () => {
      wa.prLink(at("15:02"), "example/web-app", 180);
      wa.assistantEnd(at("15:03"), L("PR を開きました。", "Opened the PR."), {
        durationMs: 3 * MIN,
      });
      hook("Stop", a, main, at("15:03"));
    });
  } else if (DESIGN === "glance") {
    // 1. 許可待ち（Bash）。件名は最初の指示（後の「はい」は飛ばす）。待ち 12m
    const a = start(
      acme,
      "api-gateway",
      "fix/auth-refresh",
      "Fix auth refresh flow",
      at("16:20"),
      L(
        "リフレッシュトークンの期限切れで 401 になるのを直して\n\n再現のテストも足してください。",
        "Fix the 401 when the refresh token expires\n\nAdd a test that reproduces it.",
      ),
    );
    step(at("16:48"), () =>
      a.w.assistantEnd(at("16:48"), L("直しました。push しますか？", "Fixed. Shall I push?"), {
        durationMs: 28 * MIN,
      }),
    );
    step(at("16:52"), () => {
      a.w.human(at("16:52"), { text: L("はい", "yes") });
      hook("UserPromptSubmit", a.id, acme, at("16:52"));
    });
    askPermission(a, acme, at("16:58"), "Bash", {
      command: "git push origin main",
      description: L("修正を main に push する", "Push the fix to main"),
    });
    // 2. エラーで停止（API の混雑）。待ち 1h02m
    const b = start(
      main,
      "billing",
      "fix/closing-date",
      "Invoice closing date",
      at("15:40"),
      L("請求書の締め日の不具合を直して", "Fix the invoice closing-date bug"),
    );
    step(at("16:08"), () => {
      b.w.apiError(at("16:08"), "overloaded", { durationMs: 28 * MIN });
      hook("StopFailure", b.id, main, at("16:08"), { error_type: "overloaded" });
    });
    // 3. 返答待ち（AI の問い）
    const c = start(
      main,
      "web-app",
      "feat/board-width",
      "Board column widths",
      at("16:30"),
      L("3日ボードの列幅を直して", "Fix the 3-day board column widths"),
    );
    step(at("16:52"), () => {
      c.w.assistantEnd(
        at("16:52"),
        L(
          "左の列は直しました。右の列も同じ幅にしますか？",
          "I fixed the left column. Should the right column use the same width?",
        ),
        { durationMs: 22 * MIN },
      );
      hook("Stop", c.id, main, at("16:52"));
    });
    // 4. 回答待ち（AskUserQuestion の問いと選択肢）
    const d4 = start(
      main,
      "docs-site",
      "main",
      "Deploy steps",
      at("16:30"),
      L("デプロイの手順を整理して", "Tidy up the deploy steps"),
    );
    step(at("16:45"), () =>
      d4.w.ask(at("16:45"), [
        {
          question: L("デプロイ先は?", "Where should this deploy?"),
          options: ["staging", "production", L("両方", "both")],
        },
      ]),
    );
    // 5. PR の確認待ち（件名は PR の題名）
    const e = start(
      main,
      "web-app",
      "fix/day-view-width",
      "Day view widths",
      at("15:00"),
      L("日表示の列幅を直して", "Fix the day view widths"),
    );
    step(at("16:00"), () => {
      e.w.prLink(at("15:59"), "example/web-app", 142);
      e.w.assistantEnd(at("16:00"), L("PR を開きました。", "Opened the PR."), {
        durationMs: 60 * MIN,
      });
      hook("Stop", e.id, main, at("16:00"));
    });
  } else {
    // 6. 伏せ字（Bearer・URL のパスワード）
    const f = start(
      acme,
      "api-gateway",
      "chore/charge-check",
      "Charge API check",
      at("16:40"),
      L("課金 API の疎通を確かめて", "Check the charge API"),
    );
    askPermission(f, acme, at("16:55"), "Bash", {
      // 鍵の形のダミー（実在しない値。文字列を組み立てて、秘密の検出に当たらないようにする）
      command: `curl -H "Authorization: Bearer ${["sk", "live", "dummy".repeat(5)].join("-")}" https://api.example.com/v1/charge?amount=100`,
      description: L("課金 API を呼んで確かめる", "Call the charge API"),
    });
    // 7. 長い・複数行のコマンド
    const g = start(
      main,
      "billing",
      "fix/migrate-0042",
      "Migration 0042",
      at("16:30"),
      L("マイグレーションを staging に流して", "Run the migration on staging"),
    );
    askPermission(g, main, at("16:50"), "Bash", {
      command:
        "export DATABASE_URL=postgres://app:dummy-pass@db.internal:5432/main\nbun run migrate --env staging && bun run seed --env staging --reset\nbun run check:schema\nbun run smoke --env staging\necho done",
      description: L("staging にマイグレーションと seed を流す", "Migrate and seed staging"),
    });
    // 8. 長いパス（Edit。中身は読まない）
    const h = start(
      main,
      "web-app",
      "feat/deploy-config",
      "Deploy config",
      at("16:20"),
      L("デプロイの設定を本番用に分けて", "Split the deploy config for production"),
    );
    askPermission(h, main, at("16:40"), "Edit", {
      file_path: "/w/web-app/src/components/board/columns/day-view/DayViewColumns.tsx",
      old_string: "(old)",
      new_string: "(new)",
    });
    // 9. 読めなかったとき（記録のファイルが消えた）
    const k = start(
      acme,
      "docs-site",
      "docs/missing-log",
      "Docs links",
      at("16:10"),
      L("リンク切れを直して", "Fix the broken links"),
    );
    askPermission(k, acme, at("16:30"), "Bash", { command: "bun run check:links" });
    step(at("17:00"), () => rmSync(k.w.path));
    // 10. Codex（中身はまだ読まない。今の表示のまま。D-207 (7)）
    const cx = codexRollout(join(home, ".codex"), {
      sid: sid(),
      cwd: repo("web-app"),
      at: at("16:00"),
      originator: "codex_cli_rs",
    });
    step(at("16:01"), () => {
      cx.threadName(at("16:01"), L("在庫表示の確認", "Stock display check"));
      cx.turn(at("16:01"), at("16:40"), "Does the stock display look right?");
    });
  }
}
// 離れていた間のまとめ（--design away / away-night。D-214 (2)）。本文はすべてダミー
if (AWAY) {
  const start = (r: string, branch: string, title: string, t: number) => {
    const s = session(main, r, branch);
    step(t, () => {
      s.w.aiTitle(t, title);
      s.w.human(t, { text: title });
      hook("UserPromptSubmit", s.id, main, t);
    });
    return s;
  };
  if (DESIGN === "away") {
    // 離席の前から待っている件（自分の番 4 のうちの 1 件。許可待ち）
    const deploy = start(
      "docs-site",
      "docs/deploy",
      L("デプロイの手順を整理して", "Write up the deploy steps"),
      at("16:20"),
    );
    step(at("16:40"), () => {
      deploy.w.toolUse(at("16:40"), "Bash", {
        command: "bun run deploy --dry-run",
        description: L("デプロイを試す", "Try the deploy"),
      });
      hook("PermissionRequest", deploy.id, main, at("16:40"), { tool_name: "Bash" });
    });
    // 返答して離席の前から続いていた件（離席の間に完了 · 6 ファイル）
    const logs = start(
      "api-gateway",
      "fix/log-format",
      L("アクセスログの形式を JSON にそろえて", "Make the access log JSON"),
      at("16:58"),
    );
    step(at("17:22"), () =>
      logs.w.assistantEnd(at("17:22"), L("そろえました。", "Done."), {
        edits: 6,
        durationMs: 24 * MIN,
      }),
    );
    // 離席の間に PR #190 を開いた
    const board = start(
      "planner-web",
      "fix/board-width",
      L("3日ボードの列幅を直して", "Fix the 3-day board column widths"),
      at("17:05"),
    );
    step(at("17:31"), () => {
      board.w.prLink(at("17:31"), "example/planner-web", 190);
      board.w.assistantEnd(at("17:31"), L("PR を開きました。", "Opened the PR."), {
        edits: 4,
        durationMs: 26 * MIN,
      });
    });
    // 離席の間に問いで止まった（猶予なしで自分の番。D-223）
    const tz = start(
      "ledger-app",
      "fix/tz-test",
      L("タイムゾーンで落ちるテストを直して", "Fix the test that fails on time zones"),
      at("17:10"),
    );
    step(at("17:41"), () =>
      tz.w.assistantEnd(
        at("17:41"),
        L("UTC と JST のどちらに合わせますか？", "Should it use UTC or JST?"),
        { durationMs: 31 * MIN },
      ),
    );
    // 離席の前に終わっていた件（まとめには入らない）
    const typo = start(
      "blog",
      "fix/footer",
      L("フッターの誤字を直して", "Fix the footer typo"),
      at("15:30"),
    );
    step(at("15:42"), () =>
      typo.w.assistantEnd(at("15:42"), "Done.", { edits: 1, durationMs: 12 * MIN }),
    );
  } else {
    // 夜のあいだ（昨日 19:02 に離れ、今朝 8:35 に戻った）: 完了 3 · 新しい待ち 2
    const night = (
      r: string,
      branch: string,
      ja: string,
      en: string,
      from: string,
      to: string,
      edits: number,
    ) => {
      const s = session(main, r, branch);
      step(at(from, -1), () => {
        s.w.aiTitle(at(from, -1), L(ja, en));
        s.w.human(at(from, -1), { text: L(ja, en) });
      });
      const end = to.startsWith("0") ? at(to) : at(to, -1);
      step(end, () => s.w.assistantEnd(end, "Done.", { edits, durationMs: end - at(from, -1) }));
    };
    night(
      "api-gateway",
      "chore/deps",
      "依存を上げてテストを通して",
      "Bump the deps and get tests passing",
      "18:50",
      "21:40",
      7,
    );
    night(
      "planner-web",
      "fix/week-scroll",
      "週表示のスクロールを直して",
      "Fix the week view scroll",
      "18:55",
      "20:10",
      3,
    );
    night(
      "docs-site",
      "docs/api",
      "API の説明を書き直して",
      "Rewrite the API docs",
      "19:00",
      "01:30",
      12,
    );
    const q = session(main, "ledger-app", "feat/export");
    step(at("18:58", -1), () => {
      q.w.aiTitle(at("18:58", -1), L("CSV の書き出しを足して", "Add CSV export"));
      q.w.human(at("18:58", -1), { text: L("CSV の書き出しを足して", "Add CSV export") });
    });
    step(at("23:12", -1), () =>
      q.w.assistantEnd(
        at("23:12", -1),
        L("区切りはカンマとタブのどちらにしますか？", "Comma or tab?"),
        { durationMs: 254 * MIN },
      ),
    );
    const pq = session(main, "infra", "chore/rotate-keys");
    step(at("19:01", -1), () => {
      pq.w.aiTitle(at("19:01", -1), L("鍵の更新の手順を試して", "Try the key rotation steps"));
      pq.w.human(at("19:01", -1), {
        text: L("鍵の更新の手順を試して", "Try the key rotation steps"),
      });
      hook("UserPromptSubmit", pq.id, main, at("19:01", -1));
    });
    step(at("02:45"), () => {
      pq.w.toolUse(at("02:45"), "Bash", {
        command: "terraform plan",
        description: L("変更を確かめる", "Check the plan"),
      });
      hook("PermissionRequest", pq.id, main, at("02:45"), { tool_name: "Bash" });
    });
  }
}
// AI のレーンで同じ時刻に重なる完了と問い（--design lane。D-246）。本文はすべてダミー。今は 17:10
if (DESIGN === "lane") {
  const pair = (
    r: string,
    branch: string,
    title: [string, string],
    start: string,
    end: string,
    question: [string, string] | null,
  ) => {
    const s = session(main, r, branch);
    step(at(start), () => {
      s.w.aiTitle(at(start), L(...title));
      s.w.human(at(start), { text: L(...title) });
      hook("UserPromptSubmit", s.id, main, at(start));
    });
    step(at(end), () => {
      s.w.assistantEnd(at(end), question ? L(...question) : L("終わりました。", "Done."), {
        durationMs: at(end) - at(start),
      });
      hook("Stop", s.id, main, at(end));
    });
  };
  // 14:00 の完了と 14:01 の問い（14:25 に返答タスク）。以前は先に始まった完了がラベルの場所を取り、問いが「+1」の裏に隠れた
  pair(
    "web-app",
    "chore/release-notes",
    ["リリースノートをまとめる", "Summarize the release notes"],
    "14:00",
    "14:12",
    null,
  );
  pair(
    "planner-web",
    "feat/onboarding-copy",
    ["オンボーディングの文言を直す", "Fix the onboarding copy"],
    "14:01",
    "14:10",
    [
      "文言を 2 案にしました。どちらにしますか？\n1. 短くする\n2. 例を足す",
      "I wrote two options. Which one?\n1. Shorter\n2. Add an example",
    ],
  );
  // 16:49 の完了と 16:50 の猶予の間の問い（16:58 に止まった。在席中なので返答タスクは 17:13 まで作られない）
  pair(
    "docs-site",
    "chore/changelog",
    ["変更履歴を整える", "Tidy up the changelog"],
    "16:49",
    "16:57",
    null,
  );
  pair(
    "docs-site",
    "feat/search-box",
    ["検索欄を見つけやすくする", "Make the search box easier to find"],
    "16:50",
    "16:58",
    [
      "検索欄の置き場所を 2 案にしました。どちらにしますか？\n1. 見出しの右\n2. 目次の上",
      "I tried two spots for the search box. Which one?\n1. Right of the header\n2. Above the contents",
    ],
  );
}
// Turnlane から答える（--design answer。D-238）。本文はすべてダミー。今は 17:10
const answerOpen = new FakeOpenSystem();
const answerPids: number[] = [];
if (DESIGN === "answer") {
  answerOpen.files.add("/Applications/Ghostty.app");
  answerOpen.files.add("/Applications/iTerm.app");
  answerOpen.files.add("/Applications/Warp.app");
  // Ghostty は 1.3.1 で AppleScript を切っていない（open/ghostty.ts が読む版と設定。D-244）
  answerOpen.outputs.set(
    "/usr/bin/plutil -extract CFBundleShortVersionString raw -o - /Applications/Ghostty.app/Contents/Info.plist",
    "1.3.1\n",
  );
  answerOpen.outputs.set("/Applications/Ghostty.app/Contents/MacOS/ghostty +show-config", "");
  answerOpen.files.add("/System/Applications/Utilities/Terminal.app");
  for (const r of ["web-app", "api-gateway", "docs-site", "planner-web"])
    answerOpen.dirs.add(repo(r));
  // 動いているセッション: pid は起動した sleep（止めるときに片付ける）
  const liveStatus = (pid: number, id: string, status: "idle" | "busy", at: number) => {
    mkdirSync(join(main, "sessions"), { recursive: true });
    writeFileSync(
      join(main, "sessions", `${pid}.json`),
      JSON.stringify({ pid, sessionId: id, status, updatedAt: at }),
    );
  };
  const live = (id: string) => {
    const p = Bun.spawn(["/bin/sleep", "86400"], { stdin: "ignore", stdout: "ignore" });
    answerPids.push(p.pid);
    liveStatus(p.pid, id, "idle", NOW);
    return p.pid;
  };
  const ps = (pid: number) => `/bin/ps -o ppid=,tty=,comm= -p ${pid}`;
  const writers = new Map<string, ReturnType<typeof session>["w"]>();
  // 1. AI の問い（tmux の中。外側は Ghostty）: 送れる。選択肢つき
  const a = session(main, "web-app", "feat/board-width");
  step(at("16:40"), () => {
    a.w.aiTitle(at("16:40"), L("3日ボードの列幅", "Three-day board column widths"));
    a.w.human(at("16:40"), {
      text: L("3日ボードの列幅を直して", "Fix the three-day board column widths"),
    });
    hook("UserPromptSubmit", a.id, main, at("16:40"));
  });
  step(at("16:48"), () => {
    a.w.assistantEnd(
      at("16:48"),
      L(
        "左の列は直しました。右の列は予定の多い日に文字が切れます。どうしますか？\n1. 右の列も同じ幅にする\n2. 右の列だけ広げる\n3. そのままにする",
        "The left column is fixed. The right column cuts off text on busy days. What should I do?\n1. Make the right column the same width\n2. Widen only the right column\n3. Leave it as is",
      ),
      { durationMs: 8 * MIN },
    );
    hook("Stop", a.id, main, at("16:48"));
  });
  // 2. 許可待ち（iTerm2）: 許可する
  const b = session(main, "api-gateway", "fix/auth-refresh");
  step(at("16:58"), () => {
    b.w.human(at("16:58"), {
      text: L("リフレッシュトークンの 401 を直して", "Fix the 401 on token refresh"),
    });
    hook("UserPromptSubmit", b.id, main, at("16:58"));
  });
  step(at("17:02"), () => {
    b.w.toolUse(at("17:02"), "Bash", {
      command: "bun test src/auth",
      description: L("認証のテストを走らせる", "Run the auth tests"),
    });
    hook("PermissionRequest", b.id, main, at("17:02"), { tool_name: "Bash" });
  });
  // 3. AI の問い（tmux の外の Warp）: 送れない
  const c = session(main, "docs-site", "docs/deploy");
  step(at("13:10"), () => {
    c.w.human(at("16:30"), { text: L("デプロイの手順を整理して", "Tidy up the deploy guide") });
    hook("UserPromptSubmit", c.id, main, at("16:30"));
  });
  step(at("16:36"), () => {
    c.w.assistantEnd(
      at("16:36"),
      L(
        "手順を 3 つにまとめました。古い手順の節は消してよいですか？",
        "I merged it into three steps. Can I delete the old section?",
      ),
      { durationMs: 6 * MIN },
    );
    hook("Stop", c.id, main, at("16:36"));
  });
  // 4. 猶予の間の問い（iTerm2。D-240）: 17:06 に止まった。在席中なので返答タスクは 17:21 まで作られない
  const g = session(main, "planner-web", "feat/icon-contrast");
  step(at("17:00"), () => {
    g.w.aiTitle(at("17:00"), L("アイコンのコントラスト", "Icon contrast"));
    g.w.human(at("17:00"), {
      text: L("ダークモードのアイコンを見やすくして", "Make the dark mode icons easier to see"),
    });
    hook("UserPromptSubmit", g.id, main, at("17:00"));
  });
  step(at("17:06"), () => {
    g.w.assistantEnd(
      at("17:06"),
      L(
        "ダークモードのアイコンを 2 案作りました。どちらにしますか？\n1. 線を太くする\n2. 色を明るくする",
        "I made two options for the dark mode icons. Which one?\n1. Thicker strokes\n2. Brighter colors",
      ),
      { durationMs: 6 * MIN },
    );
    hook("Stop", g.id, main, at("17:06"));
  });
  // 5. AskUserQuestion のダイアログ（iTerm2）: Claude Code は PermissionRequest を出し、ダイアログの間は tool_use を記録に
  // 書かない。問いが読めないので、送らずに端末で答えてもらう。帯は 3 件までなので、PermissionRequest は 1 の問いに答えた後に
  // 届く（下の run。E2E はそこから先でこの行を見る）
  const d = session(main, "api-gateway", "feat/release-channel");
  step(at("17:03"), () => {
    d.w.aiTitle(at("17:03"), L("リリースのチャンネル", "Release channel"));
    d.w.human(at("17:03"), {
      text: L("リリースのチャンネルを決めて", "Pick the release channel"),
    });
    hook("UserPromptSubmit", d.id, main, at("17:03"));
  });
  // 6. 猶予の間の問い（ターミナル.app。tmux の外。D-243）: 17:07 に止まった
  const e = session(main, "planner-web", "fix/empty-state");
  step(at("17:01"), () => {
    e.w.aiTitle(at("17:01"), L("空の状態の文言", "Empty state copy"));
    e.w.human(at("17:01"), {
      text: L("予定が無い日の文言を直して", "Fix the copy for days with no events"),
    });
    hook("UserPromptSubmit", e.id, main, at("17:01"));
  });
  step(at("17:07"), () => {
    e.w.assistantEnd(
      at("17:07"),
      L(
        "予定の無い日の文言を 2 案にしました。どちらにしますか？\n1. 「予定はありません」\n2. 「空いています」",
        'I wrote two options for days with no events. Which one?\n1. "No events"\n2. "You\'re free"',
      ),
      { durationMs: 6 * MIN },
    );
    hook("Stop", e.id, main, at("17:07"));
  });
  // 7. 猶予の間の問い（tmux の外の Ghostty 1.3。D-244）: 17:08 に止まった
  const h = session(main, "docs-site", "feat/search-box");
  step(at("17:02"), () => {
    h.w.aiTitle(at("17:02"), L("検索欄の置き場所", "Search box placement"));
    h.w.human(at("17:02"), {
      text: L("ドキュメントの検索欄を見つけやすくして", "Make the docs search box easier to find"),
    });
    hook("UserPromptSubmit", h.id, main, at("17:02"));
  });
  step(at("17:08"), () => {
    h.w.assistantEnd(
      at("17:08"),
      L(
        "検索欄の置き場所を 2 案にしました。どちらにしますか？\n1. 見出しの右\n2. 左の目次の上",
        "I tried two spots for the search box. Which one?\n1. Right of the header\n2. Above the left table of contents",
      ),
      { durationMs: 6 * MIN },
    );
    hook("Stop", h.id, main, at("17:08"));
  });
  const pa = live(a.id);
  const pb = live(b.id);
  const pc = live(c.id);
  const pg = live(g.id);
  const pd = live(d.id);
  const pe = live(e.id);
  const ph = live(h.id);
  answerOpen.outputs.set(ps(ph), "4600 ttys017 claude");
  answerOpen.outputs.set(ps(4600), "4590 ttys017 -zsh");
  answerOpen.outputs.set(ps(4590), "1 ?? /Applications/Ghostty.app/Contents/MacOS/ghostty");
  answerOpen.outputs.set(ps(pe), "4500 ttys015 claude");
  answerOpen.outputs.set(ps(4500), "4490 ttys015 -zsh");
  answerOpen.outputs.set(
    ps(4490),
    "1 ?? /System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal",
  );
  answerOpen.outputs.set(ps(pd), "4400 ttys013 claude");
  answerOpen.outputs.set(ps(4400), "4390 ttys013 -zsh");
  answerOpen.outputs.set(ps(4390), "1 ?? /Applications/iTerm.app/Contents/MacOS/iTerm2");
  writers.set("tmux", a.w);
  writers.set("ttys004", b.w);
  writers.set("ttys011", g.w);
  writers.set("ttys015", e.w);
  writers.set("ghostty", h.w);
  const lives = new Map([
    ["ghostty", { pid: ph, id: h.id }],
    ["tmux", { pid: pa, id: a.id }],
    ["ttys004", { pid: pb, id: b.id }],
    ["ttys011", { pid: pg, id: g.id }],
    ["ttys015", { pid: pe, id: e.id }],
  ]);
  // 居場所: a は tmux（%3, main:1.0）の中で外側は Ghostty、b は iTerm2 の ttys004、c は Warp の ttys009、h は Ghostty の ttys017
  const TMUX = "/opt/homebrew/bin/tmux";
  answerOpen.outputs.set(ps(pa), "4000 ttys007 claude");
  answerOpen.outputs.set(ps(4000), `3900 ttys007 ${TMUX}`);
  answerOpen.outputs.set("/bin/ps -o args= -p 4000", "tmux new-session");
  answerOpen.outputs.set(
    `${TMUX} -u list-panes -a -F #{pane_tty}\t#{pane_id}\t#{session_name}\t#{window_index}\t#{pane_index}`,
    "/dev/ttys007\t%3\tmain\t1\t0\n",
  );
  answerOpen.outputs.set(
    `${TMUX} -u list-clients -F #{client_tty}\t#{client_pid}\t#{client_session}\t#{client_activity}`,
    "/dev/ttys002\t5000\tmain\t100\n",
  );
  answerOpen.outputs.set(ps(5000), "4900 ttys002 tmux");
  answerOpen.outputs.set(ps(4900), "1 ?? /Applications/Ghostty.app/Contents/MacOS/ghostty");
  answerOpen.outputs.set(ps(pb), "4100 ttys004 claude");
  answerOpen.outputs.set(ps(4100), "4090 ttys004 -zsh");
  answerOpen.outputs.set(ps(4090), "1 ?? /Applications/iTerm.app/Contents/MacOS/iTerm2");
  answerOpen.outputs.set(ps(pc), "4200 ttys009 claude");
  answerOpen.outputs.set(ps(4200), "4190 ttys009 -zsh");
  answerOpen.outputs.set(ps(4190), "1 ?? /Applications/Warp.app/Contents/MacOS/stable");
  answerOpen.outputs.set(ps(pg), "4300 ttys011 claude");
  answerOpen.outputs.set(ps(4300), "4290 ttys011 -zsh");
  answerOpen.outputs.set(ps(4290), "1 ?? /Applications/iTerm.app/Contents/MacOS/iTerm2");
  // iTerm2 のタブの番号（着地）
  answerOpen.stdout = (argv) => (argv[0] === "/usr/bin/osascript" ? "3\n" : "");
  // 送ったら（tmux の Enter・iTerm2 の write text・ターミナル.app の do script・Ghostty の input text）、Claude が受け取って自分の指示が記録に現れた形にする
  const run = answerOpen.run.bind(answerOpen);
  let askHookSent = false;
  answerOpen.run = async (argv, o) => {
    const ok = await run(argv, o);
    // iTerm2・ターミナル.app は tty（osascript の引数）でセッションを分ける。Ghostty（目印で選ぶ。D-244）は 1 つだけ
    const via =
      argv.at(-1) === "Enter"
        ? "tmux"
        : argv.some((x) => x.includes("input text (item 2"))
          ? "ghostty"
          : argv.some((x) => x.includes("write text") || x.includes("do script (item 2"))
            ? (argv.find((x) => /^\/dev\/ttys\d+$|^ttys\d+$/.test(x))?.replace("/dev/", "") ?? null)
            : null;
    if (via === "tmux" && !askHookSent) {
      askHookSent = true;
      hook("PermissionRequest", d.id, main, at("17:04"), { tool_name: "AskUserQuestion" });
    }
    if (via) {
      writers.get(via)?.human(Date.now(), { text: "(answer)" });
      // 受け取った Claude は動き出す（sessions/<pid>.json を busy に）
      const l = lives.get(via);
      if (l) liveStatus(l.pid, l.id, "busy", Date.now());
      // このスクリプトはファイルを監視しない（noWatch）。少し後に取り込み直して判定を回し、待ちが閉じた形にする（D-241。
      // 送った印の 1 行が見えてから節が消える）
      setTimeout(async () => {
        if (!ai) return;
        await ai.supervisor.probeLive();
        await ai.supervisor.scanAll();
        await ai.supervisor.whenIdle();
        ai.runner.runOnce();
      }, 1500);
    }
    return ok;
  };
  process.on("exit", () => {
    for (const pid of answerPids)
      try {
        process.kill(pid);
      } catch {}
  });
}
// 次の指示（--design instruct。Issue #9）。本文はすべてダミー。今は 17:10。
// 1 本目は tmux の中で動いていてターンが終わったセッション（送れる）、2 本目はプロセスの終わったセッション（送らない）
if (DESIGN === "instruct") {
  answerOpen.files.add("/Applications/Ghostty.app");
  answerOpen.outputs.set(
    "/usr/bin/plutil -extract CFBundleShortVersionString raw -o - /Applications/Ghostty.app/Contents/Info.plist",
    "1.3.1\n",
  );
  answerOpen.outputs.set("/Applications/Ghostty.app/Contents/MacOS/ghostty +show-config", "");
  for (const r of ["web-app", "docs-site"]) answerOpen.dirs.add(repo(r));
  const liveStatus = (pid: number, id: string, status: "idle" | "busy", t: number) => {
    mkdirSync(join(main, "sessions"), { recursive: true });
    writeFileSync(
      join(main, "sessions", `${pid}.json`),
      JSON.stringify({ pid, sessionId: id, status, updatedAt: t }),
    );
  };
  const a = session(main, "web-app", "feat/board-width");
  step(at("16:40"), () => {
    a.w.aiTitle(at("16:40"), L("3日ボードの列幅", "Three-day board column widths"));
    a.w.human(at("16:40"), {
      text: L("3日ボードの列幅を直して", "Fix the three-day board column widths"),
    });
    hook("UserPromptSubmit", a.id, main, at("16:40"));
  });
  step(at("16:52"), () => {
    a.w.assistantEnd(
      at("16:52"),
      L(
        "左右の列を同じ幅にしました。**テストも通っています。**",
        "Both columns now use the same width. **Tests pass.**",
      ),
      { durationMs: 12 * MIN },
    );
    hook("Stop", a.id, main, at("16:52"));
  });
  const b = session(main, "docs-site", "docs/deploy");
  step(at("13:00"), () => {
    b.w.aiTitle(at("13:00"), L("デプロイの手順", "Deploy guide"));
    b.w.human(at("13:00"), { text: L("デプロイの手順を整理して", "Tidy up the deploy guide") });
    hook("UserPromptSubmit", b.id, main, at("13:00"));
  });
  step(at("13:10"), () => {
    b.w.assistantEnd(at("13:10"), L("手順を整理しました。", "I tidied up the guide."), {
      durationMs: 10 * MIN,
    });
    hook("Stop", b.id, main, at("13:10"));
  });
  const p = Bun.spawn(["/bin/sleep", "86400"], { stdin: "ignore", stdout: "ignore" });
  answerPids.push(p.pid);
  liveStatus(p.pid, a.id, "idle", NOW);
  const ps = (pid: number) => `/bin/ps -o ppid=,tty=,comm= -p ${pid}`;
  const TMUX = "/opt/homebrew/bin/tmux";
  answerOpen.outputs.set(ps(p.pid), "4000 ttys007 claude");
  answerOpen.outputs.set(ps(4000), `3900 ttys007 ${TMUX}`);
  answerOpen.outputs.set("/bin/ps -o args= -p 4000", "tmux new-session");
  answerOpen.outputs.set(
    `${TMUX} -u list-panes -a -F #{pane_tty}\t#{pane_id}\t#{session_name}\t#{window_index}\t#{pane_index}`,
    "/dev/ttys007\t%3\tmain\t1\t0\n",
  );
  answerOpen.outputs.set(
    `${TMUX} -u list-clients -F #{client_tty}\t#{client_pid}\t#{client_session}\t#{client_activity}`,
    "/dev/ttys002\t5000\tmain\t100\n",
  );
  answerOpen.outputs.set(ps(5000), "4900 ttys002 tmux");
  answerOpen.outputs.set(ps(4900), "1 ?? /Applications/Ghostty.app/Contents/MacOS/ghostty");
  // 送ったら（tmux の Enter）、Claude が受け取って自分の指示が記録に現れ、動き出した形にする
  const run = answerOpen.run.bind(answerOpen);
  answerOpen.run = async (argv, o) => {
    const ok = await run(argv, o);
    if (argv.at(-1) === "Enter") {
      a.w.human(Date.now(), { text: "(instruction)" });
      liveStatus(p.pid, a.id, "busy", Date.now());
      setTimeout(async () => {
        if (!ai) return;
        await ai.supervisor.probeLive();
        await ai.supervisor.scanAll();
        await ai.supervisor.whenIdle();
        ai.runner.runOnce();
      }, 1500);
    }
    return ok;
  };
  process.on("exit", () => {
    try {
      process.kill(p.pid);
    } catch {}
  });
}
// デモ動画の場面（--design demo。M6-30）。AI は 3 本が 15:20 に実行中。C だけが合図で許可待ちになる
/** C（api-gateway · fix/auth-refresh）に Bash の許可待ちを書く（合図・--demo-waiting） */
let demoStop: ((t: number) => void) | null = null;
if (DEMO) {
  const run = (root: string, r: string, branch: string, title: string, t: number) => {
    const s = session(root, r, branch);
    step(t, () => {
      s.w.aiTitle(t, title);
      s.w.human(t, { text: title });
      hook("UserPromptSubmit", s.id, root, t);
    });
    return s;
  };
  run(
    main,
    "web-app",
    "feat/board-width",
    L("3日ボードの列幅を直して", "Fix the three-day board column widths"),
    at("13:20"),
  );
  run(
    acme,
    "docs-site",
    "docs/deploy",
    L("デプロイの手順を整理して", "Tidy up the deploy guide"),
    at("14:05"),
  );
  const c = run(
    main,
    "api-gateway",
    "fix/auth-refresh",
    L("リフレッシュトークンの 401 を直して", "Fix the 401 on token refresh"),
    at("14:50"),
  );
  demoStop = (t: number) => {
    c.w.toolUse(t, "Bash", {
      command: "bun test src/auth",
      description: L("認証のテストを走らせる", "Run the auth tests"),
    });
    hook("PermissionRequest", c.id, main, t, { tool_name: "Bash" });
  };
  // 実機の場面 (3): 起動の時点で止まっている（待ち <1m）
  if (args.includes("--demo-waiting")) {
    const t = NOW - 20_000;
    const stop = demoStop;
    step(t, () => stop(t));
  }
  // 実機用（--real-open）: C は動いている（Ghostty のタブ 3 のダミーの台本の pid）。A・B は動いていない扱い
  if (REAL_OPEN) {
    const pid = Number(DEMO_PID);
    mkdirSync(join(main, "sessions"), { recursive: true });
    writeFileSync(
      join(main, "sessions", `${pid}.json`),
      JSON.stringify({ pid, sessionId: c.id, status: "busy", updatedAt: NOW }),
    );
  }
}
// 5分ごとの tick（返答タスクを猶予の終わりに作る）。--design ai は1分ごと（猶予の後の「タスクなし」の数分を作らない）
for (let t = at("09:00", -1); t <= NOW; t += 5 * MIN) step(t, () => {});
if (DESIGN === "ai") for (let t = at("09:00"); t <= NOW; t += MIN) step(t + 1000, () => {});

const PRS: Record<
  number,
  { title: string; head: string; merged: boolean; mergedAt?: number; review?: string }
> = {
  142:
    DESIGN === "glance"
      ? {
          title: L("日表示の列幅を直す", "Fix day view column widths"),
          head: "fix/day-view-width",
          merged: false,
          review: "REVIEW_REQUIRED",
        }
      : DESIGN === "ai"
        ? {
            title: L("日表示のレーン分け", "Split the day view into lanes"),
            head: "feat/day-lanes",
            merged: false,
            review: "REVIEW_REQUIRED",
          }
        : {
            title: DESIGN ? L("日表示", "day view") : "Day view lanes",
            head: "feat/day-view",
            merged: false,
          },
  151: { title: "Week scroll", head: "feat/week-scroll", merged: false },
  // --design away（離席の間に開いた PR）
  190: {
    title: L("右の列の幅をそろえる", "Align the right column widths"),
    head: "fix/board-width",
    merged: false,
    review: "REVIEW_REQUIRED",
  },
  // --launch の PR を開いて AI 完了
  160: {
    title: L("設定画面の文言をそろえる", "Align the settings copy"),
    head: "tl/settings-copy-0412",
    merged: false,
    review: "REVIEW_REQUIRED",
  },
  138: { title: "Dependency update", head: "chore/deps", merged: true },
  // --design pr-question（開いたまま・承認済み）
  180: {
    title: L("fix: アラートの対象外の施設を追加", "fix: skip alerts for archived sites"),
    head: "fix/issue-42",
    merged: false,
    review: "APPROVED",
  },
  // --design pr-subject（ターンの無い PR のカード）
  8: {
    title: L(
      "LP の「URL を送るだけ」を招待リンクに、通知の文言を直す",
      "Use the invite link on the landing page and fix the notice wording",
    ),
    head: "fix/lp-notify-wording",
    merged: false,
    review: "REVIEW_REQUIRED",
  },
  9: {
    title: L(
      "登録・課金の CV に流入元（UTM・参照元ホスト）を記録する",
      "Record the traffic source (UTM, referrer host) on signup and checkout",
    ),
    head: "feat/signup-utm",
    merged: false,
    review: "REVIEW_REQUIRED",
  },
  10: {
    title: L(
      "fix(widget): 動画や遅延読み込みの画像のあるページのスクリーンショット",
      "fix(widget): screenshots of pages with video and lazy images",
    ),
    head: "fix/screenshot",
    merged: false,
    review: "REVIEW_REQUIRED",
  },
  // --design stale-title（15:00 にマージ）
  170: {
    title: L(
      "docs: 本番デプロイのブランチを main に一本化",
      "docs: deploy production from main only",
    ),
    head: "docs/deploy-branch",
    merged: true,
    mergedAt: at("15:00"),
    review: "APPROVED",
  },
  // --design ai の F（13:20 にマージ。その時刻までは開いている）
  139: {
    title: L("検索の結果を日付で絞り込む", "Filter search results by date"),
    head: "feat/search-date",
    merged: true,
    mergedAt: at("13:20"),
    review: "APPROVED",
  },
};
const gh: GhClient = {
  viewer: () => "dev",
  prView: (_repo, n) => {
    const p = PRS[n];
    if (!p) return null;
    const mergedAt = p.mergedAt ?? at("20:55", -1);
    const merged = p.merged && clock.now() >= mergedAt;
    return {
      state: merged ? "merged" : "open",
      reviewDecision: p.review ?? null,
      title: p.title,
      url: `https://example.invalid/pull/${n}`,
      headRefName: p.head,
      mergedAt: merged ? mergedAt : null,
      closedAt: merged ? mergedAt : null,
      reviews: [],
    };
  },
};

// ---------- 予定（偽のカレンダー。デーモンが同期して calendar_event に入れる） ----------
let evSeq = 0;
const event = (
  title: string,
  start: number,
  end: number,
  p: {
    allDay?: string;
    free?: boolean;
    busy?: boolean;
    calendarId?: string;
    attendees?: boolean;
    url?: string;
    location?: string;
    conferenceUrl?: string;
  } = {},
): HelperEvent => ({
  calendarId: p.calendarId ?? "dev-work",
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
  // EventKit の終日予定は既定で free（祝日カレンダーも free。phase0-plan 3.3.1）。時刻付きは既定で busy
  availability: p.free || (p.allDay && !p.busy) ? "free" : "busy",
  selfResponse: p.allDay ? null : "accepted",
  eventId: `dev-ev-${evSeq}`,
  url: p.url ?? null,
  location: p.location ?? null,
  conferenceUrl: p.conferenceUrl ?? null,
  // 時刻付きの会議は参加者あり（読み取り専用。D-093）。attendees: false で参加者なし（編集できる）
  hasAttendees: p.attendees ?? !p.allDay,
  recurring: false,
});
const calendarProvider = new FakeCalendarProvider({
  connected: false,
  calendars: [
    { id: "dev-work", title: "Work", colorHex: "#6b8cc7", allowsModify: true, type: "calDAV" },
    // 書き込めるもう1つのカレンダー（予定のパネルのカレンダーの選択。D-093）
    {
      id: "dev-personal",
      title: "Personal",
      sourceTitle: "Example",
      colorHex: "#9b7cf0",
      allowsModify: true,
      type: "calDAV",
    },
    {
      id: "dev-holidays",
      title: "Holidays",
      colorHex: "#4fb3a9",
      allowsModify: false,
      type: "subscription",
    },
  ],
  events:
    DESIGN === "ai"
      ? [event(L("定例", "Weekly sync"), at("14:00"), at("14:45"))]
      : DESIGN
        ? [
            // 確定デザインの画像（D-114）: 予定 2h30m
            event(L("朝会", "Standup"), at("10:00"), at("10:15")),
            event(L("デザインレビュー", "Design review"), at("11:00"), at("12:00")),
            event(L("1on1", "1:1"), at("14:00"), at("14:30")),
            event(L("プロダクト定例", "Product sync"), at("16:00"), at("16:45")),
          ]
        : [
            event("Weekly sync", at("10:00", -1), at("10:45", -1)),
            event("Interview", at("15:00", -1), at("16:00", -1)),
            ...(DENSE
              ? [
                  event(L("朝会", "Standup"), at("09:30"), at("09:45")),
                  event("プロダクト定例（ロードマップの優先度の見直し）", at("11:00"), at("12:00")),
                  event(L("1on1", "1:1"), at("14:00"), at("14:30")),
                  event("デザインレビュー: 3日ボードと週表示", at("15:30"), at("16:15")),
                ]
              : [
                  event("Weekly sync", at("10:00"), at("10:45")),
                  event(
                    "Design review",
                    at("14:00"),
                    at("15:00"),
                    EVENT_DETAIL ? { conferenceUrl: "https://meet.example.com/abc-defg-hij" } : {},
                  ),
                  ...(EVENT_DETAIL
                    ? [
                        event("Pairing with Kim", at("16:00"), at("16:45"), {
                          attendees: false,
                          location: "Room 3",
                          conferenceUrl: "https://meet.example.com/pair-kim",
                        }),
                      ]
                    : []),
                ]),
            event("Release week", 0, 0, { allDay: TODAY, free: true }),
            event("1:1", at("13:00", 3), at("14:00", 3)),
            // 参加者のいない予定（Turnlane から動かせる。D-093）
            event("Dentist", at("08:00", 4), at("09:00", 4), { attendees: false }),
            // 以前の版がタスクの時間ブロックとして書いた予定（予定のレーンには出ない。設定の削除の対象。D-093）
            ...(args.includes("--no-timeblock-events")
              ? []
              : [
                  event("Old block A", at("16:00", -1), at("17:00", -1), {
                    attendees: false,
                    url: "dayline://timeblock/dev-old-a",
                  }),
                  event("Old block B", at("11:00", 1), at("11:30", 1), {
                    attendees: false,
                    url: "dayline://timeblock/dev-old-b",
                  }),
                ]),
            event("Planning", at("10:00", 5), at("11:00", 5)),
            // 祝日カレンダー（書き込み不可・終日・1日だけ → 自動で祝日カレンダーに採用される）
            event("Example Holiday", 0, 0, {
              allDay: addDays(TODAY, 4),
              calendarId: "dev-holidays",
            }),
            event("Another Holiday", 0, 0, {
              allDay: addDays(TODAY, 18),
              calendarId: "dev-holidays",
            }),
          ],
});

// 日報の AI 要約（M4-6）の偽の claude。stdin（日報）は読み捨て、固定の文を返す（--summary-fail は時間切れ）
const fakeBin = join(home, "fake-bin");
mkdirSync(fakeBin, { recursive: true });
const SUMMARY_FAIL = args.includes("--summary-fail");
writeFileSync(
  join(fakeBin, "claude"),
  `#!/bin/bash
for a in "$@"; do
  if [ "$a" = "--help" ]; then
    printf '  --output-format <format>\\n  --tools <tools...>\\n  --no-session-persistence\\n'; exit 0
  fi
done
input=$(cat)
${SUMMARY_FAIL ? "sleep 30" : "sleep 4"}
if printf '%s' "$input" | grep -q 'in Japanese'; then
  echo 'ログインのリファクタを進め、PR #142 をレビュー待ちに出した。料金ページの返答とデザインレビューが残り、2件を月曜へ持ち越した。'
else
  echo 'Pushed the login refactor forward and put PR #142 up for review. The pricing reply and the design review are still open; two tasks carry over to Monday.'
fi
`,
);
chmodSync(join(fakeBin, "claude"), 0o755);

// ---------- AI に頼む（D-107）: 偽の git・端末・CLI ----------
const LAUNCH = args.includes("--launch");
const launchSys = new FakeLaunchSystem();
if (args.includes("--codex")) launchSys.installed = ["claude_code", "codex"];
for (const r of git.repos.keys()) launchSys.paths.add(r);
// Claude のアカウント（D-122）: 一時 HOME の ~/.claude-main と ~/.claude-sandbox（2つあるので「アカウント」の行が出る）
launchSys.paths.add(main);
launchSys.paths.add(acme);
launchSys.reply((_c, a) => a[0] === "symbolic-ref" && a.at(-1) === "refs/remotes/origin/HEAD", {
  ok: true,
  out: "origin/main",
});
// PR の CI と変更の量（--design ai の D・F、--launch の PR）
launchSys.pr = {
  url: null,
  additions: 312,
  deletions: 48,
  files: 9,
  rollup: [
    { name: "test", status: "COMPLETED", conclusion: "SUCCESS" },
    { name: "lint", status: "COMPLETED", conclusion: "SUCCESS" },
  ],
};
if (DESIGN === "pr-subject")
  launchSys.pr = {
    url: null,
    additions: 12,
    deletions: 8,
    files: 2,
    rollup: [{ name: "test", status: "COMPLETED", conclusion: "SUCCESS" }],
  };
if (AWAY)
  launchSys.pr = {
    url: null,
    additions: 120,
    deletions: 8,
    files: 4,
    rollup: [{ name: "test", status: "COMPLETED", conclusion: "SUCCESS" }],
  };
const launchOpen = new FakeOpenSystem();
launchOpen.files.add("/Applications/Ghostty.app");
// --orca: 端末の選択肢に Orca が入っている扱い（D-122。偽の端末なので Orca は起動しない）
if (args.includes("--orca")) launchOpen.files.add("/Applications/Orca.app");

// --scratch: 開く先は偽の OS（Ghostty と Codex のアプリが入っている扱い。実際には何も起動しない）
const scratchOpen = new FakeOpenSystem();
scratchOpen.files.add("/Applications/Ghostty.app");
scratchOpen.files.add("/Applications/ChatGPT.app");
scratchOpen.bundles.set("/Applications/ChatGPT.app", "com.openai.codex");
// 壁打ちの作業フォルダ（ターミナルで再開する先。一時 HOME の下にあることにする）
scratchOpen.dirs.add(join(home, "Documents/Codex", TODAY));
scratchOpen.dirs.add(SCRATCH_DIR);
const clock = new FakeClock(at("08:00", -1));
const paths = {
  ...resolvePaths({ TURNLANE_DATA_DIR: dataDir, TURNLANE_PORT: String(PORT) }, home),
};
// 拡張（ADR 0015）: --ext <dir>（extension.json）。Web は --web-dist に拡張を組み込んだビルドを渡す（e2e/run.ts が作る）
const extDirs = extArgs(args);
const extFactories: DaemonExtensionFactory[] = [];
for (const m of readExtManifests(extDirs))
  if (m.daemon)
    extFactories.push(((await import(m.daemon)) as { default: DaemonExtensionFactory }).default);
const dist = resolve(opt("--web-dist") ?? join(ROOT, "apps/web/dist"));
const d = await startDaemon({
  paths,
  logger: nullLogger,
  assets: await assetsFromDir(dist),
  clock,
  port: PORT,
  ingest: {
    vars: {},
    git,
    gh,
    noWatch: true,
    ...(SCRATCH
      ? { openSystem: scratchOpen }
      : DESIGN === "answer" || DESIGN === "instruct"
        ? { openSystem: answerOpen }
        : {}),
  },
  calendar: { provider: calendarProvider },
  // 実際の claude / codex を探さない（ログインシェルを使わず、偽の claude の場所だけを見る）
  summary: { detect: { shell: null, knownDirs: [fakeBin] } },
  // 頼むと偽の端末に記録するだけ（紐づけは下の取り込みの間に回す）
  launch: {
    cliPath: DEVBOARD_CLI,
    sys: launchSys,
    open: launchOpen,
    intervalMs: 3_600_000,
    // 完了のときの片付けで AI の終わりを待つ長さ（偽の端末では終わらないので短く）
    finishWaitMs: 1_500,
  },
  extensions: extFactories,
  // スリープさせないは記録だけ（caffeinate を起こさない）
  power: new FakePower(),
  // ダミーデータは同意済みとして取り込む（オンボーディングの画面はまだ無い。M6-21）
  onboarding: { assumeDone: true },
});
putSetting(d.mutateCtx, "tz", TZ);
if (SCRATCH) putSetting(d.mutateCtx, "ai.scratch_dirs", [SCRATCH_DIR]);
if (args.includes("--summary") || SUMMARY_FAIL || args.includes("--summary-saved"))
  putSetting(d.mutateCtx, "report.ai_summary", {
    enabled: true,
    tool: "claude_code",
    ...(SUMMARY_FAIL ? { timeout_sec: 10 } : {}),
  });

// 在席（D-105。Mac を使っていた時間）: デーモンは実機の入力を読まない（presence を渡さない）ので、区間を直接入れる。
// 昨日は 8:30〜19:45、今日は 8:35 から今まで
{
  const pdb = new Database(paths.dbPath);
  const span = (start: number, end: number) => {
    // 保存は入力のあった区間（D-139）。既定の T（5 分）で読んだときに [start, end] になる形で入れる
    if (end > start) seedPresence(pdb, `dev-${start}`, start, end);
  };
  if (DESIGN === "away-night") {
    // 昨日 19:02 に離れ、今朝 8:35 に戻った
    span(at("08:30", -1), at("19:02", -1));
    span(at("08:35"), NOW);
  } else if (DESIGN === "away") {
    // 17:14〜17:48 の離席
    span(at("08:30", -1), at("19:45", -1));
    span(at("08:35"), at("17:14"));
    span(at("17:48"), NOW);
  } else span(at("08:30", -1), at("19:45", -1));
  if (AWAY) {
    // 上で入れた
  } else if (DESIGN === "ai") {
    // E の離席（13:15〜13:28 は Mac を使っていない）
    span(at("08:35"), at("13:15"));
    span(at("13:28"), NOW);
  } else span(at("08:35"), NOW);
  pdb.close();
}

// --launch: タスクから AI に頼んだ状態（D-107）。タスクと依頼は先に入れ、セッションは取り込みの間に紐づく
if (LAUNCH) {
  const ldb = new Database(paths.dbPath);
  const rel = (min: number) => NOW + min * MIN;
  let lseq = 0;
  let lkey = orderKeyBetween(null, null);
  const launchTask = (
    title: string,
    r: string,
    branch: string | null,
    o: { at: number; claimed: boolean; tool?: "claude_code" | "codex"; notes?: string },
  ) => {
    lkey = orderKeyAfter(lkey);
    const tk = insertRow(d.mutateCtx, schema.task, {
      title,
      status: "todo",
      scheduledDate: TODAY,
      laneOrder: lkey,
      source: "manual",
      estimateMin: 30,
      ...(o.notes ? { notesMd: o.notes } : {}),
    });
    lseq++;
    const id = `${String(lseq).padStart(2, "0")}${"0".repeat(30)}`;
    const uuid = `00000000-0000-4000-9000-${String(lseq).padStart(12, "0")}`;
    const wt = branch ? `${repo(r)}-wt/${branch.replace("/", "-")}` : null;
    if (wt) {
      launchSys.paths.add(wt);
      git.repos.set(wt, repo(r));
      git.branches.set(wt, branch as string);
    }
    ldb.run(
      `INSERT INTO ai_launch (id, task_id, tool, repo_root, cwd, worktree_path, branch, base_ref, template_id, read_only,
         trigger, session_uuid, status, created_at, fetched_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'origin/main', 'builtin:implement', 0, 'manual', ?, ?, ?, ?, ?)`,
      [
        id,
        tk.id,
        o.tool ?? "claude_code",
        repo(r),
        wt ?? repo(r),
        wt,
        branch,
        uuid,
        o.claimed ? "started" : "pending",
        o.at,
        o.claimed ? o.at + 20_000 : null,
        o.at,
      ],
    );
    return { uuid, cwd: wt ?? repo(r), branch: branch ?? "main", id };
  };
  const tr = (l: { uuid: string; cwd: string; branch: string }) =>
    claudeTranscript(main, { sid: l.uuid, cwd: l.cwd, branch: l.branch });
  // 起動できなかった（ターミナルでコマンドが実行されなかった）
  launchTask(L("依存関係の更新", "Update dependencies"), "infra", "tl/update-deps-2207", {
    at: rel(-240),
    claimed: false,
  });
  // 編集して AI 完了 · 確認（差分・テスト通過）
  const e = launchTask(
    L("README の手順を更新", "Update the README steps"),
    "blog",
    "tl/readme-steps-5530",
    {
      at: rel(-150),
      claimed: true,
    },
  );
  {
    const w = tr(e);
    step(rel(-149), () => w.human(rel(-149)));
    step(rel(-118), () => w.assistantEnd(rel(-118), "Done.", { edits: 3, durationMs: 31 * MIN }));
    launchSys.reply((c, a) => c === e.cwd && a[0] === "merge-base", { ok: true, out: "abc1234" });
    launchSys.reply((c, a) => c === e.cwd && a[0] === "diff", {
      ok: true,
      out: "42\t8\tdocs/setup.md\n6\t2\tREADME.md\n3\t0\tscripts/setup.sh",
    });
    launchSys.reply((c, a) => c === e.cwd && a[0] === "rev-list", { ok: true, out: "2" });
    ldb.run("UPDATE ai_launch SET test_ok = 1, test_at = ? WHERE id = ?", [rel(-100), e.id]);
  }
  // PR を開いて AI 完了（CI 通過。PR のレビューの自分の番が頼んだタスクに付く）
  const dd = launchTask(
    L("設定画面の文言をそろえる", "Align the settings copy"),
    "turnlane",
    "tl/settings-copy-0412",
    { at: rel(-200), claimed: true },
  );
  {
    const w = tr(dd);
    step(rel(-199), () => w.human(rel(-199)));
    step(rel(-150), () => {
      w.prLink(rel(-151), "example/turnlane", 160);
      w.assistantEnd(rel(-150), "Opened the PR.", { edits: 9, durationMs: 49 * MIN });
    });
  }
  // 質問で止まって自分の番（返答。頼んだタスクに付いて帯に出る）
  const c = launchTask(
    L("検索のインデックスを作り直す", "Rebuild the search index"),
    "turnlane",
    "tl/search-index-7731",
    { at: rel(-80), claimed: true },
  );
  {
    const w = tr(c);
    step(rel(-79), () => w.human(rel(-79)));
    step(rel(-52), () =>
      w.assistantEnd(rel(-52), "Should I keep the old index until the new one is ready?", {
        durationMs: 27 * MIN,
      }),
    );
  }
  // 紐づいた AI が実行中（ブランチは取り込まれていない。完了のシートの赤字の確認用）
  const b = launchTask(
    L("日表示のレーン幅を直す", "Fix the day view lane widths"),
    "turnlane",
    "tl/lane-widths-1186",
    {
      at: rel(-30),
      claimed: true,
      notes: L("3日ボードの今日の列と同じ比率にする", "Match the today column of the 3-day board"),
    },
  );
  {
    const w = tr(b);
    launchSys.reply(
      (c, a) => c === repo("turnlane") && a[1] === "--is-ancestor" && a[2] === b.branch,
      { ok: false, out: "" },
    );
    launchSys.reply(
      (c, a) =>
        c === repo("turnlane") && a[0] === "rev-list" && a[2] === `origin/main..${b.branch}`,
      { ok: true, out: "2" },
    );
    // hooks あり（UserPromptSubmit から Stop まで実行中）
    step(rel(-29), () => {
      w.human(rel(-29));
      hook("UserPromptSubmit", b.uuid, main, rel(-29));
    });
  }
  // 起動直後（ターミナルで実行したが、まだセッションが見つからない）
  launchTask(L("ログのローテーションを直す", "Fix log rotation"), "infra", "tl/log-rotation-0951", {
    at: rel(-1),
    claimed: true,
  });
  // 頼んでいないタスク（ホバー・右クリックの「AI に頼む」の確認用）
  insertRow(d.mutateCtx, schema.task, {
    title: L("請求書CSVの列名を英語に", "Rename the invoice CSV columns"),
    status: "todo",
    scheduledDate: TODAY,
    laneOrder: orderKeyBetween(null, null),
    source: "manual",
    estimateMin: 30,
  });
  ldb.close();
  // README の作業は確認支援のテストのコマンドを入れたプロジェクトに入れる
}

// 事実を時刻順に書きながら取り込み・判定を回す
const ai = d.ai;
if (!ai) throw new Error("ingest is not running");
await ai.supervisor.detect();
steps.sort((a, b) => a.at - b.at);
for (const s of steps.filter((x) => x.at <= NOW)) {
  clock.set(s.at);
  s.run();
  await ai.supervisor.scanAll();
  await ai.supervisor.whenIdle();
  ai.poller?.pollOnce();
  // 頼んだ AI とセッションの紐づけ（D-107）。判定の前に（自分の番を頼んだタスクに付けるため）
  d.launch?.tick();
  ai.runner.runOnce();
}
clock.set(NOW);
d.launch?.tick();
await ai.supervisor.detect();
ai.runner.runOnce();
// --design pr-subject: 自分の番の行の変更の量（gh の控え。偽の端末の PR の値）を先に読んでおく
if (DESIGN === "pr-subject")
  for (const n of [8, 9, 10, 180])
    await d.launch?.prChange(`example/${n === 180 ? "web-app" : "storefront"}#${n}`);

// ---------- 予定・タスク（DB に直接） ----------
const db = new Database(paths.dbPath);
const ctx = d.mutateCtx;
const project = (name: string, color: string) => insertRow(ctx, schema.project, { name, color }).id;
const blog = DESIGN ? "" : project("blog", "#c9a24b");
let turnlaneProject = "";
if (DESIGN) {
  project("turnlane", "#6b8cc7");
  project("billing-api", "#b8875a");
  project("api-gateway", "#8a9a6b");
} else {
  turnlaneProject = project("turnlane", "#9b7bff");
  project("api-gateway", "#4fb3a9");
  project("infra", "#8a8e95");
}
// --launch の頼んでいないタスクは Turnlane のプロジェクト（依頼のポップオーバーの「（プロジェクトの既定）」）
if (LAUNCH)
  db.run(
    "UPDATE task SET project_id = (SELECT id FROM project WHERE name = 'turnlane' AND deleted_at IS NULL) WHERE title = ?",
    [L("請求書CSVの列名を英語に", "Rename the invoice CSV columns")],
  );
// AI に頼む（D-107）: プロジェクトのリポジトリ（依頼のポップオーバーのリポジトリの既定）と確認支援のテストのコマンド
for (const [name, test] of [
  ["turnlane", "bun test"],
  ["blog", "bun test"],
  ["infra", null],
  ["api-gateway", null],
  ["billing-api", null],
] as const)
  db.run("UPDATE project SET repo_paths_json = ?, test_command = ? WHERE name = ?", [
    JSON.stringify([repo(name)]),
    test,
    name,
  ]);

let order = 0;
const task = (
  title: string,
  date: string | null,
  p: Partial<typeof schema.task.$inferInsert> & { block?: [number, number] } = {},
) => {
  const { block, ...rest } = p;
  const row = insertRow(ctx, schema.task, {
    title,
    status: "todo",
    scheduledDate: date,
    laneOrder: `a${String(++order).padStart(3, "0")}`,
    source: "manual",
    ...rest,
  });
  if (block)
    insertRow(ctx, schema.timeBlock, {
      taskId: row.id,
      startAt: block[0],
      endAt: block[1],
      tz: TZ,
    });
  return row;
};
const Y = addDays(TODAY, -1);
const done = (t: number) => ({ status: "done" as const, completedAt: t });
if (DESIGN) {
  // 確定デザインの画像（D-114）
  task(L("API設計のメモ", "API design notes"), Y, {
    estimateMin: 45,
    block: [at("10:00", -1), at("10:45", -1)],
    ...done(at("10:45", -1)),
  });
  task(L("請求書の確認", "Check invoices"), Y, {
    estimateMin: 45,
    block: [at("13:00", -1), at("13:45", -1)],
    ...done(at("13:45", -1)),
  });
  if (DESIGN === "day") {
    task(L("メール確認", "Morning email"), TODAY, {
      estimateMin: 25,
      block: [at("09:06"), at("09:31")],
      ...done(at("09:31")),
    });
  }
  task(L("週次レポートのドラフト", "Draft weekly report"), TODAY, {
    estimateMin: 30,
    block: DESIGN === "day" ? [at("09:31"), at("10:00")] : [at("09:00"), at("09:30")],
    ...done(at("10:00")),
  });
  // --design demo（デモ動画）は価格の語をダミーから外す（README の画面写真の言い換えと同じ）
  task(
    DEMO
      ? L("申し込みページの文言", "Signup page copy")
      : L("価格ページの文言", "Pricing page copy"),
    TODAY,
    {
      estimateMin: 70,
      block: [at("12:30"), at("13:40")],
      ...done(at("13:40")),
    },
  );
  task(L("請求書CSVのレビュー", "Review invoice CSV"), TODAY, {
    estimateMin: 45,
    block: [at("15:00"), at("15:45")],
  });
  task(L("経費精算を出す", "Submit expenses"), TODAY, { estimateMin: 20 });
  task(L("スプリント計画の準備", "Prep sprint planning"), addDays(TODAY, 3), {
    estimateMin: 45,
    block: [at("10:00", 3), at("10:45", 3)],
  });
  for (const x of [
    L("領収書をスキャンする", "Scan receipts"),
    L("読書メモの整理", "Tidy reading notes"),
    L("会議室の予約", "Book a meeting room"),
    L("ニュースレターの下書き", "Draft newsletter"),
  ])
    task(x, null, {});
} else {
  task("Send invoice", Y, {
    estimateMin: 30,
    block: [at("09:00", -1), at("09:30", -1)],
    ...done(at("09:31", -1)),
  });
  task("Update price list", Y, {
    estimateMin: 60,
    block: [at("11:00", -1), at("12:00", -1)],
    ...done(at("12:02", -1)),
  });
  task("Review analytics", Y, {
    estimateMin: 30,
    block: [at("13:00", -1), at("13:30", -1)],
    ...done(at("13:30", -1)),
  });
  task("Expense report", Y, {
    estimateMin: 20,
    block: [at("16:20", -1), at("16:40", -1)],
    ...done(at("16:40", -1)),
  });
  task("Call the bank", Y, {
    estimateMin: 15,
    block: [at("17:00", -1), at("17:15", -1)],
    ...done(at("17:15", -1)),
  });
  task("Book flights", Y, {
    estimateMin: 20,
    block: [at("17:30", -1), at("17:50", -1)],
    ...done(at("17:50", -1)),
  });
  task("Draft newsletter", Y, { block: [at("18:00", -1), at("18:30", -1)] });
  task("Clean up downloads", Y, {});
  if (DENSE) {
    task("朝のメール確認とSlackの未読を片付ける", TODAY, {
      estimateMin: 20,
      block: [at("09:00"), at("09:20")],
      ...done(at("09:20")),
    });
    task("週次レポートのドラフトを書いて共有フォルダに置く", TODAY, {
      estimateMin: 45,
      projectId: blog,
      block: [at("12:15"), at("13:00")],
      ...done(at("13:02")),
    });
    task("採用面接の評価シートを記入して人事に送る", TODAY, {
      estimateMin: 30,
      block: [at("17:15"), at("17:45")],
    });
    task("来週のスプリント計画のたたき台を作る", TODAY, {
      estimateMin: 45,
      block: [at("18:00"), at("18:45")],
    });
    task("経費精算（9月分）の領収書をまとめて申請する", TODAY, { estimateMin: 20 });
    task("3日ボードの使い勝手をチームに共有する", addDays(TODAY, 3), {
      estimateMin: 30,
      block: [at("10:00", 3), at("10:30", 3)],
    });
    task("四半期の目標の振り返りメモを書く", addDays(TODAY, 3), { rolloverCount: 2 });
  } else if (!MORNING) {
    task("Reply to PR #138 comment", TODAY, {
      estimateMin: 8,
      block: [at("08:50"), at("08:58")],
      ...done(at("08:58")),
    });
    // 所要時間は確定デザインのダミーデータ（Morning email 25m、Check DnD 8m）に合わせる。以前は題名が入れ替わっていた（D-052 (4)）
    task("Check DnD", TODAY, {
      estimateMin: 8,
      block: [at("08:58"), at("09:06")],
      ...done(at("09:06")),
    });
    task("Morning email", TODAY, {
      estimateMin: 25,
      block: [at("09:06"), at("09:31")],
      ...done(at("09:31")),
    });
    task("Write article outline", TODAY, {
      estimateMin: 45,
      projectId: blog,
      block: [at("14:15"), at("15:00")],
    });
    task("Invoice template fix", TODAY, { estimateMin: 15, block: [at("15:30"), at("15:45")] });
    if (NIGHT)
      // 0:00 をまたいで置いたタスク（週ボードでは両日の列に分けて描く）
      task("Deploy hotfix", TODAY, { estimateMin: 60, block: [at("23:30"), at("00:30", 1)] });
    task("Blog draft", addDays(TODAY, 1), {
      estimateMin: 60,
      projectId: blog,
      block: [at("10:00", 1), at("11:00", 1)],
    });
    task("Tax return documents", addDays(TODAY, 3), { rolloverCount: 3 });
    task("Research Raycast extension", addDays(TODAY, 3), {
      block: [at("10:00", 3), at("10:30", 3)],
    });
  } else {
    // 朝（--morning。D-192）: 昨日の列に残った 3 件（未定 2 件と、時間に置いたまま終わらなかった 1 件）と、14 日以内の古い残り。
    // 今日の計画は空き（10:00〜19:00 − 予定 1h45m = 7h15m）を超える（見出しの「計画」が琥珀）
    task("Tax return documents", Y, { rolloverCount: 2, estimateMin: 45 });
    task("Write the article outline", Y, { estimateMin: 50 });
    task("Reply to the accountant", Y, {
      estimateMin: 15,
      block: [at("16:00", -1), at("16:15", -1)],
    });
    task("Renew the domain", addDays(TODAY, -6), { estimateMin: 15 });
    task("Book the dentist", addDays(TODAY, -9));
    task("Blog draft", TODAY, {
      estimateMin: 60,
      projectId: blog,
      block: [at("10:45"), at("11:45")],
    });
    task("Pricing page copy", TODAY, { estimateMin: 90, block: [at("12:30"), at("14:00")] });
    task("Weekly review", TODAY, { estimateMin: 45, block: [at("15:00"), at("15:45")] });
    task("Refactor sidebar", TODAY, { estimateMin: 120, block: [at("16:00"), at("18:00")] });
    task("Inbox zero", TODAY, { estimateMin: 40 });
    task("Research Raycast extension", TODAY, { estimateMin: 30 });
    task("Write article outline", TODAY, { estimateMin: 50, projectId: blog });
    task("Prepare demo", TODAY, { estimateMin: 60 });
  }
}
if (!DESIGN) {
  // Inbox（Inbox のレビュー v1 の確認用）: 出どころ（Claude Code / Codex の MCP・GitHub・CLI・手入力）、見積もり、
  // プロジェクト、メモ、長い日本語の題名、7日以上残ったもの。作成は新しい順に並ぶので、古いものから入れる
  const ago = (title: string, days: number) =>
    db.run("UPDATE task SET created_at = ? WHERE title = ?", [NOW - days * 86_400_000, title]);
  task("Read the OKR doc", null, {});
  ago("Read the OKR doc", 9);
  task(
    "請求書テンプレートの税率表示を新しい区分に合わせて直し、過去分の再発行が要るかを確認する",
    null,
    {
      estimateMin: 45,
      projectId: blog,
      notesMd: "Check the 2 invoices from last month first.",
    },
  );
  ago(
    "請求書テンプレートの税率表示を新しい区分に合わせて直し、過去分の再発行が要るかを確認する",
    3,
  );
  task("Rotate the staging API keys", null, { source: "cli", estimateMin: 20 });
  ago("Rotate the staging API keys", 2);
  task("Write the migration notes", null, {
    source: "mcp",
    sourceRef: "mcp:codex:/w/api-gateway",
    estimateMin: 30,
  });
  ago("Write the migration notes", 1);
  task("Fix login redirect", null, {
    externalSource: "github",
    externalId: "issue-42",
    externalUrl: "https://example.invalid/issues/42",
    projectId: turnlaneProject,
    estimateMin: 60,
  });
  task("Try the add_task tool", null, {
    source: "mcp",
    sourceRef: "mcp:claude-code:/w/turnlane",
    projectId: turnlaneProject,
    estimateMin: 15,
    notesMd: "Ask it to file one task from the review.",
  });
}
// 確定デザインの「今日閉じた」（D-114）: 返答の閉じ方を画像に合わせる
for (const [key, status, closedAt, reason] of designClose) {
  const where = `status = 'open' AND work_item_id IN (SELECT id FROM work_item WHERE group_key LIKE ?)`;
  db.run(
    `UPDATE task SET status = ?, completed_at = ? WHERE id IN (SELECT task_id FROM follow_up WHERE ${where})`,
    ["canceled", closedAt, `%${key}`],
  );
  db.run(`UPDATE follow_up SET status = ?, closed_at = ?, close_reason = ? WHERE ${where}`, [
    status,
    closedAt,
    reason,
    `%${key}`,
  ]);
}
// --stale-blocks: 外部（MCP の schedule_task）から日付・時刻を何度か変えて、前の日付の時間ブロックが残ったタスク
// （週ボードで未定から消えた不具合の確認用）。明日のタスクは明日 14:00 と今日 11:00 のブロック、明後日のタスクは
// 明後日にかからないブロック（今日 12:00・明日 23:00）だけ。比べるために、ブロックの無い明後日のタスクも足す
if (args.includes("--stale-blocks")) {
  const ext = (id: string) => ({
    source: "mcp" as const,
    externalSource: "studio",
    externalId: id,
    projectId: turnlaneProject,
    estimateMin: 5,
  });
  const block = (taskId: string, start: number) =>
    insertRow(ctx, schema.timeBlock, { taskId, startAt: start, endAt: start + 5 * MIN, tz: TZ });
  const draft = task(L("週報: 下書き", "Weekly post: draft"), addDays(TODAY, 1), ext("post-1"));
  block(draft.id, at("11:00"));
  block(draft.id, at("14:00", 1));
  const publish = task(L("週報: 公開", "Weekly post: publish"), addDays(TODAY, 2), ext("post-2"));
  block(publish.id, at("12:00"));
  block(publish.id, at("23:00", 1));
  task(L("今週の振り返り", "Review the week"), addDays(TODAY, 2), {
    source: "cli",
    estimateMin: 30,
  });
}
// --place-reply 15:00: 「Reply: draft pricing」を朝 9:00 に今日の 15:00〜15:30 へ置いた状態（D-051 の確認用）
const placeReply = opt("--place-reply");
if (placeReply) {
  const fu = db
    .query<{ task_id: string }, []>(
      `SELECT f.task_id FROM follow_up f JOIN work_item w ON w.id = f.work_item_id
        WHERE w.group_key LIKE '%#draft/pricing' AND f.kind = 'reply' AND f.status = 'open'`,
    )
    .get();
  if (!fu) throw new Error("reply task for draft/pricing not found");
  const b = insertRow(ctx, schema.timeBlock, {
    taskId: fu.task_id,
    startAt: at(placeReply),
    endAt: at(placeReply) + 30 * MIN,
    tz: TZ,
  });
  db.run("UPDATE time_block SET created_at = ? WHERE id = ?", [at("09:00"), b.id]);
  // 今日の自分レーンへ落としたのと同じく、タスクの日付も今日にする（昨日の夜の返答タスク。日付が違うと時間軸に描かない）
  db.run("UPDATE task SET scheduled_date = ? WHERE id = ?", [TODAY, fu.task_id]);
}
db.close();
// ヘルパが接続した状態にして同期する（--calendar-off なら未接続のまま）
if (!args.includes("--calendar-off")) {
  // Calendar.app のデフォルトカレンダー（D-072）。--no-default-calendar なら無し
  calendarProvider.defaultCalendarId = args.includes("--no-default-calendar") ? null : "dev-work";
  calendarProvider.setConnected(true);
  await d.calendar?.service.whenIdle();
  if (d.calendar) await d.calendar.deps.sync();
  // --calendar-auth notDetermined|denied: 予定を取った後で権限が外れた状態（D-130 のサイドバーの知らせ）
  const auth = opt("--calendar-auth");
  if (auth === "notDetermined" || auth === "denied") {
    calendarProvider.setAuthorization(auth);
    await d.calendar?.service.whenIdle();
  }
}
// --live: 完了したセッションのプロセスが動いている扱い（AI の画面の「止まっている」と、最後の動きが 1 日より前の
// 「プロセスが残っている」。pid は起動した sleep）
if (LIVE && liveSid) {
  mkdirSync(join(main, "sessions"), { recursive: true });
  for (const id of [liveSid, ...staleSids, ...(limitSid ? [limitSid] : [])]) {
    const p = Bun.spawn(["/bin/sleep", "86400"], { stdin: "ignore", stdout: "ignore" });
    process.on("exit", () => {
      try {
        process.kill(p.pid);
      } catch {}
    });
    writeFileSync(
      join(main, "sessions", `${p.pid}.json`),
      JSON.stringify({ pid: p.pid, sessionId: id, status: "idle", updatedAt: NOW }),
    );
  }
  await ai.supervisor.probeLive();
  // 利用上限の項目の上限待ちを対応不要にする（後でに出さない。カードは done · rate_limit のまま）
  if (limitSid && !KEEP_LIMIT) {
    const ldb = new Database(paths.dbPath);
    const wi = ldb
      .query<{ id: string }, [string]>(
        "SELECT t.work_item_id AS id FROM ai_turn t JOIN ai_session s ON s.id = t.session_id WHERE s.external_id = ? AND t.work_item_id IS NOT NULL LIMIT 1",
      )
      .get(limitSid);
    ldb.close();
    if (wi) ai.deps.ops.dismissLimit(wi.id);
  }
}
// --design answer: 動いているセッション（sessions/<pid>.json）を先に読む（届け先が「動いていない」にならないように）
if (DESIGN === "answer" || DESIGN === "instruct" || REAL_OPEN) await ai.supervisor.probeLive();
ai.runner.runOnce();

// --source-health <L1|L2|L3>[,<L1|L2|L3>]: 取り込み元（main, sandbox の順）の状態を推定・停止にする（D-118 のサイドバーの知らせの確認用）。
// デーモンの監視は偽の時計を進めないと走らないので、取り込みの後に書いた値がそのまま出る
const sourceHealth = opt("--source-health");
if (sourceHealth) {
  const hdb = new Database(paths.dbPath);
  const levels = sourceHealth.split(",");
  for (const [i, root] of [main, acme].entries()) {
    const level = levels[i];
    if (!level || !["L0", "L1", "L2", "L3"].includes(level)) continue;
    hdb.run("UPDATE ai_source SET health_level = ?, health_reason = ? WHERE root_path = ?", [
      level,
      level === "L0" ? null : level === "L3" ? "parser disabled" : "hooks silent",
      root,
    ]);
  }
  hdb.close();
}
// 画面の言語・テーマ（スクリーンショット用）
const lang = opt("--lang");
if (lang === "en" || lang === "ja") putSetting(ctx, "ui.language", lang);
const theme = opt("--theme");
if (theme === "dark" || theme === "light") putSetting(ctx, "ui.theme", theme);

// --summary-saved: 今日の要約を保存済みにする（日報の画面の確認用）
if (args.includes("--summary-saved")) {
  const ja = lang === "ja";
  const md = ja
    ? "ログインのリファクタを進め、PR #142 をレビュー待ちに出した。料金ページの返答とデザインレビューが残った。"
    : "Pushed the login refactor forward and put PR #142 up for review. The pricing reply and the design review are still open.";
  const sdb = new Database(paths.dbPath);
  const note = sdb
    .query<{ id: string }, [string]>(
      "SELECT id FROM daily_note WHERE date = ? AND deleted_at IS NULL",
    )
    .get(TODAY);
  sdb.close();
  const patch = { aiSummaryMd: md, aiSummaryTool: "claude_code" as const, aiSummaryAt: NOW };
  if (note) updateRow(ctx, schema.dailyNote, note.id, patch);
  else insertRow(ctx, schema.dailyNote, { date: TODAY, ...patch });
}

const next = opt("--open") ?? "/board";
const url = `http://127.0.0.1:${PORT}/auth?t=${d.token}&next=${encodeURIComponent(next)}`;
writeFileSync(join(home, "url.txt"), url);
console.log(`turnlane dev board (dummy data, now = ${new Date(NOW).toISOString()})`);
console.log(`HOME: ${home}`);
console.log(`token: ${d.token}`);
console.log(url);

// --demo-notify: 起動の後に許可待ちを1件足す（デスクトップアプリの通知・メニューバーの確認用）
// --design demo は新しいセッションを足さず、動いていた C が Bash の許可を待って止まる（今の線は 15:20 のまま）
const demo = opt("--demo-notify");
if (demo) {
  setTimeout(async () => {
    if (demoStop) {
      // 時計は 15:20 のまま。止まった時刻は在席の区間（今まで）の中に置く（外だと待ちが「15:20 から」の形になる）
      demoStop(clock.now() - 2000);
    } else {
      const { id, w } = session(acme, "turnlane", "feat/menu-bar");
      const t = clock.now() + MIN;
      clock.set(t);
      w.human(t);
      hook("UserPromptSubmit", id, acme, t);
      hook("PermissionRequest", id, acme, t + 1000);
      clock.set(t + 2000);
    }
    await ai.supervisor.scanAll();
    await ai.supervisor.whenIdle();
    ai.runner.runOnce();
    console.log("demo: added a new approval request (needs_input)");
  }, Number(demo) * 1000);
}
console.log(`TURNLANE_DATA_DIR=${dataDir} TURNLANE_PORT=${PORT}`);

const stop = async () => {
  await d.stop();
  rmSync(home, { recursive: true, force: true });
  process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
