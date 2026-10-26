/**
 * 日報の AI 要約のジョブ（M4-6。phase0-plan 4.6 の「日報の AI 要約の仕様」、ADR 0005 の追記）。
 *
 * - 同時に1件。新しく始めると実行中のものは取り消す（日報を直した後の作り直し、Retry）
 * - 成功したら daily_note.ai_summary_md / ai_summary_tool / ai_summary_at に保存し、SSE `daily_note` を送る
 * - 失敗（CLI が無い・時間切れ・終了コード非0・空・長すぎ）は要約なし。理由はメモリにだけ持ち、日報の画面に1行で出す
 * - 日報の保存（Close the day）は要約を待たない。要約は届いたら保存する
 * - ログは理由と所要時間だけ（stdout / stderr の中身は書かない）
 */
import type { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { errorFields, type MetaOnlyLogger, meta } from "@turnlane/collectors";
import {
  buildSummaryInput,
  type Clock,
  getSetting,
  insertRow,
  type MutateCtx,
  putSetting,
  type SummaryFailure,
  type SummaryTool,
  schema,
  type TurnlaneSettings,
  updateRow,
} from "@turnlane/core";
import type {
  DailySummaryView,
  ReportLocale,
  SummaryToolsResponse,
  SummaryToolView,
} from "@turnlane/core/api";
import { OpError } from "../derive/ops.ts";
import { childEnv, type DetectedCli, type DetectOptions, detectCli, runSummaryCli } from "./cli.ts";

export interface SummaryServiceOptions {
  sqlite: Database;
  mutate: MutateCtx;
  clock: Clock;
  settings: () => TurnlaneSettings;
  logger: MetaOnlyLogger;
  /** 要約専用の作業ディレクトリ（取り込みから除外する） */
  workDir: string;
  detect: DetectOptions;
  /** その日の日報の Markdown（確定済みなら report_md、未確定なら今の事実から組み立てたもの） */
  markdown: (date: string, locale: ReportLocale) => string;
  /** 画面の言語 */
  locale: () => ReportLocale;
  publish: (dates: string[]) => void;
  /** SIGTERM から SIGKILL までの猶予（テスト用） */
  killGraceMs?: number;
}

type Job =
  | {
      state: "running";
      date: string;
      tool: SummaryTool;
      startedAt: number;
      abort: AbortController;
      done: Promise<void>;
    }
  | { state: "failed"; date: string; tool: SummaryTool; failure: SummaryFailure; at: number };

interface NoteRow {
  id: string;
  ai_summary_md: string | null;
  ai_summary_tool: SummaryTool | null;
  ai_summary_at: number | null;
}

export class SummaryService {
  readonly #o: SummaryServiceOptions;
  /** 実行中の1件 */
  #current: Extract<Job, { state: "running" }> | null = null;
  /** 日付ごとの最後の失敗（メモリだけ） */
  readonly #failed = new Map<string, Extract<Job, { state: "failed" }>>();
  #detected = new Map<SummaryTool, DetectedCli>();

  constructor(o: SummaryServiceOptions) {
    this.#o = o;
  }

  get workDir(): string {
    return this.#o.workDir;
  }

  #note(date: string): NoteRow | null {
    return this.#o.sqlite
      .query<NoteRow, [string]>(
        "SELECT id, ai_summary_md, ai_summary_tool, ai_summary_at FROM daily_note WHERE date = ? AND deleted_at IS NULL",
      )
      .get(date);
  }

  #save(date: string, p: { md: string | null; tool: SummaryTool | null }): void {
    const patch = {
      aiSummaryMd: p.md,
      aiSummaryTool: p.tool,
      aiSummaryAt: p.md === null ? null : this.#o.clock.now(),
    };
    const row = this.#note(date);
    if (row) updateRow(this.#o.mutate, schema.dailyNote, row.id, patch);
    else insertRow(this.#o.mutate, schema.dailyNote, { date, ...patch });
  }

  /** 日報の画面に出す状態 */
  view(date: string): DailySummaryView {
    const s = this.#o.settings().aiSummary;
    const n = this.#note(date);
    const cur = this.#current?.date === date ? this.#current : null;
    const failed = this.#failed.get(date) ?? null;
    return {
      enabled: s.enabled,
      configuredTool: s.tool,
      md: n?.ai_summary_md ?? null,
      tool: n?.ai_summary_tool ?? null,
      at: n?.ai_summary_at ?? null,
      job: cur
        ? { state: "running", tool: cur.tool, startedAt: cur.startedAt }
        : failed
          ? { state: "failed", tool: failed.tool, failure: failed.failure, at: failed.at }
          : null,
    };
  }

  /** 検出（結果はメモリに置く）。見つけた bin は設定の bin が未設定なら保存する */
  async detect(tool: SummaryTool, refresh = false): Promise<DetectedCli> {
    const s = this.#o.settings().aiSummary;
    const settingBin = s.tool === tool ? s.bin : null;
    const cached = this.#detected.get(tool);
    if (cached && !refresh && (settingBin === null || cached.bin === settingBin)) return cached;
    const d = await detectCli(tool, settingBin, this.#o.detect);
    this.#detected.set(tool, d);
    return d;
  }

  /** 選んでいるツールの bin を設定に書く（未設定のときだけ） */
  rememberBin(d: DetectedCli): void {
    const raw = getSetting<Record<string, unknown>>(this.#o.mutate.db, "report.ai_summary") ?? {};
    const s = this.#o.settings().aiSummary;
    if (!d.bin || s.bin !== null || s.tool !== d.tool) return;
    putSetting(this.#o.mutate, "report.ai_summary", { ...raw, bin: d.bin });
  }

  /** Claude の設定ディレクトリ（検出した取り込み元。古いものから） */
  claudeConfigDirs(): string[] {
    return this.#o.sqlite
      .query<{ root_path: string }, []>(
        "SELECT root_path FROM ai_source WHERE tool = 'claude_code' ORDER BY created_at, root_path",
      )
      .all()
      .map((r) => r.root_path);
  }

  async tools(refresh: boolean): Promise<SummaryToolsResponse> {
    const tools: SummaryToolView[] = [];
    for (const t of ["claude_code", "codex"] as const) {
      const d = await this.detect(t, refresh);
      // 有効にしたら（設定画面の On）、見つけた絶対パスを bin に保存する
      if (this.#o.settings().aiSummary.enabled) this.rememberBin(d);
      tools.push({
        tool: t,
        bin: d.bin,
        foundBy: d.foundBy,
        flags: d.flags,
        missingFlags: d.missingFlags,
      });
    }
    return { tools, claudeConfigDirs: this.claudeConfigDirs(), workDir: this.#o.workDir };
  }

  /** 実行中のものを取り消す（手で直した要約を上書きしないように） */
  cancel(date?: string): void {
    const cur = this.#current;
    if (!cur || (date !== undefined && cur.date !== date)) return;
    cur.abort.abort();
    this.#current = null;
  }

  /** POST /api/daily-notes/:date/summary: 作る・作り直す（実行中のものは取り消す）。結果は SSE で知らせる */
  start(date: string, locale: ReportLocale = this.#o.locale()): DailySummaryView {
    const s = this.#o.settings().aiSummary;
    if (!s.enabled) throw new OpError(409, "summary_disabled");
    this.cancel();
    this.#failed.delete(date);
    const abort = new AbortController();
    const job = {
      state: "running" as const,
      date,
      tool: s.tool,
      startedAt: this.#o.clock.now(),
      abort,
      done: Promise.resolve(),
    };
    this.#current = job;
    job.done = this.#run(job, locale).catch((e) => {
      this.#o.logger.warn("summary.crashed", errorFields(e));
    });
    this.#o.publish([date]);
    return this.view(date);
  }

  /** テスト・停止用: 実行中のジョブの終わりを待つ */
  async whenIdle(): Promise<void> {
    await this.#current?.done;
  }

  async #run(job: Extract<Job, { state: "running" }>, locale: ReportLocale): Promise<void> {
    const o = this.#o;
    const s = o.settings().aiSummary;
    const began = o.clock.now();
    const finish = (r: { ok: true; text: string } | { ok: false; failure: SummaryFailure }) => {
      // 取り消されたもの（別の実行・手での編集）は何も残さない
      if (this.#current !== job || job.abort.signal.aborted) return;
      this.#current = null;
      if (r.ok) {
        this.#save(job.date, { md: r.text, tool: job.tool });
        o.logger.info("summary.done", {
          date: meta(job.date),
          tool: meta(job.tool),
          ms: o.clock.now() - began,
          chars: r.text.length,
        });
      } else {
        this.#failed.set(job.date, {
          state: "failed",
          date: job.date,
          tool: job.tool,
          failure: r.failure,
          at: o.clock.now(),
        });
        o.logger.warn("summary.failed", {
          date: meta(job.date),
          tool: meta(job.tool),
          reason: meta(r.failure.kind),
          ...(r.failure.kind === "exit" ? { exit_code: r.failure.code } : {}),
          ms: o.clock.now() - began,
        });
      }
      o.publish([job.date]);
    };
    const d = await this.detect(job.tool);
    if (!d.bin) return finish({ ok: false, failure: { kind: "not_found" } });
    this.rememberBin(d);
    mkdirSync(o.workDir, { recursive: true, mode: 0o700 });
    // 日報の Markdown だけを渡す（ADR 0005 の追記）
    const input = buildSummaryInput(o.markdown(job.date, locale), locale);
    const claudeDir =
      job.tool === "claude_code"
        ? (s.claudeConfigDir ??
          (() => {
            const dirs = this.claudeConfigDirs();
            return dirs.length > 1 ? dirs[0] : undefined;
          })())
        : undefined;
    const r = await runSummaryCli({
      tool: job.tool,
      bin: d.bin,
      flags: d.flags,
      workDir: o.workDir,
      input,
      timeoutMs: s.timeoutMs,
      env: childEnv(d.bin, claudeDir ? { CLAUDE_CONFIG_DIR: claudeDir } : {}),
      signal: job.abort.signal,
      ...(o.killGraceMs !== undefined ? { killGraceMs: o.killGraceMs } : {}),
    });
    finish(r);
  }

  /** PUT /api/daily-notes/:date/summary: 手で直した要約（null・空で消す）。実行中のものは取り消す */
  put(date: string, summary: string | null): DailySummaryView {
    this.cancel(date);
    this.#failed.delete(date);
    const md = summary?.trim() ? summary.trim() : null;
    const prev = this.#note(date);
    this.#save(date, { md, tool: md === null ? null : (prev?.ai_summary_tool ?? null) });
    this.#o.publish([date]);
    return this.view(date);
  }

  stop(): void {
    this.cancel();
  }
}
