/**
 * 壁打ち（D-135）: プロジェクトに属さない AI との会話。AI のレーン・日報・自分の番・詳細パネルではリポジトリの代わりに
 * 「壁打ち」と出し、プロジェクトの一覧には出さない。
 * - Codex のプロジェクト外の会話: 作業フォルダが `~/Documents/Codex/` の下（取り込みで日付までに切り落とす。
 *   collectors の trimCodexScratchCwd）
 * - 設定（ai.scratch_dirs）で壁打ちの印を付けたフォルダとその下（Claude の Code タブを専用のフォルダで使う運用など）
 * 判定は cwd の前方一致だけ（git は見ない。印のフォルダが git の中でも壁打ちとして扱う）。
 */
import { CODEX_SCRATCH_DIR } from "@turnlane/collectors";

const strip = (p: string) => p.replace(/\/+$/, "");

/** dir とその下か（dir は絶対パス。末尾の / は無視） */
function under(cwd: string, dir: string): boolean {
  const d = strip(dir);
  return d.length > 0 && (cwd === d || cwd.startsWith(`${d}/`));
}

export interface ScratchRule {
  home: string;
  /** 壁打ちの印を付けたフォルダ（絶対パス） */
  dirs: readonly string[];
}

/** cwd が壁打ちのフォルダか */
export function isScratchCwd(cwd: string | null | undefined, rule: ScratchRule): boolean {
  if (!cwd) return false;
  const c = strip(cwd);
  const home = strip(rule.home);
  if (home && under(c, `${home}/${CODEX_SCRATCH_DIR}`)) return true;
  return rule.dirs.some((d) => d.startsWith("/") && under(c, d));
}

/** 設定の値（ai.scratch_dirs）を読む。壊れた値は空 */
export function readScratchDirs(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return [
    ...new Set(v.filter((x): x is string => typeof x === "string" && x.startsWith("/")).map(strip)),
  ].filter((x) => x.length > 0);
}
