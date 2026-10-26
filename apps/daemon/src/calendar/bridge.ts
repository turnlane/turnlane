/**
 * カレンダーヘルパとの接続（phase0-plan 1.5、M3-1・M3-2）。
 * TurnlaneCalendarHelper.app が ws://127.0.0.1:<port>/internal/ek に WebSocket クライアントとして接続し、
 * デーモンは JSON-RPC 2.0（1メッセージ1JSON）で要求を送る。ヘルパからは通知（storeChanged / authorizationChanged）が来る。
 * - 接続は1本だけ。新しい接続が来たら古い接続を閉じる（ヘルパの再起動・二重起動）
 * - 応答は 15 秒で打ち切る。切れたら待っている要求はすべて失敗させる
 * - 予定の題名などはログに出さない（呼び出し側も件数だけを記録する）
 */
import {
  type Authorization,
  type CalendarProvider,
  type CreateEventParams,
  Emitter,
  type HelperCalendar,
  type HelperEvent,
  type HelperStatus,
  type HelperTimeblockEvent,
  helperCalendar,
  helperEvent,
  helperStatus,
  helperTimeblockEvent,
  type ProviderEvent,
  type UpdateEventParams,
} from "./provider.ts";

/** Bun の ServerWebSocket のうち使う部分（テストでは偽物を渡す） */
export interface BridgeSocket {
  send(data: string): unknown;
  close(code?: number, reason?: string): void;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class HelperRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

export class HelperBridge implements CalendarProvider {
  readonly kind = "helper" as const;
  readonly #em = new Emitter();
  readonly #timeoutMs: number;
  #ws: BridgeSocket | null = null;
  #seq = 0;
  readonly #pending = new Map<number, Pending>();

  constructor(o: { timeoutMs?: number } = {}) {
    this.#timeoutMs = o.timeoutMs ?? 15_000;
  }

  connected(): boolean {
    return this.#ws !== null;
  }

  attach(ws: BridgeSocket): void {
    const prev = this.#ws;
    this.#ws = ws;
    if (prev) {
      this.#failAll("replaced");
      try {
        prev.close(4000, "replaced");
      } catch {}
    }
    this.#em.emit({ type: "connected" });
  }

  detach(ws: BridgeSocket): void {
    if (this.#ws !== ws) return;
    this.#ws = null;
    this.#failAll("disconnected");
    this.#em.emit({ type: "disconnected" });
  }

  /** ヘルパからのメッセージ（応答か通知） */
  message(ws: BridgeSocket, data: string | Uint8Array | ArrayBuffer): void {
    if (this.#ws !== ws) return;
    let m: {
      id?: unknown;
      result?: unknown;
      error?: { code?: number; message?: string };
      method?: unknown;
      params?: { authorization?: Authorization };
    };
    try {
      const text = typeof data === "string" ? data : new TextDecoder().decode(data);
      m = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof m.id === "number" && this.#pending.has(m.id)) {
      const p = this.#pending.get(m.id) as Pending;
      this.#pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.error) p.reject(new HelperRpcError(m.error.code ?? -1, m.error.message ?? "error"));
      else p.resolve(m.result);
      return;
    }
    if (m.method === "storeChanged") this.#em.emit({ type: "storeChanged" });
    else if (m.method === "authorizationChanged") {
      const a = helperStatus.shape.authorization.parse(m.params?.authorization);
      this.#em.emit({ type: "authorizationChanged", authorization: a });
    }
  }

  subscribe(l: (e: ProviderEvent) => void): () => void {
    return this.#em.subscribe(l);
  }

  async status(): Promise<HelperStatus> {
    return helperStatus.parse(await this.#call("status"));
  }

  async listCalendars(): Promise<HelperCalendar[]> {
    const r = await this.#call("listCalendars");
    return parseList(r, helperCalendar);
  }

  async fetchEvents(p: {
    calendarIds: string[];
    from: number;
    to: number;
  }): Promise<HelperEvent[]> {
    const r = await this.#call("fetchEvents", p);
    return parseList(r, helperEvent);
  }

  async createEvent(p: CreateEventParams): Promise<HelperEvent> {
    return helperEvent.parse(await this.#call("createEvent", p));
  }

  async updateEvent(p: UpdateEventParams): Promise<HelperEvent> {
    return helperEvent.parse(await this.#call("updateEvent", p));
  }

  async removeEvent(p: { eventId: string }): Promise<{ deleted: boolean }> {
    const r = (await this.#call("removeEvent", p)) as { deleted?: unknown } | null;
    return { deleted: r?.deleted === true };
  }

  async listTimeblockEvents(p: { from: number; to: number }): Promise<HelperTimeblockEvent[]> {
    return parseList(await this.#call("listTimeblockEvents", p), helperTimeblockEvent);
  }

  async deleteTimeblockEvent(p: { eventId: string }): Promise<{ deleted: boolean }> {
    const r = (await this.#call("deleteTimeblockEvent", p)) as { deleted?: unknown } | null;
    return { deleted: r?.deleted === true };
  }

  #call(method: string, params?: unknown): Promise<unknown> {
    const ws = this.#ws;
    if (!ws) return Promise.reject(new Error("helper_not_connected"));
    const id = ++this.#seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error("helper_timeout"));
      }, this.#timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      try {
        ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }));
      } catch (e) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(e as Error);
      }
    });
  }

  #failAll(reason: string): void {
    for (const [id, p] of this.#pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`helper_${reason}`));
      this.#pending.delete(id);
    }
  }
}

/** 配列の各要素を検証し、壊れた要素は落とす（1件の不正で全体を捨てない） */
function parseList<T>(
  r: unknown,
  schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } },
): T[] {
  if (!Array.isArray(r)) throw new Error("helper_bad_result");
  const out: T[] = [];
  for (const x of r) {
    const p = schema.safeParse(x);
    if (p.success) out.push(p.data);
  }
  return out;
}
