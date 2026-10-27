import type { SseEventType } from "@turnlane/core/api";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";

/**
 * SSE ハブ（/api/events。m2-api.md 3章）。UI はイベントを受けて TanStack Query を invalidate する。
 * - データは載せず、種類・影響した日付・ID・rev だけを送る（M0 の方針「メタデータだけ」）
 * - 同じ種類のイベントは 250ms 束ねて1回にする（dates / ids / workItemIds は和集合）
 * - rev はイベントを送るたびに +1 する単調増加の整数（プロセス内）。bootId は起動ごとの乱数。
 *   読み取り応答の rev と比べて、UI が古い応答を捨てる・再接続時に取りこぼしを判定するのに使う
 * - 15秒ごとに ping を送る（UI はこれが来ないとスリープ復帰などで切れたとみなして接続し直す）
 * - `?client=desktop&lang=<macOS の優先言語>` で購読したもの（デスクトップアプリ。desktop-shell.md 3.4）を数える。
 *   増減したら follow_up を送り、web にキュー（desktopNotifier）を取り直させる
 * - notify / desktop_open は束ねずにすぐ送る（中身を和集合にできないため）
 */
export type { SseEventType };

export interface SseMessage {
  type: SseEventType | "ping";
  data: Record<string, unknown>;
}

type Listener = (m: SseMessage) => void;

/** 束ねずにすぐ送るイベント */
const IMMEDIATE = new Set<SseEventType>([
  "backup",
  "notify",
  "desktop_open",
  "desktop_notifications",
  "focus",
  // 日の状態が変わったときだけ送る（多くて日数＋取り込み元の数）。束ねると埋まっていく途中が見えない
  "import_progress",
]);

const LIST_KEYS = ["dates", "ids", "workItemIds", "exts"] as const;

function mergeData(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a, ...b };
  for (const k of LIST_KEYS) {
    const xs = [...((a[k] as unknown[]) ?? []), ...((b[k] as unknown[]) ?? [])];
    if (k in a || k in b) out[k] = [...new Set(xs)].sort();
  }
  for (const k of ["inbox", "calendars"])
    if (k in a || k in b) out[k] = a[k] === true || b[k] === true;
  return out;
}

export class SseHub {
  readonly #listeners = new Set<Listener>();
  readonly #heartbeatMs: number;
  readonly #bundleMs: number;
  readonly #today: () => string;
  readonly #displayToday: () => string;
  readonly #pending = new Map<SseEventType, Record<string, unknown>>();
  #timer: ReturnType<typeof setTimeout> | null = null;
  #rev = 0;
  /** デスクトップアプリの購読（購読ごとの言語） */
  readonly #desktop = new Map<symbol, string>();
  /** 最後のデスクトップアプリの購読が切れた時刻（更新の後の起こし直し。M6-17） */
  #desktopLeftAt: number | null = null;
  readonly #now: () => number;
  readonly bootId: string = crypto.randomUUID();

  constructor(
    opts: {
      heartbeatMs?: number;
      bundleMs?: number;
      today?: () => string;
      /** 表示の「今日」（暦日。D-054） */
      displayToday?: () => string;
      /** 時計（デスクトップアプリが切れた時刻） */
      now?: () => number;
    } = {},
  ) {
    this.#heartbeatMs = opts.heartbeatMs ?? 15_000;
    this.#bundleMs = opts.bundleMs ?? 250;
    this.#today = opts.today ?? (() => "");
    this.#displayToday = opts.displayToday ?? this.#today;
    this.#now = opts.now ?? Date.now;
  }

  get size(): number {
    return this.#listeners.size;
  }

  /** つながっているデスクトップアプリの数 */
  get desktopClients(): number {
    return this.#desktop.size;
  }

  /** デスクトップアプリがつながっている、または ms 以内まではつながっていたか */
  desktopSeenWithin(ms: number): boolean {
    if (this.#desktop.size > 0) return true;
    return this.#desktopLeftAt !== null && this.#now() - this.#desktopLeftAt <= ms;
  }

  /** 最後につないだデスクトップアプリの言語（例 ja-JP）。いなければ null */
  desktopLang(): string | null {
    return [...this.#desktop.values()].at(-1) ?? null;
  }

  /** 最後に送ったイベントの rev（読み取り応答に付ける） */
  get rev(): number {
    return this.#rev;
  }

  /** イベントを送る。backup 以外は bundleMs 束ねる（0 なら即時） */
  publish(type: SseEventType, data: Record<string, unknown> = {}): void {
    if (IMMEDIATE.has(type) || this.#bundleMs === 0) {
      this.#send(type, data);
      return;
    }
    const prev = this.#pending.get(type);
    this.#pending.set(type, prev ? mergeData(prev, data) : mergeData({}, data));
    if (!this.#timer) this.#timer = setTimeout(() => this.flush(), this.#bundleMs);
  }

  /** 束ねているイベントをすぐ送る（テスト・停止時） */
  flush(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    const items = [...this.#pending];
    this.#pending.clear();
    for (const [type, data] of items) this.#send(type, data);
  }

  #send(type: SseEventType, data: Record<string, unknown>): void {
    const payload = type === "backup" ? data : { ...data, rev: ++this.#rev };
    for (const l of this.#listeners) l({ type, data: payload });
  }

  subscribe(l: Listener): () => void {
    this.#listeners.add(l);
    return () => this.#listeners.delete(l);
  }

  handle(c: Context): Response {
    const desktop = c.req.query("client") === "desktop";
    const lang = (c.req.query("lang") ?? "").slice(0, 35);
    return streamSSE(c, async (stream) => {
      const me = Symbol("sse");
      if (desktop) {
        this.#desktop.set(me, lang);
        if (this.#desktop.size === 1) this.publish("follow_up", { ids: [], workItemIds: [] });
      }
      const queue: SseMessage[] = [
        {
          type: "hello",
          data: {
            bootId: this.bootId,
            rev: this.#rev,
            today: this.#today(),
            displayToday: this.#displayToday(),
          },
        },
      ];
      let wake: (() => void) | null = null;
      const unsubscribe = this.subscribe((m) => {
        queue.push(m);
        wake?.();
      });
      let closed = false;
      stream.onAbort(() => {
        closed = true;
        wake?.();
      });
      const heartbeat = setInterval(() => {
        queue.push({ type: "ping", data: {} });
        wake?.();
      }, this.#heartbeatMs);
      try {
        while (!closed) {
          const m = queue.shift();
          if (m) {
            await stream.writeSSE({ event: m.type, data: JSON.stringify(m.data) });
            continue;
          }
          await new Promise<void>((r) => {
            wake = r;
          });
          wake = null;
        }
      } finally {
        clearInterval(heartbeat);
        unsubscribe();
        if (this.#desktop.delete(me) && this.#desktop.size === 0) {
          this.#desktopLeftAt = this.#now();
          this.publish("follow_up", { ids: [], workItemIds: [] });
        }
      }
    });
  }
}
