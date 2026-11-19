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
  askBlockState,
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

  test("節が 2 つあっても 1 つにまとめる。外すときは全部外す", () => {
    const twice = `a\n\n${ASK_SNIPPET}\nb\n\n${ASK_BLOCK_START}\nold\n${ASK_BLOCK_END}\n`;
    expect(askBlockState(twice)).toBe("outdated");
    const fixed = addAskBlock(twice);
    expect(fixed).toBe(`a\n\n${ASK_SNIPPET}\nb\n`);
    expect(askBlockState(fixed)).toBe("installed");
    expect(removeAskBlock(twice)).toBe("a\n\nb\n");
  });

  test("節の状態: 無い / 今の文 / 古い文", () => {
    expect(askBlockState("# Rules\n")).toBe("none");
    expect(askBlockState(addAskBlock("# Rules\n"))).toBe("installed");
    expect(askBlockState(`x\n${ASK_BLOCK_START}\nold\n${ASK_BLOCK_END}`)).toBe("outdated");
  });

  test("いつ使うか: 決める・確かめる問いで図が要るときは必ず。組み込みの問いと文の問いの代わり。文だけのことは今までどおり", () => {
    const desc = /^description: (.+)$/m.exec(ASK_SKILL_MD)?.[1] ?? "";
    for (const t of [desc, ASK_SNIPPET, ASK_SKILL_MD]) {
      expect(t).toContain("ALWAYS");
      expect(t).toContain("decide or confirm");
      expect(t).toContain("a figure can explain");
      expect(t).toContain("not only text");
      expect(t).toContain("AskUserQuestion");
      expect(t).toContain("ending your turn with a question in text");
      for (const ex of [
        "screen layout",
        "architecture",
        "flow or sequence",
        "before and after",
        "numbers side by side",
      ])
        expect(t).toContain(ex);
    }
    for (const t of [ASK_SNIPPET, ASK_SKILL_MD]) {
      expect(t).toContain("2–4 options");
      expect(t).toContain("yes or no, a name, a path");
    }
    // description は YAML の 1 行（": " を含むと値が壊れる）で、短く
    expect(desc.includes(": ")).toBe(false);
    expect(desc.length).toBeLessThan(450);
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

  test("古い版の節: status は outdated、install はその場で置き換える（重ならない・前後の文は変えない）", () => {
    const e = env();
    const md = join(home, "CLAUDE.md");
    const old = `# Rules\n\n${ASK_BLOCK_START}\n## Asking the user to decide\n\nWhen you need the user's decision between concrete alternatives, call ask_user.\n${ASK_BLOCK_END}\n\n## More\n`;
    writeFileSync(md, old);
    const o = opts({ claudeDirs: [join(home, ".claude")], claudeMd: [md] });
    skillCommand(e, "status", o);
    expect(
      out.some((l) => l.startsWith(`${md}: outdated`) && l.includes(`--claude-md ${md}`)),
    ).toBe(true);
    out = [];
    expect(skillCommand(e, "install", o)).toBe(0);
    expect(out).toContain(`${md}: updated the ask_user section`);
    const text = readFileSync(md, "utf8");
    expect(text).toBe(`# Rules\n\n${ASK_SNIPPET}\n## More\n`);
    expect(text.split(ASK_BLOCK_START)).toHaveLength(2);
    out = [];
    skillCommand(e, "status", o);
    expect(out).toContain(`${md}: installed`);
    out = [];
    skillCommand(e, "install", o);
    expect(out).toContain(`${md}: no change`);
  });

  test("古い版のスキル: status は outdated と更新の仕方を言う", () => {
    const e = env();
    const dir = join(home, ".claude", "skills", "turnlane-ask");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), ASK_SKILL_MD.replace("ALWAYS use when", "Use when"));
    skillCommand(e, "status", opts({ claudeDirs: [join(home, ".claude")] }));
    expect(out[0]).toContain("outdated (update with turnlane skill install)");
    out = [];
    skillCommand(e, "install", opts({ claudeDirs: [join(home, ".claude")] }));
    expect(out[0]).toEndWith(": updated");
    expect(readFileSync(join(dir, "SKILL.md"), "utf8")).toBe(ASK_SKILL_MD);
  });

  test("install: CLAUDE.md を指定しないと、節を入れるよう案内する（指定すれば出さない）", () => {
    const e = env();
    skillCommand(e, "install", opts({ claudeDirs: [join(home, ".claude")] }));
    expect(out.some((l) => l.includes("turnlane skill install --claude-md <file>"))).toBe(true);
    expect(out.some((l) => l.includes("the skill alone is often not picked up"))).toBe(true);
    out = [];
    skillCommand(
      e,
      "install",
      opts({ claudeDirs: [join(home, ".claude")], claudeMd: [join(home, "CLAUDE.md")] }),
    );
    expect(out.some((l) => l.includes("--claude-md <file>"))).toBe(false);
  });

  test("snippet は節を表示するだけ。知らない操作は使い方（2）", () => {
    const e = env();
    expect(skillCommand(e, "snippet", opts())).toBe(0);
    expect(out[0]).toBe(ASK_SNIPPET.trimEnd());
    expect(skillCommand(e, "nope", opts())).toBe(2);
  });
});
