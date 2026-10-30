// hook 以外のサブコマンドの振り分け。main.ts から動的 import される。
import { VERSION } from "@turnlane/core/version";
import { type CliEnv, parseArgs, systemEnv } from "./env.ts";
import { lang, setLang, tr } from "./lang.ts";

/** 端末で y/N を聞く（turnlane calendar cleanup-timeblocks の確認） */
async function askYesNo(question: string): Promise<boolean> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

const USAGE_EN = `turnlane ${VERSION}

Usage:
  turnlane self-install [--dry-run] [--no-load] [--no-desktop] [--from <dir>]
                                    Copy to ~/.local/bin, register the LaunchAgent, and start it.
                                    If Turnlane.app is next to it, put it in ~/Applications and open it at login
  turnlane uninstall [--dry-run]          Remove the LaunchAgent, binaries, and Turnlane.app (your data stays)
  turnlane uninstall --all [--dry-run]    Also remove Turnlane's hooks and MCP entries, its background items, and
                                    its links (your data stays). Then move Turnlane.app to the Trash
  turnlane link [--dry-run] [--app <path>]
                                    Put turnlane in ~/.local/bin (a link to the turnlane inside Turnlane.app)
  turnlane setup migrate [--dry-run] [--app <path>] | migrate --rollback [--dry-run]
                                    Move a developer install (~/.local/bin, LaunchAgents) to Turnlane.app, or undo it
  turnlane daemon start|stop|restart|status [--json]|logs [-f] [-n <lines>]
                                    Control Turnlane's background service (turnlaned)
  turnlane open [board|day|queue] [--print] [--browser]
                                    Open in the desktop app (or the browser if there is none; --print only shows the URL)
  turnlane desktop install [--app <path>] [--dry-run] | uninstall [--dry-run] | status [--json]
                                    Install the desktop app (Turnlane.app) and open it at login, remove it, or show its status
  turnlane backup                         Back up now (backups/turnlane-YYYYMMDD.db)
  turnlane export --json [--out <file>]   Export all tables as JSON Lines
  turnlane ai [--date YYYY-MM-DD] [--days N] [--json]
                                    Show AI work by day (AI time, idle, expired)
  turnlane ai run <launch ID>             Typed into the terminal by Ask AI. Picks up the request and starts Claude Code / Codex
  turnlane ai report --source <s> --id <id> --state started|running|waiting|done|error
         [--title t] [--project p] [--kind question|permission --text t [--option o]... [--label l]]
         [--error-kind k] [--url u] [--at <ms or ISO time>] [--client-id id] [--json]
                                    Report work from your own scripts and agents (a waiting report shows on
                                    Your turn right away). If Turnlane isn't running, it is saved and read when it starts
  turnlane add <text...> [--date YYYY-MM-DD] [--est <min>] [--project p] [--note n]
         [--source s --external-id id [--url u]] [--json]
                                    Add a task (natural language; no date means Inbox. If Turnlane isn't running,
                                    the task is saved and added when it starts)
  turnlane today [--json]                 Today's events, tasks, and your turn
  turnlane ls [--date YYYY-MM-DD | --inbox] [--json]
                                    List tasks (IDs are the shortest unique prefix in the list, at least 8 characters)
  turnlane done <id>                      Complete a task (an ID prefix works; if it is ambiguous, candidates are shown)
  turnlane edit <id> [--title <title>] [--date YYYY-MM-DD | --inbox] [--est <min> | --no-est]
          [--project <name> | --no-project] [--json]
                                    Change a task's title, date, estimate, or project
  turnlane rm <id>                        Delete a task
  turnlane mcp                            MCP server over stdio (Claude Code / Codex start it once it's registered)
  turnlane mcp install|uninstall|status [--claude-dir <dir>]... [--codex] [--dry-run] [--bin <path>] [--json]
                                    Register Turnlane's MCP server in Claude Code / Codex (user scope) so they can
                                    add tasks to Turnlane, remove it, or show where it's registered
  turnlane queue [--json]                 List your turn
  turnlane report [YYYY-MM-DD] [--copy] [--lang en|ja]
                                    Daily note (Markdown; the saved one if the day is closed. --copy copies it)
  turnlane sources [list|rescan|health] [--json]
                                    Sources and their status
  turnlane hooks install|uninstall|status [--claude-dir <dir>]... [--codex] [--dry-run] [--bin <path>]
                                    Add or remove hooks in Claude Code / Codex (other tools' entries are left alone)
  turnlane calendar status [--json]       Calendar helper connection and access, holiday calendar, next workday
  turnlane calendar calendars [--json] [--role <id> source|ignored]
                                    List calendars and change their role
  turnlane calendar cleanup-timeblocks [--dry-run] [--yes] [--json]
                                    Show how many time block events older versions wrote, and over which dates,
                                    then delete them after you confirm (events made in Turnlane and unmarked events are left alone)
  turnlane calendar holidays [--set <id>... | --none | --auto]
                                    Holiday calendar (automatic by default)
  turnlane calendar sync                  Fetch events again (7 days back to 21 days ahead)
  turnlane calendar authorize [--app <path>]
                                    Show the calendar access dialog
  turnlane calendar install [--app <path>] [--dry-run] | uninstall [--dry-run]
                                    Put the helper in ~/Applications and register its LaunchAgent, or remove it
  turnlane config [get [<key>] | set <key> <json>]
                                    Read or change settings (for example: turnlane config set workdays.weekdays '[1,2,3,4,5]')
  turnlane doctor [--json] [--redact]     Check the database (no conversation text), sources, hooks, MCP, holiday calendar, and updates.
                                    --redact hides home paths, user names, repository names, and titles for sharing
  turnlane onboarding [status|detect|consent [--source <id>]...|add <path>|mcp [--dry-run]|summary|restart] [--json]
                                    Import consent and start, sources found, registering the MCP server for the
                                    sources you agreed to import (mcp), progress over the last 7 days
  turnlane reingest [--source <id>]       Read sources again from the start (nothing is deleted)
  turnlane rederive [--wait --since YYYY-MM-DD]
                                    Recalculate AI work, states, and waits
  turnlane hook --tool claude_code|codex  Called by hooks (saves the JSON from stdin for import)
  turnlane --version
  turnlane help [<command>] | turnlane <command> --help
                                    Help (per command)
`;

const USAGE_JA = `turnlane ${VERSION}

使い方:
  turnlane self-install [--dry-run] [--no-load] [--no-desktop] [--from <dir>]
                                    ~/.local/bin へコピーし、LaunchAgent を登録して起動。
                                    コピー元に Turnlane.app があれば ~/Applications に置き、ログイン時に起動する
  turnlane uninstall [--dry-run]          LaunchAgent・バイナリ・Turnlane.app を削除（データは残す）
  turnlane uninstall --all [--dry-run]    hooks・MCP の Turnlane の項目、常駐の登録、リンクも外す（データは残す）。
                                    最後に Turnlane.app をゴミ箱へ
  turnlane link [--dry-run] [--app <path>]
                                    ~/.local/bin に turnlane を置く（Turnlane.app の中の turnlane へのリンク）
  turnlane setup migrate [--dry-run] [--app <path>] | migrate --rollback [--dry-run]
                                    開発時の配置（~/.local/bin・LaunchAgent）を Turnlane.app に移す・戻す
  turnlane daemon start|stop|restart|status [--json]|logs [-f] [-n <行数>]
                                    Turnlane のバックグラウンド（turnlaned）を操作する
  turnlane open [board|day|queue] [--print] [--browser]
                                    デスクトップアプリ（無ければブラウザ）で開く（--print は URL を表示するだけ）
  turnlane desktop install [--app <path>] [--dry-run] | uninstall [--dry-run] | status [--json]
                                    デスクトップアプリ（Turnlane.app）を置き、ログイン時に起動する・外す・状態
  turnlane backup                         今すぐバックアップ（backups/turnlane-YYYYMMDD.db）
  turnlane export --json [--out <file>]   全テーブルを JSON Lines で書き出す
  turnlane ai [--date YYYY-MM-DD] [--days N] [--json]
                                    AI の作業を日ごとに表示（AI の時間・放置・期限切れ）
  turnlane ai run <起動 ID>               「AI に頼む」が端末に入力する。依頼を受け取り Claude Code / Codex を起動する
  turnlane ai report --source <s> --id <id> --state started|running|waiting|done|error
         [--title t] [--project p] [--kind question|permission --text t [--option o]... [--label l]]
         [--error-kind k] [--url u] [--at <ms か ISO の時刻>] [--client-id id] [--json]
                                    自分のスクリプト・エージェントの作業を書く（waiting はすぐ自分の番に出る）。
                                    Turnlane が止まっていれば一時保存し、起動したときに読む
  turnlane add <text...> [--date YYYY-MM-DD] [--est <分>] [--project p] [--note n]
         [--source s --external-id id [--url u]] [--json]
                                    タスクを追加（自然言語。日付が無ければ Inbox。止まっている間は一時保存し、
                                    起動したときに追加）
  turnlane today [--json]                 今日の予定・タスク・自分の番
  turnlane ls [--date YYYY-MM-DD | --inbox] [--json]
                                    タスクの一覧（ID は一覧の中で一意な最短の先頭部分。8文字以上）
  turnlane done <id>                      タスクを完了にする（ID の先頭部分でも可。曖昧なら候補を出す）
  turnlane edit <id> [--title <題名>] [--date YYYY-MM-DD | --inbox] [--est <分> | --no-est]
          [--project <名前> | --no-project] [--json]
                                    タスクの題名・日付・見積・プロジェクトを変える
  turnlane rm <id>                        タスクを削除する
  turnlane mcp                            stdio の MCP サーバ（登録すると Claude Code / Codex が起動する）
  turnlane mcp install|uninstall|status [--claude-dir <dir>]... [--codex] [--dry-run] [--bin <path>] [--json]
                                    Claude Code / Codex（ユーザーのスコープ）に Turnlane の MCP サーバを登録し、
                                    AI から Turnlane にタスクを入れられるようにする・外す・登録の状態
  turnlane queue [--json]                 自分の番の一覧
  turnlane report [YYYY-MM-DD] [--copy] [--lang en|ja]
                                    日報（Markdown。確定済みならその内容。--copy でクリップボードへ）
  turnlane sources [list|rescan|health] [--json]
                                    取り込み元とその状態
  turnlane hooks install|uninstall|status [--claude-dir <dir>]... [--codex] [--dry-run] [--bin <path>]
                                    Claude Code / Codex に hooks を入れる・外す（他ツールのエントリには触らない）
  turnlane calendar status [--json]       カレンダーヘルパの接続・権限、祝日カレンダー、次の稼働日
  turnlane calendar calendars [--json] [--role <id> source|ignored]
                                    カレンダーの一覧と役割の変更
  turnlane calendar cleanup-timeblocks [--dry-run] [--yes] [--json]
                                    以前の版がタスクの時間ブロックとして書いた予定の件数・期間を出し、
                                    確認してから削除する（turnlane で作った予定・目印の無い予定には触れない）
  turnlane calendar holidays [--set <id>... | --none | --auto]
                                    祝日カレンダー（既定は自動判定）
  turnlane calendar sync                  予定を取り直す（窓: 7日前〜21日後）
  turnlane calendar authorize [--app <path>]
                                    カレンダーの権限のダイアログを出す
  turnlane calendar install [--app <path>] [--dry-run] | uninstall [--dry-run]
                                    ヘルパを ~/Applications に置き、LaunchAgent を登録する・外す
  turnlane config [get [<key>] | set <key> <json>]
                                    設定を読む・変える（例: turnlane config set workdays.weekdays '[1,2,3,4,5]'）
  turnlane doctor [--json] [--redact]     DB の監査（本文の混入）、取り込み元、hooks、MCP、祝日カレンダー、更新の状態。
                                    --redact はホームのパス・ユーザー名・リポジトリ名・題名を伏せた共有用の診断
  turnlane onboarding [status|detect|consent [--source <id>]...|add <path>|mcp [--dry-run]|summary|restart] [--json]
                                    取り込みの同意と開始、見つかった取り込み元、同意した取り込み元への MCP の登録（mcp）、
                                    直近7日の進み具合
  turnlane reingest [--source <id>]       最初から読み直す（記録は消さない）
  turnlane rederive [--wait --since YYYY-MM-DD]
                                    AI の作業・状態・待ちを再計算する
  turnlane hook --tool claude_code|codex  hooks から呼ばれる（stdin の JSON を取り込み用に一時保存）
  turnlane --version
  turnlane help [<command>] | turnlane <command> --help
                                    使い方（コマンドごと）
`;

/** 使い方（今の言語。turnlane stats は計測用なので載せない。K13） */
export function usage(): string {
  return lang() === "ja" ? USAGE_JA : USAGE_EN;
}

/** USAGE からそのコマンドの行（続きの行を含む）だけを取り出す。無ければ全体 */
export function helpFor(cmd: string): string {
  const lines = usage().split("\n");
  const out: string[] = [];
  let on = false;
  for (const l of lines) {
    const m = /^ {2}turnlane (\S+)/.exec(l);
    if (m) on = m[1] === cmd;
    else if (!l.startsWith("    ")) on = false;
    if (on) out.push(l);
  }
  return out.length > 0 ? `${tr("Usage", "使い方")}:\n${out.join("\n")}` : usage();
}

/** サブコマンドが受け付けるフラグ（値なし）・オプション（値あり）・位置引数の数 */
interface ArgSpec {
  flags?: string[];
  opts?: string[];
  pos?: number;
}

export const ARG_SPECS: Record<string, ArgSpec> = {
  "self-install": { flags: ["--dry-run", "--no-load", "--no-desktop"], opts: ["--from"] },
  uninstall: { flags: ["--dry-run", "--all"] },
  link: { flags: ["--dry-run"], opts: ["--app"] },
  setup: { flags: ["--dry-run", "--rollback"], opts: ["--app"], pos: 1 },
  daemon: { flags: ["--json", "-f"], opts: ["-n", "--lines"], pos: 1 },
  open: { flags: ["--print", "--browser"], pos: 1 },
  desktop: { flags: ["--dry-run", "--json"], opts: ["--app"], pos: 1 },
  backup: {},
  export: { flags: ["--json"], opts: ["--out"] },
  ai: {
    flags: ["--json"],
    opts: [
      "--date",
      "--days",
      "--source",
      "--id",
      "--title",
      "--project",
      "--state",
      "--kind",
      "--text",
      "--option",
      "--label",
      "--error-kind",
      "--url",
      "--at",
      "--client-id",
    ],
    pos: 2,
  },
  add: {
    flags: ["--json"],
    opts: ["--date", "--est", "--project", "--note", "--source", "--external-id", "--url"],
    pos: Number.POSITIVE_INFINITY,
  },
  today: { flags: ["--json"] },
  ls: { flags: ["--inbox", "--json"], opts: ["--date"] },
  done: { pos: 1 },
  edit: {
    flags: ["--inbox", "--no-est", "--no-project", "--json"],
    opts: ["--title", "--date", "--est", "--estimate", "--project"],
    pos: 1,
  },
  rm: { pos: 1 },
  mcp: { flags: ["--codex", "--dry-run", "--json"], opts: ["--claude-dir", "--bin"], pos: 1 },
  queue: { flags: ["--json"] },
  report: { flags: ["--copy"], opts: ["--lang"], pos: 1 },
  stats: { flags: ["--json"], opts: ["--days"] },
  sources: { flags: ["--json"], pos: 1 },
  hooks: { flags: ["--codex", "--dry-run"], opts: ["--claude-dir", "--bin"], pos: 1 },
  calendar: {
    flags: ["--json", "--none", "--auto", "--dry-run", "--yes"],
    opts: ["--role", "--set", "--app"],
    pos: 2,
  },
  config: { pos: 3 },
  doctor: { flags: ["--json", "--redact"] },
  onboarding: { flags: ["--json", "--dry-run"], opts: ["--source"], pos: 2 },
  reingest: { opts: ["--source"] },
  rederive: { flags: ["--wait"], opts: ["--since"] },
};

/** 未知の引数・多すぎる位置引数を見つけたら理由を返す（null なら問題なし） */
export function checkArgs(cmd: string, args: string[]): string | null {
  const spec = ARG_SPECS[cmd];
  if (!spec) return null;
  const { pos, flags, opts } = parseArgs(args);
  const known = new Set([...(spec.flags ?? []), ...(spec.opts ?? [])]);
  for (const f of [...flags, ...opts.keys()])
    if (!known.has(f))
      return tr(`turnlane ${cmd}: unknown option: ${f}`, `turnlane ${cmd}: 不明なオプション: ${f}`);
  for (const f of flags)
    if (spec.opts?.includes(f))
      return tr(`turnlane ${cmd}: ${f} needs a value`, `turnlane ${cmd}: ${f} には値が要ります`);
  for (const [k, v] of opts)
    if (spec.flags?.includes(k))
      return tr(`turnlane ${cmd}: ${k} takes no value`, `turnlane ${cmd}: ${k} は値を取りません`);
    else if (v === "")
      return tr(`turnlane ${cmd}: ${k} needs a value`, `turnlane ${cmd}: ${k} には値が要ります`);
  const max = spec.pos ?? 0;
  if (pos.length > max)
    return tr(
      `turnlane ${cmd}: extra arguments: ${pos.slice(max).join(" ")}`,
      `turnlane ${cmd}: 余分な引数: ${pos.slice(max).join(" ")}`,
    );
  return null;
}

export async function runCommand(cmd: string, args: string[], env: CliEnv = systemEnv()) {
  // 文言の言語（テストは env.lang を渡さなければ英語）
  setLang(env.lang ?? "en");
  if (cmd === "help") {
    env.out(args[0] ? helpFor(args[0]) : usage());
    return 0;
  }
  // --help / -h はどのサブコマンドでも使い方を出すだけ（`--` より後は題名などの位置引数）
  const dash = args.indexOf("--");
  const head = dash >= 0 ? args.slice(0, dash) : args;
  if (head.includes("--help") || head.includes("-h")) {
    env.out(ARG_SPECS[cmd] ? helpFor(cmd) : usage());
    return 0;
  }
  const bad = checkArgs(cmd, args);
  if (bad) {
    env.err(`${bad}\n\n${helpFor(cmd)}`);
    return 2;
  }
  const { pos, flags, opts, multi } = parseArgs(args);
  switch (cmd) {
    case "self-install": {
      if ((await import("./commands/setup.ts")).refuseInApp(env, "self-install")) return 1;
      const { selfInstall } = await import("./commands/install.ts");
      return selfInstall(env, {
        from: opts.get("--from"),
        dryRun: flags.has("--dry-run"),
        noLoad: flags.has("--no-load"),
        noDesktop: flags.has("--no-desktop"),
      });
    }
    case "uninstall": {
      if (flags.has("--all")) {
        const { uninstallAll } = await import("./commands/setup.ts");
        return uninstallAll(env, { dryRun: flags.has("--dry-run") });
      }
      if ((await import("./commands/setup.ts")).refuseInApp(env, "uninstall")) return 1;
      const { uninstall } = await import("./commands/install.ts");
      return uninstall(env, { dryRun: flags.has("--dry-run") });
    }
    case "daemon": {
      const d = await import("./commands/daemon.ts");
      switch (pos[0]) {
        case "start":
          return d.daemonStart(env);
        case "stop":
          return d.daemonStop(env);
        case "restart":
          return d.daemonRestart(env);
        case "status":
          return d.daemonStatus(env, flags.has("--json"));
        case "logs": {
          const n = Number(opts.get("-n") ?? opts.get("--lines") ?? 50);
          return d.daemonLogs(env, { follow: flags.has("-f"), lines: n });
        }
        default:
          env.err(`${tr("Usage", "使い方")}: turnlane daemon start|stop|restart|status|logs [-f]`);
          return 2;
      }
    }
    case "open": {
      const { openCommand } = await import("./commands/open.ts");
      return openCommand(env, pos[0], {
        print: flags.has("--print"),
        browser: flags.has("--browser"),
      });
    }
    case "link": {
      const { linkCommand } = await import("./commands/setup.ts");
      return linkCommand(env, { dryRun: flags.has("--dry-run"), app: opts.get("--app") });
    }
    case "setup": {
      if (pos[0] !== "migrate") {
        env.err(helpFor("setup"));
        return 2;
      }
      const { setupMigrate } = await import("./commands/setup.ts");
      return setupMigrate(env, {
        dryRun: flags.has("--dry-run"),
        rollback: flags.has("--rollback"),
        app: opts.get("--app"),
      });
    }
    case "desktop": {
      if (
        pos[0] === "install" &&
        (await import("./commands/setup.ts")).refuseInApp(env, "desktop install")
      )
        return 1;
      const { desktopCommand } = await import("./commands/desktop.ts");
      return desktopCommand(env, pos[0], {
        app: opts.get("--app"),
        dryRun: flags.has("--dry-run"),
        json: flags.has("--json"),
      });
    }
    case "backup": {
      const { backupCommand } = await import("./commands/data.ts");
      return backupCommand(env);
    }
    case "export": {
      const { exportCommand } = await import("./commands/data.ts");
      return exportCommand(env, { json: flags.has("--json"), out: opts.get("--out") });
    }
    case "ai": {
      if (pos[0] === "run") {
        const { aiRunCommand } = await import("./commands/ai-run.ts");
        return aiRunCommand(env, pos[1]);
      }
      if (pos[0] === "report") {
        const { aiReportCommand } = await import("./commands/ai-report.ts");
        return aiReportCommand(env, {
          source: opts.get("--source"),
          id: opts.get("--id"),
          title: opts.get("--title"),
          project: opts.get("--project"),
          state: opts.get("--state"),
          kind: opts.get("--kind"),
          text: opts.get("--text"),
          options: multi.get("--option") ?? [],
          label: opts.get("--label"),
          errorKind: opts.get("--error-kind"),
          url: opts.get("--url"),
          at: opts.get("--at"),
          clientId: opts.get("--client-id"),
          json: flags.has("--json"),
        });
      }
      const { aiCommand } = await import("./commands/ai.ts");
      return aiCommand(env, {
        date: opts.get("--date"),
        days: opts.get("--days"),
        json: flags.has("--json"),
      });
    }
    case "add": {
      const { addCommand } = await import("./commands/tasks.ts");
      return addCommand(env, {
        text: pos.join(" "),
        date: opts.get("--date"),
        est: opts.get("--est"),
        project: opts.get("--project"),
        note: opts.get("--note"),
        source: opts.get("--source"),
        externalId: opts.get("--external-id"),
        url: opts.get("--url"),
        json: flags.has("--json"),
      });
    }
    case "today": {
      const { todayCommand } = await import("./commands/tasks.ts");
      return todayCommand(env, { json: flags.has("--json") });
    }
    case "ls": {
      const { lsCommand } = await import("./commands/tasks.ts");
      return lsCommand(env, {
        date: opts.get("--date"),
        inbox: flags.has("--inbox"),
        json: flags.has("--json"),
      });
    }
    case "done": {
      const { doneCommand } = await import("./commands/tasks.ts");
      return doneCommand(env, pos[0]);
    }
    case "edit": {
      const { editCommand } = await import("./commands/tasks.ts");
      return editCommand(env, pos[0], {
        title: opts.get("--title"),
        date: opts.get("--date"),
        inbox: flags.has("--inbox"),
        est: opts.get("--est") ?? opts.get("--estimate"),
        noEst: flags.has("--no-est"),
        project: opts.get("--project"),
        noProject: flags.has("--no-project"),
        json: flags.has("--json"),
      });
    }
    case "rm": {
      const { rmCommand } = await import("./commands/tasks.ts");
      return rmCommand(env, pos[0]);
    }
    case "mcp": {
      // 引数なしは MCP サーバ（Claude Code / Codex が起動する）。install|uninstall|status は登録（D-145）
      if (pos[0] !== undefined || flags.size > 0 || opts.size > 0) {
        const { mcpConfigCommand } = await import("./commands/mcp-config.ts");
        return mcpConfigCommand(env, pos[0] ?? "", {
          claudeDirs: multi.get("--claude-dir") ?? [],
          codex: flags.has("--codex"),
          dryRun: flags.has("--dry-run"),
          json: flags.has("--json"),
          cliPath: opts.get("--bin"),
        });
      }
      const { mcpCommand } = await import("./commands/mcp.ts");
      return mcpCommand(env);
    }
    case "queue": {
      const { queueCommand } = await import("./commands/ai.ts");
      return queueCommand(env, { json: flags.has("--json") });
    }
    case "report": {
      const { reportCommand } = await import("./commands/report.ts");
      return reportCommand(env, {
        date: pos[0],
        copy: flags.has("--copy"),
        lang: opts.get("--lang"),
      });
    }
    case "stats": {
      const { statsCommand } = await import("./commands/report.ts");
      return statsCommand(env, { days: opts.get("--days"), json: flags.has("--json") });
    }
    case "sources": {
      const { sourcesCommand } = await import("./commands/ai.ts");
      return sourcesCommand(env, pos[0], { json: flags.has("--json") });
    }
    case "hooks": {
      const { hooksCommand } = await import("./commands/hooks.ts");
      return hooksCommand(env, pos[0], {
        claudeDirs: multi.get("--claude-dir") ?? [],
        codex: flags.has("--codex"),
        dryRun: flags.has("--dry-run"),
        cliPath: opts.get("--bin"),
      });
    }
    case "calendar": {
      if (
        (pos[0] === "install" || pos[0] === "uninstall") &&
        (await import("./commands/setup.ts")).refuseInApp(env, `calendar ${pos[0]}`)
      )
        return 1;
      const { calendarCommand } = await import("./commands/calendar.ts");
      return calendarCommand(env, pos[0], {
        json: flags.has("--json"),
        role: opts.get("--role"),
        roleValue: pos[1],
        set: multi.get("--set"),
        none: flags.has("--none"),
        auto: flags.has("--auto"),
        app: opts.get("--app"),
        dryRun: flags.has("--dry-run"),
        yes: flags.has("--yes"),
        confirm: process.stdin.isTTY ? askYesNo : undefined,
      });
    }
    case "config": {
      const { configCommand } = await import("./commands/calendar.ts");
      return configCommand(env, pos[0], pos[1], pos[2]);
    }
    case "doctor": {
      const { doctorCommand } = await import("./commands/doctor.ts");
      return doctorCommand(env, { json: flags.has("--json"), redact: flags.has("--redact") });
    }
    case "onboarding": {
      const { onboardingCommand } = await import("./commands/onboarding.ts");
      return onboardingCommand(env, pos[0], {
        json: flags.has("--json"),
        sources: multi.get("--source") ?? [],
        path: pos[1],
        dryRun: flags.has("--dry-run"),
      });
    }
    case "reingest": {
      const { reingestCommand } = await import("./commands/ai.ts");
      return reingestCommand(env, { source: opts.get("--source") });
    }
    case "rederive": {
      const { rederiveCommand } = await import("./commands/ai.ts");
      return rederiveCommand(env, { wait: flags.has("--wait"), since: opts.get("--since") });
    }
    default:
      env.err(
        `${tr(`turnlane: unknown command: ${cmd}`, `turnlane: 不明なコマンド: ${cmd}`)}\n\n${usage()}`,
      );
      return 2;
  }
}
