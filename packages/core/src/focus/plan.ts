/**
 * 会議前に聞く集中モード（D-097。m2-api 25章、ux-mvp 4.15）の純粋な判定。デーモンの FocusService と NotifyRunner が使う。
 * - 対象の予定（isFocusTarget）、問いを開く・閉じる・期限で自動で集中する・集中を終える（stepFocus）
 * - 答え（answerPrompt。開始の時刻を過ぎて閉じた問いにも、予定が続く間は遅れて答えられる）、手動の開始・終了
 *   （startManual / endFocus）、「次の予定の終わり」（nextEventEnd）
 * - 予定の間の集中の予約（reserveEvent / cancelReservation。D-130）: 予定の開始で始まり終わりで終わる（予定の延長を追う）
 * - 集中中の通知の絞り込み（filterFocus）と、終わったときのまとめの通知（focusSummary）
 * - 表示の文言（focusLabel・promptMessage・FOCUS_MENU）。ロケールはデーモンで解決する
 * 時刻はすべて引数で受ける（偽の時計で表駆動テストする）。
 */
import type { QueueItem } from "../api/queue.ts";
import { fmtClock } from "../format.ts";
import type { Locale } from "../i18n/task-title.ts";
import {
  followUpSubject,
  type Notice,
  type NoticeMessage,
  type NotifyContent,
  noticeWhere,
  visibleQueue,
} from "../notify/plan.ts";

export type FocusTarget = "meetings" | "busy";
export type FocusSource = "meeting" | "manual";
export type HeldStatus = "needs_input" | "error" | "your_turn";

/** 判定に使う予定の事実（calendar_event から） */
export interface FocusEventFact {
  id: string;
  title: string | null;
  start: number;
  end: number;
  allDay: boolean;
  /** derive.isBusyEvent */
  busy: boolean;
  hasAttendees: boolean | null;
  hasMeetingLink: boolean | null;
}

export interface FocusSettings {
  /** 会議の前に聞く（focus.prompt） */
  prompt: boolean;
  target: FocusTarget;
  /** 何分前に聞くか（focus.lead_min） */
  leadMin: number;
  /** 答えなければ開始の時刻に自動で集中する（focus.auto） */
  auto: boolean;
  /** 集中中も needs_input は通知する（focus.allow_needs_input） */
  allowNeedsInput: boolean;
  /** 集中の終わりを知らせる（focus.notify_end。オフなら止めた分が 0 件のときは出さない） */
  notifyEnd: boolean;
}

export const DEFAULT_FOCUS_SETTINGS: FocusSettings = {
  prompt: true,
  target: "meetings",
  leadMin: 5,
  auto: false,
  allowNeedsInput: false,
  notifyEnd: true,
};

export interface FocusActive {
  since: number;
  until: number;
  source: FocusSource;
  title: string | null;
  /** 会議の集中なら予定（calendar_event.id）。予定の終わりが変われば追う */
  eventId: string | null;
}

export interface FocusPrompt {
  /** `<calendar_event.id>:<開始>` */
  key: string;
  eventId: string;
  title: string | null;
  start: number;
  end: number;
}

/**
 * 「この予定の間は集中する」の予約（D-130）。開始の時刻に集中を始め、予定の終わりで終える（予定の変更を追う）。
 * 予約した予定は会議の前に聞かない。予定が消えた・終わったら外す
 */
export interface FocusReservation {
  eventId: string;
  start: number;
  end: number;
  title: string | null;
  /** 会議（参加者か会議リンクがある）か。終わったときのまとめの文を分ける */
  meeting: boolean;
  /** もう集中を始めた（途中で終了したら、同じ予定の間に始め直さない） */
  started: boolean;
}

export interface FocusState {
  active: FocusActive | null;
  prompt: FocusPrompt | null;
  /**
   * 答えないまま開始の時刻を過ぎて閉じた問い。予定が続く間は覚え、遅れて届いた答え（通知のボタン）を受ける
   * （`focus` なら今から予定の終わりまで集中）。予定が終わった・消えた・その終わりまで集中している・予約した・
   * 次の問いを開いたら忘れる。古い保存値には無い
   */
  closed: FocusPrompt | null;
  /** 予定の間の集中の予約（D-130。古い保存値には無い） */
  reserved: FocusReservation[];
  /** 聞いた予定（key と予定の終わり。終わりから1日で消す） */
  asked: { key: string; end: number }[];
  /** 集中中に止めた通知のカード（同じカードは最後の状態） */
  held: { workItemId: string; status: HeldStatus }[];
}

export const initialFocusState = (): FocusState => ({
  active: null,
  prompt: null,
  closed: null,
  reserved: [],
  asked: [],
  held: [],
});

const DAY = 86_400_000;
/** 手動の集中の上限 */
export const FOCUS_MAX_MS = 12 * 3_600_000;

export const promptKey = (e: { id: string; start: number }) => `${e.id}:${e.start}`;

/** 集中モードの対象の予定: busy・終日でない、かつ（会議なら）参加者か会議リンクがある */
export function isFocusTarget(e: FocusEventFact, target: FocusTarget): boolean {
  if (!e.busy || e.allDay || !(e.end > e.start)) return false;
  return target === "busy" || e.hasAttendees === true || e.hasMeetingLink === true;
}

/** 集中を始める・延ばす（集中中なら終わりの遅い方。既定は会議の集中。予約した会議でない予定は manual） */
function startForEvent(
  cur: FocusActive | null,
  e: Pick<FocusPrompt, "eventId" | "title" | "end">,
  now: number,
  source: FocusSource = "meeting",
): FocusActive {
  return {
    since: cur?.since ?? now,
    until: Math.max(cur?.until ?? 0, e.end),
    source,
    title: e.title,
    eventId: e.eventId,
  };
}

const isMeeting = (e: FocusEventFact) => e.hasAttendees === true || e.hasMeetingLink === true;

export interface FocusStep {
  state: FocusState;
  /** 今回の判定で終わった集中（止めた分を添える。まとめの通知に使う） */
  ended: { active: FocusActive; held: FocusState["held"] } | null;
  /** 今回開いた問い（通知に出す） */
  opened: FocusPrompt | null;
  /** 状態が変わった（保存して SSE focus を送る） */
  changed: boolean;
}

/**
 * 1回分の判定（30秒ごとと、予定・設定・操作の後）
 */
export function stepFocus(
  s: FocusState,
  p: { now: number; events: readonly FocusEventFact[]; settings: FocusSettings },
): FocusStep {
  const { now, settings } = p;
  const byId = new Map(p.events.map((e) => [e.id, e]));
  let active = s.active;
  let prompt = s.prompt;
  let closed = s.closed ?? null;
  let held = s.held;
  const asked = s.asked.filter((a) => a.end + DAY > now);
  let reserved = s.reserved ?? [];
  let ended: FocusStep["ended"] = null;
  let opened: FocusPrompt | null = null;

  // 予定の集中（会議・予約）は予定の終わりを追う（予定が消えたら決めた終わりのまま）
  if (active?.eventId) {
    const e = byId.get(active.eventId);
    if (e && e.end !== active.until && e.end > active.since) active = { ...active, until: e.end };
  }
  if (active && now >= active.until) {
    ended = { active, held };
    active = null;
    held = [];
  }

  // 予約（D-130）: 予定の変更を追い、消えた・終日になった・終わった予約は外す。開始の時刻に集中を始める（閉店モード中も。
  // 自分で決めたことなので）。進行中に予約したものは reserveEvent が始めている
  reserved = reserved.flatMap((r) => {
    const e = byId.get(r.eventId);
    if (!e || e.allDay || !(e.end > e.start) || now >= e.end) return [];
    let next: FocusReservation = { ...r, start: e.start, end: e.end, title: e.title };
    if (!next.started && now >= e.start) {
      active = startForEvent(active, next, now, next.meeting ? "meeting" : "manual");
      next = { ...next, started: true };
    }
    return [next];
  });
  const reservedIds = new Set(reserved.map((r) => r.eventId));

  // 開いている問い: 予定が消えた・対象でない・開始が変わった・聞かない設定・予約したなら閉じる。開始の時刻で閉じる
  // （自動で集中。自動でなければ、予定が続く間は閉じた問いとして覚え、遅れて届いた答えを受ける）
  if (prompt) {
    const e = byId.get(prompt.eventId);
    if (
      !e ||
      !isFocusTarget(e, settings.target) ||
      e.start !== prompt.start ||
      !settings.prompt ||
      reservedIds.has(e.id)
    )
      prompt = null;
    else if (now >= prompt.start) {
      if (settings.auto && now < e.end) {
        active = startForEvent(active, { ...prompt, end: e.end, title: e.title }, now);
      } else if (now < e.end) {
        closed = { ...prompt, end: e.end, title: e.title };
      }
      prompt = null;
    }
  }

  // 新しい問い
  if (!prompt && settings.prompt) {
    const lead = settings.leadMin * 60_000;
    const seen = new Set(asked.map((a) => a.key));
    const next = p.events
      .filter(
        (e) =>
          isFocusTarget(e, settings.target) &&
          now >= e.start - lead &&
          now < e.start &&
          !seen.has(promptKey(e)) &&
          !reservedIds.has(e.id) &&
          !(active && active.until >= e.end),
      )
      .sort((a, b) => a.start - b.start || a.id.localeCompare(b.id))[0];
    if (next) {
      prompt = {
        key: promptKey(next),
        eventId: next.id,
        title: next.title,
        start: next.start,
        end: next.end,
      };
      asked.push({ key: prompt.key, end: next.end });
      opened = prompt;
    }
  }

  // 閉じた問い: 予定の変更を追う。予定が終わった・消えた・開始が変わった・予約した・その終わりまで集中している・
  // 次の問いを開いた（通知が置き換わる）なら忘れる
  if (closed) {
    const e = byId.get(closed.eventId);
    if (
      opened ||
      !e ||
      now >= e.end ||
      e.start !== closed.start ||
      reservedIds.has(e.id) ||
      (active && active.until >= e.end)
    )
      closed = null;
    else closed = { ...closed, end: e.end, title: e.title };
  }

  const state: FocusState = { active, prompt, closed, reserved, asked, held };
  const changed =
    JSON.stringify(state.active) !== JSON.stringify(s.active) ||
    JSON.stringify(state.prompt) !== JSON.stringify(s.prompt) ||
    JSON.stringify(state.closed) !== JSON.stringify(s.closed ?? null) ||
    JSON.stringify(state.reserved) !== JSON.stringify(s.reserved ?? []) ||
    state.held !== s.held;
  return { state, ended, opened, changed: changed || asked.length !== s.asked.length };
}

/**
 * 問いへの答え。開いている問いの key なら答える。閉じた問い（開始の時刻を過ぎたが予定はまだ続く）の key なら遅れた答え
 * として受ける（`late`。`focus` は今から予定の終わりまで）。どちらでもなければ null（古い通知のボタン。409 stale）
 */
export function answerPrompt(
  s: FocusState,
  key: string,
  answer: "focus" | "skip",
  now: number,
): { state: FocusState; late: boolean } | null {
  if (s.prompt && s.prompt.key === key) {
    const active = answer === "focus" ? startForEvent(s.active, s.prompt, now) : s.active;
    return { state: { ...s, active, prompt: null }, late: false };
  }
  const c = s.closed ?? null;
  if (c && c.key === key && now < c.end) {
    const active = answer === "focus" ? startForEvent(s.active, c, now) : s.active;
    return { state: { ...s, active, closed: null }, late: true };
  }
  return null;
}

/** 手動で始める（集中中なら終わりを置き換える。上限12時間） */
export function startManual(s: FocusState, now: number, until: number): FocusState {
  const end = Math.min(until, now + FOCUS_MAX_MS);
  return {
    ...s,
    active: {
      since: s.active?.since ?? now,
      until: end,
      source: "manual",
      title: null,
      eventId: null,
    },
  };
}

/**
 * 「この予定の間は集中する」（D-130）。終わった予定・終日の予定は null。進行中の予定なら今から始める（集中中なら終わりの
 * 遅い方へ延ばす）。その予定の問いが開いていれば閉じる（もう聞かない）
 */
export function reserveEvent(s: FocusState, e: FocusEventFact, now: number): FocusState | null {
  if (e.allDay || !(e.end > e.start) || now >= e.end) return null;
  const running = now >= e.start;
  const r: FocusReservation = {
    eventId: e.id,
    start: e.start,
    end: e.end,
    title: e.title,
    meeting: isMeeting(e),
    started: running,
  };
  return {
    ...s,
    active: running ? startForEvent(s.active, r, now, r.meeting ? "meeting" : "manual") : s.active,
    prompt: s.prompt?.eventId === e.id ? null : s.prompt,
    closed: s.closed?.eventId === e.id ? null : (s.closed ?? null),
    reserved: [...(s.reserved ?? []).filter((x) => x.eventId !== e.id), r],
  };
}

/**
 * 予約を取り消す（D-130）。その予定の集中の最中なら集中も終える（止めた分を返す）
 */
export function cancelReservation(
  s: FocusState,
  eventId: string,
): { state: FocusState; ended: FocusStep["ended"] } {
  const reserved = (s.reserved ?? []).filter((x) => x.eventId !== eventId);
  const next = { ...s, reserved };
  if (s.active?.eventId === eventId) return endFocus(next);
  return { state: next, ended: null };
}

/** 終える（止めた分を返す） */
export function endFocus(s: FocusState): { state: FocusState; ended: FocusStep["ended"] } {
  if (!s.active) return { state: s, ended: null };
  return { state: { ...s, active: null, held: [] }, ended: { active: s.active, held: s.held } };
}

/**
 * 「次の予定の終わりまで」: 今と重なる予定（busy・終日でない）の終わり（重なるものが複数なら先に始まったもの）、
 * 無ければ horizon より前に始まるこれからの最初の予定の終わり。無ければ null
 */
export function nextEventEnd(
  events: readonly FocusEventFact[],
  now: number,
  horizon: number,
): number | null {
  const ok = events
    .filter((e) => e.busy && !e.allDay && e.end > now)
    .sort((a, b) => a.start - b.start);
  const cur = ok.find((e) => e.start <= now);
  if (cur) return cur.end;
  const next = ok.find((e) => e.start > now && e.start < horizon);
  return next ? next.end : null;
}

/**
 * 集中中の絞り込み（閉店モードの filterPaused の後）。集中していなければそのまま。集中中は needs_input の即時だけ
 * allowNeedsInput で通し、残りのカードを止めた分にする
 */
export function filterFocus(
  notices: readonly Notice[],
  o: { active: boolean; allowNeedsInput: boolean },
): { pass: Notice[]; held: FocusState["held"] } {
  if (!o.active) return { pass: [...notices], held: [] };
  const pass: Notice[] = [];
  const held: FocusState["held"] = [];
  for (const n of notices) {
    if (n.kind === "immediate") {
      const st = n.item.status === "error" ? "error" : "needs_input";
      if (st === "needs_input" && o.allowNeedsInput) pass.push(n);
      else held.push({ workItemId: n.item.workItemId, status: st });
    } else for (const x of n.items) held.push({ workItemId: x.workItemId, status: "your_turn" });
  }
  return { pass, held };
}

/** 止めた分に足す（同じカードは新しい状態で置き換える） */
export function addHeld(s: FocusState, add: FocusState["held"]): FocusState {
  if (add.length === 0) return s;
  const m = new Map(s.held.map((h) => [h.workItemId, h]));
  for (const h of add) m.set(h.workItemId, h);
  return { ...s, held: [...m.values()] };
}

// ---- 文言（デーモンが解決して返す。Rust・web は作らない） ----

const TEXT = {
  en: {
    label: "Focusing until {time}",
    ask: "{time} {title} · Focus during this meeting?",
    noTitle: "(No title)",
    focus: "Focus",
    skip: "Not now",
    meeting: "{count} waiting on you from your meeting",
    manual: "{count} waiting on you from focus",
    approvals: " ({n} approval)",
    approvalsOther: " ({n} approvals)",
    more: "and {n} more",
    ended: "Focus ended",
    endedUntil: "Until {time} · No muted notifications",
    endedDuring: "During {title} · No muted notifications",
  },
  ja: {
    label: "集中モード中 · {time} まで",
    ask: "{time} {title} · 集中モードにしますか？",
    noTitle: "（題名なし）",
    focus: "集中する",
    skip: "しない",
    meeting: "会議中に自分の番が {count} 件",
    manual: "集中モード中に自分の番が {count} 件",
    approvals: "（許可待ち {n}）",
    approvalsOther: "（許可待ち {n}）",
    more: "ほか {n} 件",
    ended: "集中モードを終了しました",
    endedUntil: "{time} まで · 止めた通知はありません",
    endedDuring: "「{title}」の間 · 止めた通知はありません",
  },
} as const;

const fill = (s: string, p: Record<string, string | number>) =>
  s.replace(/\{(\w+)\}/g, (_, k: string) => String(p[k] ?? ""));

/** メニューバー・画面上部の表示 `集中モード中 · 16:00 まで` */
export function focusLabel(a: FocusActive, tz: string, locale: Locale): string {
  return fill(TEXT[locale].label, { time: fmtClock(a.until, tz) });
}

/** 問いの文 `15:00 デザインレビュー · 集中モードにしますか？` */
export function promptText(p: FocusPrompt, tz: string, locale: Locale): string {
  const t = TEXT[locale];
  return fill(t.ask, { time: fmtClock(p.start, tz), title: p.title?.trim() || t.noTitle });
}

/** ボタンの文言（通知上のボタンと帯） */
export function promptActions(locale: Locale): { id: "focus" | "skip"; title: string }[] {
  return [
    { id: "focus", title: TEXT[locale].focus },
    { id: "skip", title: TEXT[locale].skip },
  ];
}

/** 問いの通知（デスクトップアプリ。desktop-shell.md 3.5） */
export function promptMessage(p: FocusPrompt, tz: string, locale: Locale): NoticeMessage {
  return {
    id: "focus-prompt",
    kind: "focus_prompt",
    status: "focus",
    title: promptText(p, tz, locale),
    body: "",
    path: `/board?focus=${encodeURIComponent(p.key)}`,
    sound: false,
    actions: promptActions(locale),
  };
}

/** メニューバーのサブメニューの文言 */
export const FOCUS_MENU = {
  en: {
    title: "Focus",
    m30: "30 Minutes",
    h1: "1 Hour",
    event: "Until the Next Event Ends",
    end: "End Focus",
  },
  ja: {
    title: "集中モード",
    m30: "30分",
    h1: "1時間",
    event: "次の予定の終わりまで",
    end: "終了",
  },
} as const;

/** まとめの通知の本文に出すカードの数（超えた分は「ほか N 件」） */
export const SUMMARY_LINES = 3;

/**
 * 集中が終わったときの通知（D-097、2026-10-19 の変更）。終わり方（終わりの時刻・手動・予定の終わり）で形を変えない。
 * - 止めた分のうち今も自分の番に出ているカード（状態は今のもの）があれば、件数の題名と各カードの件名（3 件まで＋「ほか N 件」。
 *   notify.content が minimal なら `repo · branch`）。needs_input を含めば鳴らす。`path: "/queue"`
 * - 無ければ `集中モードを終了しました` と `14:58 まで · 止めた通知はありません`（予定由来で題名があれば `「定例」の間 · …`）。
 *   鳴らさない。`path: "/board"`。設定 focus.notify_end がオフなら null
 * 時刻は実際に終えた時刻（終わりの時刻を過ぎてから気づいたときは終わりの時刻）
 */
export function focusSummary(
  ended: NonNullable<FocusStep["ended"]>,
  queue: readonly QueueItem[],
  o: {
    locale: Locale;
    now: number;
    tz: string;
    notifyEnd: boolean;
    content?: NotifyContent;
  },
): NoticeMessage | null {
  const { locale } = o;
  const ids = new Set(ended.held.map((h) => h.workItemId));
  const items = visibleQueue(queue).filter((x) => ids.has(x.workItemId));
  const t = TEXT[locale];
  if (items.length === 0) {
    if (!o.notifyEnd) return null;
    const title = ended.active.eventId ? ended.active.title?.trim() : "";
    const at = Math.min(o.now, ended.active.until);
    return {
      id: "focus-summary",
      kind: "focus_summary",
      status: "focus",
      title: t.ended,
      body: title
        ? fill(t.endedDuring, { title })
        : fill(t.endedUntil, { time: fmtClock(at, o.tz) }),
      path: "/board",
      sound: false,
    };
  }
  const n = items.filter((x) => x.status === "needs_input").length;
  const head = fill(ended.active.source === "meeting" ? t.meeting : t.manual, {
    count: items.length,
  });
  const line = (x: QueueItem) =>
    o.content === "minimal" ? noticeWhere(x) : followUpSubject(x, locale) || noticeWhere(x);
  const lines = items.slice(0, SUMMARY_LINES).map(line);
  if (items.length > SUMMARY_LINES) lines.push(fill(t.more, { n: items.length - SUMMARY_LINES }));
  return {
    id: "focus-summary",
    kind: "focus_summary",
    status: n > 0 ? "needs_input" : "your_turn",
    title: n > 0 ? head + fill(n === 1 ? t.approvals : t.approvalsOther, { n }) : head,
    body: lines.join("\n"),
    path: "/queue",
    sound: n > 0,
  };
}
