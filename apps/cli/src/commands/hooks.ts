/**
 * turnlane hooks install|uninstall|status [--claude-dir <dir>]... [--codex] [--dry-run] [--bin <path>]
 * （phase0-plan 3.6・3.6.1、M1-10、S5）
 *
 * - 対象を指定しなければ、検出した Claude の全設定ディレクトリの settings.json と Codex の hooks.json
 * - 識別子（--managed-by turnlane）付きで冪等に追加・削除する。他ツールのエントリには触らない。未知キーは足さない
 * - 変更があるときだけ、書き換え前に <実パス>.bak-turnlane-<ts> を作る
 * - Codex: 新規・更新の後は `/hooks` での承認を案内する。アンインストールで Turnlane より後ろのグループの承認が
 *   外れる場合は、承認状態を書き換えずに再承認を案内する（D-030）
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  ConfigParseError,
  claudeHooksDisabled,
  claudePlan,
  codexHome,
  codexInspect,
  codexPlan,
  detectClaudeDirs,
  groupsAfterTurnlane,
  install,
  loadJson,
  type Plan,
  saveJson,
  status,
  uninstall,
} from "@turnlane/core/hooks";
import type { CliEnv } from "../env.ts";
import { tr } from "../lang.ts";

export interface HooksOptions {
  claudeDirs: string[];
  codex: boolean;
  dryRun: boolean;
  cliPath?: string | undefined;
  /** 管理設定のパス（テスト用） */
  managedSettings?: string;
  now?: number;
}

interface Target {
  tool: "claude_code" | "codex";
  file: string;
  plan: Plan;
}

/** hooks に書く turnlane のパス。ビルド済みの turnlane から実行していればそれ、開発中（bun 実行）は ~/.local/bin/turnlane */
export function resolveCliPath(env: CliEnv, explicit?: string): string {
  if (explicit) return explicit;
  if (basename(env.execPath) === "turnlane") return env.execPath;
  return join(env.paths.binDir, "turnlane");
}

function targets(env: CliEnv, o: HooksOptions, cli: string): Target[] {
  const home = env.paths.home;
  const explicit = o.claudeDirs.length > 0 || o.codex;
  const claudeDirs = explicit ? o.claudeDirs : detectClaudeDirs(home, env.vars);
  const out: Target[] = claudeDirs.map((d) => ({
    tool: "claude_code" as const,
    file: join(d, "settings.json"),
    plan: claudePlan(cli),
  }));
  const ch = codexHome(home, env.vars);
  if (o.codex || (!explicit && existsSync(ch))) {
    out.push({ tool: "codex", file: join(ch, "hooks.json"), plan: codexPlan(cli) });
  }
  return out;
}

function stamp(now: number): string {
  return new Date(now)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

function codexToml(file: string): string {
  const p = join(file, "..", "config.toml");
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

export function hooksCommand(env: CliEnv, action: string | undefined, o: HooksOptions): number {
  if (action !== "install" && action !== "uninstall" && action !== "status") {
    env.err(
      tr(
        "Usage: turnlane hooks install|uninstall|status [--claude-dir <dir>]... [--codex] [--dry-run] [--bin <path>]",
        "使い方: turnlane hooks install|uninstall|status [--claude-dir <dir>]... [--codex] [--dry-run] [--bin <path>]",
      ),
    );
    return 2;
  }
  const cli = resolveCliPath(env, o.cliPath);
  const ts = targets(env, o, cli);
  if (ts.length === 0) {
    env.err(
      tr(
        "No config folder found (choose one with --claude-dir / --codex)",
        "対象の設定ディレクトリが見つかりません（--claude-dir / --codex で指定できます）",
      ),
    );
    return 1;
  }
  const pre = o.dryRun ? "[dry-run] " : "";
  const suffix = `.bak-turnlane-${stamp(o.now ?? Date.now())}`;
  let failed = 0;
  let codexChanged = false;
  for (const t of ts) {
    let f: ReturnType<typeof loadJson>;
    try {
      f = loadJson(t.file);
    } catch (e) {
      env.err(
        `${t.file}: ${e instanceof ConfigParseError ? e.message : (e as Error).message}${tr(" (nothing changed)", "（何もしません）")}`,
      );
      failed++;
      continue;
    }
    const label = `${t.tool === "codex" ? "Codex" : "Claude Code"} ${t.file}`;
    if (action === "status") {
      const st = status(f.value, t.plan);
      env.out(
        `${label}: ${st.state}${st.missing.length && st.state !== "none" ? tr(` (missing: ${st.missing.join(", ")})`, `（未登録: ${st.missing.join(", ")}）`) : ""}${st.outdated.length ? tr(` (outdated: ${st.outdated.join(", ")})`, `（古い: ${st.outdated.join(", ")}）`) : ""}`,
      );
      warnings(env, t, f.value, f.path, o);
      continue;
    }
    try {
      if (action === "install") {
        const { next, report } = install(f.value, t.plan);
        const r = saveJson(f, next, { backupSuffix: suffix, dryRun: o.dryRun });
        const parts = [
          report.added.length
            ? tr(`added ${report.added.join(", ")}`, `追加 ${report.added.join(", ")}`)
            : "",
          report.updated.length
            ? tr(`updated ${report.updated.join(", ")}`, `更新 ${report.updated.join(", ")}`)
            : "",
          report.removed.length
            ? tr(`removed ${report.removed.join(", ")}`, `削除 ${report.removed.join(", ")}`)
            : "",
        ].filter(Boolean);
        env.out(
          `${pre}${label}: ${r.changed ? parts.join(" / ") || tr("formatting normalized", "書式を正規化") : tr("no change", "変更なし")}`,
        );
        if (r.changed && !f.canonical)
          env.out(
            tr(
              `${pre}  Note: the file's original formatting (spacing and so on) is normalized`,
              `${pre}  注意: 元のファイルの書式（空白など）は正規化されます`,
            ),
          );
        if (r.backup)
          env.out(tr(`${pre}  Backup: ${r.backup}`, `${pre}  バックアップ: ${r.backup}`));
        if (t.tool === "codex" && (report.added.length > 0 || report.updated.length > 0))
          codexChanged = true;
        warnings(env, t, next, f.path, o);
      } else {
        const after = groupsAfterTurnlane(f.value);
        const { next, removed } = uninstall(f.value);
        const r = saveJson(f, next, { backupSuffix: suffix, dryRun: o.dryRun });
        env.out(
          `${pre}${label}: ${r.changed ? tr(`removed ${removed.join(", ")}`, `削除 ${removed.join(", ")}`) : tr("no change", "変更なし")}`,
        );
        if (r.backup)
          env.out(tr(`${pre}  Backup: ${r.backup}`, `${pre}  バックアップ: ${r.backup}`));
        // D-030: 承認状態は書き換えず、位置がずれる他ツールの hook の再承認を案内する
        if (t.tool === "codex" && r.changed && Object.keys(after).length > 0) {
          env.out(
            tr(
              `${pre}  Approve these hooks again with /hooks in Codex (removing Turnlane shifts their positions, which clears the approval):`,
              `${pre}  Codex の /hooks で次の hook を承認し直してください（Turnlane を外すと位置がずれ、承認が外れます）:`,
            ),
          );
          for (const [ev, names] of Object.entries(after))
            env.out(`${pre}    ${ev}: ${names.join(", ")}`);
        }
      }
    } catch (e) {
      env.err(`${t.file}: ${(e as Error).message}`);
      failed++;
    }
  }
  if (action === "install" && codexChanged) {
    env.out(
      tr(
        `${pre}Codex: next time you start Codex, approve the Turnlane hooks with /hooks (they don't run until you do)`,
        `${pre}Codex: 次に Codex を起動したら /hooks で Turnlane の hook を承認してください（承認するまで動きません）`,
      ),
    );
  }
  if (action === "install" && !o.dryRun && existsSync(cli)) {
    // 新しいバイナリの初回実行のコード検査（約1秒）を済ませておく（phase0-plan 3.6）
    Bun.spawnSync([cli, "--version"], { stdout: "ignore", stderr: "ignore" });
  }
  return failed > 0 ? 1 : 0;
}

function warnings(env: CliEnv, t: Target, value: unknown, realPath: string, o: HooksOptions): void {
  if (t.tool === "claude_code") {
    const d = claudeHooksDisabled(value as Record<string, unknown>, o.managedSettings);
    if (d.disabled)
      env.out(
        tr(
          `  Note: hooks are turned off (${d.reasons.join(", ")})`,
          `  注意: hooks が無効になっています（${d.reasons.join("、")}）`,
        ),
      );
    return;
  }
  const r = codexInspect(codexToml(t.file), realPath, value);
  if (r.featureDisabled)
    env.out(
      tr(
        "  Note: hooks are turned off in [features] of config.toml (hooks = false)",
        "  注意: config.toml の [features] で hooks が無効です（hooks = false）",
      ),
    );
  const untrusted = Object.entries(r.trustEntries)
    .filter(([, ok]) => !ok)
    .map(([ev]) => ev);
  if (untrusted.length > 0)
    env.out(
      tr(
        `  Awaiting approval (approve with /hooks): ${untrusted.join(", ")}`,
        `  承認待ち（/hooks で承認）: ${untrusted.join(", ")}`,
      ),
    );
}
