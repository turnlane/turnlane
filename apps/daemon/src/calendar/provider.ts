/**
 * カレンダーの提供元（M3-1・M3-2）。デーモンは EventKit に直接触れず、この IF だけを見る。
 * - HelperBridge（bridge.ts）: TurnlaneCalendarHelper.app が /internal/ek に WebSocket で接続してくる（phase0-plan 1.5）
 * - FakeCalendarProvider（下）: テストと `bun run dev:board` 用。ダミーの予定と祝日カレンダーを返す
 * 返す形はヘルパの JSON-RPC の結果（phase0-plan 1.5 の表）と同じ。検証は下の zod で行う。
 */
import { LEGACY_EVENT_URL_PREFIX, LEGACY_TIMEBLOCK_URL_PREFIX } from "@turnlane/core/legacy";
import { z } from "zod";

export type Authorization = "fullAccess" | "denied" | "notDetermined" | "writeOnly";

const nullableEnum = <T extends readonly [string, ...string[]]>(xs: T) =>
  z.enum(xs).nullable().optional().catch(null);

export const helperStatus = z.object({
  authorization: z.enum(["fullAccess", "denied", "notDetermined", "writeOnly"]).catch("denied"),
  version: z.string().catch(""),
});

export const helperCalendar = z.object({
  id: z.string().min(1),
  title: z.string().catch(""),
  sourceTitle: z.string().nullable().optional().catch(null),
  sourceType: z.string().nullable().optional().catch(null),
  colorHex: z.string().nullable().optional().catch(null),
  allowsModify: z.boolean().catch(false),
  type: z.string().catch("unknown"),
  /** Calendar.app の新規イベントのデフォルトカレンダー（defaultCalendarForNewEvents）。ヘルパ 0.3.0 から（D-072） */
  isDefault: z.boolean().optional().catch(false),
});

const localDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .nullable()
  .optional()
  .catch(null);

export const helperEvent = z.object({
  /** ヘルパが付ける（phase0-plan 1.5 の表には無いが、どのカレンダーの予定かを知るために要る） */
  calendarId: z.string().min(1),
  externalId: z.string().min(1),
  eventId: z.string().nullable().optional().catch(null),
  occurrenceStart: z.number(),
  title: z.string().nullable().optional().catch(null),
  location: z.string().nullable().optional().catch(null),
  start: z.number(),
  end: z.number(),
  tz: z.string().nullable().optional().catch(null),
  allDay: z.boolean().catch(false),
  /** 終日予定の日付（終わりを含まない）。ヘルパが Mac のカレンダーの日付で付ける */
  startDate: localDate,
  endDate: localDate,
  status: nullableEnum(["confirmed", "tentative", "cancelled"] as const),
  availability: nullableEnum(["busy", "free", "tentative", "unavailable"] as const),
  selfResponse: nullableEnum(["accepted", "declined", "tentative", "pending", "unknown"] as const),
  url: z.string().nullable().optional().catch(null),
  conferenceUrl: z.string().nullable().optional().catch(null),
  lastModified: z.number().nullable().optional().catch(null),
  /** 参加者がいる（attendees が空でない）。ヘルパ 0.4.0 から。返らなければ null = 分からない（編集しない。D-093） */
  hasAttendees: z.boolean().nullable().optional().catch(null),
  /** 繰り返しの予定（hasRecurrenceRules）。ヘルパ 0.4.0 から */
  recurring: z.boolean().nullable().optional().catch(null),
  /** 予定の URL・場所・メモに会議サービスの URL がある（メモの本文は返らない）。ヘルパ 0.5.0 から（D-097） */
  hasMeetingLink: z.boolean().nullable().optional().catch(null),
});

/** listTimeblockEvents の1件（M3-3 で書いた時間ブロックの予定。D-093） */
export const helperTimeblockEvent = z.object({
  eventId: z.string().min(1),
  calendarId: z.string().catch(""),
  start: z.number(),
  end: z.number(),
});

export type HelperStatus = z.infer<typeof helperStatus>;
export type HelperTimeblockEvent = z.infer<typeof helperTimeblockEvent>;

/** Turnlane が作る予定の目印（ADR 0012、D-093）。新しく作る予定に付ける */
export const OWN_EVENT_PREFIX = "turnlane://event/";
/** 名前を変える前（ADR 0016）に作った予定の目印。カレンダーに残っているので読み続ける（書かない） */
export const LEGACY_OWN_EVENT_PREFIX = LEGACY_EVENT_URL_PREFIX;
/**
 * M3-3 で書いた時間ブロックの予定の目印（D-093 で書くのをやめた。削除の対象の判定と、読み取りでの除外）。
 * 書いたのは名前を変える前の版だけなので、目印は旧名のまま（ADR 0016）
 */
export const TIMEBLOCK_EVENT_PREFIX = LEGACY_TIMEBLOCK_URL_PREFIX;

/** Turnlane（旧名を含む）が作った予定か */
export function isOwnEventUrl(url: string | null | undefined): boolean {
  return (
    typeof url === "string" &&
    (url.startsWith(OWN_EVENT_PREFIX) || url.startsWith(LEGACY_OWN_EVENT_PREFIX))
  );
}

/** createEvent の引数（phase0-plan 1.5。start / end は epoch ms。calendarId を省くと Calendar.app のデフォルト。ヘルパ 0.4.0） */
export interface CreateEventParams {
  calendarId?: string;
  title: string;
  start: number;
  end: number;
  tz: string;
  url: string;
}

/** updateEvent の引数（省いた項目は変えない。calendarId はヘルパのカレンダー ID。ヘルパ 0.4.0） */
export interface UpdateEventParams {
  eventId: string;
  title?: string;
  start?: number;
  end?: number;
  calendarId?: string;
}
export type HelperCalendar = z.infer<typeof helperCalendar>;
export type HelperEvent = z.infer<typeof helperEvent>;

/** 予定の性質（編集できるかの判定。ヘルパの editBlock と同じ条件。ADR 0012 の Decision 3） */
export interface EventTraits {
  calendarWritable: boolean;
  hasAttendees: boolean | null | undefined;
  recurring: boolean | null | undefined;
  allDay: boolean;
  url: string | null | undefined;
}

/** Turnlane から編集できない理由（編集できれば null）。ヘルパの editBlock と同じ */
export function editBlock(t: EventTraits): string | null {
  if (t.url?.startsWith(TIMEBLOCK_EVENT_PREFIX)) return "timeblock";
  if (!t.calendarWritable) return "not_writable";
  if (t.hasAttendees !== false) return "has_attendees";
  if (t.recurring === true) return "recurring";
  if (t.allDay) return "all_day";
  return null;
}

export type ProviderEvent =
  | { type: "connected" }
  | { type: "disconnected" }
  | { type: "storeChanged" }
  | { type: "authorizationChanged"; authorization: Authorization };

export interface CalendarProvider {
  readonly kind: "helper" | "fake";
  /** ヘルパが接続しているか（fake は常に true にできる） */
  connected(): boolean;
  status(): Promise<HelperStatus>;
  listCalendars(): Promise<HelperCalendar[]>;
  /** from / to は epoch ms（to は含まない） */
  fetchEvents(p: { calendarIds: string[]; from: number; to: number }): Promise<HelperEvent[]>;
  subscribe(l: (e: ProviderEvent) => void): () => void;
  /** 予定の作成・更新・削除（D-093。ヘルパ 0.4.0）。古いヘルパは method not found（HelperRpcError -32601）で失敗する */
  createEvent(p: CreateEventParams): Promise<HelperEvent>;
  updateEvent(p: UpdateEventParams): Promise<HelperEvent>;
  removeEvent(p: { eventId: string }): Promise<{ deleted: boolean }>;
  /** M3-3 で書いた時間ブロックの予定（url が dayline://timeblock/）の一覧と削除（D-093。ヘルパ 0.4.0） */
  listTimeblockEvents(p: { from: number; to: number }): Promise<HelperTimeblockEvent[]>;
  deleteTimeblockEvent(p: { eventId: string }): Promise<{ deleted: boolean }>;
}

/** 購読の共通部分 */
export class Emitter {
  readonly #ls = new Set<(e: ProviderEvent) => void>();
  subscribe(l: (e: ProviderEvent) => void): () => void {
    this.#ls.add(l);
    return () => this.#ls.delete(l);
  }
  emit(e: ProviderEvent): void {
    for (const l of [...this.#ls]) l(e);
  }
}

/**
 * テスト・dev:board 用の提供元。カレンダーと予定をメモリに持ち、窓で絞って返す。
 * 予定を変えたら storeChanged() で通知する（ヘルパの EKEventStoreChanged と同じ）。
 */
export class FakeCalendarProvider implements CalendarProvider {
  readonly kind = "fake" as const;
  readonly #em = new Emitter();
  calendars: HelperCalendar[];
  events: HelperEvent[];
  authorization: Authorization;
  #connected: boolean;
  /** 呼ばれた fetchEvents の引数（テスト用） */
  readonly fetches: { calendarIds: string[]; from: number; to: number }[] = [];

  constructor(
    o: {
      calendars?: HelperCalendar[];
      events?: HelperEvent[];
      authorization?: Authorization;
      connected?: boolean;
    } = {},
  ) {
    this.calendars = o.calendars ?? [];
    this.events = o.events ?? [];
    this.authorization = o.authorization ?? "fullAccess";
    this.#connected = o.connected ?? true;
  }

  connected(): boolean {
    return this.#connected;
  }

  setConnected(v: boolean): void {
    if (v === this.#connected) return;
    this.#connected = v;
    this.#em.emit({ type: v ? "connected" : "disconnected" });
  }

  storeChanged(): void {
    this.#em.emit({ type: "storeChanged" });
  }

  setAuthorization(a: Authorization): void {
    this.authorization = a;
    this.#em.emit({ type: "authorizationChanged", authorization: a });
  }

  async status(): Promise<HelperStatus> {
    this.#require(false);
    return { authorization: this.authorization, version: this.version };
  }

  async listCalendars(): Promise<HelperCalendar[]> {
    this.#require(true);
    return this.calendars.map((c) => ({ ...c, isDefault: c.id === this.defaultCalendarId }));
  }

  async fetchEvents(p: { calendarIds: string[]; from: number; to: number }) {
    this.#require(true);
    this.fetches.push({ ...p, calendarIds: [...p.calendarIds].sort() });
    const ids = new Set(p.calendarIds);
    return this.events
      .filter((e) => ids.has(e.calendarId) && e.end > p.from && e.start < p.to)
      .map((e) => ({ ...e }));
  }

  subscribe(l: (e: ProviderEvent) => void): () => void {
    return this.#em.subscribe(l);
  }

  /** 書き込みの呼び出し（テスト用） */
  readonly writes: { method: string; params: unknown }[] = [];
  /** Calendar.app のデフォルトカレンダー（ヘルパの ID。null は無し。D-072） */
  defaultCalendarId: string | null = null;
  /** status() の版（テスト用。既定は "fake" で、版の比較では最新扱い） */
  version = "fake";
  /**
   * カレンダーを移すと予定の ID（eventId・externalId）が変わる（テスト用。EventKit でアカウントをまたいで移すと
   * 識別子が変わることがある。ヘルパは保存の後の識別子を返すので、デーモンはそれに追従する）
   */
  reidentifyOnMove = false;
  /** 失敗させる書き込み（テスト用。投げる例外を返す） */
  failWrite: ((method: string) => Error | null) | null = null;
  #seq = 0;

  #calendar(id: string | null | undefined): HelperCalendar {
    if (!id) throw new Error("no_default_calendar");
    const cal = this.calendars.find((c) => c.id === id);
    if (!cal) throw new Error("calendar_not_found");
    if (!cal.allowsModify) throw new Error("not_writable");
    return cal;
  }

  #traits(e: HelperEvent): EventTraits {
    return {
      calendarWritable: this.calendars.find((c) => c.id === e.calendarId)?.allowsModify === true,
      hasAttendees: e.hasAttendees,
      recurring: e.recurring,
      allDay: e.allDay,
      url: e.url,
    };
  }

  #write(method: string, params: unknown): void {
    this.#require(true);
    this.writes.push({ method, params: { ...(params as object) } });
    const err = this.failWrite?.(method);
    if (err) throw err;
  }

  /** ヘルパ 0.4.0 と同じ: 指定が無ければデフォルトカレンダーへ作る（D-072・D-093）。EKEventStoreChanged と同じく通知する */
  async createEvent(p: CreateEventParams): Promise<HelperEvent> {
    this.#write("createEvent", p);
    const cal = this.#calendar(p.calendarId ?? this.defaultCalendarId);
    const n = ++this.#seq;
    const ev: HelperEvent = {
      calendarId: cal.id,
      externalId: `fake-uid-${n}`,
      eventId: `fake-ev-${n}`,
      occurrenceStart: p.start,
      title: p.title,
      location: null,
      start: p.start,
      end: p.end,
      tz: p.tz,
      allDay: false,
      startDate: null,
      endDate: null,
      status: "confirmed",
      availability: "busy",
      selfResponse: null,
      url: p.url,
      conferenceUrl: null,
      lastModified: Date.now(),
      hasAttendees: false,
      recurring: false,
      hasMeetingLink: false,
    };
    this.events = [...this.events, ev];
    this.storeChanged();
    return { ...ev };
  }

  /** ヘルパ 0.4.0 と同じ: 編集できる予定（editBlock）だけを更新する */
  async updateEvent(p: UpdateEventParams): Promise<HelperEvent> {
    this.#write("updateEvent", p);
    const found = this.events.find((e) => e.eventId === p.eventId);
    if (!found) throw new Error("not_found");
    if (editBlock(this.#traits(found))) throw new Error("not_editable");
    const calendarId =
      p.calendarId && p.calendarId !== found.calendarId
        ? this.#calendar(p.calendarId).id
        : found.calendarId;
    const start = p.start ?? found.start;
    const end = p.end ?? found.end;
    if (end <= start) throw new Error("invalid_range");
    const moved = calendarId !== found.calendarId;
    const n = moved && this.reidentifyOnMove ? ++this.#seq : null;
    const ev: HelperEvent = {
      ...found,
      ...(n !== null ? { eventId: `fake-ev-${n}`, externalId: `fake-uid-${n}` } : {}),
      calendarId,
      title: p.title ?? found.title ?? null,
      start,
      end,
      occurrenceStart: start,
      lastModified: Date.now(),
    };
    this.events = this.events.map((e) => (e.eventId === p.eventId ? ev : e));
    this.storeChanged();
    return { ...ev };
  }

  async removeEvent(p: { eventId: string }): Promise<{ deleted: boolean }> {
    this.#write("removeEvent", p);
    const found = this.events.find((e) => e.eventId === p.eventId);
    if (!found) return { deleted: false };
    if (editBlock(this.#traits(found))) throw new Error("not_editable");
    this.events = this.events.filter((e) => e.eventId !== p.eventId);
    this.storeChanged();
    return { deleted: true };
  }

  /** ヘルパ 0.4.0 と同じ: url が dayline://timeblock/ で始まる予定だけ（全カレンダー） */
  async listTimeblockEvents(p: { from: number; to: number }): Promise<HelperTimeblockEvent[]> {
    this.#require(true);
    return this.events
      .filter(
        (e) =>
          e.eventId &&
          e.url?.startsWith(TIMEBLOCK_EVENT_PREFIX) &&
          e.end > p.from &&
          e.start < p.to,
      )
      .map((e) => ({
        eventId: e.eventId as string,
        calendarId: e.calendarId,
        start: e.start,
        end: e.end,
      }));
  }

  /** ヘルパ 0.4.0 と同じ: url が dayline://timeblock/ で始まる予定だけを消す */
  async deleteTimeblockEvent(p: { eventId: string }): Promise<{ deleted: boolean }> {
    this.#write("deleteTimeblockEvent", p);
    const found = this.events.find((e) => e.eventId === p.eventId);
    if (!found) return { deleted: false };
    if (!found.url?.startsWith(TIMEBLOCK_EVENT_PREFIX)) throw new Error("not_timeblock_event");
    this.events = this.events.filter((e) => e.eventId !== p.eventId);
    this.storeChanged();
    return { deleted: true };
  }

  #require(access: boolean): void {
    if (!this.#connected) throw new Error("helper_not_connected");
    if (access && this.authorization !== "fullAccess") throw new Error("no_full_access");
  }
}
