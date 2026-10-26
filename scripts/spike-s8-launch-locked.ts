/**
 * S8: 画面のロック中・スクリーンセーバー中・ディスプレイのスリープ中に、人のいないときの起動（拡張の時刻・条件による起動。
 * ExtDeps.launcher.launch の unattended）で端末の新しいタブが開き、turnlane ai run が受け取れるか。
 * 手順と結果は docs/spikes/s8-launch-while-locked.md。利用者の画面に端末のタブ・ウインドウが開くので、利用者が立ち会って流す。
 *
 *   bun scripts/spike-s8-launch-locked.ts --terminal ghostty|orca|terminal --case lock|screensaver|display-sleep
 *     [--mode raw|unattended] [--delay 45] [--port 27495] [--results <jsonl>] [--dry-run]
 *
 * - raw: ロックの検査を飛ばして、その時点で端末を開いてみる（ロック中に開けるかを確かめる）
 * - unattended: 本体の動きのまま。ロック中は locked（screen_locked）で何も開かず、30 秒ごとにやり直し、ロックが外れたら開く
 * - --dry-run: 端末を開かない（端末に入力するはずのコマンドを、このプロセスの子として裏で実行する）。手順の確かめ用。
 *   スクリーンセーバー・ディスプレイのスリープも起こさない
 *
 * 触るもの: 一時ディレクトリ（ダミーのリポジトリ・データ・偽の claude）、選んだ端末（新しいタブ・ウインドウ）、
 * Orca を選んだときは Orca にダミーのリポジトリが登録される（終わったら Orca で外す）。
 * 触らないもの: 利用者の常駐デーモン（7317）・データ・hooks・実際の claude / codex（偽の claude が引数を記録するだけ）
 */
import { Database } from "bun:sqlite";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { LaunchDeferred } from "../apps/daemon/src/ext/types.ts";
import { SystemLaunch } from "../apps/daemon/src/launch/system.ts";
import { startDaemon } from "../apps/daemon/src/main.ts";
import { type OpenSystem, systemOpen } from "../apps/daemon/src/open/system.ts";
import { nullLogger } from "../packages/collectors/src/index.ts";
import { putSetting, resolvePaths } from "../packages/core/src/index.ts";

const ROOT = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
const opt = (k: string, d: string) => {
  const i = args.indexOf(k);
  return i >= 0 ? (args[i + 1] ?? d) : d;
};
const terminal = opt("--terminal", "ghostty");
const kase = opt("--case", "lock");
const mode = opt("--mode", "raw");
const delaySec = Number(opt("--delay", "45"));
const port = Number(opt("--port", "27495"));
const results = resolve(opt("--results", join(ROOT, "out", "s8-results.jsonl")));
const dry = args.includes("--dry-run");
if (!["ghostty", "orca", "terminal"].includes(terminal)) throw new Error(`--terminal ${terminal}`);
if (!["lock", "screensaver", "display-sleep"].includes(kase)) throw new Error(`--case ${kase}`);
if (!["raw", "unattended"].includes(mode)) throw new Error(`--mode ${mode}`);
if (port === 7317) throw new Error("7317 は利用者の常駐デーモンの番号。使わない");

const sh = async (argv: string[]) => {
  const p = Bun.spawn(argv, { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
  const out = await new Response(p.stdout).text();
  return { code: await p.exited, out: out.trim() };
};

// 1. 一時ディレクトリ: データ・ダミーのリポジトリ・偽の claude・turnlane の包み
const tmp = mkdtempSync(join(tmpdir(), "turnlane-s8-"));
const home = join(tmp, "home");
const bin = join(tmp, "bin");
const repo = join(tmp, "s8-dummy-repo");
const claudeLog = join(tmp, "claude-argv.log");
mkdirSync(home, { recursive: true });
mkdirSync(bin, { recursive: true });
mkdirSync(repo, { recursive: true });
writeFileSync(join(repo, "README.md"), "# s8 dummy\n");
await sh(["git", "-C", repo, "init", "-q", "-b", "main"]);
await sh(["git", "-C", repo, "add", "."]);
await sh([
  "git",
  "-C",
  repo,
  "-c",
  "user.name=s8",
  "-c",
  "user.email=s8@example.invalid",
  "commit",
  "-q",
  "-m",
  "init",
]);
// 偽の claude: 引数と起動の ID を記録して数秒で終わる（何も読まない・どこにも接続しない）
const LAUNCH_VAR = "{TURNLANE_LAUNCH_ID:-none}";
writeFileSync(
  join(bin, "claude"),
  [
    "#!/bin/bash",
    `printf '%s\\n' "$(date +%s) $${LAUNCH_VAR} $*" >> '${claudeLog}'`,
    'echo "fake claude (s8): started with: $*"',
    "sleep 5",
    "exit 0",
    "",
  ].join("\n"),
);
chmodSync(join(bin, "claude"), 0o755);
const dataDir = join(home, "data");
const logDir = join(home, "logs");
// 端末のタブで動く turnlane: このデーモンを指し、偽の claude を先に見つける
const cli = join(bin, "turnlane-s8");
writeFileSync(
  cli,
  [
    "#!/bin/bash",
    `export TURNLANE_DATA_DIR='${dataDir}'`,
    `export TURNLANE_LOG_DIR='${logDir}'`,
    `export TURNLANE_PORT='${port}'`,
    `export PATH='${bin}':"\${PATH}"`,
    `exec '${process.execPath}' '${join(ROOT, "apps/cli/src/main.ts")}' "$@"`,
    "",
  ].join("\n"),
);
chmodSync(cli, 0o755);

class SpikeLaunch extends SystemLaunch {
  ignoreLock = mode === "raw";
  lastLocked: boolean | null = null;
  override async screenLocked(): Promise<boolean> {
    this.lastLocked = await super.screenLocked();
    return this.ignoreLock ? false : this.lastLocked;
  }
}
const sys = new SpikeLaunch({ home, shell: null, knownDirs: [bin] });
/** --dry-run: 端末を開かず、端末に入力するはずの `<turnlane> ai run <ID>` を裏で実行する */
const dryOpen: OpenSystem = {
  exists: (p) => systemOpen.exists(p),
  isDir: (p) => systemOpen.isDir(p),
  hostApp: () => null,
  bundleId: () => null,
  async run(argv) {
    const cmd = argv.find((a) => a.includes(" ai run "));
    console.log(`(dry-run) ${argv.slice(0, 2).join(" ")} …`);
    if (cmd)
      Bun.spawn(["/bin/bash", "-c", cmd], { stdout: "ignore", stderr: "inherit", stdin: "ignore" });
    return true;
  },
};
/** 端末を開く各 step の終了コード・stderr・Orca の JSON のエラー（not_opened のときに結果へ出す） */
interface StepLog {
  cmd: string;
  code: number | null;
  timedOut?: boolean;
  stderr?: string;
  error?: string;
}
let stepLogs: StepLog[] = [];
let orcaRepoAdded = false;
/** 結果にパス・ユーザー名を残さない（一時ディレクトリ → <tmp>、ホーム → ~） */
const mask = (t: string) => {
  let out = t;
  for (const p of [`/private${tmp}`, tmp]) out = out.split(p).join("<tmp>");
  const h = process.env.HOME;
  return h ? out.split(h).join("~") : out;
};
const oneLine = (t: string, n = 300) => mask(t).replace(/\s+/g, " ").trim().slice(0, n);
/** Orca の CLI はアプリの中の実体（argv[3] が index.js）。サブコマンドだけを残す */
const stepName = (argv: readonly string[]) => {
  const rest = argv[0] === "/usr/bin/env" ? argv.slice(4) : argv.slice(0, 2);
  const words: string[] = [];
  for (const a of rest) {
    if (a.startsWith("-")) break;
    words.push(a);
  }
  return words.join(" ");
};
const jsonError = (out: string) => {
  try {
    const j = JSON.parse(out) as { ok?: boolean; error?: { code?: string; message?: string } };
    if (j.ok === false) return oneLine(`${j.error?.code ?? ""} ${j.error?.message ?? ""}`, 200);
  } catch {}
  return undefined;
};
/** systemOpen.run と同じ起動。出力を捨てずに StepLog に残す */
const diagOpen: OpenSystem = {
  ...systemOpen,
  async run(argv, o = {}) {
    const log: StepLog = { cmd: stepName(argv), code: null };
    stepLogs.push(log);
    try {
      const p = Bun.spawn([...argv], {
        stdin: o.stdin !== undefined ? new TextEncoder().encode(o.stdin) : "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      let timedOut = false;
      const timer = o.timeoutMs
        ? setTimeout(() => {
            timedOut = true;
            p.kill();
          }, o.timeoutMs)
        : null;
      const [out, err, code] = await Promise.all([
        new Response(p.stdout).text(),
        new Response(p.stderr).text(),
        p.exited,
      ]);
      if (timer) clearTimeout(timer);
      log.code = code;
      if (timedOut) log.timedOut = true;
      if (err.trim()) log.stderr = oneLine(err);
      const e = jsonError(out.trim());
      if (e) log.error = e;
      if (code === 0 && log.cmd === "repo add") orcaRepoAdded = true;
      return code === 0;
    } catch (e) {
      log.stderr = oneLine(String(e));
      return false;
    }
  },
};
const paths = resolvePaths(
  { HOME: home, TURNLANE_DATA_DIR: dataDir, TURNLANE_LOG_DIR: logDir, TURNLANE_PORT: String(port) },
  home,
);
const daemon = await startDaemon({
  paths,
  logger: nullLogger,
  port,
  ingest: false,
  calendar: false,
  summary: false,
  launch: { cliPath: cli, sys, open: dry ? dryOpen : diagOpen },
});
const launch = daemon.launch;
if (!launch) throw new Error("launch is not available");
putSetting(daemon.mutateCtx, "open.terminal", terminal);

const api = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
  const r = await fetch(`${daemon.url}/api${path}`, {
    method,
    headers: {
      authorization: `Bearer ${daemon.token}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return (await r.json()) as T;
};
const task = await api<{ task: { id: string } }>("POST", "/tasks", {
  title: "S8 dummy (read-only)",
});

const HOW: Record<string, string> = {
  lock: "画面をロックしてください（⌃⌘Q）。ロック画面のまま待ちます",
  screensaver:
    "スクリーンセーバーを始めます（open -a ScreenSaverEngine）。マウス・キーに触れずに待ちます。" +
    "「スクリーンセーバー開始後にパスワードを要求」の設定によっては、途中からロックにもなります",
  "display-sleep":
    "ディスプレイをスリープします（pmset displaysleepnow）。マウス・キーに触れずに待ちます",
};
console.log(`\nS8: 端末=${terminal} 場合=${kase} 方式=${mode}`);
console.log(`- ${delaySec} 秒後に起動します。${HOW[kase]}`);
console.log(
  `- 起動のあと最大 3 分、受け取りを待ちます。終わったらロックを外して、この端末の結果を見てください\n`,
);
await Bun.sleep(3000);
if (!dry && kase === "screensaver") await sh(["/usr/bin/open", "-a", "ScreenSaverEngine"]);
if (!dry && kase === "display-sleep") await sh(["/usr/bin/pmset", "displaysleepnow"]);
await Bun.sleep(Math.max(0, delaySec * 1000 - 3000));

const screensaverRunning = async () =>
  (await sh(["/usr/bin/pgrep", "-x", "ScreenSaverEngine"])).code === 0;
const input = {
  taskId: task.task.id,
  repo,
  tool: "claude_code" as const,
  templateId: "builtin:research",
  worktree: false,
};
const startedAt = Date.now();
const attempts: {
  atSec: number;
  locked: boolean | null;
  outcome: string;
  reason?: string;
  steps?: StepLog[];
}[] = [];
let launchId: string | null = null;
let lockedAtLaunch: boolean | null = null;
let saverAtLaunch = await screensaverRunning();
for (;;) {
  saverAtLaunch = await screensaverRunning();
  stepLogs = [];
  const r = await launch.launchUnattended(input, "schedule");
  lockedAtLaunch = sys.lastLocked;
  const deferred = r.outcome === "locked" ? (r as LaunchDeferred) : null;
  attempts.push({
    atSec: Math.round((Date.now() - startedAt) / 1000),
    locked: sys.lastLocked,
    outcome: r.outcome,
    ...(deferred ? { reason: deferred.reason } : {}),
    // 開けなかったときだけ、各 step の終了コード・stderr・Orca の JSON のエラーを残す
    ...(deferred?.reason === "not_opened" ? { steps: stepLogs } : {}),
  });
  console.log(`起動: ${JSON.stringify(attempts.at(-1))}`);
  if (!deferred) {
    launchId = (r as { launchId: string }).launchId;
    break;
  }
  // raw は1回だけ。unattended はロックが外れるまで 30 秒ごとに（最大 15 分）
  if (mode === "raw" || Date.now() - startedAt > 15 * 60_000) break;
  await Bun.sleep(30_000);
}

// 受け取り（turnlane ai run が動いた）と、偽の claude に --session-id が渡ったか
let claimedSec: number | null = null;
let sessionIdPassed = false;
const db = new Database(paths.dbPath, { readonly: true });
if (launchId) {
  const t0 = Date.now();
  for (let i = 0; i < 180; i++) {
    const row = db
      .query<{ status: string; session_uuid: string | null }, [string]>(
        "SELECT status, session_uuid FROM ai_launch WHERE id = ?",
      )
      .get(launchId);
    if (row && row.status !== "pending" && claimedSec === null)
      claimedSec = Math.round((Date.now() - t0) / 1000);
    const log = existsSync(claudeLog) ? readFileSync(claudeLog, "utf8") : "";
    if (
      row?.session_uuid &&
      log.includes(`--session-id ${row.session_uuid}`) &&
      log.includes(launchId)
    ) {
      sessionIdPassed = true;
      break;
    }
    await Bun.sleep(1000);
  }
}

db.close();
const macos = (await sh(["/usr/bin/sw_vers", "-productVersion"])).out;
const result = {
  at: new Date().toISOString(),
  macos,
  terminal,
  case: kase,
  mode,
  dryRun: dry,
  lockedAtLaunch,
  screensaverAtLaunch: saverAtLaunch,
  attempts,
  opened: launchId !== null,
  claimedWithinSec: claimedSec,
  sessionIdPassed,
};
mkdirSync(resolve(results, ".."), { recursive: true });
appendFileSync(results, `${JSON.stringify(result)}\n`);
console.log(`\n結果: ${JSON.stringify(result, null, 2)}`);
console.log(`記録: ${results}`);
if (!dry && terminal === "orca" && orcaRepoAdded)
  console.log(
    `Orca にダミーのリポジトリ（${repo}）が登録されています。Orca の一覧から外してください`,
  );

await daemon.stop();
rmSync(tmp, { recursive: true, force: true });
process.exit(0);
