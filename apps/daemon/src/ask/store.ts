/**
 * 図つきの問い（MCP の ask_user。ADR 0022）のメモリの置き場。問い・背景・案・図・答えはここにだけあり、DB・spool・ログ・
 * SSE・書き出し・バックアップには入れない。デーモンが止まれば消える（開いていた問いは MCP のプロセスから見て 404 になり、
 * AI は端末で聞き直す）。
 *
 * - 開いた問いは MCP のプロセスの long-poll（結果を待つ GET）を生きている印にする。ABANDON_MS のあいだ一度も待ちに来なければ
 *   AI 側が居なくなったとみなして取り消す（Claude Code が終わった・MCP のプロセスが落ちた）
 * - 返した答えは MCP のプロセスが受け取るまで（上限 RESULT_KEEP_MS）だけ持ち、受け取ったら捨てる。受け取るまでは開いている
 *   扱い（カードは回答待ちのまま「10:25 に返しました」）。受け取った時刻が閉じた時刻
 * - 閉じた問いは中身を捨て、状態と時刻だけの控えを TOMBSTONE_MS のあいだ残す（画面の「もう進んでいます」と、返答タスクを
 *   閉じる理由のため）
 */

import { ASK_OPEN_MAX } from "@turnlane/core";
import type { AskCreateInput, AskResultResponse, AskState, AskView } from "@turnlane/core/api";

/** MCP のプロセスが待ちに来なくなってから取り消すまで */
export const ABANDON_MS = 90_000;
/** 返した答えを MCP のプロセスが受け取るのを待つ上限 */
export const RESULT_KEEP_MS = 60_000;
/** 閉じた問いの控え（中身なし）を残す長さ */
export const TOMBSTONE_MS = 3_600_000;

export interface AskRecord {
  id: string;
  workItemId: string | null;
  turnId: string | null;
  createdAt: number;
  state: AskState;
  /** 返した時刻（answered のとき） */
  answeredAt: number | null;
  /** 閉じた時刻（返した答えは MCP のプロセスが受け取った時刻） */
  closedAt: number | null;
  /** 中身（開いている間だけ。閉じたら null） */
  content: AskCreateInput | null;
  /** 返した答え（MCP のプロセスが受け取るまで） */
  result: { choice?: string; note?: string } | null;
  /** MCP のプロセスが最後に待ちに来た時刻 */
  seenAt: number;
  /** カードを新しく作った（報告の作業の出どころと ID。閉じたら done を報告する） */
  ownCard: { source: string; id: string } | null;
}

export class AskLimitError extends Error {}

export class AskStore {
  readonly #asks = new Map<string, AskRecord>();
  readonly #waiters = new Map<string, Set<() => void>>();
  readonly #listeners = new Set<(r: AskRecord) => void>();

  constructor(private readonly now: () => number) {}

  /** 状態が変わった（開いた・返した・受け取った・閉じた）ときに呼ぶ */
  onChange(l: (r: AskRecord) => void): () => void {
    this.#listeners.add(l);
    return () => this.#listeners.delete(l);
  }

  #changed(r: AskRecord): void {
    for (const w of this.#waiters.get(r.id) ?? []) w();
    this.#waiters.delete(r.id);
    for (const l of this.#listeners) l(r);
  }

  /** 開いている（返したが MCP のプロセスがまだ受け取っていないものを含む）問い */
  isLive(r: AskRecord): boolean {
    return r.state === "open" || (r.state === "answered" && r.closedAt === null);
  }

  openCount(): number {
    let n = 0;
    for (const r of this.#asks.values()) if (this.isLive(r)) n++;
    return n;
  }

  open(
    id: string,
    content: AskCreateInput,
    at: { workItemId: string | null; turnId: string | null },
    ownCard: AskRecord["ownCard"] = null,
  ): AskRecord {
    if (this.openCount() >= ASK_OPEN_MAX) throw new AskLimitError("too_many_asks");
    const now = this.now();
    const r: AskRecord = {
      id,
      workItemId: at.workItemId,
      turnId: at.turnId,
      createdAt: now,
      state: "open",
      answeredAt: null,
      closedAt: null,
      content,
      result: null,
      seenAt: now,
      ownCard,
    };
    this.#asks.set(id, r);
    this.#changed(r);
    return r;
  }

  get(id: string): AskRecord | null {
    return this.#asks.get(id) ?? null;
  }

  /** カードを後から決めた（自分のカードを作った） */
  attach(id: string, workItemId: string | null): void {
    const r = this.#asks.get(id);
    if (!r) return;
    r.workItemId = workItemId;
    this.#changed(r);
  }

  /** 返す（開いているときだけ）。中身はここで捨てる */
  answer(id: string, value: { choice?: string; note?: string }): AskRecord | null {
    const r = this.#asks.get(id);
    if (r?.state !== "open") return null;
    r.state = "answered";
    r.answeredAt = this.now();
    r.result = value;
    r.content = null;
    this.#changed(r);
    return r;
  }

  /** 閉じる（人が閉じた = dismissed、AI 側で打ち切られた・居なくなった = cancelled） */
  close(id: string, how: "dismissed" | "cancelled"): AskRecord | null {
    const r = this.#asks.get(id);
    if (r?.state !== "open") return null;
    r.state = how;
    r.closedAt = this.now();
    r.content = null;
    this.#changed(r);
    return r;
  }

  /**
   * MCP のプロセスが結果を待つ（long-poll）。開いていれば waitMs まで待つ。返した答えは渡したら捨てて閉じる。
   * 知らない問い（デーモンの再起動で消えた・控えの期限が過ぎた）は null
   */
  async result(id: string, waitMs: number): Promise<AskResultResponse | null> {
    const r = this.#asks.get(id);
    if (!r) return null;
    r.seenAt = this.now();
    if (r.state === "open" && waitMs > 0) {
      await new Promise<void>((resolve) => {
        const set = this.#waiters.get(id) ?? new Set<() => void>();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const done = () => {
          if (timer) clearTimeout(timer);
          set.delete(done);
          resolve();
        };
        set.add(done);
        this.#waiters.set(id, set);
        timer = setTimeout(done, waitMs);
      });
      r.seenAt = this.now();
    }
    return this.#collect(r);
  }

  #collect(r: AskRecord): AskResultResponse {
    if (r.state === "open") return { state: "open" };
    if (r.state === "answered") {
      const out: AskResultResponse = { state: "answered", ...(r.result ?? {}) };
      if (r.closedAt === null) {
        r.closedAt = this.now();
        r.result = null;
        this.#changed(r);
      }
      return out;
    }
    return { state: r.state };
  }

  /** 画面に出す形（開いている間だけ中身を付ける） */
  view(id: string): AskView | null {
    const r = this.#asks.get(id);
    if (!r) return null;
    const c = r.state === "open" ? r.content : null;
    return {
      id: r.id,
      workItemId: r.workItemId,
      state: r.state,
      createdAt: r.createdAt,
      closedAt: r.state === "answered" ? r.answeredAt : r.closedAt,
      ...(c
        ? {
            question: c.question,
            ...(c.context ? { context: c.context } : {}),
            options: c.options.map((o, i) => ({
              n: i + 1,
              label: o.label,
              description: o.description,
              recommended: o.recommended === true,
              ...(o.figure ? { figure: o.figure } : {}),
            })),
            ...(c.explain ? { explain: c.explain } : {}),
          }
        : {}),
    };
  }

  /** 開いている問いの一覧（判定と画面のため。中身は呼ぶ側が要るものだけ使う） */
  live(): AskRecord[] {
    return [...this.#asks.values()].filter((r) => this.isLive(r));
  }

  /** 閉じた問いの控え（中身なし） */
  closed(): AskRecord[] {
    return [...this.#asks.values()].filter((r) => !this.isLive(r));
  }

  /**
   * 片付け（定期）: 待ちに来なくなった問いを取り消す、受け取られなかった答えを捨てて閉じる、古い控えを消す。
   * 変わった問いを返す
   */
  sweep(): AskRecord[] {
    const now = this.now();
    const changed: AskRecord[] = [];
    for (const r of [...this.#asks.values()]) {
      if (r.state === "open" && now - r.seenAt >= ABANDON_MS) {
        r.state = "cancelled";
        r.closedAt = now;
        r.content = null;
        changed.push(r);
      } else if (
        r.state === "answered" &&
        r.closedAt === null &&
        now - (r.answeredAt ?? now) >= RESULT_KEEP_MS
      ) {
        r.closedAt = now;
        r.result = null;
        changed.push(r);
      } else if (r.closedAt !== null && now - r.closedAt >= TOMBSTONE_MS) {
        this.#asks.delete(r.id);
      }
    }
    for (const r of changed) this.#changed(r);
    return changed;
  }
}
