import { homedir } from "node:os";
import { join } from "node:path";

/**
 * 実行時の配置（phase0-plan 1.4）。CLI とデーモンで共有する。
 * 開発・テストで実データに触れないよう、環境変数で上書きできる:
 * - TURNLANE_DATA_DIR（既定 ~/Library/Application Support/turnlane）
 * - TURNLANE_LOG_DIR（既定 ~/Library/Logs/turnlane）
 * - TURNLANE_PORT（既定 7317）
 * HOME を差し替えた場合も、それに従う。
 */
export interface TurnlanePaths {
  home: string;
  dataDir: string;
  dbPath: string;
  tokenPath: string;
  backupDir: string;
  spoolDir: string;
  /** 日報の AI 要約の作業ディレクトリ（取り込みから除外する。M4-6） */
  summarizeDir: string;
  logDir: string;
  logPath: string;
  launchAgentsDir: string;
  binDir: string;
  port: number;
}

export const DEFAULT_PORT = 7317;
export const DAEMON_LABEL = "dev.turnlane.daemon";
export const CALENDAR_HELPER_LABEL = "dev.turnlane.calendar-helper";
export const CALENDAR_HELPER_APP = "TurnlaneCalendarHelper.app";
export const DESKTOP_LABEL = "dev.turnlane.desktop";
export const DESKTOP_APP = "Turnlane.app";

export function resolvePaths(
  env: Record<string, string | undefined> = process.env,
  home: string = env.HOME ?? homedir(),
): TurnlanePaths {
  const dataDir = env.TURNLANE_DATA_DIR || join(home, "Library", "Application Support", "turnlane");
  const logDir = env.TURNLANE_LOG_DIR || join(home, "Library", "Logs", "turnlane");
  const port = env.TURNLANE_PORT ? Number(env.TURNLANE_PORT) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid TURNLANE_PORT: ${env.TURNLANE_PORT}`);
  }
  return {
    home,
    dataDir,
    dbPath: join(dataDir, "turnlane.db"),
    tokenPath: join(dataDir, "token"),
    backupDir: join(dataDir, "backups"),
    spoolDir: join(dataDir, "spool"),
    summarizeDir: join(dataDir, "summarize"),
    logDir,
    logPath: join(logDir, "turnlaned.log"),
    launchAgentsDir: join(home, "Library", "LaunchAgents"),
    binDir: join(home, ".local", "bin"),
    port,
  };
}

export function baseUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}
