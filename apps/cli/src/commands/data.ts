/**
 * turnlane backup / turnlane export --json [--out <file>]（phase0-plan 3.6、M0-7）。
 *
 * backup: デーモンが動いていれば POST /api/admin/backup で依頼する。止まっていれば DB を読み取り専用で
 *         開いて自分で VACUUM INTO する（同じファイル名・同じ世代管理）。
 * export: DB を読み取り専用で開いて全テーブルを JSON Lines で書き出す（WAL なのでデーモン稼働中でもよい）。
 */

import { closeSync, existsSync, openSync, writeSync } from "node:fs";
import {
  BACKUP_GENERATIONS,
  backupNow,
  DEFAULT_DAY_BOUNDARY,
  exportJsonl,
  openDatabase,
  pruneBackups,
  systemTimeZone,
  toLocalDate,
  VERSION,
} from "@turnlane/core";
import { daemonClient, fetchHealth } from "../client.ts";
import type { CliEnv } from "../env.ts";
import { tr } from "../lang.ts";

export async function backupCommand(env: CliEnv, now = Date.now()): Promise<number> {
  const { paths } = env;
  if (await fetchHealth(paths)) {
    const res = await daemonClient(paths).api.admin.backup.$post();
    if (!res.ok) {
      env.err(
        tr(
          `Backup failed (HTTP ${res.status}). Check turnlane daemon logs.`,
          `バックアップに失敗しました（HTTP ${res.status}）。turnlane daemon logs を確認してください。`,
        ),
      );
      return 1;
    }
    const r = (await res.json()) as { date: string; path: string };
    env.out(tr(`Backed up: ${r.path}`, `バックアップしました: ${r.path}`));
    return 0;
  }
  if (!existsSync(paths.dbPath)) {
    env.err(tr(`No database at ${paths.dbPath}`, `DB がありません: ${paths.dbPath}`));
    return 1;
  }
  // デーモン停止中: 自分で取る（日付区切りの設定はデーモン側で読むので、ここでは既定値を使う）
  const db = openDatabase(paths.dbPath, { readonly: true });
  try {
    const date = toLocalDate(now, systemTimeZone(), DEFAULT_DAY_BOUNDARY);
    const r = backupNow(db, paths.backupDir, date, { replace: true });
    pruneBackups(paths.backupDir, BACKUP_GENERATIONS);
    env.out(
      tr(
        `Backed up directly (Turnlane isn't running): ${r.path}`,
        `バックアップしました（Turnlane が止まっているため直接）: ${r.path}`,
      ),
    );
    return 0;
  } finally {
    db.close();
  }
}

export function exportCommand(
  env: CliEnv,
  opts: { json: boolean; out?: string | undefined; write?: (s: string) => void },
): number {
  if (!opts.json) {
    env.err(
      tr(
        "Usage: turnlane export --json [--out <file>] (JSON Lines only for now)",
        "使い方: turnlane export --json [--out <file>]（今は JSON Lines だけ）",
      ),
    );
    return 2;
  }
  const { paths } = env;
  if (!existsSync(paths.dbPath)) {
    env.err(tr(`No database at ${paths.dbPath}`, `DB がありません: ${paths.dbPath}`));
    return 1;
  }
  const db = openDatabase(paths.dbPath, { readonly: true });
  let fd: number | null = null;
  try {
    let write = opts.write ?? ((s: string) => process.stdout.write(s));
    if (opts.out) {
      fd = openSync(opts.out, "w", 0o600);
      const f = fd;
      write = (s) => {
        writeSync(f, s);
      };
    }
    const counts = exportJsonl(db, write, { appVersion: VERSION, exportedAt: Date.now() });
    if (opts.out) {
      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      env.err(
        tr(
          `Exported: ${opts.out} (${Object.keys(counts).length} tables, ${total} rows)`,
          `エクスポートしました: ${opts.out}（${Object.keys(counts).length} テーブル、${total} 行）`,
        ),
      );
    }
    return 0;
  } finally {
    if (fd !== null) closeSync(fd);
    db.close();
  }
}
