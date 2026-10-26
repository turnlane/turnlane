/**
 * 壁打ち（D-135）の結合テスト: Codex のプロジェクト外の会話（~/Documents/Codex/<日付>/<名前>）と、設定で印を付けた
 * フォルダの Claude Code のセッション。取り込み → 判定 → API まで通す。時計と git は偽物。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { putSetting, taskDisplayTitle } from "@turnlane/core";
import type { WorkItemDetail } from "@turnlane/core/api";
import { type AiEnv, makeAiEnv, present } from "./helpers/env.ts";
import { claudeTranscript, codexRollout } from "./helpers/transcript.ts";

let env: AiEnv;
afterEach(async () => {
  await env?.cleanup();
});

const MIN = 60_000;
const T0 = Date.UTC(2026, 8, 14, 1, 0); // 2026-09-14 10:00 JST
/** 最初の依頼の文から作られたフォルダ名の代わり（DB・API に残らないこと） */
const SLUG = "SENTINEL-plan-the-team-offsite";
const SID = "22222222-0000-4000-8000-000000000135";

const q = <T>(sql: string, ...args: (string | number)[]) =>
  env.sqlite.query<T, (string | number)[]>(sql).all(...args);

function setup() {
  env = makeAiEnv({ now: T0 });
  present(env.sqlite, T0 - 60 * MIN, T0 + 14 * 60 * MIN);
  const cwd = join(env.home, "Documents/Codex/2026-09-14", SLUG);
  return codexRollout(join(env.home, ".codex"), { sid: SID, cwd, at: T0 - 5 * MIN });
}

/** 取り込み系のテーブルと API の応答のどこにも、フォルダ名が残っていない */
function expectNoSlug() {
  const dump = JSON.stringify([
    q("SELECT * FROM ai_session"),
    q("SELECT * FROM ai_turn"),
    q("SELECT * FROM hook_event"),
    q("SELECT * FROM ingest_cursor"),
    q("SELECT * FROM work_item"),
    q("SELECT * FROM task"),
    env.ai.deps.queue(),
    env.ai.deps.days("2026-09-14", 1),
  ]);
  expect(dump).not.toContain("SENTINEL");
}

describe("壁打ち: Codex のプロジェクト外の会話（D-135）", () => {
  test("作業フォルダは日付までに切り落として保存し、カードは壁打ち。質問で終われば自分の番", async () => {
    const r = setup();
    r.threadName(T0 - 4 * MIN, "Offsite plan");
    r.turn(T0 - 4 * MIN, T0, "Which city should we pick?");
    env.clock.set(T0 + 1 * MIN);
    await env.sync();
    expect(q("SELECT cwd, repo_root, entrypoint FROM ai_session")).toEqual([
      {
        cwd: join(env.home, "Documents/Codex/2026-09-14"),
        repo_root: null,
        entrypoint: "Codex Desktop",
      },
    ]);
    expect(q("SELECT DISTINCT cwd FROM ai_turn")).toEqual([
      { cwd: join(env.home, "Documents/Codex/2026-09-14") },
    ]);
    const [wi] = q<{ id: string; scratch: number; repo_root: string | null; status: string }>(
      "SELECT id, scratch, repo_root, status FROM work_item",
    );
    expect(wi).toMatchObject({ scratch: 1, repo_root: null, status: "your_turn" });
    const day = env.ai.deps.days("2026-09-14", 1).days[0];
    expect(day?.items.map((x) => [x.title, x.scratch, x.repoRoot])).toEqual([
      ["Offsite plan", true, null],
    ]);
    const detail = env.ai.deps.detail(wi?.id as string) as WorkItemDetail;
    expect(detail.workItem.scratch).toBe(true);

    // 自分の番の判定は今のまま（質問で終わったターンから15分で返答タスク）
    env.clock.set(T0 + 16 * MIN);
    env.ai.runner.runOnce();
    const queue = env.ai.deps.queue();
    expect(queue.map((x) => [x.scratch, x.repoRoot, x.followUps.map((f) => f.kind)])).toEqual([
      [true, null, ["reply"]],
    ]);
    const [task] = q<{ title: string; title_key: string; title_params: string }>(
      "SELECT title, title_key, title_params FROM task",
    );
    expect(JSON.parse(task?.title_params ?? "{}")).toMatchObject({ repo: null, scratch: true });
    expectNoSlug();
  });

  test("質問で終わらなければ自分の番にしない（done）", async () => {
    const r = setup();
    r.turn(T0 - 4 * MIN, T0, "Here is a draft agenda.");
    env.clock.set(T0 + 30 * MIN);
    await env.sync();
    expect(q("SELECT status, scratch FROM work_item")).toEqual([{ status: "done", scratch: 1 }]);
    expect(q("SELECT * FROM follow_up")).toHaveLength(0);
  });

  test("題名を保存しない設定でもフォルダ名を落とし、返答タスクの題名は「壁打ち」", async () => {
    const r = setup();
    putSetting(env.mutate, "privacy", { storeTitles: false });
    r.threadName(T0 - 4 * MIN, "Offsite plan");
    r.turn(T0 - 4 * MIN, T0, "Which city should we pick?");
    env.clock.set(T0 + 16 * MIN);
    await env.sync();
    env.ai.runner.runOnce();
    expect(q("SELECT title FROM ai_session")).toEqual([{ title: null }]);
    const [task] = q<{ title: string; title_key: string; title_params: string }>(
      "SELECT title, title_key, title_params FROM task",
    );
    const row = {
      title: task?.title ?? "",
      titleKey: task?.title_key ?? null,
      titleParams: task?.title_params ?? null,
    };
    expect(taskDisplayTitle(row, "ja")).toBe("返答: 壁打ち");
    expect(taskDisplayTitle(row, "en")).toBe("Reply: Scratch");
    expectNoSlug();
  });

  test("CLI で ~/Documents/Codex の下で始めた会話も壁打ち", async () => {
    env = makeAiEnv({ now: T0 });
    const cwd = join(env.home, "Documents/Codex/2026-09-14", SLUG);
    const r = codexRollout(join(env.home, ".codex"), {
      sid: SID,
      cwd,
      at: T0 - 5 * MIN,
      originator: "codex_cli_rs",
    });
    r.turn(T0 - 4 * MIN, T0, "Done.");
    env.clock.set(T0 + 1 * MIN);
    await env.sync();
    expect(q("SELECT scratch FROM work_item")).toEqual([{ scratch: 1 }]);
    expectNoSlug();
  });
});

describe("壁打ち: ほかのツールでも ~/Documents/Codex の下のフォルダ名は落とす（D-135・D-136）", () => {
  /** DB のすべてのテーブルと API の応答（一覧・詳細・取り込み元） */
  function dumpAll(): string {
    const tables = q<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    ).map((x) => x.name);
    const ids = q<{ id: string }>("SELECT id FROM work_item").map((x) => x.id);
    return JSON.stringify([
      tables.map((t) => q(`SELECT * FROM "${t}"`)),
      env.ai.deps.queue(),
      env.ai.deps.queueExtras(),
      env.ai.deps.days("2026-09-14", 1),
      ids.map((id) => env.ai.deps.detail(id)),
      env.ai.deps.sources(),
    ]);
  }

  test("Claude Code を Codex の作ったフォルダで動かしたセッション: フォルダ名は DB にも API にも残らない", async () => {
    env = makeAiEnv({ now: T0 });
    present(env.sqlite, T0 - 60 * MIN, T0 + 14 * 60 * MIN);
    // Claude Code はトランスクリプトを projects/<cwd を符号化した名前>/<sid>.jsonl に置く（フォルダ名を含む）
    const tr = claudeTranscript(join(env.home, ".claude"), {
      sid: "44444444-0000-4000-8000-000000000135",
      cwd: join(env.home, "Documents/Codex/2026-09-14", SLUG),
      branch: "",
    });
    expect(tr.path).toContain(SLUG);
    tr.human(T0 - 2 * MIN);
    tr.assistantEnd(T0, "Done.");
    env.clock.set(T0 + 1 * MIN);
    await env.sync();
    expect(q("SELECT cwd FROM ai_session")).toEqual([
      { cwd: join(env.home, "Documents/Codex/2026-09-14") },
    ]);
    expect(q("SELECT DISTINCT cwd FROM ai_turn")).toEqual([
      { cwd: join(env.home, "Documents/Codex/2026-09-14") },
    ]);
    expect(q("SELECT scratch FROM work_item")).toEqual([{ scratch: 1 }]);
    // トランスクリプトの置き場所は日付までのキーで持つ（実際のパスは列挙で毎回得る）
    const enc = join(env.home, "Documents/Codex/2026-09-14").replaceAll(/[/.]/g, "-");
    expect(q("SELECT stream_key FROM ingest_cursor WHERE parser_id LIKE 'claude%'")).toEqual([
      { stream_key: `projects/${enc}/44444444-0000-4000-8000-000000000135.jsonl` },
    ]);
    expect(q("SELECT file_path, transcript_missing_at FROM ai_session")).toEqual([
      {
        file_path: join(
          env.home,
          ".claude/projects",
          enc,
          "44444444-0000-4000-8000-000000000135.jsonl",
        ),
        transcript_missing_at: null,
      },
    ]);
    expect(dumpAll()).not.toContain("SENTINEL");

    // 続きも同じキーのカーソルから読む（消えたファイルとして扱わない）
    tr.human(T0 + 10 * MIN);
    tr.assistantEnd(T0 + 12 * MIN, "Which one should I keep?");
    env.clock.set(T0 + 13 * MIN);
    await env.sync();
    expect(q("SELECT count(*) AS n FROM ai_turn")).toEqual([{ n: 2 }]);
    expect(q("SELECT count(*) AS n FROM ingest_cursor WHERE parser_id LIKE 'claude%'")).toEqual([
      { n: 1 },
    ]);
    expect(q("SELECT transcript_missing_at FROM ai_session")).toEqual([
      { transcript_missing_at: null },
    ]);
    env.clock.set(T0 + 30 * MIN);
    env.ai.runner.runOnce();
    expect(env.ai.deps.queue().map((x) => [x.scratch, x.repoRoot])).toEqual([[true, null]]);
    expect(dumpAll()).not.toContain("SENTINEL");

    // ファイルが消えたら（30日削除）、日付までのキーのまま消えた印を付ける
    rmSync(tr.path);
    await env.sync();
    expect(
      q<{ missing: number }>("SELECT transcript_missing_at IS NOT NULL AS missing FROM ai_session"),
    ).toEqual([{ missing: 1 }]);
    expect(dumpAll()).not.toContain("SENTINEL");
  });
});

describe("壁打ち: 設定で印を付けたフォルダ（D-135）", () => {
  test("印のフォルダの Claude Code のセッションは、git の中でもリポジトリにせず壁打ちとして出す", async () => {
    env = makeAiEnv({ now: T0 });
    present(env.sqlite, T0 - 60 * MIN, T0 + 14 * 60 * MIN);
    const dir = join(env.home, "scratch");
    env.git.repos.set(dir, dir);
    env.git.defaults.set(dir, "main");
    const tr = claudeTranscript(join(env.home, ".claude"), {
      sid: "33333333-0000-4000-8000-000000000135",
      cwd: dir,
      branch: "main",
    });
    tr.human(T0 - 2 * MIN);
    tr.assistantEnd(T0, "Want me to compare the two options?");
    env.clock.set(T0 + 1 * MIN);
    await env.sync();
    // 印を付ける前はリポジトリの作業
    expect(q("SELECT scratch, repo_root FROM work_item")).toEqual([{ scratch: 0, repo_root: dir }]);

    putSetting(env.mutate, "ai.scratch_dirs", [dir]);
    env.ai.runner.runOnce();
    expect(q("SELECT scratch, repo_root FROM work_item")).toEqual([
      { scratch: 1, repo_root: null },
    ]);
    // プロジェクトの一覧（設定 > プロジェクトのリポジトリの候補）に出さない
    expect(
      q("SELECT repo_root FROM work_item WHERE repo_root IS NOT NULL AND deleted_at IS NULL"),
    ).toEqual([]);
    env.clock.set(T0 + 16 * MIN);
    env.ai.runner.runOnce();
    expect(env.ai.deps.queue().map((x) => [x.scratch, x.repoRoot])).toEqual([[true, null]]);

    // 印を外せば元に戻る
    putSetting(env.mutate, "ai.scratch_dirs", []);
    env.ai.runner.runOnce();
    expect(q("SELECT scratch, repo_root FROM work_item")).toEqual([{ scratch: 0, repo_root: dir }]);
  });
});
