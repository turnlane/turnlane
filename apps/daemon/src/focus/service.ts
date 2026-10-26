/**
 * 会議前に聞く集中モード（D-097。m2-api 25章、ux-mvp 4.15）の状態と時刻の進行。判定は core の focus/plan.ts。
 * - 30秒ごとと、予定・設定の変化（SSE calendar / settings）の後に tick: 問いを開く・閉じる、開始の時刻の自動の集中、
 *   終わりの時刻で集中を終える
 * - 開いた問いは、デスクトップアプリがつながっていて通知が許可されていれば SSE notify（ボタン付き）で出す。
 *   それ以外は web が画面上部の帯で出す（FocusView.channel = band）
 * - 集中中に止めた通知（NotifyRunner の hold）と、終わった時点でまとめ待ちだった your_turn を合わせ、今も残っている分を
 *   まとめて1回通知する。残っていなくても「集中モードを終了しました」を1回出す（設定 focus.notify_end でオフにできる）
 * - 答えないまま開始の時刻を過ぎた問いは、予定が続く間「閉じた問い」として覚え、遅れて届いた答え（通知のボタン）を受ける。
 *   届いた答えと結果（答えた・遅れて答えた・stale）はログに残す
 * - 「この予定の間は集中する」の予約（D-130。reserve / cancel）。予定の開始で始まり終わりで終わる
 * - 状態は setting の focus.state（local_only）に置き、再起動しても続ける（予約も同じ値に入る。マイグレーションは要らない）
 * 予定の題名はログに出さない。
 */
import type { Database } from "bun:sqlite";
import { errorFields, type MetaOnlyLogger, meta } from "@turnlane/collectors";
import {
  addDays,
  type Clock,
  dayStartMs,
  derive,
  getSetting,
  type MutateCtx,
  putSetting,
  type TurnlaneSettings,
  toLocalDate,
} from "@turnlane/core";
import type { FocusStartInput, FocusSummaryExtras, FocusView, QueueItem } from "@turnlane/core/api";
import {
  addHeld,
  answerPrompt,
  cancelReservation,
  endFocus,
  FOCUS_MENU,
  type FocusEventFact,
  type FocusSettings,
  type FocusState,
  type FocusStep,
  focusLabel,
  focusSummary,
  initialFocusState,
  type Locale,
  NATIVE_MENU,
  type NotifyContent,
  nextEventEnd,
  promptMessage,
  promptText,
  reserveEvent,
  startManual,
  stepFocus,
} from "@turnlane/core/web";
import { OpError } from "../derive/ops.ts";

export const FOCUS_STATE_KEY = "focus.state";
const HOUR = 3_600_000;

export interface FocusDeps {
  sqlite: Database;
  mutate: MutateCtx;
  clock: Clock;
  settings: () => TurnlaneSettings;
  prefs: () => FocusSettings;
  locale: () => Locale;
  /** 通知に出す中身（設定 notify.content。まとめの本文の行。省略は件名） */
  content?: () => NotifyContent;
  /** 自分の番（まとめの通知で今も残っているカードを数える） */
  queue: () => QueueItem[];
  /**
   * NotifyRunner のまとめ待ち（15分のまとめを待つ your_turn のカード）を取り出して空にする。集中の終わりのまとめに
   * 含め、通常のまとめから外す（集中が15分より短いと止めた分に入らないため。m2-api 25章）。無ければ渡さない
   */
  takePending?: () => string[];
  /** デスクトップアプリがつながっていて通知が許可されている（問いを通知のボタンで出す） */
  desktopChannel: () => boolean;
  publish: (type: "focus" | "notify", data: Record<string, unknown>) => void;
  logger: MetaOnlyLogger;
}

function validState(v: unknown): v is FocusState {
  const s = v as FocusState | null;
  return (
    !!s &&
    typeof s === "object" &&
    Array.isArray(s.asked) &&
    Array.isArray(s.held) &&
    (s.active === null || typeof s.active?.until === "number") &&
    (s.prompt === null || typeof s.prompt?.key === "string") &&
    (s.closed === undefined || s.closed === null || typeof s.closed?.key === "string") &&
    (s.reserved === undefined || Array.isArray(s.reserved))
  );
}

export class FocusService {
  #state: FocusState;

  constructor(private readonly d: FocusDeps) {
    let saved: unknown;
    try {
      saved = getSetting<unknown>(d.mutate.db, FOCUS_STATE_KEY);
    } catch {}
    // 予約（D-130）の前に保存した値には reserved が、閉じた問いの前に保存した値には closed が無い
    this.#state = validState(saved)
      ? { ...saved, reserved: saved.reserved ?? [], closed: saved.closed ?? null }
      : initialFocusState();
  }

  get state(): FocusState {
    return this.#state;
  }

  /** 予定（今の前後と、予約した予定。busy の判定は空き時間・放置と同じ） */
  #events(now: number, extraIds: readonly string[] = this.#state.reserved.map((r) => r.eventId)) {
    const ids = [...new Set(extraIds)];
    const inIds = ids.length > 0 ? ` OR e.id IN (${ids.map(() => "?").join(",")})` : "";
    return this.d.sqlite
      .query<
        {
          id: string;
          title: string | null;
          start: number;
          end: number;
          all_day: number;
          status: derive.CalendarEventFact["status"];
          availability: derive.CalendarEventFact["availability"];
          self_response: derive.CalendarEventFact["selfResponse"];
          is_own_timeblock: number;
          role: derive.CalendarEventFact["calendarRole"];
          has_attendees: number | null;
          has_meeting_link: number | null;
        },
        (number | string)[]
      >(
        `SELECT e.id, e.title, e.start_at AS start, e.end_at AS end, e.all_day, e.status, e.availability,
                e.self_response, e.is_own_timeblock, c.role, e.has_attendees, e.has_meeting_link
           FROM calendar_event e JOIN calendar c ON c.id = e.calendar_id
          WHERE (e.end_at > ? AND e.start_at < ?)${inIds}`,
      )
      .all(now - 24 * HOUR, now + 36 * HOUR, ...ids)
      .map(
        (r): FocusEventFact => ({
          id: r.id,
          title: r.title,
          start: r.start,
          end: r.end,
          allDay: r.all_day === 1,
          busy: derive.isBusyEvent({
            startAt: r.start,
            endAt: r.end,
            status: r.status,
            availability: r.availability,
            selfResponse: r.self_response,
            isOwnTimeblock: r.is_own_timeblock === 1,
            calendarRole: r.role,
          }),
          hasAttendees: r.has_attendees === null ? null : r.has_attendees === 1,
          hasMeetingLink: r.has_meeting_link === null ? null : r.has_meeting_link === 1,
        }),
      );
  }

  /** 状態を置き換え、変わっていれば保存して SSE focus を送る */
  #commit(next: FocusState, opened: FocusState["prompt"] = null): void {
    const prev = this.#state;
    this.#state = next;
    const same = JSON.stringify(prev) === JSON.stringify(next);
    if (same) return;
    try {
      putSetting(this.d.mutate, FOCUS_STATE_KEY, next);
    } catch (e) {
      this.d.logger.warn("focus.save_failed", errorFields(e));
    }
    if (
      JSON.stringify(prev.active) !== JSON.stringify(next.active) ||
      JSON.stringify(prev.prompt) !== JSON.stringify(next.prompt) ||
      JSON.stringify(prev.closed) !== JSON.stringify(next.closed) ||
      JSON.stringify(prev.reserved) !== JSON.stringify(next.reserved)
    ) {
      // late: 閉じた問いがまだ答えを受ける（アプリは問いの通知を残す）
      this.d.publish("focus", {
        active: next.active !== null,
        prompt: next.prompt !== null,
        late: next.closed !== null,
      });
    }
    if (opened && this.d.desktopChannel()) {
      const s = this.d.settings();
      this.d.publish("notify", { notices: [promptMessage(opened, s.tz, this.d.locale())] });
    }
  }

  /** 集中が終わった: 止めた分のうち今も残っているものをまとめて1回通知する（無ければ終わったことだけを知らせる） */
  #ended(ended: FocusStep["ended"]): void {
    if (!ended) return;
    this.d.logger.info("focus.ended", {
      source: meta(ended.active.source),
      held: ended.held.length,
    });
    let q: QueueItem[] = [];
    try {
      q = this.d.queue();
    } catch {
      return;
    }
    // まとめ待ちの your_turn も止めた分に加える（通常のまとめからは外れる）
    let pending: string[] = [];
    try {
      pending = this.d.takePending?.() ?? [];
    } catch {}
    const have = new Set(ended.held.map((h) => h.workItemId));
    const held = [
      ...ended.held,
      ...pending
        .filter((id) => !have.has(id))
        .map((workItemId) => ({ workItemId, status: "your_turn" as const })),
    ];
    let content: NotifyContent = "subject";
    try {
      content = this.d.content?.() ?? "subject";
    } catch {}
    const m = focusSummary({ ...ended, held }, q, {
      locale: this.d.locale(),
      now: this.d.clock.now(),
      tz: this.d.settings().tz,
      notifyEnd: this.d.prefs().notifyEnd,
      content,
    });
    if (m) this.d.publish("notify", { notices: [m] });
  }

  /** 1回進める（30秒ごと・予定と設定の変化の後。テストから直接呼ぶ） */
  tick(): FocusStep {
    const now = this.d.clock.now();
    const r = stepFocus(this.#state, {
      now,
      events: this.#events(now),
      settings: this.d.prefs(),
    });
    // channel: 問いの出し先（desktop = アプリの通知のボタン、band = 帯だけ）。通知のボタンが効かないときの切り分け
    if (r.opened)
      this.d.logger.info("focus.prompted", {
        lead_min: this.d.prefs().leadMin,
        channel: meta(this.d.desktopChannel() ? "desktop" : "band"),
      });
    this.#commit(r.state, r.opened);
    this.#ended(r.ended);
    return r;
  }

  /**
   * 問いへの答え（通知のボタン・帯）。開いている問いか、閉じたばかりでまだ続く予定の問い（遅れた答え。late）。
   * どちらでもなければ 409 stale。届いた答えと結果は必ずログに残す（通知のボタンが効かないときの切り分け）
   */
  answer(key: string, answer: "focus" | "skip"): FocusView {
    const r = answerPrompt(this.#state, key, answer, this.d.clock.now());
    if (!r) {
      this.d.logger.warn("focus.answer_stale", {
        answer: meta(answer),
        prompt_open: this.#state.prompt !== null,
        closed_open: this.#state.closed !== null,
      });
      throw new OpError(409, "stale");
    }
    this.d.logger.info("focus.answered", { answer: meta(answer), late: r.late });
    this.#commit(r.state);
    return this.view();
  }

  /** 集中の API が 4xx を返した（入力の不備・予定が無い など）。切り分けのためにログに残す */
  logRejected(path: string, status: number, error: string): void {
    this.d.logger.warn("focus.rejected", { path: meta(path), status, error: meta(error) });
  }

  /** 手動で始める（メニューバー・⌘K） */
  start(p: FocusStartInput): FocusView {
    const now = this.d.clock.now();
    let until: number;
    if ("minutes" in p) until = now + p.minutes * 60_000;
    else {
      const end = nextEventEnd(this.#events(now), now, this.#horizon(now));
      if (end === null) throw new OpError(409, "no_event");
      until = end;
    }
    this.d.logger.info("focus.started", { by: meta("minutes" in p ? "minutes" : "event_end") });
    this.#commit(startManual(this.#state, now, until));
    return this.view();
  }

  /**
   * 「この予定の間は集中する」（D-130。予定の詳細パネル・予定の右クリック）。404 not_found / 409 ended（終わった予定・
   * 終日の予定）
   */
  reserve(eventId: string): FocusView {
    const now = this.d.clock.now();
    const e = this.#events(now, [eventId]).find((x) => x.id === eventId);
    if (!e) throw new OpError(404, "not_found");
    const next = reserveEvent(this.#state, e, now);
    if (!next) throw new OpError(409, "ended");
    this.d.logger.info("focus.reserved", { running: now >= e.start });
    this.#commit(next);
    return this.view();
  }

  /** 予約を取り消す（その予定の集中の最中なら集中も終え、まとめの通知を出す） */
  cancel(eventId: string): FocusView {
    const r = cancelReservation(this.#state, eventId);
    this.#commit(r.state);
    this.#ended(r.ended);
    return this.view();
  }

  /** 終える（まとめの通知を出す） */
  end(): FocusView {
    const r = endFocus(this.#state);
    this.#commit(r.state);
    this.#ended(r.ended);
    return this.view();
  }

  /** 今日（論理日）の終わり（「次の予定の終わりまで」の探す範囲） */
  #horizon(now: number): number {
    const s = this.d.settings();
    return dayStartMs(addDays(toLocalDate(now, s.tz, s.dayBoundary), 1), s.tz, s.dayBoundary);
  }

  // ---- NotifyRunner から ----

  /** 今集中しているか（終わりの時刻を過ぎていれば false。終える処理は tick が行う） */
  active(now = this.d.clock.now()): boolean {
    const a = this.#state.active;
    return a !== null && now < a.until;
  }

  allowNeedsInput(): boolean {
    return this.d.prefs().allowNeedsInput;
  }

  /** 集中中に止めた通知を覚える */
  hold(held: FocusState["held"]): void {
    if (held.length === 0) return;
    this.#commit(addHeld(this.#state, held));
  }

  // ---- 表示 ----

  view(): FocusView {
    const now = this.d.clock.now();
    const s = this.d.settings();
    const locale = this.d.locale();
    const a = this.active(now) ? this.#state.active : null;
    const p = this.#state.prompt;
    return {
      active: a
        ? {
            since: a.since,
            until: a.until,
            source: a.source,
            title: a.title,
            label: focusLabel(a, s.tz, locale),
          }
        : null,
      prompt: p
        ? {
            key: p.key,
            title: p.title,
            start: p.start,
            end: p.end,
            label: promptText(p, s.tz, locale),
          }
        : null,
      channel: this.d.desktopChannel() ? "desktop" : "band",
      nextEventEnd: nextEventEnd(this.#events(now), now, this.#horizon(now)),
      reserved: this.#state.reserved
        .filter((r) => r.end > now)
        .map((r) => ({ eventId: r.eventId, start: r.start, end: r.end })),
    };
  }

  /** QueueResponse.focus（web のブラウザ通知の抑止） */
  queueFocus(): { until: number; allowNeedsInput: boolean } | null {
    const a = this.#state.active;
    return a && this.active() ? { until: a.until, allowNeedsInput: this.allowNeedsInput() } : null;
  }

  /** /api/queue/summary に足すもの（メニューバー） */
  summaryExtras(): FocusSummaryExtras {
    const now = this.d.clock.now();
    const s = this.d.settings();
    const locale = this.d.locale();
    const a = this.active(now) ? this.#state.active : null;
    return {
      focus: a ? { label: focusLabel(a, s.tz, locale) } : null,
      focusMenu: { ...FOCUS_MENU[locale] },
      nativeMenu: NATIVE_MENU[locale],
      focusEventAvailable: nextEventEnd(this.#events(now), now, this.#horizon(now)) !== null,
    };
  }
}
