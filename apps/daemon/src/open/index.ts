/**
 * タスクから開く（D-059。ux-mvp 4.11、m2-api 13章）。
 * - options: タスクの種類ごとの既定（⏎）と `o` のメニュー。開けるものだけを、実際に開くアプリの名前つきで返す
 * - open: 開き方を「試す順の候補」（Attempt）に組み立て、成功するまで順に起動する
 * AI のセッションに戻る順: 動いているセッションのアプリを前面に → Codex app のスレッド → ターミナルに resume コマンドを
 * 入力済み（Ghostty）→ ターミナルを開いてコピー → コピーだけ。Claude Code の claude-cli:// は再開できないので使わない（S7）。
 * 動いているセッションは、プロセスの tty → tmux のペイン → cwd → アプリの順でそのタブを探す（D-214 (4)。focus.ts）。
 * Codex のセッション（アプリ・CLI）は、Codex のアプリが入っていれば「Codex で開く」（codex://threads/<id>。D-135）。
 */
import type { Database } from "bun:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSetting, type Locale, type MutateCtx, openLandingText, openMenu } from "@turnlane/core";
import type {
  OpenAction,
  OpenAppKind,
  OpenAppsResponse,
  OpenFallbackReason,
  OpenLanding,
  OpenOption,
  OpenOptions,
  OpenOutcome,
  OpenResult,
} from "@turnlane/core/api";
import { OpError, type UserOps } from "../derive/ops.ts";
import {
  AppFinder,
  CodexAppFinder,
  appName as catalogName,
  type FoundApp,
  selectedApp,
} from "./apps.ts";
import { ghosttyMarker, planLiveFocus, withTab } from "./focus.ts";
import { type LiveLocation, locateLive } from "./locate.ts";
import { type OrcaPick, orcaList, parseOrcaTerminals, pickOrcaTerminal, planOrca } from "./orca.ts";
import type { OpenSystem } from "./system.ts";
import { loadTarget, type OpenTargetInfo, resumeCommand } from "./target.ts";

export interface Step {
  argv: string[];
  timeoutMs?: number;
}

/** 起動の前後の下ごしらえ（Ghostty の目印。focus.ts）。失敗しても止めない */
export type Prep = { mkdir: string } | { rmdir: string } | { tty: string; write: string };

/** 1つの開き方。steps を順に起動し、どれかが失敗したら次の Attempt へ */
export interface Attempt {
  steps: Step[];
  outcome: OpenOutcome;
  app: string | null;
  /** クリップボードへ書く文字列（opened_copied / copied） */
  copy?: string;
  /** 動いているセッションを前に出したときの着地（focus.ts） */
  landing?: OpenLanding;
  /** 最後の起動の標準出力（AppleScript の返したタブの番号）を landing に足す */
  tabFromOutput?: boolean;
  /** steps の前・後（成功しても失敗しても）に行う */
  prepare?: Prep[];
  finally?: Prep[];
}

/**
 * 下ごしらえを 1 つ行う（Ghostty の目印。「開く」と答えるの届け先。D-244）。失敗しても止めない（目印が書けなければ、
 * 開くは cwd の一致・アプリを前に出す段に落ち、答えるは目印の端末が見つからずに送らない）
 */
export function runPrep(sys: OpenSystem, p: Prep): void {
  try {
    if ("mkdir" in p) sys.makeDir?.(p.mkdir);
    else if ("rmdir" in p) sys.removeDir?.(p.rmdir);
    else sys.writeTty?.(p.tty, p.write);
  } catch {
    // 続ける
  }
}

const OPEN = "/usr/bin/open";
const OSA = "/usr/bin/osascript";
/** オートメーションの許可の確認ダイアログで Apple Event が待たされるので、短く打ち切ってコピーへ落とす */
export const OSA_TIMEOUT_MS = 5_000;

/** Ghostty の新しいウインドウを cwd で開き、コマンドを入力済みにする（改行を付けないので実行しない） */
export const GHOSTTY_TYPE = `on run argv
  tell application "Ghostty"
    set cfg to new surface configuration
    set initial working directory of cfg to item 1 of argv
    set initial input of cfg to item 2 of argv
    new window with configuration cfg
    activate
  end tell
end run`;

const openApp = (app: FoundApp, dir: string): Step => {
  // GitHub Desktop は同梱の CLI（github）と同じく --cli-open で渡す（単一インスタンスが既存のウインドウへ渡す）
  if (app.id === "github_desktop")
    return { argv: [OPEN, "-n", app.path, "--args", `--cli-open=${dir}`] };
  // Orca はフォルダを渡して開くと何が起きるか決まっていないので、前面に出すだけ（端末は CLI で作る。orca.ts）
  if (app.id === "orca") return { argv: [OPEN, "-a", app.path] };
  return { argv: [OPEN, "-a", app.path, dir] };
};

const finder = (dir: string): Attempt => ({
  steps: [{ argv: [OPEN, "-a", "Finder", dir] }],
  outcome: "opened",
  app: "Finder",
});

export interface Apps {
  editor: FoundApp | null;
  terminal: FoundApp | null;
  diff: FoundApp | null;
  /** Codex のアプリ（D-135。入っていなければ null） */
  codex?: FoundApp | null;
}

/** 開き方 → 試す順の候補。使えない開き方なら null */
export function planOpen(
  action: OpenAction,
  t: OpenTargetInfo,
  apps: Apps,
  ctx: {
    home: string;
    hostApp: (pid: number) => string | null;
    /** 動いているセッションの居場所（open で先に調べる。無ければ hostApp だけで探す） */
    live?: LiveLocation | null;
    /** Ghostty の目印のフォルダ */
    marker?: string;
    /** Orca の中のセッションの端末（D-238） */
    orca?: { app: FoundApp; pick: OrcaPick } | null;
  },
): Attempt[] | null {
  const editor = (dir: string): Attempt[] => [
    ...(apps.editor
      ? [{ steps: [openApp(apps.editor, dir)], outcome: "opened" as const, app: apps.editor.name }]
      : []),
    finder(dir),
  ];
  switch (action) {
    case "report_url": {
      if (!t.reportUrl) return null;
      return [{ steps: [{ argv: [OPEN, t.reportUrl] }], outcome: "opened", app: null }];
    }
    case "pr":
    case "pr_files": {
      if (!t.prUrl) return null;
      const url = action === "pr" ? t.prUrl : `${t.prUrl}/files`;
      return [{ steps: [{ argv: [OPEN, url] }], outcome: "opened", app: null }];
    }
    case "editor":
      return t.folder ? editor(t.folder) : null;
    case "finder":
      return t.folder ? [finder(t.folder)] : null;
    case "terminal": {
      if (!t.folder) return null;
      const term = apps.terminal;
      if (term?.id === "orca")
        return [
          ...planOrca(term, { worktree: t.folder }, "opened"),
          { steps: [openApp(term, t.folder)], outcome: "opened", app: term.name },
          finder(t.folder),
        ];
      return term
        ? [{ steps: [openApp(term, t.folder)], outcome: "opened", app: term.name }]
        : [finder(t.folder)];
    }
    case "diff": {
      // 頼んだ AI の worktree があればそこ（元のリポジトリはそのブランチを取り出していない）
      const dir = t.worktree ?? t.folder;
      if (!dir) return null;
      const d = apps.diff;
      return [
        ...(d ? [{ steps: [openApp(d, dir)], outcome: "opened" as const, app: d.name }] : []),
        ...editor(dir),
      ];
    }
    case "codex_app": {
      // Codex のアプリでスレッドを開く（D-135）。codex://threads/<id> は公式の文書が無いので、開けなければ
      // 再開コマンドのコピーに落とす
      const s = t.session;
      if (s?.tool !== "codex" || !apps.codex) return null;
      return [
        {
          steps: [{ argv: [OPEN, `codex://threads/${s.externalId}`] }],
          outcome: "opened",
          app: apps.codex.name,
        },
        { steps: [], outcome: "copied", app: null, copy: resumeCommand(s, ctx.home, true) },
      ];
    }
    case "copy_resume": {
      if (!t.session) return null;
      return [
        { steps: [], outcome: "copied", app: null, copy: resumeCommand(t.session, ctx.home, true) },
      ];
    }
    case "session": {
      const s = t.session;
      if (!s) return null;
      const out: Attempt[] = [];
      const term = apps.terminal;
      // 1. 動いているセッション: そのタブ（ペイン）を前に出す（新しく再開しない）。tty → tmux → cwd → アプリ
      if (s.livePid !== null) {
        const live = ctx.live ?? { tty: null, host: ctx.hostApp(s.livePid), tmux: null };
        out.push(
          ...planLiveFocus(live, {
            cwd: s.cwd,
            marker: ctx.marker ?? join(tmpdir(), "turnlane-focus"),
            fallback: term ? { path: term.path, name: term.name } : null,
            ...(ctx.orca !== undefined ? { orca: ctx.orca } : {}),
          }),
        );
        return out.length > 0 ? out : null;
      }
      // 2. Codex app で始めたスレッド
      if (s.tool === "codex" && s.entrypoint === "Codex Desktop")
        out.push({
          steps: [{ argv: [OPEN, `codex://threads/${s.externalId}`] }],
          outcome: "opened",
          app: "Codex",
        });
      // 3. ターミナルを cwd で開き、resume コマンドを入力済みに（Ghostty）／開いてコピー
      const dir = s.cwd ?? t.folder;
      const typed = resumeCommand(s, ctx.home, dir === null);
      if (term && dir) {
        // Orca: リポジトリのフォルダ（Orca の worktree のルート）で端末を作り、cd 付きの resume コマンドを実行する
        // （Orca の CLI は入力済みにして止める手段が無いので、Ghostty と違い実行まで進む。D-122）
        if (term.id === "orca")
          out.push(
            ...planOrca(
              term,
              { worktree: t.folder ?? dir, command: resumeCommand(s, ctx.home, true) },
              "opened",
            ),
          );
        if (term.id === "ghostty")
          out.push({
            steps: [{ argv: [OSA, "-e", GHOSTTY_TYPE, dir, typed], timeoutMs: OSA_TIMEOUT_MS }],
            outcome: "typed",
            app: term.name,
          });
        out.push({
          steps: [openApp(term, dir)],
          outcome: "opened_copied",
          app: term.name,
          copy: typed,
        });
      }
      // 4. コピーだけ
      out.push({ steps: [], outcome: "copied", app: null, copy: resumeCommand(s, ctx.home, true) });
      return out;
    }
  }
}

/** カードだけで開いたときの既定（open なフォローアップの既定 → PR → セッション → Finder） */
function defaultFor(t: OpenTargetInfo): OpenAction[] {
  // 報告の項目（ADR 0021）は報告の開く先だけ（端末のセッション・リポジトリは無い）
  if (t.reportUrl) return ["report_url"];
  const kind = t.followUp?.kind ?? t.openKind;
  if (t.followUp) return [...openMenu(t.followUp.kind)];
  const all = [...openMenu(null)];
  const first = kind
    ? (openMenu(kind)[0] as OpenAction)
    : t.prUrl
      ? "pr"
      : t.session
        ? "session"
        : "finder";
  return [first, ...all.filter((a) => a !== first)];
}

/**
 * 同じ所を開く項目を1つにする（D-135 のレビュー）。エディタ・差分ツールが入っていなければ Finder・エディタに落ちるので、
 * リポジトリの無いカード（壁打ち・git 管理外）では「Finder で開く」が並んでいた。開く先のアプリが同じ項目は
 * Finder で表示 > エディタ > 差分ツール > ターミナル の順で1つだけ残す（並びはそのまま）
 */
const DEDUPE_RANK: Partial<Record<OpenAction, number>> = {
  finder: 0,
  editor: 1,
  diff: 2,
  terminal: 3,
};

export function dedupeOptions(options: readonly OpenOption[]): OpenOption[] {
  const keyOf = (o: OpenOption) =>
    o.action === "finder" ? "Finder" : DEDUPE_RANK[o.action] !== undefined ? o.app : null;
  const best = new Map<string, OpenAction>();
  for (const o of options) {
    const k = keyOf(o);
    if (k === null) continue;
    const cur = best.get(k);
    if (cur === undefined || (DEDUPE_RANK[o.action] ?? 9) < (DEDUPE_RANK[cur] ?? 9))
      best.set(k, o.action);
  }
  return options.filter((o) => {
    const k = keyOf(o);
    return k === null || best.get(k) === o.action;
  });
}

export interface OpenerOptions {
  sqlite: Database;
  mutate: MutateCtx;
  sys: OpenSystem;
  home: string;
  now: () => number;
  ops: UserOps;
  /** 着地の文（message）の言語。無ければ英語 */
  locale?: () => Locale;
}

export class Opener {
  readonly #finder: AppFinder;
  readonly #codex: CodexAppFinder;

  constructor(private readonly o: OpenerOptions) {
    this.#finder = new AppFinder(o.sys, o.home);
    this.#codex = new CodexAppFinder(o.sys, o.home);
  }

  #apps(): Apps {
    const sel = (k: OpenAppKind) => selectedApp(k, this.#setting(`open.${k}`));
    return {
      editor: this.#finder.resolve("editor", sel("editor")),
      terminal: this.#finder.resolve("terminal", sel("terminal")),
      diff: this.#finder.resolve("diff", sel("diff")),
      codex: this.#codex.find(),
    };
  }

  #setting(k: string): unknown {
    try {
      return getSetting(this.o.mutate.db, k);
    } catch {
      return undefined;
    }
  }

  #ctx() {
    return { home: this.o.home, hostApp: (pid: number) => this.o.sys.hostApp(pid) };
  }

  /** 入っている Orca（D-122。設定の端末が Orca でなくても、Orca の中のセッションのタブを選ぶのに使う） */
  orcaApp(): FoundApp | null {
    return this.#finder.installed("terminal").find((a) => a.id === "orca") ?? null;
  }

  /**
   * 居場所の端末のアプリが Orca なら、`orca terminal list` からセッションの端末を選ぶ（D-238）。Orca でなければ undefined。
   * list の画面の中身・題名は parseOrcaTerminals で捨てる
   */
  async orcaFor(
    live: LiveLocation,
    s: { termHandle?: string | null; cwd: string | null },
  ): Promise<{ app: FoundApp; pick: OrcaPick; writable: boolean } | null | undefined> {
    if (!live.host || !/\/Orca\.app$/.test(live.host)) return undefined;
    const app = this.orcaApp() ?? { id: "orca", name: "Orca", path: live.host };
    const rows = parseOrcaTerminals((await this.o.sys.capture?.(orcaList(app))) ?? null);
    const pick = pickOrcaTerminal(rows, { handle: s.termHandle ?? null, cwd: s.cwd });
    const writable =
      pick.handle !== null && rows.some((r) => r.handle === pick.handle && r.writable);
    return { app, pick, writable };
  }

  options(ref: { followUpId?: string; workItemId?: string }): OpenOptions {
    const t = loadTarget(this.o.sqlite, this.o.sys, ref, this.o.now());
    const apps = this.#apps();
    // メニューを出すだけなので、動いているセッションの親プロセスはたどらない
    const ctx = { home: this.o.home, hostApp: () => null };
    const options: OpenOption[] = [];
    for (const action of defaultFor(t)) {
      let plan: Attempt[] | null;
      try {
        plan = planOpen(action, t, apps, ctx);
      } catch {
        plan = null;
      }
      if (!plan || plan.length === 0) continue;
      // Codex のアプリで始めた会話は「Codex で再開」が同じ所を開くので、「Codex で開く」を重ねて出さない
      if (
        action === "codex_app" &&
        options.some((x) => x.action === "session" && x.app === "Codex")
      )
        continue;
      const app =
        action === "session"
          ? t.session?.livePid != null
            ? null
            : (plan[0]?.app ?? null)
          : action === "copy_resume"
            ? null
            : (plan[0]?.app ?? null);
      options.push({ action, app });
    }
    const shown = dedupeOptions(options);
    return { default: shown[0]?.action ?? null, options: shown };
  }

  async open(ref: {
    followUpId?: string;
    workItemId?: string;
    action?: OpenAction;
  }): Promise<OpenResult> {
    const t = loadTarget(this.o.sqlite, this.o.sys, ref, this.o.now());
    const action = ref.action ?? defaultFor(t)[0];
    if (!action) throw new OpError(409, "unavailable");
    const apps = this.#apps();
    // 動いているセッション: プロセスから tty・tmux のペイン・端末のアプリを調べてから組み立てる
    const pid = action === "session" ? (t.session?.livePid ?? null) : null;
    const live = pid !== null ? await locateLive(pid, this.o.sys) : null;
    const orca = live && t.session ? await this.orcaFor(live, t.session) : undefined;
    const marker = ghosttyMarker();
    const plan = planOpen(action, t, apps, {
      ...this.#ctx(),
      live,
      marker,
      ...(orca !== undefined ? { orca } : {}),
    });
    if (!plan || plan.length === 0) throw new OpError(409, "unavailable");
    // 最初の開き方が失敗して落ちた理由（B-5）。端末への入力（osascript）の失敗だけを見る
    let fallback: OpenResult["fallback"] = null;
    for (const a of plan) {
      const r = await this.#run(a);
      if (!r.ok) {
        if (r.reason && !fallback) fallback = { reason: r.reason, app: a.app };
        continue;
      }
      let engagedAt: number | null = null;
      if (t.followUp && (t.followUp.status === "open" || t.followUp.status === "snoozed")) {
        engagedAt = this.o.ops.engage(t.followUp.id).engaged_at;
      }
      // 設定の端末が入っていないので別の端末で開いた（no_terminal）
      if (!fallback && (action === "session" || action === "terminal") && a.steps.length > 0) {
        const selected = selectedApp("terminal", this.#setting("open.terminal"));
        if (selected && apps.terminal && apps.terminal.id !== selected)
          fallback = { reason: "no_terminal", app: catalogName("terminal", selected) };
      }
      const landing = a.landing
        ? a.tabFromOutput
          ? withTab(a.landing, r.stdout ?? "")
          : a.landing
        : null;
      return {
        action,
        outcome: a.outcome,
        app: a.app,
        command: a.copy ?? null,
        engagedAt,
        fallback,
        landing,
        message:
          landing && a.app ? openLandingText(a.app, landing, this.o.locale?.() ?? "en") : null,
      };
    }
    throw new OpError(409, "open_failed");
  }

  async #run(a: Attempt): Promise<{ ok: boolean; reason?: OpenFallbackReason; stdout?: string }> {
    for (const p of a.prepare ?? []) this.#prep(p);
    try {
      let stdout = "";
      for (const s of a.steps) {
        const o = s.timeoutMs ? { timeoutMs: s.timeoutMs } : {};
        const d = this.o.sys.runDetail
          ? await this.o.sys.runDetail(s.argv, o)
          : { ok: await this.o.sys.run(s.argv, o), stderr: "", timedOut: false };
        if (!d.ok) {
          if (s.argv[0] !== OSA) return { ok: false };
          if (d.timedOut) return { ok: false, reason: "automation_timeout" };
          if (/-1743|not authorized|Not authorized/i.test(d.stderr))
            return { ok: false, reason: "automation_denied" };
          return { ok: false };
        }
        stdout = d.stdout ?? "";
      }
      // コピーは開いた後（失敗しても UI がコピーし直す）
      if (a.copy !== undefined) await this.o.sys.run(["/usr/bin/pbcopy"], { stdin: a.copy });
      return { ok: true, stdout };
    } finally {
      for (const p of a.finally ?? []) this.#prep(p);
    }
  }

  #prep(p: Prep): void {
    runPrep(this.o.sys, p);
  }

  apps(): OpenAppsResponse {
    const one = (k: OpenAppKind) => {
      const selected = selectedApp(k, this.#setting(`open.${k}`));
      const effective = this.#finder.resolve(k, selected);
      return {
        selected,
        effective: effective?.id ?? null,
        installed: this.#finder.installed(k).map((a) => ({ id: a.id, name: a.name })),
      };
    };
    return { editor: one("editor"), terminal: one("terminal"), diff: one("diff") };
  }
}
