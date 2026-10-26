/**
 * 通知の判定をデーモンで回す（desktop-shell.md 3.1、ADR 0010 の決定 2）。
 * キューが変わったとき（follow_up / work_item / task / day_boundary / settings の SSE の後）と1分ごとに、
 * キューに visibleQueue → planNotifications → filterPaused を適用し（web と同じ順）、出すものがあれば SSE の `notify` を送る。
 * - 起動直後の1回目は通知せず、見たことにする（再起動のたびに通知が重複しない）
 * - 閉店モード中に出た自分の番は通知済みとして扱い、明けた後にまとめて出し直さない（filterPaused の前に seen に入る）
 * - 判定はデスクトップアプリがつながっていなくても回す（つないだ瞬間に古い待ちをまとめて通知しないため）
 * - 集中モード中（D-097。m2-api 25章）は filterPaused の後に filterFocus で止め、止めたカードを FocusService に渡す
 *   （終わったら FocusService がまとめて1回通知する。そのときまとめ待ちの your_turn も takePending で渡し、通常のまとめから外す）
 * - オンボーディングが済むまでと、まとめての取り込み（同意の後・新しい取り込み元・reingest）の間は通知しない
 *   （onboarding.md 5.3、M6-18）。判定は回して見たことにするので、済んだ後に過去の出来事をまとめて通知しない
 */
import type { QueueItem } from "@turnlane/core/api";
import {
  type FocusState,
  filterFocus,
  initialNotifyState,
  type NotifyContent,
  type NotifyState,
  noticeMessage,
  planNotifications,
  visibleQueue,
} from "@turnlane/core/web";
import type { SseEventType } from "../http/sse.ts";

export interface NotifyRunnerDeps {
  queue(): { items: QueueItem[] };
  /** 通知の文言の言語 */
  locale(): "en" | "ja";
  /** 通知に出す中身（設定 notify.content。D-207 (4)）。省略は件名 */
  content?: () => NotifyContent;
  now(): number;
  /**
   * notify は通知。follow_up は時間に置いた自分の番の開始が来て帯に戻ったときの合図（DB は変わらないので、画面とメニューバーに
   * 取り直させる）
   */
  publish(type: "notify" | "follow_up", data: Record<string, unknown>): void;
  subscribe(l: (m: { type: SseEventType | "ping" }) => void): () => void;
  intervalMs?: number;
  /** 拡張が足した通知の保留（ADR 0015。集中モードの後に当てる） */
  holds?: NotifyHolds;
  /** true の間は判定だけ回して通知しない（オンボーディング中・まとめての取り込み中。M6-18） */
  muted?: () => boolean;
  /** 集中モード（無ければ集中しない） */
  focus?: {
    active(now: number): boolean;
    allowNeedsInput(): boolean;
    hold(held: FocusState["held"]): void;
  };
}

type Notice = ReturnType<typeof filterFocus>["pass"][number];

/**
 * 拡張の通知の保留（ExtDeps.notify.hold。ADR 0015）: 条件に当たったカードを通知から外し、拡張に渡す。
 * まとめ（batch）は当たったカードだけ外し、残りが無ければ通知ごと外す
 */
interface Hold {
  filter: (item: QueueItem) => boolean;
  onHeld?: ((items: QueueItem[]) => void) | undefined;
}

export class NotifyHolds {
  readonly #holds = new Set<Hold>();

  get size(): number {
    return this.#holds.size;
  }

  add(filter: (item: QueueItem) => boolean, onHeld?: (items: QueueItem[]) => void): () => void {
    const h: Hold = { filter, onHeld };
    this.#holds.add(h);
    return () => {
      this.#holds.delete(h);
    };
  }

  apply(notices: readonly Notice[]): Notice[] {
    if (this.#holds.size === 0) return [...notices];
    const held = new Map<Hold, QueueItem[]>();
    const hit = (item: QueueItem) => {
      for (const h of this.#holds) {
        let ok = false;
        try {
          ok = h.filter(item);
        } catch {}
        if (ok) {
          held.set(h, [...(held.get(h) ?? []), item]);
          return true;
        }
      }
      return false;
    };
    const out: Notice[] = [];
    for (const n of notices) {
      if (n.kind === "immediate") {
        if (!hit(n.item)) out.push(n);
      } else {
        const items = n.items.filter((x) => !hit(x));
        if (items.length > 0) out.push({ ...n, items });
      }
    }
    for (const [h, items] of held) {
      try {
        h.onHeld?.(items);
      } catch {}
    }
    return out;
  }
}

const TRIGGERS = new Set<string>(["follow_up", "work_item", "task", "day_boundary", "settings"]);

export class NotifyRunner {
  #state: NotifyState = initialNotifyState();
  #timer: ReturnType<typeof setInterval> | null = null;
  #soon: ReturnType<typeof setTimeout> | null = null;
  /** 許可待ちの猶予（PERMISSION_GRACE_MS）の後にもう一度判定する */
  #recheck: ReturnType<typeof setTimeout> | null = null;
  /** 時間に置いた自分の番（開始の前）の followUp の id。開始が来て外れたら follow_up を流す */
  #scheduled = new Set<string>();
  /** いちばん早い開始の時刻に判定する */
  #startTimer: ReturnType<typeof setTimeout> | null = null;
  #startAt: number | null = null;
  #unsubscribe: (() => void) | null = null;
  readonly #d: NotifyRunnerDeps;

  constructor(d: NotifyRunnerDeps) {
    this.#d = d;
  }

  start(): void {
    this.run();
    this.#unsubscribe = this.#d.subscribe((m) => {
      if (TRIGGERS.has(m.type) && !this.#soon) {
        this.#soon = setTimeout(() => {
          this.#soon = null;
          this.run();
        }, 0);
      }
    });
    this.#timer = setInterval(() => this.run(), this.#d.intervalMs ?? 60_000);
  }

  stop(): void {
    this.#unsubscribe?.();
    if (this.#timer) clearInterval(this.#timer);
    if (this.#soon) clearTimeout(this.#soon);
    if (this.#recheck) clearTimeout(this.#recheck);
    this.#recheck = null;
    if (this.#startTimer) clearTimeout(this.#startTimer);
    this.#startTimer = null;
    this.#startAt = null;
    this.#timer = null;
    this.#soon = null;
  }

  /**
   * 判定だけ回して、今のフォローアップを見たことにする（通知しない）。まとめての取り込みが終わった直後に、
   * 判定の実行の後で呼ぶ（取り込んだ過去の出来事を、次の判定で通知しないため）
   */
  prime(): void {
    this.run(true);
  }

  /**
   * まとめ待ちの your_turn（カードの id）を取り出して空にする。集中が終わったときに FocusService が呼び、終わりのまとめに
   * 含める（集中が15分より短いと、集中中に増えた your_turn はまとめの時刻が来ておらず止めた分に入らないため）。
   * 取り出した分は通常のまとめから外れ、通知した時刻も記録する（二重に出さない）
   */
  takePending(): string[] {
    const ids = [...this.#state.pending];
    if (ids.length === 0) return ids;
    const now = this.#d.now();
    const lastByCard = new Map(this.#state.lastByCard);
    for (const id of ids) lastByCard.set(id, now);
    this.#state = { ...this.#state, pending: new Set(), lastByCard };
    return ids;
  }

  /**
   * 時間に置いた自分の番（ux-mvp 4.6）: 開始が来て scheduled から外れた id があれば follow_up を流す（通知は open になった
   * フォローアップとして planNotifications が 1 回出す）。次の開始の時刻に判定をもう一度回す（1 分ごとの判定を待たない）
   */
  #watchScheduled(items: readonly QueueItem[], now: number): void {
    const cur = scheduledOf(items);
    const back = [...this.#scheduled].filter((id) => !cur.has(id));
    this.#scheduled = new Set(cur.keys());
    if (back.length > 0) {
      try {
        this.#d.publish("follow_up", { ids: back, workItemIds: [] });
      } catch {}
    }
    if (!this.#timer) return;
    const next = cur.size > 0 ? Math.min(...cur.values()) : null;
    if (next === this.#startAt) return;
    if (this.#startTimer) clearTimeout(this.#startTimer);
    this.#startTimer = null;
    this.#startAt = next;
    if (next === null) return;
    // setTimeout の上限（約 24.8 日）を超えないように、遠いものは 1 分ごとの判定に任せる
    const wait = Math.max(0, next - now) + 50;
    if (wait > 2 ** 31 - 1) return;
    this.#startTimer = setTimeout(() => {
      this.#startTimer = null;
      this.#startAt = null;
      this.run();
    }, wait);
  }

  /** 1回判定する（テストから直接呼ぶ）。送った通知を返す */
  run(forceMute = false): ReturnType<typeof noticeMessage>[] {
    const now = this.#d.now();
    let q: ReturnType<NotifyRunnerDeps["queue"]>;
    try {
      q = this.#d.queue();
    } catch {
      return [];
    }
    this.#watchScheduled(q.items, now);
    const r = planNotifications(this.#state, visibleQueue(q.items), now);
    this.#state = r.state;
    if (r.recheckAt !== undefined && !this.#recheck && this.#timer) {
      this.#recheck = setTimeout(
        () => {
          this.#recheck = null;
          this.run();
        },
        Math.max(0, r.recheckAt - now) + 50,
      );
    }
    let muted = forceMute;
    try {
      muted ||= this.#d.muted?.() ?? false;
    } catch {}
    if (muted) {
      // まとめの待ちも捨てる（明けた後に過去の your_turn をまとめて出さない）
      this.#state = { ...this.#state, pending: new Set() };
      return [];
    }
    const f = this.#d.focus;
    const focused = filterFocus(r.notices, {
      active: f?.active(now) ?? false,
      allowNeedsInput: f?.allowNeedsInput() ?? false,
    });
    if (focused.held.length > 0) f?.hold(focused.held);
    const notices = this.#d.holds ? this.#d.holds.apply(focused.pass) : focused.pass;
    if (notices.length === 0) return [];
    const locale = this.#d.locale();
    let content: NotifyContent = "subject";
    try {
      content = this.#d.content?.() ?? "subject";
    } catch {}
    const out = notices.map((n) => noticeMessage(n, locale, content));
    this.#d.publish("notify", { notices: out });
    return out;
  }
}

/** 開始の前の時間に置いた自分の番（status scheduled）の id と開始の時刻 */
function scheduledOf(items: readonly QueueItem[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const x of items)
    for (const f of x.followUps)
      if (f.status === "scheduled" && f.scheduledAt !== undefined) out.set(f.id, f.scheduledAt);
  return out;
}

/** 設定 ui.language と、デスクトップアプリが渡した macOS の優先言語から通知の言語を決める（3.2） */
export function notifyLocale(setting: string, desktopLang: string | null): "en" | "ja" {
  if (setting === "en" || setting === "ja") return setting;
  return desktopLang?.toLowerCase().startsWith("ja") ? "ja" : "en";
}
