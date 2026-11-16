/**
 * turnlane skill install|uninstall|status|snippet（図つきの問い。ADR 0022）: Turnlane の印のあるスキルだけを足す・外す、
 * 指定した CLAUDE.md / AGENTS.md にだけ印で囲んだ 1 節を足す・外す（バックアップを取り、他の文は変えない）。一時 HOME だけ
 */
import { afterEach, describe, expect, test } from "bun:test";
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
import {
  ASK_BLOCK_END,
  ASK_BLOCK_START,
  ASK_SKILL_MD,
  ASK_SNIPPET,
  addAskBlock,
  removeAskBlock,
  resolvePaths,
} from "@turnlane/core";
import { skillCommand, skillState } from "../src/commands/skill.ts";
import type { CliEnv } from "../src/env.ts";
import { FakeLaunchctl } from "../src/launchctl.ts";

let home: string;
let out: string[] = [];

afterEach(() => {
  if (home) rmSync(home, { recursive: true, force: true });
});

function env(): CliEnv {
  home = mkdtempSync(join(tmpdir(), "turnlane-skill-"));
  out = [];
  return {
    paths: resolvePaths({ HOME: home }, home),
    launchctl: new FakeLaunchctl(() => "x"),
    out: (s) => out.push(s),
    err: (s) => out.push(`ERR ${s}`),
    execPath: "/usr/local/bin/bun",
    vars: { HOME: home },
  };
}

const opts = (p: Partial<Parameters<typeof skillCommand>[2]> = {}) => ({
  claudeDirs: [],
  claudeMd: [],
  agentsMd: [],
  dryRun: false,
  now: Date.UTC(2026, 10, 16, 1, 0),
  ...p,
});

describe("CLAUDE.md / AGENTS.md の節", () => {
  test("足す・外すで元の文に戻る。2 回足しても 1 つ", () => {
    const text = "# Project\n\nRules.\n";
    const added = addAskBlock(text);
    expect(added).toBe(`${text}\n${ASK_SNIPPET}`);
    expect(addAskBlock(added)).toBe(added);
    expect(removeAskBlock(added)).toBe(text);
    expect(removeAskBlock(text)).toBe(text);
    expect(removeAskBlock(addAskBlock(""))).toBe("");
  });

  test("古い節は今の文に置き換える（前後の文は変えない）", () => {
    const old = `a\n\n${ASK_BLOCK_START}\nold text\n${ASK_BLOCK_END}\nb\n`;
    expect(addAskBlock(old)).toBe(`a\n\n${ASK_SNIPPET}b\n`);
  });

  test("節は ask_user・図・端末への戻り方を言う", () => {
    expect(ASK_SNIPPET).toContain("`ask_user`");
    expect(ASK_SNIPPET).toContain("static HTML/SVG");
    expect(ASK_SNIPPET).toContain("ask in the terminal");
    expect(ASK_SKILL_MD).toContain("allowed-tools: mcp__turnlane__ask_user");
    expect(ASK_SKILL_MD).toContain("--tl-text");
  });
});

describe("turnlane skill", () => {
  test("install → status → uninstall（検出した Claude の設定ディレクトリ）", () => {
    const e = env();
    mkdirSync(join(home, ".claude"));
    writeFileSync(join(home, ".claude", "settings.json"), "{}");
    expect(skillCommand(e, "install", opts())).toBe(0);
    const f = join(home, ".claude", "skills", "turnlane-ask", "SKILL.md");
    expect(readFileSync(f, "utf8")).toBe(ASK_SKILL_MD);
    expect(skillState(join(home, ".claude"))).toBe("installed");
    out = [];
    expect(skillCommand(e, "install", opts())).toBe(0);
    expect(out.some((l) => l.endsWith("no change"))).toBe(true);
    expect(skillCommand(e, "uninstall", opts())).toBe(0);
    expect(existsSync(join(home, ".claude", "skills", "turnlane-ask"))).toBe(false);
  });

  test("同じ名前の別のスキル（印が無い）には触らない", () => {
    const e = env();
    const dir = join(home, ".claude", "skills", "turnlane-ask");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "my own skill\n");
    writeFileSync(join(home, ".claude", "settings.json"), "{}");
    expect(skillCommand(e, "install", opts())).toBe(0);
    expect(readFileSync(join(dir, "SKILL.md"), "utf8")).toBe("my own skill\n");
    expect(skillCommand(e, "uninstall", opts())).toBe(0);
    expect(readFileSync(join(dir, "SKILL.md"), "utf8")).toBe("my own skill\n");
    expect(skillState(join(home, ".claude"))).toBe("foreign");
  });

  test("古い Turnlane のスキルは更新する。利用者が足したファイルは外すときに残す", () => {
    const e = env();
    const dir = join(home, ".claude", "skills", "turnlane-ask");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "<!-- managed-by: turnlane -->\nold\n");
    writeFileSync(join(home, ".claude", "settings.json"), "{}");
    expect(skillState(join(home, ".claude"))).toBe("outdated");
    skillCommand(e, "install", opts());
    expect(readFileSync(join(dir, "SKILL.md"), "utf8")).toBe(ASK_SKILL_MD);
    writeFileSync(join(dir, "notes.md"), "mine");
    skillCommand(e, "uninstall", opts());
    expect(readdirSync(dir)).toEqual(["notes.md"]);
  });

  test("--claude-md / --agents-md: 指定したファイルにだけ節。書き換える前にバックアップ。--dry-run は書かない", () => {
    const e = env();
    const md = join(home, "proj", "CLAUDE.md");
    const agents = join(home, "proj", "AGENTS.md");
    mkdirSync(join(home, "proj"));
    writeFileSync(md, "# Rules\n");
    expect(
      skillCommand(
        e,
        "install",
        opts({
          claudeDirs: [join(home, ".claude")],
          claudeMd: [md],
          agentsMd: [agents],
          dryRun: true,
        }),
      ),
    ).toBe(0);
    expect(readFileSync(md, "utf8")).toBe("# Rules\n");
    expect(existsSync(agents)).toBe(false);
    skillCommand(
      e,
      "install",
      opts({ claudeDirs: [join(home, ".claude")], claudeMd: [md], agentsMd: [agents] }),
    );
    expect(readFileSync(md, "utf8")).toBe(`# Rules\n\n${ASK_SNIPPET}`);
    expect(readFileSync(agents, "utf8")).toBe(ASK_SNIPPET);
    expect(
      readdirSync(join(home, "proj")).filter((n) => n.startsWith("CLAUDE.md.bak-turnlane-")),
    ).toHaveLength(1);
    skillCommand(
      e,
      "uninstall",
      opts({ claudeDirs: [join(home, ".claude")], claudeMd: [md], agentsMd: [agents] }),
    );
    expect(readFileSync(md, "utf8")).toBe("# Rules\n");
    expect(readFileSync(agents, "utf8")).toBe("");
  });

  test("snippet は節を表示するだけ。知らない操作は使い方（2）", () => {
    const e = env();
    expect(skillCommand(e, "snippet", opts())).toBe(0);
    expect(out[0]).toBe(ASK_SNIPPET.trimEnd());
    expect(skillCommand(e, "nope", opts())).toBe(2);
  });
});
