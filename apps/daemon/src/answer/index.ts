/**
 * Turnlane から答える（D-238、ADR 0019。m2-api 31章）: 自分の番の待ち（問い・許可）への答えを、そのセッションの端末の
 * タブ（ペイン）に文字として届け、タブを前に出す。端末は内蔵しない。自動では送らない（人が押したときだけ）。
 *
 * - wait: 待ちの中身（問いの全文は表示の瞬間に記録から読む。保存しない）と届け先
 * - 待ちの対象は core の `derive.openWaitOf`（D-240）: 開いているフォローアップ → 無ければセッションの待ち（猶予の間の
 *   問いも答えられる）。フォローアップの無い待ちは、届け先・前に出すをカード（workItemId）で決める
 * - answer: (a) 待ちがまだ開いているか記録の末尾で確かめ、閉じていれば 409 wait_closed（送らない）(b) 届け先を決めて送る
 *   (c) 3 秒以内に記録が進んだか（新しい自分の指示・許可の結果）を見る (d) 確かめられなければ「開く」と同じ経路でタブを
 *   前に出す（確かめられたら Turnlane に留まる。D-241）
 * - 答えの文は保存しない（記録に自分の指示として現れ、ADR 0018 の規則で 1 行目だけが保存される）。ログは
 *   `answer.sent`（文字数と届け先の種類）だけ
 */
import type { Database } from "bun:sqlite";
import { type MetaOnlyLogger, meta } from "@turnlane/collectors";
import {
  ANSWER_MAX,
  answerLanding,
  answerSentText,
  answerWhere,
  type derive,
  instructBlock,
  instructUndeliverable,
  type Locale,
} from "@turnlane/core";
import type {
  AnswerDelivery,
  AnswerInput,
  AnswerResult,
  InstructBlocked,
  InstructCheck,
  InstructInput,
  InstructResult,
  OpenLanding,
  WaitResponse,
} from "@turnlane/core/api";
import { OpError } from "../derive/ops.ts";
import { ghosttyMarker, hostTerminal } from "../open/focus.ts";
import { ghosttyScriptable, noteGhosttyUnscriptable } from "../open/ghostty.ts";
import { type Opener, runPrep } from "../open/index.ts";
import { locateLive } from "../open/locate.ts";
import type { OpenSystem } from "../open/system.ts";
import { loadTarget } from "../open/target.ts";
import {
  answerText,
  type Delivery,
  ghosttyFailure,
  parseOrcaSend,
  planSend,
  resolveDelivery,
  sendPrep,
  sendsNewlines,
} from "./deliver.ts";
import { type InstructRead, readInstruct, tailState } from "./instruct.ts";
import { readWait, type WaitRead, waitOpen } from "./wait.ts";

/** 送った後に記録が進んだかを見る長さと間隔 */
export const CONFIRM_MS = 3_000;
const CONFIRM_STEP_MS = 250;

export interface AnswererOptions {
  sqlite: Database;
  sys: OpenSystem;
  opener: Opener;
  logger: MetaOnlyLogger;
  home: string;
  now: () => number;
  locale: () => Locale;
  /** 設定「Turnlane から答える」（turn.answer。既定オン） */
  enabled: () => boolean;
  /** 設定「行に中身を出す」（turn.show_detail。オフなら問いの全文を読まない） */
  showDetail: () => boolean;
  /** 待つ（テストでは差し替える） */
  sleep?: (ms: number) => Promise<void>;
  /** カードのセッションの待ち（runner の最後の判定。D-240）。無ければフォローアップだけを見る */
  sessionWait?: (workItemId: string) => derive.SessionWait | null;
}

export class Answerer {
  constructor(private readonly o: AnswererOptions) {}

  #sessionWait(workItemId: string): derive.SessionWait | null {
    return this.o.sessionWait?.(workItemId) ?? null;
  }

  /** フォローアップがあればそれ、無ければカード（フォローアップの無い待ち。D-240） */
  #ref(workItemId: string, w: WaitRead): { followUpId: string } | { workItemId: string } {
    return w.followUp ? { followUpId: w.followUp.id } : { workItemId };
  }

  /** 届け先を決める（動いているセッションの居場所 → 端末） */
  async #deliveryFor(
    workItemId: string,
    w: WaitRead,
  ): Promise<{ d: Delivery; tool: string | null; host?: string }> {
    if (!w.wait) return { d: { ok: false, app: null, reason: "not_live" }, tool: null };
    return this.#deliveryTo(this.#ref(workItemId, w));
  }

  /** 届け先（フォローアップかカードの、動いているセッションの居場所 → 端末） */
  async #deliveryTo(
    ref: { followUpId: string } | { workItemId: string },
  ): Promise<{ d: Delivery; tool: string | null; host?: string }> {
    const t = loadTarget(this.o.sqlite, this.o.sys, ref, this.o.now());
    const s = t.session;
    if (!s?.livePid)
      return { d: { ok: false, app: null, reason: "not_live" }, tool: s?.tool ?? null };
    const live = await locateLive(s.livePid, this.o.sys);
    const orca = await this.o.opener.orcaFor(live, s);
    // Ghostty（tmux の外）: AppleScript が使えるか（版と設定。Apple Event は送らない）と、目印の後に戻す cwd（D-244）
    const ghostty =
      live.host && !live.tmux && hostTerminal(live.host).kind === "ghostty"
        ? {
            cwd: s.cwd,
            marker: ghosttyMarker(),
            scriptable: await ghosttyScriptable(this.o.sys, live.host, this.o.now()),
          }
        : undefined;
    return {
      d: resolveDelivery(live, orca, ghostty),
      tool: s.tool,
      ...(ghostty && live.host ? { host: live.host } : {}),
    };
  }

  #delivery(d: Delivery, tool: string | null): AnswerDelivery {
    const locale = this.o.locale();
    if (!d.ok)
      return {
        deliverable: false,
        via: null,
        terminal: d.app,
        landing: null,
        multiline: false,
        reason: d.reason,
      };
    return {
      deliverable: true,
      via: d.via,
      terminal: d.app,
      landing: answerWhere(d.app, { pane: d.via === "tmux" ? d.pane.label : null }, locale),
      multiline: sendsNewlines(d, tool),
    };
  }

  /** 報告のセッションか（ADR 0021） */
  #reportSource(sessionId: string): boolean {
    return (
      this.o.sqlite
        .query<{ e: string | null }, [string]>(
          "SELECT entrypoint AS e FROM ai_session WHERE id = ?",
        )
        .get(sessionId)?.e === "report"
    );
  }

  async wait(workItemId: string): Promise<WaitResponse | null> {
    const w = readWait(this.o.sqlite, workItemId, {
      showDetail: this.o.showDetail(),
      home: this.o.home,
      sessionWait: this.#sessionWait(workItemId),
    });
    if (!w) return null;
    const base = {
      workItemId,
      followUpId: w.wait?.followUpId ?? null,
      kind: w.kind,
      readAt: this.o.now(),
    };
    const off = !this.o.enabled();
    // 報告の項目（ADR 0021）: 端末に送る口は無い。答えは報告した側で（開く先）
    const reporter = w.session && this.#reportSource(w.session.id) ? w.session.tool : null;
    const { d, tool } = reporter
      ? { d: { ok: false, app: reporter, reason: "report" } as Delivery, tool: null }
      : off || w.kind === "none"
        ? { d: { ok: false, app: null, reason: off ? "off" : "not_live" } as Delivery, tool: null }
        : await this.#deliveryFor(workItemId, w);
    const delivery = this.#delivery(d, tool);
    return {
      ...base,
      ...(w.question ? { question: w.question } : {}),
      ...(w.options ? { options: w.options } : {}),
      ...(w.permission ? { permission: w.permission } : {}),
      ...(w.error ? { error: w.error } : {}),
      ...(w.unavailable ? { unavailable: w.unavailable } : {}),
      // 許可する（1）は Claude Code の許可のダイアログだけ（Codex の承認の画面は番号が違う）
      canAllow: w.kind === "permission" && delivery.deliverable && tool === "claude_code",
      delivery,
    };
  }

  async answer(workItemId: string, input: AnswerInput): Promise<AnswerResult> {
    if (!this.o.enabled()) throw new OpError(409, "answer_off");
    const allow = "allow" in input;
    if (!allow && (typeof input.text !== "string" || input.text.length > ANSWER_MAX))
      throw new OpError(400, "invalid_input");
    const w = readWait(this.o.sqlite, workItemId, {
      showDetail: false,
      home: this.o.home,
      sessionWait: this.#sessionWait(workItemId),
    });
    if (!w) throw new OpError(404, "not_found");
    if (w.kind === "none" || !w.wait) throw new OpError(409, "wait_closed");
    if (allow && w.kind !== "permission") throw new OpError(400, "invalid_input");
    // (a) 待ちがまだ開いているか（閉じていれば送らない）
    if (!waitOpen(this.o.sqlite, w, this.#sessionWait(workItemId)).open)
      throw new OpError(409, "wait_closed");
    // (b) 届け先
    const { d, tool, host } = await this.#deliveryFor(workItemId, w);
    if (!d.ok) throw new OpError(409, "undeliverable");
    if (allow && tool !== "claude_code") throw new OpError(409, "undeliverable");
    const prepared = allow ? { text: "1", folded: false } : answerText(tool, d, input.text);
    if (!prepared) throw new OpError(400, "invalid_input");
    const steps = planSend(d, allow ? { kind: "allow" } : { kind: "text", text: prepared.text });
    let observed = false;
    const prep = sendPrep(d);
    for (const p of prep.prepare) runPrep(this.o.sys, p);
    try {
      observed = await this.#send(d, steps, host);
    } finally {
      // Ghostty の目印は送れても送れなくても戻す
      for (const p of prep.finally) runPrep(this.o.sys, p);
    }
    // (c) 送った後 3 秒以内に記録が進んだか
    const confirmed = observed || (await this.#progressed(workItemId, w));
    // (d) 確かめられなければタブを前に出す（「開く」と同じ経路。対応中の印も付く）。確かめられたら Turnlane に留まる
    // （前に出すと Turnlane の知らせが後ろに回って見えない。見たければ知らせの「開く」。D-241）
    let focus: OpenLanding | null = null;
    if (!confirmed) {
      try {
        const r = await this.o.opener.open({ ...this.#ref(workItemId, w), action: "session" });
        focus = r.outcome === "focused" ? (r.landing ?? null) : null;
      } catch {
        focus = null;
      }
    }
    const locale = this.o.locale();
    const landing = answerLanding(
      d.app,
      d.via,
      d.via === "tmux" ? d.pane.label : null,
      focus,
      locale,
    );
    this.o.logger.info("answer.sent", {
      chars: prepared.text.length,
      via: meta(d.via),
      allow,
      confirmed,
      folded: prepared.folded,
    });
    return {
      delivered: true,
      confirmed,
      via: d.via,
      app: d.app,
      landing,
      focus,
      message: answerSentText({ confirmed, landing }, locale),
      folded: prepared.folded,
    };
  }

  /**
   * 次の指示を送れるか（Issue #9、ADR 0019 の Decision 11）。プロセスが動いている・記録の末尾がターンの終わり・開いている
   * 待ちが無い、を満たしたときだけ端末のタブを探す（終わったセッションには ps・tmux も起動しない）。AI 項目が無ければ null
   */
  async instructCheck(workItemId: string): Promise<InstructCheck | null> {
    const r = await this.#instructPlan(workItemId);
    if (!r) return null;
    if (!r.ok) return { ok: false, reason: r.reason, terminal: r.terminal };
    const delivery = this.#delivery(r.d, r.tool);
    return {
      ok: true,
      via: r.d.via,
      terminal: r.d.app,
      landing: delivery.landing ?? r.d.app,
      multiline: delivery.multiline,
    };
  }

  async #instructPlan(workItemId: string): Promise<
    | null
    | { ok: false; reason: InstructBlocked; terminal: string | null }
    | {
        ok: true;
        d: Extract<Delivery, { ok: true }>;
        tool: string | null;
        host?: string;
        read: InstructRead;
      }
  > {
    const read = readInstruct(this.o.sqlite, workItemId, {
      now: this.o.now(),
      sessionWait: this.#sessionWait(workItemId),
    });
    if (!read) return null;
    const blocked = instructBlock({ enabled: this.o.enabled(), ...read.facts });
    if (blocked) return { ok: false, reason: blocked, terminal: null };
    const { d, tool, host } = await this.#deliveryTo({ workItemId });
    if (!d.ok) return { ok: false, reason: instructUndeliverable(d.reason), terminal: d.app };
    return { ok: true, d, tool, ...(host ? { host } : {}), read };
  }

  /**
   * 次の指示を端末のタブに文字として届ける（答えると同じ口）。送る前の条件を満たさなければ 409（理由の言葉）で送らない。
   * 送った後 3 秒以内に記録へ新しい自分の指示が現れたら confirmed（タブは前に出さない）。文は保存しない（ログは文字数と
   * 届け先の種類だけ）
   */
  async instruct(workItemId: string, input: InstructInput): Promise<InstructResult> {
    if (typeof input.text !== "string" || input.text.length > ANSWER_MAX)
      throw new OpError(400, "invalid_input");
    const plan = await this.#instructPlan(workItemId);
    if (!plan) throw new OpError(404, "not_found");
    if (!plan.ok) throw new OpError(409, plan.reason);
    const { d, tool, host, read } = plan;
    const prepared = answerText(tool, d, input.text);
    if (!prepared) throw new OpError(400, "invalid_input");
    const steps = planSend(d, { kind: "text", text: prepared.text });
    let observed = false;
    const prep = sendPrep(d);
    for (const p of prep.prepare) runPrep(this.o.sys, p);
    try {
      observed = await this.#send(d, steps, host);
    } finally {
      for (const p of prep.finally) runPrep(this.o.sys, p);
    }
    const confirmed = observed || (await this.#newPrompt(read));
    let focus: OpenLanding | null = null;
    if (!confirmed) {
      try {
        const r = await this.o.opener.open({ workItemId, action: "session" });
        focus = r.outcome === "focused" ? (r.landing ?? null) : null;
      } catch {
        focus = null;
      }
    }
    const locale = this.o.locale();
    const landing = answerLanding(
      d.app,
      d.via,
      d.via === "tmux" ? d.pane.label : null,
      focus,
      locale,
    );
    this.o.logger.info("instruction.sent", {
      chars: prepared.text.length,
      via: meta(d.via),
      confirmed,
      folded: prepared.folded,
    });
    return {
      delivered: true,
      confirmed,
      via: d.via,
      app: d.app,
      landing,
      focus,
      message: answerSentText({ confirmed, landing }, locale),
      folded: prepared.folded,
    };
  }

  /** 記録に新しい自分の指示が現れたか（最後の指示の目印が変わった）を CONFIRM_MS まで見る */
  async #newPrompt(read: InstructRead): Promise<boolean> {
    const s = read.session;
    if (!s) return false;
    const sleep = this.o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    for (let waited = 0; waited <= CONFIRM_MS; waited += CONFIRM_STEP_MS) {
      const m = tailState(s).mark;
      if (m !== null && m !== read.mark) return true;
      if (waited + CONFIRM_STEP_MS > CONFIRM_MS) break;
      await sleep(CONFIRM_STEP_MS);
    }
    return false;
  }

  /** 手順を順に起動する。Orca は受理と送信の観測を分けて読む。Ghostty は送れなかった理由を分ける（D-244） */
  async #send(
    d: Extract<Delivery, { ok: true }>,
    steps: ReturnType<typeof planSend>,
    host: string | undefined,
  ): Promise<boolean> {
    let observed = false;
    for (const s of steps) {
      const r = this.o.sys.runDetail
        ? await this.o.sys.runDetail(s.argv, {
            ...(s.timeoutMs ? { timeoutMs: s.timeoutMs } : {}),
            ...(d.via === "orca" ? { stdoutMax: 64 * 1024 } : {}),
          })
        : {
            ok: await this.o.sys.run(s.argv, s.timeoutMs ? { timeoutMs: s.timeoutMs } : {}),
            stdout: "",
            stderr: "",
            timedOut: false,
          };
      if (d.via === "orca") {
        // 受理されたか（accepted）と、送信を観測したか（turn_started）を分けて読む
        const p = parseOrcaSend(r.stdout ?? "");
        if (!r.ok || !p.accepted) throw new OpError(409, "send_failed");
        if (p.observed) observed = true;
      } else if (!r.ok) {
        if (d.via === "ghostty") {
          // 目印の端末が 0 個・複数、AppleScript が応答しない: 文は入っていないので「この端末には送れません」
          const why = ghosttyFailure(r);
          this.o.logger.info("answer.undelivered", { via: meta("ghostty"), reason: meta(why) });
          if (why === "unsupported" && host)
            noteGhosttyUnscriptable(this.o.sys, host, this.o.now());
          if (why !== "send_failed") throw new OpError(409, "undeliverable");
        }
        throw new OpError(409, "send_failed");
      }
    }
    return observed;
  }

  /** 記録が進んだか（待ちが閉じたか）を CONFIRM_MS まで見る。記録を読めなければ false */
  async #progressed(workItemId: string, w: WaitRead): Promise<boolean> {
    const sleep = this.o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    for (let waited = 0; waited <= CONFIRM_MS; waited += CONFIRM_STEP_MS) {
      const r = waitOpen(this.o.sqlite, w, this.#sessionWait(workItemId));
      if (!r.readable) return false;
      if (!r.open) return true;
      if (waited + CONFIRM_STEP_MS > CONFIRM_MS) break;
      await sleep(CONFIRM_STEP_MS);
    }
    return false;
  }
}
