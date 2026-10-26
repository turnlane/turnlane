/**
 * S5 実験 1: Claude Code の settings.json に未知キー等を足したとき、hooks が動くか / 警告が出るか /
 * Claude Code が settings.json を書き換えるか。
 *
 * - 一時 CLAUDE_CONFIG_DIR だけを使う。実ユーザーの設定ディレクトリには触れない
 * - 認証は通さない（ANTHROPIC_API_KEY にダミーを入れ、API 呼び出しは 401 で失敗させる）
 * - hook は受け取った JSON から hook_event_name だけを記録する（本文は記録しない）
 *
 * 実行: bun experiments/claude-unknown-keys.ts
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EVENTS = ["SessionStart", "UserPromptSubmit", "Stop", "StopFailure", "SessionEnd"];

// biome-ignore lint/suspicious/noExplicitAny: 実験用
type Settings = Record<string, any>;
type Variant = { name: string; mutate: (s: Settings, log: string) => void };

function hookCmd(log: string, tag: string): string {
  return `jq -c '{e: .hook_event_name, tag: "${tag}"}' >> '${log}'`;
}

function baseSettings(log: string): Settings {
  const hooks: Settings = {};
  for (const e of EVENTS) {
    hooks[e] = [{ hooks: [{ type: "command", command: hookCmd(log, "base"), timeout: 5 }] }];
  }
  return { hooks };
}

function addGroup(s: Settings, group: Settings): void {
  for (const e of EVENTS) s.hooks[e].push(structuredClone(group));
}

const variants: Variant[] = [
  { name: "A_baseline", mutate: () => {} },
  {
    name: "B_toplevel_unknown_key",
    mutate: (s) => {
      s["x-dayline"] = { managed: true, version: 1 };
    },
  },
  {
    name: "C_handler_unknown_key",
    mutate: (s, log) =>
      addGroup(s, {
        hooks: [{ type: "command", command: hookCmd(log, "c"), timeout: 5, managedBy: "dayline" }],
      }),
  },
  {
    name: "D_group_unknown_key",
    mutate: (s, log) =>
      addGroup(s, {
        managedBy: "dayline",
        hooks: [{ type: "command", command: hookCmd(log, "d"), timeout: 5 }],
      }),
  },
  {
    name: "E_disableAllHooks",
    mutate: (s) => {
      s.disableAllHooks = true;
    },
  },
  {
    name: "F_async_marker_in_command",
    mutate: (s, log) =>
      addGroup(s, {
        hooks: [
          {
            type: "command",
            command: `${hookCmd(log, "f")} # --managed-by dayline`,
            timeout: 5,
            async: true,
          },
        ],
      }),
  },
  {
    name: "G_unknown_event_name",
    mutate: (s, log) => {
      s.hooks.NoSuchEvent = [{ hooks: [{ type: "command", command: hookCmd(log, "g") }] }];
    },
  },
  {
    name: "H_statusMessage",
    mutate: (s, log) =>
      addGroup(s, {
        hooks: [
          { type: "command", command: hookCmd(log, "h"), timeout: 5, statusMessage: "dayline" },
        ],
      }),
  },
];

const root = mkdtempSync(join(tmpdir(), "s5-claude-"));
const results: Settings[] = [];
try {
  for (const v of variants) {
    const cfg = join(root, v.name);
    const cwd = join(root, `${v.name}-cwd`);
    mkdirSync(cfg, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    const log = join(root, `${v.name}.log`);
    const s = baseSettings(log);
    v.mutate(s, log);
    const settingsPath = join(cfg, "settings.json");
    writeFileSync(settingsPath, `${JSON.stringify(s, null, 2)}\n`);
    const before = readFileSync(settingsPath, "utf8");
    const p = Bun.spawnSync(["claude", "-p", "say ok", "--max-turns", "1"], {
      cwd,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        CLAUDE_CONFIG_DIR: cfg,
        ANTHROPIC_API_KEY: "sk-ant-dummy-s5-spike",
      },
      timeout: 90_000,
    });
    const after = readFileSync(settingsPath, "utf8");
    const fired = existsSync(log)
      ? readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : [];
    const out = `${p.stdout.toString()}\n${p.stderr.toString()}`.replaceAll(root, "<tmp>");
    results.push({
      variant: v.name,
      exitCode: p.exitCode,
      fired,
      settingsRewritten: before !== after,
      outputHead: out.trim().slice(0, 240),
    });
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
const version = Bun.spawnSync(["claude", "--version"]).stdout.toString().trim();
const outPath = join(import.meta.dir, "..", "results", "claude-unknown-keys.json");
writeFileSync(outPath, `${JSON.stringify({ claudeVersion: version, results }, null, 2)}\n`);
console.log(JSON.stringify(results, null, 2));
