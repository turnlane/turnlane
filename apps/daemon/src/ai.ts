/**
 * 取り込み（supervisor）・判定（runner）・PR 状態（gh）・API（AiDeps）をまとめて組み立てる（M1）。
 */
import type { Database } from "bun:sqlite";
import {
  builtinAdapters,
  errorFields,
  type MetaOnlyLogger,
  type SourceAdapter,
} from "@turnlane/collectors";
import {
  addDays,
  type Clock,
  getSetting,
  isScratchCwd,
  type MutateCtx,
  newId,
  nextWorkday,
  putSetting,
  readScratchDirs,
  readSettings,
  toLocalDate,
  type WorkdayRule,
} from "@turnlane/core";
import type { LiveLaunch } from "@turnlane/core/api";
import { mcpTargetFor, mcpTargetStatus } from "@turnlane/core/mcp";
import { Answerer } from "./answer/index.ts";
import { openWaitFor } from "./answer/wait.ts";
import {
  AWAY_DISMISSED_KEY,
  awayDigest,
  type PrChangeCached,
  type PrChangeLookup,
  withChange,
} from "./derive/away.ts";
import { liveItems } from "./derive/live.ts";
import { UserOps } from "./derive/ops.ts";
import { DeriveRunner } from "./derive/runner.ts";
import {
  aiDays,
  graceQueue,
  limitQueue,
  plannedStart,
  queue,
  queueExtras,
  workItemDetail,
} from "./derive/views.ts";
import { type GhClient, PrPoller } from "./github/pr-poller.ts";
import { readGlance, snapshotWaitDetails } from "./glance/index.ts";
import { readLastReply } from "./glance/last-reply.ts";
import type { AiDeps, SourceView } from "./http/ai-routes.ts";
import type { SseHub } from "./http/sse.ts";
import { dirExcludeGlobs } from "./ingest/enrich.ts";
import { type GitProbe, ScratchAwareGit } from "./ingest/git.ts";
import type { ClaudeLimitsSink } from "./ingest/sink.ts";
import { type SourceRow, Supervisor } from "./ingest/supervisor.ts";
import { notifyLocale } from "./notify/runner.ts";
import { Opener } from "./open/index.ts";
import { type OpenSystem, systemOpen } from "./open/system.ts";
import { readMeta } from "./planner/common.ts";
import { readUiPrefs } from "./planner/ui-prefs.ts";

export interface AiOptions {
  sqlite: Database;
  mutate: MutateCtx;
  clock: Clock;
  logger: MetaOnlyLogger;
  hub: SseHub;
  git: GitProbe;
  home: string;
  dataDir: string;
  vars: Record<string, string | undefined>;
  adapters?: readonly SourceAdapter[];
  gh?: GhClient | null;
  noWatch?: boolean;
  /** タスクから開く（D-059）が OS に触れるところ（テストでは差し替える） */
  openSystem?: OpenSystem;
  /** 取り込まないディレクトリ（日報の AI 要約の作業ディレクトリ。M4-6） */
  excludeDirs?: readonly string[];
  /** 取り込みに同意しているか（onboarding.md 5.2。省略時は同意済み） */
  consented?: () => boolean;
  /** 取り込む範囲の始まり（D-181。null・省略は制限なし） */
  importSince?: () => number | null;
  /** 手で足した設定ディレクトリ（M6-19） */
  extraRoots?: () => readonly string[];
  /** キューが進んだとき（進捗。M6-20） */
  onProgress?: () => void;
  /** まとめての取り込みが終わったとき（判定を回した後に呼ぶ。通知の既読化。M6-18） */
  onBulkDone?: () => void;
  /**
   * MCP の登録の状態（D-145）で、登録が指しているべき turnlane の絶対パス。無ければ command のファイルがあるかで見る
   */
  mcpCli?: string | null;
  /** Claude の利用枠の記録先（取り込みが `.claude.json` のキャッシュを見つけたら記録する） */
  limits?: ClaudeLimitsSink;
}

export interface AiSystem {
  supervisor: Supervisor;
  runner: DeriveRunner;
  poller: PrPoller | null;
  deps: AiDeps;
  recordUserOp(at: number): void;
  /** 稼働日の規則（M3-6。カレンダーの祝日を含む）。カレンダーが無ければ設定の稼働曜日だけ */
  setWorkdays(fn: () => WorkdayRule): void;
  /** PR の変更の量と CI を読む先（頼む機能の確認支援の控え。離れていた間のまとめ・終わった件の行） */
  setPrChange(fn: PrChangeLookup, cached: PrChangeCached): void;
  /** 片付けが残っている起動を読む先（AI の画面。GET /api/ai/live）。頼む機能が無ければ起動は無いものとする */
  setLiveLaunches(fn: () => Promise<ReadonlyMap<string, LiveLaunch>>): void;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * 取り込み元（Claude のプロファイル・Codex）の MCP の登録の状態（D-145。設定 > AI の取り込み）。設定ファイルは読むだけで、
 * 見るのは turnlane の項目だけ。Claude / Codex 以外は unknown
 */
export function sourceMcpState(
  r: Pick<SourceRow, "tool" | "root_path">,
  home: string,
  cli: string | null,
): SourceView["mcpState"] {
  if (r.tool !== "claude_code" && r.tool !== "codex") return "unknown";
  try {
    return mcpTargetStatus(mcpTargetFor(r.tool, r.root_path, home), cli).state;
  } catch {
    return "unreadable";
  }
}

function sourceView(r: SourceRow): Omit<SourceView, "mcpState"> {
  const list = (s: string) => {
    try {
      const v = JSON.parse(s) as unknown;
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    } catch {
      return [];
    }
  };
  return {
    id: r.id,
    tool: r.tool,
    rootPath: r.root_path,
    profileLabel: r.profile_label,
    enabled: r.enabled === 1,
    hooksState: r.hooks_state,
    healthLevel: r.health_level,
    healthReason: r.health_reason,
    detectedVersion: r.detected_version,
    lastIngestAt: r.last_ingest_at,
    lastHookAt: r.last_hook_at,
    excludeGlobs: list(r.exclude_globs_json),
    includeGlobs: list(r.include_globs_json),
  };
}

/**
 * 壁打ちのフォルダか（D-135）。判定のたびに設定（ai.scratch_dirs）を読む（取り込み・判定でターンごとに呼ばれるので、
 * 保存値の文字列が変わったときだけ読み直す）
 */
export function scratchMatcher(sqlite: Database, home: string): (cwd: string) => boolean {
  let raw: string | null | undefined;
  let dirs: string[] = [];
  return (cwd) => {
    const v =
      sqlite
        .query<{ value_json: string }, [string]>("SELECT value_json FROM setting WHERE key = ?")
        .get("ai.scratch_dirs")?.value_json ?? null;
    if (v !== raw) {
      raw = v;
      try {
        dirs = readScratchDirs(v ? JSON.parse(v) : null);
      } catch {
        dirs = [];
      }
    }
    return isScratchCwd(cwd, { home, dirs });
  };
}

export function createAiSystem(o: AiOptions): AiSystem {
  const adapters = o.adapters ?? builtinAdapters;
  const settings = () => readSettings(o.mutate.db);
  // 壁打ちのフォルダは git 管理外として扱う（D-135）
  const isScratch = scratchMatcher(o.sqlite, o.home);
  const git = new ScratchAwareGit(o.git, isScratch);
  // 待ちの中身の保存（ADR 0018）: 読めなかったフォローアップは同じ起動の間は読み直さない
  const triedWaits = new Set<string>();
  const runner = new DeriveRunner({
    afterRun: (now, s) => {
      if (s.storeDetail) snapshotWaitDetails(o.sqlite, { now, home: o.home, tried: triedWaits });
    },
    sqlite: o.sqlite,
    mutate: o.mutate,
    git,
    isScratch,
    clock: o.clock,
    logger: o.logger,
    runningStaleMs: Object.fromEntries(adapters.map((a) => [a.tool, a.timing.runningStaleMs])),
    publish: (type, data) => o.hub.publish(type, data),
  });
  const supervisor = new Supervisor({
    sqlite: o.sqlite,
    clock: o.clock,
    logger: o.logger,
    adapters,
    git,
    env: { home: o.home, vars: { ...o.vars, TURNLANE_DATA_DIR: o.dataDir } },
    settings,
    onChanged: () => runner.schedule(),
    // 判定の実行中は次のチャンクに進まない（取り込みの書き込みで判定が打ち切られないように）
    yieldTo: () => runner.idle(),
    onSourceChanged: () => o.hub.publish("source", {}),
    ...(o.limits ? { limits: o.limits } : {}),
    ...(o.noWatch ? { noWatch: true } : {}),
    builtinExclude: (o.excludeDirs ?? []).flatMap(dirExcludeGlobs),
    ...(o.consented ? { consented: o.consented } : {}),
    ...(o.importSince ? { importSince: o.importSince } : {}),
    ...(o.extraRoots ? { extraRoots: o.extraRoots } : {}),
    ...(o.onProgress ? { onProgress: o.onProgress } : {}),
    // まとめての取り込みの後: 判定を今回して（取り込んだ過去の出来事のフォローアップを作り）から知らせる
    onBulkDone: () => {
      try {
        runner.runOnce();
      } catch (e) {
        o.logger.warn("derive.failed", errorFields(e));
      }
      o.onBulkDone?.();
    },
  });
  const poller =
    o.gh === null
      ? null
      : new PrPoller({
          sqlite: o.sqlite,
          clock: o.clock,
          logger: o.logger,
          ...(o.gh ? { gh: o.gh } : {}),
          onChanged: () => runner.schedule(),
        });
  const ops = new UserOps(
    o.sqlite,
    o.mutate,
    o.clock,
    () => runner.schedule(50),
    (type, data) => o.hub.publish(type, data),
  );
  const opener = new Opener({
    sqlite: o.sqlite,
    mutate: o.mutate,
    sys: o.openSystem ?? systemOpen,
    home: o.home,
    now: () => o.clock.now(),
    ops,
    locale: () => notifyLocale(readUiPrefs(o.mutate.db).language, o.hub.desktopLang()),
  });

  const answerer = new Answerer({
    sqlite: o.sqlite,
    sys: o.openSystem ?? systemOpen,
    opener,
    logger: o.logger,
    home: o.home,
    now: () => o.clock.now(),
    locale: () => notifyLocale(readUiPrefs(o.mutate.db).language, o.hub.desktopLang()),
    enabled: () => getSetting<unknown>(o.mutate.db, "turn.answer") !== false,
    showDetail: () => getSetting<unknown>(o.mutate.db, "turn.show_detail") !== false,
    sessionWait: (id) => runner.sessionWait(id),
  });
  /** 答える対象の待ち（D-240。queue の item・詳細に付ける。wait・answer と同じ判定） */
  const openWait = (id: string) => openWaitFor(o.sqlite, id, runner.sessionWait(id)) ?? undefined;

  let lastOpMinute = -1;
  const recordUserOp = (at: number) => {
    // 同じ1分の中は1件にまとめる（3.3.1）
    const minute = Math.floor(at / 60_000);
    if (minute === lastOpMinute) return;
    lastOpMinute = minute;
    o.sqlite.run("INSERT INTO usage_event (id, at, kind) VALUES (?, ?, 'user_op')", [
      newId(o.clock),
      at,
    ]);
    runner.schedule();
  };

  let workdaysFn: (() => WorkdayRule) | null = null;
  const workdays = (): WorkdayRule =>
    workdaysFn?.() ?? { weekdays: settings().workdays, holidays: new Set<string>() };

  let prChangeFn: PrChangeLookup | null = null;
  let liveLaunchesFn: (() => Promise<ReadonlyMap<string, LiveLaunch>>) | null = null;
  let prCachedFn: PrChangeCached | null = null;

  const deps: AiDeps = {
    days: (date, days) => {
      const s = settings();
      const now = o.clock.now();
      const to = date ?? toLocalDate(now, s.tz, s.dayBoundary);
      return aiDays(o.sqlite, s, now, addDays(to, -(days - 1)), days);
    },
    detail: (id) => {
      const d = workItemDetail(o.sqlite, id, settings(), o.clock.now(), o.hub.rev);
      const w = d ? openWait(id) : undefined;
      return d && w ? { ...d, openWait: w } : d;
    },
    glance: (id) => {
      const now = o.clock.now();
      const s = settings();
      return readGlance(o.sqlite, id, {
        now,
        // 猶予中の問い（D-245）はフォローアップが無いので、セッションの待ちのターンを読む
        sessionWait: runner.sessionWait(id),
        showDetail: getSetting<unknown>(o.mutate.db, "turn.show_detail") !== false,
        home: o.home,
        ...(s.storeDetail ? { stored: { day: toLocalDate(now, s.tz, s.dayBoundary) } } : {}),
      });
    },
    lastReply: async (id) => {
      const r = readLastReply(o.sqlite, id, {
        now: o.clock.now(),
        showDetail: getSetting<unknown>(o.mutate.db, "turn.show_detail") !== false,
      });
      // 次の指示を送れるか（Issue #9）。答えると同じ届け先の判定
      const instruct = r ? await answerer.instructCheck(id) : null;
      return r && instruct ? { ...r, instruct } : r;
    },
    storedDetail: () => storedDetailCounts(o.sqlite),
    clearStoredDetail: () => {
      const n = storedDetailCounts(o.sqlite);
      o.sqlite.transaction(() => {
        o.sqlite.run("DELETE FROM wait_detail");
        o.sqlite.run("DELETE FROM ai_instruction");
      })();
      // 消した分を読み直さない（保存をオフにしていなければ、これからの指示・待ちはまた保存する）
      for (const r of o.sqlite
        .query<{ id: string }, []>("SELECT id FROM follow_up WHERE status IN ('open', 'snoozed')")
        .all())
        triedWaits.add(r.id);
      o.hub.publish("work_item", { dates: [], ids: [] });
      return n;
    },
    queue: () =>
      withChange(o.sqlite, queue(o.sqlite, settings(), o.clock.now()), prCachedFn).map((x) => {
        const w = openWait(x.workItemId);
        return w ? { ...x, wait: w } : x;
      }),
    graceQueue: () =>
      graceQueue(o.sqlite, settings(), o.clock.now(), runner.sessionWaits()).map((x) => {
        const w = openWait(x.workItemId);
        return w ? { ...x, wait: w } : x;
      }),
    limitQueue: () => limitQueue(o.sqlite, settings(), o.clock.now()),
    live: async () => {
      const launches = (await liveLaunchesFn?.()) ?? new Map<string, LiveLaunch>();
      return liveItems(o.sqlite, o.clock.now(), launches).map((x) => {
        const w = openWait(x.id);
        return w ? { ...x, wait: w } : x;
      });
    },
    away: async () => ({
      digest: await awayDigest(o.sqlite, settings(), o.clock.now(), prChangeFn ?? undefined),
    }),
    dismissAway: (key) => {
      putSetting(o.mutate, AWAY_DISMISSED_KEY, key, "local_only");
      o.hub.publish("settings", {});
    },
    queueExtras: () => queueExtras(o.sqlite, settings(), o.clock.now()),
    meta: () => readMeta(settings(), o.clock.now(), o.hub.rev),
    opener,
    answerer,
    snoozeUntil: (preset) => {
      const now = o.clock.now();
      if (preset === "30m") return now + 30 * 60_000;
      if (preset === "1h") return now + 60 * 60_000;
      // 明日朝 = 次の稼働日（祝日を除く。M3-6）の計画の目安の開始（D-064・D-106）
      const s = settings();
      const today = toLocalDate(now, s.tz, s.dayBoundary);
      const next = nextWorkday(today, workdays()) ?? addDays(today, 1);
      return plannedStart(next, s);
    },
    ops,
    sources: () =>
      supervisor.sources().map((r) => ({
        ...sourceView(r),
        // 同意の前は他ツールの設定ファイルを読まない（onboarding.md 5.2）
        mcpState: supervisor.consented ? sourceMcpState(r, o.home, o.mcpCli ?? null) : "unknown",
      })),
    patchSource: (id, p) => {
      const sets: string[] = [];
      const args: (string | number)[] = [];
      if (p.enabled !== undefined) {
        sets.push("enabled = ?");
        args.push(p.enabled ? 1 : 0);
      }
      if (p.excludeGlobs) {
        sets.push("exclude_globs_json = ?");
        args.push(JSON.stringify(p.excludeGlobs));
      }
      if (p.includeGlobs) {
        sets.push("include_globs_json = ?");
        args.push(JSON.stringify(p.includeGlobs));
      }
      if (p.profileLabel !== undefined) {
        sets.push("profile_label = ?");
        args.push(p.profileLabel);
      }
      if (sets.length === 0) return;
      o.sqlite.run(`UPDATE ai_source SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`, [
        ...args,
        o.clock.now(),
        id,
      ]);
      void supervisor.reconcile();
    },
    rescan: async () => {
      await supervisor.reconcile();
    },
    reingest: async (sourceId) => {
      await supervisor.reingest(sourceId);
    },
    rederive: (opts) => runner.rederive(opts),
    ingestStatus: () => ({ backfillDone: supervisor.backfillDone }),
  };

  return {
    supervisor,
    runner,
    poller,
    deps,
    recordUserOp,
    setWorkdays(fn) {
      workdaysFn = fn;
    },
    setLiveLaunches(fn) {
      liveLaunchesFn = fn;
    },
    setPrChange(fn, cached) {
      prChangeFn = fn;
      prCachedFn = cached;
    },
    async start() {
      await supervisor.start();
      runner.start();
      poller?.start();
    },
    async stop() {
      poller?.stop();
      runner.stop();
      await runner.idle();
      await supervisor.stop();
    },
  };
}

/** 保存した待ちの中身の件数（ADR 0018） */
function storedDetailCounts(db: Database): { instructions: number; waits: number } {
  const n = (t: string) =>
    db.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${t}`).get()?.n ?? 0;
  return { instructions: n("ai_instruction"), waits: n("wait_detail") };
}
