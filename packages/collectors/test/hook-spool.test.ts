import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import claudeCode from "../src/adapters/claude-code/index.ts";
import codex from "../src/adapters/codex/index.ts";
import hookSpool, { spoolDirOf } from "../src/adapters/hook-spool/index.ts";
import { HOOK_ALLOWLIST, type HOOK_TOOL_IDS } from "../src/hook-allowlist.ts";
import type { HookEvent } from "../src/index.ts";
import {
  fixtureCtx,
  readAll,
  rootFor,
  runGoldenSuite,
  runIncrementalSuite,
} from "../src/testing/index.ts";

const FIXTURES = join(import.meta.dir, "fixtures/hook_spool");

runGoldenSuite(hookSpool, FIXTURES);
runIncrementalSuite(hookSpool, FIXTURES);

describe("hook_spool（phase0-plan 3.6.1）", () => {
  test("各イベントを元ツールの ToolId で正規化し、(file, offset) を付ける。不明なツール・session_id なしは捨てる", async () => {
    const dir = join(FIXTURES, "v1", "each-event");
    const ev = (await readAll(hookSpool, rootFor(hookSpool, dir), fixtureCtx())) as HookEvent[];
    expect(ev.map((e) => [e.ref.tool, e.name])).toEqual([
      ["claude_code", "SessionStart"],
      ["claude_code", "UserPromptSubmit"],
      ["claude_code", "PermissionRequest"],
      ["claude_code", "Notification"],
      ["claude_code", "Stop"],
      ["claude_code", "StopFailure"],
      ["claude_code", "SessionEnd"],
      ["codex", "UserPromptSubmit"],
      ["codex", "Stop"],
      ["claude_code", "Stop"],
    ]);
    expect(ev[3]?.notificationType).toBe("permission_prompt");
    expect(ev[5]?.errorType).toBe("rate_limit");
    expect(ev[0]?.configRoot).toBe("/fixture/home/.claude");
    expect(new Set(ev.map((e) => `${e.spool.file}:${e.spool.offset}`)).size).toBe(ev.length);
  });

  test("StopFailure のエラーの種類: 公式の項目名 error を優先し、無ければ古い error_type。識別子の形でなければ入れない", async () => {
    const dir = mkdtempSync(join(tmpdir(), "turnlane-spool-"));
    try {
      const line = (o: object) =>
        JSON.stringify({
          v: 1,
          tool: "claude_code",
          received_at: 1,
          hook_event_name: "StopFailure",
          session_id: "s1",
          ...o,
        });
      writeFileSync(
        join(dir, "hooks-20260902.jsonl"),
        [
          line({ error: "rate_limit" }),
          line({ error_type: "server_error" }),
          line({ error: "overloaded", error_type: "rate_limit" }),
          line({}),
          line({ error: "API Error: x" }),
        ]
          .map((l) => `${l}\n`)
          .join(""),
      );
      const ev = (await readAll(hookSpool, rootFor(hookSpool, dir), fixtureCtx())) as HookEvent[];
      expect(ev.map((e) => e.errorType ?? null)).toEqual([
        "rate_limit",
        "server_error",
        "overloaded",
        null,
        null,
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("許可リストは error を持ち、本文になりうる error_details・last_assistant_message を持たない", () => {
    const keys: readonly string[] = HOOK_ALLOWLIST.claude_code.keys;
    expect(keys).toContain("error");
    expect(keys).toContain("error_type");
    expect(keys).not.toContain("error_details");
    expect(keys).not.toContain("last_assistant_message");
  });

  test("サブエージェントの hook の agent_id・agent_type と permission_mode を入れる（セッションは親の session_id のまま）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "turnlane-spool-"));
    try {
      const line = (o: object) =>
        JSON.stringify({
          v: 1,
          tool: "claude_code",
          received_at: 1,
          hook_event_name: "PermissionRequest",
          session_id: "parent",
          tool_name: "Bash",
          ...o,
        });
      writeFileSync(
        join(dir, "hooks-20260902.jsonl"),
        `${line({ agent_id: "a1", agent_type: "general-purpose", permission_mode: "bypassPermissions" })}\n${line({})}\n`,
      );
      const ev = (await readAll(hookSpool, rootFor(hookSpool, dir), fixtureCtx())) as HookEvent[];
      expect(
        ev.map((e) => [
          e.ref.externalId,
          e.agentId ?? null,
          e.agentType ?? null,
          e.permissionMode ?? null,
        ]),
      ).toEqual([
        ["parent", "a1", "general-purpose", "bypassPermissions"],
        ["parent", null, null, null],
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("term（Orca の端末のハンドル。D-238）は形の合うものだけを HookEvent に入れる", async () => {
    const dir = mkdtempSync(join(tmpdir(), "turnlane-spool-"));
    try {
      const h = "term_0a1b2c3d-4e5f-6789-abcd-ef0123456789";
      const line = (term: string) =>
        JSON.stringify({
          v: 1,
          tool: "claude_code",
          received_at: 1,
          hook_event_name: "Stop",
          session_id: "s",
          term,
        });
      writeFileSync(join(dir, "hooks-20260902.jsonl"), `${line(h)}\n${line("not a handle")}\n`);
      const ev = (await readAll(hookSpool, rootFor(hookSpool, dir), fixtureCtx())) as HookEvent[];
      expect(ev.map((e) => e.term ?? null)).toEqual([h, null]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("quota_horizon（自動再開を止めた理由が 24 時間より先に明ける）は disabled の通知にだけ horizon として入れる", async () => {
    const dir = mkdtempSync(join(tmpdir(), "turnlane-spool-"));
    try {
      const line = (o: object) =>
        JSON.stringify({
          v: 1,
          tool: "claude_code",
          received_at: 1,
          hook_event_name: "Notification",
          session_id: "s",
          ...o,
        });
      writeFileSync(
        join(dir, "hooks-20260902.jsonl"),
        `${[
          line({ notification_type: "quota_auto_resume_disabled", quota_horizon: true }),
          line({ notification_type: "quota_auto_resume_disabled" }),
          line({ notification_type: "idle_prompt", quota_horizon: true }),
          line({ notification_type: "quota_auto_resume_disabled", quota_horizon: "yes" }),
        ].join("\n")}\n`,
      );
      const ev = (await readAll(hookSpool, rootFor(hookSpool, dir), fixtureCtx())) as HookEvent[];
      expect(ev.map((e) => e.horizon ?? null)).toEqual([true, null, null, null]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("spool の行に本文系のキーが紛れていても出力しない", async () => {
    const dir = mkdtempSync(join(tmpdir(), "turnlane-spool-"));
    try {
      const S = "SENTINEL_BODY_spool";
      writeFileSync(
        join(dir, "hooks-20260902.jsonl"),
        `${JSON.stringify({ v: 1, tool: "claude_code", received_at: 1, hook_event_name: "Stop", session_id: "s", prompt: S, last_assistant_message: S, tool_input: { c: S }, message: S })}\n`,
      );
      const ev = await readAll(hookSpool, rootFor(hookSpool, dir), fixtureCtx());
      expect(ev).toHaveLength(1);
      expect(JSON.stringify(ev)).not.toContain(S);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("spool の場所は TURNLANE_DATA_DIR に従う", () => {
    expect(spoolDirOf({ home: "/h", vars: {} })).toBe(
      "/h/Library/Application Support/turnlane/spool",
    );
    expect(spoolDirOf({ home: "/h", vars: { TURNLANE_DATA_DIR: "/d/" } })).toBe("/d/spool");
  });

  test("各アダプタの HookSpec は hook-allowlist.ts の定数から作られている（ADR 0009）", () => {
    for (const a of [claudeCode, codex]) {
      const tool = a.tool as (typeof HOOK_TOOL_IDS)[number];
      expect(a.hooks?.events).toEqual(HOOK_ALLOWLIST[tool].events);
      for (const e of HOOK_ALLOWLIST[tool].events) {
        expect(a.hooks?.allowlist[e]).toEqual(HOOK_ALLOWLIST[tool].keys);
      }
    }
  });
});
