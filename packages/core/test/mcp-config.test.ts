// Claude Code / Codex への MCP の登録（D-145）。一時 HOME だけを使う
import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyMcp,
  claudeUserConfigFile,
  codexInstallText,
  codexUninstallText,
  McpConfigError,
  mcpStatusOf,
  mcpTargetStatus,
  mcpTargets,
  planMcp,
} from "../src/mcp/index.ts";

const CLI = "/Users/someone/.local/bin/turnlane";
const OLD = "/Users/someone/old/turnlane";

function first<T>(xs: T[]): T {
  const x = xs[0];
  if (x === undefined) throw new Error("empty");
  return x;
}

function home(): string {
  return mkdtempSync(join(tmpdir(), "turnlane-mcp-test-"));
}

/** Claude Code の書く形（2 スペース、末尾改行）。サインインの情報やプロジェクトの状態を模したもの */
const CLAUDE_JSON = {
  numStartups: 12,
  oauthAccount: {
    accountUuid: "00000000-0000-0000-0000-000000000000",
    emailAddress: "x@example.com",
  },
  projects: {
    "/w/app": { allowedTools: [], mcpServers: { local1: { type: "stdio", command: "a" } } },
  },
  mcpServers: { other: { type: "stdio", command: "/opt/other", args: ["serve"], env: { K: "v" } } },
  theme: "dark",
};
const claudeText = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

const CODEX_TOML = `# Codex config
model = "gpt-5"
approval_policy = "on-request"

[features]
hooks = true

[mcp_servers.other]
command = "/opt/other"
args = ["serve", "--port", "1"]

[mcp_servers.other.env]
TOKEN_NAME = "x"

[projects."/w/app"]
trust_level = "trusted"
`;

describe("場所", () => {
  test("既定の ~/.claude は ~/.claude.json、他のプロファイルはその中の .claude.json", () => {
    const h = home();
    expect(claudeUserConfigFile(join(h, ".claude"), h)).toBe(join(h, ".claude.json"));
    expect(claudeUserConfigFile(join(h, ".claude-acme"), h)).toBe(
      join(h, ".claude-acme", ".claude.json"),
    );
  });

  test("古い名前 .config.json があればそちらを読む（Claude Code と同じ）", () => {
    const h = home();
    mkdirSync(join(h, ".claude-acme"));
    writeFileSync(join(h, ".claude-acme", ".config.json"), "{}\n");
    expect(claudeUserConfigFile(join(h, ".claude-acme"), h)).toBe(
      join(h, ".claude-acme", ".config.json"),
    );
  });

  test("見つけ方は hooks と同じ（~/.claude と ~/.claude-*、~/.codex があれば Codex）", () => {
    const h = home();
    for (const d of [".claude", ".claude-acme", ".claude-empty"]) mkdirSync(join(h, d));
    mkdirSync(join(h, ".claude", "projects"));
    writeFileSync(join(h, ".claude-acme", "settings.json"), "{}");
    mkdirSync(join(h, ".codex"));
    const ts = mcpTargets(h, {});
    expect(ts.map((t) => [t.tool, t.file])).toEqual([
      ["claude_code", join(h, ".claude.json")],
      ["claude_code", join(h, ".claude-acme", ".claude.json")],
      ["codex", join(h, ".codex", "config.toml")],
    ]);
    // 指定したらそれだけ
    expect(mcpTargets(h, {}, { codex: true }).map((t) => t.tool)).toEqual(["codex"]);
  });
});

describe("Claude（.claude.json）", () => {
  const setup = (v: unknown = CLAUDE_JSON) => {
    const h = home();
    mkdirSync(join(h, ".claude-acme"));
    const file = join(h, ".claude-acme", ".claude.json");
    writeFileSync(file, claudeText(v), { mode: 0o600 });
    return { h, file, target: first(mcpTargets(h, {}, { claudeDirs: [join(h, ".claude-acme")] })) };
  };

  test("turnlane だけを足し、他のキー・順序・書式はそのまま。install → uninstall で元に戻る", () => {
    const { file, target } = setup();
    const before = readFileSync(file, "utf8");
    const p = planMcp(target, "install", CLI);
    expect(p.action).toBe("added");
    applyMcp(p, { backupSuffix: ".bak-turnlane-1" });
    const v = JSON.parse(readFileSync(file, "utf8"));
    expect(Object.keys(v)).toEqual(Object.keys(CLAUDE_JSON));
    expect(v.mcpServers.turnlane).toEqual({
      type: "stdio",
      command: CLI,
      args: ["mcp"],
      env: {},
    });
    expect(v.mcpServers.other).toEqual(CLAUDE_JSON.mcpServers.other);
    expect(v.oauthAccount).toEqual(CLAUDE_JSON.oauthAccount);
    expect(v.projects).toEqual(CLAUDE_JSON.projects);
    applyMcp(planMcp(target, "uninstall", CLI), { backupSuffix: ".bak-turnlane-2" });
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  test("冪等: 2回目は変更なし（退避も作らない）", () => {
    const { h, target } = setup();
    applyMcp(planMcp(target, "install", CLI), { backupSuffix: ".bak-turnlane-1" });
    const p = planMcp(target, "install", CLI);
    expect(p.changed).toBe(false);
    expect(applyMcp(p, { backupSuffix: ".bak-turnlane-2" }).changed).toBe(false);
    expect(readdirSync(join(h, ".claude-acme")).filter((n) => n.includes(".bak-"))).toEqual([
      ".claude.json.bak-turnlane-1",
    ]);
  });

  test("退避は元の内容とパーミッションで作る", () => {
    const { file, target } = setup();
    const before = readFileSync(file, "utf8");
    const r = applyMcp(planMcp(target, "install", CLI), { backupSuffix: ".bak-turnlane-X" });
    expect(r.backup).toBe(`${realpathSync(file)}.bak-turnlane-X`);
    expect(readFileSync(`${file}.bak-turnlane-X`, "utf8")).toBe(before);
    expect(statSync(`${file}.bak-turnlane-X`).mode & 0o777).toBe(0o600);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test("古いパスは直す（env など他の項目は残す）", () => {
    const { file, target } = setup({
      ...CLAUDE_JSON,
      mcpServers: {
        turnlane: { type: "stdio", command: OLD, args: ["mcp"], env: { A: "1" } },
        other: CLAUDE_JSON.mcpServers.other,
      },
    });
    expect(mcpTargetStatus(target, CLI)).toMatchObject({ state: "outdated", reason: "path" });
    const p = planMcp(target, "install", CLI);
    expect(p.action).toBe("updated");
    applyMcp(p, { backupSuffix: ".b" });
    const v = JSON.parse(readFileSync(file, "utf8"));
    expect(Object.keys(v.mcpServers)).toEqual(["turnlane", "other"]);
    expect(v.mcpServers.turnlane).toEqual({
      type: "stdio",
      command: CLI,
      args: ["mcp"],
      env: { A: "1" },
    });
    expect(mcpTargetStatus(target, CLI).state).toBe("installed");
  });

  test("ファイルが無ければ作る（0600）。uninstall では作らない", () => {
    const h = home();
    mkdirSync(join(h, ".claude-new"));
    const t = first(mcpTargets(h, {}, { claudeDirs: [join(h, ".claude-new")] }));
    expect(planMcp(t, "uninstall", CLI).changed).toBe(false);
    applyMcp(planMcp(t, "install", CLI), { backupSuffix: ".b" });
    expect(statSync(t.file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(t.file, "utf8")).mcpServers.turnlane.command).toBe(CLI);
  });

  test("読めない JSON は書かず、エラーにファイルの中身を含めない", () => {
    const h = home();
    mkdirSync(join(h, ".claude-x"));
    const file = join(h, ".claude-x", ".claude.json");
    writeFileSync(file, '{"oauthAccount": {"emailAddress": "secret@example.com"');
    const t = first(mcpTargets(h, {}, { claudeDirs: [join(h, ".claude-x")] }));
    let err: unknown;
    try {
      planMcp(t, "install", CLI);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(McpConfigError);
    expect((err as McpConfigError).code).toBe("unreadable");
    expect(String((err as Error).message)).not.toContain("secret");
  });

  test("dry-run は書かない", () => {
    const { file, target } = setup();
    const before = readFileSync(file, "utf8");
    const r = applyMcp(planMcp(target, "install", CLI), { backupSuffix: ".b", dryRun: true });
    expect(r.changed).toBe(true);
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(existsSync(`${file}.b`)).toBe(false);
  });

  test("読んだ後に書き換えられていたら書かない", () => {
    const { file, target } = setup();
    const p = planMcp(target, "install", CLI);
    writeFileSync(file, claudeText({ ...CLAUDE_JSON, numStartups: 13 }));
    expect(() => applyMcp(p, { backupSuffix: ".b" })).toThrow(McpConfigError);
    expect(JSON.parse(readFileSync(file, "utf8")).mcpServers.turnlane).toBeUndefined();
  });
});

describe("Codex（config.toml）", () => {
  test("末尾に [mcp_servers.turnlane] を足し、他の行はそのまま。install → uninstall で元に戻る", () => {
    const t = codexInstallText(CODEX_TOML, CLI);
    expect(t.startsWith(CODEX_TOML)).toBe(true);
    expect(t.slice(CODEX_TOML.length)).toBe(
      `\n[mcp_servers.turnlane]\ncommand = "${CLI}"\nargs = ["mcp"]\n`,
    );
    const v = Bun.TOML.parse(t) as Record<string, Record<string, unknown>>;
    expect(v.mcp_servers?.turnlane).toEqual({ command: CLI, args: ["mcp"] });
    expect(v.mcp_servers?.other).toEqual({
      command: "/opt/other",
      args: ["serve", "--port", "1"],
      env: { TOKEN_NAME: "x" },
    });
    expect(codexUninstallText(t)).toBe(CODEX_TOML);
  });

  test("冪等", () => {
    const t = codexInstallText(CODEX_TOML, CLI);
    expect(codexInstallText(t, CLI)).toBe(t);
    expect(codexUninstallText(CODEX_TOML)).toBe(CODEX_TOML);
  });

  test("空のファイル・無いファイル", () => {
    expect(codexInstallText("", CLI)).toBe(
      `[mcp_servers.turnlane]\ncommand = "${CLI}"\nargs = ["mcp"]\n`,
    );
    expect(codexUninstallText(codexInstallText("", CLI))).toBe("");
  });

  test("途中にある登録の古いパスはその場で直す（他の項目・下の表・コメントは残す）", () => {
    const raw = `model = "o"

[mcp_servers.turnlane]
# mine
command = "${OLD}"
args = ["mcp"]
startup_timeout_sec = 20

[mcp_servers.turnlane.env]
A = "1"

# next
[profiles.x]
model = "y"
`;
    const t = codexInstallText(raw, CLI);
    expect(t).toBe(raw.replace(OLD, CLI));
    // uninstall は下の表ごと外し、次の表の前のコメントは残す
    expect(codexUninstallText(t)).toBe(`model = "o"

# next
[profiles.x]
model = "y"
`);
  });

  test("複数行の args も直す", () => {
    const raw = `[mcp_servers."turnlane"]\ncommand = "${OLD}"\nargs = [\n  "serve",\n]\n`;
    const t = codexInstallText(raw, CLI);
    expect(Bun.TOML.parse(t)).toEqual({
      mcp_servers: { turnlane: { command: CLI, args: ["mcp"] } },
    });
  });

  test("表の形でない登録（インラインの表）は書き換えない", () => {
    const raw = `[mcp_servers]\nturnlane = { command = "${OLD}", args = ["mcp"] }\n`;
    expect(() => codexInstallText(raw, CLI)).toThrow(McpConfigError);
    expect(() => codexUninstallText(raw)).toThrow(McpConfigError);
  });

  test("mcp_servers がインラインの表なら足せない（壊さない）", () => {
    const raw = `mcp_servers = { other = { command = "x" } }\n`;
    expect(() => codexInstallText(raw, CLI)).toThrow(McpConfigError);
  });

  test("読めない TOML は書かない", () => {
    expect(() => codexInstallText('a = "x\n', CLI)).toThrow(McpConfigError);
  });

  test("パスの空白・引用符は TOML の文字列としてエスケープする", () => {
    const p = '/Users/a b/Library/Application Support/turnlane/bin/"t"';
    const t = codexInstallText("", p);
    expect(
      (Bun.TOML.parse(t) as Record<string, Record<string, Record<string, unknown>>>).mcp_servers
        ?.turnlane?.command,
    ).toBe(p);
  });

  test("ファイルに書く: 退避、冪等、uninstall", () => {
    const h = home();
    mkdirSync(join(h, ".codex"));
    const file = join(h, ".codex", "config.toml");
    writeFileSync(file, CODEX_TOML);
    const target = first(mcpTargets(h, {}, { codex: true }));
    expect(mcpTargetStatus(target, CLI).state).toBe("none");
    const r = applyMcp(planMcp(target, "install", CLI), { backupSuffix: ".bak-turnlane-1" });
    expect(readFileSync(String(r.backup), "utf8")).toBe(CODEX_TOML);
    expect(mcpTargetStatus(target, CLI).state).toBe("installed");
    expect(planMcp(target, "install", CLI).changed).toBe(false);
    applyMcp(planMcp(target, "uninstall", CLI), { backupSuffix: ".bak-turnlane-2" });
    expect(readFileSync(file, "utf8")).toBe(CODEX_TOML);
  });
});

describe("状態", () => {
  test("none / installed / outdated（path・args・missing）", () => {
    expect(mcpStatusOf(null, CLI).state).toBe("none");
    expect(mcpStatusOf({ command: CLI, args: ["mcp"] }, CLI).state).toBe("installed");
    expect(mcpStatusOf({ command: OLD, args: ["mcp"] }, CLI)).toMatchObject({
      state: "outdated",
      reason: "path",
    });
    expect(mcpStatusOf({ command: CLI, args: [] }, CLI)).toMatchObject({ reason: "args" });
    // 期待するパスが分からなければ、command のファイルがあるかで見る
    expect(mcpStatusOf({ command: "/nonexistent/turnlane", args: ["mcp"] }, null)).toMatchObject({
      state: "outdated",
      reason: "missing",
    });
  });
});
