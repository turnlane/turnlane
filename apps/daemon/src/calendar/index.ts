/**
 * カレンダー（M3 の段階 A）と CLI から変える設定の組み立て。HTTP（calendar-routes.ts）と週ボードが使う。
 * 予定の作成・編集（D-093。Calendar.app のデフォルトカレンダーへ）と、M3-3 で書いた時間ブロックの予定の削除は events.ts。
 */
import type { Database } from "bun:sqlite";
import type { MetaOnlyLogger } from "@turnlane/collectors";
import {
  addDays,
  type CalendarColorKey,
  type Clock,
  configKeys,
  derive,
  type ExtraConfigSchemas,
  getSetting,
  isCalendarColorKey,
  isKnownConfigKey,
  isWorkday,
  type MutateCtx,
  nextWorkday,
  putSetting,
  readSettings,
  toLocalDate,
  validateConfig,
  type WorkdayRule,
} from "@turnlane/core";
import type { CalendarEventDetail } from "@turnlane/core/api";
import { OpError } from "../derive/ops.ts";
import type { SseHub } from "../http/sse.ts";
import { OSA_TIMEOUT_MS } from "../open/index.ts";
import { type OpenSystem, systemOpen } from "../open/system.ts";
import {
  CalendarEvents,
  type EventExpect,
  type EventPatch,
  type EventsStatus,
  readOnlyReason,
  type TimeblockEventsSummary,
} from "./events.ts";
import type { CalendarProvider } from "./provider.ts";
import { CalendarSync, type CalendarSyncStatus, type SyncResult } from "./sync.ts";
import { holidayState, workdayRule } from "./workdays.ts";

/** 役割（writeback は D-093 で使わない。0007 で ignored にした。DB の CHECK には残る） */
export type CalendarRole = "source" | "writeback" | "ignored";

export interface CalendarView {
  id: string;
  name: string;
  account: string | null;
  /** カレンダーアプリの色（同期した値） */
  color: string | null;
  /** Turnlane の中で選んだ色（D-125。パレットのキー）。null ならカレンダーアプリの色 */
  colorKey: CalendarColorKey | null;
  writable: boolean;
  /** EKCalendar の種類（ヘルパから一覧を受け取るまでは null） */
  type: string | null;
  role: CalendarRole;
  /** Calendar.app の新規イベントのデフォルトカレンダー（ヘルパ 0.3.0 から。D-072） */
  isDefault: boolean;
  /** 祝日カレンダーとして使っている */
  holiday: boolean;
  events: number;
  lastSyncedAt: number | null;
}

export interface CalendarStatusView extends CalendarSyncStatus {
  calendars: { total: number; source: number; ignored: number };
  holidays: {
    mode: "auto" | "manual" | "none";
    calendars: { id: string; name: string }[];
    /** 今日以降の祝日（窓の中） */
    upcoming: { date: string; name: string | null }[];
  };
  workdays: { weekdays: number[]; today: string; isWorkday: boolean; nextWorkday: string | null };
  /** 予定の書き先（Calendar.app のデフォルトカレンダー。D-093） */
  events: EventsStatus;
}

export interface CalendarDeps {
  status(): CalendarStatusView;
  calendars(): CalendarView[];
  setRole(id: string, role: "source" | "ignored"): CalendarView;
  /** Turnlane の中だけの色を選ぶ・戻す（D-125。null でカレンダーアプリの色に戻す。カレンダー側は書き換えない） */
  setColor(id: string, key: CalendarColorKey | null): CalendarView;
  /** 予定の詳細（D-070。編集できるかと理由。D-093） */
  event(id: string): CalendarEventDetail;
  /**
   * 予定を作る（Calendar.app のデフォルトカレンダー。D-093。calendarId（calendar.id）があればそのカレンダー）。
   * カレンダーがまだ同期されていなければ null
   */
  createEvent(p: {
    title: string;
    start: number;
    end: number;
    calendarId?: string;
  }): Promise<CalendarEventDetail | null>;
  /** 予定を変える（題名・開始・終了・カレンダー。編集できる予定だけ） */
  updateEvent(id: string, patch: EventPatch, ifMatch?: EventExpect): Promise<CalendarEventDetail>;
  /** 予定を消す（編集できる予定だけ） */
  deleteEvent(id: string): Promise<void>;
  /** M3-3 で書いた時間ブロックの予定の件数と期間（D-093） */
  timeblockEvents(): Promise<TimeblockEventsSummary>;
  /** その予定を消す（数え直した件数が expected と違えば 409 changed） */
  cleanupTimeblockEvents(expected: number): Promise<{ deleted: number; failed: number }>;
  /** 予定を Calendar.app で開く（その予定を出せなければ Calendar.app を開くだけ。D-070） */
  openEvent(id: string): Promise<{ outcome: "shown" | "opened" | "failed" }>;
  sync(): Promise<SyncResult>;
  workdayRule(): WorkdayRule;
  /** 稼働日の規則と祝日名（持ち越しの理由に使う） */
  workdays(): { rule: WorkdayRule; names: ReadonlyMap<string, string | null> };
  config: {
    list(): Record<string, unknown>;
    get(key: string): unknown;
    set(key: string, value: unknown): unknown;
  };
}

export interface CalendarSystem {
  deps: CalendarDeps;
  service: CalendarSync;
  events: CalendarEvents;
  start(): void;
  stop(): void;
}

/** Calendar.app で予定を出す（引数: カレンダー名、予定の UID = calendarItemExternalIdentifier） */
export const SHOW_EVENT = `on run argv
  tell application "Calendar"
    set evs to (every event of calendar (item 1 of argv) whose uid is (item 2 of argv))
    if (count of evs) is 0 then error "no event" number 1
    show item 1 of evs
    activate
  end tell
end run`;

export function createCalendar(o: {
  sqlite: Database;
  mutate: MutateCtx;
  clock: Clock;
  hub: SseHub;
  logger: MetaOnlyLogger;
  provider: CalendarProvider;
  /** 予定・稼働日・設定が変わった（runner.schedule） */
  onChanged?: () => void;
  /** 拡張の設定のキー（ADR 0015。`ext.<id>.*`）。turnlane config と /api/config で本体のキーと同じに扱う */
  extConfig?: ExtraConfigSchemas;
  /** Calendar.app を開く（テストは偽物） */
  openSystem?: OpenSystem;
  /** 利用者のホーム（壁打ちのフォルダの `~/` を展開する。D-135） */
  home?: string;
}): CalendarSystem {
  const sys = o.openSystem ?? systemOpen;
  const settings = () => readSettings(o.mutate.db);
  const service = new CalendarSync({
    sqlite: o.sqlite,
    clock: o.clock,
    settings,
    provider: o.provider,
    logger: o.logger,
    publish: (type, data) => o.hub.publish(type, data),
    ...(o.onChanged ? { onChanged: o.onChanged } : {}),
  });
  const events = new CalendarEvents({
    sqlite: o.sqlite,
    clock: o.clock,
    settings,
    provider: o.provider,
    service,
    logger: o.logger,
    publish: (dates) => {
      if (dates.length > 0) o.hub.publish("calendar", { dates });
      o.onChanged?.();
    },
  });
  const windowDates = () => {
    const w = service.status().window;
    const out: string[] = [];
    for (let d = w.from; d <= w.to; d = addDays(d, 1)) out.push(d);
    return out;
  };
  const rule = () => workdayRule(o.sqlite, settings(), service.types);

  /** Turnlane が書き戻した予定なら、その時間ブロックとタスク（M3-3。calendar_event.own_timeblock_id） */
  const ownTimeBlockOf = (eventId: string): CalendarEventDetail["ownTimeBlock"] => {
    const r = o.sqlite
      .query<{ block_id: string; task_id: string | null }, [string]>(
        `SELECT b.id AS block_id, b.task_id FROM calendar_event e JOIN time_block b ON b.id = e.own_timeblock_id
          WHERE e.id = ?`,
      )
      .get(eventId);
    return r ? { blockId: r.block_id, taskId: r.task_id } : null;
  };

  const calendars = (): CalendarView[] => {
    const hs = holidayState(o.sqlite, settings(), service.types);
    const holidayIds = new Set(hs.calendars.map((c) => c.id));
    return o.sqlite
      .query<
        {
          id: string;
          name: string;
          account_name: string | null;
          color: string | null;
          color_key: string | null;
          is_writable: number;
          role: CalendarRole;
          last_synced_at: number | null;
          n: number;
        },
        []
      >(
        `SELECT c.id, c.name, c.account_name, c.color, c.color_key, c.is_writable, c.role, c.last_synced_at,
                (SELECT count(*) FROM calendar_event e WHERE e.calendar_id = c.id) AS n
           FROM calendar c ORDER BY c.account_name, c.name, c.id`,
      )
      .all()
      .map((r) => ({
        id: r.id,
        name: r.name,
        account: r.account_name,
        color: r.color,
        colorKey: isCalendarColorKey(r.color_key) ? r.color_key : null,
        writable: r.is_writable === 1,
        type: service.types.get(r.id) ?? null,
        role: r.role,
        isDefault: r.id === service.defaultCalendar,
        holiday: holidayIds.has(r.id),
        events: r.n,
        lastSyncedAt: r.last_synced_at,
      }));
  };

  const deps: CalendarDeps = {
    status() {
      const s = settings();
      const st = service.status();
      const cals = calendars();
      const hs = holidayState(o.sqlite, s, service.types);
      const today = toLocalDate(o.clock.now(), s.tz, s.dayBoundary);
      const r: WorkdayRule = { weekdays: s.workdays, holidays: new Set(hs.dates.keys()) };
      return {
        ...st,
        calendars: {
          total: cals.length,
          source: cals.filter((c) => c.role === "source").length,
          ignored: cals.filter((c) => c.role !== "source").length,
        },
        holidays: {
          mode: hs.mode,
          calendars: hs.calendars,
          upcoming: [...hs.dates.entries()]
            .filter(([d]) => d >= today)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([date, name]) => ({ date, name })),
        },
        workdays: {
          weekdays: s.workdays,
          today,
          isWorkday: isWorkday(today, r),
          nextWorkday: nextWorkday(today, r),
        },
        events: events.status(),
      };
    },
    calendars,
    setRole(id, role) {
      const row = o.sqlite
        .query<{ id: string; role: string }, [string]>("SELECT id, role FROM calendar WHERE id = ?")
        .get(id);
      if (!row) throw new OpError(404, "calendar_not_found");
      if (row.role !== role) {
        o.sqlite.run("UPDATE calendar SET role = ?, updated_at = ? WHERE id = ?", [
          role,
          o.clock.now(),
          id,
        ]);
        // 週ボードの予定と busy の判定が変わる。取得するカレンダーも変わるので同期し直す
        o.hub.publish("calendar", { dates: windowDates(), calendars: true });
        o.onChanged?.();
        service.schedule(0);
      }
      const v = calendars().find((c) => c.id === id);
      if (!v) throw new OpError(404, "calendar_not_found");
      return v;
    },
    setColor(id, key) {
      const row = o.sqlite
        .query<{ color_key: string | null }, [string]>(
          "SELECT color_key FROM calendar WHERE id = ?",
        )
        .get(id);
      if (!row) throw new OpError(404, "calendar_not_found");
      if (row.color_key !== key) {
        o.sqlite.run("UPDATE calendar SET color_key = ?, updated_at = ? WHERE id = ?", [
          key,
          o.clock.now(),
          id,
        ]);
        // 見た目だけが変わる（予定・busy の判定は同じ）。開いている画面のボードと、カレンダーの一覧（設定・予定の
        // パネル・作成のポップオーバーの上端）を読み直させる（calendars: true）。同期はしない
        o.hub.publish("calendar", { dates: windowDates(), calendars: true });
        o.onChanged?.();
      }
      const v = calendars().find((c) => c.id === id);
      if (!v) throw new OpError(404, "calendar_not_found");
      return v;
    },
    event(id) {
      const e = o.sqlite
        .query<
          {
            id: string;
            title: string | null;
            location: string | null;
            start_at: number;
            end_at: number;
            tz: string | null;
            all_day: number;
            start_date: string | null;
            end_date: string | null;
            status: CalendarEventDetail["status"];
            availability: "busy" | "free" | "tentative" | "unavailable" | null;
            self_response: "accepted" | "declined" | "pending" | "tentative" | "unknown" | null;
            conference_url: string | null;
            is_own_timeblock: number;
            is_own_event: number;
            has_attendees: number | null;
            recurring: number | null;
            has_meeting_link: number | null;
            event_id: string | null;
            calendar_id: string;
            is_writable: number;
            name: string;
            account_name: string | null;
            color: string | null;
            color_key: string | null;
            role: CalendarRole;
          },
          [string]
        >(
          `SELECT e.id, e.title, e.location, e.start_at, e.end_at, e.tz, e.all_day, e.start_date, e.end_date,
                  e.status, e.availability, e.self_response, e.conference_url, e.is_own_timeblock,
                  e.is_own_event, e.has_attendees, e.recurring, e.has_meeting_link, e.event_id, e.calendar_id, c.is_writable,
                  c.name, c.account_name, c.color, c.color_key, c.role
             FROM calendar_event e JOIN calendar c ON c.id = e.calendar_id WHERE e.id = ?`,
        )
        .get(id);
      if (!e) throw new OpError(404, "not_found");
      return {
        id: e.id,
        title: e.title,
        start: e.start_at,
        end: e.end_at,
        allDay: e.all_day === 1,
        startDate: e.start_date,
        endDate: e.end_date,
        tz: e.tz,
        calendarName: e.name,
        calendarAccount: e.account_name,
        calendarColor: e.color,
        calendarColorKey: isCalendarColorKey(e.color_key) ? e.color_key : null,
        location: e.location,
        conferenceUrl: e.conference_url,
        busy: derive.isBusyEvent({
          startAt: e.start_at,
          endAt: e.end_at,
          status: e.status,
          availability: e.availability,
          selfResponse: e.self_response,
          isOwnTimeblock: e.is_own_timeblock === 1,
          calendarRole: e.role,
        }),
        status: e.status,
        hasMeetingLink: e.has_meeting_link === null ? null : e.has_meeting_link === 1,
        ownTimeBlock: ownTimeBlockOf(e.id),
        calendarId: e.calendar_id,
        ...(() => {
          const reason = readOnlyReason(e, events.helperOutdated());
          return { editable: reason === null, readOnlyReason: reason };
        })(),
        createdByTurnlane: e.is_own_event === 1,
      };
    },
    async createEvent(p) {
      const id = await events.create(p);
      return id ? deps.event(id) : null;
    },
    async updateEvent(id, patch, ifMatch) {
      await events.update(id, patch, ifMatch);
      return deps.event(id);
    },
    deleteEvent: (id) => events.remove(id),
    timeblockEvents: () => events.timeblockSummary(),
    cleanupTimeblockEvents: (expected) => events.cleanupTimeblocks(expected),
    async openEvent(id) {
      const e = o.sqlite
        .query<{ external_id: string; name: string }, [string]>(
          "SELECT e.external_id, c.name FROM calendar_event e JOIN calendar c ON c.id = e.calendar_id WHERE e.id = ?",
        )
        .get(id);
      if (!e) throw new OpError(404, "not_found");
      // その予定を前面に出す（Calendar.app の AppleScript。オートメーションの許可が要る）→ だめなら開くだけ
      const shown = await sys.run(["/usr/bin/osascript", "-e", SHOW_EVENT, e.name, e.external_id], {
        timeoutMs: OSA_TIMEOUT_MS,
      });
      if (shown) return { outcome: "shown" };
      const opened = await sys.run(["/usr/bin/open", "-a", "Calendar"]);
      return { outcome: opened ? "opened" : "failed" };
    },
    sync: () => service.syncNow(),
    workdayRule: rule,
    workdays() {
      const s = settings();
      const hs = holidayState(o.sqlite, s, service.types);
      return {
        rule: { weekdays: s.workdays, holidays: new Set(hs.dates.keys()) },
        names: hs.dates,
      };
    },
    config: {
      list() {
        const out: Record<string, unknown> = {};
        for (const k of configKeys(o.extConfig)) out[k] = getSetting(o.mutate.db, k) ?? null;
        return out;
      },
      get(key) {
        if (!isKnownConfigKey(key, o.extConfig)) throw new OpError(404, "unknown_key");
        return getSetting(o.mutate.db, key) ?? null;
      },
      set(key, value) {
        if (!isKnownConfigKey(key, o.extConfig)) throw new OpError(404, "unknown_key");
        // 壁打ちのフォルダ（D-135）は `~/scratch` の形でも受ける
        if (key === "ai.scratch_dirs" && o.home && Array.isArray(value)) {
          const home = o.home.replace(/\/+$/, "");
          value = value.map((x) =>
            typeof x === "string" && (x === "~" || x.startsWith("~/"))
              ? `${home}${x.slice(1)}`.replace(/\/+$/, "")
              : typeof x === "string"
                ? x.trim().replace(/(.)\/+$/, "$1")
                : x,
          );
        }
        const v = validateConfig(key, value, o.extConfig);
        if (!v.ok) throw new OpError(400, `invalid_value: ${v.error}`);
        putSetting(o.mutate, key, v.value);
        if (key.startsWith("workdays.")) {
          o.hub.publish("calendar", { dates: windowDates() });
          if (key === "workdays.holiday_calendars") service.schedule(0);
        } else if (key === "work_hours.planned") {
          // 計画の目安（D-062・D-106）: 空き時間が変わる
          o.hub.publish("plan_guide", { dates: windowDates() });
          o.hub.publish("settings", {});
        } else if (key === "presence.tail_min") {
          // 「使っていた」とみなす長さ（D-110 (2)）: 在席は読むときに T を足すので（D-139）、待ち区間を作り直せば数え直す
          o.hub.publish("settings", {});
          o.onChanged?.();
        } else if (key === "tz" || key === "day_boundary") {
          const s = settings();
          o.hub.publish("day_boundary", {
            today: toLocalDate(o.clock.now(), s.tz, s.dayBoundary),
            displayToday: toLocalDate(o.clock.now(), s.tz, 0),
          });
          o.onChanged?.();
        } else {
          o.hub.publish("settings", {});
          o.onChanged?.();
        }
        return v.value;
      },
    },
  };

  return {
    deps,
    service,
    events,
    start: () => service.start(),
    stop: () => service.stop(),
  };
}
