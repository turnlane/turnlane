import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePaths, type TurnlanePaths } from "@turnlane/core";
import { hooksCommand } from "../src/commands/hooks.ts";
import type { CliEnv } from "../src/env.ts";
import { FakeLaunchctl } from "../src/launchctl.ts";

let home: string;
let paths: TurnlanePaths;
let out: string[];
let errs: string[];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "turnlane-hooks-cli-"));
  paths = resolvePaths({ HOME: home }, home);
  out = [];
  errs = [];
  for (const d of [".claude/projects", ".claude-acme/projects", ".codex/sessions"])
    mkdirSync(join(home, d), { recursive: true });
  // 他ツールの hook がすでにある settings.json
  writeFileSync(
    join(home, ".claude", "settings.json"),
    `${JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "notify-me" }] }] } }, null, 2)}\n`,
  );
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

const opts = {
  claudeDirs: [] as string[],
  codex: false,
  dryRun: false,
  managedSettings: "/nonexistent/turnlane-test/managed-settings.json",
  now: Date.UTC(2026, 9, 3),
};
const json = (p: string) => JSON.parse(readFileSync(p, "utf8"));

describe("turnlane hooks（M1-10、phase0-plan 3.6.1）", () => {
  test("検出した Claude の全設定ディレクトリと Codex に入れ、冪等、アンインストールで元に戻る", () => {
    const original = readFileSync(join(home, ".claude", "settings.json"), "utf8");
    expect(hooksCommand(env(), "install", opts)).toBe(0);
    const s = json(join(home, ".claude", "settings.json"));
    // 他ツールのグループは先頭のまま、Turnlane は末尾。turnlane のパスは ~/.local/bin/turnlane（bun で実行中のため）
    expect(s.hooks.Stop[0].hooks[0].command).toBe("notify-me");
    expect(s.hooks.Stop[1].hooks[0].command).toBe(
      `'${join(home, ".local/bin/turnlane")}' hook --tool claude_code --managed-by turnlane`,
    );
    expect(s.hooks.Stop[1].hooks[0]).toMatchObject({ timeout: 5, async: true });
    expect(Object.keys(json(join(home, ".claude-acme", "settings.json")).hooks)).toHaveLength(7);
    const codex = json(join(home, ".codex", "hooks.json"));
    expect(Object.keys(codex)).toEqual(["hooks"]);
    expect(codex.hooks.Stop[0].hooks[0]).toEqual({
      type: "command",
      command: `'${join(home, ".local/bin/turnlane")}' hook --tool codex --managed-by turnlane`,
      timeout: 2,
    });
    // バックアップは既存のファイルだけ（変更があるとき）
    expect(
      readdirSync(join(home, ".claude")).filter((n) => n.includes(".bak-turnlane-")),
    ).toHaveLength(1);
    expect(
      readdirSync(join(home, ".codex")).filter((n) => n.includes(".bak-turnlane-")),
    ).toHaveLength(0);
    expect(out.some((l) => l.includes("approve the Turnlane hooks with /hooks"))).toBe(true);

    out = [];
    expect(hooksCommand(env(), "install", opts)).toBe(0);
    expect(out.filter((l) => l.includes("no change"))).toHaveLength(3);

    out = [];
    expect(hooksCommand(env(), "status", opts)).toBe(0);
    expect(out.filter((l) => l.endsWith(": installed"))).toHaveLength(3);
    expect(out.some((l) => l.includes("Awaiting approval"))).toBe(true);

    expect(hooksCommand(env(), "uninstall", opts)).toBe(0);
    expect(readFileSync(join(home, ".claude", "settings.json"), "utf8")).toBe(original);
    expect(json(join(home, ".codex", "hooks.json"))).toEqual({});
  });

  test("Codex: turnlane の後ろに他ツールが足した hook は、アンインストール時に再承認を案内する（D-030）", () => {
    hooksCommand(env(), "install", { ...opts, codex: true });
    const p = join(home, ".codex", "hooks.json");
    const v = json(p);
    v.hooks.Stop.push({ hooks: [{ type: "command", command: "/opt/other-tool notify" }] });
    writeFileSync(p, `${JSON.stringify(v, null, 2)}\n`);
    out = [];
    expect(hooksCommand(env(), "uninstall", { ...opts, codex: true })).toBe(0);
    expect(out.some((l) => l.includes("Approve these hooks again"))).toBe(true);
    expect(out.some((l) => l.includes("Stop: /opt/other-tool"))).toBe(true);
    // config.toml（承認状態）には触れない
    expect(existsSync(join(home, ".codex", "config.toml"))).toBe(false);
  });

  test("--dry-run は書かない。--claude-dir を指定したらそれだけ", () => {
    const before = readFileSync(join(home, ".claude", "settings.json"), "utf8");
    expect(hooksCommand(env(), "install", { ...opts, dryRun: true })).toBe(0);
    expect(readFileSync(join(home, ".claude", "settings.json"), "utf8")).toBe(before);
    expect(existsSync(join(home, ".codex", "hooks.json"))).toBe(false);
    expect(out.every((l) => l.startsWith("[dry-run]") || l.startsWith("  "))).toBe(true);
    hooksCommand(env(), "install", {
      ...opts,
      claudeDirs: [join(home, ".claude-acme")],
      cliPath: "/x/turnlane",
    });
    expect(existsSync(join(home, ".claude-acme", "settings.json"))).toBe(true);
    expect(readFileSync(join(home, ".claude", "settings.json"), "utf8")).toBe(before);
  });

  test("JSON が壊れた設定ファイルには何もしない", () => {
    writeFileSync(join(home, ".claude-acme", "settings.json"), "{ // comment\n}");
    expect(hooksCommand(env(), "install", opts)).toBe(1);
    expect(readFileSync(join(home, ".claude-acme", "settings.json"), "utf8")).toBe(
      "{ // comment\n}",
    );
    expect(errs.some((e) => e.includes("JSON として読めません"))).toBe(true);
  });
});
