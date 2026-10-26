/**
 * Claude の利用枠の読み取り（statusLine の受け口）の純粋な部品: rate_limits の取り出し、利用者の statusLine の探し方、
 * 起動に渡す --settings
 */
import { describe, expect, test } from "bun:test";
import {
  claudeConfigDir,
  findUserStatusLine,
  launchArgv,
  parseRateLimits,
  statusLineSettingsJson,
} from "../src/index.ts";

describe("parseRateLimits", () => {
  test("5時間・7日の使用率とリセットの時刻（秒 → ms）だけを取り出す", () => {
    const input = {
      session_id: "x",
      model: { display_name: "Opus" },
      cost: { total_cost_usd: 1.2 },
      rate_limits: {
        five_hour: { used_percentage: 23.5, resets_at: 1738425600 },
        seven_day: { used_percentage: 41.2, resets_at: 1738857600 },
        spend_limit: { used_percentage: 10, resets_at: 1740787200 },
      },
    };
    expect(parseRateLimits(input)).toEqual({
      fiveHour: { usedPercentage: 23.5, resetsAt: 1738425600_000 },
      sevenDay: { usedPercentage: 41.2, resetsAt: 1738857600_000 },
    });
  });

  test("片方だけ・形の違うもの・無いもの", () => {
    expect(
      parseRateLimits({
        rate_limits: { five_hour: { used_percentage: 5, resets_at: 1700000000 } },
      }),
    ).toEqual({ fiveHour: { usedPercentage: 5, resetsAt: 1700000000_000 } });
    expect(
      parseRateLimits({ rate_limits: { five_hour: { used_percentage: "5", resets_at: 1 } } }),
    ).toBeNull();
    expect(parseRateLimits({ rate_limits: {} })).toBeNull();
    expect(parseRateLimits({})).toBeNull();
    expect(parseRateLimits(null)).toBeNull();
    expect(parseRateLimits("text")).toBeNull();
  });

  test("ms で来ても読める", () => {
    expect(
      parseRateLimits({
        rate_limits: { seven_day: { used_percentage: 1, resets_at: 1738857600123 } },
      }),
    ).toEqual({ sevenDay: { usedPercentage: 1, resetsAt: 1738857600123 } });
  });
});

describe("claudeConfigDir", () => {
  test("CLAUDE_CONFIG_DIR、無ければ ~/.claude。末尾の / は落とす", () => {
    expect(claudeConfigDir({ HOME: "/u", CLAUDE_CONFIG_DIR: "/u/.claude-acme/" })).toBe(
      "/u/.claude-acme",
    );
    expect(claudeConfigDir({ HOME: "/u" })).toBe("/u/.claude");
    expect(claudeConfigDir({ HOME: "/u", CLAUDE_CONFIG_DIR: "" })).toBe("/u/.claude");
  });
});

describe("findUserStatusLine", () => {
  const files = (m: Record<string, unknown>) => (p: string) => {
    if (!(p in m)) throw new Error("ENOENT");
    const v = m[p];
    return typeof v === "string" ? v : JSON.stringify(v);
  };

  test("プロジェクトのローカル → プロジェクト → 利用者の順に最初のもの", () => {
    const user = { statusLine: { type: "command", command: "user-line", padding: 1 } };
    const proj = { statusLine: { type: "command", command: "proj-line" } };
    const local = { statusLine: { type: "command", command: "local-line", refreshInterval: 5 } };
    const all = {
      "/u/.claude/settings.json": user,
      "/p/.claude/settings.json": proj,
      "/p/.claude/settings.local.json": local,
    };
    expect(
      findUserStatusLine({ configDir: "/u/.claude", projectDir: "/p", readFile: files(all) }),
    ).toEqual({ command: "local-line", refreshInterval: 5 });
    const { "/p/.claude/settings.local.json": _, ...noLocal } = all;
    expect(
      findUserStatusLine({ configDir: "/u/.claude", projectDir: "/p", readFile: files(noLocal) }),
    ).toEqual({ command: "proj-line" });
    expect(
      findUserStatusLine({ configDir: "/u/.claude", projectDir: null, readFile: files(all) }),
    ).toEqual({ command: "user-line", padding: 1 });
  });

  test("無い・読めない・command でないものは飛ばす", () => {
    const m = {
      "/p/.claude/settings.local.json": "{ not json",
      "/p/.claude/settings.json": { statusLine: { type: "static", command: "x" } },
      "/u/.claude/settings.json": { statusLine: { type: "command", command: "  " } },
    };
    expect(
      findUserStatusLine({ configDir: "/u/.claude", projectDir: "/p", readFile: files(m) }),
    ).toBeNull();
    expect(
      findUserStatusLine({ configDir: "/u/.claude", projectDir: "/p", readFile: files({}) }),
    ).toBeNull();
  });
});

describe("statusLineSettingsJson と launchArgv", () => {
  test("受け口のコマンドだけ。利用者の見た目の設定は引き継ぐ。空白を含むパスはシェルの1語に", () => {
    expect(JSON.parse(statusLineSettingsJson("/u/.local/bin/turnlane", null))).toEqual({
      statusLine: { type: "command", command: "/u/.local/bin/turnlane statusline" },
    });
    expect(
      JSON.parse(
        statusLineSettingsJson("/Users/a b/turnlane", {
          command: "x",
          padding: 2,
          refreshInterval: 10,
          hideVimModeIndicator: true,
        }),
      ),
    ).toEqual({
      statusLine: {
        type: "command",
        command: "'/Users/a b/turnlane' statusline",
        padding: 2,
        refreshInterval: 10,
        hideVimModeIndicator: true,
      },
    });
  });

  test("Claude Code にだけ --settings を付ける（プロンプトの前）", () => {
    const base = { prompt: "hi", sessionUuid: null, name: "t", readOnly: true, cwd: "/w" };
    expect(launchArgv({ ...base, tool: "claude_code", settings: "{}" })).toEqual([
      "claude",
      "-n",
      "t",
      "--permission-mode",
      "plan",
      "--settings",
      "{}",
      "hi",
    ]);
    expect(launchArgv({ ...base, tool: "claude_code" })).not.toContain("--settings");
    expect(launchArgv({ ...base, tool: "codex", settings: "{}" })).toEqual([
      "codex",
      "-C",
      "/w",
      "-s",
      "read-only",
      "hi",
    ]);
  });
});
