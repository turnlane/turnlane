import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nullLogger } from "@turnlane/collectors";
import { FakeClock, resolvePaths, type TurnlanePaths } from "@turnlane/core";
import { FakeGit } from "../../daemon/src/ingest/git.ts";
import { type RunningDaemon, startDaemon } from "../../daemon/src/main.ts";
import { claudeTranscript } from "../../daemon/test/helpers/transcript.ts";
import { doctorCommand } from "../src/commands/doctor.ts";
import {
  buildRedacted,
  type RedactInput,
  redactedLines,
  scrub,
} from "../src/commands/doctor-redact.ts";
import type { CliEnv } from "../src/env.ts";
import { FakeLaunchctl } from "../src/launchctl.ts";

const BASE: RedactInput = {
  cliVersion: "0.6.0",
  daemonVersion: "0.6.0",
  os: { macos: "15.1", arch: "arm64" },
  bunVersion: "1.4.2",
  db: { userVersion: 12, schemaVersion: 12 },
  audit: { maxLength: 300, longValues: [] },
  sources: [
    {
      tool: "claude_code",
      root_path: "/Users/alice/.claude",
      enabled: 1,
      health_level: "L0",
      health_reason: null,
      detected_version: "2.1.287",
      hooks_state: "receiving",
    },
    {
      tool: "claude_code",
      root_path: "/Users/alice/.claude-acmecorp",
      enabled: 0,
      health_level: "L1",
      health_reason: "format_changed:3_streams",
      detected_version: null,
      hooks_state: "none",
    },
  ],
  hooks: [
    { file: "/Users/alice/.claude/settings.json", state: "installed" },
    {
      file: "/Users/alice/.claude-acmecorp/settings.json",
      state: "unreadable: Unexpected token in /Users/alice/.claude-acmecorp/settings.json",
    },
  ],
  mcp: [
    { tool: "claude_code", dir: "/Users/alice/.claude", state: "installed" },
    { tool: "claude_code", dir: "/Users/alice/.claude-acmecorp", state: "outdated-path" },
  ],
  versions: [{ tool: "claude_code", version: "2.2.0", tested: ">=2.1 <2.2", ok: false }],
  calendar: {
    connected: true,
    authorization: "fullAccess",
    holidays: "auto",
    holidayCalendars: ["Alice's Holidays"],
  },
  desktop: {
    installed: true,
    signature: "Apple Development",
    launchAgent: { loaded: true, running: true },
    connected: true,
    app: { notifications: "granted", shortcut: { registered: true } },
  },
  aiSummary: { enabled: true, tool: "claude_code", bin: "/Users/alice/.local/bin/claude" },
  onboarding: { state: "done", consented: true },
  update: { enabled: true, configured: false, available: false, latest: null },
};

describe("turnlane doctor --redact（M6-6）", () => {
  test("許可した項目だけを出す: 設定ディレクトリは default / profile-N、カレンダーは件数、エラー文は状態のコードだけ", () => {
    const r = buildRedacted(BASE);
    expect(r.sources.map((s) => s.profile)).toEqual(["default", "profile-1"]);
    expect(r.hooks).toEqual([
      { tool: "claude_code", profile: "default", state: "installed" },
      { tool: "claude_code", profile: "profile-1", state: "unreadable" },
    ]);
    expect(r.mcp).toEqual([
      { tool: "claude_code", profile: "default", state: "installed" },
      { tool: "claude_code", profile: "profile-1", state: "outdated-path" },
    ]);
    expect(redactedLines(r)).toContain("mcp: claude_code profile-1 · outdated-path");
    expect(r.calendar?.holidayCalendars).toBe(1);
    expect(r.aiSummary).toEqual({ enabled: true, tool: "claude_code", cliFound: true });
    const text = [JSON.stringify(r), ...redactedLines(r)].join("\n");
    for (const w of ["alice", "acmecorp", "/Users", "Holidays", ".local"])
      expect(text).not.toContain(w);
    expect(redactedLines(r)[0]).toBe("Turnlane diagnostics (redacted)");
  });

  test("最後の伏せ字: ホームは ~、ユーザー名・ホスト名・リポジトリ名は <redacted>（大文字小文字を問わない）", () => {
    const s = scrub("/Users/alice/x Alice my-repo MacBook-of-alice ab", {
      home: "/Users/alice",
      secrets: ["alice", "my-repo", "MacBook-of-alice", "ab"],
    });
    expect(s).toBe("~/x <redacted> <redacted> <redacted> ab");
  });
});

describe("doctor --redact の更新確認の行（M6-12）", () => {
  test.each([
    { off: null, enabled: true, configured: true, want: "update check: on" },
    {
      off: "setting" as const,
      enabled: false,
      configured: true,
      want: "update check: off (setting)",
    },
    {
      off: "custom_build" as const,
      enabled: true,
      configured: true,
      want: "update check: off (custom build)",
    },
    {
      off: "dev_install" as const,
      enabled: true,
      configured: true,
      want: "update check: off (dev install)",
    },
    {
      off: null,
      enabled: true,
      configured: false,
      want: "update check: off (no feed in this build)",
    },
  ])("$want", (c) => {
    const r = buildRedacted({
      ...BASE,
      update: {
        enabled: c.enabled,
        configured: c.configured,
        off: c.off,
        available: false,
        latest: null,
      },
    });
    expect(redactedLines(r)).toContain(c.want);
  });
});

describe("turnlane doctor --redact をデーモンと DB に対して", () => {
  let home = "";
  let daemon: RunningDaemon | null = null;
  afterEach(async () => {
    await daemon?.stop();
    daemon = null;
    rmSync(home, { recursive: true, force: true });
  });

  test("ホームのパス・設定ディレクトリの名前・リポジトリ名・題名が出力に無い", async () => {
    home = mkdtempSync(join(tmpdir(), "turnlane-redact-"));
    const now = Date.now();
    const repo = join(home, "src", "zebra-secret-repo");
    const git = new FakeGit();
    git.repos.set(repo, repo);
    git.branches.set(repo, "feat/x");
    for (const profile of [".claude", ".claude-acmecorp"]) {
      const w = claudeTranscript(join(home, profile), {
        sid:
          profile === ".claude"
            ? "00000000-0000-4000-8000-000000000001"
            : "00000000-0000-4000-8000-000000000002",
        cwd: repo,
        branch: "feat/x",
      });
      w.human(now - 30 * 60_000);
      w.aiTitle(now - 29 * 60_000, "Quokka migration plan");
      w.assistantEnd(now - 10 * 60_000, "Done.");
      utimesSync(w.path, new Date(now - 10 * 60_000), new Date(now - 10 * 60_000));
    }
    const paths: TurnlanePaths = resolvePaths({ HOME: home }, home);
    daemon = await startDaemon({
      paths,
      logger: nullLogger,
      port: 0,
      clock: new FakeClock(now),
      ingest: { git, noWatch: true },
      calendar: false,
      summary: false,
      onboarding: { assumeDone: true },
    });
    for (let i = 0; i < 200 && !daemon.supervisor?.backfillDone; i++) await Bun.sleep(10);
    daemon.ai?.runner.runOnce();
    const out: string[] = [];
    const env: CliEnv = {
      paths: { ...paths, port: daemon.port },
      launchctl: new FakeLaunchctl(() => "x"),
      out: (s) => out.push(s),
      err: (s) => out.push(`ERR ${s}`),
      execPath: "/usr/local/bin/bun",
      vars: { HOME: home },
    };
    // 伏せない doctor には出る（比較のため）
    expect(await doctorCommand(env, { json: true })).toBe(0);
    expect(out.join("\n")).toContain(home);
    for (const json of [false, true]) {
      out.length = 0;
      expect(await doctorCommand(env, { json, redact: true })).toBe(0);
      const text = out.join("\n");
      for (const w of [
        home,
        home.slice(home.lastIndexOf("/") + 1),
        "acmecorp",
        "zebra-secret-repo",
        "Quokka",
      ])
        expect(text).not.toContain(w);
      expect(text).toContain(json ? '"profile":"profile-1"' : "source: claude_code profile-1");
      expect(text).toContain("onboarding");
    }
  });
});

test("M6-15: 配置の方式と常駐の登録を出し、アプリの場所は出さない", () => {
  const r = buildRedacted({
    ...BASE,
    install: {
      mode: "app",
      cliLinkOk: true,
      background: {
        daemon: "enabled",
        calendarHelper: "notRegistered",
        mainApp: "requiresApproval",
      },
    },
  });
  const text = scrub(redactedLines(r).join("\n"), { home: "/Users/alice", secrets: ["alice"] });
  expect(text).toContain(
    "install: app · hooks path ok · background: daemon enabled, calendar helper notRegistered, open at login requiresApproval",
  );
  expect(text).not.toContain("/Applications");
});
