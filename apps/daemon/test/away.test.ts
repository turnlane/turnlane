/**
 * 離れていた間のまとめ（GET /api/away。ux-mvp 4.13、D-214 (2)）: 在席の区間と AI の事実（ターンの終わり・PR・フォローアップ）から、
 * 戻ってから 30 分だけ 1 行を返す。閉じた印だけを保存する。本文はすべて合成のダミー
 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { putSetting } from "@turnlane/core";
import { AWAY_DISMISSED_KEY } from "../src/derive/away.ts";
import type { GhClient } from "../src/github/pr-poller.ts";
import { seedPresence } from "../src/presence/service.ts";
import { type AiEnv, makeAiEnv } from "./helpers/env.ts";
import { claudeTranscript } from "./helpers/transcript.ts";

const MIN = 60_000;
// 2026-10-16 17:00 JST
const T0 = Date.UTC(2026, 9, 16, 8, 0);
const t = (min: number) => T0 + min * MIN;

let env: AiEnv;
afterEach(async () => {
  await env?.cleanup();
});

/** 17:14〜17:48 の離席の間に、完了（6 ファイル）・PR #190・問い（17:41）が起きた場面 */
async function scene() {
  const gh: GhClient = {
    viewer: () => "me",
    prView: () => ({
      state: "open",
      reviewDecision: "REVIEW_REQUIRED",
      title: "右の列の幅をそろえる",
      url: "https://example.invalid/pull/190",
      headRefName: "fix/board-width",
      mergedAt: null,
      closedAt: null,
      reviews: [],
    }),
  };
  env = makeAiEnv({ now: t(0), gh });
  for (const r of ["logs", "board", "tz"]) env.git.repos.set(`/w/${r}`, `/w/${r}`);
  const root = join(env.home, ".claude");
  const s = (n: number, r: string, branch: string) =>
    claudeTranscript(root, {
      sid: `99999999-0000-4000-8000-00000000000${n}`,
      cwd: `/w/${r}`,
      branch,
    });
  const logs = s(1, "logs", "fix/log-format");
  const board = s(2, "board", "fix/board-width");
  const tz = s(3, "tz", "fix/tz-test");
  logs.human(t(5), { text: "アクセスログの形式を JSON にそろえて" });
  board.human(t(10), { text: "3日ボードの列幅を直して" });
  tz.human(t(12), { text: "タイムゾーンで落ちるテストを直して" });
  // 在席: 9:00〜17:14、17:48 から今まで（T を足した形）
  seedPresence(env.sqlite, "p1", t(-480), t(14));
  logs.assistantEnd(t(22), "そろえました。", { edits: 6, durationMs: 17 * MIN });
  board.prLink(t(31), "example/board", 190);
  board.assistantEnd(t(31), "PR を開きました。", { edits: 3, durationMs: 21 * MIN });
  tz.assistantEnd(t(41), "UTC と JST のどちらに合わせますか？", { durationMs: 29 * MIN });
  for (const m of [15, 25, 35, 45]) {
    env.clock.set(t(m));
    await env.sync();
    env.ai.poller?.pollOnce();
    env.ai.runner.runOnce();
  }
  seedPresence(env.sqlite, "p2", t(48), t(100));
  env.clock.set(t(50));
  await env.sync();
}

test("戻ったら 17:14–17:48 の間の 完了 1 · PR 1 · 新しい待ち 1。完了はファイル数、問いは止まった時刻", async () => {
  await scene();
  const { digest } = await env.ai.deps.away();
  expect(digest).not.toBeNull();
  if (!digest) return;
  expect(digest.from).toBe(t(14));
  expect(digest.to).toBe(t(48));
  expect(digest.until).toBe(t(78));
  expect(digest.counts).toEqual({ done: 1, pr: 1, wait: 1, error: 0 });
  // 時刻は分で比べる（記録の書き手が 100ms ずらして書く）
  expect(digest.items.map((x) => [x.branch, x.kind, Math.floor((x.at - T0) / MIN)])).toEqual([
    ["fix/log-format", "done", 22],
    ["fix/board-width", "pr_opened", 31],
    ["fix/tz-test", "question", 41],
  ]);
  const [done, pr, q] = digest.items;
  expect(done?.change).toEqual({ files: 6 });
  expect(done?.title).toBe("アクセスログの形式を JSON にそろえて");
  expect(pr?.pr).toMatchObject({ number: 190, ref: "example/board#190" });
  expect(pr?.change).toEqual({ files: 3 });
  // 問いは離席中なので猶予なしで自分の番（D-223）。開くとそのフォローアップ
  expect(q?.followUpId).toEqual(expect.any(String));
  // 本文（AI の発言）は返さない
  expect(JSON.stringify(digest)).not.toContain("UTC と JST");
});

test("PR の変更の量と CI は gh で読めたときだけ。自分の番の行（PR の確認待ち）にも付く", async () => {
  await scene();
  env.ai.setPrChange(
    async (ref) =>
      ref === "example/board#190" ? { files: 4, additions: 120, deletions: 8, ci: "pass" } : null,
    (ref) =>
      ref === "example/board#190" ? { files: 4, additions: 120, deletions: 8, ci: "pass" } : null,
  );
  const { digest } = await env.ai.deps.away();
  expect(digest?.items[1]?.change).toEqual({ files: 4, additions: 120, deletions: 8, ci: "pass" });
  const row = env.ai.deps.queue().find((x) => x.branch === "fix/board-width");
  expect(row?.change).toEqual({ files: 4, additions: 120, deletions: 8, ci: "pass" });
  // 待ちの件（問い）には付けない
  expect(env.ai.deps.queue().find((x) => x.branch === "fix/tz-test")?.change).toBeUndefined();
});

test("30 分で消える。閉じたら同じ離席では出ない。並んだ件を開いても消える。設定がオフなら出さない", async () => {
  await scene();
  env.clock.set(t(77));
  expect((await env.ai.deps.away()).digest).not.toBeNull();
  env.clock.set(t(78));
  expect((await env.ai.deps.away()).digest).toBeNull();

  env.clock.set(t(55));
  const d = (await env.ai.deps.away()).digest;
  expect(d).not.toBeNull();
  env.ai.deps.dismissAway(d?.key ?? "");
  expect((await env.ai.deps.away()).digest).toBeNull();
  putSetting(env.mutate, AWAY_DISMISSED_KEY, "0");
  expect((await env.ai.deps.away()).digest).not.toBeNull();

  // 並んだ件（問い）を開いた（engage）
  const fu = d?.items.find((x) => x.kind === "question")?.followUpId ?? "";
  env.ai.deps.ops.engage(fu);
  expect((await env.ai.deps.away()).digest).toBeNull();
});

test("設定「戻ったときのまとめを出す」がオフなら出さない", async () => {
  await scene();
  putSetting(env.mutate, "turn.away_summary", false);
  expect((await env.ai.deps.away()).digest).toBeNull();
});

test("夜をまたいだ離席: 昨日の最後の在席から今朝まで", async () => {
  env = makeAiEnv({ now: t(0) });
  env.git.repos.set("/w/logs", "/w/logs");
  const root = join(env.home, ".claude");
  const tr = claudeTranscript(root, {
    sid: "99999999-0000-4000-8000-000000000009",
    cwd: "/w/logs",
    branch: "chore/nightly",
  });
  // 昨日 9:00〜19:02 在席、19:00 に頼んで 21:30 に完了。今朝 8:35 に戻った
  seedPresence(env.sqlite, "y", t(-480), t(122));
  tr.human(t(120), { text: "夜のうちに依存を上げて" });
  tr.assistantEnd(t(270), "上げました。", { edits: 2, durationMs: 150 * MIN });
  env.clock.set(t(280));
  await env.sync();
  const morning = t(15 * 60 + 35);
  seedPresence(env.sqlite, "m", morning, morning + 5 * MIN);
  env.clock.set(morning + 5 * MIN);
  const { digest } = await env.ai.deps.away();
  expect(digest?.from).toBe(t(122));
  expect(digest?.to).toBe(morning);
  expect(digest?.counts).toEqual({ done: 1, pr: 0, wait: 0, error: 0 });
});

test("利用枠で止まった（上限待ち）は離れていた間のエラーに数えない。ほかのエラーは数える", async () => {
  env = makeAiEnv({ now: t(0) });
  for (const r of ["logs", "board"]) env.git.repos.set(`/w/${r}`, `/w/${r}`);
  const root = join(env.home, ".claude");
  const spool = join(env.dataDir, "spool");
  mkdirSync(spool, { recursive: true });
  const lines: string[] = [];
  const hook = (sid: string, name: string, at: number, extra: Record<string, string> = {}) => {
    lines.push(
      JSON.stringify({
        v: 1,
        tool: "claude_code",
        received_at: at,
        config_root: root,
        hook_event_name: name,
        session_id: sid,
        ...extra,
      }),
    );
    writeFileSync(join(spool, "hooks-20261016.jsonl"), `${lines.join("\n")}\n`);
  };
  const a = "99999999-0000-4000-8000-00000000000a";
  const b = "99999999-0000-4000-8000-00000000000b";
  const limited = claudeTranscript(root, { sid: a, cwd: "/w/logs", branch: "fix/limit" });
  const failed = claudeTranscript(root, { sid: b, cwd: "/w/board", branch: "fix/server" });
  seedPresence(env.sqlite, "p1", t(-480), t(14));
  limited.human(t(5), { text: "ログの形式をそろえて" });
  failed.human(t(6), { text: "列幅を直して" });
  hook(a, "UserPromptSubmit", t(5));
  hook(b, "UserPromptSubmit", t(6));
  limited.apiError(t(20), "rate_limit", { durationMs: 15 * MIN });
  hook(a, "StopFailure", t(20), { error: "rate_limit" });
  failed.apiError(t(21), "server_error", { durationMs: 15 * MIN });
  // 古い spool の行（error_type）も読む
  hook(b, "StopFailure", t(21), { error_type: "server_error" });
  env.clock.set(t(25));
  await env.sync();
  seedPresence(env.sqlite, "p2", t(48), t(100));
  env.clock.set(t(50));
  await env.sync();
  const { digest } = await env.ai.deps.away();
  expect(digest?.counts).toEqual({ done: 0, pr: 0, wait: 0, error: 1 });
});
