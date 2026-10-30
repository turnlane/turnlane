/**
 * 取り込みの監督（phase0-plan 3.2、M1-2）。
 * - ソースの検出（builtinAdapters の detect）と ai_source の登録
 * - fs.watch（recursive）と 60 秒ごとの再走査（mtime・サイズの比較）
 * - ストリーム単位のキュー（デバウンス 500ms・直列実行・priority 順）。1回 512KB まで読み、続きは再投入
 *   （1 チャンクの同期処理を短くし、HTTP を待たせない）
 * - ライブ状態の probe（5 秒ごと + sessions/ の変化）
 * - spool の掃除（7日より古く取り込み済みのもの）
 * - health（縮退レベルとカウンタ。M1-12）
 * - 同意のゲート（onboarding.md 5.2、M6-18）: 同意の前は検出（ai_source の登録）だけをし、セッションのファイル・spool・
 *   sessions/ の probe・他ツールの設定ファイル（hooks の状態）を読まない。同意したら beginIngest() で始める
 * - 新しい日から取り込む（5.3、M6-20）: キューは priority → mtime の新しい順。日ごとの完了は ImportProgress が
 *   pendingMtimes() から判定する
 */
import type { Database } from "bun:sqlite";
import {
  accessSync,
  constants,
  existsSync,
  type FSWatcher,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  watch,
} from "node:fs";
import { dirname } from "node:path";
import {
  type DetectedRoot,
  errorFields,
  type MetaOnlyLogger,
  meta,
  type SourceAdapter,
  type StreamSpec,
  satisfiesRange,
  type WatchSpec,
} from "@turnlane/collectors";
import { addDays, type Clock, dayStartMs, newId, toLocalDate } from "@turnlane/core";
import { isInternalSource } from "@turnlane/core/api";
import {
  claudePlan,
  codexInspect,
  codexPlan,
  status as hooksStatus,
  loadJson,
} from "@turnlane/core/hooks";
import { enrich, parseRules } from "./enrich.ts";
import type { GitProbe } from "./git.ts";
import { assessHealth, type StreamHealth } from "./health.ts";
import {
  applyClaudeLimits,
  applyLiveSweep,
  applyRead,
  type ClaudeLimitsSink,
  loadCursor,
  recordCursorError,
  type SinkContext,
  toCursor,
} from "./sink.ts";

export interface SourceRow {
  id: string;
  tool: string;
  root_path: string;
  profile_label: string | null;
  enabled: number;
  hooks_state: string;
  include_globs_json: string;
  exclude_globs_json: string;
  health_level: string;
  health_reason: string | null;
  detected_version: string | null;
  last_ingest_at: number | null;
  last_hook_at: number | null;
}

interface Active {
  row: SourceRow;
  adapter: SourceAdapter;
  root: DetectedRoot;
}

interface Job {
  sourceId: string;
  stream: StreamSpec;
  /** ファイルの更新時刻（新しい日から取り込む並べ順と、日ごとの完了の判定。消えたファイルは 0） */
  mtimeMs: number;
  /**
   * まとめての取り込み（同意の後・新しい取り込み元・reingest で、カーソルが無く live でないストリーム）。
   * 残っている間は過去の出来事なので通知しない（bulkImporting）
   */
  bulk: boolean;
}

/** 検出の API（M6-19）の1行。件数はファイルの数と更新時刻だけで数える（中身を開かない） */
export interface DetectSummary {
  row: SourceRow;
  /** 直近7日（6日前の論理日の始まり以降）に更新されたセッションのファイル数。取り込む範囲と同じ（D-181） */
  sessions7d: number;
  lastActivityAt: number | null;
  readable: boolean;
  reason: string | null;
}

export interface SupervisorOptions {
  sqlite: Database;
  clock: Clock;
  logger: MetaOnlyLogger;
  adapters: readonly SourceAdapter[];
  git: GitProbe;
  env: { home: string; vars: Record<string, string | undefined> };
  settings: () => { tz: string; dayBoundary: number; storeTitles: boolean; storeDetail?: boolean };
  /**
   * シンクで変化したセッションがあったとき（derive runner を起こす）。利用枠（`.claude.json` のキャッシュ）を記録したときは
   * 空の集合で呼ぶ（上限待ちの明ける時刻を導出し直す）
   */
  onChanged: (sessionIds: Set<string>) => void;
  /** 利用枠の記録先（`.claude.json` のキャッシュ）。省略は読んでも捨てる */
  limits?: ClaudeLimitsSink;
  /** ソースの状態が変わったとき（SSE） */
  onSourceChanged?: () => void;
  /**
   * 取り込みに同意しているか（onboarding.md 5.2、M6-18）。false の間は検出だけをする。省略時は同意済み
   * （テストと、ゲートを持たない組み立て）
   */
  consented?: () => boolean;
  /**
   * 取り込む範囲の始まり（D-181。オンボーディングの importSince）。これより前に更新が止まった、まだ読んでいない
   * ストリームは読まない（今も後からも）。null・省略は制限なし（既存の利用者とテスト）
   */
  importSince?: () => number | null;
  /** 手で足した設定ディレクトリ（Choose a folder…、M6-19）。検出の候補に足す */
  extraRoots?: () => readonly string[];
  /** キューが進んだとき（ジョブを1つ処理した・走査を終えた。日ごとの完了の判定。M6-20） */
  onProgress?: () => void;
  /** まとめての取り込み（Job.bulk）が無くなったとき（通知の既読化。M6-18） */
  onBulkDone?: () => void;
  maxBytes?: number;
  debounceMs?: number;
  reconcileMs?: number;
  liveMs?: number;
  /** 軽い走査（WatchSpec.pollEveryMs）の判定の間隔。既定 1 秒（各監視先の間隔はその pollEveryMs） */
  pollTickMs?: number;
  /** fs.watch を使わない（テスト） */
  noWatch?: boolean;
  /** チャンクの間に待つもの（判定の非同期の実行が終わるまで。ai.ts）。省略時はイベントループに 1 回譲るだけ */
  yieldTo?: () => Promise<void>;
  /**
   * どの取り込み元にも常に足す除外の glob（日報の AI 要約の作業ディレクトリ。M4-6）。
   * 取り込み元ごとの exclude_globs_json には書かない（設定画面の一覧に出さず、消せない）
   */
  builtinExclude?: readonly string[];
  /**
   * Codex のプロセスの確かめ（Issue #10。hooks が残した親の pid）。alive は kill(pid, 0)、name は `ps -o comm=`（pid の
   * 使い回しに備えて、1 分ごとに codex のプロセスかを確かめる）。テストは偽物を渡す
   */
  codexProcess?: CodexProcessProbe;
}

export interface CodexProcessProbe {
  alive(pid: number): boolean;
  name(pid: number): string | null;
}

/** 実際の OS で確かめる（kill(pid, 0) と ps の comm） */
export const systemCodexProcess: CodexProcessProbe = {
  alive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === "EPERM";
    }
  },
  name(pid) {
    try {
      const r = Bun.spawnSync(["/bin/ps", "-o", "comm=", "-p", String(pid)], {
        stdout: "pipe",
        stderr: "ignore",
      });
      const s = r.stdout.toString().trim();
      return r.exitCode === 0 && s ? s : null;
    } catch {
      return null;
    }
  },
};

/** Codex のプロセスの名前を確かめ直す間隔 */
const CODEX_NAME_TTL_MS = 60_000;
/** hooks の pid から Codex のプロセスを探すセッション（これより前に動いたものは、生きていると分かっているものだけ） */
const CODEX_PROBE_WINDOW_MS = 24 * 3_600_000;

const PRIORITY = { live: 0, recent: 1, backfill: 2 } as const;
const SPOOL_KEEP_MS = 7 * 86_400_000;

export class Supervisor {
  readonly #o: SupervisorOptions;
  readonly #sources = new Map<string, Active>();
  readonly #watchers = new Map<string, FSWatcher>();
  readonly #queue = new Map<string, Job>();
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #health = new Map<string, Map<string, StreamHealth>>();
  /**
   * 最後の列挙で見つかったストリームのキー → 実際のパス（取り込み元ごと）。キーは実際のパスと違うことがある（Claude Code の
   * Codex の作業フォルダの名前を落としたキー。D-136）ので、DB のキーから実際のファイルを探すときはここを先に見る
   */
  readonly #listed = new Map<string, Map<string, string>>();
  /**
   * 軽い走査（WatchSpec.pollEveryMs）の対象: 取り込み元 → 監視先 → ストリームのキー → 実際のパスと最後に見た mtime。
   * 列挙（scanAll）で live / recent のものに入れ直し、監視で新しく見つけたものを足す
   */
  readonly #polled = new Map<string, Map<string, Map<string, { path: string; mtime: number }>>>();
  /** 監視先ごとの最後の軽い走査の時刻 */
  readonly #polledAt = new Map<string, number>();
  #running = false;
  #drainDone: Promise<void> = Promise.resolve();
  #stopped = false;
  #idle: (() => void)[] = [];
  #intervals: ReturnType<typeof setInterval>[] = [];
  #liveTimer: ReturnType<typeof setTimeout> | null = null;
  /** 処理中のジョブ（日ごとの完了の判定に含める） */
  #inflight: Job | null = null;
  /** 走査（scanAll）の途中か。途中は日の完了を決めない */
  #scanning = 0;
  /** 同意の後の取り込みを始めたか */
  #begun = false;
  /** 同意の後の最初の走査を終えたか */
  #firstScanDone = false;
  #hadBulk = false;
  /** 最後の検出で見つかった (tool, root_path) */
  #detected = new Set<string>();
  /** Codex の pid → 名前を確かめた時刻と結果（Issue #10） */
  readonly #codexNames = new Map<number, { at: number; ok: boolean }>();
  /** 初回のバックフィルが終わったか（turnlane ai の確認・テスト用） */
  backfillDone = false;

  constructor(o: SupervisorOptions) {
    this.#o = o;
  }

  get #sink(): SinkContext {
    const s = this.#o.settings();
    return {
      db: this.#o.sqlite,
      clock: this.#o.clock,
      tz: s.tz,
      dayBoundary: s.dayBoundary,
      storeDetail: s.storeDetail === true,
      ...(this.#o.limits ? { limits: this.#o.limits } : {}),
    };
  }

  /** 取り込みに同意しているか */
  get consented(): boolean {
    return this.#o.consented?.() ?? true;
  }

  /** 同意の後の取り込みを始めたか */
  get begun(): boolean {
    return this.#begun;
  }

  async start(): Promise<void> {
    await this.detect();
    this.#intervals.push(
      setInterval(() => void this.reconcile(), this.#o.reconcileMs ?? 60_000),
      setInterval(() => void this.probeLive(), this.#o.liveMs ?? 5_000),
    );
    if (!this.#o.noWatch)
      this.#intervals.push(setInterval(() => this.pollChanged(), this.#o.pollTickMs ?? 1_000));
    if (this.consented) await this.#begin();
  }

  /**
   * 同意したときに呼ぶ（POST /api/onboarding/consent）。まだ始めていなければ、走査・監視・probe を始める。
   * 同意していなければ何もしない
   */
  async beginIngest(): Promise<void> {
    if (this.#stopped || this.#begun || !this.consented) return;
    await this.#begin();
  }

  async #begin(): Promise<void> {
    this.#begun = true;
    this.#updateHooksState();
    await this.scanAll();
    this.#firstScanDone = true;
    this.#o.onProgress?.();
    await this.probeLive();
    if (!this.#o.noWatch) this.#watchAll();
    void this.whenIdle().then(() => {
      this.backfillDone = true;
      this.#o.onProgress?.();
    });
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    for (const t of this.#intervals) clearInterval(t);
    for (const t of this.#timers.values()) clearTimeout(t);
    if (this.#liveTimer) clearTimeout(this.#liveTimer);
    for (const w of this.#watchers.values()) w.close();
    this.#watchers.clear();
    this.#queue.clear();
    // 読み取り・書き込みの途中なら終わるまで待つ（DB を閉じる前に）
    await this.#drainDone;
  }

  /** キューが空になるまで待つ */
  whenIdle(): Promise<void> {
    if (!this.#running && this.#queue.size === 0 && this.#timers.size === 0)
      return Promise.resolve();
    return new Promise((r) => this.#idle.push(r));
  }

  sources(): SourceRow[] {
    return this.#o.sqlite
      .query<SourceRow, []>("SELECT * FROM ai_source ORDER BY tool, root_path")
      .all();
  }

  /** 検出して ai_source に登録する（既存の enabled・除外ルールは保つ） */
  async detect(): Promise<void> {
    const now = this.#o.clock.now();
    const detected = new Set<string>();
    const extraRoots = this.#o.extraRoots?.() ?? [];
    for (const adapter of this.#o.adapters) {
      let roots: DetectedRoot[] = [];
      try {
        roots = await adapter.detect(
          extraRoots.length > 0 ? { ...this.#o.env, extraRoots } : this.#o.env,
        );
      } catch (e) {
        this.#o.logger.warn("ingest.detect_failed", {
          tool: meta(adapter.tool),
          ...errorFields(e),
        });
      }
      for (const root of roots) {
        this.#o.sqlite.run(
          `INSERT INTO ai_source (id, tool, root_path, profile_label, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (tool, root_path) DO NOTHING`,
          [newId(this.#o.clock), adapter.tool, root.rootPath, root.profileLabel, now, now],
        );
        const row = this.#o.sqlite
          .query<SourceRow, [string, string]>(
            "SELECT * FROM ai_source WHERE tool = ? AND root_path = ?",
          )
          .get(adapter.tool, root.rootPath);
        if (!row) continue;
        detected.add(`${adapter.tool}\0${root.rootPath}`);
        const known = this.#sources.has(row.id);
        if (row.enabled === 1) this.#sources.set(row.id, { row, adapter, root });
        else this.#sources.delete(row.id);
        if (!known && row.enabled === 1) {
          this.#o.logger.info("ingest.source", {
            tool: meta(adapter.tool),
            label: meta(root.profileLabel),
            evidence: root.evidence.map((x) => meta(x)),
          });
        }
      }
    }
    this.#detected = detected;
  }

  /** 直近7日の始まり（6日前の論理日の始まり。D-181。検出の件数と、最初の同意で決める取り込む範囲） */
  recentSince(): number {
    const s = this.#o.settings();
    const today = toLocalDate(this.#o.clock.now(), s.tz, s.dayBoundary);
    return dayStartMs(addDays(today, -6), s.tz, s.dayBoundary);
  }

  /**
   * 検出の API（onboarding.md 5.2・5.4、M6-19）: 最後の検出で見つかった取り込み元ごとに、直近7日に更新された
   * セッションのファイル数と最終の更新時刻を返す。ファイルの一覧と更新時刻（stat）だけを使い、中身は開かない。
   * spool（Turnlane 自身のディレクトリ）は出さない
   */
  async detectSummary(): Promise<DetectSummary[]> {
    await this.detect();
    const since = this.recentSince();
    const out: DetectSummary[] = [];
    for (const row of this.sources()) {
      if (isInternalSource(row.tool) || !this.#detected.has(`${row.tool}\0${row.root_path}`))
        continue;
      const adapter = this.#o.adapters.find((a) => a.tool === row.tool);
      if (!adapter) continue;
      const root: DetectedRoot = {
        tool: adapter.tool,
        rootPath: row.root_path,
        profileLabel: row.profile_label ?? "default",
        evidence: [],
      };
      let streams: StreamSpec[] = [];
      let readable = true;
      let reason: string | null = null;
      try {
        accessSync(row.root_path, constants.R_OK | constants.X_OK);
        streams = await adapter.listStreams(root, {});
      } catch (e) {
        readable = false;
        reason = (e as NodeJS.ErrnoException).code ?? "unreadable";
      }
      let d7 = 0;
      let last: number | null = null;
      for (const s of streams) {
        if (!isSessionStream(s)) continue;
        let m: number;
        try {
          m = Math.floor(statSync(s.path).mtimeMs);
        } catch {
          continue;
        }
        if (last === null || m > last) last = m;
        if (m >= since) d7++;
      }
      out.push({
        row,
        sessions7d: d7,
        lastActivityAt: last,
        readable,
        reason,
      });
    }
    return out;
  }

  /**
   * 全ストリームを列挙し、カーソルと比べて変化があるものを priority → 新しい順に投入する。
   * まだ読んでいないストリームのうち、取り込む範囲（importSince）より前に更新が止まったものは読まない（D-181）
   */
  async scanAll(): Promise<number> {
    if (!this.consented) return 0;
    const since = this.#o.importSince?.() ?? null;
    let n = 0;
    this.#scanning++;
    try {
      for (const [sourceId, a] of this.#sources) {
        let streams: StreamSpec[] = [];
        try {
          streams = await a.adapter.listStreams(a.root, {});
        } catch (e) {
          this.#o.logger.warn("ingest.list_failed", {
            tool: meta(a.adapter.tool),
            ...errorFields(e),
          });
          continue;
        }
        this.#listed.set(sourceId, new Map(streams.map((s) => [s.key, s.path])));
        const withMtime = streams.map((s) => ({ s, m: mtimeOf(s.path) }));
        this.#resetPolled(sourceId, a.adapter.watch(a.root), withMtime);
        withMtime.sort((x, y) => PRIORITY[x.s.priority] - PRIORITY[y.s.priority] || y.m - x.m);
        for (const { s, m } of withMtime) {
          const c = loadCursor(this.#o.sqlite, sourceId, s.key);
          if (
            c === null &&
            since !== null &&
            m < since &&
            s.priority !== "live" &&
            !isInternalSource(a.adapter.tool)
          )
            continue;
          if (this.#changed(a.adapter, s, c)) {
            this.#enqueue(
              { sourceId, stream: s, mtimeMs: m, bulk: c === null && s.priority !== "live" },
              0,
            );
            n++;
          }
        }
        // 元ファイルが消えたストリーム（30日削除）。今の列挙にあるキーは消えていない（キーが実際のパスと違うことがある）
        for (const key of this.#cursorKeys(sourceId)) {
          if (this.#exists(sourceId, a.root.rootPath, key)) continue;
          const path = `${a.root.rootPath}/${key}`;
          this.#enqueue(
            {
              sourceId,
              stream: { key, kind: "jsonl", path, priority: "backfill" },
              mtimeMs: 0,
              bulk: false,
            },
            0,
          );
        }
      }
    } finally {
      this.#scanning--;
    }
    return n;
  }

  /**
   * まだ読んでいない（キューと処理中の）ストリームの更新時刻（取り込み元ごと）。日ごとの完了の判定（M6-20）に使う。
   * 走査の途中・始める前は null（まだ決められない）
   */
  pendingMtimes(): { sourceId: string; mtimeMs: number }[] | null {
    if (!this.#begun || !this.#firstScanDone || this.#scanning > 0) return null;
    const out = [...this.#queue.values()].map((j) => ({
      sourceId: j.sourceId,
      mtimeMs: j.mtimeMs,
    }));
    if (this.#inflight)
      out.push({ sourceId: this.#inflight.sourceId, mtimeMs: this.#inflight.mtimeMs });
    return out;
  }

  /** 取り込み元ごとの、読めなかったファイルの数（カーソルのエラー。消えたファイルは除く） */
  skippedBySource(): Map<string, number> {
    const rows = this.#o.sqlite
      .query<{ source_id: string; n: number }, []>(
        "SELECT source_id, count(*) AS n FROM ingest_cursor WHERE last_error IS NOT NULL AND last_error <> 'missing' GROUP BY source_id",
      )
      .all();
    return new Map(rows.map((r) => [r.source_id, r.n]));
  }

  /** まとめての取り込み（同意の後・新しい取り込み元・reingest）の途中か。途中は通知しない */
  get bulkImporting(): boolean {
    return this.#inflight?.bulk === true || [...this.#queue.values()].some((j) => j.bulk);
  }

  #cursorKeys(sourceId: string): string[] {
    return this.#o.sqlite
      .query<{ stream_key: string }, [string]>(
        "SELECT stream_key FROM ingest_cursor WHERE source_id = ? AND (last_error IS NULL OR last_error <> 'missing')",
      )
      .all(sourceId)
      .map((r) => r.stream_key);
  }

  #changed(adapter: SourceAdapter, s: StreamSpec, c: ReturnType<typeof loadCursor>): boolean {
    if (!c || c.parser_version !== adapter.parserVersion) return true;
    try {
      const st = statSync(s.path);
      return st.size !== c.size || Math.floor(st.mtimeMs) !== c.mtime_ms || st.ino !== c.inode;
    } catch {
      return true;
    }
  }

  async reconcile(): Promise<void> {
    if (this.#stopped) return;
    await this.detect();
    if (!this.consented) return;
    if (!this.#begun) {
      await this.#begin();
      return;
    }
    await this.scanAll();
    if (!this.#o.noWatch) this.#watchAll();
    this.#cleanSpool();
    this.#updateHooksState();
    this.#updateHealth();
  }

  /**
   * hooks の受信状態（ai_source.hooks_state。phase0-plan 3.6.1、ux-mvp 4.9）。設定ファイルは読むだけ。
   * none（Turnlane の hook が無い）/ installed / pending_trust（Codex で未承認）/ receiving（24時間以内に届いた）/
   * silent（インストールから24時間以上たち、トランスクリプトには活動があるのに hook が24時間届かない）
   */
  #updateHooksState(): void {
    const now = this.#o.clock.now();
    const DAY = 86_400_000;
    for (const [sourceId, a] of this.#sources) {
      if (a.adapter.tool !== "claude_code" && a.adapter.tool !== "codex") continue;
      const file = `${a.root.rootPath}/${a.adapter.tool === "codex" ? "hooks.json" : "settings.json"}`;
      let state = "none";
      try {
        const f = loadJson(file);
        const plan = a.adapter.tool === "codex" ? codexPlan("turnlane") : claudePlan("turnlane");
        if (hooksStatus(f.value, plan).state !== "none") {
          const row = this.#o.sqlite
            .query<{ last_hook_at: number | null }, [string]>(
              "SELECT last_hook_at FROM ai_source WHERE id = ?",
            )
            .get(sourceId);
          const lastHook = row?.last_hook_at ?? null;
          const activity =
            this.#o.sqlite
              .query<{ t: number | null }, [string]>(
                "SELECT MAX(last_activity_at) AS t FROM ai_session WHERE source_id = ?",
              )
              .get(sourceId)?.t ?? null;
          let untrusted = false;
          if (a.adapter.tool === "codex") {
            let toml = "";
            try {
              toml = readFileSync(`${a.root.rootPath}/config.toml`, "utf8");
            } catch {}
            untrusted = Object.values(codexInspect(toml, f.path, f.value).trustEntries).some(
              (ok) => !ok,
            );
          }
          const installedAt = statSync(f.path).mtimeMs;
          if (lastHook !== null && now - lastHook < DAY) state = "receiving";
          else if (untrusted) state = "pending_trust";
          else if (activity !== null && now - activity < DAY && now - installedAt > DAY)
            state = "silent";
          else state = "installed";
        }
      } catch {
        state = "none";
      }
      this.#o.sqlite.run("UPDATE ai_source SET hooks_state = ? WHERE id = ? AND hooks_state <> ?", [
        state,
        sourceId,
        state,
      ]);
    }
  }

  /** turnlane reingest: カーソルを戻して読み直す（行は消さない。upsert なので重複しない） */
  async reingest(sourceId?: string): Promise<void> {
    if (!this.consented) return;
    if (sourceId) this.#o.sqlite.run("DELETE FROM ingest_cursor WHERE source_id = ?", [sourceId]);
    else this.#o.sqlite.run("DELETE FROM ingest_cursor");
    await this.scanAll();
  }

  #enqueue(job: Job, debounceMs = this.#o.debounceMs ?? 500): void {
    if (this.#stopped) return;
    const k = `${job.sourceId}\0${job.stream.key}`;
    // まとめて取り込んでいるストリームに監視の変化が来ても、まとめての取り込みの印は保つ
    if (this.#queue.get(k)?.bulk) job = { ...job, bulk: true };
    if (job.bulk) this.#hadBulk = true;
    const t = this.#timers.get(k);
    if (t) clearTimeout(t);
    if (debounceMs <= 0) {
      this.#timers.delete(k);
      this.#queue.set(k, job);
      void this.#drain();
      return;
    }
    this.#timers.set(
      k,
      setTimeout(() => {
        this.#timers.delete(k);
        this.#queue.set(k, job);
        void this.#drain();
      }, debounceMs),
    );
  }

  #drain(): Promise<void> {
    if (this.#running) return this.#drainDone;
    this.#drainDone = this.#drainLoop();
    return this.#drainDone;
  }

  async #drainLoop(): Promise<void> {
    this.#running = true;
    try {
      while (!this.#stopped && this.#queue.size > 0) {
        // priority → 新しい順（新しい日から埋める。onboarding.md 5.3）
        const [k, job] = [...this.#queue.entries()].sort(
          (a, b) =>
            PRIORITY[a[1].stream.priority] - PRIORITY[b[1].stream.priority] ||
            b[1].mtimeMs - a[1].mtimeMs,
        )[0] as [string, Job];
        this.#queue.delete(k);
        this.#inflight = job;
        let more: boolean;
        try {
          more = await this.#process(job);
        } finally {
          this.#inflight = null;
        }
        // 処理中に監視の変化で同じストリームが入っていれば、そちらを残す（続きも読まれる）
        if (more && !this.#queue.has(k)) this.#queue.set(k, job);
        this.#afterJob();
        // イベントループを譲る（HTTP を止めない）。判定が走っていれば終わるまで待つ
        await Bun.sleep(0);
        await this.#o.yieldTo?.();
      }
    } finally {
      this.#running = false;
      if (this.#queue.size === 0 && this.#timers.size === 0) {
        const waiters = this.#idle.splice(0);
        for (const w of waiters) w();
      }
    }
  }

  /** 1チャンク読んで反映する。続きがあれば true */
  async #process(job: Job): Promise<boolean> {
    const a = this.#sources.get(job.sourceId);
    if (!a) return false;
    const { adapter, row } = a;
    const s = this.#o.settings();
    let cursorRow = loadCursor(this.#o.sqlite, job.sourceId, job.stream.key);
    if (!cursorRow) cursorRow = this.#takeOverRenamed(job);
    const cursor = toCursor(cursorRow, adapter.parserVersion);
    try {
      const result = await adapter.read(job.stream, cursor, {
        now: this.#o.clock.now(),
        maxBytes: this.#o.maxBytes ?? 512 * 1024,
        privacy: { storeTitles: s.storeTitles, storeDetails: s.storeDetail === true },
        log: this.#o.logger,
        home: this.#o.env.home,
      });
      if (result.missing && !cursorRow) return false;
      const parsed = parseRules(row.include_globs_json, row.exclude_globs_json);
      const rules = {
        include: parsed.include,
        exclude: [...parsed.exclude, ...(this.#o.builtinExclude ?? [])],
      };
      const en = enrich(result.events, adapter, rules, this.#o.git, this.#o.env.home);
      const res = applyRead(
        this.#sink,
        { id: row.id, tool: row.tool, rootPath: row.root_path },
        job.stream,
        { id: adapter.parserId, version: adapter.parserVersion },
        { ...result, events: en.events },
        en.repoRoots,
      );
      if (result.missing)
        recordCursorError(this.#o.sqlite, job.sourceId, job.stream.key, "missing");
      this.#trackHealth(job.sourceId, job.stream.key, result.stats, en.events);
      if (res.sessions.size > 0 || res.hooks > 0) this.#o.onChanged(res.sessions);
      return !result.done;
    } catch (e) {
      this.#o.logger.warn("ingest.read_failed", {
        tool: meta(adapter.tool),
        stream: meta(job.stream.key),
        ...errorFields(e),
      });
      recordCursorError(this.#o.sqlite, job.sourceId, job.stream.key, (e as Error).name ?? "Error");
      return false;
    }
  }

  /** リネーム: 同じ (dev, inode) の既存カーソルが別のキーにあり、そのファイルが消えていれば引き継ぐ */
  #takeOverRenamed(job: Job): ReturnType<typeof loadCursor> {
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(job.stream.path);
    } catch {
      return null;
    }
    const a = this.#sources.get(job.sourceId);
    if (!a) return null;
    const rows = this.#o.sqlite
      .query<{ stream_key: string }, [string, number, number, string]>(
        "SELECT stream_key FROM ingest_cursor WHERE source_id = ? AND dev = ? AND inode = ? AND stream_key <> ?",
      )
      .all(job.sourceId, st.dev, st.ino, job.stream.key);
    for (const r of rows) {
      if (this.#exists(job.sourceId, a.root.rootPath, r.stream_key)) continue;
      this.#o.sqlite.run(
        "UPDATE ingest_cursor SET stream_key = ? WHERE source_id = ? AND stream_key = ?",
        [job.stream.key, job.sourceId, r.stream_key],
      );
      return loadCursor(this.#o.sqlite, job.sourceId, job.stream.key);
    }
    return null;
  }

  /** キーのストリームのファイルがあるか（最後の列挙で見つかったか、キーをそのままパスにしたファイルがある） */
  #exists(sourceId: string, rootPath: string, key: string): boolean {
    const p = this.#listed.get(sourceId)?.get(key);
    return (p !== undefined && existsSync(p)) || existsSync(`${rootPath}/${key}`);
  }

  /**
   * Codex のセッションのプロセス（Issue #10）: hooks が残した親の pid（hook_event.pid の最後のもの）が生きていて codex の
   * プロセスなら busy、そうでなければ gone を ai_session.live_* に写す。SessionEnd の hook が pid の後に来ていれば gone。
   * hooks の来ていないセッションは触らない（live_status は null のまま。最後の動きから 6 時間の推定）。
   * busy は「プロセスがある」だけの意味で、状態の判定（running / needs_input）には使わない（core の sessionStatus）
   */
  #probeCodex(): void {
    const probe = this.#o.codexProcess ?? systemCodexProcess;
    const now = this.#o.clock.now();
    const rows = this.#o.sqlite
      .query<
        {
          id: string;
          live_status: string | null;
          live_pid: number | null;
          pid: number | null;
          pid_at: number | null;
          ended_at: number | null;
        },
        [number]
      >(
        `SELECT s.id, s.live_status, s.live_pid,
                (SELECT h.pid FROM hook_event h WHERE h.tool = 'codex' AND h.session_external_id = s.external_id
                   AND h.pid IS NOT NULL ORDER BY h.occurred_at DESC LIMIT 1) AS pid,
                (SELECT max(h.occurred_at) FROM hook_event h WHERE h.tool = 'codex' AND h.session_external_id = s.external_id
                   AND h.pid IS NOT NULL) AS pid_at,
                (SELECT max(h.occurred_at) FROM hook_event h WHERE h.tool = 'codex' AND h.session_external_id = s.external_id
                   AND h.hook_event_name = 'SessionEnd') AS ended_at
         FROM ai_session s
         WHERE s.tool = 'codex' AND s.is_subagent = 0
           AND (s.live_status IN ('busy', 'idle') OR s.last_activity_at >= ?)`,
      )
      .all(now - CODEX_PROBE_WINDOW_MS);
    const changed = new Set<string>();
    for (const r of rows) {
      if (r.pid === null || r.pid_at === null) continue;
      const ended = r.ended_at !== null && r.ended_at >= r.pid_at;
      const alive = !ended && probe.alive(r.pid) && this.#isCodex(probe, r.pid, now);
      const status = alive ? "busy" : "gone";
      if (r.live_status !== status || r.live_pid !== r.pid) changed.add(r.id);
      this.#o.sqlite.run(
        "UPDATE ai_session SET live_status = ?, live_pid = ?, live_checked_at = ? WHERE id = ?",
        [status, r.pid, now, r.id],
      );
    }
    if (changed.size > 0) this.#o.onChanged(changed);
  }

  /** pid が codex のプロセスか（pid の使い回しに備える。1 分覚える） */
  #isCodex(probe: CodexProcessProbe, pid: number, now: number): boolean {
    const c = this.#codexNames.get(pid);
    if (c && now - c.at < CODEX_NAME_TTL_MS) return c.ok;
    const name = probe.name(pid);
    // 名前が取れなければ（ps が使えない）、生きていることだけで判断する
    const ok = name === null ? true : /(^|\/)codex([^/]*)$/i.test(name);
    this.#codexNames.set(pid, { at: now, ok });
    return ok;
  }

  async probeLive(): Promise<void> {
    if (!this.#begun) return;
    this.#probeCodex();
    for (const [, a] of this.#sources) {
      if (!a.adapter.probeLive) continue;
      try {
        const all = await a.adapter.probeLive(a.root);
        const probes = all.filter((p) => p.kind === "live_status");
        const changed = new Set<string>();
        let limits = false;
        const tx = this.#o.sqlite.transaction(() => {
          // 利用枠（`.claude.json` のキャッシュ。更新されたときだけ届く）
          for (const p of all) {
            if (p.kind === "claude_limits" && applyClaudeLimits(this.#sink, p)) limits = true;
          }
          for (const p of probes) {
            const r = this.#o.sqlite
              .query<
                { id: string; live_status: string | null; live_pid: number | null },
                [string, string]
              >(
                "SELECT id, live_status, live_pid FROM ai_session WHERE tool = ? AND external_id = ?",
              )
              .get(p.ref.tool, p.ref.externalId);
            if (!r) continue;
            if (r.live_status !== p.status || r.live_pid !== (p.pid ?? null)) changed.add(r.id);
            this.#o.sqlite.run(
              "UPDATE ai_session SET live_status = ?, live_pid = ?, live_checked_at = ? WHERE id = ?",
              [p.status, p.pid ?? null, this.#o.clock.now(), r.id],
            );
          }
          const seen = new Set(
            probes.filter((p) => p.status !== "gone").map((p) => p.ref.externalId),
          );
          for (const id of applyLiveSweep(
            this.#sink,
            { id: a.row.id, tool: a.row.tool, rootPath: a.row.root_path },
            seen,
          )) {
            changed.add(id);
          }
        });
        tx();
        if (changed.size > 0 || limits) this.#o.onChanged(changed);
      } catch (e) {
        this.#o.logger.warn("ingest.live_failed", {
          tool: meta(a.adapter.tool),
          ...errorFields(e),
        });
      }
    }
  }

  #watchAll(): void {
    for (const [sourceId, a] of this.#sources) {
      for (const spec of a.adapter.watch(a.root)) {
        const k = `${sourceId}\0${spec.dir}`;
        if (this.#watchers.has(k)) continue;
        if (!existsSync(spec.dir)) {
          // 監視先が未作成（ai-session-ingestion 3.5）: 存在する最も近い親を見張り、作られたら張り直す
          this.#watchParent(spec.dir);
          continue;
        }
        try {
          const w = watch(spec.dir, { recursive: spec.recursive }, (_ev, filename) => {
            if (!filename) return;
            const abs = `${spec.dir}/${filename.toString()}`;
            if (!spec.match(abs)) return;
            if (abs.includes("/sessions/") && /\/\d+\.json$/.test(abs)) {
              this.#scheduleLive();
              return;
            }
            const stream = a.adapter.streamFor(a.root, abs);
            if (!stream) return;
            const mtime = mtimeOf(abs);
            // 新しく作られた rollout も、次の列挙を待たずに軽い走査の対象にする（その後の追記は監視に来ない）
            if (spec.pollEveryMs !== undefined)
              this.#pollSet(sourceId, spec.dir).set(stream.key, { path: abs, mtime });
            this.#enqueue({ sourceId, stream, mtimeMs: mtime, bulk: false });
          });
          w.on("error", () => {
            w.close();
            this.#watchers.delete(k);
          });
          this.#watchers.set(k, w);
        } catch (e) {
          this.#o.logger.warn("ingest.watch_failed", { dir: meta(spec.dir), ...errorFields(e) });
        }
      }
    }
  }

  /**
   * いま書いたファイルをすぐ取り込む（報告の受け口。ADR 0021）。そのツールの有効な取り込み元のストリームなら、待たずに
   * キューに入れて true。同意の前・取り込み元が無効なら false（次に読めるようになったときに取り込む）
   */
  ingestPath(tool: string, abs: string): boolean {
    if (!this.consented || !this.#begun) return false;
    for (const [sourceId, a] of this.#sources) {
      if (a.adapter.tool !== tool) continue;
      const stream = a.adapter.streamFor(a.root, abs);
      if (!stream) continue;
      this.#enqueue({ sourceId, stream, mtimeMs: mtimeOf(abs), bulk: false }, 0);
      return true;
    }
    return false;
  }

  #pollSet(sourceId: string, dir: string): Map<string, { path: string; mtime: number }> {
    let bySpec = this.#polled.get(sourceId);
    if (!bySpec) {
      bySpec = new Map();
      this.#polled.set(sourceId, bySpec);
    }
    let set = bySpec.get(dir);
    if (!set) {
      set = new Map();
      bySpec.set(dir, set);
    }
    return set;
  }

  /** 列挙の結果から軽い走査の対象を入れ直す（live / recent のもの。古いものは 60 秒ごとの再走査に任せる） */
  #resetPolled(
    sourceId: string,
    specs: readonly WatchSpec[],
    streams: readonly { s: StreamSpec; m: number }[],
  ): void {
    for (const spec of specs) {
      if (spec.pollEveryMs === undefined) continue;
      const set = this.#pollSet(sourceId, spec.dir);
      set.clear();
      for (const { s, m } of streams) {
        if (s.priority === "backfill" || !s.path.startsWith(`${spec.dir}/`) || !spec.match(s.path))
          continue;
        set.set(s.key, { path: s.path, mtime: m });
      }
    }
  }

  /**
   * 軽い走査（WatchSpec.pollEveryMs）: 対象のストリームの mtime だけを見て、変わったものを読む。中身は読まない。
   * 間隔が来た監視先だけを見る。投入した数を返す
   */
  pollChanged(): number {
    // 対象は列挙（scanAll）と監視が入れる。同意の前は列挙しないので空
    if (this.#stopped || !this.consented) return 0;
    const now = this.#o.clock.now();
    let n = 0;
    for (const [sourceId, bySpec] of this.#polled) {
      const a = this.#sources.get(sourceId);
      if (!a) continue;
      for (const spec of a.adapter.watch(a.root)) {
        if (spec.pollEveryMs === undefined) continue;
        const set = bySpec.get(spec.dir);
        if (!set || set.size === 0) continue;
        const k = `${sourceId}\0${spec.dir}`;
        if (now - (this.#polledAt.get(k) ?? 0) < spec.pollEveryMs) continue;
        this.#polledAt.set(k, now);
        for (const [key, e] of set) {
          const m = mtimeOf(e.path);
          if (m === e.mtime) continue;
          e.mtime = m;
          const stream = a.adapter.streamFor(a.root, e.path);
          if (!stream || stream.key !== key) continue;
          this.#enqueue({ sourceId, stream, mtimeMs: m, bulk: false });
          n++;
        }
      }
    }
    return n;
  }

  #watchParent(dir: string): void {
    let p = dirname(dir);
    while (p !== "/" && !existsSync(p)) p = dirname(p);
    const k = `parent\0${p}`;
    if (this.#watchers.has(k)) return;
    try {
      const w = watch(p, { recursive: false }, () => {
        if (!existsSync(dir)) return;
        w.close();
        this.#watchers.delete(k);
        this.#watchAll();
        void this.scanAll();
      });
      w.on("error", () => {
        w.close();
        this.#watchers.delete(k);
      });
      this.#watchers.set(k, w);
    } catch {}
  }

  #scheduleLive(): void {
    if (this.#liveTimer) return;
    this.#liveTimer = setTimeout(() => {
      this.#liveTimer = null;
      void this.probeLive();
    }, 300);
  }

  /** Turnlane の spool（自分のデータ）のうち、7日より古く取り込み済みのものを消す */
  #cleanSpool(): void {
    for (const [sourceId, a] of this.#sources) {
      if (!isInternalSource(a.adapter.tool) || !existsSync(a.root.rootPath)) continue;
      const own = a.adapter.tool === "report" ? /^report-\d{8}\.jsonl$/ : /^hooks-\d{8}\.jsonl$/;
      for (const name of readdirSync(a.root.rootPath)) {
        if (!own.test(name)) continue;
        const p = `${a.root.rootPath}/${name}`;
        try {
          const st = statSync(p);
          const c = loadCursor(this.#o.sqlite, sourceId, name);
          if (this.#o.clock.now() - st.mtimeMs > SPOOL_KEEP_MS && c && c.byte_offset >= st.size) {
            rmSync(p);
            this.#o.sqlite.run("DELETE FROM ingest_cursor WHERE source_id = ? AND stream_key = ?", [
              sourceId,
              name,
            ]);
          }
        } catch {}
      }
    }
  }

  #trackHealth(
    sourceId: string,
    key: string,
    stats: { records: number; missingRequired: number; unknownTypes: number },
    events: readonly { kind: string; clientVersion?: string }[],
  ): void {
    let m = this.#health.get(sourceId);
    if (!m) {
      m = new Map();
      this.#health.set(sourceId, m);
    }
    const prev = m.get(key) ?? { records: 0, missingRequired: 0, unknownTypes: 0 };
    m.set(key, {
      records: prev.records + stats.records,
      missingRequired: prev.missingRequired + stats.missingRequired,
      unknownTypes: prev.unknownTypes + stats.unknownTypes,
    });
    const v = [...events]
      .reverse()
      .find((e) => e.kind === "session_seen" && e.clientVersion)?.clientVersion;
    if (v)
      this.#o.sqlite.run("UPDATE ai_source SET detected_version = ? WHERE id = ?", [v, sourceId]);
  }

  #updateHealth(): void {
    let changed = false;
    for (const [sourceId, a] of this.#sources) {
      const row = this.#o.sqlite
        .query<SourceRow, [string]>("SELECT * FROM ai_source WHERE id = ?")
        .get(sourceId);
      if (!row) continue;
      const h = assessHealth({
        streams: [...(this.#health.get(sourceId)?.values() ?? [])],
        hooksReceiving:
          row.last_hook_at !== null && this.#o.clock.now() - row.last_hook_at < 86_400_000,
        versionOk:
          !row.detected_version || satisfiesRange(row.detected_version, a.adapter.testedVersions),
        detectedVersion: row.detected_version,
        testedVersions: a.adapter.testedVersions,
      });
      if (h.level !== row.health_level || h.reason !== row.health_reason) {
        this.#o.sqlite.run(
          "UPDATE ai_source SET health_level = ?, health_reason = ?, updated_at = ? WHERE id = ?",
          [h.level, h.reason, this.#o.clock.now(), sourceId],
        );
        changed = true;
      }
    }
    if (changed) this.#o.onSourceChanged?.();
  }

  #afterJob(): void {
    this.#o.onProgress?.();
    if (this.#hadBulk && !this.bulkImporting) {
      this.#hadBulk = false;
      try {
        this.#o.onBulkDone?.();
      } catch (e) {
        this.#o.logger.warn("ingest.bulk_done_failed", errorFields(e));
      }
    }
  }

  /** テスト・turnlane sources health 用: 今すぐ health を計算して保存する */
  refreshHealth(): void {
    this.#updateHealth();
  }
}

function mtimeOf(path: string): number {
  try {
    return Math.floor(statSync(path).mtimeMs);
  } catch {
    return 0;
  }
}

/**
 * セッションの数に数えるストリーム（検出の件数）: ルート直下の索引（Codex の session_index.jsonl）と、
 * サブエージェントのトランスクリプトを除く
 */
function isSessionStream(s: StreamSpec): boolean {
  return s.key.includes("/") && !s.key.includes("/subagents/");
}
