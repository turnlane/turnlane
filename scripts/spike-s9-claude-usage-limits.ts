/**
 * S9: Claude の利用枠の受け口（`--settings` の statusLine → `turnlane statusline`）が、利用者の本物の Claude Code で動くか。
 * 手順と結果は docs/spikes/s9-claude-usage-limits.md。利用者が自分の端末で流す（Claude Code が対話で立ち上がる）。
 *
 *   bun scripts/spike-s9-claude-usage-limits.ts [--account <設定ディレクトリ>] [--port 27496] [--results <jsonl>] [--dry-run]
 *
 * 確かめること:
 *  (a) `--settings` の statusLine が利用者の設定より優先され、アカウント（CLAUDE_CONFIG_DIR）ごとに `rate_limits` が届くか
 *  (b) 利用者の statusLine のコマンドに同じ入力を渡して、その出力を返せるか（表示が変わらないか）
 *  (d) CLI に、利用枠のリセット後に自分で続ける機能があるか（`claude --help` の行から探す）
 *  （c の StopFailure の error_type は公式ドキュメントで確かめ、文書に書く）
 *
 * 流れ: 一時ディレクトリに別のデーモンを 27496 番で立て、`claude --settings <受け口> --permission-mode plan "<短い指示>"`
 * を、この端末で対話のまま起動する。応答が出て下の statusLine を見たら /exit で閉じる。閉じた後に、受け口の記録（中身なし）と
 * デーモンが受け取った値から結果を1行にまとめ、見た目の確認を2つ聞く。
 * --dry-run: claude を起動せず、偽の入力（rate_limits つき）で受け口を1回だけ動かす（手順の確かめ）
 *
 * 触るもの: 一時ディレクトリ（データ・記録）、選んだアカウントでの短い読み取りのみのセッション1回（Claude Code が普段どおり
 * 自分の記録を残す。Turnlane の hooks を入れていれば、常駐の Turnlane にも短いセッションとして出る）。
 * 触らないもの: 利用者の常駐デーモン（7317）・データ・settings.json（読むだけ）・認証のファイル。会話の中身は記録しない
 */
import { Database } from "bun:sqlite";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { startDaemon } from "../apps/daemon/src/main.ts";
import { nullLogger } from "../packages/collectors/src/index.ts";
import { findUserStatusLine, resolvePaths } from "../packages/core/src/index.ts";

const ROOT = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
const opt = (k: string, d: string) => {
  const i = args.indexOf(k);
  return i >= 0 ? (args[i + 1] ?? d) : d;
};
const home = process.env.HOME ?? homedir();
const dflt = join(home, ".claude");
const account = resolve(
  opt("--account", process.env.CLAUDE_CONFIG_DIR || dflt).replace(/^~(?=\/|$)/, home),
).replace(/\/+$/, "");
const port = Number(opt("--port", "27496"));
const results = resolve(opt("--results", join(ROOT, "out", "s9-results.jsonl")));
const dry = args.includes("--dry-run");
if (port === 7317) throw new Error("7317 は利用者の常駐デーモンの番号。使わない");
if (!existsSync(account)) throw new Error(`設定ディレクトリがありません: ${account}`);

const sh = async (argv: string[], env?: Record<string, string | undefined>) => {
  try {
    const p = Bun.spawn(argv, {
      stdout: "pipe",
      stderr: "ignore",
      stdin: "ignore",
      ...(env ? { env } : {}),
    });
    const out = await new Response(p.stdout).text();
    return { code: await p.exited, out: out.trim() };
  } catch {
    return { code: -1, out: "" };
  }
};
const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

const tmp = mkdtempSync(join(tmpdir(), "turnlane-s9-"));
const dataDir = join(tmp, "data");
const trace = join(tmp, "trace.jsonl");
mkdirSync(dataDir, { recursive: true });
const paths = resolvePaths(
  { HOME: home, TURNLANE_DATA_DIR: dataDir, TURNLANE_LOG_DIR: join(tmp, "log") },
  home,
);
const daemon = await startDaemon({
  paths: { ...paths, port },
  logger: nullLogger,
  port,
  ingest: false,
});

// 受け口: 一時のデーモンに送り、記録を trace に足す（中身は書かない）
const wrapper = [
  `TURNLANE_DATA_DIR=${q(dataDir)}`,
  `TURNLANE_PORT=${port}`,
  `TURNLANE_STATUSLINE_TRACE=${q(trace)}`,
  q(process.execPath),
  q(join(ROOT, "apps/cli/src/main.ts")),
  "statusline",
].join(" ");
const user = findUserStatusLine({ configDir: account, projectDir: ROOT });
const settings = JSON.stringify({
  statusLine: {
    type: "command",
    command: wrapper,
    ...(user?.padding !== undefined ? { padding: user.padding } : {}),
    ...(user?.refreshInterval !== undefined ? { refreshInterval: user.refreshInterval } : {}),
    ...(user?.hideVimModeIndicator !== undefined
      ? { hideVimModeIndicator: user.hideVimModeIndicator }
      : {}),
  },
});

// 既定（~/.claude）は CLAUDE_CONFIG_DIR を消す（付けると ~/.claude.json ではなく ~/.claude/.claude.json を読むため）
const env: Record<string, string | undefined> = { ...process.env };
if (account === dflt) delete env.CLAUDE_CONFIG_DIR;
else env.CLAUDE_CONFIG_DIR = account;

const claude = Bun.which("claude", { PATH: env.PATH ?? "" });
const version = claude ? (await sh([claude, "--version"], env)).out.split("\n")[0] : null;
const help = claude ? (await sh([claude, "--help"], env)).out : "";
// (d) 再開・続きに関わるオプションの名前（説明の文は残さない）
const resumeOptions = [
  ...new Set(
    help
      .split("\n")
      .filter((l) => /resume|continue|retry|limit|reset/i.test(l))
      .map((l) => /(--[a-z][a-z0-9-]*)/.exec(l)?.[1])
      .filter((x): x is string => !!x),
  ),
];
const autoResume = /auto[- ]?(continue|resume)|resume.*(after|when).*(limit|reset)/i.test(help);

console.log(
  `S9: アカウント ${basename(account)}${account === dflt ? "（既定）" : ""}、Claude Code ${version ?? "（見つかりません）"}`,
);
console.log(`利用者の statusLine: ${user ? "あり（受け口の中で動かします）" : "なし"}`);
console.log(`一時のデーモン: 127.0.0.1:${port}（常駐の Turnlane には触れません）\n`);

if (dry) {
  const input = JSON.stringify({
    session_id: "dry",
    workspace: { current_dir: ROOT, project_dir: ROOT },
    rate_limits: {
      five_hour: { used_percentage: 1, resets_at: Math.floor(Date.now() / 1000) + 3600 },
      seven_day: { used_percentage: 2, resets_at: Math.floor(Date.now() / 1000) + 86400 },
    },
  });
  const p = Bun.spawn(["/bin/sh", "-c", wrapper], {
    env,
    cwd: ROOT,
    stdin: new Blob([input]),
    stdout: "pipe",
    stderr: "ignore",
  });
  const out = await new Response(p.stdout).text();
  await p.exited;
  console.log(`受け口の出力（利用者の statusLine の出力。${out.length} 文字）`);
} else {
  if (!claude) throw new Error("claude が見つかりません");
  console.log(
    [
      "これから Claude Code が開きます（読み取りのみ・ツールなしの短い指示を1つ送ります）。",
      "1. 応答が出るまで待ち、画面の下の statusLine がいつもどおりか見てください（設定していなければ空のまま）",
      "2. 10秒ほど待ってから /exit で閉じてください（初めてのフォルダなら信頼の確認が出ます）",
      "",
    ].join("\n"),
  );
  await Bun.sleep(2000);
  const p = Bun.spawn(
    [
      claude,
      "--settings",
      settings,
      "--permission-mode",
      "plan",
      "This is a connectivity check. Do not read files or use tools. Reply with just: OK",
    ],
    { cwd: ROOT, env, stdin: "inherit", stdout: "inherit", stderr: "inherit" },
  );
  await p.exited;
}

// 結果
const lines = existsSync(trace)
  ? readFileSync(trace, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
  : [];
await daemon.stop();
const db = new Database(paths.dbPath, { readonly: true });
const row = db
  .query<
    { five_hour_resets_at: number | null; seven_day_resets_at: number | null; at: number },
    [string]
  >("SELECT five_hour_resets_at, seven_day_resets_at, at FROM claude_limit WHERE account = ?")
  .get(account);
db.close();
const ms = lines.map((l) => Number(l.ms)).sort((a, b) => a - b);
const hoursTo = (t: number | null | undefined) =>
  t ? Math.round(((t - Date.now()) / 3_600_000) * 10) / 10 : null;

let looked: string | null = null;
let blank: string | null = null;
if (!dry) {
  looked = prompt(
    user
      ? "いつもの statusLine の表示が出ていましたか？（y = 同じ / n = 違った・崩れた）"
      : "statusLine を設定していない場合: 画面の下に空の行が増えた・キーのヒントが消えたなど、いつもと違いましたか？（y = 違った / n = 同じ）",
  );
  blank = prompt("ほかに気づいたこと（無ければ Enter。会話の中身は書かないでください）");
}

const result = {
  spike: "s9",
  at: new Date().toISOString(),
  dryRun: dry,
  claudeVersion: version,
  account: basename(account),
  defaultAccount: account === dflt,
  userStatusLine: user !== null,
  calls: lines.length,
  callsWithFiveHour: lines.filter((l) => l.fiveHour).length,
  callsWithSevenDay: lines.filter((l) => l.sevenDay).length,
  sentOk: lines.filter((l) => l.sent === "ok").length,
  userExitCodes: [...new Set(lines.map((l) => l.userExit))],
  wrapperMsMedian: ms.length ? ms[Math.floor(ms.length / 2)] : null,
  wrapperMsMax: ms.length ? ms.at(-1) : null,
  recorded: row
    ? {
        fiveHourResetsInH: hoursTo(row.five_hour_resets_at),
        sevenDayResetsInH: hoursTo(row.seven_day_resets_at),
      }
    : null,
  resumeOptions,
  autoResumeInHelp: autoResume,
  ownerSaw: looked,
  ownerNote: blank || null,
};
mkdirSync(dirname(results), { recursive: true });
appendFileSync(results, `${JSON.stringify(result)}\n`);
console.log(`\n${JSON.stringify(result, null, 2)}\n\n記録: ${results}`);
rmSync(tmp, { recursive: true, force: true });
process.exit(0);
