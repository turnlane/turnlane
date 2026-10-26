// turnlane mcp install|uninstall|status（D-145）。一時 HOME の中の Claude のプロファイルと Codex だけを使う
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePaths, type TurnlanePaths } from "@turnlane/core";
import { mcpConfigCommand, refreshMcpPaths } from "../src/commands/mcp-config.ts";
import type { CliEnv } from "../src/env.ts";
import { setLang } from "../src/lang.ts";
import { FakeLaunchctl } from "../src/launchctl.ts";
import { runCommand } from "../src/run.ts";

let home: string;
let paths: TurnlanePaths;
let out: string[];
let errs: string[];

const CLAUDE_JSON = {
  numStartups: 3,
  oauthAccount: { emailAddress: "someone@example.com" },
  projects: { "/w/app": { allowedTools: [] } },
  mcpServers: { other: { type: "stdio", command: "/opt/other", args: [], env: {} } },
};
const CODEX_TOML = `model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "/opt/other"\n`;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "turnlane-mcp-cli-")));
  paths = resolvePaths({ HOME: home }, home);
  out = [];
  errs = [];
  for (const d of [".claude/projects", ".claude-acme/projects", ".codex/sessions"])
    mkdirSync(join(home, d), { recursive: true });
  writeFileSync(join(home, ".claude.json"), `${JSON.stringify(CLAUDE_JSON, null, 2)}\n`, {
    mode: 0o600,
  });
  writeFileSync(join(home, ".codex", "config.toml"), CODEX_TOML);
  setLang("en");
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function env(): CliEnv {
  return {
    paths,
    launchctl: new FakeLaunchctl(() => "x"),
    out: (s) => out.push(s),
    err: (s) => errs.push(s),
    execPath: "/usr/local/bin/bun",
    // CLAUDE_CONFIG_DIR / CODEX_HOME を渡さない（実行環境の設定ディレクトリに触れない）
    vars: { HOME: home },
  };
}

const NOW = Date.UTC(2026, 9, 9, 1, 2, 3);
const opts = { claudeDirs: [] as string[], codex: false, dryRun: false, now: NOW };
const CLI = () => join(home, ".local/bin/turnlane");
const json = (p: string) => JSON.parse(readFileSync(p, "utf8"));

describe("turnlane mcp install / uninstall / status", () => {
  test("見つけた Claude のプロファイルすべてと Codex に登録する。他のキーはそのまま、冪等、uninstall で元に戻る", () => {
    const before = {
      def: readFileSync(join(home, ".claude.json"), "utf8"),
      codex: CODEX_TOML,
    };
    expect(mcpConfigCommand(env(), "install", opts)).toBe(0);
    expect(errs).toEqual([]);
    const def = json(join(home, ".claude.json"));
    expect(def.mcpServers.turnlane).toEqual({
      type: "stdio",
      command: CLI(),
      args: ["mcp"],
      env: {},
    });
    expect(def.oauthAccount).toEqual(CLAUDE_JSON.oauthAccount);
    expect(def.mcpServers.other).toEqual(CLAUDE_JSON.mcpServers.other);
    // CLAUDE_CONFIG_DIR のプロファイルはその中の .claude.json（無ければ作る）
    expect(json(join(home, ".claude-acme", ".claude.json")).mcpServers.turnlane.command).toBe(
      CLI(),
    );
    expect(readFileSync(join(home, ".codex", "config.toml"), "utf8")).toBe(
      `${CODEX_TOML}\n[mcp_servers.turnlane]\ncommand = "${CLI()}"\nargs = ["mcp"]\n`,
    );
    // 退避は既存のファイルだけ
    const stamp = "20261009T010203Z";
    expect(existsSync(join(home, `.claude.json.bak-turnlane-${stamp}`))).toBe(true);
    expect(existsSync(join(home, ".codex", `config.toml.bak-turnlane-${stamp}`))).toBe(true);
    expect(readdirSync(join(home, ".claude-acme")).some((n) => n.includes(".bak-"))).toBe(false);
    // 出力に .claude.json の他の内容を出さない
    expect(out.join("\n")).not.toContain("someone@example.com");

    // 冪等
    out = [];
    expect(mcpConfigCommand(env(), "install", { ...opts, now: NOW + 1000 })).toBe(0);
    expect(out.filter((l) => l.includes(": no change"))).toHaveLength(3);
    expect(readdirSync(home).filter((n) => n.includes(".bak-turnlane-"))).toHaveLength(1);

    // status
    out = [];
    expect(mcpConfigCommand(env(), "status", { ...opts, json: true })).toBe(0);
    const st = JSON.parse(out[0] as string);
    expect(st.cli).toBe(CLI());
    expect(st.targets.map((t: { state: string }) => t.state)).toEqual([
      "installed",
      "installed",
      "installed",
    ]);

    // uninstall: 元のバイト列に戻る
    out = [];
    expect(mcpConfigCommand(env(), "uninstall", { ...opts, now: NOW + 2000 })).toBe(0);
    expect(readFileSync(join(home, ".claude.json"), "utf8")).toBe(before.def);
    expect(readFileSync(join(home, ".codex", "config.toml"), "utf8")).toBe(before.codex);
    expect(json(join(home, ".claude-acme", ".claude.json"))).toEqual({ mcpServers: {} });
  });

  test("--dry-run は書かず、書く項目と退避の名前を出す（.claude.json の他の内容は出さない）", () => {
    const raw = readFileSync(join(home, ".claude.json"), "utf8");
    expect(mcpConfigCommand(env(), "install", { ...opts, dryRun: true })).toBe(0);
    expect(readFileSync(join(home, ".claude.json"), "utf8")).toBe(raw);
    expect(readFileSync(join(home, ".codex", "config.toml"), "utf8")).toBe(CODEX_TOML);
    expect(existsSync(join(home, ".claude-acme", ".claude.json"))).toBe(false);
    expect(readdirSync(home).some((n) => n.includes(".bak-"))).toBe(false);
    const text = out.join("\n");
    expect(text).toBe(
      [
        `[dry-run] Claude Code ${home}/.claude (${home}/.claude.json): would add turnlane → ${CLI()} mcp`,
        `[dry-run]     "mcpServers": { "turnlane": {"type":"stdio","command":"${CLI()}","args":["mcp"]} }`,
        `[dry-run]   Backup: ${home}/.claude.json.bak-turnlane-20261009T010203Z`,
        `[dry-run] Claude Code ${home}/.claude-acme (${home}/.claude-acme/.claude.json): would add turnlane → ${CLI()} mcp`,
        `[dry-run]     "mcpServers": { "turnlane": {"type":"stdio","command":"${CLI()}","args":["mcp"]} }`,
        `[dry-run] Codex ${home}/.codex (${home}/.codex/config.toml): would add turnlane → ${CLI()} mcp`,
        "[dry-run]     [mcp_servers.turnlane]",
        `[dry-run]     command = "${CLI()}"`,
        '[dry-run]     args = ["mcp"]',
        `[dry-run]   Backup: ${home}/.codex/config.toml.bak-turnlane-20261009T010203Z`,
        "[dry-run] Restart running Claude Code / Codex sessions to load it (Claude Code lists it under /mcp)",
      ].join("\n"),
    );
    expect(text).not.toContain("someone@example.com");
  });

  test("--claude-dir / --codex で対象を絞る。--bin で登録するパスを決める", () => {
    expect(
      mcpConfigCommand(env(), "install", {
        ...opts,
        claudeDirs: [join(home, ".claude-acme")],
        cliPath: "/opt/t/turnlane",
      }),
    ).toBe(0);
    expect(json(join(home, ".claude-acme", ".claude.json")).mcpServers.turnlane.command).toBe(
      "/opt/t/turnlane",
    );
    expect(json(join(home, ".claude.json")).mcpServers.turnlane).toBeUndefined();
    expect(readFileSync(join(home, ".codex", "config.toml"), "utf8")).toBe(CODEX_TOML);
  });

  test("status: 未登録・別のパス・読めない を1行ずつ出す", () => {
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({ mcpServers: { turnlane: { command: "/old/turnlane", args: ["mcp"] } } }),
    );
    writeFileSync(join(home, ".codex", "config.toml"), 'a = "unterminated\n');
    expect(mcpConfigCommand(env(), "status", opts)).toBe(1);
    expect(out).toEqual([
      `Claude Code ${home}/.claude (${home}/.claude.json): points to another turnlane: /old/turnlane (fix with turnlane mcp install)`,
      `Claude Code ${home}/.claude-acme (${home}/.claude-acme/.claude.json): not registered (turnlane mcp install)`,
      `Codex ${home}/.codex (${home}/.codex/config.toml): can't be read as JSON / TOML`,
    ]);
  });

  test("読めないファイルはそのまま残し、他の対象は続ける（終了コード 1）", () => {
    writeFileSync(join(home, ".claude.json"), '{"oauthAccount": {"emailAddress": "x@example.com"');
    expect(mcpConfigCommand(env(), "install", opts)).toBe(1);
    expect(errs.join("\n")).toContain("can't be read as JSON / TOML (nothing changed)");
    expect(errs.join("\n")).not.toContain("x@example.com");
    expect(json(join(home, ".claude-acme", ".claude.json")).mcpServers.turnlane.command).toBe(
      CLI(),
    );
  });

  test("日本語", () => {
    setLang("ja");
    mcpConfigCommand(env(), "status", { ...opts, codex: true });
    expect(out[0]).toContain("未登録（turnlane mcp install）");
    setLang("en");
  });

  test("引数なしの turnlane mcp はサーバ（ここでは起動しない）、未知の動作は使い方", async () => {
    expect(await runCommand("mcp", ["frobnicate"], env())).toBe(2);
    expect(errs[0]).toContain("Usage: turnlane mcp install|uninstall|status");
    expect(await runCommand("mcp", ["install", "--bogus"], env())).toBe(2);
    errs = [];
    expect(await runCommand("mcp", ["status", "--codex", "--json"], env())).toBe(0);
    expect(JSON.parse(out.at(-1) as string).targets[0].tool).toBe("codex");
  });

  test("help に install|uninstall|status が載る", async () => {
    expect(await runCommand("help", ["mcp"], env())).toBe(0);
    expect(out.join("\n")).toContain("turnlane mcp install|uninstall|status");
  });
});

describe("self-install の MCP のパスの更新", () => {
  test("別のパスを指す登録だけを直し、登録の無いところには足さない", () => {
    writeFileSync(
      join(home, ".claude.json"),
      `${JSON.stringify({ ...CLAUDE_JSON, mcpServers: { turnlane: { type: "stdio", command: "/old/turnlane", args: ["mcp"], env: {} } } }, null, 2)}\n`,
    );
    const steps: string[] = [];
    const n = refreshMcpPaths(env(), CLI(), {
      dryRun: false,
      now: NOW,
      step: (s) => steps.push(s),
    });
    expect(n).toBe(1);
    expect(json(join(home, ".claude.json")).mcpServers.turnlane.command).toBe(CLI());
    expect(existsSync(join(home, ".claude-acme", ".claude.json"))).toBe(false);
    expect(readFileSync(join(home, ".codex", "config.toml"), "utf8")).toBe(CODEX_TOML);
    expect(steps[0]).toBe(
      `MCP: Claude Code ${home}/.claude (${home}/.claude.json): updated turnlane: /old/turnlane → ${CLI()}`,
    );
    // 2回目は何もしない
    expect(refreshMcpPaths(env(), CLI(), { dryRun: false, now: NOW, step: () => {} })).toBe(0);
  });

  test("dry-run は書かない", () => {
    writeFileSync(
      join(home, ".codex", "config.toml"),
      `${CODEX_TOML}\n[mcp_servers.turnlane]\ncommand = "/old/turnlane"\nargs = ["mcp"]\n`,
    );
    const before = readFileSync(join(home, ".codex", "config.toml"), "utf8");
    const steps: string[] = [];
    expect(
      refreshMcpPaths(env(), CLI(), { dryRun: true, now: NOW, step: (s) => steps.push(s) }),
    ).toBe(1);
    expect(readFileSync(join(home, ".codex", "config.toml"), "utf8")).toBe(before);
    expect(steps[0]).toContain("would update turnlane: /old/turnlane →");
  });
});
