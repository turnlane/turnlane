/**
 * ツールごとの差（イベント、ハンドラのオプション、無効化の検出、信頼承認）。
 * M1-10 の apps/cli/src/hooks-install/{claude,codex}.ts に相当。
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { hookCommand, type Plan } from "./hooks-config.ts";

// ---------- Claude Code ----------

/** dayline が受け取るイベント。PreToolUse / PostToolUse は高頻度なので入れない（ai-session-ingestion 2.4） */
export const CLAUDE_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PermissionRequest",
  "Notification",
  "Stop",
  "StopFailure",
  "SessionEnd",
] as const;

export function claudePlan(dlPath: string): Plan {
  return {
    events: CLAUDE_EVENTS,
    // async: Claude の処理をブロックしない。timeout は秒
    handler: () => ({ type: "command", command: hookCommand(dlPath, "claude_code"), timeout: 5, async: true }),
  };
}

/** `~/.claude` と `~/.claude-*` のうち設定ディレクトリらしいもの（projects/ か settings.json がある） */
export function detectClaudeDirs(home: string, env: Record<string, string | undefined>): string[] {
  const dirs = new Set<string>();
  if (env.CLAUDE_CONFIG_DIR) dirs.add(env.CLAUDE_CONFIG_DIR);
  for (const name of readdirSync(home)) {
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

export const CLAUDE_MANAGED_SETTINGS = "/Library/Application Support/ClaudeCode/managed-settings.json";

export interface DisabledCheck {
  disabled: boolean;
  reasons: string[];
}

/**
 * hooks が止められていないかの点検（読み取りのみ）。
 * - ユーザー設定の `disableAllHooks: true`
 * - 管理設定（managed-settings.json）の `disableAllHooks` / `allowManagedHooksOnly`
 * プロジェクト単位の `.claude/settings*.json` の `disableAllHooks` は全プロジェクトを走査できないので見ない。
 * 代わりに「インストール済みなのにトランスクリプトには活動があり hook が来ない」無音検知で拾う（ux-mvp 4.9）。
 */
export function claudeHooksDisabled(settings: Record<string, unknown>, managedPath = CLAUDE_MANAGED_SETTINGS): DisabledCheck {
  const reasons: string[] = [];
  if (settings.disableAllHooks === true) reasons.push("settings.json: disableAllHooks");
  if (existsSync(managedPath)) {
    try {
      const m = JSON.parse(readFileSync(managedPath, "utf8"));
      if (m.disableAllHooks === true) reasons.push("managed-settings: disableAllHooks");
      if (m.allowManagedHooksOnly === true) reasons.push("managed-settings: allowManagedHooksOnly");
    } catch {
      reasons.push("managed-settings: 読めない");
    }
  }
  return { disabled: reasons.length > 0, reasons };
}

// ---------- Codex ----------

/** Codex には Notification / StopFailure が無い。Interrupt は 0.147 で追加された */
export const CODEX_EVENTS = ["SessionStart", "UserPromptSubmit", "PermissionRequest", "Stop", "SessionEnd"] as const;

export function codexPlan(dlPath: string): Plan {
  return {
    events: CODEX_EVENTS,
    // async は付けない（Codex 0.147 は async: true のハンドラを「未対応」として読み飛ばす。S5 実験 2）。
    // SessionEnd / Interrupt の timeout は Codex 側で最大 3 秒に丸められるので全イベント 2 秒に揃える
    handler: () => ({ type: "command", command: hookCommand(dlPath, "codex"), timeout: 2 }),
  };
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
 * - dayline のハンドラの位置に対応する `[hooks.state."<path>:<event>:<g>:<h>"]` があるか
 *   （hash の一致までは見ない。承認済みかどうかの最終判定は spool に届いたかで行う）
 */
export function codexInspect(
  configToml: string,
  hooksJsonRealPath: string,
  // biome-ignore lint/suspicious/noExplicitAny: JSON
  hooksJson: any,
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
    if (table === "features" && /^(hooks|codex_hooks)\s*=\s*false\b/.test(t)) featureDisabled = true;
  }
  const trustEntries: Record<string, boolean> = {};
  for (const [event, groups] of Object.entries(hooksJson?.hooks ?? {})) {
    if (!Array.isArray(groups)) continue;
    groups.forEach((g, gi) => {
      (g?.hooks ?? []).forEach((h: { command?: string }, hi: number) => {
        if (!h?.command?.includes("--managed-by dayline")) return;
        const key = `${hooksJsonRealPath}:${SNAKE[event] ?? event.toLowerCase()}:${gi}:${hi}`;
        trustEntries[event] = stateKeys.has(key);
      });
    });
  }
  return { featureDisabled, trustEntries };
}
