import { mkdirSync, statSync } from "node:fs";
import { errorFields, type MetaOnlyLogger, meta, type SourceAdapter } from "@turnlane/collectors";
import {
  addDays,
  type Clock,
  createDb,
  DEFAULT_DAY_BOUNDARY,
  ensureSelfDevice,
  ensureToken,
  getSetting,
  HlcClock,
  MigrationError,
  type MutateCtx,
  maxChangeLogHlc,
  migrate,
  migrations,
  openDatabase,
  parseDayBoundary,
  putSetting,
  readSettings,
  readUserVersion,
  SCHEMA_VERSION,
  systemClock,
  systemTimeZone,
  type TurnlanePaths,
  toLocalDate,
  updateBuildOff,
  updateChannel,
  VERSION,
} from "@turnlane/core";
import { updateMenuItem } from "@turnlane/core/web";
import { type AiSystem, createAiSystem } from "./ai.ts";
import { type BridgeSocket, HelperBridge } from "./calendar/bridge.ts";
import { type CalendarSystem, createCalendar } from "./calendar/index.ts";
import type { CalendarProvider } from "./calendar/provider.ts";
import { cleanStoredSubjects } from "./derive/stored-subject.ts";
import { createExtDeps } from "./ext/deps.ts";
import { ExtRuntime, extConfigSchemas, loadExtensions, migrateExtensions } from "./ext/host.ts";
import { KeepAwake, NO_POWER_STATE, type PowerSystem } from "./ext/power.ts";
import type { DaemonExtensionFactory } from "./ext/types.ts";
import { FocusService } from "./focus/service.ts";
import type { GhClient } from "./github/pr-poller.ts";
import type { HealthReport } from "./health.ts";
import { createApp } from "./http/app.ts";
import type { DesktopStatusStore } from "./http/desktop-routes.ts";
import { EK_PATH, ekUpgradeCheck } from "./http/internal-ek.ts";
import { SseHub } from "./http/sse.ts";
import type { StaticAssets } from "./http/static.ts";
import { type GitProbe, SystemGit } from "./ingest/git.ts";
import type { Supervisor } from "./ingest/supervisor.ts";
import { type InstallOptions, InstallService } from "./install/index.ts";
import { BackupJob } from "./jobs/backup.ts";
import { LaunchService } from "./launch/service.ts";
import { type LaunchSystem, SystemLaunch } from "./launch/system.ts";
import { ClaudeLimitsStore } from "./limits/claude.ts";
import { NotifyHolds, NotifyRunner, notifyLocale } from "./notify/runner.ts";
import { ensureOnboarding, OnboardingService, readExtraRoots } from "./onboarding/service.ts";
import { AppFinder, selectedApp } from "./open/apps.ts";
import { type OpenSystem, systemOpen } from "./open/system.ts";
import { createPlanner } from "./planner/index.ts";
import { focusSettings, readUiPrefs } from "./planner/ui-prefs.ts";
import type { PresenceReader } from "./presence/reader.ts";
import { PresenceService } from "./presence/service.ts";
import type { DetectOptions } from "./summary/cli.ts";
import { AutoUpdater, type AutoUpdaterOptions } from "./update/auto.ts";
import {
  readUpdateState,
  UPDATE_STATE_KEY,
  UpdateChecker,
  type UpdateCheckerOptions,
} from "./update/checker.ts";

/**
 * turnlaned の起動（phase0-plan 1.3）: DB open → migrate → (collectors, M1) → jobs → http
 */
export interface StartOptions {
  paths: TurnlanePaths;
  logger: MetaOnlyLogger;
  assets?: StaticAssets | undefined;
  clock?: Clock;
  /** テスト用。0 なら空いているポートを使う */
  port?: number;
  backupIntervalMs?: number;
  /**
   * 取り込み（M1）。vars は検出に使う環境変数（CLAUDE_CONFIG_DIR / CODEX_HOME）。省略時は空で、
   * paths.home の下だけを検出する（テストが実行環境の設定ディレクトリを読まないように）。
   * bin.ts は process.env を渡す。false なら取り込みを動かさない
   */
  ingest?:
    | false
    | {
        vars?: Record<string, string | undefined>;
        adapters?: readonly SourceAdapter[];
        git?: GitProbe;
        gh?: GhClient | null;
        noWatch?: boolean;
        /** タスクから開く（D-059）が OS に触れるところ。dev:board の --scratch は偽物を渡す */
        openSystem?: OpenSystem;
      };
  /**
   * カレンダー（M3）。省略時はヘルパ（TurnlaneCalendarHelper.app）の WebSocket 接続を待つ。
   * テストと dev:board は FakeCalendarProvider を渡す。false ならカレンダーを動かさない
   */
  calendar?:
    | false
    | {
        provider?: CalendarProvider;
        /**
         * カレンダーの接続（オンボーディング O4 の主ボタン）: ヘルパを常駐させて許可のダイアログを出す。bin.ts は同梱の
         * turnlane（calendar install → authorize）を起動する。省略時は画面に「この起動では接続できない」と出る
         */
        connect?: () => Promise<void>;
      };
  /**
   * 日報の AI 要約（M4-6）。CLI の検出の仕方（テストと dev:board はログインシェルを使わず、偽の CLI の場所を渡す）。
   * false なら要約を作らない
   */
  summary?: false | { detect?: Partial<DetectOptions>; killGraceMs?: number };
  /**
   * 在席の記録（D-105、ADR 0013）。省略時は動かさない（テストが実行環境の入力の状態を読まないように）。
   * bin.ts は SystemPresenceReader を渡す。dev:board は presence_span に区間を直接入れる
   */
  presence?: false | { reader: PresenceReader; intervalMs?: number };
  /**
   * タスクから AI に頼む（D-107）。省略時は動かさない（テストが端末・git・CLI に触れないように）。
   * bin.ts は turnlane の絶対パスを渡す。dev:board と E2E は偽の git・CLI・端末を渡す
   */
  launch?:
    | false
    | {
        cliPath: string;
        sys?: LaunchSystem;
        open?: OpenSystem;
        intervalMs?: number;
        /** 完了のときの片付けで AI の終わりを待つ長さ（ms。dev-board・E2E で短くする） */
        finishWaitMs?: number;
      };
  /**
   * 組み込む拡張（ADR 0015）。単一バイナリでは scripts/build.ts が作る .build/extensions.gen.ts の一覧
   * （公開のビルドでは空）。省略時は拡張なし
   */
  extensions?: readonly DaemonExtensionFactory[];
  /** スリープさせない（ExtDeps.power）。省略時は何もしない（テストが caffeinate を起こさないように）。bin.ts は本物を渡す */
  power?: PowerSystem;
  /**
   * オンボーディング（onboarding.md 5.1・5.2、M6-18）。assumeDone は、設定 onboarding の無い新しい DB を
   * 同意済み・済み（done）として始める（テスト・dev-board・E2E）。省略時は、カーソルの無い新しい DB は同意を待つ
   */
  onboarding?: { assumeDone?: boolean };
  /**
   * 更新確認（M6-12）。feedUrl は確認先（省略時はビルドの値と TURNLANE_UPDATE_FEED_URL。テストが外に出ないように、
   * startDaemon の省略時は確認しない）。bin.ts は resolveUpdateFeed(process.env) を渡す
   */
  update?: {
    feedUrl: string | null;
    /** 確認先を TURNLANE_UPDATE_FEED_URL（ループバック）に差し替えたか。差し替えたときは拡張・配置の条件を見ない（スモーク） */
    feedOverridden?: boolean;
    fetch?: UpdateCheckerOptions["fetch"];
    firstDelayMs?: number;
    /** 自動更新の取得・検証・置き換え・アプリの確かめの差し替え（テスト）。省略時は本物 */
    auto?: Partial<
      Pick<AutoUpdaterOptions, "download" | "verify" | "install" | "appRunning" | "idleGraceMs">
    > & { afterInstallMs?: number };
  };
  /**
   * システム設定の画面を開く（オンボーディング O4 の拒否・O7。`x-apple.systempreferences:` の URL）。省略時は開けない
   * （テスト・開発が実行環境の設定を開かないように）。bin.ts は /usr/bin/open を渡す
   */
  openSettings?: (pane: "calendars" | "notifications") => Promise<boolean>;
  /**
   * 配置の方式（M6-15・M6-17）。省略時は dev（install.json を書かない。テストが実行環境に書かないように）。
   * bin.ts は自分の場所から決めて渡す（app なら hooks・MCP に固定の場所を書き、バンドルの版を監視する）
   */
  install?: InstallOptions & {
    pathVar?: string | undefined;
    homebrewCandidates?: readonly string[];
    readBuild?: (appPath: string) => string | null;
    exit?: () => void;
    /** 更新の後にアプリを背景で起こす（M6-17）。省略時は起こさない。bin.ts は openDesktopInBackground を渡す */
    openDesktop?: () => Promise<boolean>;
  };
}

export interface RunningDaemon {
  port: number;
  url: string;
  token: string;
  mutateCtx: MutateCtx;
  supervisor: Supervisor | null;
  ai: AiSystem | null;
  calendar: CalendarSystem | null;
  focus: FocusService;
  launch: LaunchService | null;
  onboarding: OnboardingService;
  update: UpdateChecker;
  autoUpdate: AutoUpdater;
  install: InstallService | null;
  stop(): Promise<void>;
}

export async function startDaemon(opts: StartOptions): Promise<RunningDaemon> {
  const { paths, logger } = opts;
  const clock = opts.clock ?? systemClock;
  const startedAt = clock.now();
  // DB・WAL・バックアップ・spool を他ユーザーから読めないようにする
  process.umask(0o077);
  mkdirSync(paths.dataDir, { recursive: true, mode: 0o700 });
  // turnlane hook が書く spool（Turnlane 自身のディレクトリ）。先に作っておくと起動直後から監視できる
  mkdirSync(paths.spoolDir, { recursive: true, mode: 0o700 });

  const token = ensureToken(paths.tokenPath);
  const sqlite = openDatabase(paths.dbPath);
  try {
    const r = migrate(sqlite, migrations, { backupDir: paths.backupDir, now: () => clock.now() });
    if (r.applied.length > 0) {
      logger.info("db.migrated", {
        applied: r.applied.map((id) => meta(id)),
        user_version: r.userVersion,
        backup: r.backupPath ? meta(r.backupPath) : null,
      });
    }
  } catch (e) {
    logger.error("db.migrate_failed", {
      ...errorFields(e, { includeMessage: true }),
      migration: e instanceof MigrationError && e.migrationId ? meta(e.migrationId) : null,
    });
    sqlite.close();
    throw e;
  }
  // 配置の方式（M6-15）: app なら hooks・MCP に固定の場所（アプリの中の turnlane へのリンク）を書く
  const install = opts.install
    ? new InstallService({
        ...opts.install,
        dataDir: paths.dataDir,
        home: paths.home,
        version: VERSION,
        logger,
        now: () => clock.now(),
        pathVar: opts.install.pathVar,
        // ヘルパの版の入れ替え（M6-17）。calendar は下で作る（呼ばれるのは start の後）
        helperVersion: () => {
          const st = calendar?.service.status();
          return st?.connected ? st.helperVersion : null;
        },
        // 更新の後の起こし直し（M6-17）。hub は下で作る（呼ばれるのはバンドルの監視の中）
        desktopSeenWithin: (ms) => hub.desktopSeenWithin(ms),
        // 前の版のバンドル（.Turnlane.app.old）を消す合図: 新しい版のアプリがつながった
        desktopConnected: () => hub.desktopClients > 0,
      })
    : null;
  const hooksCli = install?.hooksCli ?? (opts.launch ? opts.launch.cliPath : null);
  // 拡張（ADR 0015）: 本体のマイグレーションの後に、拡張ごとの分を適用する
  const exts = loadExtensions(opts.extensions ?? [], logger);
  try {
    migrateExtensions(sqlite, exts, {
      backupDir: paths.backupDir,
      now: () => clock.now(),
      logger,
    });
  } catch (e) {
    logger.error("db.ext_migrate_failed", errorFields(e, { includeMessage: true }));
    sqlite.close();
    throw e;
  }
  const extConfig = extConfigSchemas(exts);
  const db = createDb(sqlite);
  const deviceId = ensureSelfDevice(db, clock);
  // mutate 層の文脈（M1 以降のルート・取り込み・ジョブが使う）。HLC は change_log の最大値から復元する
  const mutateCtx: MutateCtx = {
    db,
    clock,
    deviceId,
    hlc: new HlcClock(deviceId, clock, maxChangeLogHlc(db)),
  };

  // 保存した件名（自分の指示の 1 行目・自動のタスクの作成時の件名）の相づち・貼り付けの印を直す（起動時に 1 度。冪等。
  // ai-session-ingestion 4.4）。会話本文は読まない
  try {
    const n = cleanStoredSubjects(sqlite, mutateCtx);
    if (n.instructions + n.tasks > 0) logger.info("db.subjects_cleaned", n);
  } catch (e) {
    logger.error("db.subjects_clean_failed", errorFields(e));
  }

  const settingsNow = () => readSettings(db);
  const todayNow = () => {
    const st = settingsNow();
    return toLocalDate(clock.now(), st.tz, st.dayBoundary);
  };
  // 表示の「今日」は暦日（D-054）
  const displayTodayNow = () => toLocalDate(clock.now(), settingsNow().tz, 0);
  const hub = new SseHub({
    today: todayNow,
    displayToday: displayTodayNow,
    now: () => clock.now(),
  });
  const dayBoundarySetting = getSetting<string>(db, "day_boundary");
  const backupJob = new BackupJob({
    db: sqlite,
    dir: paths.backupDir,
    clock,
    tz: systemTimeZone(),
    boundary: dayBoundarySetting ? parseDayBoundary(dayBoundarySetting) : DEFAULT_DAY_BOUNDARY,
    logger,
    onCreated: (info) => hub.publish("backup", { date: info.date }),
  });
  const ingestOpts = opts.ingest === false ? null : (opts.ingest ?? {});
  const calendarOpts = opts.calendar === false ? null : (opts.calendar ?? {});
  // オンボーディング（M6-18）: 既存の DB は同意済みにする移行。取り込みのゲートと通知の停止に使う
  let onboarding: OnboardingService | null = null;
  const onboardingInitial = ensureOnboarding(sqlite, mutateCtx, {
    assumeDone: opts.onboarding?.assumeDone === true,
  });
  let notifierRef: NotifyRunner | null = null;
  // Claude の利用枠（statusLine の受け口が送る値と、取り込みが読む `.claude.json` のキャッシュ。アカウントごとの最新）
  const claudeLimits = new ClaudeLimitsStore(sqlite, clock);
  const ai = ingestOpts
    ? createAiSystem({
        sqlite,
        limits: claudeLimits,
        mutate: mutateCtx,
        clock,
        logger,
        hub,
        git: ingestOpts.git ?? new SystemGit(),
        home: paths.home,
        dataDir: paths.dataDir,
        vars: ingestOpts.vars ?? {},
        ...(ingestOpts.adapters ? { adapters: ingestOpts.adapters } : {}),
        // gh は bin.ts が渡したときだけ使う（テストが実行環境の gh を呼ばないように）
        gh: ingestOpts.gh ?? null,
        ...(ingestOpts.openSystem ? { openSystem: ingestOpts.openSystem } : {}),
        ...(ingestOpts.noWatch ? { noWatch: true } : {}),
        // 日報の AI 要約の実行を AI の作業として取り込まない（M4-6）
        excludeDirs: [paths.summarizeDir],
        consented: () => onboarding?.consented() ?? onboardingInitial.consentedAt !== null,
        importSince: () => (onboarding?.state() ?? onboardingInitial).importSince,
        extraRoots: () => readExtraRoots(mutateCtx),
        onProgress: () => onboarding?.onProgress(),
        onBulkDone: () => notifierRef?.prime(),
        // MCP の登録が指しているべき turnlane（D-145）。bin.ts は turnlaned と同じ場所の turnlane を渡す
        mcpCli: hooksCli,
      })
    : null;
  const supervisor = ai?.supervisor ?? null;
  onboarding = new OnboardingService(
    {
      sqlite,
      mutate: mutateCtx,
      clock,
      hub,
      logger,
      home: paths.home,
      supervisor: () => supervisor,
      runner: () => ai?.runner ?? null,
      cliPath: hooksCli,
      calendarConnect: calendarOpts?.connect ?? null,
      // システム設定の画面（O4 の拒否・O7）。open の手段が無ければ開けない
      openSettings: opts.openSettings ?? null,
    },
    onboardingInitial,
  );
  // 自動更新（ADR 0008 の追記 4）: 配布版（mode が app）で update.check と update.download がオンのとき、確認の後に
  // 同じ GitHub Releases から取得・検証し、Restart to update かアプリが動いていない間に入れる
  const updateFeed = opts.update?.feedUrl ?? null;
  const readUpdate = () => readUpdateState(getSetting<unknown>(db, UPDATE_STATE_KEY));
  const autoOpts = opts.update?.auto ?? {};
  const autoUpdater = new AutoUpdater({
    dataDir: paths.dataDir,
    version: VERSION,
    clock,
    logger,
    enabled: () =>
      getSetting<unknown>(db, "update.check") !== false &&
      getSetting<unknown>(db, "update.download") !== false,
    appPath: () => (install?.mode === "app" ? install.appPath : null),
    latest: () => readUpdate()?.latest ?? null,
    load: () => readUpdate()?.download ?? null,
    save: (d) =>
      putSetting(mutateCtx, UPDATE_STATE_KEY, {
        ...(readUpdate() ?? { checkedAt: 0, latest: null, error: null }),
        download: d,
      }),
    publish: (data) => hub.publish("update", data),
    loopbackOrigin:
      opts.update?.feedOverridden === true && updateFeed ? new URL(updateFeed).origin : null,
    desktopConnected: () => hub.desktopClients > 0,
    afterInstall: (reason) =>
      install?.bundleReplaced({
        relaunchDesktop: reason === "user",
        ...(autoOpts.afterInstallMs !== undefined ? { afterMs: autoOpts.afterInstallMs } : {}),
      }),
    ...(autoOpts.download ? { download: autoOpts.download } : {}),
    ...(autoOpts.verify ? { verify: autoOpts.verify } : {}),
    ...(autoOpts.install ? { install: autoOpts.install } : {}),
    ...(autoOpts.appRunning ? { appRunning: autoOpts.appRunning } : {}),
    ...(autoOpts.idleGraceMs !== undefined ? { idleGraceMs: autoOpts.idleGraceMs } : {}),
  });
  const desktopGoneUnsub = hub.onDesktopGone(() => autoUpdater.onDesktopGone());
  // 更新確認（M6-12）。確認先が無い（テスト）なら何もしない。拡張を組み込んだビルドと開発時の配置では確認しない
  const updater = new UpdateChecker({
    feedUrl: updateFeed,
    version: VERSION,
    clock,
    logger,
    enabled: () => getSetting<unknown>(db, "update.check") !== false,
    load: readUpdate,
    save: (s) => putSetting(mutateCtx, UPDATE_STATE_KEY, s),
    onChecked: () => autoUpdater.onChecked(),
    downloadEnabled: () => getSetting<unknown>(db, "update.download") !== false,
    download: () => autoUpdater.status(),
    install: () => autoUpdater.install("user"),
    publish: () => hub.publish("update", {}),
    ...(opts.update?.fetch ? { fetch: opts.update.fetch } : {}),
    ...(opts.update?.firstDelayMs !== undefined ? { firstDelayMs: opts.update.firstDelayMs } : {}),
    channel: () => (install ? updateChannel(install.mode) : "dev"),
    buildOff: updateBuildOff({
      // 組み込んだ数（版が合わずに読み飛ばした拡張も、拡張を組み込んだビルドとして扱う）
      extensions: (opts.extensions ?? []).length,
      mode: install?.mode ?? null,
      feedOverridden: opts.update?.feedOverridden === true,
    }),
  });
  const sqliteVersion =
    sqlite.query<{ v: string }, []>("SELECT sqlite_version() AS v").get()?.v ?? "";

  let port = opts.port ?? paths.port;
  const health = (): HealthReport => ({
    ok: true,
    version: VERSION,
    pid: process.pid,
    startedAt,
    uptimeMs: clock.now() - startedAt,
    port,
    db: {
      userVersion: readUserVersion(sqlite),
      schemaVersion: SCHEMA_VERSION,
      journalMode:
        sqlite.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode ?? "",
      sqliteVersion,
      sizeBytes: statSync(paths.dbPath).size,
    },
    backup: backupJob.status(),
    sources: sqlite
      .query<{ tool: string; profile_label: string | null; health_level: string }, []>(
        "SELECT tool, profile_label, health_level FROM ai_source WHERE enabled = 1 ORDER BY tool, root_path",
      )
      .all()
      .map((r) => ({ tool: r.tool, label: r.profile_label ?? "", healthLevel: r.health_level })),
    calendarHelper: (() => {
      const st = calendar?.service.status();
      return st
        ? {
            connected: st.connected,
            authorization: st.authorization,
            version: st.helperVersion,
            lastSyncedAt: st.lastSyncedAt,
            problem: st.problem,
          }
        : { connected: false };
    })(),
    sseClients: hub.size,
    extensions: exts.map((e) => e.id),
  });

  const admin = { backup: () => backupJob.runNow() };
  // カレンダー（M3）。ヘルパが未接続でも他の機能は動く（予定が空で「カレンダー未接続」と出る）
  const bridge = calendarOpts && !calendarOpts.provider ? new HelperBridge() : null;
  const calendar = calendarOpts
    ? createCalendar({
        sqlite,
        mutate: mutateCtx,
        clock,
        hub,
        logger,
        provider: calendarOpts.provider ?? (bridge as HelperBridge),
        onChanged: () => ai?.runner.schedule(0),
        extConfig,
        home: paths.home,
      })
    : null;
  // スヌーズの「明日朝」と閉店モードの明けは、祝日を除いた次の稼働日で決める（D-052）
  if (calendar && ai) ai.setWorkdays(() => calendar.deps.workdays().rule);
  // ボード系（M2）。タスクの操作は取り込みが止まっていても使える
  const planner = createPlanner({
    sqlite,
    mutate: mutateCtx,
    clock,
    hub,
    ai,
    ...(calendar ? { workdays: calendar.deps.workdays } : {}),
    // 時間ブロックの書き戻し（M3-3）。束ねて流す
    ...(opts.summary === false
      ? {}
      : {
          summary: {
            workDir: paths.summarizeDir,
            logger,
            detect: { home: paths.home, ...(opts.summary?.detect ?? {}) },
            ...(opts.summary?.killGraceMs !== undefined
              ? { killGraceMs: opts.summary.killGraceMs }
              : {}),
          },
        }),
  });
  // タスクから AI に頼む（D-107）: 依頼・turnlane ai run の受け取り・セッションとの紐づけ・確認支援・worktree の片付け
  const launch = opts.launch
    ? (() => {
        const openSys = opts.launch.open ?? systemOpen;
        const finder = new AppFinder(openSys, paths.home);
        const svc = new LaunchService({
          sqlite,
          mutate: mutateCtx,
          clock,
          sys: opts.launch.sys ?? new SystemLaunch({ home: paths.home }),
          open: openSys,
          cliPath: opts.launch.cliPath,
          home: paths.home,
          terminal: () => {
            let v: unknown;
            try {
              v = getSetting(db, "open.terminal");
            } catch {}
            return finder.resolve("terminal", selectedApp("terminal", v));
          },
          locale: () => (readUiPrefs(db).language === "ja" ? "ja" : "en"),
          logger,
          onChanged: () => ai?.runner.schedule(0),
          publish: (type, data) => hub.publish(type, data),
          ...(opts.launch.intervalMs !== undefined ? { intervalMs: opts.launch.intervalMs } : {}),
          ...(opts.launch.finishWaitMs !== undefined
            ? { finishWaitMs: opts.launch.finishWaitMs }
            : {}),
          // 完了のときの片付け: ダイアログで待っている AI に終了の指示を送らない（runner の待ちの判定）
          sessionWait: (id) => ai?.runner.sessionWait(id) ?? null,
          orcaApp: () => finder.installed("terminal").find((a) => a.id === "orca") ?? null,
        });
        planner.tasks.onCompleted = (id) => void svc.onTaskCompleted(id);
        return svc;
      })()
    : null;
  // 離れていた間のまとめ・終わった件の行の PR の変更の量と CI は、確認支援と同じ控えから読む（D-214 (2)）
  if (launch && ai)
    ai.setPrChange(
      (ref) => launch.prChange(ref),
      (ref) => launch.prChangeCached(ref),
    );
  // AI の画面の「片付けが残っている」（GET /api/ai/live）
  if (launch && ai) ai.setLiveLaunches(() => launch.liveLaunches());
  // 在席（D-105）: 30秒ごとに最後の入力からの経過を読み、presence_span に区間を残す。Mac に戻ってきたら判定を走らせる
  const presence = opts.presence
    ? new PresenceService({
        sqlite,
        mutate: mutateCtx,
        clock,
        logger,
        reader: opts.presence.reader,
        ...(opts.presence.intervalMs !== undefined ? { intervalMs: opts.presence.intervalMs } : {}),
        onResumed: () => ai?.runner.schedule(0),
      })
    : null;
  // turnlane add がデーモン停止中に書いた spool を取り込む（起動時と1分ごと）
  const ingestCli = () => {
    try {
      const n = planner.tasks.ingestCliSpool(paths.spoolDir);
      if (n > 0) logger.info("cli_spool.ingested", { tasks: n });
    } catch (e) {
      logger.warn("cli_spool.failed", errorFields(e));
    }
  };
  ingestCli();
  const cliTimer = setInterval(ingestCli, 60_000);
  // 日付区切り（M4-4）: 前の日の日報を確定し、UI に知らせる（UI は全キャッシュを無効化し、
  // 週ボードの範囲を付け替える）。判定（24時間・72時間の期限など）も起こす。起動時は昨日の分を確かめる
  const finalize = (date: string) => {
    try {
      if (planner.dailyNote.finalizeDay(date)) logger.info("day.finalized", { date: meta(date) });
    } catch (e) {
      logger.warn("day.finalize_failed", errorFields(e));
    }
  };
  // 暦の日付が変わったときも知らせ、UI が今日の列を付け替える（D-054）
  let lastToday = todayNow();
  let lastDisplay = displayTodayNow();
  finalize(addDays(lastToday, -1));
  const dayTimer = setInterval(() => {
    const t = todayNow();
    const disp = displayTodayNow();
    if (t !== lastToday) {
      const prev = lastToday;
      lastToday = t;
      lastDisplay = disp;
      finalize(prev);
      ai?.runner.schedule();
      hub.publish("day_boundary", { today: t, displayToday: disp });
    } else if (disp !== lastDisplay) {
      lastDisplay = disp;
      hub.publish("day_boundary", { today: t, displayToday: disp });
    }
  }, 30_000);
  // 集中モード（D-097。m2-api 25章）: 30秒ごとと、予定・設定・デスクトップアプリの状態の変化の後に進める
  const desktopStore: DesktopStatusStore = { status: null };
  const uiLocale = () => notifyLocale(readUiPrefs(db).language, hub.desktopLang());
  const focus = new FocusService({
    sqlite,
    mutate: mutateCtx,
    clock,
    settings: settingsNow,
    prefs: () => focusSettings(readUiPrefs(db)),
    locale: uiLocale,
    content: () =>
      getSetting<unknown>(db, "notify.content") === "minimal" ? "minimal" : "subject",
    queue: () => ai?.deps.queue() ?? [],
    takePending: () => notifierRef?.takePending() ?? [],
    desktopChannel: () =>
      hub.desktopClients > 0 && desktopStore.status?.notifications === "granted",
    publish: (type, data) => hub.publish(type, data),
    logger,
  });
  const focusTick = () => {
    try {
      focus.tick();
    } catch (e) {
      logger.warn("focus.tick_failed", errorFields(e));
    }
  };
  const focusTimer = setInterval(focusTick, 30_000);
  let focusSoon: ReturnType<typeof setTimeout> | null = null;
  const FOCUS_TRIGGERS = new Set(["calendar", "settings", "day_boundary", "desktop_status"]);
  const focusUnsub = hub.subscribe((m) => {
    if (!FOCUS_TRIGGERS.has(m.type) || focusSoon) return;
    focusSoon = setTimeout(() => {
      focusSoon = null;
      focusTick();
    }, 0);
  });
  // 通知の判定（デスクトップアプリへの notify イベント。desktop-shell.md 3.1）
  const notifyHolds = new NotifyHolds();
  const notifier = ai
    ? new NotifyRunner({
        holds: notifyHolds,
        queue: () => ({ items: ai.deps.queue() }),
        locale: uiLocale,
        // 通知に出す中身（D-207 (4)。既定は件名）
        content: () =>
          getSetting<unknown>(db, "notify.content") === "minimal" ? "minimal" : "subject",
        now: () => clock.now(),
        publish: (type, data) => hub.publish(type, data),
        subscribe: (l) => hub.subscribe(l),
        focus: {
          active: (now) => focus.active(now),
          allowNeedsInput: () => focus.allowNeedsInput(),
          hold: (held) => focus.hold(held),
        },
        muted: () => onboarding?.muted() ?? false,
      })
    : null;
  notifierRef = notifier;
  // 拡張の部品と実行（ADR 0015）
  const keepAwake = new KeepAwake(opts.power ?? { hold: () => null }, logger);
  const extRuntime = new ExtRuntime(
    exts,
    (id) =>
      createExtDeps(
        {
          sqlite,
          mutate: mutateCtx,
          clock,
          logger,
          dataDir: paths.dataDir,
          oneShotDir: paths.summarizeDir,
          extConfig,
          hub,
          tasks: planner.tasks,
          day: (date) => planner.day(date).day,
          workdays: () => {
            if (calendar) return calendar.deps.workdays().rule;
            return { weekdays: settingsNow().workdays, holidays: new Set<string>() };
          },
          ai,
          launch,
          summary: planner.summary,
          holds: notifyHolds,
          power: keepAwake,
          powerState: () =>
            opts.power?.read ? opts.power.read() : Promise.resolve(NO_POWER_STATE),
          limits: claudeLimits,
          home: paths.home,
        },
        id,
      ),
    logger,
  );
  const extRoutes = extRuntime.routes();
  const appDeps = {
    extRoutes,
    token,
    desktop: desktopStore,
    focus: () => focus,
    hub,
    health,
    admin,
    assets: opts.assets,
    ai: () => ai?.deps,
    planner: () => planner,
    calendar: () => calendar?.deps,
    launch: () => launch ?? undefined,
    limits: () => claudeLimits,
    onboarding: () => onboarding ?? undefined,
    update: () => updater,
    updateMenu: () => updateMenuItem(updater.status(), uiLocale()),
    install: () => install ?? undefined,
    ...(ai ? { recordUserOp: ai.recordUserOp } : {}),
  };
  let app = createApp({ ...appDeps, port });
  // ヘルパの WebSocket（/internal/ek）は Hono を通さずに upgrade する
  const fetchWithEk = (req: Request, srv: ReturnType<typeof Bun.serve>) => {
    if (new URL(req.url).pathname === EK_PATH) {
      if (!bridge) return new Response("Not Found", { status: 404 });
      const denied = ekUpgradeCheck(req, token, port);
      if (denied) return denied;
      if (srv.upgrade(req, { data: {} })) return undefined;
      return new Response("Upgrade failed", { status: 400 });
    }
    return app.fetch(req);
  };
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port,
      fetch: fetchWithEk,
      websocket: {
        open: (ws) => bridge?.attach(ws as BridgeSocket),
        message: (ws, m) => bridge?.message(ws as BridgeSocket, m as string | Uint8Array),
        close: (ws) => bridge?.detach(ws as BridgeSocket),
        // ヘルパは長く繋ぎっぱなしにする。切れてもヘルパが接続し直す
        idleTimeout: 960,
        sendPings: true,
      },
      // SSE を切らないよう、アイドルタイムアウトは上限にする（ハートビートは 15 秒ごと）
      idleTimeout: 255,
    });
  } catch (e) {
    logger.error("http.listen_failed", { ...errorFields(e), port });
    sqlite.close();
    throw e;
  }
  if (port === 0) {
    port = server.port ?? 0;
    // ポート 0 のときは Host 検証に実ポートが要るので作り直す
    app = createApp({ ...appDeps, port });
  }
  logger.info("daemon.started", {
    version: meta(VERSION),
    port,
    pid: process.pid,
    user_version: readUserVersion(sqlite),
    web_assets: Object.keys(opts.assets ?? {}).length,
  });
  // 起動時に今日の分が無ければ作り、以降は 10 分ごとに確認する
  backupJob.start(opts.backupIntervalMs);
  // 取り込みはバックグラウンドで始める（初回のバックフィルで HTTP の起動を待たせない）
  if (ai) void ai.start().catch((e) => logger.error("ingest.start_failed", errorFields(e)));
  notifier?.start();
  updater.start();
  install?.start();
  autoUpdater.start();
  calendar?.start();
  presence?.start();
  launch?.start();
  focusTick();
  extRuntime.start();

  let stopped = false;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    token,
    mutateCtx,
    supervisor,
    ai,
    calendar,
    focus,
    launch,
    onboarding,
    update: updater,
    autoUpdate: autoUpdater,
    install,
    async stop() {
      if (stopped) return;
      stopped = true;
      // 拡張の停止は待たずに始める（HTTP を同じ tick で止めるため）。DB を閉じる前に待つ
      const extStopping = extRuntime.stop();
      keepAwake.stop();
      clearInterval(dayTimer);
      clearInterval(cliTimer);
      presence?.stop();
      launch?.stop();
      notifier?.stop();
      updater.stop();
      autoUpdater.stop();
      desktopGoneUnsub();
      install?.stop();
      clearInterval(focusTimer);
      if (focusSoon) clearTimeout(focusSoon);
      focusUnsub();
      planner.summary?.stop();
      backupJob.stop();
      calendar?.stop();
      // HTTP を先に止める（同じポートでの再起動を待たせない）。取り込みの途中の書き込みを待ってから DB を閉じる
      const closing = server.stop(true);
      await ai?.stop();
      await extStopping;
      await closing;
      sqlite.close();
      logger.info("daemon.stopped", {});
    },
  };
}
