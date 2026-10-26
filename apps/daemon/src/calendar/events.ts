/**
 * 予定の作成・編集（D-093。ADR 0012、phase0-plan 4.5 の「D-093 の方式」、m2-api 24章）。
 *
 * - 作る: ヘルパの createEvent（calendarId を省く = Calendar.app のデフォルトカレンダー。作成の入力で選んだカレンダーが
 *   あればそこへ。url = turnlane://event/<uuid>）
 * - 変える・消す: 編集できる予定（下の EDITABLE_SQL。ヘルパも同じ条件を確かめる）だけを updateEvent / removeEvent
 * - 書けたら calendar_event の行を結果で置き換え（id は変えない）、SSE `calendar` を送る。書き込みは同期と直列
 *   （CalendarSync.exclusive）。Calendar.app 側の変更は従来の同期で取り込む
 * - M3-3 で書いた時間ブロックの予定（url = dayline://timeblock/）の件数・期間と、確認後の削除。対象の判定はヘルパが
 *   url の接頭辞で行う（listTimeblockEvents / deleteTimeblockEvent）。自動では消さない
 * 題名はログに出さない（件数とコードだけ）。
 */
import type { Database } from "bun:sqlite";
import { type MetaOnlyLogger, meta } from "@turnlane/collectors";
import {
  addDays,
  type CalendarColorKey,
  type Clock,
  dayStartMs,
  isCalendarColorKey,
  newId,
  type TurnlaneSettings,
  toLocalDate,
} from "@turnlane/core";
import { OpError } from "../derive/ops.ts";
import { HelperRpcError } from "./bridge.ts";
import { type CalendarProvider, type HelperEvent, OWN_EVENT_PREFIX } from "./provider.ts";
import { type CalendarSync, upsertEventRow } from "./sync.ts";

/** 予定の作成・編集に要るヘルパの版（D-093。0.6.0 から目印が turnlane://event/。ADR 0016） */
export const EVENTS_HELPER = "0.6.0";

/** 会議リンクをメモでも判定するヘルパの版（D-097。それより前は URL・場所だけで判定する） */
export const MEETING_LINK_HELPER = "0.5.0";

/** 時間ブロックの予定を探す範囲（今日の前後の日数） */
export const TIMEBLOCK_SCAN_DAYS = 365;

/**
 * 編集できる予定（calendar_event を e、calendar を c とした SQL の条件。ADR 0012 の Decision 3）:
 * 書き込めるカレンダー・参加者なし（NULL = 分からないは不可）・繰り返しでない・終日でない・時間ブロックの予定でない・eventIdentifier がある
 */
export const EDITABLE_SQL = `(c.is_writable = 1 AND e.has_attendees = 0 AND coalesce(e.recurring, 0) = 0
  AND e.all_day = 0 AND e.is_own_timeblock = 0 AND e.event_id IS NOT NULL)`;

/** 読み取り専用の理由（UI の1行。編集できれば null） */
export type ReadOnlyReason = "attendees" | "calendar" | "recurring" | "all_day" | "helper";

export interface EventRowFacts {
  is_writable: number;
  has_attendees: number | null;
  recurring: number | null;
  all_day: number;
  is_own_timeblock: number;
  event_id: string | null;
}

/** EDITABLE_SQL と同じ判定（helperOutdated なら helper） */
export function readOnlyReason(r: EventRowFacts, helperOutdated: boolean): ReadOnlyReason | null {
  if (r.all_day === 1) return "all_day";
  if (r.is_writable !== 1 || r.is_own_timeblock === 1) return "calendar";
  if (r.has_attendees === 1) return "attendees";
  if (r.recurring === 1) return "recurring";
  if (helperOutdated || r.has_attendees === null || !r.event_id) return "helper";
  return null;
}

/** 版が min より前か（"fake" など版の形でないものは前ではない扱い） */
export function versionBelow(version: string | null | undefined, min: string): boolean {
  const parse = (v: string) => /^(\d+)\.(\d+)\.(\d+)/.exec(v)?.slice(1).map(Number) ?? null;
  const a = version ? parse(version) : null;
  const b = parse(min);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if ((a[i] as number) !== (b[i] as number)) return (a[i] as number) < (b[i] as number);
  }
  return false;
}

/** 失敗のコード（ログ・HTTP の error に入れる短い英字） */
export function errorCode(e: unknown): string {
  if (e instanceof HelperRpcError) {
    if (e.code === -32601) return "helper_outdated";
    if (e.code === 1) return "no_access";
    // ヘルパのストアの失敗は message が短い英字のコード（not_writable、no_default_calendar など）
    if (e.code > 1 && /^[a-z_]+$/.test(e.message)) return e.message.slice(0, 40);
    return `helper_${e.code}`;
  }
  const m = e instanceof Error ? e.message : String(e);
  return (/^[a-z_]+$/.test(m) ? m : "error").slice(0, 40);
}

/** 予定の書き先（設定画面・turnlane calendar status。D-093） */
export interface EventsStatus {
  /** Calendar.app のデフォルトカレンダー（分からなければ null） */
  calendar: {
    id: string;
    name: string;
    account: string | null;
    color: string | null;
    /** Turnlane の中で選んだ色（D-125） */
    colorKey: CalendarColorKey | null;
  } | null;
  /** ok = 書ける / none = デフォルトが無い / not_writable = 書き込めない / unknown = ヘルパ未接続・古い・未同期 */
  defaultCalendar: "ok" | "none" | "not_writable" | "unknown";
  /** ヘルパが 0.4.0 より前（予定を作成・編集できない） */
  helperOutdated: boolean;
}

/** M3-3 で書いた時間ブロックの予定の件数と期間（D-093） */
export interface TimeblockEventsSummary {
  count: number;
  /** 最初の開始・最後の終わり（0件なら null） */
  from: number | null;
  to: number | null;
  calendars: { name: string; account: string | null; count: number }[];
}

export interface EventPatch {
  title?: string;
  start?: number;
  end?: number;
  /** 移す先（calendar.id） */
  calendarId?: string;
}

/**
 * ⌘Z の逆の書き込みの前提（D-096）: 予定が今この状態のときだけ書く。違えば（Calendar.app などで変わっていたら）
 * 書かずに 409 changed。calendarId は calendar.id、title は省くと比べない
 */
export interface EventExpect {
  start: number;
  end: number;
  title?: string | null;
  calendarId?: string;
}

interface Row extends EventRowFacts {
  id: string;
  calendar_id: string;
  start_at: number;
  end_at: number;
}

export class CalendarEvents {
  constructor(
    private readonly o: {
      sqlite: Database;
      clock: Clock;
      settings: () => TurnlaneSettings;
      provider: CalendarProvider;
      service: CalendarSync;
      logger: MetaOnlyLogger;
      /** 予定が変わった論理日付（SSE calendar）と、待ち区間の作り直し */
      publish: (dates: string[]) => void;
    },
  ) {}

  /** ヘルパが 0.4.0 より前（接続していて版が分かるときだけ） */
  helperOutdated(): boolean {
    const st = this.o.service.status();
    return st.connected && versionBelow(st.helperVersion, EVENTS_HELPER);
  }

  status(): EventsStatus {
    const st = this.o.service.status();
    const outdated = this.helperOutdated();
    const id = this.o.service.defaultCalendar;
    if (id === null) return { calendar: null, defaultCalendar: "none", helperOutdated: outdated };
    if (id === undefined || !st.connected)
      return { calendar: null, defaultCalendar: "unknown", helperOutdated: outdated };
    const r = this.o.sqlite
      .query<
        {
          id: string;
          name: string;
          account_name: string | null;
          color: string | null;
          color_key: string | null;
          is_writable: number;
        },
        [string]
      >("SELECT id, name, account_name, color, color_key, is_writable FROM calendar WHERE id = ?")
      .get(id);
    if (!r) return { calendar: null, defaultCalendar: "unknown", helperOutdated: outdated };
    return {
      calendar: {
        id: r.id,
        name: r.name,
        account: r.account_name,
        color: r.color,
        colorKey: isCalendarColorKey(r.color_key) ? r.color_key : null,
      },
      defaultCalendar: r.is_writable === 1 ? "ok" : "not_writable",
      helperOutdated: outdated,
    };
  }

  /** 書き込みの前提（接続・版） */
  #requireHelper(): void {
    if (!this.o.provider.connected()) throw new OpError(409, "helper_not_connected");
    if (this.helperOutdated()) throw new OpError(409, "helper_outdated");
  }

  /** ヘルパの失敗 → 409 のコード */
  async #call<T>(op: string, f: () => Promise<T>): Promise<T> {
    try {
      return await f();
    } catch (e) {
      if (e instanceof OpError) throw e;
      const code = errorCode(e);
      this.o.logger.info("calendar.event_write_failed", { op: meta(op), code: meta(code) });
      throw new OpError(409, code === "helper_disconnected" ? "helper_not_connected" : code);
    }
  }

  #row(id: string): Row & { title: string | null } {
    const r = this.o.sqlite
      .query<Row & { title: string | null }, [string]>(
        `SELECT e.id, e.calendar_id, e.start_at, e.end_at, e.title, e.all_day, e.has_attendees, e.recurring,
                e.is_own_timeblock, e.event_id, c.is_writable
           FROM calendar_event e JOIN calendar c ON c.id = e.calendar_id WHERE e.id = ?`,
      )
      .get(id);
    if (!r) throw new OpError(404, "not_found");
    return r;
  }

  #calendarRowId(externalId: string): string | null {
    return (
      this.o.sqlite
        .query<{ id: string }, [string]>(
          "SELECT id FROM calendar WHERE provider = 'eventkit' AND external_id = ?",
        )
        .get(externalId)?.id ?? null
    );
  }

  /**
   * ヘルパの結果を calendar_event に入れる（id を保つ。同じ (calendar, externalId, occurrence) の別の行は消す）。
   * カレンダーがまだ同期されていなければ入れずに null
   */
  #store(e: HelperEvent, id: string | null): string | null {
    const calendarId = this.#calendarRowId(e.calendarId);
    if (!calendarId) return null;
    const db = this.o.sqlite;
    const rowId = id ?? newId(this.o.clock);
    db.transaction(() => {
      db.run("DELETE FROM calendar_event WHERE id = ?", [rowId]);
      db.run(
        "DELETE FROM calendar_event WHERE calendar_id = ? AND external_id = ? AND occurrence_start = ?",
        [calendarId, e.externalId, e.occurrenceStart],
      );
      upsertEventRow(db, { id: rowId, calendarId, fetchedAt: this.o.clock.now() }, e, null);
    })();
    return rowId;
  }

  #publish(ranges: { start: number; end: number }[]): void {
    const dates = new Set<string>();
    for (const r of ranges) this.o.service.addDates(dates, r.start, r.end, null, null);
    // 表示の日付（暦日）でも知らせる（深夜の 0:00〜日付区切り。週ボードの今日の列は暦日）
    const s = this.o.settings();
    for (const r of ranges) dates.add(toLocalDate(r.start, s.tz, 0));
    this.o.publish([...dates].sort());
  }

  /**
   * 予定を作る・移す先のカレンダー（calendar.id）→ ヘルパのカレンダー ID。無い（404 calendar_not_found）・書き込めない
   * （400 not_writable）・無視している（400 calendar_ignored）カレンダーには書かない
   */
  #target(id: string): string {
    const c = this.o.sqlite
      .query<{ external_id: string; is_writable: number; role: string }, [string]>(
        "SELECT external_id, is_writable, role FROM calendar WHERE id = ? AND provider = 'eventkit'",
      )
      .get(id);
    if (!c) throw new OpError(404, "calendar_not_found");
    if (c.is_writable !== 1) throw new OpError(400, "not_writable");
    if (c.role === "ignored") throw new OpError(400, "calendar_ignored");
    return c.external_id;
  }

  /**
   * 予定を作る（calendarId を省けば Calendar.app のデフォルトカレンダー、あればそのカレンダー）。
   * 戻り値は calendar_event.id（カレンダーが未同期なら null）
   */
  async create(p: {
    title: string;
    start: number;
    end: number;
    calendarId?: string;
  }): Promise<string | null> {
    const title = p.title.trim();
    if (!title) throw new OpError(400, "invalid_input: title");
    if (!(p.end > p.start)) throw new OpError(400, "invalid_input: range");
    const calendarExt = p.calendarId !== undefined ? this.#target(p.calendarId) : undefined;
    this.#requireHelper();
    const s = this.o.settings();
    const result = await this.o.service.exclusive(async () => {
      const e = await this.#call("create", () =>
        this.o.provider.createEvent({
          ...(calendarExt !== undefined ? { calendarId: calendarExt } : {}),
          title,
          start: p.start,
          end: p.end,
          tz: s.tz,
          url: `${OWN_EVENT_PREFIX}${newId(this.o.clock)}`,
        }),
      );
      return { e, id: this.#store(e, null) };
    });
    this.o.logger.info("calendar.event_created", {
      stored: result.id !== null,
      chosen_calendar: calendarExt !== undefined,
    });
    if (result.id === null) this.o.service.schedule(0);
    this.#publish([{ start: result.e.start, end: result.e.end }]);
    return result.id;
  }

  /**
   * ifMatch の状態と今の予定を比べる（D-096）。キャッシュ（calendar_event）と、ヘルパから読み直した予定の両方で比べる
   * （同期がまだ届いていない外部の変更も拾う）。違えば 409 changed
   */
  async #verify(r: Row & { title: string | null }, x: EventExpect): Promise<void> {
    const changed = () => new OpError(409, "changed");
    const sameTitle = (t: string | null | undefined) =>
      x.title === undefined || (t ?? null) === (x.title ?? null);
    if (r.start_at !== x.start || r.end_at !== x.end || !sameTitle(r.title)) throw changed();
    if (x.calendarId !== undefined && x.calendarId !== r.calendar_id) throw changed();
    const cal = this.o.sqlite
      .query<{ external_id: string }, [string]>("SELECT external_id FROM calendar WHERE id = ?")
      .get(r.calendar_id);
    if (!cal) throw changed();
    const live = await this.#call("verify", () =>
      this.o.provider.fetchEvents({ calendarIds: [cal.external_id], from: x.start, to: x.end }),
    );
    const e = live.find((y) => y.eventId === r.event_id);
    if (!e || e.start !== x.start || e.end !== x.end || !sameTitle(e.title)) throw changed();
  }

  /**
   * 予定を変える（題名・開始・終了・カレンダー）。編集できる予定だけ。ifMatch があれば、今の予定がその状態のときだけ
   * 書く（⌘Z の逆の書き込み。D-096）
   */
  async update(id: string, patch: EventPatch, ifMatch?: EventExpect): Promise<string> {
    const r = this.#row(id);
    if (readOnlyReason(r, this.helperOutdated())) throw new OpError(409, "not_editable");
    this.#requireHelper();
    const title = patch.title?.trim();
    if (patch.title !== undefined && !title) throw new OpError(400, "invalid_input: title");
    const start = patch.start ?? r.start_at;
    const end = patch.end ?? r.end_at;
    if (!(end > start)) throw new OpError(400, "invalid_input: range");
    let calendarExt: string | undefined;
    if (patch.calendarId && patch.calendarId !== r.calendar_id)
      calendarExt = this.#target(patch.calendarId);
    const e = await this.o.service.exclusive(async () => {
      if (ifMatch) await this.#verify(this.#row(id), ifMatch);
      const e = await this.#call("update", () =>
        this.o.provider.updateEvent({
          eventId: r.event_id as string,
          ...(title !== undefined ? { title } : {}),
          ...(patch.start !== undefined ? { start: patch.start } : {}),
          ...(patch.end !== undefined ? { end: patch.end } : {}),
          ...(calendarExt ? { calendarId: calendarExt } : {}),
        }),
      );
      this.#store(e, id);
      return e;
    });
    this.o.logger.info("calendar.event_updated", { moved_calendar: calendarExt !== undefined });
    this.#publish([
      { start: r.start_at, end: r.end_at },
      { start: e.start, end: e.end },
    ]);
    return id;
  }

  /** 予定を消す。編集できる予定だけ */
  async remove(id: string): Promise<void> {
    const r = this.#row(id);
    if (readOnlyReason(r, this.helperOutdated())) throw new OpError(409, "not_editable");
    this.#requireHelper();
    await this.o.service.exclusive(async () => {
      await this.#call("remove", () =>
        this.o.provider.removeEvent({ eventId: r.event_id as string }),
      );
      this.o.sqlite.run("DELETE FROM calendar_event WHERE id = ?", [id]);
    });
    this.o.logger.info("calendar.event_removed", {});
    this.#publish([{ start: r.start_at, end: r.end_at }]);
  }

  // ---------- M3-3 で書いた時間ブロックの予定の削除 ----------

  #scanRange(): { from: number; to: number } {
    const s = this.o.settings();
    const today = toLocalDate(this.o.clock.now(), s.tz, s.dayBoundary);
    return {
      from: dayStartMs(addDays(today, -TIMEBLOCK_SCAN_DAYS), s.tz, s.dayBoundary),
      to: dayStartMs(addDays(today, TIMEBLOCK_SCAN_DAYS + 1), s.tz, s.dayBoundary),
    };
  }

  async #listTimeblocks() {
    this.#requireHelper();
    return this.#call("list_timeblocks", () =>
      this.o.provider.listTimeblockEvents(this.#scanRange()),
    );
  }

  /** 件数・期間・カレンダーごとの件数（消さない） */
  async timeblockSummary(): Promise<TimeblockEventsSummary> {
    const list = await this.#listTimeblocks();
    const names = new Map(
      this.o.sqlite
        .query<{ external_id: string; name: string; account_name: string | null }, []>(
          "SELECT external_id, name, account_name FROM calendar WHERE provider = 'eventkit'",
        )
        .all()
        .map((c) => [c.external_id, c]),
    );
    const by = new Map<string, { name: string; account: string | null; count: number }>();
    for (const e of list) {
      const c = names.get(e.calendarId);
      const k = e.calendarId;
      const cur = by.get(k) ?? { name: c?.name ?? "?", account: c?.account_name ?? null, count: 0 };
      cur.count++;
      by.set(k, cur);
    }
    return {
      count: list.length,
      from: list.length > 0 ? Math.min(...list.map((e) => e.start)) : null,
      to: list.length > 0 ? Math.max(...list.map((e) => e.end)) : null,
      calendars: [...by.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    };
  }

  /**
   * 確認の後に消す。数え直した件数が expected と違えば消さずに 409 changed（画面で数え直してもらう）。
   * ヘルパの deleteTimeblockEvent が1件ずつ目印を確かめてから消す
   */
  async cleanupTimeblocks(expected: number): Promise<{ deleted: number; failed: number }> {
    const list = await this.#listTimeblocks();
    if (list.length !== expected) throw new OpError(409, "changed");
    let deleted = 0;
    let failed = 0;
    for (const e of list) {
      try {
        const r = await this.o.provider.deleteTimeblockEvent({ eventId: e.eventId });
        if (r.deleted) deleted++;
      } catch (err) {
        failed++;
        this.o.logger.info("calendar.timeblock_delete_failed", { code: meta(errorCode(err)) });
        if (!this.o.provider.connected()) break;
      }
    }
    this.o.logger.info("calendar.timeblocks_cleaned", { deleted, failed });
    this.o.service.schedule(0);
    return { deleted, failed };
  }
}
