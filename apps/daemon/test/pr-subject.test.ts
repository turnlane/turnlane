/**
 * 別のディレクトリのセッションが別のリポジトリの PR を出した（fix-subject-pr）。PR は head のブランチのカードに付き、
 * そのカードにはターンが無い（指示も ai-title も無い）。件名はブランチ名を空白で区切ったものではなく PR の題名にする。
 * 本文はすべて合成のダミー
 */
import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import type { QueueItem, WorkItemDetail } from "@turnlane/core/api";
import { followUpSubject, noticeMessage } from "@turnlane/core/web";
import type { GhClient } from "../src/github/pr-poller.ts";
import { createApp } from "../src/http/app.ts";
import { type AiEnv, makeAiEnv } from "./helpers/env.ts";
import { claudeTranscript } from "./helpers/transcript.ts";

const TOKEN = "f".repeat(64);
const HOST = "127.0.0.1:7317";
const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 2, 0, 0);
const PR_TITLE = "Clarify the invite link wording on the landing page";
const BRANCH = "fix/lp-notify-wording";

let env: AiEnv;
afterEach(async () => {
  await env?.cleanup();
});

test("ターンの無い PR のカード: 件名・詳細の見出し・通知の件名は PR の題名（ブランチ名でない）", async () => {
  const gh: GhClient = {
    viewer: () => "me",
    prView: () => ({
      state: "open",
      reviewDecision: null,
      title: PR_TITLE,
      url: "https://example.invalid/pull/8",
      headRefName: BRANCH,
      mergedAt: null,
      closedAt: null,
      reviews: [],
    }),
  };
  env = makeAiEnv({ now: T0, gh });
  env.git.repos.set("/w/plans", "/w/plans");
  env.git.defaults.set("/w/plans", "main");
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

  // 計画のディレクトリ（既定のブランチ）のセッションが、別のリポジトリに PR を出して終わる
  const s = claudeTranscript(root, {
    sid: "88888888-0000-4000-8000-000000000001",
    cwd: "/w/plans",
    branch: "main",
  });
  s.aiTitle(T0, "Weekly planning");
  s.human(T0, { text: "Ship the landing page wording fix" });
  s.prLink(T0 + 2 * MIN, "example/site", 8);
  s.assistantEnd(T0 + 3 * MIN, "Opened the PR.", { durationMs: 3 * MIN });
  env.clock.set(T0 + 10 * MIN);
  await env.sync();
  env.ai.poller?.pollOnce();
  await env.sync();

  const card = env.sqlite
    .query<{ id: string; title_source: string; turns: number }, [string]>(
      `SELECT w.id, w.title_source, (SELECT count(*) FROM ai_turn t WHERE t.work_item_id = w.id) AS turns
       FROM work_item w WHERE w.branch = ?`,
    )
    .get(BRANCH);
  expect(card?.title_source).toBe("pr");
  expect(card?.turns).toBe(0);
  const wi = card?.id ?? "";

  // 自分の番（PR の確認待ち）: 件名は PR の題名、PR 由来の印が付く
  const q = await get<{ items: QueueItem[] }>("/api/queue");
  const item = q.items.find((x) => x.workItemId === wi) as QueueItem;
  expect(item.followUps.filter((f) => f.status === "open").map((f) => f.kind)).toEqual([
    "review_pr",
  ]);
  expect(item.title).toBe(PR_TITLE);
  expect(item.titleSource).toBe("pr");
  expect(followUpSubject(item, "en")).toBe(PR_TITLE);
  expect(followUpSubject(item, "ja")).toBe(PR_TITLE);

  // 詳細の見出し
  const d = await get<WorkItemDetail>(`/api/work-items/${wi}`);
  expect(d.workItem.title).toBe(PR_TITLE);
  expect(d.workItem.titleSource).toBe("pr");

  // まとめの通知の行も同じ件名
  const n = noticeMessage({ kind: "batch", items: [item] }, "en");
  expect(n.body).toBe(`${PR_TITLE} — Needs review`);
});
