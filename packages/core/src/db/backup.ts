import type { Database } from "bun:sqlite";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { compactDate } from "../dates.ts";

/**
 * 日次バックアップ（phase0-plan 1.4、2.5-6、M0-7）: `VACUUM INTO backups/turnlane-YYYYMMDD.db`、14 世代。
 * 日付は論理日付（日付区切り適用後）。マイグレーション前のバックアップ（pre-migrate-*）は世代管理の対象外。
 */
export const BACKUP_GENERATIONS = 14;
const DAILY_RE = /^turnlane-(\d{4})(\d{2})(\d{2})\.db$/;

export interface BackupInfo {
  date: string;
  path: string;
  sizeBytes: number;
  mtimeMs: number;
}

export function backupPath(dir: string, date: string): string {
  return join(dir, `turnlane-${compactDate(date)}.db`);
}

/**
 * その日のバックアップを作る。既にあれば replace=false なら何もしない（日次ジョブ）、
 * replace=true なら作り直す（turnlane backup）。一時ファイルに書いてから rename するので、途中で落ちても壊れない。
 */
export function backupNow(
  db: Database,
  dir: string,
  date: string,
  opts: { replace?: boolean } = {},
): { path: string; created: boolean } {
  const path = backupPath(dir, date);
  if (existsSync(path) && !opts.replace) return { path, created: false };
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}`;
  rmSync(tmp, { force: true });
  try {
    db.run("VACUUM INTO ?", [tmp]);
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
  return { path, created: true };
}

/** 日次バックアップの一覧（新しい順） */
export function listBackups(dir: string): BackupInfo[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((name) => {
      const m = DAILY_RE.exec(name);
      if (!m) return null;
      const path = join(dir, name);
      const st = statSync(path);
      return { date: `${m[1]}-${m[2]}-${m[3]}`, path, sizeBytes: st.size, mtimeMs: st.mtimeMs };
    })
    .filter((b): b is BackupInfo => b !== null)
    .sort((a, b) => (a.date < b.date ? 1 : -1));
}

/** 新しい順に keep 世代を残し、それより古い日次バックアップを消す。消したパスを返す */
export function pruneBackups(dir: string, keep = BACKUP_GENERATIONS): string[] {
  const old = listBackups(dir).slice(keep);
  for (const b of old) rmSync(b.path, { force: true });
  return old.map((b) => b.path);
}
