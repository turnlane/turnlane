/**
 * turnlane skill install|uninstall|status [--claude-dir <dir>]... [--claude-md <file>] [--agents-md <file>] [--dry-run]
 * turnlane skill snippet
 * （図つきの問い。ADR 0022）
 *
 * - スキル: Claude の設定ディレクトリ（指定が無ければ検出したすべて）の `skills/turnlane-ask/SKILL.md`。中に Turnlane の印
 *   （`<!-- managed-by: turnlane -->`）があるものだけを書き換え・削除する。同じ名前の別のスキルには触らない
 * - CLAUDE.md / AGENTS.md: 指定したファイルにだけ、始まりと終わりの印で囲んだ 1 節を足す・外す。他の文は変えない。
 *   変えるときは先に `<ファイル>.bak-turnlane-<時刻>` を作る（hooks と同じ）
 * - snippet: 貼る 1 節を表示する（ファイルには書かない）
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  ASK_SKILL_MARK,
  ASK_SKILL_MD,
  ASK_SKILL_NAME,
  ASK_SNIPPET,
  addAskBlock,
  hasAskBlock,
  removeAskBlock,
} from "@turnlane/core";
import { detectClaudeDirs } from "@turnlane/core/hooks";
import type { CliEnv } from "../env.ts";
import { tr } from "../lang.ts";

export interface SkillOptions {
  claudeDirs: string[];
  claudeMd: string[];
  agentsMd: string[];
  dryRun: boolean;
  now?: number;
}

function stamp(now: number): string {
  return new Date(now)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

/** スキルの状態: installed（今の文）/ outdated（Turnlane のものだが古い）/ foreign（同じ名前の別のスキル）/ none */
export function skillState(dir: string): "installed" | "outdated" | "foreign" | "none" {
  const f = join(dir, "skills", ASK_SKILL_NAME, "SKILL.md");
  if (!existsSync(f)) return existsSync(dirname(f)) ? "foreign" : "none";
  let text = "";
  try {
    text = readFileSync(f, "utf8");
  } catch {
    return "foreign";
  }
  if (!text.includes(ASK_SKILL_MARK)) return "foreign";
  return text === ASK_SKILL_MD ? "installed" : "outdated";
}

/** Markdown のファイルに節を足す・外す（変わったときだけ書く。書く前にバックアップ） */
function editMd(
  env: CliEnv,
  file: string,
  action: "install" | "uninstall" | "status",
  o: SkillOptions,
  suffix: string,
): boolean {
  const pre = o.dryRun ? "[dry-run] " : "";
  let text = "";
  const exists = existsSync(file);
  if (exists) {
    try {
      text = readFileSync(file, "utf8");
    } catch (e) {
      env.err(`${file}: ${(e as Error).message}`);
      return false;
    }
  }
  if (action === "status") {
    env.out(`${file}: ${hasAskBlock(text) ? "installed" : "none"}`);
    return true;
  }
  const next = action === "install" ? addAskBlock(text) : removeAskBlock(text);
  if (next === text) {
    env.out(`${pre}${file}: ${tr("no change", "変更なし")}`);
    return true;
  }
  if (!exists && action === "uninstall") return true;
  env.out(
    `${pre}${file}: ${action === "install" ? tr("added the ask_user section", "ask_user の節を追加") : tr("removed the ask_user section", "ask_user の節を削除")}`,
  );
  if (o.dryRun) return true;
  try {
    if (exists) {
      copyFileSync(file, `${file}${suffix}`);
      env.out(tr(`  Backup: ${file}${suffix}`, `  バックアップ: ${file}${suffix}`));
    } else mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, next);
    return true;
  } catch (e) {
    env.err(`${file}: ${(e as Error).message}`);
    return false;
  }
}

export function skillCommand(env: CliEnv, action: string | undefined, o: SkillOptions): number {
  if (action === "snippet") {
    env.out(ASK_SNIPPET.trimEnd());
    return 0;
  }
  if (action !== "install" && action !== "uninstall" && action !== "status") {
    env.err(
      tr(
        "Usage: turnlane skill install|uninstall|status [--claude-dir <dir>]... [--claude-md <file>] [--agents-md <file>] [--dry-run] | snippet",
        "使い方: turnlane skill install|uninstall|status [--claude-dir <dir>]... [--claude-md <file>] [--agents-md <file>] [--dry-run] | snippet",
      ),
    );
    return 2;
  }
  const pre = o.dryRun ? "[dry-run] " : "";
  const suffix = `.bak-turnlane-${stamp(o.now ?? Date.now())}`;
  const dirs = o.claudeDirs.length > 0 ? o.claudeDirs : detectClaudeDirs(env.paths.home, env.vars);
  let failed = 0;
  if (dirs.length === 0 && o.claudeMd.length === 0 && o.agentsMd.length === 0) {
    env.err(
      tr(
        "No Claude config folder found (choose one with --claude-dir)",
        "Claude の設定ディレクトリが見つかりません（--claude-dir で指定できます）",
      ),
    );
    return 1;
  }
  for (const d of dirs) {
    const folder = join(d, "skills", ASK_SKILL_NAME);
    const file = join(folder, "SKILL.md");
    const st = skillState(d);
    const label = `Claude Code ${file}`;
    if (action === "status") {
      env.out(`${label}: ${st}`);
      continue;
    }
    if (st === "foreign") {
      env.out(
        tr(
          `${pre}${label}: another skill with this name is there; left alone`,
          `${pre}${label}: 同じ名前の別のスキルがあるので触りません`,
        ),
      );
      continue;
    }
    try {
      if (action === "install") {
        if (st === "installed") {
          env.out(`${pre}${label}: ${tr("no change", "変更なし")}`);
          continue;
        }
        env.out(
          `${pre}${label}: ${st === "outdated" ? tr("updated", "更新") : tr("added", "追加")}`,
        );
        if (!o.dryRun) {
          mkdirSync(folder, { recursive: true });
          writeFileSync(file, ASK_SKILL_MD);
        }
      } else {
        if (st === "none") {
          env.out(`${pre}${label}: ${tr("no change", "変更なし")}`);
          continue;
        }
        env.out(`${pre}${label}: ${tr("removed", "削除")}`);
        if (!o.dryRun) {
          rmSync(file, { force: true });
          // フォルダは空なら消す（利用者が足したファイルは残す）
          if (readdirSync(folder).length === 0) rmSync(folder, { recursive: true, force: true });
        }
      }
    } catch (e) {
      env.err(`${file}: ${(e as Error).message}`);
      failed++;
    }
  }
  for (const f of [...o.claudeMd, ...o.agentsMd]) if (!editMd(env, f, action, o, suffix)) failed++;
  if (action === "install")
    env.out(
      tr(
        `${pre}Codex: put the section in AGENTS.md (--agents-md <file>) and raise tool_timeout_sec for turnlane in ~/.codex/config.toml (see the README)`,
        `${pre}Codex: AGENTS.md に節を入れ（--agents-md <ファイル>）、~/.codex/config.toml の turnlane の tool_timeout_sec を延ばしてください（README を参照）`,
      ),
    );
  return failed > 0 ? 1 : 0;
}

/** uninstall --all から呼ぶ: 検出した Claude の設定ディレクトリのスキルを外す（Turnlane の印のあるものだけ） */
export function uninstallSkills(env: CliEnv, dryRun: boolean): number {
  let failed = 0;
  const pre = dryRun ? "[dry-run] " : "";
  for (const d of detectClaudeDirs(env.paths.home, env.vars)) {
    const st = skillState(d);
    if (st !== "installed" && st !== "outdated") continue;
    const folder = join(d, "skills", ASK_SKILL_NAME);
    env.out(`${pre}skill: ${join(folder, "SKILL.md")}: ${tr("removed", "削除")}`);
    if (dryRun) continue;
    try {
      rmSync(join(folder, "SKILL.md"), { force: true });
      if (readdirSync(folder).length === 0) rmSync(folder, { recursive: true, force: true });
    } catch (e) {
      env.err(`${folder}: ${(e as Error).message}`);
      failed++;
    }
  }
  return failed;
}
