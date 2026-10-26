import type { Database } from "bun:sqlite";

/**
 * 完全エクスポート（phase0-plan 2.5-6、ADR 0002）: 全テーブルを JSON Lines で書き出す。
 * 1行目はヘッダ（形式名・スキーマ番号）、以降は1行1レコード `{"type":"row","table":…,"row":{…}}`。
 * DB には会話本文が無い（ADR 0005）ので、そのまま書き出してよい。
 */
export const EXPORT_FORMAT = "turnlane-export";
export const EXPORT_FORMAT_VERSION = 1;

export interface ExportHeader {
  type: "header";
  format: typeof EXPORT_FORMAT;
  formatVersion: number;
  schemaVersion: number;
  appVersion: string;
  exportedAt: number;
  tables: Record<string, number>;
}

export function exportTables(db: Database): string[] {
  return db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> '__migrations' ORDER BY name",
    )
    .all()
    .map((r) => r.name);
}

/** write には改行付きの1行ずつ渡す。戻り値はテーブルごとの件数 */
export function exportJsonl(
  db: Database,
  write: (line: string) => void,
  meta: { appVersion: string; exportedAt: number },
): Record<string, number> {
  const tables = exportTables(db);
  const counts: Record<string, number> = {};
  // 読み取りを1つのトランザクションにまとめ、途中で書き込まれても一貫した断面にする
  db.run("BEGIN");
  try {
    for (const t of tables) {
      counts[t] = db.query<{ n: number }, []>(`SELECT count(*) AS n FROM "${t}"`).get()?.n ?? 0;
    }
    const header: ExportHeader = {
      type: "header",
      format: EXPORT_FORMAT,
      formatVersion: EXPORT_FORMAT_VERSION,
      schemaVersion:
        db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0,
      appVersion: meta.appVersion,
      exportedAt: meta.exportedAt,
      tables: counts,
    };
    write(`${JSON.stringify(header)}\n`);
    for (const t of tables) {
      for (const row of db.query<Record<string, unknown>, []>(`SELECT * FROM "${t}"`).iterate()) {
        write(`${JSON.stringify({ type: "row", table: t, row })}\n`);
      }
    }
  } finally {
    db.run("COMMIT");
  }
  return counts;
}
