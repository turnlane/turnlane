/**
 * 外の作業の報告（ADR 0021。m2-api 37 章）: POST /api/ai/reports → spool の 1 行 → report アダプタ → 既存の判定。
 * 合成の報告だけ（実データ・hooks の設定には触れない）
 */
import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { putSetting } from "@turnlane/core";
import type { QueueResponse, ReportResponse, ReportSourcesResponse } from "@turnlane/core/api";
import { MASK } from "@turnlane/core/web";
import { createApp } from "../src/http/app.ts";
import { createPlanner } from "../src/planner/index.ts";
import { type AiEnv, makeAiEnv, present } from "./helpers/env.ts";

const TOKEN = "f".repeat(64);
const HOST = "127.0.0.1:7317";
const MIN = 60_000;
const H = 60 * MIN;
const T0 = Date.UTC(2026, 9, 2, 0, 0);

let env: AiEnv;
afterEach(async () => {
  await env?.cleanup();
});

async function setup() {
  env = makeAiEnv({ now: T0 });
  present(env.sqlite, T0 - H, T0 + 14 * H);
  await env.ai.supervisor.detect();
  await env.ai.supervisor.beginIngest();
  const planner = createPlanner({
    sqlite: env.sqlite,
    mutate: env.mutate,
    clock: env.clock,
    hub: env.hub,
    ai: env.ai,
  });
  const app = createApp({
    token: TOKEN,
    port: 7317,
    hub: env.hub,
    health: () => ({}) as never,
    admin: { backup: () => ({ date: "", path: "" }) },
    ai: () => env.ai.deps,
    planner: () => planner,
    recordUserOp: env.ai.recordUserOp,
  });
  const call = async <T>(method: string, path: string, body?: unknown) => {
    const r = await app.request(`http://${HOST}${path}`, {
      method,
      headers: {
        host: HOST,
        authorization: `Bearer ${TOKEN}`,
        "x-turnlane-client": "cli",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, body: (await r.json()) as T };
  };
  const report = (body: Record<string, unknown>, at = env.clock.now()) => {
    env.clock.set(at);
    return call<ReportResponse & { error?: string; field?: string }>(
      "POST",
      "/api/ai/reports",
      body,
    );
  };
  const items = async () =>
    (await call<QueueResponse>("GET", "/api/queue")).body.items.filter((x) =>
      x.followUps.some((f) => f.status === "open"),
    );
  const item = (source: string, id: string) =>
    env.sqlite
      .query<
        { id: string; status: string; project_id: string | null; title_auto: string },
        [string, string]
      >(
        `SELECT w.id, w.status, w.project_id, w.title_auto FROM work_item w
         WHERE w.id IN (SELECT t.work_item_id FROM ai_turn t JOIN ai_session s ON s.id = t.session_id
                        WHERE s.tool = ? AND s.external_id = ?)`,
      )
      .get(source, id);
  return { call, report, items, item };
}

const base = { source: "myscript", id: "export-1" };

describe("POST /api/ai/reports", () => {
  test("started → waiting(question) → done: 実行中 → すぐ自分の番（問いと選択肢を伏せ字の後に保存）→ 完了", async () => {
    const s = await setup();
    const r1 = await s.report({
      ...base,
      state: "started",
      title: "Nightly export",
      project: "Reports",
    });
    expect(r1.status).toBe(202);
    expect(r1.body).toMatchObject({ accepted: true, queued: false });
    expect(r1.body.workItemId).toBeTruthy();
    expect(s.item("myscript", "export-1")).toMatchObject({
      status: "running",
      title_auto: "Nightly export",
    });
    // プロジェクトは名前で作り、項目に付ける
    const proj = env.sqlite
      .query<{ id: string }, []>("SELECT id FROM project WHERE name = 'Reports'")
      .get();
    expect(s.item("myscript", "export-1")?.project_id).toBe(proj?.id ?? "none");
    // spool の 1 行（本文の入れ物のキーは使わない）
    const spool = join(env.dataDir, "spool");
    const file = readdirSync(spool).find((f) => f.startsWith("report-"));
    expect(file).toBe("report-20261002.jsonl");

    await s.report(
      {
        ...base,
        state: "waiting",
        wait: {
          kind: "question",
          text: "Overwrite the file? token=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123",
          options: ["Overwrite", "Keep both"],
        },
        url: "https://example.com/runs/1",
      },
      T0 + 5 * MIN,
    );
    expect(s.item("myscript", "export-1")?.status).toBe("needs_input");
    const rows = await s.items();
    expect(rows.map((x) => x.followUps.map((f) => f.kind))).toEqual([["reply"]]);
    const fid = rows[0]?.followUps[0]?.id ?? "";
    env.ai.runner.runOnce();
    const wd = env.sqlite
      .query<{ kind: string; text: string; options_json: string; masked: number }, [string]>(
        "SELECT kind, text, options_json, masked FROM wait_detail WHERE follow_up_id = ?",
      )
      .get(fid);
    expect(wd?.kind).toBe("ask");
    expect(wd?.text).toContain(MASK);
    expect(wd?.text).not.toContain("abcdefghijklmnop");
    expect(JSON.parse(wd?.options_json ?? "[]")).toEqual([
      { question: wd?.text, options: ["Overwrite", "Keep both"] },
    ]);
    expect(wd?.masked).toBe(1);

    // 答える: 中身は読めるだけ（端末に送る口は無い。答えは myscript で）
    const wid = rows[0]?.workItemId ?? "";
    const w = await s.call<{
      kind: string;
      question?: { text: string };
      options?: { n: number; label: string }[];
      delivery: { deliverable: boolean; reason?: string; terminal: string | null };
    }>("GET", `/api/work-items/${wid}/wait`);
    expect(w.body.kind).toBe("ask");
    expect(w.body.question?.text).toContain("Overwrite the file?");
    expect(w.body.options?.map((o) => o.label)).toEqual(["Overwrite", "Keep both"]);
    expect(w.body.delivery).toMatchObject({
      deliverable: false,
      reason: "report",
      terminal: "myscript",
    });
    const sent = await s.call("POST", `/api/work-items/${wid}/answer`, { text: "1" });
    expect(sent.status).toBe(409);
    // 開く: 報告の URL
    const opts = await s.call<{ default: string | null }>(
      "GET",
      `/api/open/options?followUpId=${fid}`,
    );
    expect(opts.body.default).toBe("report_url");
    const opened = await s.call<{ outcome: string }>("POST", "/api/open", { followUpId: fid });
    expect(opened.status).toBe(200);
    expect(env.open.runs).toContainEqual(["/usr/bin/open", "https://example.com/runs/1"]);

    await s.report({ ...base, state: "done" }, T0 + 9 * MIN);
    expect(s.item("myscript", "export-1")?.status).toBe("done");
    expect(await s.items()).toEqual([]);
    const fu = env.sqlite
      .query<{ status: string; close_reason: string }, [string]>(
        "SELECT status, close_reason FROM follow_up WHERE id = ?",
      )
      .get(fid);
    expect(fu).toEqual({ status: "done", close_reason: "auto:answered" });
  });

  test("waiting(permission) は許可のタスク、error はエラーと再開のタスク", async () => {
    const s = await setup();
    await s.report({ source: "nightly", id: "backup", state: "started", title: "Backup" });
    await s.report(
      {
        source: "nightly",
        id: "backup",
        state: "waiting",
        wait: { kind: "permission", text: "Delete 3 old snapshots", label: "Delete snapshots" },
      },
      T0 + 2 * MIN,
    );
    expect(s.item("nightly", "backup")?.status).toBe("needs_input");
    const rows = await s.items();
    expect(rows.map((x) => x.followUps.map((f) => f.kind))).toEqual([["approve"]]);
    env.ai.runner.runOnce();
    const wd = env.sqlite
      .query<{ kind: string; tool: string; label: string }, []>(
        "SELECT kind, tool, label FROM wait_detail",
      )
      .get();
    expect(wd).toEqual({
      kind: "permission",
      tool: "Delete snapshots",
      label: "Delete 3 old snapshots",
    });
    await s.report(
      { source: "nightly", id: "backup", state: "error", error: { kind: "timeout" } },
      T0 + 4 * MIN,
    );
    expect(s.item("nightly", "backup")?.status).toBe("error");
    expect((await s.items()).map((x) => x.followUps.map((f) => f.kind))).toEqual([
      ["resume_error"],
    ]);
  });

  test("だめな報告は 400 と項目の名前だけ（予約の出どころ・開けない URL・知らないキー）", async () => {
    const s = await setup();
    const bad = async (b: unknown) => {
      const r = await s.call<{ error: string; field: string }>("POST", "/api/ai/reports", b);
      expect(r.status).toBe(400);
      return r.body.field;
    };
    expect(await bad({ ...base, source: "claude_code", state: "started" })).toBe("source");
    expect(await bad({ ...base, state: "started", url: "file:///etc/hosts" })).toBe("url");
    expect(await bad({ ...base, state: "waiting" })).toBe("wait");
    expect(await bad({ ...base, state: "started", prompt: "hello" })).toBe("prompt");
    expect(await bad("x")).toBe("body");
    expect(existsSpool()).toBe(false);
  });

  test("同じ client_id は 1 回だけ。出どころ 1 つにつき 1 分 60 件まで", async () => {
    const s = await setup();
    const cid = "0192a3b4-0000-7000-8000-000000000001";
    await s.report({ ...base, state: "started", client_id: cid });
    await s.report({ ...base, state: "started", client_id: cid }, T0 + 1000);
    const n = () =>
      env.sqlite
        .query<{ n: number }, []>(
          "SELECT count(*) AS n FROM ai_turn t JOIN ai_session s ON s.id = t.session_id WHERE s.tool = 'myscript'",
        )
        .get()?.n ?? 0;
    expect(n()).toBe(1);
    for (let i = 0; i < 65; i++)
      await s.report({ source: "myscript", id: `job-${i}`, state: "done" }, T0 + 2 * MIN + i * 100);
    // 2 分目の 60 件まで（最初の分の 1 件と合わせて 61）
    expect(n()).toBe(61);
  });

  test("デーモンが止まっている間に CLI が spool に書いた行も、次の走査で同じように取り込む", async () => {
    const s = await setup();
    const spool = join(env.dataDir, "spool");
    mkdirSync(spool, { recursive: true });
    appendFileSync(
      join(spool, "report-20261002.jsonl"),
      `${JSON.stringify({
        v: 1,
        kind: "report",
        received_at: T0,
        client_id: "c-offline-1",
        source: "myscript",
        id: "offline",
        state: "waiting",
        title: "Offline job",
        wait_kind: "question",
        wait_text: "Continue?",
      })}\n`,
    );
    env.clock.set(T0 + MIN);
    await env.sync();
    expect(s.item("myscript", "offline")?.status).toBe("needs_input");
    expect((await s.items()).length).toBe(1);
    // 判定をやり直しても同じ
    env.ai.runner.rederive();
    expect(s.item("myscript", "offline")?.status).toBe("needs_input");
  });

  test("待ちの中身を保存しない設定なら、報告の文は持たない", async () => {
    const s = await setup();
    putSetting(env.mutate, "turn.store_detail", false);
    await s.report({
      ...base,
      state: "waiting",
      wait: { kind: "question", text: "Overwrite?" },
    });
    env.ai.runner.runOnce();
    expect(
      env.sqlite.query<{ n: number }, []>("SELECT count(*) AS n FROM wait_detail").get()?.n,
    ).toBe(0);
    expect(
      env.sqlite
        .query<{ n: number }, []>("SELECT count(*) AS n FROM ai_turn WHERE wait_json IS NOT NULL")
        .get()?.n,
    ).toBe(0);
    expect(s.item("myscript", "export-1")?.status).toBe("needs_input");
  });

  test("GET /api/ai/reports/sources: 報告してきた出どころ", async () => {
    const s = await setup();
    await s.report({ ...base, state: "started" });
    await s.report({ source: "nightly", id: "a", state: "done" }, T0 + MIN);
    const r = await s.call<ReportSourcesResponse>("GET", "/api/ai/reports/sources");
    expect(r.body).toEqual({
      enabled: true,
      sources: [
        { source: "myscript", items: 1, lastReportAt: T0 },
        { source: "nightly", items: 1, lastReportAt: T0 + MIN },
      ],
    });
  });
});

function existsSpool(): boolean {
  try {
    return readdirSync(join(env.dataDir, "spool")).some(
      (f) =>
        f.startsWith("report-") && readFileSync(join(env.dataDir, "spool", f), "utf8").length > 0,
    );
  } catch {
    return false;
  }
}
