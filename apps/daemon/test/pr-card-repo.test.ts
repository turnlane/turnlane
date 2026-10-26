/**
 * PR のカードのリポジトリは PR の属するリポジトリ（fix-pr-card-repo）。計画のディレクトリのセッションが別のリポジトリに
 * PR を出しても、PR のカード（ターンの無いカード）のリポジトリをセッションの cwd のリポジトリにしない。
 * 手元にクローンがあればそのパス、無ければ `owner/repo`。前の版で間違ったリポジトリに付いたカードは次の判定で付け替わり、
 * 同じ repo×branch のカードが既にあれば統合する。本文はすべて合成のダミー
 */
import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import type { QueueItem } from "@turnlane/core/api";
import { noticeWhere } from "@turnlane/core/web";
import type { GhClient } from "../src/github/pr-poller.ts";
import { createApp } from "../src/http/app.ts";
import { loadTarget } from "../src/open/target.ts";
import { type AiEnv, makeAiEnv } from "./helpers/env.ts";
import { claudeTranscript } from "./helpers/transcript.ts";

const TOKEN = "f".repeat(64);
const HOST = "127.0.0.1:7317";
const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 2, 0, 0);
const BRANCH = "fix/lp-notify-wording";

let env: AiEnv;
afterEach(async () => {
  await env?.cleanup();
});

const gh: GhClient = {
  viewer: () => "me",
  prView: () => ({
    state: "open",
    reviewDecision: null,
    title: "Clarify the invite link wording on the landing page",
    url: "https://github.com/example/site/pull/8",
    headRefName: BRANCH,
    mergedAt: null,
    closedAt: null,
    reviews: [],
  }),
};

function setup(opts: { clone: boolean }) {
  env = makeAiEnv({ now: T0, gh });
  // 計画のディレクトリ（リモートが無い）と、PR の属するリポジトリのクローン（リモートが example/site）
  env.git.repos.set("/w/plans", "/w/plans");
  env.git.defaults.set("/w/plans", "main");
  if (opts.clone) {
    env.git.repos.set("/w/site", "/w/site");
    env.git.defaults.set("/w/site", "main");
    env.git.remotes.set("/w/site", ["example/site"]);
  }
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
  return { get, root: join(env.home, ".claude") };
}

/** 計画のディレクトリのセッションが example/site に PR #8 を出して終わる */
async function planSessionOpensPr(root: string) {
  const s = claudeTranscript(root, {
    sid: "88888888-0000-4000-8000-000000000001",
    cwd: "/w/plans",
    branch: "main",
  });
  s.aiTitle(T0, "Weekly planning");
  s.human(T0, { text: "Ship the landing page wording fix" });
  s.prLink(T0 + 2 * MIN, "example/site", 8);
  s.assistantEnd(T0 + 3 * MIN, "Opened the PR.", { durationMs: 3 * MIN });
}

/** クローンのディレクトリで動いたセッション（クローンを手元のリポジトリとして知る） */
function siteSession(root: string, branch: string, at: number) {
  const s = claudeTranscript(root, {
    sid: "88888888-0000-4000-8000-000000000002",
    cwd: "/w/site",
    branch,
  });
  s.human(at, { text: "Tidy the footer links" });
  s.assistantEnd(at + MIN, "Done.", { durationMs: MIN });
}

async function settle(at: number) {
  env.clock.set(at);
  await env.sync();
  env.ai.poller?.pollOnce();
  await env.sync();
}

type Card = {
  id: string;
  group_key: string;
  repo_root: string | null;
  branch: string | null;
  deleted_at: number | null;
  merged_into_id: string | null;
};
const cards = () =>
  env.sqlite
    .query<Card, [string]>(
      "SELECT id, group_key, repo_root, branch, deleted_at, merged_into_id FROM work_item WHERE branch = ? ORDER BY created_at",
    )
    .all(BRANCH);
const openReviews = () =>
  env.sqlite
    .query<{ id: string; work_item_id: string }, []>(
      "SELECT id, work_item_id FROM follow_up WHERE kind = 'review_pr' AND status = 'open' AND deleted_at IS NULL",
    )
    .all();

test("PR だけのカードのリポジトリは PR の属するリポジトリのクローン（セッションの cwd でない）。開くと head の worktree", async () => {
  const { get, root } = setup({ clone: true });
  siteSession(root, "main", T0 - 60 * MIN);
  planSessionOpensPr(root);
  await settle(T0 + 10 * MIN);

  const [card] = cards();
  expect(card?.repo_root).toBe("/w/site");
  expect(card?.group_key).toBe(`branch:/w/site#${BRANCH}`);

  // 自分の番の 3 行目（リポジトリ · ブランチ）
  const q = await get<{ items: QueueItem[] }>("/api/queue");
  const item = q.items.find((x) => x.workItemId === card?.id) as QueueItem;
  expect(item.repoRoot).toBe("/w/site");
  expect(noticeWhere(item)).toBe(`site · ${BRANCH}`);

  // 開く: セッションの無いカードは、PR のリポジトリで head ブランチを取り出している worktree に向く
  env.open.dirs.add("/w/site");
  const t1 = loadTarget(env.sqlite, env.open, { workItemId: card?.id as string }, T0 + 10 * MIN);
  expect(t1.folder).toBe("/w/site");
  env.open.dirs.add("/w/site-wt/lp");
  env.open.worktrees.set(`/w/site#${BRANCH}`, "/w/site-wt/lp");
  const t2 = loadTarget(env.sqlite, env.open, { workItemId: card?.id as string }, T0 + 10 * MIN);
  expect(t2.folder).toBe("/w/site-wt/lp");
  expect(t2.worktree).toBe("/w/site-wt/lp");
  expect(t2.prUrl).toBe("https://github.com/example/site/pull/8");
});

test("手元にクローンが無ければ owner/repo を持つ（表示は repo の名前。フォルダとしては開かない）", async () => {
  const { get, root } = setup({ clone: false });
  planSessionOpensPr(root);
  await settle(T0 + 10 * MIN);

  const [card] = cards();
  expect(card?.repo_root).toBe("example/site");
  const q = await get<{ items: QueueItem[] }>("/api/queue");
  const item = q.items.find((x) => x.workItemId === card?.id) as QueueItem;
  expect(noticeWhere(item)).toBe(`site · ${BRANCH}`);
  const t = loadTarget(env.sqlite, env.open, { workItemId: card?.id as string }, T0 + 10 * MIN);
  expect(t.folder).toBeNull();
  expect(t.prUrl).toBe("https://github.com/example/site/pull/8");
});

test("前の版でセッションの cwd のリポジトリに付いたカードは、次の判定で PR のリポジトリに付け替わる（ID と自分の番を保つ）", async () => {
  const { root } = setup({ clone: true });
  siteSession(root, "main", T0 - 60 * MIN);
  planSessionOpensPr(root);
  await settle(T0 + 10 * MIN);
  const [card] = cards();
  const [review] = openReviews();
  expect(review?.work_item_id).toBe(card?.id as string);

  // 前の版の状態: カードのキーとリポジトリが計画のディレクトリ
  env.sqlite.run("UPDATE work_item SET group_key = ?, repo_root = ? WHERE id = ?", [
    `branch:/w/plans#${BRANCH}`,
    "/w/plans",
    card?.id as string,
  ]);
  await settle(T0 + 20 * MIN);

  const after = cards().filter((c) => c.deleted_at === null);
  expect(after).toHaveLength(1);
  expect(after[0]?.id).toBe(card?.id as string);
  expect(after[0]?.repo_root).toBe("/w/site");
  expect(after[0]?.group_key).toBe(`branch:/w/site#${BRANCH}`);
  expect(openReviews()).toEqual([{ id: review?.id as string, work_item_id: card?.id as string }]);
});

test("付け替え先に同じ repo×branch のカードがあれば統合する（自分の番は 1 つ）", async () => {
  // はじめはクローンのリモートが PR のリポジトリと結べない → PR は owner/repo のカード、クローンのブランチは別のカード
  const { root } = setup({ clone: true });
  env.git.remotes.set("/w/site", ["example/site-old"]);
  siteSession(root, BRANCH, T0 - 30 * MIN);
  planSessionOpensPr(root);
  await settle(T0 + 10 * MIN);
  const before = cards();
  expect(before.map((c) => c.repo_root).sort()).toEqual(["/w/site", "example/site"]);
  const pseudo = before.find((c) => c.repo_root === "example/site") as Card;
  const target = before.find((c) => c.repo_root === "/w/site") as Card;
  expect(openReviews().map((r) => r.work_item_id)).toEqual([pseudo.id]);

  // リモートが PR のリポジトリになった → PR のカードはクローンの同じブランチのカードへ統合
  env.git.remotes.set("/w/site", ["example/site"]);
  await settle(T0 + 40 * MIN);

  const all = cards();
  const live = all.filter((c) => c.deleted_at === null);
  expect(live.map((c) => c.id)).toEqual([target.id]);
  expect(all.find((c) => c.id === pseudo.id)?.merged_into_id).toBe(target.id);
  expect(openReviews().map((r) => r.work_item_id)).toEqual([target.id]);
  const pr = env.sqlite
    .query<{ work_item_id: string }, []>("SELECT work_item_id FROM ai_artifact WHERE kind = 'pr'")
    .get();
  expect(pr?.work_item_id).toBe(target.id);
});

test("あとでクローンを知ったら owner/repo のカードをそのまま付け替える", async () => {
  const { root } = setup({ clone: true });
  planSessionOpensPr(root);
  await settle(T0 + 10 * MIN);
  const [pseudo] = cards();
  expect(pseudo?.repo_root).toBe("example/site");

  siteSession(root, BRANCH, T0 + 30 * MIN);
  await settle(T0 + 40 * MIN);
  const live = cards().filter((c) => c.deleted_at === null);
  expect(live).toHaveLength(1);
  expect(live[0]?.id).toBe(pseudo?.id as string);
  expect(live[0]?.repo_root).toBe("/w/site");
  expect(openReviews().map((r) => r.work_item_id)).toEqual([pseudo?.id as string]);
});
