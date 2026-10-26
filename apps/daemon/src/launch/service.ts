/**
 * タスクから AI に頼む（D-107・D-109 の無料の部分。plan §B、m2-api 27章）。
 *
 * 1. 依頼（launch）: タスク・リポジトリ・ツール・依頼の型・worktree を受け取り、worktree を作り（git のリポジトリで選んだとき）、
 *    ai_launch を作って、いつもの端末の新しいタブで `turnlane ai run <起動 ID>` を実行させる
 * 2. 受け取り（claim）: turnlane ai run が起動 ID で1回だけ、cwd と起動の引数を受け取る。プロンプトはメモリにだけ持ち、2分で捨てる
 * 3. 紐づけ（tick）: Claude Code は先に渡した --session-id、Codex は worktree（cwd）と時刻でセッションを見つける。
 *    5分たっても見つからなければ unlinked（直近のセッションから選んでもらう）
 * 4. 確認支援（check）: 差分の量（git）・テスト（ボタンで実行。結果は成否と時刻だけを DB に）・CI（gh）
 * 5. 片付け（cleanup）: タスクを完了にしたとき、取り込まれて clean な worktree だけを消す。それ以外は消さずに残し、
 *    詳細パネルから確認して強制で消す。取り込まれていない変更を黙って消さない
 * 6. 完了のときの片付け（finish）: 画面の完了のシートで選んだもの。AI を終了してタブを閉じる（finish.ts）→ worktree を消す
 *    （cleanup。強制はシートで明示したときだけ）。どちらが失敗しても呼び出し側はタスクを完了にする
 *
 * git の書き込みは worktree の add / remove と branch -d（強制は確認の後だけ）で、対象は ai_launch に記録したものに限る。
 */
import type { Database } from "bun:sqlite";
import { randomBytes, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import { errorFields, type MetaOnlyLogger, meta } from "@turnlane/collectors";
import {
  builtinTemplates,
  type Clock,
  claudeAccountDirName,
  claudeAccountEnv,
  claudeConfigFile,
  composePrompt,
  countPorcelain,
  DEFAULT_TEMPLATE_ID,
  type derive,
  diffExcerpt,
  type FolderTrust,
  findUserStatusLine,
  folderTrust,
  getSetting,
  launchArgv,
  type MutateCtx,
  newId,
  parseNumstat,
  parseNumstatFiles,
  parseRepoPaths,
  putSetting,
  repoName,
  statusLineSettingsJson,
  summarizeChecks,
  taskDisplayTitle,
  trustKeys,
  unlinkedReason,
  worktreeBranch,
  worktreePathFor,
} from "@turnlane/core";
import type {
  AiLaunchClaim,
  AiLaunchInput,
  AiLaunchOptions,
  AiLaunchResult,
  AiLaunchTool,
  AiTemplateView,
  CiState,
  ClaudeAccountOption,
  ClaudeAccountView,
  LaunchCandidate,
  LaunchFinishInput,
  LaunchFinishItem,
  LaunchFinishPlan,
  LaunchFinishResult,
  LaunchRepoOption,
  LiveLaunch,
  WorkCheckView,
  WorkDiffView,
  WorktreeCleanupResult,
} from "@turnlane/core/api";
import { OpError } from "../derive/ops.ts";
import type { LaunchDeferred } from "../ext/types.ts";

/** 起動のきっかけ（ai_launch.trigger の値） */
export type AiLaunchTrigger = "manual" | "schedule" | "queue" | "issue";

import type { FoundApp } from "../open/apps.ts";
import { ghosttyScriptable } from "../open/ghostty.ts";
import type { Attempt } from "../open/index.ts";
import type { OpenSystem } from "../open/system.ts";
import { FINISH_WAIT_MS, TerminalCloser } from "./finish.ts";
import type { LaunchSystem } from "./system.ts";
import { planLaunch, planShell, trustCommand, unattendedWaitsWhileLocked } from "./terminal.ts";
import { launchWorkItem } from "./views.ts";

/** turnlane ai run が受け取れる時間（plan §B.1） */
export const CLAIM_TTL_MS = 2 * 60_000;
/** 受け取ってからセッションを探す時間 */
export const LINK_WINDOW_MS = 5 * 60_000;
/** Codex のセッションの始まりとして受け取りの前後に許す幅 */
const CODEX_BEFORE_MS = 10_000;
const CODEX_AFTER_MS = 3 * 60_000;
/** テストの上限（plan §B.5） */
export const TEST_TIMEOUT_MS = 10 * 60_000;
const CHECK_TTL_MS = 15_000;
const CI_TTL_MS = 60_000;
/** review.diff の上限（ファイル数・抜粋のバイト数） */
const DIFF_DEFAULT_FILES = 30;
const DIFF_MAX_FILES = 200;
const DIFF_DEFAULT_BYTES = 12_000;
const DIFF_MAX_BYTES = 64_000;

const LAUNCH_ID = /^[0-9a-f]{32}$/;
/** tmux の置き場所（送れない端末を tmux で包む。D-238。open/locate.ts の探す場所と同じ） */
const TMUX_PATHS = ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"];
// biome-ignore lint/suspicious/noControlCharactersInRegex: 制御文字を拒むための正規表現
const CONTROL = /[\u0000-\u001f\u007f]/;

export interface LaunchRow {
  id: string;
  task_id: string;
  tool: AiLaunchTool;
  repo_root: string;
  cwd: string;
  worktree_path: string | null;
  branch: string | null;
  base_ref: string | null;
  template_id: string | null;
  read_only: number;
  session_uuid: string | null;
  session_id: string | null;
  status: "pending" | "started" | "linked" | "unlinked" | "failed";
  fail_reason: string | null;
  test_ok: number | null;
  test_at: number | null;
  created_at: number;
  fetched_at: number | null;
  linked_at: number | null;
  cleaned_at: number | null;
  trigger: AiLaunchTrigger;
  claude_account: string | null;
  exit_code: number | null;
  exit_after_ms: number | null;
  exited_at: number | null;
  unlinked_reason: string | null;
}

/** フォルダの信頼の確かめ（ExtDeps.launcher.folderTrust） */
export interface FolderTrustInput {
  repo: string;
  tool?: AiLaunchTool;
  /** 設定ディレクトリ。省略すると起動と同じ既定（プロジェクト → 前回 → 最初のアカウント） */
  claudeAccount?: string | null;
  /** 既定のアカウントをタスクのプロジェクトから決めるとき */
  taskId?: string | null;
}

export interface OpenForTrustResult {
  outcome: "opened" | "opened_copied" | "copied";
  app: string | null;
  /** コピーしたコマンド（opened のときは null） */
  command: string | null;
}

export interface LaunchServiceOptions {
  sqlite: Database;
  mutate: MutateCtx;
  clock: Clock;
  sys: LaunchSystem;
  /** 端末を開く（osascript・open・pbcopy） */
  open: OpenSystem;
  /** 端末に入力する turnlane の絶対パス */
  cliPath: string;
  /** 利用者のホーム（`~/.claude` を既定のアカウントとして見分ける。D-122） */
  home: string;
  /** 開く端末（設定 open.terminal。無ければ null = コピーだけ） */
  terminal: () => FoundApp | null;
  locale: () => "ja" | "en";
  logger: MetaOnlyLogger;
  /** 書いた後に判定を起こす（紐づいた・タスクの状態が変わる） */
  onChanged: () => void;
  publish: (type: "task" | "work_item", data: Record<string, unknown>) => void;
  /** 紐づけの間隔（ms。既定 10 秒） */
  intervalMs?: number;
  /** 完了のときの片付けで AI の終わりを待つ長さ（ms。既定 FINISH_WAIT_MS）と、待つ間の眠り（テストで差し替える） */
  finishWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** カードのセッションの待ち（runner の判定。D-240）。ダイアログで待っている AI に終了の指示を送らないために見る */
  sessionWait?: (workItemId: string) => derive.SessionWait | null;
  /** 入っている Orca（タブを閉じる CLI の実体） */
  orcaApp?: () => FoundApp | null;
}

interface Pending {
  claim: AiLaunchClaim;
  expiresAt: number;
}

interface TestMem {
  state: "running" | "passed" | "failed";
  at: number;
  exitCode: number | null;
  tail: string[];
}

export class LaunchService {
  readonly #o: LaunchServiceOptions;
  readonly #pending = new Map<string, Pending>();
  readonly #tests = new Map<string, TestMem>();
  readonly #checks = new Map<string, { at: number; v: WorkCheckView }>();
  /** AI の画面の片付けが残っている起動（liveLaunches。15 秒） */
  #live: { at: number; v: Map<string, LiveLaunch> } | null = null;
  readonly #ci = new Map<string, { at: number; v: Awaited<ReturnType<LaunchSystem["prCheck"]>> }>();
  readonly #git = new Map<string, boolean>();
  #timer: ReturnType<typeof setInterval> | null = null;
  readonly #closer: TerminalCloser;

  constructor(o: LaunchServiceOptions) {
    this.#o = o;
    this.#closer = new TerminalCloser({
      sqlite: o.sqlite,
      open: o.open,
      now: () => o.clock.now(),
      sleep: o.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms))),
      waitMs: o.finishWaitMs ?? FINISH_WAIT_MS,
      sessionWait: o.sessionWait,
      orcaApp: o.orcaApp,
    });
  }

  /**
   * PR の変更の量と CI（離れていた間のまとめ・終わった件の行。D-214 (2)）。確認支援と同じ控え（#ci）を使い、
   * maxAgeMs より古ければ gh で読み直す。fetch: false なら控えだけ（読み直さない）。gh で読めなければ null
   */
  async prChange(
    ref: string,
    opts: { maxAgeMs?: number; fetch?: boolean } = {},
  ): Promise<{
    files: number | null;
    additions: number | null;
    deletions: number | null;
    ci: CiState | null;
  } | null> {
    const m = /^([^#]+)#(\d+)$/.exec(ref);
    if (!m) return null;
    const now = this.#o.clock.now();
    let c = this.#ci.get(ref);
    if ((!c || now - c.at > (opts.maxAgeMs ?? 5 * 60_000)) && opts.fetch !== false) {
      c = { at: now, v: await this.#o.sys.prCheck(m[1] as string, Number(m[2])) };
      this.#ci.set(ref, c);
    }
    return this.prChangeCached(ref);
  }

  /** prChange の控えだけを読む（gh を呼ばない。自分の番の一覧の行） */
  prChangeCached(ref: string): {
    files: number | null;
    additions: number | null;
    deletions: number | null;
    ci: CiState | null;
  } | null {
    const v = this.#ci.get(ref)?.v;
    if (!v) return null;
    return {
      files: v.files,
      additions: v.additions,
      deletions: v.deletions,
      ci: summarizeChecks(v.rollup).state,
    };
  }

  start(): void {
    this.#timer = setInterval(() => {
      try {
        this.tick();
      } catch (e) {
        this.#o.logger.warn("launch.tick_failed", errorFields(e));
      }
    }, this.#o.intervalMs ?? 10_000);
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  // ---------- 選択肢 ----------

  templates(): AiTemplateView[] {
    const own = this.#o.sqlite
      .query<
        {
          id: string;
          name: string;
          body: string;
          tool: AiLaunchTool | null;
          read_only: number;
          worktree: number | null;
        },
        []
      >("SELECT id, name, body, tool, read_only, worktree FROM ai_template ORDER BY created_at")
      .all()
      .map((r) => ({
        id: r.id,
        name: r.name,
        builtin: false,
        body: r.body,
        tool: r.tool,
        readOnly: r.read_only === 1,
        worktree: r.worktree === null ? null : r.worktree === 1,
      }));
    return [...builtinTemplates(this.#o.locale()), ...own];
  }

  async #isGit(path: string): Promise<boolean> {
    const hit = this.#git.get(path);
    if (hit !== undefined) return hit;
    const r = await this.#o.sys.git.run(path, ["rev-parse", "--show-toplevel"], 5000);
    // リポジトリのルートだけ（サブディレクトリは選ばせない）。/var と /private/var のような別名は実体で比べる
    const real = (p: string) => {
      try {
        return realpathSync(p);
      } catch {
        return normalize(p);
      }
    };
    const ok = r.ok && real(r.out.trim()) === real(path);
    this.#git.set(path, ok);
    return ok;
  }

  #projectFor(repo: string): {
    id: string;
    color: string | null;
    worktree_default: number | null;
    worktree_copy_globs_json: string;
    test_command: string | null;
  } | null {
    const rows = this.#o.sqlite
      .query<
        {
          id: string;
          color: string | null;
          repo_paths_json: string;
          worktree_default: number | null;
          worktree_copy_globs_json: string;
          test_command: string | null;
        },
        []
      >(
        "SELECT id, color, repo_paths_json, worktree_default, worktree_copy_globs_json, test_command FROM project WHERE deleted_at IS NULL AND archived_at IS NULL",
      )
      .all();
    return rows.find((r) => parseRepoPaths(r.repo_paths_json).includes(repo)) ?? null;
  }

  /** taskId が無ければ（作成のポップオーバーでまだタスクが無いとき）プロジェクトなしとして選ぶ */
  async options(taskId: string | null): Promise<AiLaunchOptions> {
    const t = taskId ? this.#task(taskId) : { project_id: null };
    const db = this.#o.sqlite;
    const projects = db
      .query<{ id: string; repo_paths_json: string }, []>(
        "SELECT id, repo_paths_json FROM project WHERE deleted_at IS NULL AND archived_at IS NULL ORDER BY name",
      )
      .all();
    const own = projects.find((p) => p.id === t.project_id);
    const paths: string[] = [];
    const add = (p: string | null | undefined) => {
      if (p && isAbsolute(p) && !CONTROL.test(p) && !paths.includes(p) && this.#o.sys.exists(p))
        paths.push(p);
    };
    for (const p of parseRepoPaths(own?.repo_paths_json)) add(p);
    for (const pr of projects) for (const p of parseRepoPaths(pr.repo_paths_json)) add(p);
    const last = this.#last();
    add(last.repo);
    // 最近 AI が作業したリポジトリ（30日、10件まで）
    for (const r of db
      .query<{ repo_root: string }, [number]>(
        "SELECT repo_root FROM work_item WHERE repo_root IS NOT NULL AND deleted_at IS NULL AND last_activity_at >= ? GROUP BY repo_root ORDER BY MAX(last_activity_at) DESC LIMIT 10",
      )
      .all(this.#o.clock.now() - 30 * 86_400_000))
      add(r.repo_root);
    const ownFirst = parseRepoPaths(own?.repo_paths_json).find((p) => paths.includes(p));
    const accounts = this.claudeAccountOptions();
    const projectAccount = this.#projectAccount(accounts);
    const repos: LaunchRepoOption[] = [];
    for (const p of paths.slice(0, 20)) {
      const git = await this.#isGit(p);
      const proj = this.#projectFor(p);
      repos.push({
        path: p,
        name: repoName(p) ?? p,
        git,
        worktreeDefault: git && (proj?.worktree_default ?? 1) === 1,
        color: proj?.color ?? null,
        projectDefault: p === ownFirst,
        claudeAccount: projectAccount(proj?.id),
      });
    }
    const tools = await this.#o.sys.tools();
    const templates = this.templates();
    const defaultRepo =
      ownFirst ??
      (last.repo && paths.includes(last.repo) ? last.repo : null) ??
      repos[0]?.path ??
      null;
    return {
      repos,
      defaultRepo,
      tools,
      defaultTool: last.tool && tools.includes(last.tool) ? last.tool : (tools[0] ?? null),
      templates,
      defaultTemplateId:
        last.templateId && templates.some((x) => x.id === last.templateId)
          ? last.templateId
          : DEFAULT_TEMPLATE_ID,
      terminal: this.#o.terminal()?.name ?? null,
      claudeAccounts: accounts,
      defaultClaudeAccount: this.#defaultAccount(accounts, defaultRepo, t.project_id),
    };
  }

  /** プロジェクトの ID → そのプロジェクトの既定のアカウント（選択肢にあるものだけ） */
  #projectAccount(accounts: ClaudeAccountOption[]) {
    const byProject = this.#accountByProject();
    return (projectId: string | null | undefined): string | null => {
      const a = projectId ? byProject[projectId] : undefined;
      return a && accounts.some((x) => x.path === a) ? a : null;
    };
  }

  /** リポジトリのプロジェクトの既定 → タスクのプロジェクトの既定 → 前回選んだもの → 先頭 */
  #defaultAccount(
    accounts: ClaudeAccountOption[],
    repo: string | null,
    taskProjectId: string | null,
  ): string | null {
    const projectAccount = this.#projectAccount(accounts);
    const last = this.#last().claudeAccount;
    return (
      (repo ? projectAccount(this.#projectFor(repo)?.id) : null) ??
      projectAccount(taskProjectId) ??
      (last && accounts.some((a) => a.path === last) ? last : null) ??
      accounts[0]?.path ??
      null
    );
  }

  // ---------- Claude のアカウント（D-122） ----------

  /** 取り込みで検出した Claude Code の設定ディレクトリ（取り込みを止めたものは除く）。パスの順 */
  #claudeSources(): string[] {
    return this.#o.sqlite
      .query<{ root_path: string }, []>(
        "SELECT root_path FROM ai_source WHERE tool = 'claude_code' AND enabled = 1 ORDER BY root_path",
      )
      .all()
      .map((r) => r.root_path)
      .filter((p) => isAbsolute(p) && !CONTROL.test(p) && this.#o.sys.exists(p));
  }

  #accountSettings(): Record<string, { name?: string; hidden?: boolean }> {
    try {
      const v = getSetting<Record<string, { name?: string; hidden?: boolean }>>(
        this.#o.mutate.db,
        "ai.claude_accounts",
      );
      return v && typeof v === "object" ? v : {};
    } catch {
      return {};
    }
  }

  #accountByProject(): Record<string, string> {
    try {
      const v = getSetting<Record<string, string>>(
        this.#o.mutate.db,
        "ai.claude_account_by_project",
      );
      return v && typeof v === "object" ? v : {};
    } catch {
      return {};
    }
  }

  /** 設定 > AI の一覧（外したものも含む） */
  claudeAccounts(): ClaudeAccountView[] {
    const conf = this.#accountSettings();
    const home = this.#o.home.replace(/\/+$/, "");
    return this.#claudeSources().map((path) => ({
      path,
      displayPath: path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path,
      dirName: claudeAccountDirName(path, this.#o.home),
      customName: typeof conf[path]?.name === "string" ? (conf[path]?.name as string) : null,
      hidden: conf[path]?.hidden === true,
    }));
  }

  /** 起動の選択肢（外したものを除く） */
  claudeAccountOptions(): ClaudeAccountOption[] {
    return this.claudeAccounts()
      .filter((a) => !a.hidden)
      .map((a) => ({ path: a.path, name: a.customName ?? a.dirName }));
  }

  #last(): { tool?: AiLaunchTool; templateId?: string; repo?: string; claudeAccount?: string } {
    try {
      return (
        getSetting<{
          tool?: AiLaunchTool;
          templateId?: string;
          repo?: string;
          claudeAccount?: string;
        }>(this.#o.mutate.db, "ai.last_launch") ?? {}
      );
    } catch {
      return {};
    }
  }

  #task(id: string) {
    const t = this.#o.sqlite
      .query<
        {
          id: string;
          title: string;
          title_key: string | null;
          title_params: string | null;
          notes_md: string | null;
          project_id: string | null;
          scheduled_date: string | null;
          status: string;
        },
        [string]
      >(
        "SELECT id, title, title_key, title_params, notes_md, project_id, scheduled_date, status FROM task WHERE id = ? AND deleted_at IS NULL",
      )
      .get(id);
    if (!t) throw new OpError(404, "task_not_found");
    return t;
  }

  // ---------- 依頼 ----------

  /**
   * trigger は起動のきっかけ（ai_launch.trigger）。画面からの依頼は manual。拡張（ADR 0015）は ExtDeps.launcher から
   * 他の値で起動できる
   */
  async launch(input: AiLaunchInput, trigger: AiLaunchTrigger = "manual"): Promise<AiLaunchResult> {
    return (await this.#launch(input, trigger, false)) as AiLaunchResult;
  }

  /**
   * 人のいないときの起動（拡張の時刻・条件による起動。ExtDeps.launcher.launch の unattended）。
   * - 画面がロックされていれば、worktree も起動の行も作らずに locked（screen_locked）を返す。ただしロック中に開ける端末
   *   （Orca。unattendedWaitsWhileLocked）は待たずに起動する
   * - Orca は前面に出さない（--focus なし）。端末を開けなければコピーに落とさず、作った worktree・起動の行を片付けて
   *   locked（not_opened）を返す。呼び出し側はロックが外れてから（次の判定で）もう一度呼べる
   */
  /**
   * 送れない端末を tmux で包むときの tmux（D-238。設定 launch.tmux_wrap がオンで tmux が入っていれば絶対パス。無ければ null）
   */
  #tmuxWrap(): string | null {
    let on: unknown;
    try {
      on = getSetting<unknown>(this.#o.mutate.db, "launch.tmux_wrap");
    } catch {
      on = undefined;
    }
    if (on === false) return null;
    return TMUX_PATHS.find((p) => this.#o.sys.exists(p)) ?? null;
  }

  /** 人のいないときの起動が、画面のロック中に待つか（いまの端末の設定で決まる） */
  unattendedWaitsWhileLocked(): boolean {
    return unattendedWaitsWhileLocked(this.#o.terminal());
  }

  async launchUnattended(
    input: AiLaunchInput,
    trigger: AiLaunchTrigger,
  ): Promise<AiLaunchResult | LaunchDeferred> {
    return this.#launch(input, trigger, true);
  }

  async #launch(
    input: AiLaunchInput,
    trigger: AiLaunchTrigger,
    unattended: boolean,
  ): Promise<AiLaunchResult | LaunchDeferred> {
    const o = this.#o;
    const task = this.#task(input.taskId);
    if (task.status === "done" || task.status === "canceled") throw new OpError(409, "task_closed");
    const repo = input.repo;
    if (!isAbsolute(repo) || CONTROL.test(repo) || repo.split("/").includes(".."))
      throw new OpError(400, "bad_repo");
    if (!o.sys.exists(repo)) throw new OpError(409, "repo_missing");
    const tools = await o.sys.tools();
    if (!tools.includes(input.tool)) throw new OpError(409, "tool_missing");
    const template =
      this.templates().find((x) => x.id === (input.templateId ?? DEFAULT_TEMPLATE_ID)) ??
      (this.templates()[0] as AiTemplateView);
    const instruction = input.instruction?.slice(0, 4000) ?? null;
    // Claude のアカウント（D-122）: 選んだもの（選択肢にあるものだけ）→ 選択肢の既定
    let account: string | null = null;
    let accountChoices = 0;
    if (input.tool === "claude_code") {
      const accounts = this.claudeAccountOptions();
      accountChoices = accounts.length;
      if (input.claudeAccount !== undefined) {
        if (!accounts.some((a) => a.path === input.claudeAccount))
          throw new OpError(409, "account_missing");
        account = input.claudeAccount;
      } else {
        account = this.#defaultAccount(accounts, repo, task.project_id);
      }
    }
    const term = o.terminal();
    if (unattended && unattendedWaitsWhileLocked(term) && (await o.sys.screenLocked())) {
      o.logger.info("launch.deferred", { reason: meta("screen_locked"), trigger: meta(trigger) });
      return { outcome: "locked", reason: "screen_locked" };
    }
    const now = o.clock.now();
    const title = taskDisplayTitle(
      { title: task.title, titleKey: task.title_key, titleParams: task.title_params },
      o.locale(),
    );

    // worktree（git のリポジトリで選んだとき）
    let cwd = repo;
    let worktreePath: string | null = null;
    let branch: string | null = null;
    let baseRef: string | null = null;
    if (input.worktree) {
      if (!(await this.#isGit(repo))) throw new OpError(409, "not_git");
      const head = await o.sys.git.run(repo, [
        "symbolic-ref",
        "--quiet",
        "--short",
        "refs/remotes/origin/HEAD",
      ]);
      baseRef = head.ok && head.out.trim() ? head.out.trim() : "HEAD";
      const dir = this.#worktreeDir();
      for (let i = 0; i < 4 && !worktreePath; i++) {
        const b = worktreeBranch(title, Number.parseInt(randomBytes(2).toString("hex"), 16));
        const p = worktreePathFor(repo, b, dir);
        if (o.sys.exists(p)) continue;
        const r = await o.sys.git.run(repo, ["worktree", "add", p, "-b", b, baseRef], 60_000);
        if (!r.ok) {
          o.logger.warn("launch.worktree_failed", { repo: meta(repoName(repo) ?? "") });
          throw new OpError(409, "worktree_failed");
        }
        worktreePath = p;
        branch = b;
      }
      if (!worktreePath) throw new OpError(409, "worktree_failed");
      cwd = worktreePath;
      this.#copyUntracked(repo, worktreePath);
    } else {
      const b = await o.sys.git.run(repo, ["rev-parse", "--abbrev-ref", "HEAD"], 5000);
      branch = b.ok && b.out.trim() && b.out.trim() !== "HEAD" ? b.out.trim() : null;
    }

    const id = randomBytes(16).toString("hex");
    const sessionUuid = input.tool === "claude_code" ? randomUUID() : null;
    const prompt = composePrompt(template.body, {
      title,
      notes: task.notes_md,
      repo: repoName(repo),
      branch,
      instruction,
    });
    const argv = launchArgv({
      tool: input.tool,
      prompt,
      sessionUuid,
      name: title,
      readOnly: template.readOnly,
      cwd,
      // Claude の利用枠の受け口（turnlane statusline）。本体が起動するセッションにだけ付け、利用者の statusLine は受け口の中で
      // そのまま動かす（利用者の settings.json は書き換えない）。見た目の設定（padding など）は利用者のものを引き継ぐ
      settings:
        input.tool === "claude_code"
          ? statusLineSettingsJson(
              o.cliPath,
              findUserStatusLine({
                configDir: (account ?? `${o.home.replace(/\/+$/, "")}/.claude`).replace(/\/+$/, ""),
                projectDir: cwd,
              }),
            )
          : null,
    });
    o.sqlite.run(
      `INSERT INTO ai_launch (id, task_id, tool, repo_root, cwd, worktree_path, branch, base_ref, template_id, read_only,
         trigger, session_uuid, claude_account, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      [
        id,
        task.id,
        input.tool,
        repo,
        cwd,
        worktreePath,
        branch,
        baseRef,
        template.id,
        template.readOnly ? 1 : 0,
        trigger,
        sessionUuid,
        input.tool === "claude_code" ? account : null,
        now,
        now,
      ],
    );
    const accountEnv = claudeAccountEnv(account, o.home, accountChoices);
    this.#pending.set(id, {
      claim: {
        cwd,
        argv,
        env: { TURNLANE_LAUNCH_ID: id, ...accountEnv.set },
        ...(accountEnv.unset.length > 0 ? { unsetEnv: accountEnv.unset } : {}),
      },
      expiresAt: now + CLAIM_TTL_MS,
    });
    try {
      const prev = this.#last();
      putSetting(o.mutate, "ai.last_launch", {
        tool: input.tool,
        templateId: template.id,
        repo,
        ...(account
          ? { claudeAccount: account }
          : prev.claudeAccount
            ? { claudeAccount: prev.claudeAccount }
            : {}),
      });
    } catch {}
    this.#publishTask(task.id, task.scheduled_date);

    const tmux = this.#tmuxWrap();
    const plan = planLaunch(term, o.cliPath, id, cwd, {
      title,
      repo,
      unattended,
      tmux,
      // Ghostty: AppleScript を切っている・古いと分かれば tmux で包む（D-244。Apple Event は送らずに版と設定を読む）
      ...(tmux && term?.id === "ghostty"
        ? { ghosttyScriptable: await ghosttyScriptable(o.open, term.path, o.clock.now()) }
        : {}),
    });
    for (const a of plan) {
      if (!(await this.#run(a))) continue;
      o.logger.info("launch.opened", {
        tool: meta(input.tool),
        outcome: meta(a.outcome),
        worktree: worktreePath !== null,
      });
      return {
        launchId: id,
        outcome: a.outcome === "typed" ? "opened" : (a.outcome as AiLaunchResult["outcome"]),
        app: a.app,
        command: a.copy ?? null,
        cwd,
        worktreePath,
        branch,
      };
    }
    if (unattended) {
      // 開けなかった: 起動の行と、いま作った worktree・ブランチを片付ける（次の判定でやり直すたびに増やさない）
      this.#pending.delete(id);
      o.sqlite.run("DELETE FROM ai_launch WHERE id = ?", [id]);
      if (worktreePath) {
        await o.sys.git.run(repo, ["worktree", "remove", "--force", worktreePath], 30_000);
        if (branch) await o.sys.git.run(repo, ["branch", "-D", branch]);
      }
      this.#publishTask(task.id, task.scheduled_date);
      o.logger.info("launch.deferred", { reason: meta("not_opened"), trigger: meta(trigger) });
      return { outcome: "locked", reason: "not_opened" };
    }
    // コピーだけは必ず成功扱い（pbcopy が無くても UI がコピーし直す）
    const last = plan.at(-1) as Attempt;
    return {
      launchId: id,
      outcome: "copied",
      app: null,
      command: last.copy ?? null,
      cwd,
      worktreePath,
      branch,
    };
  }

  #worktreeDir(): string | null {
    try {
      const v = getSetting<string | null>(this.#o.mutate.db, "ai.worktree_dir");
      return typeof v === "string" && isAbsolute(v) ? v : null;
    } catch {
      return null;
    }
  }

  /** プロジェクトの「worktree にコピーするファイル」（glob）。既にあるファイルは上書きしない */
  #copyUntracked(repo: string, worktree: string): void {
    const p = this.#projectFor(repo);
    if (!p) return;
    let globs: string[] = [];
    try {
      const v = JSON.parse(p.worktree_copy_globs_json) as unknown;
      globs = Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    } catch {}
    for (const g of globs.slice(0, 20)) {
      for (const rel of this.#o.sys.glob(repo, g)) {
        if (rel.split("/").includes("..") || rel.startsWith(".git/")) continue;
        const to = join(worktree, rel);
        if (!this.#o.sys.exists(to)) this.#o.sys.copyFile(join(repo, rel), to);
      }
    }
  }

  async #run(a: Attempt): Promise<boolean> {
    for (const s of a.steps) {
      const ok = await this.#o.open.run(s.argv, s.timeoutMs ? { timeoutMs: s.timeoutMs } : {});
      if (!ok) return false;
    }
    if (a.copy !== undefined) await this.#o.open.run(["/usr/bin/pbcopy"], { stdin: a.copy });
    return true;
  }

  #publishTask(taskId: string, date: string | null): void {
    this.#o.publish("task", { dates: date ? [date] : [], ids: [taskId], inbox: date === null });
  }

  #row(id: string): LaunchRow {
    if (!LAUNCH_ID.test(id)) throw new OpError(404, "not_found");
    const r = this.#o.sqlite
      .query<LaunchRow, [string]>("SELECT * FROM ai_launch WHERE id = ?")
      .get(id);
    if (!r) throw new OpError(404, "not_found");
    return r;
  }

  // ---------- turnlane ai run ----------

  /** 起動 ID で1回だけ受け取る。期限切れ・受け取り済みは 409 */
  claim(id: string): AiLaunchClaim {
    const r = this.#row(id);
    const p = this.#pending.get(id);
    const now = this.#o.clock.now();
    if (r.status !== "pending" || !p || p.expiresAt < now) {
      this.#pending.delete(id);
      throw new OpError(409, "expired");
    }
    this.#pending.delete(id);
    this.#o.sqlite.run(
      "UPDATE ai_launch SET status = 'started', fetched_at = ?, updated_at = ? WHERE id = ?",
      [now, now, id],
    );
    this.#publishTask(r.task_id, this.#taskDate(r.task_id));
    // タブの居場所を覚える（完了のときにタブを閉じる。AI が先に終わっていてもそのタブのシェルに届ける）
    this.#closer.remember(id);
    return p.claim;
  }

  /** turnlane ai run が起動できなかった（CLI が見つからない） */
  fail(id: string, reason: "cli_missing"): void {
    const r = this.#row(id);
    if (r.status !== "pending" && r.status !== "started") return;
    const now = this.#o.clock.now();
    this.#o.sqlite.run(
      "UPDATE ai_launch SET status = 'failed', fail_reason = ?, updated_at = ? WHERE id = ?",
      [reason, now, id],
    );
    this.#publishTask(r.task_id, this.#taskDate(r.task_id));
  }

  /**
   * turnlane ai run が、AI の CLI の終わりを知らせた（終了コードと、始めてから終わるまでの ms）。紐づいた後でも記録する。
   * 紐づいていなければ、EXIT_GRACE_MS 待っても来なければ unlinked（exited）にする（tick）
   */
  exited(id: string, code: number, afterMs: number): void {
    const r = this.#row(id);
    if (r.status === "pending" || r.exited_at !== null) return;
    const now = this.#o.clock.now();
    this.#o.sqlite.run(
      "UPDATE ai_launch SET exit_code = ?, exit_after_ms = ?, exited_at = ?, updated_at = ? WHERE id = ?",
      [code, afterMs, now, now, id],
    );
    this.#o.logger.info("launch.exited", {
      tool: meta(r.tool),
      trigger: meta(r.trigger),
      status: meta(r.status),
      code,
      after_s: Math.round(afterMs / 1000),
    });
    this.#publishTask(r.task_id, this.#taskDate(r.task_id));
  }

  // ---------- フォルダの信頼（Claude Code） ----------

  /**
   * そのアカウントの Claude Code がフォルダを信頼しているか（設定のファイルの projects[<パス>].hasTrustDialogAccepted だけを読む）。
   * 信頼していないと、対話モードの claude は「このフォルダを信頼しますか」で止まる。Codex・読めないときは unknown
   */
  folderTrust(input: FolderTrustInput): FolderTrust {
    if ((input.tool ?? "claude_code") !== "claude_code") return "unknown";
    let account: string | null;
    if (input.claudeAccount !== undefined) account = input.claudeAccount;
    else {
      let projectId: string | null = null;
      if (input.taskId) {
        try {
          projectId = this.#task(input.taskId).project_id;
        } catch {}
      }
      account = this.#defaultAccount(this.claudeAccountOptions(), input.repo, projectId);
    }
    return this.#trustOf(input.repo, account);
  }

  #trustOf(path: string, account: string | null): FolderTrust {
    if (!isAbsolute(path) || CONTROL.test(path)) return "unknown";
    const o = this.#o;
    const file = claudeConfigFile(account, o.home, (p) => o.sys.exists(p));
    const roots = o.sys.gitRoots(path);
    const keys = trustKeys(roots.real, roots);
    if (roots.real !== path)
      for (const k of trustKeys(path, { top: null, main: null }))
        if (!keys.includes(k)) keys.push(k);
    return folderTrust(keys, o.sys.trustFlags(file, keys));
  }

  /**
   * フォルダの信頼のために、いつもの端末でそのフォルダの claude を開く（前面に出す。人が「信頼する」を選ぶ。Turnlane は
   * 設定のファイルに書かない）。開けなければコマンドをコピーする
   */
  async openForTrust(input: {
    repo: string;
    claudeAccount?: string | null;
  }): Promise<OpenForTrustResult> {
    const o = this.#o;
    const repo = input.repo;
    if (!isAbsolute(repo) || CONTROL.test(repo) || repo.split("/").includes(".."))
      throw new OpError(400, "bad_repo");
    if (!o.sys.exists(repo)) throw new OpError(409, "repo_missing");
    const accounts = this.claudeAccountOptions();
    let account: string | null;
    if (input.claudeAccount !== undefined && input.claudeAccount !== null) {
      if (!accounts.some((a) => a.path === input.claudeAccount))
        throw new OpError(409, "account_missing");
      account = input.claudeAccount;
    } else
      account = input.claudeAccount === null ? null : this.#defaultAccount(accounts, repo, null);
    const command = trustCommand(claudeAccountEnv(account, o.home, accounts.length));
    for (const a of planShell(o.terminal(), repo, command, { repo })) {
      if (!(await this.#run(a))) continue;
      o.logger.info("launch.trust_opened", { outcome: meta(a.outcome) });
      return {
        outcome: a.outcome === "typed" ? "opened" : (a.outcome as OpenForTrustResult["outcome"]),
        app: a.app,
        command: a.copy ?? null,
      };
    }
    // planShell の最後（コピー）は必ず通る
    return { outcome: "copied", app: null, command: null };
  }

  /** 紐づかなかった依頼（unlinked）のフォルダをターミナルで開いて信頼する（B-5。詳細パネルの「ターミナルで開いて信頼する」） */
  async openForTrustOf(launchId: string): Promise<OpenForTrustResult> {
    const r = this.#row(launchId);
    return this.openForTrust({ repo: r.repo_root, claudeAccount: r.claude_account });
  }

  #taskDate(taskId: string): string | null {
    return (
      this.#o.sqlite
        .query<{ scheduled_date: string | null }, [string]>(
          "SELECT scheduled_date FROM task WHERE id = ?",
        )
        .get(taskId)?.scheduled_date ?? null
    );
  }

  // ---------- 紐づけ ----------

  /** 紐づけと期限切れ。変えた依頼の件数を返す */
  tick(): number {
    const o = this.#o;
    const db = o.sqlite;
    const now = o.clock.now();
    for (const [id, p] of this.#pending) if (p.expiresAt < now) this.#pending.delete(id);
    const open = db
      .query<LaunchRow, []>("SELECT * FROM ai_launch WHERE status IN ('pending', 'started')")
      .all();
    const changed: LaunchRow[] = [];
    const set = (r: LaunchRow, sql: string, args: (string | number | null)[]) => {
      db.run(`UPDATE ai_launch SET ${sql}, updated_at = ? WHERE id = ?`, [...args, now, r.id]);
      changed.push(r);
    };
    const linkedIds = new Set(
      db
        .query<{ session_id: string }, []>(
          "SELECT session_id FROM ai_launch WHERE session_id IS NOT NULL",
        )
        .all()
        .map((x) => x.session_id),
    );
    for (const r of open) {
      if (r.status === "pending") {
        // 端末でコマンドが実行されなかった（許可の拒否・コピーしたまま）
        if (r.created_at + CLAIM_TTL_MS < now) {
          set(r, "status = 'failed', fail_reason = 'not_claimed'", []);
          o.logger.info("launch.failed", {
            reason: meta("not_claimed"),
            tool: meta(r.tool),
            trigger: meta(r.trigger),
          });
        }
        continue;
      }
      const since = r.fetched_at ?? r.created_at;
      let sessionId: string | null = null;
      let ambiguous = false;
      if (r.tool === "claude_code" && r.session_uuid) {
        sessionId =
          db
            .query<{ id: string }, [string]>(
              "SELECT id FROM ai_session WHERE tool = 'claude_code' AND external_id = ?",
            )
            .get(r.session_uuid)?.id ?? null;
      } else if (r.tool === "codex") {
        const cands = db
          .query<{ id: string }, [string, number, number]>(
            `SELECT id FROM ai_session WHERE tool = 'codex' AND is_subagent = 0 AND cwd = ?
               AND started_at >= ? AND started_at <= ? ORDER BY started_at, id`,
          )
          .all(r.cwd, since - CODEX_BEFORE_MS, since + CODEX_AFTER_MS)
          .filter((c) => !linkedIds.has(c.id));
        // worktree は依頼ごとに一意なので最初のもの。worktree なしで候補が複数なら選んでもらう
        if (cands.length === 1 || (cands.length > 1 && r.worktree_path !== null))
          sessionId = cands[0]?.id ?? null;
        else if (cands.length > 1) ambiguous = true;
      }
      if (sessionId) {
        linkedIds.add(sessionId);
        set(r, "status = 'linked', session_id = ?, linked_at = ?", [sessionId, now]);
      } else {
        const reason = ambiguous
          ? "no_session"
          : unlinkedReason({
              now,
              since,
              windowMs: LINK_WINDOW_MS,
              exitedAt: r.exited_at,
              // 信頼の確かめは、理由を決めるときだけ（Claude Code で、終わっていないとき）
              trust:
                r.tool === "claude_code" && r.exited_at === null && since + LINK_WINDOW_MS < now
                  ? this.#trustOf(r.cwd, r.claude_account)
                  : "unknown",
            });
        if (reason) {
          set(r, "status = 'unlinked', unlinked_reason = ?", [reason]);
          o.logger.info("launch.unlinked", {
            reason: meta(reason),
            tool: meta(r.tool),
            trigger: meta(r.trigger),
            ...(r.exited_at !== null
              ? { code: r.exit_code, after_s: Math.round((r.exit_after_ms ?? 0) / 1000) }
              : {}),
            waited_s: Math.round((now - since) / 1000),
          });
        }
      }
    }
    if (changed.length > 0) {
      o.onChanged();
      for (const r of changed) this.#publishTask(r.task_id, this.#taskDate(r.task_id));
    }
    return changed.length;
  }

  /** 紐づかなかった依頼の候補（同じツールの、依頼の前後30分に始まった紐づいていないセッション） */
  candidates(id: string): LaunchCandidate[] {
    const r = this.#row(id);
    const since = r.fetched_at ?? r.created_at;
    return this.#o.sqlite
      .query<
        {
          id: string;
          tool: AiLaunchTool;
          title: string | null;
          cwd: string | null;
          started_at: number;
        },
        [string, number, number]
      >(
        `SELECT s.id, s.tool, s.title, s.cwd, s.started_at FROM ai_session s
         WHERE s.tool = ? AND s.is_subagent = 0 AND s.started_at >= ? AND s.started_at <= ?
           AND NOT EXISTS (SELECT 1 FROM ai_launch l WHERE l.session_id = s.id)
         ORDER BY s.started_at DESC LIMIT 10`,
      )
      .all(r.tool, since - 30 * 60_000, since + 30 * 60_000)
      .map((s) => ({
        sessionId: s.id,
        tool: s.tool,
        title: s.title,
        cwd: s.cwd,
        startedAt: s.started_at,
      }));
  }

  /** 候補から選んで紐づける */
  link(id: string, sessionId: string): void {
    const r = this.#row(id);
    if (!this.candidates(id).some((c) => c.sessionId === sessionId))
      throw new OpError(409, "not_candidate");
    const now = this.#o.clock.now();
    this.#o.sqlite.run(
      "UPDATE ai_launch SET status = 'linked', session_id = ?, linked_at = ?, updated_at = ? WHERE id = ?",
      [sessionId, now, now, id],
    );
    this.#o.onChanged();
    this.#publishTask(r.task_id, this.#taskDate(r.task_id));
  }

  // ---------- 確認支援 ----------

  /** AI 項目に紐づいた依頼（最後のもの） */
  #launchForWorkItem(workItemId: string): LaunchRow | null {
    return (
      this.#o.sqlite
        .query<LaunchRow, [string]>(
          `SELECT l.* FROM ai_launch l WHERE l.session_id IN
             (SELECT DISTINCT session_id FROM ai_turn WHERE work_item_id = ?)
           ORDER BY l.created_at DESC LIMIT 1`,
        )
        .get(workItemId) ?? null
    );
  }

  async check(ref: { workItemId?: string; launchId?: string }): Promise<WorkCheckView> {
    const key = ref.launchId ? `l:${ref.launchId}` : `w:${ref.workItemId}`;
    const hit = this.#checks.get(key);
    const now = this.#o.clock.now();
    if (hit && now - hit.at < CHECK_TTL_MS) return this.#withTest(hit.v);
    const v = await this.#check(ref);
    this.#checks.set(key, { at: now, v });
    return this.#withTest(v);
  }

  /** テストの状態は毎回メモリから（実行中の表示を遅らせない） */
  #withTest(v: WorkCheckView): WorkCheckView {
    if (!v.launchId) return v;
    const m = this.#tests.get(v.launchId);
    if (!m) return v;
    return {
      ...v,
      test: { ...v.test, state: m.state, at: m.at, exitCode: m.exitCode, tail: m.tail },
    };
  }

  async #check(ref: { workItemId?: string; launchId?: string }): Promise<WorkCheckView> {
    const db = this.#o.sqlite;
    const git = this.#o.sys.git;
    let launch: LaunchRow | null = null;
    let workItemId = ref.workItemId ?? null;
    if (ref.launchId) {
      launch = this.#row(ref.launchId);
      workItemId = launch.status === "linked" ? launchWorkItem(db, launch.session_id) : null;
    } else if (workItemId) launch = this.#launchForWorkItem(workItemId);
    const w = workItemId
      ? db
          .query<{ repo_root: string | null; branch: string | null }, [string]>(
            "SELECT repo_root, branch FROM work_item WHERE id = ? AND deleted_at IS NULL",
          )
          .get(workItemId)
      : null;
    if (ref.workItemId && !w && !launch) throw new OpError(404, "not_found");
    const repo = launch?.repo_root ?? w?.repo_root ?? null;
    const branch = launch?.branch ?? w?.branch ?? null;
    const wt =
      launch?.worktree_path &&
      launch.cleaned_at === null &&
      this.#o.sys.exists(launch.worktree_path)
        ? launch.worktree_path
        : null;

    // 差分
    let diff: WorkCheckView["diff"] = null;
    const range = await this.#diffRange(repo, branch, wt, launch?.base_ref ?? null);
    if (range) {
      const ns = await git.run(range.cwd, ["diff", "--numstat", ...range.args], 20_000);
      const commits = await git.run(
        range.cwd,
        ["rev-list", "--count", `${range.point}..${range.head}`],
        10_000,
      );
      const st = wt ? await git.run(wt, ["status", "--porcelain"], 10_000) : null;
      if (ns.ok) {
        const p = parseNumstat(ns.out);
        diff = {
          base: range.base,
          ...p,
          commits: commits.ok ? Number(commits.out.trim()) || 0 : 0,
          uncommitted: st?.ok ? countPorcelain(st.out) : null,
        };
      }
    }

    // PR と CI
    let pr: WorkCheckView["pr"] = null;
    let ci: WorkCheckView["ci"] = null;
    const art = workItemId
      ? db
          .query<{ ref: string; url: string | null }, [string]>(
            "SELECT ref, url FROM ai_artifact WHERE work_item_id = ? AND kind = 'pr' ORDER BY first_seen_at DESC LIMIT 1",
          )
          .get(workItemId)
      : null;
    if (art) {
      const m = /^([^#]+)#(\d+)$/.exec(art.ref);
      if (m) {
        const num = Number(m[2]);
        const k = art.ref;
        const now = this.#o.clock.now();
        let c = this.#ci.get(k);
        if (!c || now - c.at > CI_TTL_MS) {
          c = { at: now, v: await this.#o.sys.prCheck(m[1] as string, num) };
          this.#ci.set(k, c);
        }
        pr = {
          number: num,
          url: c.v?.url ?? art.url ?? `https://github.com/${m[1]}/pull/${num}`,
          additions: c.v?.additions ?? null,
          deletions: c.v?.deletions ?? null,
          files: c.v?.files ?? null,
        };
        ci = c.v ? summarizeChecks(c.v.rollup) : null;
      }
    }

    // テスト（プロジェクトの設定。依頼のときだけ実行できる）
    const command = launch && repo ? this.#projectFor(repo)?.test_command?.trim() || null : null;
    const test: WorkCheckView["test"] = {
      command,
      state: !command
        ? "none"
        : launch?.test_ok === 1
          ? "passed"
          : launch?.test_ok === 0
            ? "failed"
            : "idle",
      at: launch?.test_at ?? null,
      exitCode: null,
      tail: [],
    };
    return {
      workItemId,
      launchId: launch?.id ?? null,
      diff,
      test,
      ci,
      pr,
      worktree: launch?.worktree_path
        ? {
            path: launch.worktree_path,
            branch: launch.branch,
            exists: launch.cleaned_at === null && this.#o.sys.exists(launch.worktree_path),
            cleanedAt: launch.cleaned_at,
          }
        : null,
    };
  }

  /**
   * 差分の範囲: base（依頼のときの base_ref、無ければ origin/HEAD）とブランチの分岐点から、worktree があれば作業ツリーまで
   * （未コミットの変更を含む）、無ければブランチの先端まで。git でない・base と同じブランチ・分からなければ null
   */
  async #diffRange(
    repo: string | null,
    branch: string | null,
    wt: string | null,
    baseRef: string | null,
  ): Promise<{ cwd: string; base: string; point: string; head: string; args: string[] } | null> {
    const git = this.#o.sys.git;
    if (!repo || !this.#o.sys.exists(repo) || !(await this.#isGit(repo))) return null;
    let base = baseRef;
    if (!base) {
      const h = await git.run(repo, [
        "symbolic-ref",
        "--quiet",
        "--short",
        "refs/remotes/origin/HEAD",
      ]);
      base = h.ok && h.out.trim() ? h.out.trim() : null;
    }
    const head = wt ? "HEAD" : branch;
    if (!head || !base) return null;
    // origin の無いリポジトリでは base が "HEAD"（依頼のときのリポジトリの HEAD）。worktree の中の HEAD はブランチの方を
    // 指すので、リポジトリで解いたコミットにする
    let from = base;
    if (base === "HEAD" && wt) {
      const h = await git.run(repo, ["rev-parse", "--verify", "HEAD"], 10_000);
      if (!h.ok || !h.out.trim()) return null;
      from = h.out.trim();
    } else if (head === base || `origin/${head}` === base) return null;
    const cwd = wt ?? repo;
    const mb = await git.run(cwd, ["merge-base", from, head], 10_000);
    if (!mb.ok || !mb.out.trim()) return null;
    const point = mb.out.trim();
    // worktree は作業ツリーまで（未コミットの変更を含む）、そうでなければブランチの先端まで
    return { cwd, base, point, head, args: wt ? [point] : [point, head] };
  }

  /**
   * 依頼の差分の中身（拡張の review.diff）: ファイルごとの追加・削除と、上限つきの抜粋。範囲は check の差分と同じ。
   * 分からなければ null。git の読み取りだけ（書き込みはしない）
   */
  async diff(
    launchId: string,
    o: { maxFiles?: number; maxBytes?: number } = {},
  ): Promise<WorkDiffView | null> {
    const r = this.#row(launchId);
    const git = this.#o.sys.git;
    const wt =
      r.worktree_path && r.cleaned_at === null && this.#o.sys.exists(r.worktree_path)
        ? r.worktree_path
        : null;
    const range = await this.#diffRange(r.repo_root, r.branch, wt, r.base_ref);
    if (!range) return null;
    const maxFiles = Math.max(1, Math.min(DIFF_MAX_FILES, o.maxFiles ?? DIFF_DEFAULT_FILES));
    const maxBytes = Math.max(1024, Math.min(DIFF_MAX_BYTES, o.maxBytes ?? DIFF_DEFAULT_BYTES));
    const ns = await git.run(range.cwd, ["diff", "--numstat", ...range.args], 20_000);
    if (!ns.ok) return null;
    const all = parseNumstatFiles(ns.out);
    const untracked = wt
      ? (await git.run(wt, ["ls-files", "--others", "--exclude-standard"], 10_000)).out
          .split("\n")
          .map((x) => x.trim())
          .filter(Boolean)
      : [];
    const raw = await git.run(
      range.cwd,
      ["diff", "--no-color", "--no-ext-diff", "--unified=2", ...range.args],
      20_000,
    );
    const ex = raw.ok
      ? diffExcerpt(raw.out, { maxBytes, perFile: Math.max(512, Math.floor(maxBytes / 4)) })
      : { excerpt: "", truncated: true };
    const weight = (f: (typeof all)[number]) => (f.additions ?? 0) + (f.deletions ?? 0);
    const files = [...all].sort((a, b) => weight(b) - weight(a)).slice(0, maxFiles);
    return {
      base: range.base,
      files,
      totalFiles: all.length + untracked.length,
      additions: all.reduce((n, f) => n + (f.additions ?? 0), 0),
      deletions: all.reduce((n, f) => n + (f.deletions ?? 0), 0),
      untracked: untracked.slice(0, maxFiles),
      excerpt: ex.excerpt,
      truncated: ex.truncated || all.length > maxFiles || untracked.length > maxFiles,
    };
  }

  /** テストをボタンで実行する（無料。D-110 (10)）。すぐ返し、終わったら SSE で知らせる */
  runTest(launchId: string): { state: "running" } {
    const r = this.#row(launchId);
    const cmd = this.#projectFor(r.repo_root)?.test_command?.trim();
    if (!cmd) throw new OpError(409, "no_test_command");
    if (this.#tests.get(launchId)?.state === "running") return { state: "running" };
    const cwd =
      r.worktree_path && r.cleaned_at === null && this.#o.sys.exists(r.worktree_path)
        ? r.worktree_path
        : r.repo_root;
    const started = this.#o.clock.now();
    this.#tests.set(launchId, { state: "running", at: started, exitCode: null, tail: [] });
    this.#invalidate(r);
    void this.#o.sys
      .runTest(cmd, cwd, TEST_TIMEOUT_MS)
      .then((res) => {
        const ok = res.exitCode === 0;
        const at = this.#o.clock.now();
        this.#tests.set(launchId, {
          state: ok ? "passed" : "failed",
          at,
          exitCode: res.exitCode,
          tail: res.tail,
        });
        this.#o.sqlite.run(
          "UPDATE ai_launch SET test_ok = ?, test_at = ?, updated_at = ? WHERE id = ?",
          [ok ? 1 : 0, at, at, launchId],
        );
        this.#o.logger.info("launch.test_done", {
          ok,
          timed_out: res.timedOut,
          ms: at - started,
        });
      })
      .catch((e) => {
        this.#tests.set(launchId, {
          state: "failed",
          at: this.#o.clock.now(),
          exitCode: null,
          tail: [],
        });
        this.#o.logger.warn("launch.test_failed", errorFields(e));
      })
      .finally(() => this.#invalidate(r));
    return { state: "running" };
  }

  #invalidate(r: LaunchRow): void {
    this.#checks.clear();
    this.#live = null;
    const wi = r.status === "linked" ? launchWorkItem(this.#o.sqlite, r.session_id) : null;
    this.#o.publish("work_item", { dates: [], ids: wi ? [wi] : [] });
    this.#publishTask(r.task_id, this.#taskDate(r.task_id));
  }

  // ---------- 片付け ----------

  /**
   * worktree を片付ける。force なしは clean かつ取り込み済み（base に含まれる・base からのコミットが無い・PR がマージ／クローズ済み）
   * のときだけ消す。force は詳細パネルで確認した後（未コミット・未マージを捨てる）
   */
  async cleanup(launchId: string, force: boolean): Promise<WorktreeCleanupResult> {
    const r = this.#row(launchId);
    const git = this.#o.sys.git;
    if (!r.worktree_path) return { removed: false, reason: "missing", uncommitted: null };
    if (r.cleaned_at !== null) return { removed: true, reason: null, uncommitted: null };
    const now = this.#o.clock.now();
    const mark = () => {
      this.#o.sqlite.run("UPDATE ai_launch SET cleaned_at = ?, updated_at = ? WHERE id = ?", [
        now,
        now,
        launchId,
      ]);
      this.#invalidate(r);
    };
    if (!this.#o.sys.exists(r.worktree_path)) {
      mark();
      return { removed: true, reason: "missing", uncommitted: null };
    }
    const { uncommitted, merged } = await this.#worktreeState(r);
    if (!force) {
      if (uncommitted === null || uncommitted > 0)
        return { removed: false, reason: "dirty", uncommitted };
      if (!merged) return { removed: false, reason: "unmerged", uncommitted };
    }
    const rm = await git.run(
      r.repo_root,
      ["worktree", "remove", ...(force ? ["--force"] : []), r.worktree_path],
      30_000,
    );
    if (!rm.ok) return { removed: false, reason: "failed", uncommitted };
    if (r.branch) await git.run(r.repo_root, ["branch", force ? "-D" : "-d", r.branch]);
    this.#o.logger.info("launch.worktree_removed", { forced: force });
    mark();
    return { removed: true, reason: null, uncommitted };
  }

  /** worktree の未コミットの数（読めなければ null）と、取り込み済みか（base に含まれる・base からのコミットが無い・PR が閉じた） */
  async #worktreeState(r: LaunchRow): Promise<{ uncommitted: number | null; merged: boolean }> {
    const git = this.#o.sys.git;
    const st = await git.run(r.worktree_path as string, ["status", "--porcelain"], 10_000);
    const uncommitted = st.ok ? countPorcelain(st.out) : null;
    let merged = false;
    if (r.branch && r.base_ref) {
      const anc = await git.run(r.repo_root, ["merge-base", "--is-ancestor", r.branch, r.base_ref]);
      const ahead = await git.run(r.repo_root, [
        "rev-list",
        "--count",
        `${r.base_ref}..${r.branch}`,
      ]);
      const prDone = this.#o.sqlite
        .query<{ n: number }, [string]>(
          "SELECT count(*) AS n FROM ai_artifact WHERE kind = 'pr' AND head_ref = ? AND state IN ('merged', 'closed')",
        )
        .get(r.branch);
      merged = anc.ok || (ahead.ok && ahead.out.trim() === "0") || (prDone?.n ?? 0) > 0;
    }
    return { uncommitted, merged };
  }

  // ---------- 完了のときの片付け（完了のシート） ----------

  /**
   * 完了にするタスクのうち、起動が生きている依頼（started / linked で、worktree が残っているか AI のプロセスが動いている）。
   * 空ならシートを出さない
   */
  async finishPlan(taskIds: readonly string[]): Promise<LaunchFinishPlan> {
    const ids = [...new Set(taskIds)].slice(0, 50);
    if (ids.length === 0) return { launches: [] };
    const rows = this.#o.sqlite
      .query<LaunchRow, string[]>(
        `SELECT * FROM ai_launch WHERE status IN ('started', 'linked') AND task_id IN (${ids
          .map(() => "?")
          .join(",")}) ORDER BY created_at`,
      )
      .all(...ids);
    const launches: LaunchFinishItem[] = [];
    for (const r of rows) {
      const item = await this.#finishItem(r);
      if (item) launches.push(item);
    }
    return { launches };
  }

  /** 起動が生きている依頼 1 件（worktree が残っているか AI のプロセスが動いている）。どちらも無ければ null */
  async #finishItem(r: LaunchRow): Promise<LaunchFinishItem | null> {
    const wt =
      r.worktree_path && r.cleaned_at === null && this.#o.sys.exists(r.worktree_path)
        ? r.worktree_path
        : null;
    const aiRunning = await this.#closer.aiRunning(r);
    if (!wt && !aiRunning) return null;
    let worktree: LaunchFinishItem["worktree"] = null;
    if (wt) {
      const st = await this.#worktreeState(r);
      worktree = {
        path: wt,
        branch: r.branch,
        state:
          st.uncommitted === null || st.uncommitted > 0
            ? "dirty"
            : st.merged
              ? "clean"
              : "unmerged",
      };
    }
    return { launchId: r.id, taskId: r.task_id, tool: r.tool, aiRunning, worktree };
  }

  /**
   * AI の画面の「片付けが残っている」（GET /api/ai/live）: セッションに紐づいた依頼のうち、worktree が残っているか AI の
   * プロセスが動いているもの（完了のシートと同じ判定）。AI 項目 → 起動（同じ項目に複数あれば新しい依頼）。pgrep と git を
   * 使うので確認支援と同じく 15 秒覚える（片付け・起動の状態が変われば捨てる）
   */
  async liveLaunches(): Promise<Map<string, LiveLaunch>> {
    const now = this.#o.clock.now();
    if (this.#live && now - this.#live.at < CHECK_TTL_MS) return this.#live.v;
    const rows = this.#o.sqlite
      .query<LaunchRow & { task_status: string | null }, []>(
        `SELECT l.*, t.status AS task_status FROM ai_launch l LEFT JOIN task t ON t.id = l.task_id
         WHERE l.status IN ('started', 'linked') AND l.session_id IS NOT NULL
           AND (l.exited_at IS NULL OR (l.worktree_path IS NOT NULL AND l.cleaned_at IS NULL))
         ORDER BY l.created_at DESC LIMIT 200`,
      )
      .all();
    const v = new Map<string, LiveLaunch>();
    for (const r of rows) {
      const wi = launchWorkItem(this.#o.sqlite, r.session_id);
      if (!wi || v.has(wi)) continue;
      const item = await this.#finishItem(r);
      if (!item) continue;
      v.set(wi, {
        launchId: item.launchId,
        taskId: item.taskId,
        taskDone: r.task_status === "done",
        aiRunning: item.aiRunning,
        worktree: item.worktree,
      });
    }
    this.#live = { at: now, v };
    return v;
  }

  /**
   * 完了のシートで選んだ片付け: AI を終了してタブを閉じる → worktree を消す（force はシートで明示したときだけ）。
   * どちらかが失敗しても止めずに結果を返す（タスクの完了は呼び出し側）
   */
  async finish(launchId: string, input: LaunchFinishInput): Promise<LaunchFinishResult> {
    const r = this.#row(launchId);
    let terminal: LaunchFinishResult["terminal"] = null;
    let reason: LaunchFinishResult["reason"] = null;
    let app: string | null = null;
    if (input.closeTerminal) {
      try {
        ({ terminal, reason, app } = await this.#closer.close(r));
      } catch (e) {
        this.#o.logger.warn("launch.finish_terminal_failed", errorFields(e));
        terminal = "failed";
        reason = "send_failed";
      }
    }
    let worktree: WorktreeCleanupResult | null = null;
    if (input.removeWorktree && r.worktree_path && r.cleaned_at === null) {
      try {
        worktree = await this.cleanup(launchId, input.force);
      } catch (e) {
        this.#o.logger.warn("launch.cleanup_failed", errorFields(e));
        worktree = { removed: false, reason: "failed", uncommitted: null };
      }
    }
    this.#o.logger.info("launch.finished", {
      tool: meta(r.tool),
      terminal: meta(terminal ?? "skipped"),
      ...(reason ? { reason: meta(reason) } : {}),
      worktree: meta(
        worktree ? (worktree.removed ? "removed" : (worktree.reason ?? "kept")) : "skipped",
      ),
      forced: input.force,
    });
    return { terminal, reason, app, worktree };
  }

  /** タスクを完了にしたとき: そのタスクの依頼の worktree を、消してよいものだけ片付ける */
  async onTaskCompleted(taskId: string): Promise<void> {
    const rows = this.#o.sqlite
      .query<{ id: string }, [string]>(
        "SELECT id FROM ai_launch WHERE task_id = ? AND worktree_path IS NOT NULL AND cleaned_at IS NULL",
      )
      .all(taskId);
    for (const r of rows) {
      try {
        await this.cleanup(r.id, false);
      } catch (e) {
        this.#o.logger.warn("launch.cleanup_failed", errorFields(e));
      }
    }
  }

  // ---------- 依頼の型（利用者が足すもの。plan §B.4） ----------

  saveTemplate(
    id: string | null,
    v: {
      name: string;
      body: string;
      tool: AiLaunchTool | null;
      readOnly: boolean;
      worktree: boolean | null;
    },
  ): AiTemplateView {
    const now = this.#o.clock.now();
    const db = this.#o.sqlite;
    if (id === null) {
      const nid = newId(this.#o.clock);
      db.run(
        "INSERT INTO ai_template (id, name, body, tool, read_only, worktree, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [
          nid,
          v.name,
          v.body,
          v.tool,
          v.readOnly ? 1 : 0,
          v.worktree === null ? null : v.worktree ? 1 : 0,
          now,
          now,
        ],
      );
      id = nid;
    } else {
      if (id.startsWith("builtin:")) throw new OpError(409, "builtin");
      const r = db.run(
        "UPDATE ai_template SET name = ?, body = ?, tool = ?, read_only = ?, worktree = ?, updated_at = ? WHERE id = ?",
        [
          v.name,
          v.body,
          v.tool,
          v.readOnly ? 1 : 0,
          v.worktree === null ? null : v.worktree ? 1 : 0,
          now,
          id,
        ],
      );
      if (r.changes === 0) throw new OpError(404, "not_found");
    }
    return this.templates().find((t) => t.id === id) as AiTemplateView;
  }

  deleteTemplate(id: string): void {
    if (id.startsWith("builtin:")) throw new OpError(409, "builtin");
    const r = this.#o.sqlite.run("DELETE FROM ai_template WHERE id = ?", [id]);
    if (r.changes === 0) throw new OpError(404, "not_found");
  }
}
