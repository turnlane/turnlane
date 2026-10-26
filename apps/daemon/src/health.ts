/** GET /api/health の応答（phase0-plan 3.4）。M1 以降で sources / calendarHelper を埋める */
export interface HealthReport {
  ok: boolean;
  version: string;
  pid: number;
  startedAt: number;
  uptimeMs: number;
  port: number;
  db: {
    userVersion: number;
    schemaVersion: number;
    journalMode: string;
    sqliteVersion: string;
    sizeBytes: number;
  };
  backup: { lastDate: string | null; lastAt: number | null; count: number };
  sources: { tool: string; label: string; healthLevel: string }[];
  /** カレンダーヘルパ（M3）。未接続なら connected = false で、他の機能はそのまま動く */
  calendarHelper: {
    connected: boolean;
    authorization?: "fullAccess" | "denied" | "notDetermined" | "writeOnly" | null;
    version?: string | null;
    lastSyncedAt?: number | null;
    /** 予定を取れていないことの知らせ（D-130。サイドバー下の1行。null は知らせない） */
    problem?: "no_access" | "not_connected" | "sync_failing" | null;
  };
  sseClients: number;
  /** 組み込んだ拡張の id（ADR 0015。公開のビルドでは空） */
  extensions: string[];
}
