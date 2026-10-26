/**
 * turnlane mcp install|uninstall|status [--claude-dir <dir>]... [--codex] [--dry-run] [--bin <path>] [--json]（D-145。phase0-plan 3.6.2）
 *
 * - 対象を指定しなければ、hooks と同じく見つかった Claude のプロファイルすべて（~/.claude と ~/.claude-* など）と、
 *   ~/.codex（CODEX_HOME）があれば Codex
 * - ユーザーのスコープに `turnlane`（command は turnlane の絶対パス、args は ["mcp"]）を登録する。claude / codex の
 *   CLI は呼ばず（無い・別名のことがある）、設定ファイルを直接、turnlane の項目だけ冪等に書き換える
 * - 変更があるときだけ、書き換え前に <実パス>.bak-turnlane-<ts> を作る
 * - `.claude.json` の他の内容（サインインの情報・プロジェクトの状態）は表示しない。出すのは turnlane の項目だけ
 */
import {
  applyMcp,
  backupStamp,
  type McpConfigError,
  type McpEntry,
  type McpPlan,
  type McpStatus,
  type McpTarget,
  mcpTargetStatus,
  mcpTargets,
  planMcp,
} from "@turnlane/core/mcp";
import type { CliEnv } from "../env.ts";
import { tr } from "../lang.ts";
import { resolveCliPath } from "./hooks.ts";

export interface McpConfigOptions {
  claudeDirs: string[];
  codex: boolean;
  dryRun: boolean;
  json?: boolean;
  cliPath?: string | undefined;
  now?: number;
}

const USAGE_EN =
  "Usage: turnlane mcp install|uninstall|status [--claude-dir <dir>]... [--codex] [--dry-run] [--bin <path>] [--json]";
const USAGE_JA =
  "使い方: turnlane mcp install|uninstall|status [--claude-dir <dir>]... [--codex] [--dry-run] [--bin <path>] [--json]";

export function toolName(t: McpTarget): string {
  return t.tool === "codex" ? "Codex" : "Claude Code";
}

function label(t: McpTarget): string {
  return `${toolName(t)} ${t.dir} (${t.file})`;
}

/** 失敗の理由（ファイルの中身は含めない） */
export function mcpErrorText(e: unknown): string {
  const code = (e as McpConfigError | null)?.code;
  switch (code) {
    case "unreadable":
      return tr("can't be read as JSON / TOML", "JSON / TOML として読めません");
    case "not_object":
      return tr(
        "unexpected shape (not an object)",
        "形が想定と違います（オブジェクトではありません）",
      );
    case "changed":
      return tr(
        "the file changed while Turnlane was reading it. Run the command again",
        "読み込みの後にファイルが変わりました。もう一度実行してください",
      );
    case "unsafe_toml":
      return tr(
        "Turnlane can't edit this config.toml safely (turnlane is defined inline, or the result didn't check out)",
        "この config.toml は安全に書き換えられません（turnlane がインラインの表で書かれている、または書き換えた結果を確かめられない）",
      );
    default:
      return (e as Error).message;
  }
}

/** 状態の1行（登録済み / 未登録 / 別の turnlane を指す など） */
export function statusText(st: McpStatus): string {
  if (st.state === "installed") return tr("registered", "登録済み");
  if (st.state === "none")
    return tr("not registered (turnlane mcp install)", "未登録（turnlane mcp install）");
  const cmd = st.entry?.command ?? "?";
  switch (st.reason) {
    case "path":
      return tr(
        `points to another turnlane: ${cmd} (fix with turnlane mcp install)`,
        `別の turnlane を指しています: ${cmd}（turnlane mcp install で直ります）`,
      );
    case "missing":
      return tr(
        `the registered turnlane doesn't exist: ${cmd} (fix with turnlane mcp install)`,
        `登録された turnlane がありません: ${cmd}（turnlane mcp install で直ります）`,
      );
    default:
      return tr(
        "registered in an unexpected form (fix with turnlane mcp install)",
        "想定と違う形で登録されています（turnlane mcp install で直ります）",
      );
  }
}

/** dry-run で見せる、書く turnlane の項目（ファイルの他の部分は出さない） */
function entryLines(p: McpPlan): string[] {
  const e = p.after as McpEntry;
  if (p.target.tool === "codex")
    return [
      "[mcp_servers.turnlane]",
      `command = ${JSON.stringify(e.command)}`,
      `args = ${JSON.stringify(e.args)}`,
    ];
  return [
    `"mcpServers": { "turnlane": ${JSON.stringify({ type: "stdio", command: e.command, args: e.args })} }`,
  ];
}

function actionText(p: McpPlan, dryRun: boolean): string {
  const cmd = p.after?.command ?? "";
  switch (p.action) {
    case "added":
      return dryRun
        ? tr(`would add turnlane → ${cmd} mcp`, `turnlane を追加します → ${cmd} mcp`)
        : tr(`added turnlane → ${cmd} mcp`, `turnlane を追加しました → ${cmd} mcp`);
    case "updated":
      return dryRun
        ? tr(
            `would update turnlane: ${p.before?.command ?? "?"} → ${cmd}`,
            `turnlane を更新します: ${p.before?.command ?? "?"} → ${cmd}`,
          )
        : tr(
            `updated turnlane: ${p.before?.command ?? "?"} → ${cmd}`,
            `turnlane を更新しました: ${p.before?.command ?? "?"} → ${cmd}`,
          );
    case "removed":
      return dryRun
        ? tr("would remove turnlane", "turnlane を外します")
        : tr("removed turnlane", "turnlane を外しました");
    default:
      return tr("no change", "変更なし");
  }
}

export interface ApplyResult {
  failed: number;
  changed: number;
}

/**
 * 対象ごとに install / uninstall を行い、1行ずつ出す（turnlane mcp、turnlane onboarding mcp が使う）。
 * 失敗した対象は飛ばして続ける
 */
export function applyToTargets(
  env: CliEnv,
  targets: McpTarget[],
  action: "install" | "uninstall",
  cli: string,
  o: { dryRun: boolean; now?: number | undefined },
): ApplyResult {
  const pre = o.dryRun ? "[dry-run] " : "";
  const suffix = `.bak-turnlane-${backupStamp(o.now ?? Date.now())}`;
  let failed = 0;
  let changed = 0;
  for (const t of targets) {
    try {
      const p = planMcp(t, action, cli);
      const r = applyMcp(p, { backupSuffix: suffix, dryRun: o.dryRun });
      env.out(`${pre}${label(t)}: ${actionText(p, o.dryRun)}`);
      if (o.dryRun && p.changed && p.after)
        for (const l of entryLines(p)) env.out(`${pre}    ${l}`);
      if (o.dryRun && p.changed && p.exists)
        env.out(
          tr(`${pre}  Backup: ${p.path}${suffix}`, `${pre}  バックアップ: ${p.path}${suffix}`),
        );
      if (r.backup) env.out(tr(`${pre}  Backup: ${r.backup}`, `${pre}  バックアップ: ${r.backup}`));
      if (p.changed) changed++;
    } catch (e) {
      env.err(`${label(t)}: ${mcpErrorText(e)}${tr(" (nothing changed)", "（何もしません）")}`);
      failed++;
    }
  }
  if (action === "install" && changed > 0)
    env.out(
      tr(
        `${pre}Restart running Claude Code / Codex sessions to load it (Claude Code lists it under /mcp)`,
        `${pre}動いている Claude Code / Codex は起動し直すと読み込みます（Claude Code では /mcp に出ます）`,
      ),
    );
  return { failed, changed };
}

export interface McpStatusRow {
  tool: McpTarget["tool"];
  dir: string;
  file: string;
  state: McpStatus["state"] | "unreadable";
  reason?: string;
  command?: string | null;
}

export function statusRows(targets: McpTarget[], cli: string): McpStatusRow[] {
  return targets.map((t) => {
    try {
      const st = mcpTargetStatus(t, cli);
      return {
        tool: t.tool,
        dir: t.dir,
        file: t.file,
        state: st.state,
        ...(st.reason ? { reason: st.reason } : {}),
        ...(st.entry ? { command: st.entry.command } : {}),
      };
    } catch (e) {
      return {
        tool: t.tool,
        dir: t.dir,
        file: t.file,
        state: "unreadable" as const,
        reason: (e as McpConfigError).code ?? "unreadable",
      };
    }
  });
}

export function statusRowText(r: McpStatusRow): string {
  if (r.state === "unreadable") return mcpErrorText({ code: r.reason });
  const st: McpStatus = {
    state: r.state,
    entry: r.command !== undefined ? { command: r.command, args: null } : null,
  };
  if (r.reason) st.reason = r.reason as NonNullable<McpStatus["reason"]>;
  return statusText(st);
}

export function mcpConfigCommand(env: CliEnv, action: string, o: McpConfigOptions): number {
  if (action !== "install" && action !== "uninstall" && action !== "status") {
    env.err(tr(USAGE_EN, USAGE_JA));
    return 2;
  }
  const cli = resolveCliPath(env, o.cliPath);
  const targets = mcpTargets(env.paths.home, env.vars, {
    claudeDirs: o.claudeDirs,
    codex: o.codex,
  });
  if (action === "status") {
    const rows = statusRows(targets, cli);
    if (o.json) {
      env.out(JSON.stringify({ cli, targets: rows }));
      return 0;
    }
    if (rows.length === 0)
      env.out(
        tr(
          "Found neither Claude Code nor Codex (choose with --claude-dir / --codex)",
          "Claude Code も Codex も見つかりません（--claude-dir / --codex で指定できます）",
        ),
      );
    for (const r of rows) env.out(`${toolName(r)} ${r.dir} (${r.file}): ${statusRowText(r)}`);
    return rows.some((r) => r.state === "unreadable") ? 1 : 0;
  }
  if (targets.length === 0) {
    env.err(
      tr(
        "No config folder found (choose one with --claude-dir / --codex)",
        "対象の設定ディレクトリが見つかりません（--claude-dir / --codex で指定できます）",
      ),
    );
    return 1;
  }
  const r = applyToTargets(env, targets, action, cli, { dryRun: o.dryRun, now: o.now });
  return r.failed > 0 ? 1 : 0;
}

/**
 * turnlane self-install: 既に登録してある turnlane が別のパス（古い場所）を指していれば、新しいパスに直す。
 * 登録の無いところには足さない。失敗しても self-install は止めない（案内だけ）
 */
export function refreshMcpPaths(
  env: CliEnv,
  cli: string,
  o: { dryRun: boolean; now?: number | undefined; step: (s: string) => void },
): number {
  let updated = 0;
  const suffix = `.bak-turnlane-${backupStamp(o.now ?? Date.now())}`;
  for (const t of mcpTargets(env.paths.home, env.vars)) {
    try {
      const st = mcpTargetStatus(t, cli);
      if (st.state !== "outdated" || (st.reason !== "path" && st.reason !== "missing")) continue;
      const p = planMcp(t, "install", cli);
      const r = applyMcp(p, { backupSuffix: suffix, dryRun: o.dryRun });
      o.step(`MCP: ${label(t)}: ${actionText(p, o.dryRun)}`);
      if (r.backup) o.step(tr(`  Backup: ${r.backup}`, `  バックアップ: ${r.backup}`));
      updated++;
    } catch (e) {
      o.step(
        tr(
          `MCP: ${label(t)}: couldn't update (${mcpErrorText(e)}). Run turnlane mcp install later`,
          `MCP: ${label(t)}: 更新できませんでした（${mcpErrorText(e)}）。後で turnlane mcp install を実行してください`,
        ),
      );
    }
  }
  return updated;
}
