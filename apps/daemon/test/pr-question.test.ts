/**
 * 前のセッションが PR を出したブランチで、後の別のセッションが問いで止まった（fix-pr-link）。
 * PR はブランチのカードに付いたまま（成果に出る）だが、状態・主ボタン・件名は AI の問い（返答待ち）を優先する
 * （問いの間は PR の題名を件名にしない。fix-subject-pr）。問いへの返答タスクが閉じたら PR の確認待ちに戻り、指示・ai-title が
 * 無ければ件名は PR の題名（ブランチ名より上）。本文はすべて合成のダミー
 */
import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import type { QueueItem, WorkItemDetail } from "@turnlane/core/api";
import { followUpSubject } from "@turnlane/core/web";
import type { GhClient } from "../src/github/pr-poller.ts";
import { createApp } from "../src/http/app.ts";
import { type AiEnv, makeAiEnv } from "./helpers/env.ts";
import { claudeTranscript } from "./helpers/transcript.ts";

const TOKEN = "f".repeat(64);
const HOST = "127.0.0.1:7317";
const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 2, 0, 0);
const PR_TITLE = "fix: skip alerts for archived sites";
const BRANCH = "fix/issue-42";

let env: AiEnv;
afterEach(async () => {
  await env?.cleanup();
});

test("PR のあるブランチで別のセッションが問いで止まる → 返答待ちが PR の確認待ちより先", async () => {
  const gh: GhClient = {
    viewer: () => "me",
    prView: () => ({
      state: "open",
      reviewDecision: "APPROVED",
      title: PR_TITLE,
      url: "https://example.invalid/pull/43",
      headRefName: BRANCH,
      mergedAt: null,
      closedAt: null,
      reviews: [],
    }),
  };
  env = makeAiEnv({ now: T0, gh });
  env.git.repos.set("/w/app", "/w/app");
  env.git.defaults.set("/w/app", "main");
  const app = createApp({
    token: TOKEN,
    port: 7317,
    hub: env.hub,
    health: () => ({}) as never,
    admin: { backup: () => ({ date: "", path: "" }) },
    ai: () => env.ai.deps,
    recordUserOp: env.ai.recordUserOp,
  });
  const get = async <T>(path: string) =>
    (await (
      await app.request(`http://${HOST}${path}`, {
        headers: { host: HOST, authorization: `Bearer ${TOKEN}` },
      })
    ).json()) as T;
  const root = join(env.home, ".claude");

  // セッション A: ブランチで PR を出して終わる
  const a = claudeTranscript(root, {
    sid: "42424242-0000-4000-8000-00000000000a",
    cwd: "/w/app",
    branch: BRANCH,
  });
  a.human(T0, { text: "Skip alerts for archived sites" });
  a.prLink(T0 + 2 * MIN, "example/app", 43);
  a.assistantEnd(T0 + 3 * MIN, "Opened the PR.", { durationMs: 3 * MIN });
  env.clock.set(T0 + 10 * MIN);
  await env.sync();
  env.ai.poller?.pollOnce();
  await env.sync();

  // セッション B: 同じ作業ディレクトリ（ブランチはそのまま）で別の調査をして、問いで止まる
  const t1 = T0 + 2 * 60 * MIN;
  const b = claudeTranscript(root, {
    sid: "42424242-0000-4000-8000-00000000000b",
    cwd: "/w/app",
    branch: BRANCH,
  });
  b.human(t1, { text: "Why does the customer id come back as -1?" });
  b.assistantEnd(t1 + 2 * MIN, "Should I file an issue or implement the fix?", {
    durationMs: 2 * MIN,
  });
  env.clock.set(t1 + 30 * MIN);
  await env.sync();

  const wi =
    env.sqlite
      .query<{ id: string }, [string]>("SELECT id FROM work_item WHERE branch = ?")
      .get(BRANCH)?.id ?? "";
  // PR は出したセッションの記録（pr-link）と head ブランチで、このブランチのカードに付いている
  expect(
    env.sqlite
      .query<{ work_item_id: string; head_ref: string }, []>(
        "SELECT work_item_id, head_ref FROM ai_artifact WHERE kind = 'pr'",
      )
      .all(),
  ).toEqual([{ work_item_id: wi, head_ref: BRANCH }]);

  const d = await get<WorkItemDetail>(`/api/work-items/${wi}`);
  expect(d.workItem.status).toBe("your_turn");
  expect(d.workItem.reason).toBe("question");
  expect(d.workItem.title).not.toBe(PR_TITLE);
  expect(d.artifacts.find((x) => x.kind === "pr")?.title).toBe(PR_TITLE);

  const q = await get<{ items: QueueItem[] }>("/api/queue");
  const item = q.items.find((x) => x.workItemId === wi) as QueueItem;
  expect(
    item.followUps
      .filter((f) => f.status === "open")
      .map((f) => f.kind)
      .sort(),
  ).toEqual(["reply", "review_pr"]);
  expect(followUpSubject(item, "en")).not.toBe(PR_TITLE);
  expect(item.titleSource).toBeUndefined();

  // 返答タスクを閉じる（対応不要）と、PR の確認待ちに戻る。ai-title が無いので件名は PR の題名（ブランチ名より上。fix-subject-pr）
  env.sqlite.run(
    "UPDATE follow_up SET status = 'dismissed', closed_at = ? WHERE work_item_id = ? AND kind = 'reply'",
    [t1 + 31 * MIN, wi],
  );
  env.clock.set(t1 + 32 * MIN);
  await env.sync();
  const back = await get<WorkItemDetail>(`/api/work-items/${wi}`);
  expect(back.workItem.reason).toBe("pr_open");
  expect(back.workItem.title).toBe(PR_TITLE);
  expect(back.workItem.titleSource).toBe("pr");
  const q2 = await get<{ items: QueueItem[] }>("/api/queue");
  const back2 = q2.items.find((x) => x.workItemId === wi) as QueueItem;
  expect(back2.title).toBe(PR_TITLE);
  expect(back2.titleSource).toBe("pr");
  expect(followUpSubject(back2, "en")).toBe(PR_TITLE);
  const pr = back2.followUps.find((f) => f.kind === "review_pr");
  expect(pr?.title.t === "auto" ? pr.title.params.prTitle : null).toBe(PR_TITLE);
});
