/**
 * デーモン側のオンボーディング（onboarding.md 5 章、M6-18〜M6-20）。画面（M6-21〜）はまだ無く、API と CLI から使う。
 * - 状態（設定 `onboarding`）と、既存の利用者を同意済みにする移行（ensureOnboarding）
 * - 同意のゲート: 同意の前は Supervisor が検出だけをする（consented()）。同意で取り込みを始める
 * - 検出（ファイルの数と更新時刻だけ）、Choose a folder…（設定ディレクトリを手で足す）
 * - 新しい日からの進捗（SSE import_progress）と、7日の要約（在席・カレンダーに依存しない値だけ）
 * - 通知: 済むまでと、まとめての取り込みの間は止める（muted()）
 * - O4〜O5a（M6-23・M6-24）: カレンダーの接続の開始、hooks のインストール、MCP の登録（同意した取り込み元ごと）
 */
import type { Database } from "bun:sqlite";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { MetaOnlyLogger } from "@turnlane/collectors";
import { errorFields } from "@turnlane/collectors";
import {
  addDays,
  applyOnboardingConsent,
  applyOnboardingStep,
  type Clock,
  dayStartMs,
  existingUserOnboarding,
  getSetting,
  initialOnboarding,
  type MutateCtx,
  ONBOARDING_KEY,
  type Onboarding,
  type OnboardingStep,
  type OnboardingStepStatus,
  putSetting,
  readOnboarding,
  readSettings,
  restartOnboarding,
  toLocalDate,
} from "@turnlane/core";
import type {
  CalendarConnectAttempt,
  CalendarConnectResponse,
  DetectedSourceView,
  DetectResponse,
  HooksInstallResponse,
  HooksInstallTarget,
  ImportProgress,
  McpInstallResponse,
  McpInstallTarget,
  OnboardingBoard,
  OnboardingSummary,
  OnboardingView,
} from "@turnlane/core/api";
import { isInternalSource } from "@turnlane/core/api";
import {
  claudeHooksDisabled,
  claudePlan,
  codexInspect,
  codexPlan,
  install as installHooksIn,
  loadJson,
  saveJson,
} from "@turnlane/core/hooks";
import { applyMcp, backupStamp, McpConfigError, mcpTargetFor, planMcp } from "@turnlane/core/mcp";
import { CalendarConnectError } from "../calendar/connect.ts";
import { OpError } from "../derive/ops.ts";
import type { DeriveRunner } from "../derive/runner.ts";
import { aiDays } from "../derive/views.ts";
import type { SseHub } from "../http/sse.ts";
import type { DetectSummary, Supervisor } from "../ingest/supervisor.ts";
import { computeProgress, emptyProgressMemo, type ProgressMemo, progressKey } from "./progress.ts";

/** 手で足した設定ディレクトリ（Choose a folder…）。local_only の内部の設定（turnlane config には出さない） */
export const EXTRA_ROOTS_KEY = "ingest.extra_roots";
const MAX_EXTRA_ROOTS = 20;

/**
 * 起動時の移行（onboarding.md 5.1）: 設定 `onboarding` が無ければ作る。取り込みのカーソルがある DB（既存の利用者）は
 * 同意済みで流れも済んだもの（done）にし、同意の時刻は最初のカーソルの updated_at。それ以外は pending。
 * assumeDone は、カーソルの無い新しい DB も done にする（テスト・dev-board・E2E）
 */
export function ensureOnboarding(
  sqlite: Database,
  mutate: MutateCtx,
  o: { assumeDone?: boolean } = {},
): Onboarding {
  const cur = readOnboarding(getSetting(mutate.db, ONBOARDING_KEY));
  if (cur) return cur;
  const first =
    sqlite.query<{ t: number | null }, []>("SELECT MIN(updated_at) AS t FROM ingest_cursor").get()
      ?.t ?? null;
  const v =
    first !== null
      ? existingUserOnboarding(first)
      : o.assumeDone
        ? existingUserOnboarding(mutate.clock.now())
        : initialOnboarding();
  putSetting(mutate, ONBOARDING_KEY, v);
  return v;
}

export function readExtraRoots(mutate: MutateCtx): string[] {
  const v = getSetting<unknown>(mutate.db, EXTRA_ROOTS_KEY);
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** 絶対パス（制御文字・`..` を含まない）を正規化する。だめなら null */
function cleanAbsPath(p: unknown): string | null {
  if (typeof p !== "string" || p.length > 1024 || !p.startsWith("/")) return null;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 制御文字を拒むための正規表現
  if (/[\u0000-\u001f\u007f]/.test(p) || p.split("/").includes("..")) return null;
  const s = p.replace(/\/+$/, "");
  return s === "" ? null : s;
}

export interface OnboardingDeps {
  sqlite: Database;
  mutate: MutateCtx;
  clock: Clock;
  hub: SseHub;
  logger: MetaOnlyLogger;
  home: string;
  /** 取り込み（無ければ検出・進捗は空） */
  supervisor: () => Supervisor | null;
  runner: () => DeriveRunner | null;
  /** hooks と MCP に書く turnlane のパス（bin.ts は turnlaned と同じ場所の turnlane。無ければ ~/.local/bin/turnlane） */
  cliPath?: string | null;
  /**
   * カレンダーの接続（O4 の主ボタン）: ヘルパを常駐させて許可のダイアログを出す。結果は待たない（画面が status で確かめる）。
   * null ならこのデーモンにその手段が無い（テスト・開発）
   */
  calendarConnect?: (() => Promise<void>) | null;
  /** システム設定の画面を開く（O4 の拒否・O7）。null なら開けない */
  openSettings?: ((pane: "calendars" | "notifications") => Promise<boolean>) | null;
}

/** システム設定の画面の URL（macOS 13 以降） */
export const SYSTEM_SETTINGS_URL = {
  calendars: "x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars",
  notifications: "x-apple.systempreferences:com.apple.Notifications-Settings.extension",
} as const;

/** 同意した（取り込む）Claude Code / Codex の取り込み元（hooks・MCP の対象。D-122: 設定ディレクトリごと） */
type ConfigSource = { id: string; tool: "claude_code" | "codex"; rootPath: string };

export class OnboardingService {
  readonly #d: OnboardingDeps;
  #state: Onboarding;
  #memo: ProgressMemo = emptyProgressMemo();
  #lastKey = "";
  #derivedAfterImport = false;
  /** 最後に始めたカレンダーの接続（GET /api/onboarding/calendar/connect） */
  #calendarAttempt: CalendarConnectAttempt | null = null;

  constructor(d: OnboardingDeps, initial: Onboarding) {
    this.#d = d;
    this.#state = initial;
  }

  state(): Onboarding {
    return this.#state;
  }

  /** 取り込みのゲート（onboarding.md 5.2）: 同意の時刻があるか */
  consented(): boolean {
    return this.#state.consentedAt !== null;
  }

  /** 通知を止めるか: 流れが済むまでと、まとめての取り込みの間 */
  muted(): boolean {
    return this.#state.state !== "done" || this.#d.supervisor()?.bulkImporting === true;
  }

  #save(next: Onboarding): void {
    this.#state = next;
    putSetting(this.#d.mutate, ONBOARDING_KEY, next);
    this.#d.hub.publish("onboarding", {});
  }

  view(): OnboardingView {
    return {
      ...this.#state,
      consented: this.consented(),
      backfillDone: this.#d.supervisor()?.backfillDone ?? false,
    };
  }

  setStep(step: OnboardingStep, status: OnboardingStepStatus): OnboardingView {
    if (step === "sources" && status === "done" && !this.consented())
      throw new OpError(409, "consent_required");
    this.#save(applyOnboardingStep(this.#state, step, status));
    // カレンダーを許可した後は、過去7日の待ちを予定で区分し直す（4.4。在席の記録を始める前の日は作り直さない）
    if (step === "calendar" && status === "done") this.#rederiveWeek();
    return this.view();
  }

  restart(): OnboardingView {
    this.#save(restartOnboarding(this.#state));
    return this.view();
  }

  #rederiveWeek(): void {
    const runner = this.#d.runner();
    if (!runner) return;
    const s = readSettings(this.#d.mutate.db);
    const today = toLocalDate(this.#d.clock.now(), s.tz, s.dayBoundary);
    try {
      runner.rederive({ waitSince: addDays(today, -7) });
    } catch (e) {
      this.#d.logger.warn("onboarding.rederive_failed", errorFields(e));
    }
  }

  #view(x: DetectSummary, extra: ReadonlySet<string>): DetectedSourceView {
    return {
      id: x.row.id,
      tool: x.row.tool,
      label: x.row.profile_label ?? "default",
      rootPath: x.row.root_path,
      enabled: x.row.enabled === 1,
      sessions7d: x.sessions7d,
      lastActivityAt: x.lastActivityAt,
      readable: x.readable,
      reason: x.reason,
      manual: extra.has(x.row.root_path),
    };
  }

  /** GET /api/onboarding/detect（M6-19） */
  async detect(): Promise<DetectResponse> {
    const sup = this.#d.supervisor();
    const list = sup ? await sup.detectSummary() : [];
    const extra = new Set(readExtraRoots(this.#d.mutate));
    const sources = list.map((x) => this.#view(x, extra));
    const home = this.#d.home;
    // Claude Desktop の Code タブのセッションは既定の設定ディレクトリ（~/.claude）に残る
    const present = existsSync(`${home}/Library/Application Support/Claude`);
    const via = sources.find((s) => s.tool === "claude_code" && s.rootPath === `${home}/.claude`);
    return {
      sources,
      claudeDesktop: { present, viaSourceId: present ? (via?.id ?? null) : null },
      home,
      now: this.#d.clock.now(),
    };
  }

  /**
   * POST /api/onboarding/sources（Choose a folder…）: Claude Code の設定ディレクトリを手で足す。
   * projects/ があるディレクトリだけを受け付ける
   */
  async addSource(path: unknown): Promise<DetectedSourceView> {
    // 画面の入力は ~/ で始めてよい（表示も ~ で出す）
    const p = cleanAbsPath(
      typeof path === "string" && path.startsWith("~/") ? `${this.#d.home}${path.slice(1)}` : path,
    );
    if (!p) throw new OpError(400, "invalid_path");
    let ok = false;
    try {
      ok = statSync(`${p}/projects`).isDirectory();
    } catch {}
    if (!ok) throw new OpError(400, "not_a_claude_config_dir");
    const sup = this.#d.supervisor();
    if (!sup) throw new OpError(409, "ingest_unavailable");
    const roots = readExtraRoots(this.#d.mutate);
    if (!roots.includes(p)) {
      if (roots.length >= MAX_EXTRA_ROOTS) throw new OpError(400, "too_many_folders");
      putSetting(this.#d.mutate, EXTRA_ROOTS_KEY, [...roots, p]);
    }
    const list = await sup.detectSummary();
    const hit = list.find((x) => x.row.tool === "claude_code" && x.row.root_path === p);
    if (!hit) throw new OpError(400, "not_a_claude_config_dir");
    // ~/.claude 以外で名前が付けられないもの（default）はディレクトリ名を名前にする
    if (hit.row.profile_label === "default" && p !== `${this.#d.home}/.claude`) {
      const label = basename(p).slice(0, 40);
      this.#d.sqlite.run("UPDATE ai_source SET profile_label = ?, updated_at = ? WHERE id = ?", [
        label,
        this.#d.clock.now(),
        hit.row.id,
      ]);
      hit.row.profile_label = label;
    }
    this.#d.hub.publish("source", {});
    // 同意の後に足したものは、そのまま取り込みを始める
    if (this.consented()) void sup.reconcile();
    return this.#view(hit, new Set([...roots, p]));
  }

  /**
   * POST /api/onboarding/consent: 同意を記録し、チェックした元だけを有効にして取り込みを始める。
   * 空の一覧でもよい（取り込み元が0件の「Continue」。D-181: 見つかった元を後から読む）。
   * spool（Turnlane 自身のディレクトリ）は常に有効
   */
  async consent(enabledSourceIds: readonly string[]): Promise<OnboardingView> {
    const sup = this.#d.supervisor();
    if (!sup) throw new OpError(409, "ingest_unavailable");
    const rows = sup.sources().filter((r) => !isInternalSource(r.tool));
    const known = new Set(rows.map((r) => r.id));
    const unknown = enabledSourceIds.filter((id) => !known.has(id));
    if (unknown.length > 0) throw new OpError(400, "unknown_source");
    const on = new Set(enabledSourceIds);
    const now = this.#d.clock.now();
    for (const r of rows) {
      const v = on.has(r.id) ? 1 : 0;
      if (r.enabled !== v)
        this.#d.sqlite.run("UPDATE ai_source SET enabled = ?, updated_at = ? WHERE id = ?", [
          v,
          now,
          r.id,
        ]);
    }
    const first = !this.consented();
    if (first) this.#memo = emptyProgressMemo();
    // 取り込むのは直近7日だけ（D-181）。範囲は最初の同意のときに決め、後から広げない
    this.#save(applyOnboardingConsent(this.#state, now, sup.recentSince()));
    this.#d.hub.publish("source", {});
    await sup.detect();
    if (sup.begun) void sup.reconcile();
    else await sup.beginIngest();
    this.onProgress();
    return this.view();
  }

  /** 進捗（GET /api/onboarding/progress と SSE import_progress） */
  progress(): ImportProgress {
    const sup = this.#d.supervisor();
    const s = readSettings(this.#d.mutate.db);
    const now = this.#d.clock.now();
    const sourceIds = sup
      ? sup
          .sources()
          .filter((r) => !isInternalSource(r.tool) && r.enabled === 1)
          .map((r) => r.id)
      : [];
    return computeProgress(
      {
        today: toLocalDate(now, s.tz, s.dayBoundary),
        tz: s.tz,
        dayBoundary: s.dayBoundary,
        begun: (sup?.begun ?? false) && this.consented(),
        pending: sup?.pendingMtimes() ?? null,
        sourceIds,
        skipped: sup?.skippedBySource() ?? new Map(),
      },
      this.#memo,
      now,
    );
  }

  /** Supervisor がキューを進めたとき。日の状態が変わったときだけ SSE を送る */
  onProgress(): void {
    // 流れが済んで7日分も終わっていれば、もう知らせる相手はいない（常用中のジョブごとの計算を省く）
    if (this.#state.state === "done" && this.#memo.doneAt !== null) return;
    let p: ImportProgress;
    try {
      p = this.progress();
    } catch (e) {
      this.#d.logger.warn("onboarding.progress_failed", errorFields(e));
      return;
    }
    // 7日分が終わったら、要約の数字が揃うように判定を1回回してから知らせる（非同期。HTTP を止めない）
    const runner = p.doneAt !== null && !this.#derivedAfterImport ? this.#d.runner() : null;
    if (p.doneAt !== null) this.#derivedAfterImport = true;
    if (runner) {
      void runner
        .runNow()
        .catch((e) => this.#d.logger.warn("onboarding.derive_failed", errorFields(e)))
        .then(() => {
          // 判定を待つ間に進んだ分も含めて知らせる
          try {
            this.#publishProgress(this.progress());
          } catch (e) {
            this.#d.logger.warn("onboarding.progress_failed", errorFields(e));
          }
        });
      return;
    }
    this.#publishProgress(p);
  }

  #publishProgress(p: ImportProgress): void {
    const key = progressKey(p);
    if (key === this.#lastKey) return;
    this.#lastKey = key;
    this.#d.hub.publish("import_progress", p as unknown as Record<string, unknown>);
  }

  #cli(): string {
    return this.#d.cliPath ?? join(this.#d.home, ".local", "bin", "turnlane");
  }

  /** hooks・MCP の対象（同意の前は 409）。spool と Claude Desktop は対象外 */
  #configSources(): ConfigSource[] {
    if (!this.consented()) throw new OpError(409, "consent_required");
    const sup = this.#d.supervisor();
    if (!sup) throw new OpError(409, "ingest_unavailable");
    return sup
      .sources()
      .filter((r) => r.enabled === 1 && (r.tool === "claude_code" || r.tool === "codex"))
      .map((r) => ({ id: r.id, tool: r.tool as "claude_code" | "codex", rootPath: r.root_path }));
  }

  /**
   * POST /api/onboarding/hooks { dryRun }（O5。turnlane hooks install と同じ関数）: 同意した取り込み元の設定ディレクトリ
   * ごとに Turnlane の項目だけを末尾に足す（退避あり。CLAUDE.md 6）。段は進めない（画面が Continue で進める）。
   * 書いた後は取り込みの検出を回して hooks_state を読み直す
   */
  async installHooks(dryRun: boolean): Promise<HooksInstallResponse> {
    const sources = this.#configSources();
    const cli = this.#cli();
    const suffix = `.bak-turnlane-${backupStamp(this.#d.clock.now())}`;
    const targets: HooksInstallTarget[] = [];
    for (const s of sources) {
      const codex = s.tool === "codex";
      const file = join(s.rootPath, codex ? "hooks.json" : "settings.json");
      const plan = codex ? codexPlan(cli) : claudePlan(cli);
      const t: HooksInstallTarget = {
        sourceId: s.id,
        tool: s.tool,
        file,
        added: [],
        updated: [],
        unchanged: [],
        changed: false,
        backup: null,
        error: null,
        disabled: [],
        needsApproval: false,
      };
      targets.push(t);
      let f: ReturnType<typeof loadJson>;
      try {
        f = loadJson(file);
      } catch {
        t.error = "unreadable";
        continue;
      }
      try {
        const { next, report } = installHooksIn(f.value, plan);
        t.added = report.added;
        t.updated = report.updated;
        t.unchanged = report.unchanged;
        const r = saveJson(f, next, { backupSuffix: suffix, dryRun });
        t.changed = r.changed;
        t.backup = r.backup ?? null;
        if (codex) {
          let toml = "";
          try {
            toml = readFileSync(join(s.rootPath, "config.toml"), "utf8");
          } catch {}
          const ins = codexInspect(toml, f.path, next);
          if (ins.featureDisabled) t.disabled.push("config.toml: hooks = false");
          t.needsApproval =
            report.added.length > 0 ||
            report.updated.length > 0 ||
            Object.values(ins.trustEntries).some((ok) => !ok);
        } else {
          t.disabled = claudeHooksDisabled(next as Record<string, unknown>).reasons;
        }
      } catch (e) {
        t.error = /変更されました/.test((e as Error).message) ? "changed" : "write_failed";
        this.#d.logger.warn("onboarding.hooks_failed", errorFields(e));
      }
    }
    const failed = targets.filter((t) => t.error !== null).length;
    if (!dryRun && targets.some((t) => t.changed)) {
      this.#d.logger.info("onboarding.hooks_installed", {
        targets: targets.length,
        changed: targets.filter((t) => t.changed).length,
        failed,
      });
      // hooks_state を読み直す（取り込みの検出の一部）
      void this.#d
        .supervisor()
        ?.reconcile()
        .catch((e) => this.#d.logger.warn("onboarding.reconcile_failed", errorFields(e)));
      this.#d.hub.publish("source", {});
    }
    return { dryRun, cli, targets, failed };
  }

  /**
   * POST /api/onboarding/mcp { dryRun }（O5a。turnlane mcp install と同じ関数。D-145）: 同意した取り込み元に
   * `turnlane` の MCP サーバを登録する。段は進めない（画面が Continue で進める）
   */
  installMcp(dryRun: boolean): McpInstallResponse {
    const sources = this.#configSources();
    const cli = this.#cli();
    const suffix = `.bak-turnlane-${backupStamp(this.#d.clock.now())}`;
    const targets: McpInstallTarget[] = [];
    for (const s of sources) {
      const target = mcpTargetFor(s.tool, s.rootPath, this.#d.home);
      const t: McpInstallTarget = {
        sourceId: s.id,
        tool: s.tool,
        file: target.file,
        action: "none",
        changed: false,
        backup: null,
        error: null,
      };
      targets.push(t);
      try {
        const p = planMcp(target, "install", cli);
        const r = applyMcp(p, { backupSuffix: suffix, dryRun });
        t.action = p.action === "removed" ? "none" : p.action;
        t.changed = p.changed;
        t.backup = r.backup ?? null;
      } catch (e) {
        t.error = e instanceof McpConfigError ? e.code : "unreadable";
        this.#d.logger.warn("onboarding.mcp_failed", errorFields(e));
      }
    }
    const failed = targets.filter((t) => t.error !== null).length;
    if (!dryRun && targets.some((t) => t.changed)) {
      this.#d.logger.info("onboarding.mcp_installed", {
        targets: targets.length,
        changed: targets.filter((t) => t.changed).length,
        failed,
      });
      this.#d.hub.publish("source", {});
    }
    return { dryRun, cli, targets, failed };
  }

  /**
   * POST /api/onboarding/calendar/connect（O4 の主ボタン）。すぐ失敗したもの（1.5 秒以内の例外）だけ failed と返し、
   * それより長いもの（OS のダイアログを待つ）は待たずに started（画面が /api/calendar/status で確かめる）。
   * 終わったら結果を覚え、画面が GET /api/onboarding/calendar/connect で読む（失敗の理由は stderr の要約。onboarding.md 4.4）
   */
  async connectCalendar(): Promise<CalendarConnectResponse> {
    const f = this.#d.calendarConnect;
    if (!f) return { started: false, reason: "unavailable" };
    this.#d.logger.info("onboarding.calendar_connect", {});
    const attempt: CalendarConnectAttempt = {
      id: (this.#calendarAttempt?.id ?? 0) + 1,
      state: "running",
      startedAt: this.#d.clock.now(),
      finishedAt: null,
      code: null,
      detail: null,
    };
    this.#calendarAttempt = attempt;
    const p = f();
    const settled = p.then(
      () => {
        attempt.state = "ok";
        attempt.code = 0;
        attempt.finishedAt = this.#d.clock.now();
        return false;
      },
      (e) => {
        this.#d.logger.warn("onboarding.calendar_connect_failed", errorFields(e));
        attempt.state = "failed";
        attempt.finishedAt = this.#d.clock.now();
        if (e instanceof CalendarConnectError) {
          attempt.code = e.exitCode;
          attempt.detail = e.detail;
        } else attempt.detail = e instanceof Error ? e.message.slice(0, 300) : null;
        return true;
      },
    );
    const failed = await Promise.race([settled, Bun.sleep(1500).then(() => false)]);
    return failed
      ? { started: false, reason: "failed", attempt: { ...attempt } }
      : { started: true, reason: null, attempt: { ...attempt } };
  }

  /** GET /api/onboarding/calendar/connect: 最後に始めたカレンダーの接続（無ければ null） */
  calendarAttempt(): CalendarConnectAttempt | null {
    return this.#calendarAttempt ? { ...this.#calendarAttempt } : null;
  }

  /** POST /api/onboarding/open-settings { pane }（O4 の拒否・O7）。開けなければ 409 */
  async openSettings(pane: "calendars" | "notifications"): Promise<{ opened: boolean }> {
    const f = this.#d.openSettings;
    if (!f) throw new OpError(409, "open_unavailable");
    return { opened: await f(pane) };
  }

  /**
   * GET /api/onboarding/board?days=7（O3 の日ごとの列）: 日ごとの AI の作業のラベル（新しい日が先頭）。
   * 今日へ持ち越した未完了のカードは、その日に動いた分だけを数えるので入れない。要約の件数はこのラベルの数（§5 の 18）
   */
  board(days = 7): OnboardingBoard {
    const s = readSettings(this.#d.mutate.db);
    const now = this.#d.clock.now();
    const to = toLocalDate(now, s.tz, s.dayBoundary);
    const from = addDays(to, -(days - 1));
    const v = aiDays(this.#d.sqlite, s, now, from, days);
    const span = this.#d.sqlite.query<
      { work_item_id: string; a: number; b: number | null },
      [string]
    >(
      "SELECT work_item_id, MIN(started_at) AS a, MAX(COALESCE(ended_at, started_at)) AS b FROM ai_turn WHERE local_date = ? AND work_item_id IS NOT NULL GROUP BY work_item_id",
    );
    return {
      from,
      to,
      days: v.days.map((d) => {
        const spans = new Map(span.all(d.date).map((r) => [r.work_item_id, r]));
        const items = d.items
          .filter((x) => x.carriedFrom === null && (x.aiMs > 0 || x.turns > 0))
          .sort((a, b) => b.aiMs - a.aiMs)
          .map((x) => {
            const sp = spans.get(x.id);
            return {
              id: x.id,
              title: x.title,
              status: x.status,
              repoRoot: x.repoRoot,
              scratch: x.scratch,
              branch: x.branch,
              prRef: x.prRef,
              aiMs: x.aiMs,
              startAt: sp?.a ?? null,
              endAt: sp?.b ?? null,
            };
          });
        return { date: d.date, aiMs: items.reduce((n, x) => n + x.aiMs, 0), items };
      }),
    };
  }

  /**
   * GET /api/onboarding/summary?days=7（O3 の1行）: AI の稼働時間、AI の作業の数（O3 の列のラベルと同じ数え方）、
   * AI が人を待った回数。Idle・放置など在席とカレンダーで変わる値は出さない
   */
  summary(days = 7): OnboardingSummary {
    const b = this.board(days);
    const s = readSettings(this.#d.mutate.db);
    const now = this.#d.clock.now();
    let aiMs = 0;
    let cards = 0;
    for (const d of b.days) {
      aiMs += d.aiMs;
      cards += d.items.length;
    }
    const runner = this.#d.runner();
    const waits = runner
      ? runner.waitsStartedBetween(dayStartMs(b.from, s.tz, s.dayBoundary), now + 1)
      : 0;
    const p = this.progress();
    const want = new Set(b.days.map((d) => d.date));
    const complete =
      days <= p.days.length
        ? p.days.filter((d) => want.has(d.date)).every((d) => d.state === "done")
        : (this.#d.supervisor()?.backfillDone ?? false);
    return { from: b.from, to: b.to, days, aiMs, cards, waits, complete };
  }
}
