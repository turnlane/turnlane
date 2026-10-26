/**
 * derive runner の結合テスト（M1-7〜M1-11）。合成のトランスクリプトを一時 HOME に書き、取り込み → 判定 →
 * フォローアップ → 待ち区間 → API の集計まで通す。時計は偽物、git も偽物（FakeGit）。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { insertRow, newId, putSetting, schema, taskDisplayTitle } from "@turnlane/core";
import type { GhClient, GhPr } from "../src/github/pr-poller.ts";
import {
  type AiEnv,
  installClaudeCase,
  installCodexCase,
  makeAiEnv,
  present,
} from "./helpers/env.ts";
import { claudeTranscript } from "./helpers/transcript.ts";

let env: AiEnv;
afterEach(async () => {
  await env?.cleanup();
});

const MIN = 60_000;
const T0 = Date.UTC(2026, 8, 14, 1, 0); // 2026-09-14 10:00 JST

function setup(opts: Parameters<typeof makeAiEnv>[0] = {}, presence = true) {
  env = makeAiEnv({ now: T0, ...opts });
  // この日は 9:00 から Mac を使い続けている（D-105。放置は在席の間だけ数える）
  if (presence) present(env.sqlite, T0 - 60 * MIN, T0 + 14 * 60 * MIN);
  env.git.repos.set("/w/app", "/w/app");
  env.git.defaults.set("/w/app", "main");
  return claudeTranscript(join(env.home, ".claude"), {
    sid: "11111111-0000-4000-8000-000000000001",
    cwd: "/w/app",
    branch: "feat/login",
  });
}

const q = <T>(sql: string, ...args: (string | number)[]) =>
  env.sqlite.query<T, (string | number)[]>(sql).all(...args);

describe("runner: 状態とフォローアップ（M1 完了条件）", () => {
  test("質問で終わる → 15分で返答タスク（YOUR TURN）→ 返答すると自動で閉じる", async () => {
    const tr = setup();
    tr.human(T0 - 2 * MIN);
    tr.assistantEnd(T0, "Which option do you prefer?");
    env.clock.set(T0 + 1 * MIN);
    await env.sync();
    const [wi] = q<{ id: string; status: string; status_reason: string; group_key: string }>(
      "SELECT id, status, status_reason, group_key FROM work_item",
    );
    expect(wi).toMatchObject({
      status: "your_turn",
      status_reason: "question",
      group_key: "branch:/w/app#feat/login",
    });
    expect(q("SELECT * FROM follow_up")).toHaveLength(0);

    env.clock.set(T0 + 16 * MIN);
    env.ai.runner.runOnce();
    const queue = env.ai.deps.queue();
    expect(queue.map((x) => [x.status, x.followUps.map((f) => f.kind)])).toEqual([
      ["your_turn", ["reply"]],
    ]);
    const [task] = q<{
      title: string;
      title_key: string;
      title_params: string;
      status: string;
      source: string;
      scheduled_date: string;
    }>("SELECT title, title_key, title_params, status, source, scheduled_date FROM task");
    expect(task).toMatchObject({ status: "todo", source: "ai", scheduled_date: "2026-09-14" });
    // 題名は文字列で保存せず、種類とパラメータを保存する（D-046）
    expect(task).toMatchObject({ title: "", title_key: "followup.reply" });
    expect(JSON.parse(task?.title_params ?? "{}")).toMatchObject({
      repo: "app",
      branch: "feat/login",
    });
    const row = {
      title: task?.title ?? "",
      titleKey: task?.title_key ?? null,
      titleParams: task?.title_params ?? null,
    };
    expect(taskDisplayTitle(row, "en").startsWith("Reply: ")).toBe(true);
    expect(taskDisplayTitle(row, "ja").startsWith("返答: ")).toBe(true);
    expect(queue[0]?.followUps[0]?.task?.titleKey).toBe("followup.reply");

    // 返答（同じセッションに人間の入力）
    tr.human(T0 + 20 * MIN);
    env.clock.set(T0 + 20 * MIN + 5000);
    await env.sync();
    const [fu] = q<{ status: string; close_reason: string; closed_at: number }>(
      "SELECT status, close_reason, closed_at FROM follow_up",
    );
    expect(fu).toEqual({
      status: "done",
      close_reason: "auto:human_input",
      closed_at: T0 + 20 * MIN,
    });
    const [t2] = q<{ status: string; auto_completed: number }>(
      "SELECT status, auto_completed FROM task",
    );
    expect(t2).toEqual({ status: "done", auto_completed: 1 });
    expect(q("SELECT source FROM task_time_entry")).toEqual([{ source: "followup_estimate" }]);
    expect(env.ai.deps.queue()).toEqual([]);
    // 状態の履歴
    expect(
      q<{ status: string }>("SELECT status FROM work_item_status_log ORDER BY from_at").map(
        (r) => r.status,
      ),
    ).toEqual(["your_turn", "running"]);
  });

  test("「他に何かありますか？」で終わったら返答タスクを出さない（締めの決まり文句）", async () => {
    const tr = setup();
    tr.human(T0 - 2 * MIN);
    tr.assistantEnd(T0, "修正しました。他に何かありますか？");
    env.clock.set(T0 + 30 * MIN);
    await env.sync();
    expect(q("SELECT status, status_reason FROM work_item")).toEqual([
      { status: "done", status_reason: "ended" },
    ]);
    expect(q("SELECT * FROM follow_up")).toHaveLength(0);
    expect(q("SELECT closing_question FROM ai_turn")).toEqual([{ closing_question: 1 }]);
  });

  test("返答タスクのあるブランチでコミットすると「解決済み（推定）」で閉じ、カードは done", async () => {
    const tr = setup();
    tr.human(T0 - 2 * MIN);
    tr.assistantEnd(T0, "Should I proceed with the migration?");
    env.clock.set(T0 + 16 * MIN);
    await env.sync();
    expect(q("SELECT kind, status FROM follow_up")).toEqual([{ kind: "reply", status: "open" }]);
    env.git.commits.set("/w/app#feat/login", [T0 + 25 * MIN]);
    env.clock.set(T0 + 26 * MIN);
    env.ai.runner.runOnce();
    expect(q("SELECT status, close_reason, closed_at FROM follow_up")).toEqual([
      { status: "done", close_reason: "auto:resolved:commit", closed_at: T0 + 25 * MIN },
    ]);
    expect(q("SELECT status FROM work_item")).toEqual([{ status: "done" }]);
    // 放置は返答タスクが出た 10:16（tick の時刻）から 10:25 まで（D-045 (1)。Mac は 9:00 から使っている）
    const day = env.ai.deps.days("2026-09-14", 1).days[0];
    expect(day?.idleMs).toBe(9 * MIN);
  });

  test("別セッションの入力: 前から開いていたセッションでは閉じず、トリガの後に始まったセッションで閉じる（問いのセッションが生きている間は閉じない）", async () => {
    const a = setup();
    const claude = join(env.home, ".claude");
    const other = (n: number) =>
      claudeTranscript(claude, {
        sid: `11111111-0000-4000-8000-00000000000${n}`,
        cwd: "/w/app",
        branch: "feat/login",
      });
    // 取り込みと判定だけ（プロセスの探索はしない。live_status を手で置く）
    const ingest = async () => {
      await env.ai.supervisor.detect();
      await env.ai.supervisor.scanAll();
      await env.ai.supervisor.whenIdle();
      env.ai.runner.runOnce();
    };
    // B は問いより前から開いている（並行のセッション）
    const b = other(2);
    b.human(T0 - 30 * MIN);
    b.assistantEnd(T0 - 28 * MIN, "Done.");
    a.human(T0 - 2 * MIN);
    a.assistantEnd(T0, "投稿したら教えてください。");
    env.clock.set(T0 + 16 * MIN);
    await ingest();
    expect(q("SELECT kind, status FROM follow_up")).toEqual([{ kind: "reply", status: "open" }]);
    // 古い並行のセッション B への入力は兆候にしない
    b.human(T0 + 18 * MIN);
    env.clock.set(T0 + 19 * MIN);
    await ingest();
    expect(q("SELECT status FROM follow_up")).toEqual([{ status: "open" }]);
    // 問いの後に始まったセッション C。問いのセッション A のプロセスが生きている（idle）間は閉じない
    const sidA = "11111111-0000-4000-8000-000000000001";
    const live = (st: string | null) =>
      env.sqlite.run(
        "UPDATE ai_session SET live_status = ?, live_pid = 4242, live_checked_at = ? WHERE external_id = ?",
        [st, env.clock.now(), sidA],
      );
    other(3).human(T0 + 22 * MIN);
    env.clock.set(T0 + 23 * MIN);
    live("idle");
    await ingest();
    expect(q("SELECT status FROM follow_up")).toEqual([{ status: "open" }]);
    // 同じブランチのコミットも、生きている間は兆候にしない
    env.git.commits.set("/w/app#feat/login", [T0 + 24 * MIN]);
    env.clock.set(T0 + 25 * MIN);
    env.ai.runner.runOnce();
    expect(q("SELECT status FROM follow_up")).toEqual([{ status: "open" }]);
    // A のプロセスが終わった（gone）→ 早い方の兆候（C の開始）の時刻で閉じる
    live("gone");
    env.clock.set(T0 + 26 * MIN);
    env.ai.runner.runOnce();
    expect(q("SELECT status, close_reason, closed_at FROM follow_up")).toEqual([
      { status: "done", close_reason: "auto:resolved:new_session", closed_at: T0 + 22 * MIN },
    ]);
    // 閉じた後に A が生き返っても（再計算しても）開き直さない
    live("idle");
    env.clock.set(T0 + 27 * MIN);
    env.ai.runner.runOnce();
    expect(q("SELECT status, close_reason, closed_at FROM follow_up")).toEqual([
      { status: "done", close_reason: "auto:resolved:new_session", closed_at: T0 + 22 * MIN },
    ]);
  });

  test("時間に置いた返答タスクは、置いた時刻からブロックの開始まで放置に数えない（D-051、W38・W39）", async () => {
    const tr = setup();
    tr.human(T0 - 2 * MIN);
    tr.assistantEnd(T0, "Which option do you prefer?");
    env.clock.set(T0 + 16 * MIN);
    await env.sync();
    const [fu] = q<{ task_id: string }>("SELECT task_id FROM follow_up");
    // 10:30 に 15:00〜15:30 へ置く
    env.clock.set(T0 + 30 * MIN);
    insertRow(env.mutate, schema.timeBlock, {
      id: newId(env.clock),
      taskId: fu?.task_id as string,
      startAt: T0 + 300 * MIN,
      endAt: T0 + 330 * MIN,
      tz: "Asia/Tokyo",
      writebackState: "pending",
    });
    env.clock.set(T0 + 360 * MIN);
    env.ai.runner.runOnce();
    const segs = q<{ kind: string; excluded_by: string | null; ms: number }>(
      "SELECT kind, excluded_by, SUM(end_at - start_at) AS ms FROM ai_wait_segment GROUP BY kind, excluded_by ORDER BY kind, excluded_by",
    );
    // 10:16〜10:30 と、開始の 15:00 を過ぎた 15:00〜16:00 が放置
    expect(segs).toEqual([
      { kind: "excluded", excluded_by: "no_task", ms: 1 * MIN - 100 },
      { kind: "excluded", excluded_by: "scheduled", ms: 270 * MIN },
      { kind: "grace", excluded_by: null, ms: 15 * MIN },
      { kind: "idle", excluded_by: null, ms: 74 * MIN },
    ]);
    // 「今日」にしただけ（ブロックを消した）なら従来どおり
    env.sqlite.run("UPDATE time_block SET deleted_at = ?", [T0 + 360 * MIN]);
    env.ai.runner.runOnce();
    expect(env.ai.deps.days("2026-09-14", 1).days[0]?.idleMs).toBe(344 * MIN);
  });

  test("待ち区間はキャッシュ: 古い規則で書いた区間は、次の実行で直近7日分を作り直す（D-058 の入れ替え後）", async () => {
    const tr = setup();
    tr.human(T0 - 2 * MIN);
    tr.assistantEnd(T0, "Which option do you prefer?");
    env.clock.set(T0 + 16 * MIN);
    await env.sync();
    env.clock.set(T0 + 60 * MIN);
    env.ai.runner.runOnce();
    const sql =
      "SELECT kind, excluded_by, start_at, end_at FROM ai_wait_segment ORDER BY start_at, kind";
    const fresh = q(sql);
    expect(fresh.length).toBeGreaterThan(0);
    // 古い規則のデーモンが書いた行のつもりで、区分を書き換え、余計な行を足す
    env.sqlite.run("UPDATE ai_wait_segment SET kind = 'idle', excluded_by = NULL");
    const [wi] = q<{ id: string }>("SELECT id FROM work_item");
    env.sqlite.run(
      `INSERT INTO ai_wait_segment (id, work_item_id, wait_key, follow_up_id, local_date, kind, excluded_by,
         start_at, end_at, is_open, end_reason, estimated, computed_at) VALUES (?, ?, 'stale', NULL, '2026-09-13', 'idle', NULL, ?, ?, 0, NULL, 0, ?)`,
      [newId(env.clock), wi?.id as string, T0 - 20 * 60 * MIN, T0 - 19 * 60 * MIN, T0],
    );
    env.ai.runner.runOnce();
    expect(q(sql)).toEqual(fresh);
  });

  test("e（対応不要）・s（スヌーズ）・Space（完了）とスヌーズ中の待ちは放置に数えない（D-032）", async () => {
    const tr = setup();
    tr.human(T0 - 2 * MIN);
    tr.assistantEnd(T0, "どちらの案にしますか？");
    env.clock.set(T0 + 16 * MIN);
    await env.sync();
    const [fu] = q<{ id: string }>("SELECT id FROM follow_up");
    env.clock.set(T0 + 20 * MIN);
    env.ai.deps.ops.snooze(fu?.id as string, T0 + 80 * MIN);
    env.clock.set(T0 + 90 * MIN);
    env.ai.runner.runOnce();
    expect(q("SELECT status, snoozes_json FROM follow_up")).toEqual([
      { status: "open", snoozes_json: JSON.stringify([[T0 + 20 * MIN, T0 + 80 * MIN]]) },
    ]);
    const segs = q<{ kind: string; excluded_by: string | null; ms: number }>(
      "SELECT kind, excluded_by, SUM(end_at - start_at) AS ms FROM ai_wait_segment GROUP BY kind, excluded_by ORDER BY kind, excluded_by",
    );
    // 猶予の後、返答タスクが出る 10:16 までは no_task（待ちの始点は turn_duration の時刻 T0 + 100ms）
    expect(segs).toEqual([
      { kind: "excluded", excluded_by: "no_task", ms: 1 * MIN - 100 },
      { kind: "excluded", excluded_by: "snoozed", ms: 60 * MIN },
      { kind: "grace", excluded_by: null, ms: 15 * MIN },
      { kind: "idle", excluded_by: null, ms: 14 * MIN },
    ]);
    env.ai.deps.ops.dismiss(fu?.id as string);
    expect(
      q("SELECT f.status, t.status AS task FROM follow_up f JOIN task t ON t.id = f.task_id"),
    ).toEqual([{ status: "dismissed", task: "canceled" }]);
    env.ai.runner.runOnce();
    expect(q("SELECT status FROM work_item")).toEqual([{ status: "done" }]);
    // 同じトリガでは作り直さない
    env.clock.set(T0 + 120 * MIN);
    env.ai.runner.runOnce();
    expect(q("SELECT count(*) AS n FROM follow_up")).toEqual([{ n: 1 }]);
  });

  test("「〜の回答を待っています。」で止まったら返答タスク（D-066 (1)）", async () => {
    const tr = setup();
    tr.human(T0 - 2 * MIN);
    tr.assistantEnd(
      T0,
      "実装は終わりました。\n\nほかに、前のメッセージで聞いた 2 点の回答を待っています。",
    );
    env.clock.set(T0 + 16 * MIN);
    await env.sync();
    expect(q("SELECT ended_with, closing_question FROM ai_turn")).toEqual([
      { ended_with: "question", closing_question: 0 },
    ]);
    expect(q("SELECT status, status_reason FROM work_item")).toEqual([
      { status: "your_turn", status_reason: "question" },
    ]);
    expect(q("SELECT kind, status FROM follow_up")).toEqual([{ kind: "reply", status: "open" }]);
  });

  test("y: 質問と判定されなかったカードに返答タスクを手で作る。2回目は何もしない。返答で閉じる（D-066 (2)）", async () => {
    const tr = setup();
    tr.human(T0 - 2 * MIN);
    tr.assistantEnd(T0, "実装しました。");
    env.clock.set(T0 + 5 * MIN);
    await env.sync();
    const [wi] = q<{ id: string; status: string }>("SELECT id, status FROM work_item");
    expect(wi?.status).toBe("done");
    expect(() => env.ai.deps.ops.createReplyTask("nope")).toThrow("work_item not found");
    const r1 = env.ai.deps.ops.createReplyTask(wi?.id as string);
    expect(r1.created).toBe(true);
    expect(r1.row).toMatchObject({ kind: "reply", status: "open", trigger_at: T0 + 5 * MIN });
    expect(r1.row?.artifact_ref.endsWith(":manual")).toBe(true);
    const r2 = env.ai.deps.ops.createReplyTask(wi?.id as string);
    expect(r2).toMatchObject({ created: false, row: { id: r1.row?.id }, taskId: r1.taskId });
    expect(q("SELECT source, title_key, scheduled_date FROM task")).toEqual([
      { source: "manual", title_key: "followup.reply", scheduled_date: "2026-09-14" },
    ]);
    env.ai.runner.runOnce();
    expect(q("SELECT status, status_reason FROM work_item")).toEqual([
      { status: "your_turn", status_reason: "question" },
    ]);
    expect(env.ai.deps.queue().map((x) => x.followUps.map((f) => f.kind))).toEqual([["reply"]]);
    // 15分たっても自動の返答タスクを重ねない。your_turn のままなので閉じない
    env.clock.set(T0 + 40 * MIN);
    env.ai.runner.runOnce();
    expect(q("SELECT status FROM follow_up")).toEqual([{ status: "open" }]);
    // 返答（同じセッションに人間の入力）で閉じる
    tr.human(T0 + 45 * MIN);
    env.clock.set(T0 + 45 * MIN + 5000);
    await env.sync();
    expect(q("SELECT status, close_reason FROM follow_up")).toEqual([
      { status: "done", close_reason: "auto:human_input" },
    ]);
    // 閉じた後にもう一度 y: 新しいターンに作る
    tr.assistantEnd(T0 + 50 * MIN, "直しました。");
    env.clock.set(T0 + 55 * MIN);
    await env.sync();
    expect(env.ai.deps.ops.createReplyTask(wi?.id as string).created).toBe(true);
    expect(q("SELECT count(*) AS n FROM follow_up WHERE status = 'open'")).toEqual([{ n: 1 }]);
  });

  test("カードの題名: セッションが他のカードにまたがらなければ要約タイトル、またがればブランチ名（D-066 (3)）", async () => {
    const a = setup();
    a.aiTitle(T0 - 3 * MIN, "Fix the flaky login test");
    a.human(T0 - 2 * MIN);
    a.assistantEnd(T0, "直しました。");
    // 別のセッションでブランチを切り替える（feat/x → feat/y）
    const sid = "11111111-0000-4000-8000-000000000002";
    const x = claudeTranscript(join(env.home, ".claude"), { sid, cwd: "/w/app", branch: "feat/x" });
    x.aiTitle(T0 - 3 * MIN, "Shared session title");
    x.human(T0 - 2 * MIN);
    x.assistantEnd(T0, "x を直しました。");
    const y = claudeTranscript(join(env.home, ".claude"), { sid, cwd: "/w/app", branch: "feat/y" });
    y.human(T0 + MIN);
    y.assistantEnd(T0 + 2 * MIN, "y を直しました。");
    env.clock.set(T0 + 5 * MIN);
    await env.sync();
    expect(q("SELECT branch, title_auto, title_source FROM work_item ORDER BY branch")).toEqual([
      { branch: "feat/login", title_auto: "Fix the flaky login test", title_source: "ai_title" },
      { branch: "feat/x", title_auto: "x", title_source: "branch" },
      { branch: "feat/y", title_auto: "y", title_source: "branch" },
    ]);
  });

  test("Codex でも質問で終われば your_turn", async () => {
    env = makeAiEnv({ now: Date.UTC(2026, 8, 1, 3) });
    installCodexCase(env.home, "cli-git");
    await env.sync();
    const statuses = q<{ status: string; tools_json: string }>(
      "SELECT status, tools_json FROM work_item",
    );
    expect(statuses.length).toBeGreaterThan(0);
    expect(statuses.every((s) => s.tools_json === '["codex"]')).toBe(true);
  });

  test("hooks: PermissionRequest で needs_input・許可待ちのフォローアップ、Stop で閉じる", async () => {
    const tr = setup();
    tr.human(T0);
    const spool = join(env.dataDir, "spool");
    mkdirSync(spool, { recursive: true });
    const sid = "11111111-0000-4000-8000-000000000001";
    const line = (name: string, at: number) =>
      `${JSON.stringify({ v: 1, tool: "claude_code", received_at: at, config_root: join(env.home, ".claude"), hook_event_name: name, session_id: sid })}\n`;
    writeFileSync(
      join(spool, "hooks-20260914.jsonl"),
      line("UserPromptSubmit", T0) + line("PermissionRequest", T0 + 10_000),
    );
    env.clock.set(T0 + 20_000);
    await env.sync();
    expect(q("SELECT status, status_reason, status_estimated FROM work_item")).toEqual([
      { status: "needs_input", status_reason: "hook:permission_request", status_estimated: 0 },
    ]);
    expect(q("SELECT kind, status FROM follow_up")).toEqual([{ kind: "approve", status: "open" }]);
    expect(env.ai.deps.queue()[0]?.status).toBe("needs_input");
    writeFileSync(
      join(spool, "hooks-20260914.jsonl"),
      line("UserPromptSubmit", T0) +
        line("PermissionRequest", T0 + 10_000) +
        line("Stop", T0 + 60_000),
    );
    tr.assistantEnd(T0 + 60_000, "done.");
    env.clock.set(T0 + 70_000);
    await env.sync();
    expect(q("SELECT status, close_reason FROM follow_up")).toEqual([
      { status: "done", close_reason: "auto:next_turn_ok" },
    ]);
    expect(q("SELECT status FROM work_item")).toEqual([{ status: "done" }]);
  });

  test("PR: gh で open を確かめてから review_pr を作り、merged で閉じる。head ブランチのカードに付ける", async () => {
    const prs = new Map<string, GhPr>();
    const gh: GhClient = {
      viewer: () => "me",
      prView: (repo, n) => prs.get(`${repo}#${n}`) ?? null,
    };
    const tr = setup({ gh });
    tr.human(T0 - 5 * MIN);
    tr.prLink(T0 - MIN, "org/app", 42);
    tr.assistantEnd(T0, "PR を作りました。");
    env.clock.set(T0 + MIN);
    await env.sync();
    // gh で状態を確かめる前（unknown）はレビュータスクを作らない（バックフィルで古い PR のタスクを作らないため）
    expect(q("SELECT * FROM follow_up")).toHaveLength(0);
    prs.set("org/app#42", {
      state: "open",
      reviewDecision: null,
      title: "Add login",
      url: "https://github.com/org/app/pull/42",
      headRefName: "feat/login",
      mergedAt: null,
      closedAt: null,
      reviews: [],
    });
    expect(env.ai.poller?.pollOnce()).toBe(1);
    env.ai.runner.runOnce();
    expect(q("SELECT kind, artifact_ref, status FROM follow_up")).toEqual([
      { kind: "review_pr", artifact_ref: "org/app#42", status: "open" },
    ]);
    expect(q("SELECT status, status_reason, pr_ref FROM work_item")).toEqual([
      { status: "your_turn", status_reason: "pr_open", pr_ref: "org/app#42" },
    ]);
    prs.set("org/app#42", {
      state: "merged",
      reviewDecision: null,
      title: "Add login",
      url: "https://github.com/org/app/pull/42",
      headRefName: "feat/login",
      mergedAt: T0 + 30 * MIN,
      closedAt: T0 + 30 * MIN,
      reviews: [],
    });
    env.clock.set(T0 + 37 * MIN);
    expect(env.ai.poller?.pollOnce()).toBe(1);
    env.ai.runner.runOnce();
    expect(q("SELECT status, close_reason FROM follow_up")).toEqual([
      { status: "done", close_reason: "auto:pr_merged" },
    ]);
    expect(q("SELECT status, status_reason, title_auto, title_source FROM work_item")).toEqual([
      { status: "done", status_reason: "pr_merged", title_auto: "Add login", title_source: "pr" },
    ]);
  });

  test("y: PR だけのカード（head ブランチにターンが無い）。開いているタスク（PR の確認）があればそれを返し、無ければ作る", async () => {
    const pr: GhPr = {
      state: "open",
      reviewDecision: null,
      title: "Example change",
      url: "https://github.com/org/app/pull/43",
      headRefName: "feat/other",
      mergedAt: null,
      closedAt: null,
      reviews: [],
    };
    const gh: GhClient = { viewer: () => "me", prView: () => pr };
    const tr = setup({ gh });
    tr.human(T0 - 5 * MIN);
    tr.prLink(T0 - MIN, "org/app", 43);
    tr.assistantEnd(T0, "PR を作りました。");
    env.clock.set(T0 + MIN);
    await env.sync();
    expect(env.ai.poller?.pollOnce()).toBe(1);
    env.ai.runner.runOnce();
    const [card] = q<{ id: string }>(
      "SELECT w.id FROM work_item w WHERE w.branch = 'feat/other' AND NOT EXISTS (SELECT 1 FROM ai_turn t WHERE t.work_item_id = w.id)",
    );
    const id = card?.id as string;
    const [review] = q<{ id: string; task_id: string }>(
      "SELECT id, task_id FROM follow_up WHERE work_item_id = ? AND kind = 'review_pr' AND status = 'open'",
      id,
    );
    expect(review?.task_id).toBeTruthy();
    const tasks = () => q<{ n: number }>("SELECT count(*) AS n FROM task")[0]?.n;
    const before = tasks();
    // 開いている PR の確認のタスクが結び付いている: 作らずにそれを返す（同じ件を同じ日に2つ並べない）
    expect(env.ai.deps.ops.createReplyTask(id)).toMatchObject({
      created: false,
      taskId: review?.task_id,
      row: { id: review?.id, kind: "review_pr" },
    });
    expect(tasks()).toBe(before);
    // 対応不要にしてタスクが取り消されたら、トリガのターンなしで作る
    env.ai.deps.ops.dismiss(review?.id as string);
    const r1 = env.ai.deps.ops.createReplyTask(id);
    expect(r1.created).toBe(true);
    expect(r1.row).toMatchObject({
      kind: "reply",
      status: "open",
      trigger_turn_id: null,
      trigger_at: T0 + MIN,
      artifact_ref: "card:manual",
      task_id: r1.taskId,
    });
    expect(tasks()).toBe((before ?? 0) + 1);
    expect(env.ai.deps.ops.createReplyTask(id)).toMatchObject({
      created: false,
      row: { id: r1.row?.id },
    });
    // 導出を回しても閉じない（ターンが無いので「返答済み」にはならない）。自分の番に出る
    env.clock.set(T0 + 30 * MIN);
    env.ai.runner.runOnce();
    expect(q("SELECT status FROM follow_up WHERE id = ?", r1.row?.id as string)).toEqual([
      { status: "open" },
    ]);
    expect(
      env.ai.deps
        .queue()
        .flatMap((x) => x.followUps)
        .some((f) => f.id === r1.row?.id),
    ).toBe(true);
    // 閉じた後にもう一度押すと、使っていない artifact_ref で作り直す
    env.ai.deps.ops.dismiss(r1.row?.id as string);
    const r3 = env.ai.deps.ops.createReplyTask(id);
    expect(r3.created).toBe(true);
    expect(r3.row?.artifact_ref).toBe("card:manual:2");
  });

  test("y: カードのセッションを起動した頼んだタスク（D-107）が開いていれば、作らずにそれを返す", async () => {
    const tr = setup();
    tr.human(T0 - 2 * MIN);
    tr.assistantEnd(T0, "実装しました。");
    env.clock.set(T0 + 5 * MIN);
    await env.sync();
    const [wi] = q<{ id: string }>("SELECT id FROM work_item");
    const [turn] = q<{ session_id: string }>("SELECT session_id FROM ai_turn");
    const task = insertRow(env.mutate, schema.task, {
      title: "Example request",
      status: "todo",
      scheduledDate: "2026-09-14",
      laneOrder: "a0",
      source: "manual",
    });
    const launch = {
      id: newId(env.clock),
      taskId: task.id,
      tool: "claude_code" as const,
      repoRoot: "/w/app",
      cwd: "/w/app",
      sessionId: turn?.session_id as string,
      status: "linked" as const,
      createdAt: T0 - 10 * MIN,
      updatedAt: T0 - 10 * MIN,
    };
    env.sqlite.run(
      "INSERT INTO ai_launch (id, task_id, tool, repo_root, cwd, session_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        launch.id,
        launch.taskId,
        launch.tool,
        launch.repoRoot,
        launch.cwd,
        launch.sessionId,
        launch.status,
        launch.createdAt,
        launch.updatedAt,
      ],
    );
    expect(env.ai.deps.ops.createReplyTask(wi?.id as string)).toEqual({
      row: null,
      created: false,
      taskId: task.id,
    });
    expect(q("SELECT count(*) AS n FROM follow_up")).toEqual([{ n: 0 }]);
    // 頼んだタスクを完了にしたら作る
    env.sqlite.run("UPDATE task SET status = 'done' WHERE id = ?", [task.id]);
    expect(env.ai.deps.ops.createReplyTask(wi?.id as string).created).toBe(true);
  });

  test("既定ブランチの session カードもリポジトリを持つ。名前を変える前の cwd のターンがあっても、後のターンのリポジトリ（D-061）", async () => {
    env = makeAiEnv({ now: T0 });
    env.git.repos.set("/w/strategy", "/w/strategy");
    env.git.defaults.set("/w/strategy", "main");
    // 同じセッション: 名前を変える前（今は無い）の cwd で2ターン、変えた後の cwd で1ターン
    env.git.missing.add("/w/old-name");
    const root = join(env.home, ".claude");
    const sid = "11111111-0000-4000-8000-0000000000d1";
    const before = claudeTranscript(root, {
      sid,
      cwd: "/w/old-name",
      branch: "main",
      enc: "-w-old-name",
    });
    const after = claudeTranscript(root, {
      sid,
      cwd: "/w/strategy",
      branch: "main",
      enc: "-w-old-name",
    });
    before.human(T0 - 30 * MIN);
    before.assistantEnd(T0 - 29 * MIN, "done");
    before.human(T0 - 20 * MIN);
    before.assistantEnd(T0 - 19 * MIN, "done");
    after.human(T0 - 10 * MIN);
    after.assistantEnd(T0 - 9 * MIN, "done");
    // git 管理外のセッション
    claudeTranscript(root, {
      sid: "11111111-0000-4000-8000-0000000000d2",
      cwd: "/tmp/notes",
      branch: "",
    }).human(T0 - 5 * MIN);
    await env.sync();
    const wis = q<{ group_key: string; repo_root: string | null }>(
      "SELECT group_key, repo_root FROM work_item WHERE deleted_at IS NULL ORDER BY group_key",
    );
    expect(wis).toEqual([
      { group_key: `session:claude_code:${sid}`, repo_root: "/w/strategy" },
      { group_key: "session:claude_code:11111111-0000-4000-8000-0000000000d2", repo_root: null },
    ]);
  });

  test("匿名化フィクスチャ全体: カード・状態・待ち・日別の集計が出る（turnlane ai の元）", async () => {
    env = makeAiEnv({ now: Date.UTC(2026, 8, 2, 12) });
    for (const c of [
      "pr-created",
      "question-end",
      "subagent-branch-switch",
      "synthetic-closing-error",
      "ask-user-question",
    ]) {
      installClaudeCase(env.home, c);
    }
    installCodexCase(env.home, "desktop-guardian-aborted");
    for (const r of ["/fixture/repo-a", "/fixture/repo-b", "/fixture/repo-c", "/fixture/repo-d"])
      env.git.repos.set(r, r);
    await env.sync();
    const wis = q<{ group_key: string; status: string }>(
      "SELECT group_key, status FROM work_item WHERE deleted_at IS NULL",
    );
    expect(wis.length).toBeGreaterThan(3);
    expect(wis.some((w) => w.group_key.startsWith("branch:"))).toBe(true);
    expect(wis.some((w) => w.group_key.startsWith("session:"))).toBe(true);
    // ノイズ（guardian）のセッションのターンはカードに入らない
    expect(
      q(
        "SELECT count(*) AS n FROM ai_turn t JOIN ai_session s ON s.id = t.session_id WHERE s.is_noise = 1 AND t.work_item_id IS NOT NULL",
      ),
    ).toEqual([{ n: 0 }]);
    const view = env.ai.deps.days(undefined, 7);
    expect(view.days).toHaveLength(7);
    expect(view.days.some((d) => d.items.length > 0)).toBe(true);
    // 2回目の判定で何も変わらない（冪等）
    const before = q("SELECT id, status, status_reason, title_auto FROM work_item ORDER BY id");
    env.ai.runner.runOnce();
    expect(q("SELECT id, status, status_reason, title_auto FROM work_item ORDER BY id")).toEqual(
      before,
    );
  });
});

describe("在席（D-105）", () => {
  test("Mac を離れた間は不在（away）。翌朝は Mac を使い始めてから数える", async () => {
    const tr = setup({}, false);
    // 9:00〜10:30 と 11:30〜12:00 に Mac を使った
    present(env.sqlite, T0 - 60 * MIN, T0 + 30 * MIN);
    present(env.sqlite, T0 + 90 * MIN, T0 + 120 * MIN);
    tr.human(T0 - 2 * MIN);
    tr.assistantEnd(T0, "Which option do you prefer?");
    env.clock.set(T0 + 16 * MIN);
    await env.sync();
    env.clock.set(T0 + 120 * MIN);
    env.ai.runner.runOnce();
    const sum = (by: string) =>
      q<{ ms: number | null }>(
        "SELECT SUM(end_at - start_at) AS ms FROM ai_wait_segment WHERE excluded_by = ?",
        by,
      )[0]?.ms ?? 0;
    expect(sum("away")).toBe(60 * MIN);
    // 放置は 10:16〜10:30 と 11:30〜12:00
    expect(env.ai.deps.days("2026-09-14", 1).days[0]?.idleMs).toBe(44 * MIN);

    // 翌朝 9:30 から Mac を使う。夜のあいだ（不在）は数えず、翌朝の在席から数え直す（D-105）
    present(env.sqlite, T0 + 23.5 * 60 * MIN, T0 + 24 * 60 * MIN);
    env.clock.set(T0 + 24 * 60 * MIN);
    env.ai.runner.runOnce();
    expect(env.ai.deps.days("2026-09-15", 1).days[0]?.idleMs).toBe(30 * MIN);
    expect(env.ai.deps.days("2026-09-14", 1).days[0]?.idleMs).toBe(44 * MIN);
  });

  test("在席の記録を始めた日（idle.presence_since）より前の待ち区間は作り直さない（D-110 (3)）", async () => {
    const tr = setup();
    tr.human(T0 - 2 * MIN);
    tr.assistantEnd(T0, "Which option do you prefer?");
    env.clock.set(T0 + 16 * MIN);
    await env.sync();
    const [wi] = q<{ id: string }>("SELECT id FROM work_item");
    // 前日の行（古い規則で数えた値）
    env.sqlite.run(
      `INSERT INTO ai_wait_segment (id, work_item_id, wait_key, follow_up_id, local_date, kind, excluded_by,
         start_at, end_at, is_open, end_reason, estimated, computed_at) VALUES ('old', ?, 'old', NULL, '2026-09-13', 'idle', NULL, ?, ?, 0, NULL, 0, ?)`,
      [wi?.id as string, T0 - 20 * 60 * MIN, T0 - 19 * 60 * MIN, T0],
    );
    putSetting(env.mutate, "idle.presence_since", T0 - 2 * 60 * MIN);
    env.ai.runner.runOnce();
    expect(q("SELECT id FROM ai_wait_segment WHERE local_date = '2026-09-13'")).toEqual([
      { id: "old" },
    ]);
  });
});
