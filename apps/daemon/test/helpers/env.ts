/** daemon のテスト用の環境（一時 HOME、匿名化フィクスチャ、DB） */
import type { Database } from "bun:sqlite";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtinAdapters, nullLogger } from "@turnlane/collectors";
import {
  type Clock,
  createDb,
  ensureSelfDevice,
  FakeClock,
  HlcClock,
  type MutateCtx,
  migrate,
  migrations,
  openDatabase,
  putSetting,
} from "@turnlane/core";
import { type AiSystem, createAiSystem } from "../../src/ai.ts";
import type { GhClient } from "../../src/github/pr-poller.ts";
import { SseHub } from "../../src/http/sse.ts";
import { FakeGit } from "../../src/ingest/git.ts";
import type { CodexProcessProbe } from "../../src/ingest/supervisor.ts";
import { Supervisor } from "../../src/ingest/supervisor.ts";
import { ClaudeLimitsStore } from "../../src/limits/claude.ts";
import { seedPresence } from "../../src/presence/service.ts";
import { FakeOpenSystem } from "./open-system.ts";

export const FIXTURES = join(import.meta.dir, "../../../../packages/collectors/test/fixtures");

export interface TestEnv {
  home: string;
  dataDir: string;
  sqlite: Database;
  clock: FakeClock;
  git: FakeGit;
  changed: Set<string>;
  supervisor: Supervisor;
  cleanup(): Promise<void>;
}

/** Claude のフィクスチャのケースを一時 HOME の ~/.claude 配下に置く */
export function installClaudeCase(home: string, caseName: string, profile = ".claude"): void {
  const src = join(FIXTURES, "claude_code/2.1.x", caseName, "projects");
  const dst = join(home, profile, "projects");
  mkdirSync(dst, { recursive: true });
  cpSync(src, dst, { recursive: true });
}

export function installCodexCase(home: string, caseName: string): void {
  cpSync(join(FIXTURES, "codex/0.147.x", caseName), join(home, ".codex"), { recursive: true });
}

export function makeEnv(opts: { clock?: Clock; now?: number } = {}): TestEnv {
  const home = mkdtempSync(join(tmpdir(), "turnlane-daemon-"));
  const dataDir = join(home, "data");
  mkdirSync(dataDir, { recursive: true });
  const sqlite = openDatabase(join(dataDir, "turnlane.db"));
  migrate(sqlite, migrations);
  const clock = new FakeClock(opts.now ?? Date.UTC(2026, 8, 3));
  const git = new FakeGit();
  const changed = new Set<string>();
  const supervisor = new Supervisor({
    sqlite,
    clock,
    logger: nullLogger,
    adapters: builtinAdapters,
    git,
    env: { home, vars: { TURNLANE_DATA_DIR: dataDir } },
    settings: () => ({ tz: "Asia/Tokyo", dayBoundary: 240, storeTitles: true }),
    onChanged: (ids) => {
      for (const id of ids) changed.add(id);
    },
    noWatch: true,
    debounceMs: 0,
    reconcileMs: 3_600_000,
    liveMs: 3_600_000,
  });
  return {
    home,
    dataDir,
    sqlite,
    clock,
    git,
    changed,
    supervisor,
    async cleanup() {
      await supervisor.stop();
      sqlite.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/** 取り込み系テーブルの内容（id・作成時刻など実行ごとに変わる列を除く） */
export function ingestSnapshot(db: Database): unknown {
  const q = (sql: string) => db.query(sql).all();
  return {
    sessions: q(
      "SELECT tool, external_id, (SELECT external_id FROM ai_session p WHERE p.id = s.parent_session_id) AS parent, is_subagent, entrypoint, client_version, model, cwd, repo_root, title, title_source, started_at, last_activity_at, ended_at, archived, has_human_input, is_noise, transcript_missing_at IS NOT NULL AS missing FROM ai_session s ORDER BY tool, external_id",
    ),
    turns: q(
      "SELECT s.external_id, t.turn_key, t.started_at, t.ended_at, t.duration_ms, t.local_date, t.status, t.ended_with, t.initiator, t.git_branch, t.cwd, t.input_tokens, t.output_tokens, t.cache_read_tokens, t.tool_counts_json, t.edited_files_count, t.pending_question, t.closing_question FROM ai_turn t JOIN ai_session s ON s.id = t.session_id ORDER BY s.external_id, t.started_at, t.turn_key",
    ),
    artifacts: q("SELECT kind, ref, url, first_seen_at FROM ai_artifact ORDER BY kind, ref"),
    hooks: q(
      "SELECT tool, config_root, hook_event_name, session_external_id, agent_id, agent_type, permission_mode, notification_type, error_type, occurred_at, spool_file, spool_offset FROM hook_event ORDER BY spool_file, spool_offset",
    ),
  };
}

export interface AiEnv {
  home: string;
  dataDir: string;
  sqlite: Database;
  clock: FakeClock;
  git: FakeGit;
  mutate: MutateCtx;
  ai: AiSystem;
  hub: SseHub;
  /** タスクから開く（D-059）の OS の偽物（起動した引数を記録する） */
  open: FakeOpenSystem;
  /** Claude の利用枠の記録先（statusLine の受け口と `.claude.json` のキャッシュ） */
  limits: ClaudeLimitsStore;
  /** 全ストリームを読み直してから判定する（fs.watch を使わないテスト用） */
  sync(): Promise<void>;
  cleanup(): Promise<void>;
}

/** supervisor + runner + API の組（実際の gh・launchd・実データには触れない） */
export function makeAiEnv(
  opts: {
    now?: number;
    gh?: GhClient | null;
    excludeDirs?: string[];
    /** Codex のプロセスの確かめ（Issue #10）。既定は「どの pid も動いていない」（実際の OS を見ない） */
    codexProcess?: CodexProcessProbe;
  } = {},
): AiEnv {
  const home = mkdtempSync(join(tmpdir(), "turnlane-ai-"));
  const dataDir = join(home, "data");
  mkdirSync(dataDir, { recursive: true });
  const sqlite = openDatabase(join(dataDir, "turnlane.db"));
  migrate(sqlite, migrations);
  const clock = new FakeClock(opts.now ?? Date.UTC(2026, 8, 14, 1, 0));
  const db = createDb(sqlite);
  const deviceId = ensureSelfDevice(db, clock);
  const mutate: MutateCtx = { db, clock, deviceId, hlc: new HlcClock(deviceId, clock, null) };
  putSetting(mutate, "tz", "Asia/Tokyo");
  const git = new FakeGit();
  const hub = new SseHub();
  const open = new FakeOpenSystem();
  const limits = new ClaudeLimitsStore(sqlite, clock);
  const ai = createAiSystem({
    sqlite,
    limits,
    mutate,
    clock,
    logger: nullLogger,
    hub,
    git,
    home,
    dataDir,
    vars: {},
    gh: opts.gh ?? null,
    noWatch: true,
    // テストは実際に open を実行しない
    openSystem: open,
    ...(opts.excludeDirs ? { excludeDirs: opts.excludeDirs } : {}),
    codexProcess: opts.codexProcess ?? {
      alive: () => false,
      info: () => null,
      terminals: () => [],
      cwd: () => null,
    },
  });
  return {
    open,
    limits,
    home,
    dataDir,
    sqlite,
    clock,
    git,
    mutate,
    ai,
    hub,
    async sync() {
      await ai.supervisor.detect();
      await ai.supervisor.scanAll();
      await ai.supervisor.whenIdle();
      await ai.supervisor.probeLive();
      ai.runner.runOnce();
    },
    async cleanup() {
      await ai.stop();
      sqlite.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/**
 * 在席の区間を入れる（D-105。テストは在席のサンプルを動かさないので、Mac を使っていた時間を直接置く）。
 * 保存は入力のあった区間なので（D-139）、既定の T（5 分）で読んだときに [start, end] になる形で入れる
 */
export function present(sqlite: Database, start: number, end: number): void {
  seedPresence(sqlite, `p-${start}-${end}-${Math.random().toString(36).slice(2, 8)}`, start, end);
}
