import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
import {
  type LogFields,
  type LogLevel,
  type MetaOnlyLogger,
  safeEventName,
} from "@turnlane/collectors";

/**
 * デーモンのログ（phase0-plan 1.2）: JSON Lines を turnlaned.log に追記し、5MB × 5 世代で回転する。
 * 受け取れる値は MetaOnlyLogger の型でメタデータに限る（ADR 0005）。
 */
export interface FileLoggerOptions {
  path: string;
  maxBytes?: number;
  generations?: number;
  /** stderr にも出す（フォアグラウンド起動時） */
  echo?: boolean;
  now?: () => number;
  minLevel?: LogLevel;
}

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export class FileLogger implements MetaOnlyLogger {
  readonly path: string;
  readonly #maxBytes: number;
  readonly #generations: number;
  readonly #echo: boolean;
  readonly #now: () => number;
  readonly #min: number;
  #size: number;

  constructor(opts: FileLoggerOptions) {
    this.path = opts.path;
    this.#maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
    this.#generations = opts.generations ?? 5;
    this.#echo = opts.echo ?? false;
    this.#now = opts.now ?? Date.now;
    this.#min = LEVELS[opts.minLevel ?? "info"];
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    this.#size = existsSync(this.path) ? statSync(this.path).size : 0;
  }

  debug(event: string, fields?: LogFields): void {
    this.#write("debug", event, fields);
  }
  info(event: string, fields?: LogFields): void {
    this.#write("info", event, fields);
  }
  warn(event: string, fields?: LogFields): void {
    this.#write("warn", event, fields);
  }
  error(event: string, fields?: LogFields): void {
    this.#write("error", event, fields);
  }

  #write(level: LogLevel, event: string, fields?: LogFields): void {
    if (LEVELS[level] < this.#min) return;
    const line = `${JSON.stringify({
      t: new Date(this.#now()).toISOString(),
      level,
      event: safeEventName(event),
      ...fields,
    })}\n`;
    try {
      const bytes = Buffer.byteLength(line);
      if (this.#size + bytes > this.#maxBytes && this.#size > 0) this.#rotate();
      appendFileSync(this.path, line, { mode: 0o600 });
      this.#size += bytes;
    } catch {
      // ログの失敗でデーモンを止めない
    }
    if (this.#echo) process.stderr.write(line);
  }

  #rotate(): void {
    const g = this.#generations;
    rmSync(`${this.path}.${g - 1}`, { force: true });
    for (let i = g - 2; i >= 1; i--) {
      if (existsSync(`${this.path}.${i}`)) renameSync(`${this.path}.${i}`, `${this.path}.${i + 1}`);
    }
    renameSync(this.path, `${this.path}.1`);
    this.#size = 0;
  }
}
