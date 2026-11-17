/**
 * hook で答える（ADR 0023。m2-api 42 章）: Claude Code の PermissionRequest の hook（`turnlane hook --tool claude_code
 * --answer`）が開いた待ちを、デーモンのメモリにだけ持つ。人が Turnlane で「許可する」・選択肢を押したら、その答えを hook の
 * long-poll に返す（hook が Claude Code に出す）。
 *
 * - 持つのは識別子（session_id・agent_id）・ツールの名前・時刻だけ。ツールの入力・答えの文は持たない（答えは hook が受け取る
 *   まで、hook に渡したら捨てる）。DB・spool・ログ・SSE に入れない。デーモンが止まれば消える（hook は 404 で何も出さずに終わる）
 * - 待たないとき（設定「Turnlane から答える」がオフ・プログラム経由のセッション）は開かない（hook はすぐ終わる）
 * - 取り下げ（core の hookWaitWithdrawal）: 同じセッション・同じエージェントの次の待ちが開いた、セッションが終わった、本体の
 *   ターンが進んだ、カードの待ちが閉じた、カードに一度も現れない、hook から聞かれなくなった。取り下げた待ちの hook は何も
 *   出さずに終わる（本体の確認はそのまま）
 * - ログは `hook_wait.closed`（理由と道具の種類）だけ
 */
import { type MetaOnlyLogger, meta } from "@turnlane/collectors";
import {
  HOOK_WAIT_KEEP_MS,
  HOOK_WAIT_MAX,
  HOOK_WAIT_POLL_MAX_MS,
  type HookWaitEntry,
  type HookWaitWithdrawal,
  hookWaitWithdrawal,
  type LaterHook,
  matchHookWait,
} from "@turnlane/core";
import type { HookAskChoice, HookWaitOpenResponse, HookWaitResult } from "@turnlane/core/api";

/** 渡す答え（hook が受け取るまでだけ持つ） */
export type HookDelivery =
  | { state: "allow" }
  | { state: "answer"; answers: HookAskChoice[]; count: number };

interface Rec extends HookWaitEntry {
  /** 渡す答え（hook が受け取ったら null に戻し、待ちを閉じる） */
  pending: HookDelivery | null;
  /** 閉じた時刻と理由（閉じた後は控えだけ） */
  closedAt: number | null;
  how: HookWaitWithdrawal | "answered" | "cancelled" | null;
}

export interface HookWaitOptions {
  now: () => number;
  newId: () => string;
  logger: MetaOnlyLogger;
  /** 設定「Turnlane から答える」（turn.answer） */
  enabled: () => boolean;
  /** プログラム経由のセッション（取り込んだ記録と hooks の印から。core の isProgramSession） */
  isProgram: (session: string) => boolean;
  /** 状態が変わった（開いた・閉じた）ときに呼ぶ（画面の「答える」の節の読み直し）。引数は session_id */
  changed?: (session: string) => void;
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** 本文に入れてよい形の識別子（session_id・agent_id）か */
const okId = (v: unknown): v is string => typeof v === "string" && SAFE_ID.test(v);

/** ツールの名前（mcp__server__tool も含む）。長さと文字だけ確かめる */
const okTool = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(v);

export class HookWaits {
  readonly #recs = new Map<string, Rec>();
  readonly #waiters = new Map<string, Set<() => void>>();

  constructor(private readonly o: HookWaitOptions) {}

  #wake(id: string): void {
    for (const w of this.#waiters.get(id) ?? []) w();
    this.#waiters.delete(id);
  }

  #close(r: Rec, how: NonNullable<Rec["how"]>): void {
    if (r.closedAt !== null) return;
    r.closedAt = this.o.now();
    r.how = how;
    r.pending = null;
    this.o.logger.info("hook_wait.closed", {
      how: meta(how),
      ask: r.tool === "AskUserQuestion",
      sub: r.agentId !== null,
    });
    this.#wake(r.id);
    this.o.changed?.(r.session);
  }

  /** 開いている待ち（答えを渡して hook がまだ受け取っていないものを含む） */
  live(): HookWaitEntry[] {
    return [...this.#recs.values()].filter((r) => r.closedAt === null);
  }

  /**
   * hook が待ちを開く。待たないときは理由（hook は何も出さずに終わる）。同じセッション・同じエージェントの前の待ちは閉じている
   * （Claude Code は確認を 1 つずつ出す）ので取り下げる
   */
  open(input: unknown): HookWaitOpenResponse {
    const b = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
    if (!okId(b.session) || !okTool(b.tool)) return { wait: false, reason: "unsupported" };
    if (b.agentId !== undefined && !okId(b.agentId)) return { wait: false, reason: "unsupported" };
    if (!this.o.enabled()) return { wait: false, reason: "off" };
    const entry = typeof b.entrypoint === "string" ? b.entrypoint : "";
    if (b.delegated === true || entry.startsWith("sdk-") || this.o.isProgram(b.session))
      return { wait: false, reason: "program" };
    // 許可を確かめない設定（bypassPermissions）では確認が出ない。念のため待たない
    if (b.permissionMode === "bypassPermissions") return { wait: false, reason: "unsupported" };
    const agentId = typeof b.agentId === "string" ? b.agentId : null;
    for (const r of this.#recs.values())
      if (r.closedAt === null && r.session === b.session && r.agentId === agentId)
        this.#close(r, "superseded");
    const live = this.live().sort((a, z) => a.openedAt - z.openedAt);
    for (const r of live.slice(0, Math.max(0, live.length - HOOK_WAIT_MAX + 1)))
      this.#close(r as Rec, "gone");
    const now = this.o.now();
    const id = this.o.newId();
    this.#recs.set(id, {
      id,
      session: b.session,
      agentId,
      tool: b.tool,
      openedAt: now,
      lastPollAt: now,
      seen: false,
      pending: null,
      closedAt: null,
      how: null,
    });
    this.o.changed?.(b.session);
    return { wait: true, id };
  }

  /**
   * hook が答えを待つ（long-poll）。答えがあれば渡して閉じる。閉じた・取り下げた待ちは withdrawn。知らない待ち（デーモンの
   * 再起動で消えた・控えの期限が過ぎた）は null
   */
  async result(id: string, waitMs: number): Promise<HookWaitResult | null> {
    const r = this.#recs.get(id);
    if (!r) return null;
    r.lastPollAt = this.o.now();
    const ms = Math.max(0, Math.min(HOOK_WAIT_POLL_MAX_MS, waitMs));
    if (r.closedAt === null && !r.pending && ms > 0) {
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
        timer = setTimeout(done, ms);
      });
      r.lastPollAt = this.o.now();
    }
    if (r.pending) {
      const p = r.pending;
      this.#close(r, "answered");
      return p.state === "allow" ? p : { state: "answer", count: p.count, answers: p.answers };
    }
    return r.closedAt === null ? { state: "open" } : { state: "withdrawn" };
  }

  /** hook の側で終わった（シグナル・親が消えた）。知らなければ false */
  cancel(id: string): boolean {
    const r = this.#recs.get(id);
    if (!r) return false;
    this.#close(r, "cancelled");
    return true;
  }

  /** カードの待ちと同じものを待っている hook（ちょうど 1 つのときだけ） */
  match(q: {
    session: string;
    kind: "permission" | "ask";
    tool: string | null;
  }): HookWaitEntry | null {
    return matchHookWait(this.live(), q);
  }

  /**
   * 答えを渡す。hook が受け取るのを最長 collectMs 待ち、受け取られたら true。受け取られなければ渡すのをやめて false
   * （hook が居ない。何も出していない）
   */
  async deliver(id: string, d: HookDelivery, collectMs = 3_000): Promise<boolean> {
    const r = this.#recs.get(id);
    if (!r || r.closedAt !== null) return false;
    r.pending = d;
    this.#wake(id);
    // 実時間で待つ（hook の long-poll は実時間で動く。偽の時計のテストでも止まらないよう回数で数える）
    for (let waited = 0; r.closedAt === null && waited < collectMs; waited += 50)
      await Bun.sleep(50);
    if (r.closedAt === null) {
      r.pending = null;
      return false;
    }
    return r.how === "answered";
  }

  /**
   * 片付け（判定の後と定期）: 取り下げの条件を確かめる。facts はその待ちのカードに待ちが開いているか（同じセッション・同じ
   * 種類）と、待ちを開いた後に届いたそのセッションの hook のイベント
   */
  sweep(facts: (e: HookWaitEntry) => { open: boolean; later: readonly LaterHook[] }): void {
    const now = this.o.now();
    for (const r of [...this.#recs.values()]) {
      if (r.closedAt !== null) {
        if (now - r.closedAt > HOOK_WAIT_KEEP_MS) this.#recs.delete(r.id);
        continue;
      }
      if (r.pending) continue;
      const f = facts(r);
      if (f.open) r.seen = true;
      const why = hookWaitWithdrawal(r, { now, open: f.open, later: f.later });
      if (why) this.#close(r, why);
    }
  }
}
