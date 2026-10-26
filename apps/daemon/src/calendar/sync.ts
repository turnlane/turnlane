/**
 * 予定の読み取りの同期（M3-2。phase0-plan 4.5・3.3.1、m2-api.md 3.2）。
 *
 * - 窓（今日の7日前〜21日後）のスナップショットを取り、calendar_event を代入で置き換える（窓内で返らなかった予定・
 *   窓から外れた予定・同期しないカレンダーの予定は削除する）。calendar_event はキャッシュ（local_only）
 * - 取得するカレンダー: 役割が source のもの + 祝日カレンダー（役割が ignored でも。M3-6）。
 *   祝日カレンダーが自動（設定が null）のときは候補（書き込み不可・誕生日でない）をすべて取得して判定に使う
 * - 予定ごとに編集できるかの材料（eventIdentifier・参加者・繰り返し）と目印（turnlane://event/・旧名の dayline://event/ = Turnlane が作った予定、
 *   dayline://timeblock/ = M3-3 で書いた時間ブロックの予定）を持つ（D-093）
 * - Turnlane からの予定の書き込み（events.ts）は exclusive() で同期と直列にする（取得の途中の結果で消さない）
 * - きっかけ: ヘルパの接続、storeChanged（2秒束ねる）、権限の変化、5分ごと、POST /api/calendar/sync、設定の変更
 * - 変化があった論理日付を SSE `calendar` で知らせ、runner に待ち区間の作り直しを頼む（会議と重なる待ちが
 *   集計外 `event` になる。runner は毎回、窓の7日前から作り直すので初回の同期で窓内の過去日も直る）
 * - ヘルパ未接続・権限なしのときは何もしない（キャッシュは残す）。他の機能はそのまま動く
 */
import type { Database } from "bun:sqlite";
import { errorFields, type MetaOnlyLogger, meta } from "@turnlane/collectors";
import {
  addDays,
  type Clock,
  dayStartMs,
  isHolidayCandidate,
  newId,
  type TurnlaneSettings,
  toLocalDate,
} from "@turnlane/core";
import { hasMeetingLink } from "@turnlane/core/web";
import {
  type Authorization,
  type CalendarProvider,
  type HelperEvent,
  isOwnEventUrl,
  TIMEBLOCK_EVENT_PREFIX,
} from "./provider.ts";

export const WINDOW_PAST_DAYS = 7;
export const WINDOW_FUTURE_DAYS = 21;
/** M3-3 で書いた時間ブロックの予定の目印（D-093 で書くのをやめた。読み取りで除くのに使う） */
export const OWN_TIMEBLOCK_PREFIX = TIMEBLOCK_EVENT_PREFIX;

const SIG_SQL = `coalesce(title, '') || '|' || coalesce(location, '') || '|' || start_at || '|' || end_at || '|' ||
  coalesce(tz, '') || '|' || all_day || '|' || coalesce(start_date, '') || '|' || coalesce(end_date, '') || '|' ||
  coalesce(status, '') || '|' || coalesce(availability, '') || '|' || coalesce(self_response, '') || '|' ||
  coalesce(conference_url, '') || '|' || coalesce(own_timeblock_id, '') || ':' || is_own_timeblock || '|' ||
  coalesce(event_id, '') || '|' || coalesce(has_attendees, '') || '|' || coalesce(recurring, '') || '|' || is_own_event || '|' ||
  coalesce(has_meeting_link, '')`;

const b01 = (v: boolean | null | undefined) => (v === true ? 1 : v === false ? 0 : null);

/** ヘルパの予定 → calendar_event の列（own は M3-3 の時間ブロックの予定の ID。sig は変化の判定） */
export function eventColumns(e: HelperEvent, ownTimeblockId: string | null) {
  const allDay = e.allDay ? 1 : 0;
  const startDate = e.allDay ? (e.startDate ?? null) : null;
  const endDate = e.allDay ? (e.endDate ?? null) : null;
  const own = ownTimeblockId !== null || e.url?.startsWith(OWN_TIMEBLOCK_PREFIX) ? 1 : 0;
  const v = {
    title: e.title ?? null,
    location: e.location ?? null,
    startAt: e.start,
    endAt: e.end,
    tz: e.tz ?? null,
    allDay,
    startDate,
    endDate,
    status: e.status ?? null,
    availability: e.availability ?? null,
    selfResponse: e.selfResponse ?? null,
    conferenceUrl: e.conferenceUrl ?? null,
    extUpdatedAt: e.lastModified ?? null,
    isOwnTimeblock: own,
    ownTimeblockId,
    eventId: e.eventId ?? null,
    hasAttendees: b01(e.hasAttendees),
    recurring: b01(e.recurring),
    isOwnEvent: isOwnEventUrl(e.url) ? 1 : 0,
    // 会議リンク（D-097）: ヘルパ 0.5.0 は URL・場所・メモで判定した値を返す。それより前は URL・場所だけで判定する
    hasMeetingLink:
      typeof e.hasMeetingLink === "boolean"
        ? Number(e.hasMeetingLink)
        : Number(hasMeetingLink([e.url, e.location, e.conferenceUrl])),
  };
  const sig = [
    v.title ?? "",
    v.location ?? "",
    v.startAt,
    v.endAt,
    v.tz ?? "",
    allDay,
    startDate ?? "",
    endDate ?? "",
    v.status ?? "",
    v.availability ?? "",
    v.selfResponse ?? "",
    v.conferenceUrl ?? "",
    `${ownTimeblockId ?? ""}:${own}`,
    v.eventId ?? "",
    v.hasAttendees ?? "",
    v.recurring ?? "",
    v.isOwnEvent,
    v.hasMeetingLink,
  ].join("|");
  return { v, sig };
}

/** calendar_event の1行を代入する（(calendar_id, external_id, occurrence_start) が同じなら更新。id は新しい行だけに使う） */
export function upsertEventRow(
  db: Database,
  row: { id: string; calendarId: string; fetchedAt: number },
  e: HelperEvent,
  ownTimeblockId: string | null,
): void {
  const { v } = eventColumns(e, ownTimeblockId);
  db.run(
    `INSERT INTO calendar_event (id, calendar_id, external_id, occurrence_start, title, location, start_at, end_at, tz,
       all_day, start_date, end_date, status, availability, self_response, conference_url, ext_updated_at,
       is_own_timeblock, own_timeblock_id, fetched_at, event_id, has_attendees, recurring, is_own_event,
       has_meeting_link)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (calendar_id, external_id, occurrence_start) DO UPDATE SET
       title = excluded.title, location = excluded.location, start_at = excluded.start_at,
       end_at = excluded.end_at, tz = excluded.tz, all_day = excluded.all_day,
       start_date = excluded.start_date, end_date = excluded.end_date, status = excluded.status,
       availability = excluded.availability, self_response = excluded.self_response,
       conference_url = excluded.conference_url, ext_updated_at = excluded.ext_updated_at,
       is_own_timeblock = excluded.is_own_timeblock, own_timeblock_id = excluded.own_timeblock_id,
       fetched_at = excluded.fetched_at, event_id = excluded.event_id, has_attendees = excluded.has_attendees,
       recurring = excluded.recurring, is_own_event = excluded.is_own_event,
       has_meeting_link = excluded.has_meeting_link`,
    [
      row.id,
      row.calendarId,
      e.externalId,
      e.occurrenceStart,
      v.title,
      v.location,
      v.startAt,
      v.endAt,
      v.tz,
      v.allDay,
      v.startDate,
      v.endDate,
      v.status,
      v.availability,
      v.selfResponse,
      v.conferenceUrl,
      v.extUpdatedAt,
      v.isOwnTimeblock,
      v.ownTimeblockId,
      row.fetchedAt,
      v.eventId,
      v.hasAttendees,
      v.recurring,
      v.isOwnEvent,
      v.hasMeetingLink,
    ],
  );
}

export interface SyncResult {
  ok: boolean;
  reason: "not_connected" | "no_access" | "error" | null;
  calendars: number;
  events: number;
  changedDates: string[];
}

/** 予定を取れていないことの知らせ（D-130。サイドバー下の1行）。null は知らせない */
export type CalendarProblem = "no_access" | "not_connected" | "sync_failing";

/** 未接続をいつから知らせるか（ヘルパ・デーモンの起動し直しの数秒〜30秒は知らせない） */
export const NOT_CONNECTED_GRACE_MS = 2 * 60_000;
/** 同期の失敗をいつから知らせるか（5分ごとの同期が3回ほど続けて失敗したら） */
export const SYNC_FAILING_GRACE_MS = 15 * 60_000;

/**
 * 予定を取れていないか（D-130）。
 * - no_access: ヘルパはつながっているが権限がフルアクセスでない（すぐ知らせる）
 * - not_connected: 一度つながったことがある（カレンダーの行がある）のに、2分以上つながっていない。カレンダーを使って
 *   いない人（ヘルパを入れていない）には知らせない
 * - sync_failing: つながっていて権限もあるが、同期の失敗が15分以上続いている
 */
export function calendarProblem(p: {
  now: number;
  connected: boolean;
  authorization: Authorization | null;
  everConnected: boolean;
  disconnectedSince: number | null;
  failingSince: number | null;
}): CalendarProblem | null {
  if (p.connected) {
    if (p.authorization !== null && p.authorization !== "fullAccess") return "no_access";
    if (p.failingSince !== null && p.now - p.failingSince >= SYNC_FAILING_GRACE_MS)
      return "sync_failing";
    return null;
  }
  if (
    p.everConnected &&
    p.disconnectedSince !== null &&
    p.now - p.disconnectedSince >= NOT_CONNECTED_GRACE_MS
  )
    return "not_connected";
  return null;
}

export interface CalendarSyncStatus {
  provider: "helper" | "fake";
  connected: boolean;
  authorization: Authorization | null;
  helperVersion: string | null;
  lastSyncedAt: number | null;
  lastError: string | null;
  window: { from: string; to: string };
  /** 予定を取れていないことの知らせ（D-130） */
  problem: CalendarProblem | null;
}

export interface CalendarSyncOptions {
  sqlite: Database;
  clock: Clock;
  settings: () => TurnlaneSettings;
  provider: CalendarProvider;
  logger: MetaOnlyLogger;
  publish: (type: "calendar" | "source" | "settings", data: Record<string, unknown>) => void;
  /** 予定が変わった（runner.schedule） */
  onChanged?: () => void;
  intervalMs?: number;
  debounceMs?: number;
}

interface EventRow {
  id: string;
  calendar_id: string;
  external_id: string;
  occurrence_start: number;
  start_at: number;
  end_at: number;
  all_day: number;
  start_date: string | null;
  end_date: string | null;
  sig: string;
}

export class CalendarSync {
  readonly #o: CalendarSyncOptions;
  /** calendar.id → EKCalendar の種類（祝日の自動判定で誕生日を除くため。DB には持たない） */
  readonly types = new Map<string, string>();
  /**
   * Calendar.app の新規イベントのデフォルトカレンダー（calendar.id）。無ければ null、ヘルパが古い（isDefault を返さない）・
   * まだ同期していなければ undefined（D-072）
   */
  defaultCalendar: string | null | undefined = undefined;
  #authorization: Authorization | null = null;
  #version: string | null = null;
  #lastSyncedAt: number | null = null;
  #lastError: string | null = null;
  /** つながっていない間の始まり（D-130。つながっていれば null） */
  #disconnectedSince: number | null = null;
  /** 権限のある同期が失敗し始めた時刻（成功したら null） */
  #failingSince: number | null = null;
  #running: Promise<SyncResult> | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #interval: ReturnType<typeof setInterval> | null = null;
  #unsubscribe: (() => void) | null = null;

  constructor(o: CalendarSyncOptions) {
    this.#o = o;
  }

  get provider(): CalendarProvider {
    return this.#o.provider;
  }

  start(): void {
    if (!this.#o.provider.connected()) this.#disconnectedSince = this.#o.clock.now();
    this.#unsubscribe = this.#o.provider.subscribe((e) => {
      switch (e.type) {
        case "connected":
          this.#disconnectedSince = null;
          this.#o.logger.info("calendar.helper_connected", {
            provider: meta(this.#o.provider.kind),
          });
          this.#o.publish("source", {});
          this.schedule(0);
          break;
        case "disconnected":
          this.#o.logger.info("calendar.helper_disconnected", {});
          this.#authorization = null;
          this.#disconnectedSince ??= this.#o.clock.now();
          this.#failingSince = null;
          this.#o.publish("source", {});
          break;
        case "storeChanged":
          this.schedule();
          break;
        case "authorizationChanged":
          this.#authorization = e.authorization;
          this.#o.logger.info("calendar.authorization_changed", {
            authorization: meta(e.authorization),
          });
          this.#o.publish("source", {});
          this.schedule(0);
          break;
      }
    });
    this.#interval = setInterval(() => this.schedule(0), this.#o.intervalMs ?? 5 * 60_000);
    if (this.#o.provider.connected()) this.schedule(0);
  }

  stop(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    if (this.#timer) clearTimeout(this.#timer);
    if (this.#interval) clearInterval(this.#interval);
    this.#timer = null;
    this.#interval = null;
  }

  /** 同期を予約する（束ねる）。既定は storeChanged 用の 2 秒 */
  schedule(delayMs = this.#o.debounceMs ?? 2000): void {
    if (this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.syncNow();
    }, delayMs);
  }

  /** 今すぐ同期する。実行中なら終わるのを待ってから、もう一度実行する（直列化） */
  async syncNow(): Promise<SyncResult> {
    while (this.#running) await this.#running.catch(() => {});
    this.#running = this.#sync();
    try {
      return await this.#running;
    } finally {
      this.#running = null;
    }
  }

  /**
   * 同期と直列に f を走らせる（Turnlane からの予定の書き込み。D-093）。取得の途中の結果で、書いたばかりの予定の行を
   * 「返らなかった予定」として消さないため
   */
  async exclusive<T>(f: () => Promise<T>): Promise<T> {
    while (this.#running) await this.#running.catch(() => {});
    const p = f();
    const marker: Promise<SyncResult> = p.then(
      () => ({ ok: true, reason: null, calendars: 0, events: 0, changedDates: [] }),
      () => ({ ok: false, reason: "error", calendars: 0, events: 0, changedDates: [] }),
    );
    this.#running = marker;
    try {
      return await p;
    } finally {
      if (this.#running === marker) this.#running = null;
    }
  }

  /** 進行中の同期が終わるまで待つ（テスト・停止時） */
  async whenIdle(): Promise<void> {
    while (this.#running || this.#timer) {
      if (this.#timer) {
        clearTimeout(this.#timer);
        this.#timer = null;
        await this.syncNow();
      } else await this.#running?.catch(() => {});
    }
  }

  status(): CalendarSyncStatus {
    const w = this.#window();
    return {
      provider: this.#o.provider.kind,
      connected: this.#o.provider.connected(),
      authorization: this.#o.provider.connected() ? this.#authorization : null,
      helperVersion: this.#o.provider.connected() ? this.#version : null,
      lastSyncedAt: this.#lastSyncedAt,
      lastError: this.#lastError,
      window: { from: w.fromDate, to: w.toDate },
      problem: calendarProblem({
        now: this.#o.clock.now(),
        connected: this.#o.provider.connected(),
        authorization: this.#authorization,
        everConnected:
          this.#o.sqlite.query<{ n: number }, []>("SELECT count(*) AS n FROM calendar").get()?.n !==
          0,
        disconnectedSince: this.#disconnectedSince,
        failingSince: this.#failingSince,
      }),
    };
  }

  #window() {
    const s = this.#o.settings();
    const today = toLocalDate(this.#o.clock.now(), s.tz, s.dayBoundary);
    const fromDate = addDays(today, -WINDOW_PAST_DAYS);
    const toDate = addDays(today, WINDOW_FUTURE_DAYS);
    return {
      fromDate,
      toDate,
      from: dayStartMs(fromDate, s.tz, s.dayBoundary),
      to: dayStartMs(addDays(toDate, 1), s.tz, s.dayBoundary),
    };
  }

  async #sync(): Promise<SyncResult> {
    const o = this.#o;
    const empty = (reason: SyncResult["reason"]): SyncResult => ({
      ok: false,
      reason,
      calendars: 0,
      events: 0,
      changedDates: [],
    });
    if (!o.provider.connected()) return empty("not_connected");
    try {
      const st = await o.provider.status();
      this.#authorization = st.authorization;
      this.#version = st.version;
      if (st.authorization !== "fullAccess") {
        this.#lastError = "no_access";
        return empty("no_access");
      }
      const cals = await o.provider.listCalendars();
      const settings = o.settings();
      const w = this.#window();
      // 1. カレンダーの一覧を反映する（新しいものは role = source）
      const rows = this.#upsertCalendars(cals);
      const typesBefore = JSON.stringify([...this.types.entries()].sort());
      this.types.clear();
      for (const c of cals) {
        const id = rows.get(c.id);
        if (id) this.types.set(id, c.type);
      }
      const typesChanged = typesBefore !== JSON.stringify([...this.types.entries()].sort());
      const known = cals.some((c) => c.isDefault !== undefined);
      const def = cals.find((c) => c.isDefault === true);
      const defaultBefore = this.defaultCalendar;
      this.defaultCalendar = known ? ((def && rows.get(def.id)) ?? null) : undefined;
      if (defaultBefore !== this.defaultCalendar) o.publish("settings", {});
      // 2. 取得するカレンダー
      const roleOf = new Map(
        o.sqlite
          .query<{ id: string; external_id: string; role: string; is_writable: number }, []>(
            "SELECT id, external_id, role, is_writable FROM calendar",
          )
          .all()
          .map((r) => [r.external_id, r]),
      );
      const manual = settings.holidayCalendars ? new Set(settings.holidayCalendars) : null;
      const fetchIds = cals
        .filter((c) => {
          const r = roleOf.get(c.id);
          if (!r) return false;
          if (r.role === "source") return true;
          if (manual) return manual.has(r.id);
          return isHolidayCandidate({ id: r.id, isWritable: c.allowsModify, type: c.type });
        })
        .map((c) => c.id);
      const events =
        fetchIds.length > 0
          ? await o.provider.fetchEvents({ calendarIds: fetchIds, from: w.from, to: w.to })
          : [];
      // 3. スナップショットで置き換える
      const changed = this.#replaceEvents(rows, new Set(fetchIds), events, w);
      this.#lastSyncedAt = o.clock.now();
      this.#lastError = null;
      this.#failingSince = null;
      if (typesChanged) {
        // 祝日の自動判定の結果（週ボードの稼働日）が変わりうるので、窓の全日付を知らせる
        for (let d = w.fromDate; d <= w.toDate; d = addDays(d, 1)) changed.add(d);
      }
      const dates = [...changed].sort();
      o.logger.info("calendar.synced", {
        calendars: cals.length,
        fetched_calendars: fetchIds.length,
        events: events.length,
        changed_dates: dates.length,
      });
      if (dates.length > 0) {
        o.publish("calendar", { dates });
        o.onChanged?.();
      }
      return {
        ok: true,
        reason: null,
        calendars: cals.length,
        events: events.length,
        changedDates: dates,
      };
    } catch (e) {
      this.#lastError = e instanceof Error ? e.message.slice(0, 80) : "error";
      if (o.provider.connected()) this.#failingSince ??= o.clock.now();
      o.logger.warn("calendar.sync_failed", errorFields(e, { includeMessage: true }));
      return empty(o.provider.connected() ? "error" : "not_connected");
    }
  }

  /** ヘルパのカレンダー ID → calendar.id */
  #upsertCalendars(
    cals: {
      id: string;
      title: string;
      sourceTitle?: string | null | undefined;
      colorHex?: string | null | undefined;
      allowsModify: boolean;
    }[],
  ): Map<string, string> {
    const db = this.#o.sqlite;
    const now = this.#o.clock.now();
    const out = new Map<string, string>();
    db.transaction(() => {
      const existing = new Map(
        db
          .query<{ id: string; external_id: string }, []>(
            "SELECT id, external_id FROM calendar WHERE provider = 'eventkit'",
          )
          .all()
          .map((r) => [r.external_id, r.id]),
      );
      for (const c of cals) {
        const id = existing.get(c.id);
        if (id) {
          db.run(
            "UPDATE calendar SET name = ?, account_name = ?, color = ?, is_writable = ?, updated_at = ? WHERE id = ?",
            [c.title, c.sourceTitle ?? null, c.colorHex ?? null, c.allowsModify ? 1 : 0, now, id],
          );
          out.set(c.id, id);
        } else {
          const nid = newId(this.#o.clock);
          db.run(
            `INSERT INTO calendar (id, provider, external_id, account_name, name, color, is_writable, role, created_at, updated_at)
             VALUES (?, 'eventkit', ?, ?, ?, ?, ?, 'source', ?, ?)`,
            [
              nid,
              c.id,
              c.sourceTitle ?? null,
              c.title,
              c.colorHex ?? null,
              c.allowsModify ? 1 : 0,
              now,
              now,
            ],
          );
          out.set(c.id, nid);
        }
      }
      // Mac から消えたカレンダー: 予定を消し、時間ブロックが参照していなければ行も消す
      const listed = new Set(cals.map((c) => c.id));
      for (const [ext, id] of existing) {
        if (listed.has(ext)) continue;
        db.run("DELETE FROM calendar_event WHERE calendar_id = ?", [id]);
        const used = db
          .query<{ n: number }, [string]>(
            "SELECT count(*) AS n FROM time_block WHERE writeback_calendar_id = ?",
          )
          .get(id);
        if ((used?.n ?? 0) === 0) db.run("DELETE FROM calendar WHERE id = ?", [id]);
      }
    })();
    return out;
  }

  #replaceEvents(
    rows: Map<string, string>,
    fetched: Set<string>,
    events: HelperEvent[],
    w: { from: number; to: number },
  ): Set<string> {
    const db = this.#o.sqlite;
    const now = this.#o.clock.now();
    const changed = new Set<string>();
    const fetchedRowIds = new Set([...fetched].map((x) => rows.get(x)).filter(Boolean) as string[]);
    const ownByEventId = new Map(
      db
        .query<{ id: string; external_event_id: string }, []>(
          "SELECT id, external_event_id FROM time_block WHERE external_event_id IS NOT NULL",
        )
        .all()
        .map((b) => [b.external_event_id, b.id]),
    );
    db.transaction(() => {
      const old = new Map(
        db
          .query<EventRow, []>(
            `SELECT id, calendar_id, external_id, occurrence_start, start_at, end_at, all_day, start_date, end_date,
                    ${SIG_SQL} AS sig
               FROM calendar_event`,
          )
          .all()
          .map((r) => [`${r.calendar_id}|${r.external_id}|${r.occurrence_start}`, r]),
      );
      const seen = new Set<string>();
      for (const e of events) {
        const calendarId = rows.get(e.calendarId);
        if (!calendarId || !fetched.has(e.calendarId)) continue;
        if (e.end <= w.from || e.start >= w.to) continue;
        const key = `${calendarId}|${e.externalId}|${e.occurrenceStart}`;
        if (seen.has(key)) continue;
        seen.add(key);
        // M3-3 で書いた時間ブロックの予定。目印（url）の後ろの ID。アカウントの同期で url が落ちても
        // 書いたときの eventIdentifier で見分ける（予定として二重に数えない。D-093 で書くのはやめた）
        const ownId = e.url?.startsWith(OWN_TIMEBLOCK_PREFIX)
          ? e.url.slice(OWN_TIMEBLOCK_PREFIX.length) || null
          : e.eventId
            ? (ownByEventId.get(e.eventId) ?? null)
            : null;
        const { v, sig } = eventColumns(e, ownId);
        const prev = old.get(key);
        if (prev && prev.sig === sig) continue;
        if (prev)
          this.addDates(changed, prev.start_at, prev.end_at, prev.start_date, prev.end_date);
        this.addDates(changed, e.start, e.end, v.startDate, v.endDate);
        upsertEventRow(db, { id: newId(this.#o.clock), calendarId, fetchedAt: now }, e, ownId);
      }
      // 返らなかった予定（窓の外・消えた・同期しないカレンダー）を消す
      for (const [key, r] of old) {
        if (seen.has(key)) continue;
        db.run("DELETE FROM calendar_event WHERE id = ?", [r.id]);
        this.addDates(changed, r.start_at, r.end_at, r.start_date, r.end_date);
      }
      for (const id of fetchedRowIds) {
        db.run("UPDATE calendar SET last_synced_at = ? WHERE id = ?", [now, id]);
      }
    })();
    return changed;
  }

  /** 予定が掛かる論理日付（終日は start_date〜end_date の前日、時刻付きは開始〜終了の直前） */
  addDates(
    out: Set<string>,
    start: number,
    end: number,
    startDate: string | null,
    endDate: string | null,
  ): void {
    const s = this.#o.settings();
    let from: string;
    let to: string;
    if (startDate && endDate) {
      from = startDate;
      to = addDays(endDate, -1);
    } else {
      from = toLocalDate(start, s.tz, s.dayBoundary);
      to = toLocalDate(Math.max(start, end - 1), s.tz, s.dayBoundary);
    }
    // 長い予定でも窓の日数ぶんまで
    for (let d = from, i = 0; d <= to && i < WINDOW_PAST_DAYS + WINDOW_FUTURE_DAYS + 2; i++) {
      out.add(d);
      d = addDays(d, 1);
    }
  }
}
