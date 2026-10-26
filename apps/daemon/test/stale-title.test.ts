/**
 * PR をマージした後に同じセッションで別の作業を頼んだとき、件名が古い PR の題名に残らない（fix-stale-title、spec-glance §2.2）。
 * 同じターンで 2 回目の許可待ちになっても自分の番と詳細に出る。本文はすべて合成のダミー
 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GlanceResponse, QueueItem, WorkItemDetail } from "@turnlane/core/api";
import { followUpSubject } from "@turnlane/core/web";
import type { GhClient } from "../src/github/pr-poller.ts";
import { createApp } from "../src/http/app.ts";
import { type AiEnv, makeAiEnv } from "./helpers/env.ts";
import { claudeTranscript } from "./helpers/transcript.ts";

const TOKEN = "f".repeat(64);
const HOST = "127.0.0.1:7317";
const MIN = 60_000;
const H = 60 * MIN;
const T0 = Date.UTC(2026, 9, 2, 0, 0);
const PR_TITLE = "docs: deploy production from main only";

let env: AiEnv;
afterEach(async () => {
  await env?.cleanup();
});

test("マージ済みの PR の後の許可待ち: 件名・詳細の見出し・通知の件名は PR の題名でなく、中身も読める", async () => {
  const gh: GhClient = {
    viewer: () => "me",
    prView: () => ({
      state: "merged",
      reviewDecision: "APPROVED",
      title: PR_TITLE,
      url: "https://example.invalid/pull/7",
      headRefName: "docs/deploy-branch",
      mergedAt: T0 + 2 * H,
      closedAt: T0 + 2 * H,
      reviews: [],
    }),
  };
  env = makeAiEnv({ now: T0, gh });
  env.git.repos.set("/w/docs-site", "/w/docs-site");
  env.git.defaults.set("/w/docs-site", "main");
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
  mkdirSync(join(env.dataDir, "spool"), { recursive: true });
  const hooks: string[] = [];
  const hook = (name: string, at: number, extra: Record<string, string> = {}) => {
    hooks.push(
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
    writeFileSync(join(env.dataDir, "spool", "hooks-20261002.jsonl"), `${hooks.join("\n")}\n`);
  };

  // 既定のブランチで 1 ターン（セッションが他のカードにまたがる → カードの自動の題名は PR の題名）
  const sid = "77777777-0000-4000-8000-000000000001";
  const onMain = claudeTranscript(root, { sid, cwd: "/w/docs-site", branch: "main" });
  const tr = claudeTranscript(root, { sid, cwd: "/w/docs-site", branch: "docs/deploy-branch" });
  onMain.aiTitle(T0, "Deploy docs cleanup");
  onMain.human(T0, { text: "Fix the README typos" });
  onMain.assistantEnd(T0 + 5 * MIN, "Done.");
  tr.human(T0 + 10 * MIN, { text: "Update the docs for deploying from main only" });
  tr.prLink(T0 + 20 * MIN, "example/docs-site", 7);
  tr.assistantEnd(T0 + 21 * MIN, "Opened the PR.", { durationMs: 11 * MIN });
  env.clock.set(T0 + 3 * H);
  await env.sync();
  env.ai.poller?.pollOnce();
  await env.sync();

  // PR のマージの後、同じセッションで別の依頼。1 回目の許可は通り、同じターンで 2 回目の許可待ち
  const t1 = T0 + 3 * H;
  tr.human(t1, { text: "Estimate the monthly infra cost\n\nBreak it down by service." });
  hook("UserPromptSubmit", t1);
  const first = tr.toolUse(t1 + MIN, "Bash", { command: "ls" });
  hook("PermissionRequest", t1 + MIN, { tool_name: "Bash" });
  env.clock.set(t1 + MIN + 10_000);
  await env.sync();
  tr.toolResult(t1 + MIN + 30_000, first);
  env.clock.set(t1 + 2 * MIN);
  await env.sync();
  // 1 回目の許可は通って閉じた
  expect(
    env.sqlite
      .query<{ status: string }, []>("SELECT status FROM follow_up WHERE kind = 'approve'")
      .all()
      .map((r) => r.status),
  ).toEqual(["done"]);
  tr.toolUse(t1 + 3 * MIN, "Bash", {
    command: "cloudcost report --month 2026-09",
    description: "Get last month's cost",
  });
  hook("PermissionRequest", t1 + 3 * MIN, { tool_name: "Bash" });
  env.clock.set(t1 + 5 * MIN);
  await env.sync();

  const id =
    env.sqlite
      .query<{ id: string; title_source: string }, []>(
        "SELECT id, title_source FROM work_item WHERE branch = 'docs/deploy-branch'",
      )
      .get() ?? null;
  expect(id?.title_source).toBe("pr");
  const wi = id?.id ?? "";

  // 自分の番に出る（2 回目の許可待ち）。件名（通知・メニューバーの既定）は PR の題名でない
  const q = await get<{ items: QueueItem[] }>("/api/queue");
  const item = q.items.find((x) => x.workItemId === wi);
  expect(item?.status).toBe("needs_input");
  expect(item?.followUps.filter((f) => f.status === "open").map((f) => f.kind)).toEqual([
    "approve",
  ]);
  expect(item?.title).toBe("Deploy docs cleanup");
  expect(followUpSubject(item as QueueItem, "en")).toBe("Deploy docs cleanup");

  // 詳細の見出しの元も PR の題名でない。成果の PR はそのまま
  const d = await get<WorkItemDetail>(`/api/work-items/${wi}`);
  expect(d.workItem.title).toBe("Deploy docs cleanup");
  expect(d.workItem.titleSource).toBe("ai_title");
  expect(d.artifacts.find((a) => a.kind === "pr")?.title).toBe(PR_TITLE);

  // 中身: 待っているコマンドと、件名に使う直近の指示
  const g = await get<GlanceResponse>(`/api/work-items/${wi}/glance`);
  expect(g.kind).toBe("permission");
  expect(g.permission?.detail).toBe("cloudcost report --month 2026-09");
  // 件名はその日の最初の自分の指示で固定（D-214 (1)・ADR 0018）。PR の題名ではない
  expect(g.prompt?.text).toBe("Update the docs for deploying from main only");

  // 終わった後（待っていない）も、AI の線と詳細の見出しに使う直近の指示は読める
  tr.toolResult(t1 + 6 * MIN, "x");
  tr.assistantEnd(t1 + 7 * MIN, "Here is the estimate.");
  hook("Stop", t1 + 7 * MIN);
  env.clock.set(t1 + 8 * MIN);
  await env.sync();
  const after = await get<GlanceResponse>(`/api/work-items/${wi}/glance`);
  expect(after.kind).toBe("none");
  expect(after.prompt?.text).toBe("Update the docs for deploying from main only");
});
