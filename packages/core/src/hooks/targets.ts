/**
 * ツールごとの差（イベント、ハンドラのオプション、無効化の検出、信頼承認）。phase0-plan 3.6.1、S5。
 * イベントの一覧は @turnlane/collectors/hook-allowlist の定数を正とする（ADR 0009）。
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { HOOK_ALLOWLIST } from "@turnlane/collectors/hook-allowlist";
import { hookCommand, isTurnlaneHandler, type Plan } from "./config.ts";

export const CLAUDE_EVENTS = HOOK_ALLOWLIST.claude_code.events;
export const CODEX_EVENTS = HOOK_ALLOWLIST.codex.events;

export function claudePlan(cliPath: string): Plan {
  return {
    events: CLAUDE_EVENTS,
    // async: Claude の処理をブロックしない。timeout は秒
    handler: () => ({
      type: "command",
      command: hookCommand(cliPath, "claude_code"),
      timeout: 5,
      async: true,
    }),
  };
}

export function codexPlan(cliPath: string): Plan {
  return {
    events: CODEX_EVENTS,
    // async は付けない（Codex 0.147 は async: true のハンドラを未対応として読み飛ばす）。timeout は全イベント 2 秒
    handler: () => ({ type: "command", command: hookCommand(cliPath, "codex"), timeout: 2 }),
  };
}

/** `~/.claude` と `~/.claude-*` のうち設定ディレクトリらしいもの（projects/ か settings.json がある）と CLAUDE_CONFIG_DIR */
export function detectClaudeDirs(home: string, env: Record<string, string | undefined>): string[] {
  const dirs = new Set<string>();
  if (env.CLAUDE_CONFIG_DIR) dirs.add(env.CLAUDE_CONFIG_DIR.replace(/\/+$/, ""));
  let names: string[] = [];
  try {
    names = readdirSync(home);
  } catch {}
  for (const name of names) {
    if (name !== ".claude" && !name.startsWith(".claude-")) continue;
    const p = join(home, name);
    try {
      if (!statSync(p).isDirectory()) continue;
    } catch {
      continue;
    }
    if (existsSync(join(p, "projects")) || existsSync(join(p, "settings.json"))) dirs.add(p);
  }
  return [...dirs].sort();
}

export function codexHome(home: string, env: Record<string, string | undefined>): string {
  return (env.CODEX_HOME || join(home, ".codex")).replace(/\/+$/, "");
}

export const CLAUDE_MANAGED_SETTINGS =
  "/Library/Application Support/ClaudeCode/managed-settings.json";

export interface DisabledCheck {
  disabled: boolean;
  reasons: string[];
}

/**
 * hooks が止められていないかの点検（読み取りのみ）。
 * プロジェクト単位の `.claude/settings*.json` の `disableAllHooks` は全プロジェクトを走査できないので見ない（無音検知で拾う）。
 */
export function claudeHooksDisabled(
  settings: Record<string, unknown>,
  managedPath = CLAUDE_MANAGED_SETTINGS,
): DisabledCheck {
  const reasons: string[] = [];
  if (settings.disableAllHooks === true) reasons.push("settings.json: disableAllHooks");
  if (existsSync(managedPath)) {
    try {
      const m = JSON.parse(readFileSync(managedPath, "utf8")) as Record<string, unknown>;
      if (m.disableAllHooks === true) reasons.push("managed-settings: disableAllHooks");
      if (m.allowManagedHooksOnly === true) reasons.push("managed-settings: allowManagedHooksOnly");
    } catch {
      reasons.push("managed-settings: unreadable");
    }
  }
  return { disabled: reasons.length > 0, reasons };
}

const SNAKE: Record<string, string> = {
  SessionStart: "session_start",
  UserPromptSubmit: "user_prompt_submit",
  PermissionRequest: "permission_request",
  Stop: "stop",
  SessionEnd: "session_end",
};

/**
 * config.toml を読み取りだけで点検する（TOML パーサは持たず、行単位で見る）。
 * - `[features]` の `hooks = false`（旧名 `codex_hooks`）
 * - Turnlane のハンドラの位置に対応する `[hooks.state."<path>:<event>:<g>:<h>"]` があるか（hash の一致までは見ない。
 *   承認済みかどうかの最終判定は spool に届いたかで行う）
 */
export function codexInspect(
  configToml: string,
  hooksJsonRealPath: string,
  hooksJson: unknown,
): { featureDisabled: boolean; trustEntries: Record<string, boolean> } {
  let table = "";
  let featureDisabled = false;
  const stateKeys = new Set<string>();
  for (const line of configToml.split("\n")) {
    const t = line.trim();
    const header = t.match(/^\[(.+)\]$/);
    if (header?.[1]) {
      table = header[1];
      const st = table.match(/^hooks\.state\."(.+)"$/);
      if (st?.[1]) stateKeys.add(st[1].replaceAll('\\"', '"').replaceAll("\\\\", "\\"));
      continue;
    }
    if (table === "features" && /^(hooks|codex_hooks)\s*=\s*false\b/.test(t))
      featureDisabled = true;
  }
  const trustEntries: Record<string, boolean> = {};
  const hooks = (hooksJson as { hooks?: Record<string, unknown> } | null)?.hooks ?? {};
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    groups.forEach((g, gi) => {
      const hs = (g as { hooks?: unknown[] } | null)?.hooks ?? [];
      hs.forEach((h, hi) => {
        if (!isTurnlaneHandler(h)) return;
        const key = `${hooksJsonRealPath}:${SNAKE[event] ?? event.toLowerCase()}:${gi}:${hi}`;
        trustEntries[event] = stateKeys.has(key);
      });
    });
  }
  return { featureDisabled, trustEntries };
}
