import type { Database } from "bun:sqlite";
import { errorFields, type MetaOnlyLogger, meta } from "@turnlane/collectors";
import {
  BACKUP_GENERATIONS,
  backupNow,
  type Clock,
  type DayBoundary,
  listBackups,
  pruneBackups,
  toLocalDate,
} from "@turnlane/core";

/**
 * 日次バックアップのジョブ（M0-7）。起動時と一定間隔で「今日（論理日付）の分が無ければ作る」。
 * 14 世代を超えた古いものは消す。
 */
export interface BackupJobOptions {
  db: Database;
  dir: string;
  clock: Clock;
  tz: string;
  boundary: DayBoundary;
  logger: MetaOnlyLogger;
  onCreated?: (info: { date: string; path: string }) => void;
  keep?: number;
}

export class BackupJob {
  readonly #o: BackupJobOptions;
  #timer: ReturnType<typeof setInterval> | null = null;
  lastAt: number | null = null;

  constructor(o: BackupJobOptions) {
    this.#o = o;
  }

  today(): string {
    return toLocalDate(this.#o.clock.now(), this.#o.tz, this.#o.boundary);
  }

  /** 今日の分が無ければ作る。作ったら true */
  runIfDue(): boolean {
    return this.#run(false).created;
  }

  /** 即時バックアップ（turnlane backup / POST /api/admin/backup）。今日の分を作り直す */
  runNow(): { date: string; path: string } {
    const r = this.#run(true);
    return { date: r.date, path: r.path };
  }

  #run(replace: boolean): { created: boolean; date: string; path: string } {
    const o = this.#o;
    const date = this.today();
    try {
      const r = backupNow(o.db, o.dir, date, { replace });
      if (r.created) {
        this.lastAt = o.clock.now();
        const removed = pruneBackups(o.dir, o.keep ?? BACKUP_GENERATIONS);
        o.logger.info("backup.created", {
          date: meta(date),
          path: meta(r.path),
          pruned: removed.length,
          manual: replace,
        });
        o.onCreated?.({ date, path: r.path });
      }
      return { ...r, date };
    } catch (e) {
      o.logger.error("backup.failed", {
        ...errorFields(e, { includeMessage: true }),
        date: meta(date),
      });
      throw e;
    }
  }

  status(): { lastDate: string | null; lastAt: number | null; count: number } {
    const list = listBackups(this.#o.dir);
    return {
      lastDate: list[0]?.date ?? null,
      lastAt: this.lastAt ?? list[0]?.mtimeMs ?? null,
      count: list.length,
    };
  }

  start(intervalMs = 10 * 60_000): void {
    const tick = () => {
      try {
        this.runIfDue();
      } catch {
        // ログは #run で出している。次の間隔で再試行する
      }
    };
    tick();
    this.#timer = setInterval(tick, intervalMs);
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }
}
