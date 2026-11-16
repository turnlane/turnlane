/**
 * 図つきの問い（MCP の ask_user。ADR 0022。m2-api 41 章）: MCP のプロセスが開いた問いをカードに付け、自分の番に回答待ちとして
 * 出し、画面で選んだ答えを MCP のプロセスの long-poll に返す。
 *
 * - カードの決め方: (1) MCP のプロセスの親（AI のプロセス）が動いているセッションのカード（`ai_session.live_pid`）
 *   (2) 無ければ MCP のプロセスの作業ディレクトリで最近動いたターンのカード（リポジトリ × ブランチ。既定ブランチは
 *   セッションのカード）(3) どちらも無ければ自分のカード（報告の作業。出どころ `agent`、題名はフォルダの名前。ADR 0021 の道。
 *   報告に入れるのは状態と題名だけで、問いの中身は入れない）
 * - 判定には問いの ID・時刻・ターンだけを渡す（runner の asks）。中身はメモリ（AskStore）にだけある
 * - ログは問いの ID と数（案の数・図のバイト数・状態）だけ。文は出さない
 */
import type { Database } from "bun:sqlite";
import { basename } from "node:path";
import { type MetaOnlyLogger, meta } from "@turnlane/collectors";
import { type derive, figureBytes, parseAskAnswer, parseAskInput } from "@turnlane/core";
import type {
  AskCreateInput,
  AskCreateResponse,
  AskResultResponse,
  AskView,
  GlanceResponse,
} from "@turnlane/core/api";
import { OpError } from "../derive/ops.ts";
import { AskLimitError, type AskRecord, AskStore } from "./store.ts";

/** 自分のカード（報告の作業）の出どころ */
export const ASK_OWN_SOURCE = "agent";
/** 作業ディレクトリでカードを探すときに見るターンの古さ */
const CWD_LOOKBACK_MS = 24 * 3_600_000;
/** long-poll の上限 */
export const ASK_WAIT_MAX_MS = 25_000;
/** 片付けの間隔 */
const SWEEP_MS = 15_000;

export interface AskServiceOptions {
  sqlite: Database;
  logger: MetaOnlyLogger;
  now: () => number;
  newId: () => string;
  /** 判定を回す（問いが開いた・閉じた）。await できる（問いを開いたら返答タスクができるまで待つ。上限つき） */
  rederive: () => Promise<void>;
  /** 報告を受ける（自分のカード。ADR 0021 の ReportReceiver.receive） */
  report: (body: Record<string, unknown>) => Promise<{ workItemId: string | null } | null>;
  /** 返答タスクを閉じる（人が閉じた。UserOps.dismiss） */
  dismissFollowUp: (followUpId: string) => void;
  /** 片付けのタイマーを回さない（テスト） */
  noTimer?: boolean;
}

export class AskService {
  readonly store: AskStore;
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly o: AskServiceOptions) {
    this.store = new AskStore(o.now);
    this.store.onChange((r) => {
      // 閉じたら自分のカードの作業も終える（状態だけ）
      if (!this.store.isLive(r) && r.ownCard) {
        const own = r.ownCard;
        r.ownCard = null;
        void this.o.report({ source: own.source, id: own.id, state: "done" }).catch(() => {});
      }
    });
  }

  start(): void {
    if (this.o.noTimer || this.#timer) return;
    this.#timer = setInterval(() => this.sweep(), SWEEP_MS);
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  sweep(): void {
    const changed = this.store.sweep();
    for (const r of changed)
      this.o.logger.info("ask.closed", { ask: meta(r.id), how: meta(r.state) });
    if (changed.length > 0) void this.o.rederive();
  }

  /** 判定に渡す事実（カード → 開いている問い、問い → 閉じ方）。中身は渡さない */
  facts(): {
    open: Map<string, derive.AskFact[]>;
    closures: Map<string, derive.AskClosure>;
  } {
    const open = new Map<string, derive.AskFact[]>();
    for (const r of this.store.live()) {
      if (!r.workItemId) continue;
      const xs = open.get(r.workItemId) ?? [];
      xs.push({ id: r.id, at: r.createdAt, turnId: r.turnId });
      open.set(r.workItemId, xs);
    }
    const closures = new Map<string, derive.AskClosure>();
    for (const r of this.store.closed()) {
      if (r.state === "open" || r.closedAt === null) continue;
      closures.set(r.id, { how: r.state, at: r.closedAt });
    }
    return { open, closures };
  }

  /** 問いを開く（MCP のプロセス）。カードを決めて、返答タスクができるまで待つ */
  async create(input: unknown): Promise<AskCreateResponse> {
    const p = parseAskInput(input);
    if (!p.ok) throw new OpError(400, `invalid_input: ${p.field}`);
    const v = p.value;
    const id = this.o.newId();
    const found = this.#attach(v);
    let rec: AskRecord;
    try {
      rec = this.store.open(id, v, found ?? { workItemId: null, turnId: null });
    } catch (e) {
      if (e instanceof AskLimitError) throw new OpError(409, "too_many_asks");
      throw e;
    }
    let ownCard = false;
    if (!found) {
      // 自分のカード（報告の作業）。状態と題名だけを報告する
      ownCard = true;
      rec.ownCard = { source: ASK_OWN_SOURCE, id };
      const title = (v.cwd ? basename(v.cwd) : "") || "Question";
      const r = await this.o
        .report({ source: ASK_OWN_SOURCE, id, state: "started", title: title.slice(0, 120) })
        .catch(() => null);
      this.store.attach(id, r?.workItemId ?? null);
      // カードにできなかった（AI の取り込みがオフ・同意の前）: 画面に出せない問いは開いておかない
      if (!r?.workItemId) {
        this.store.close(id, "cancelled");
        throw new OpError(409, "no_card");
      }
    }
    this.o.logger.info("ask.opened", {
      ask: meta(id),
      options: v.options.length,
      figures: v.options.filter((o) => o.figure && "html" in o.figure).length,
      explain: v.explain && "html" in v.explain ? figureBytes(v.explain.html) : 0,
      own_card: ownCard,
    });
    await this.o.rederive();
    const now = this.store.get(id);
    return { id, workItemId: now?.workItemId ?? null, ownCard };
  }

  /** MCP のプロセスの long-poll。知らない問いは 404（デーモンの再起動で消えた） */
  async result(id: string, waitMs: number): Promise<AskResultResponse> {
    const r = await this.store.result(id, Math.max(0, Math.min(ASK_WAIT_MAX_MS, waitMs)));
    if (!r) throw new OpError(404, "ask_not_found");
    if (r.state !== "open") void this.o.rederive();
    return r;
  }

  /** MCP のプロセスが取り消す（AI 側で打ち切られた） */
  cancel(id: string): void {
    if (!this.store.get(id)) throw new OpError(404, "ask_not_found");
    if (this.store.close(id, "cancelled")) {
      this.o.logger.info("ask.closed", { ask: meta(id), how: meta("cancelled") });
      void this.o.rederive();
    }
  }

  view(id: string): AskView {
    const v = this.store.view(id);
    if (!v) throw new OpError(404, "ask_not_found");
    return v;
  }

  /** 画面が返す */
  answer(id: string, input: unknown): { state: "answered"; answeredAt: number } {
    const r = this.store.get(id);
    if (!r) throw new OpError(404, "ask_not_found");
    if (r.state !== "open" || !r.content) throw new OpError(409, "ask_closed");
    const p = parseAskAnswer(
      input,
      r.content.options.map((o) => o.label),
    );
    if (!p.ok) throw new OpError(400, `invalid_input: ${p.field}`);
    const done = this.store.answer(id, p.value);
    if (!done) throw new OpError(409, "ask_closed");
    this.o.logger.info("ask.answered", {
      ask: meta(id),
      choice: p.value.choice !== undefined,
      note_chars: p.value.note?.length ?? 0,
    });
    void this.o.rederive();
    return { state: "answered", answeredAt: done.answeredAt ?? this.o.now() };
  }

  /** 画面が閉じる（返答タスクも対応不要にする） */
  dismiss(id: string): void {
    const r = this.store.get(id);
    if (!r) throw new OpError(404, "ask_not_found");
    if (r.state !== "open") throw new OpError(409, "ask_closed");
    const fu = this.#followUpOf(id);
    // 返答タスクの対応不要が closedByUser で問いを閉じる。返答タスクがまだ無ければ問いだけ閉じる
    if (fu) this.o.dismissFollowUp(fu);
    if (this.store.get(id)?.state === "open") this.closedByUser(id);
  }

  /** 返答タスクを人が閉じた（対応不要・完了）。開いていれば問いも閉じる（AI には dismissed） */
  closedByUser(id: string): void {
    if (this.store.close(id, "dismissed")) {
      this.o.logger.info("ask.closed", { ask: meta(id), how: meta("dismissed") });
      void this.o.rederive();
    }
  }

  /**
   * 行の「待っている理由」（GET /api/work-items/:id/glance）: カードに開いている問いがあれば、問いと案の名前を返す
   * （表示の瞬間にメモリから。保存しない）。無ければ null
   */
  glance(workItemId: string, now: number): GlanceResponse | null {
    const r = this.store
      .live()
      .filter((x) => x.workItemId === workItemId && x.state === "open" && x.content)
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    if (!r?.content) return null;
    const labels = r.content.options.map((o) => o.label);
    return {
      workItemId,
      kind: "ask",
      ask: {
        question: r.content.question,
        options: labels.slice(0, 3),
        more: Math.max(0, labels.length - 3),
        questions: [{ question: r.content.question, options: labels }],
      },
      readAt: now,
    };
  }

  #followUpOf(id: string): string | null {
    return (
      this.o.sqlite
        .query<{ id: string }, [string]>(
          "SELECT id FROM follow_up WHERE artifact_ref = ? AND deleted_at IS NULL AND status IN ('open', 'snoozed') LIMIT 1",
        )
        .get(`ask_user:${id}:ask`)?.id ?? null
    );
  }

  /** AI のセッションのカード（動いているプロセス → 作業ディレクトリ）。無ければ null */
  #attach(v: AskCreateInput): { workItemId: string; turnId: string } | null {
    const db = this.o.sqlite;
    const now = this.o.now();
    const live = (wi: string | null) => {
      if (!wi) return null;
      // 統合したカードは統合先に。隠したカード・消したカードには付けない（自分の番に出ない）
      const w = db
        .query<
          { id: string; merged: string | null; hidden: number | null; deleted: number | null },
          [string]
        >(
          "SELECT id, merged_into_id AS merged, hidden_at AS hidden, deleted_at AS deleted FROM work_item WHERE id = ?",
        )
        .get(wi);
      if (!w) return null;
      if (w.merged) return live(w.merged);
      return w.hidden || w.deleted ? null : w.id;
    };
    if (v.pid) {
      const t = db
        .query<{ id: string; wi: string | null }, [number, number]>(
          `SELECT t.id, t.work_item_id AS wi FROM ai_session s JOIN ai_turn t ON t.session_id = s.id
           WHERE s.live_pid = ? AND s.last_activity_at >= ? AND s.is_subagent = 0 AND t.work_item_id IS NOT NULL
           ORDER BY t.started_at DESC LIMIT 1`,
        )
        .get(v.pid, now - CWD_LOOKBACK_MS);
      const wi = live(t?.wi ?? null);
      if (t && wi) return { workItemId: wi, turnId: t.id };
    }
    if (v.cwd) {
      const dir = v.cwd.replace(/\/+$/, "") || "/";
      const t = db
        .query<{ id: string; wi: string | null }, [string, string, number]>(
          `SELECT t.id, t.work_item_id AS wi FROM ai_turn t JOIN ai_session s ON s.id = t.session_id
           WHERE (t.cwd = ?1 OR substr(t.cwd, 1, length(?2)) = ?2) AND t.started_at >= ?3
             AND s.is_subagent = 0 AND s.entrypoint IS NOT 'report' AND t.work_item_id IS NOT NULL
           ORDER BY t.started_at DESC LIMIT 1`,
        )
        .get(dir, `${dir === "/" ? "" : dir}/`, now - CWD_LOOKBACK_MS);
      const wi = live(t?.wi ?? null);
      if (t && wi) return { workItemId: wi, turnId: t.id };
    }
    return null;
  }
}
