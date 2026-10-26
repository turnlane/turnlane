/**
 * 待っている件の中身（GET /api/work-items/:id/glance。D-207、ADR 0005 の追記 2）。
 * 本文はすべて合成のダミー。DB・ログに出ないことは test/privacy.test.ts で確かめる
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GlanceResponse } from "@turnlane/core/api";
import { MASK } from "@turnlane/core/web";
import { permissionOf } from "../src/glance/index.ts";
import { createApp } from "../src/http/app.ts";
import { type AiEnv, makeAiEnv } from "./helpers/env.ts";
import { claudeTranscript } from "./helpers/transcript.ts";

const TOKEN = "f".repeat(64);
const HOST = "127.0.0.1:7317";
const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 2, 0, 0);

let env: AiEnv;
afterEach(async () => {
  await env?.cleanup();
});

function setup() {
  env = makeAiEnv({ now: T0 });
  for (const r of ["/w/api-gateway", "/w/web-app", "/w/docs-site"]) {
    env.git.repos.set(r, r);
    env.git.defaults.set(r, "main");
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
  const root = join(env.home, ".claude");
  const spool = join(env.dataDir, "spool");
  mkdirSync(spool, { recursive: true });
  const hooks: string[] = [];
  const hook = (sid: string, name: string, at: number, extra: Record<string, string> = {}) => {
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
    writeFileSync(join(spool, "hooks-20261002.jsonl"), `${hooks.join("\n")}\n`);
  };
  const idOf = (branch: string) =>
    env.sqlite
      .query<{ id: string }, [string]>("SELECT id FROM work_item WHERE branch = ?")
      .get(branch)?.id ?? "none";
  const glance = async (branch: string) => {
    const r = await app.request(`http://${HOST}/api/work-items/${idOf(branch)}/glance`, {
      headers: { host: HOST, authorization: `Bearer ${TOKEN}` },
    });
    return { res: r, body: (await r.json()) as GlanceResponse };
  };
  return { root, hook, glance, app };
}

describe("GET /api/work-items/:id/glance（D-207）", () => {
  test("許可待ち: 待っている Bash の説明とコマンド（伏せ字）、件名は直近の意味のある指示。no-store", async () => {
    const { root, hook, glance } = setup();
    const sid = "66666666-0000-4000-8000-000000000001";
    const tr = claudeTranscript(root, { sid, cwd: "/w/api-gateway", branch: "fix/auth-refresh" });
    tr.human(T0, { text: "Fix the 401 when the refresh token expires" });
    tr.assistantEnd(T0 + MIN, "Which one should I take?");
    tr.human(T0 + 2 * MIN, { text: "ok" });
    tr.toolResult(
      T0 + 2 * MIN + 500,
      tr.toolUse(T0 + 2 * MIN + 100, "Read", { file_path: "/w/api-gateway/a.ts" }),
    );
    tr.toolUse(T0 + 3 * MIN, "Bash", {
      command: "API_TOKEN=abc123 git push origin fix/auth-refresh\necho done",
      description: "Push the fix branch",
    });
    hook(sid, "UserPromptSubmit", T0 + 2 * MIN);
    hook(sid, "PermissionRequest", T0 + 3 * MIN, { tool_name: "Bash" });
    env.clock.set(T0 + 5 * MIN);
    await env.sync();
    const { res, body } = await glance("fix/auth-refresh");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(body.kind).toBe("permission");
    expect(body.permission).toMatchObject({
      tool: "Bash",
      label: "Push the fix branch",
      detail: `API_TOKEN=${MASK} git push origin fix/auth-refresh`,
      detailKind: "command",
      moreLines: 1,
      masked: true,
    });
    expect(body.prompt?.text).toBe("Fix the 401 when the refresh token expires");
  });

  test("返答待ち: 最後のメッセージの問い。回答待ち: AskUserQuestion の問いと選択肢", async () => {
    const { root, hook, glance } = setup();
    const a = "66666666-0000-4000-8000-000000000002";
    const ta = claudeTranscript(root, { sid: a, cwd: "/w/web-app", branch: "feat/board-width" });
    ta.human(T0, { text: "3日ボードの列幅を直して" });
    ta.assistantEnd(T0 + MIN, "左の列は直しました。右の列も同じ幅にしますか？");
    hook(a, "UserPromptSubmit", T0);
    hook(a, "Stop", T0 + MIN);
    const b = "66666666-0000-4000-8000-000000000003";
    const tb = claudeTranscript(root, { sid: b, cwd: "/w/docs-site", branch: "docs/deploy" });
    tb.human(T0, { text: "デプロイの手順を整理して" });
    tb.ask(T0 + MIN, [
      { question: "デプロイ先は?", options: ["staging", "production", "両方", "あとで"] },
      { question: "いつ?", options: ["今日", "明日"] },
    ]);
    env.clock.set(T0 + 20 * MIN);
    await env.sync();
    const q = (await glance("feat/board-width")).body;
    expect(q.kind).toBe("question");
    expect(q.question?.row).toBe("右の列も同じ幅にしますか？");
    expect(q.prompt?.text).toBe("3日ボードの列幅を直して");
    const k = (await glance("docs/deploy")).body;
    expect(k.kind).toBe("ask");
    expect(k.ask).toMatchObject({
      question: "デプロイ先は?",
      options: ["staging", "production", "両方"],
      more: 1,
    });
    expect(k.ask?.questions).toHaveLength(2);
  });

  test("AskUserQuestion のダイアログの PermissionRequest: 許可ではなく問いとして読む。tool_use がまだ記録に無ければ unreadable", async () => {
    const { root, hook, glance } = setup();
    const a = "66666666-0000-4000-8000-000000000004";
    const ta = claudeTranscript(root, { sid: a, cwd: "/w/docs-site", branch: "docs/ask-hook" });
    ta.human(T0, { text: "デプロイの手順を整理して" });
    ta.ask(T0 + MIN, [{ question: "デプロイ先は?", options: ["staging", "production"] }]);
    hook(a, "UserPromptSubmit", T0);
    hook(a, "PermissionRequest", T0 + MIN, { tool_name: "AskUserQuestion" });
    const b = "66666666-0000-4000-8000-000000000005";
    const tb = claudeTranscript(root, { sid: b, cwd: "/w/web-app", branch: "feat/ask-hook" });
    tb.human(T0, { text: "列の幅を直して" });
    hook(b, "UserPromptSubmit", T0);
    hook(b, "PermissionRequest", T0 + MIN, { tool_name: "AskUserQuestion" });
    env.clock.set(T0 + 3 * MIN);
    await env.sync();
    const kinds = env.sqlite
      .query<{ kind: string }, []>("SELECT kind FROM follow_up ORDER BY kind")
      .all()
      .map((r) => r.kind);
    expect(kinds).toEqual(["approve", "approve"]);
    const k = (await glance("docs/ask-hook")).body;
    expect(k.kind).toBe("ask");
    expect(k.ask).toMatchObject({ question: "デプロイ先は?", options: ["staging", "production"] });
    const n = (await glance("feat/ask-hook")).body;
    expect(n.kind).toBe("none");
    expect(n.unavailable).toBe("unreadable");
    expect(n.prompt?.text).toBe("列の幅を直して");
  });

  test("記録が消えても保存した中身と件名は出る（ADR 0018）。保存がオフなら中身なしで理由だけ。行に出さない設定なら読まない。無い AI 項目は 404", async () => {
    const { root, hook, glance, app } = setup();
    const sid = "66666666-0000-4000-8000-000000000004";
    const tr = claudeTranscript(root, { sid, cwd: "/w/api-gateway", branch: "fix/gone" });
    tr.human(T0, { text: "Fix the flaky test" });
    tr.toolUse(T0 + MIN, "Bash", { command: "bun test", description: "Run tests" });
    hook(sid, "PermissionRequest", T0 + MIN, { tool_name: "Bash" });
    env.clock.set(T0 + 2 * MIN);
    await env.sync();
    expect((await glance("fix/gone")).body.kind).toBe("permission");
    const { rmSync } = await import("node:fs");
    rmSync(tr.path);
    const kept = (await glance("fix/gone")).body;
    expect(kept).toMatchObject({
      kind: "permission",
      permission: { tool: "Bash", label: "Run tests", detail: "bun test" },
      prompt: { text: "Fix the flaky test" },
    });
    env.sqlite.run(
      "INSERT INTO setting (key, value_json, updated_at, hlc, device_id) SELECT 'turn.store_detail', 'false', 0, hlc, device_id FROM setting LIMIT 1",
    );
    const gone = (await glance("fix/gone")).body;
    expect(gone).toMatchObject({ kind: "none", unavailable: "missing" });
    expect(gone.prompt).toBeUndefined();
    env.sqlite.run(
      "INSERT INTO setting (key, value_json, updated_at, hlc, device_id) SELECT 'turn.show_detail', 'false', 0, hlc, device_id FROM setting LIMIT 1",
    );
    expect((await glance("fix/gone")).body).toMatchObject({ kind: "none", unavailable: "off" });
    const r = await app.request(`http://${HOST}/api/work-items/nope/glance`, {
      headers: { host: HOST, authorization: `Bearer ${TOKEN}` },
    });
    expect(r.status).toBe(404);
  });
});

describe("ツールの呼び出し → 表示する中身", () => {
  test("Edit はリポジトリからの相対パスだけ（中身は読まない）、WebFetch は host と path、MCP はキー名だけ", () => {
    const e = permissionOf(
      "Edit",
      { file_path: "/w/web-app/src/deploy.ts", old_string: "SECRET_A", new_string: "SECRET_B" },
      "/w/web-app",
      "/home/x",
    );
    expect(e).toEqual({ tool: "Edit", detail: "src/deploy.ts", detailKind: "path", masked: false });
    expect(JSON.stringify(e)).not.toContain("SECRET");
    expect(
      permissionOf(
        "WebFetch",
        { url: "https://docs.example.com/api/v2?key=abc", prompt: "p" },
        null,
        "/h",
      ),
    ).toMatchObject({ detail: "docs.example.com/api/v2", detailKind: "url" });
    const m = permissionOf(
      "mcp__github__create_pull_request",
      { title: "t", body: "SECRET" },
      null,
      "/h",
    );
    expect(m).toMatchObject({
      tool: "github",
      sub: "create_pull_request",
      argKeys: ["title", "body"],
    });
    expect(JSON.stringify(m)).not.toContain("SECRET");
    expect(permissionOf("Read", { file_path: "/h/notes/a.md" }, null, "/h").detail).toBe(
      "~/notes/a.md",
    );
  });
});
