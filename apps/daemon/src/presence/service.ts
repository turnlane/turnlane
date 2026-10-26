/**
 * 在席の記録（D-105・D-110・D-139、ADR 0013）。30 秒ごとにサンプルを読み、presence_span の最後の区間を延ばすか新しい区間を足す。
 * presence_span は端末内だけのテーブル（同期しない・mutate() を通さない）。区間は入力のあった区間で持ち、
 * 「使っていた」とみなす長さ（presence.tail_min）は読むとき（presenceIn）に今の設定で足す（D-139）。
 *
 * - 起動時に idle.presence_since（在席の記録を始めた時刻）が無ければ今を入れる（D-110 (3)。これより前の日の放置は作り直さない）
 * - 新しい区間を足した（Mac に戻ってきた）ら onResumed を呼ぶ（判定を走らせ、閉じた日の明けを早く反映する）
 * - 起動して最初のサンプルでは、前回の最後の区間を 2 分以内まで見ていたなら、その続きとして扱う（D-139 (3)）
 */
import type { Database } from "bun:sqlite";
import { errorFields, type MetaOnlyLogger, meta } from "@turnlane/collectors";
import { type Clock, derive, getSetting, type MutateCtx, newId, putSetting } from "@turnlane/core";
import type { PresenceReader } from "./reader.ts";

export interface PresenceOptions {
  sqlite: Database;
  mutate: MutateCtx;
  clock: Clock;
  logger: MetaOnlyLogger;
  reader: PresenceReader;
  intervalMs?: number;
  onResumed?: () => void;
}

export const PRESENCE_SINCE_KEY = "idle.presence_since";

/** idle.presence_since が無ければ now を入れる（D-110 (3)） */
export function ensurePresenceSince(mutate: MutateCtx, now: number): void {
  if (typeof getSetting<number>(mutate.db, PRESENCE_SINCE_KEY) === "number") return;
  putSetting(mutate, PRESENCE_SINCE_KEY, now, "local_only");
}

type Row = derive.PresenceRow & { id: string };

function lastRow(sqlite: Database): Row | null {
  return (
    sqlite
      .query<Row, []>(
        "SELECT id, start_at AS start, end_at AS end, seen_until AS seenUntil FROM presence_span ORDER BY end_at DESC, id DESC LIMIT 1",
      )
      .get() ?? null
  );
}

/**
 * 1つのサンプルを保存する（D-139。入力のあった区間で持ち、T は足さない）。最後の区間を延ばすか新しい区間を足す。
 * 新しい区間を作ったら resumed = true
 */
export function recordSample(
  sqlite: Database,
  clock: Clock,
  sample: derive.PresenceSample,
  prev: derive.PrevSample | null,
): { prev: derive.PrevSample; resumed: boolean } {
  const last = lastRow(sqlite);
  const step = derive.presenceStep(last, sample, prev);
  if (last && step.update)
    sqlite.run(
      "UPDATE presence_span SET start_at = ?, end_at = ?, seen_until = ?, updated_at = ? WHERE id = ?",
      [step.update.start, step.update.end, step.update.seenUntil, sample.at, last.id],
    );
  if (step.insert)
    sqlite.run(
      "INSERT INTO presence_span (id, start_at, end_at, seen_until, source, updated_at) VALUES (?, ?, ?, ?, 'hid', ?)",
      [newId(clock), step.insert.start, step.insert.end, step.insert.seenUntil, sample.at],
    );
  return { prev: step.prev, resumed: step.insert !== null };
}

/**
 * デーモンの起動時に、前回の最後の区間の続きを引き継ぐ（D-139 (3)）。最後に見ていたサンプルから
 * `PRESENCE_MAX_GAP_MS` 以内なら、それを前のサンプルとして扱う（再起動で最後の入力の後の続きを切らない）
 */
export function carryOverPrev(sqlite: Database, now: number): derive.PrevSample | null {
  const last = lastRow(sqlite);
  if (!last || last.seenUntil === null) return null;
  if (last.seenUntil > now || now - last.seenUntil >= derive.PRESENCE_MAX_GAP_MS) return null;
  return { at: last.seenUntil, lastInput: last.end };
}

/** 在席の区間を、既に T を足した形（[始まり, 終わり]）で入れる（テスト・dev-board 用。同じ T で読めば同じ区間になる） */
export function seedPresence(
  sqlite: Database,
  id: string,
  start: number,
  end: number,
  tailMs: number = derive.PRESENCE_TAIL_MIN.default * 60_000,
): void {
  sqlite.run(
    "INSERT INTO presence_span (id, start_at, end_at, seen_until, source, updated_at) VALUES (?, ?, ?, ?, 'hid', ?)",
    [id, start, Math.max(start, end - tailMs), end, end],
  );
}

/**
 * [from, to) にかかる在席の区間（T を足して和集合にしたもの。開始順。D-139）。T は今の設定
 * （presence.tail_min）を渡す。区間は切り詰めない
 */
export function presenceIn(
  sqlite: Database,
  from: number,
  to: number,
  tailMs: number,
): [number, number][] {
  const rows = sqlite
    .query<derive.PresenceRow, [number, number]>(
      "SELECT start_at AS start, end_at AS end, seen_until AS seenUntil FROM presence_span WHERE end_at > ? AND start_at < ? ORDER BY start_at",
    )
    .all(from - tailMs, to);
  return derive.expandPresence(rows, tailMs).filter(([s, e]) => e > from && s < to);
}

/** t より前に在席していた最後の時刻（t で切る。T を足した終わり。D-139）。無ければ null */
export function lastPresentBefore(sqlite: Database, t: number, tailMs: number): number | null {
  const maxEnd = sqlite
    .query<{ e: number | null }, [number]>(
      "SELECT MAX(end_at) AS e FROM presence_span WHERE start_at < ?",
    )
    .get(t)?.e;
  if (maxEnd === null || maxEnd === undefined) return null;
  const spans = presenceIn(sqlite, maxEnd - tailMs, t, tailMs);
  const last = spans.at(-1);
  return last ? Math.min(last[1], t) : null;
}

export class PresenceService {
  readonly #o: PresenceOptions;
  #timer: ReturnType<typeof setInterval> | null = null;
  #prev: derive.PrevSample | null = null;
  #busy = false;
  #started = false;
  #method: string | null = null;

  constructor(o: PresenceOptions) {
    this.#o = o;
  }

  start(): void {
    ensurePresenceSince(this.#o.mutate, this.#o.clock.now());
    this.#timer = setInterval(
      () => void this.sample(),
      this.#o.intervalMs ?? derive.PRESENCE_SAMPLE_MS,
    );
    void this.sample();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  /** 1回読む（テストからも呼ぶ） */
  async sample(): Promise<void> {
    if (this.#busy) return;
    this.#busy = true;
    try {
      const reading = await this.#o.reader.read();
      const at = this.#o.clock.now();
      const method = this.#o.reader.method();
      if (method !== this.#method) {
        this.#method = method;
        this.#o.logger.info("presence.method", { method: meta(method) });
      }
      // 起動して最初のサンプル: 前回の最後の区間の続きを引き継ぐ（D-139 (3)）
      if (!this.#started) {
        this.#started = true;
        this.#prev = carryOverPrev(this.#o.sqlite, at);
      }
      const r = recordSample(this.#o.sqlite, this.#o.clock, { at, ...reading }, this.#prev);
      this.#prev = r.prev;
      if (r.resumed) this.#o.onResumed?.();
    } catch (e) {
      this.#o.logger.warn("presence.sample_failed", errorFields(e));
    } finally {
      this.#busy = false;
    }
  }
}
