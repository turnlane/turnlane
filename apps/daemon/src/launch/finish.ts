/**
 * 完了のときの片付けのうち「AI を終了してタブを閉じる」（m2-api 27章 finish）。Turnlane から答える（D-238、answer/deliver.ts）の
 * 届け先と送り方をそのまま使い、送る文は固定の文字列だけ（`/exit`・`/quit`・`exit`）。利用者の入力はシェルに通さない。
 *
 * 1. 居場所: `turnlane ai run <起動 ID>` のプロセスを pgrep で探し（起動 ID は依頼ごとに一意。tmux のクライアントは除く）、
 *    「開く」と同じ locateLive で tty・tmux のペイン・端末のアプリを調べる。親のプロセス（タブのシェル）も覚える。
 *    受け取り（claim）のときに一度調べてメモリに持つ（AI が先に終わっていても、そのタブのシェルに exit を送れる）
 * 2. AI がまだ動いていれば、その tty にまだ turnlane ai run がいることを確かめてから、Claude Code は `/exit`、Codex は `/quit`
 *    を送る。許可・選択のダイアログで待っているときは送らない（Enter が選択になる）
 * 3. turnlane ai run の終わり（exit の知らせと、プロセスが無くなったこと）を最長 FINISH_WAIT_MS 待つ。終わらなければ止める
 * 4. タブを閉じる: シェルの pid がまだ同じ tty にいることを確かめてから `exit` を送る。Orca は同梱の CLI の
 *    `orca terminal close --terminal <h> --tab`。Turnlane が包んだ tmux のセッション（ペインのコマンドが turnlane ai run）は
 *    AI が終われば自分で閉じるので、ペインが無くなったことだけ確かめる
 * 5. 送る口の無い端末（deliver.ts の unsupported。tmux で包んでいない Warp・Kitty など）は何もしない（not_closable）
 *
 * 読むのはプロセスの pid・親・tty・実行ファイルの名前と、tmux・Orca の端末の一覧だけ（画面の中身は読まない）。
 * ログには結果と理由のコードだけ（パス・題名・tty は出さない）
 */
import type { Database } from "bun:sqlite";
import { basename } from "node:path";
import type { derive } from "@turnlane/core";
import type { AiLaunchTool, LaunchFinishReason, LaunchTerminalOutcome } from "@turnlane/core/api";
import {
  type Delivery,
  parseOrcaSend,
  planSend,
  resolveDelivery,
  sendPrep,
} from "../answer/deliver.ts";
import { openWaitFor } from "../answer/wait.ts";
import type { FoundApp } from "../open/apps.ts";
import { ghosttyMarker, hostTerminal } from "../open/focus.ts";
import { ghosttyScriptable } from "../open/ghostty.ts";
import { runPrep, type Step } from "../open/index.ts";
import {
  LIST_PANES_FORMAT,
  type LiveLocation,
  locateLive,
  parsePanes,
  parsePsTtyLine,
  tmuxBase,
} from "../open/locate.ts";
import {
  orcaCli,
  orcaList,
  orcaWritable,
  parseOrcaTerminals,
  pickOrcaTerminal,
} from "../open/orca.ts";
import type { OpenSystem } from "../open/system.ts";
import { lastTermHandle } from "../open/target.ts";
import { launchWorkItem } from "./views.ts";

/** AI の終わりを待つ長さ */
export const FINISH_WAIT_MS = 20_000;
const POLL_MS = 250;
const ORCA_CLOSE_TIMEOUT_MS = 15_000;

/** AI の CLI を終える文（Codex CLI の `/quit`（`/exit` と同じ）。Claude Code は `/exit`） */
export function exitCommand(tool: AiLaunchTool): "/exit" | "/quit" {
  return tool === "codex" ? "/quit" : "/exit";
}

/** タブのシェルを終える文 */
export const SHELL_EXIT = "exit";

/** turnlane ai run の居場所（受け取りのときに調べて覚える） */
export interface RunWhere {
  /** turnlane ai run の pid */
  pid: number;
  /** その親（タブのシェル）。親が tmux のサーバ（Turnlane が包んだセッション）なら null */
  shellPid: number | null;
  live: LiveLocation;
}

export interface FinishLaunchRow {
  id: string;
  tool: AiLaunchTool;
  cwd: string;
  session_id: string | null;
  exit_code: number | null;
  exited_at: number | null;
}

export interface TerminalCloseResult {
  terminal: LaunchTerminalOutcome;
  reason: LaunchFinishReason | null;
  app: string | null;
}

export interface CloserDeps {
  sqlite: Database;
  open: OpenSystem;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  waitMs: number;
  /** カードのセッションの待ち（runner の判定。D-240）。無ければフォローアップだけを見る */
  sessionWait?: ((workItemId: string) => derive.SessionWait | null) | undefined;
  /** 入っている Orca（Orca の CLI の実体。無ければ居場所の .app） */
  orcaApp?: (() => FoundApp | null) | undefined;
}

const LAUNCH_ID = /^[0-9a-f]{32}$/;

/** `pgrep` の出力 → pid（自分自身・1 以下は除く） */
export function parsePids(out: string | null): number[] {
  if (!out) return [];
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^\d+$/.test(l))
    .map(Number)
    .filter((n) => n > 1 && n !== process.pid);
}

/** pgrep の引数（起動 ID で終わる `ai run <ID>` の行だけ） */
export function pgrepArgv(launchId: string): string[] {
  if (!LAUNCH_ID.test(launchId)) throw new Error("bad launch id");
  return ["/usr/bin/pgrep", "-f", `ai run ${launchId}$`];
}

export const psArgv = (pid: number): string[] => [
  "/bin/ps",
  "-o",
  "ppid=,tty=,comm=",
  "-p",
  String(pid),
];

export class TerminalCloser {
  readonly #where = new Map<string, RunWhere>();

  constructor(private readonly o: CloserDeps) {}

  async #ps(pid: number) {
    return parsePsTtyLine((await this.o.open.capture?.(psArgv(pid))) ?? "");
  }

  /** turnlane ai run を探して居場所を調べる。1 つに決まらなければ null（別のタブに送らない） */
  async locate(launchId: string): Promise<RunWhere | null> {
    const cap = this.o.open.capture?.bind(this.o.open);
    if (!cap) return null;
    const found: { pid: number; ppid: number; tty: string }[] = [];
    for (const pid of parsePids(await cap(pgrepArgv(launchId)))) {
      const row = await this.#ps(pid);
      // tmux で包んだときの tmux のクライアント（引数に同じコマンドを持つ）は除く
      if (!row?.tty || basename(row.comm) === "tmux") continue;
      found.push({ pid, ppid: row.ppid, tty: row.tty });
    }
    if (found.length !== 1) return null;
    const f = found[0] as (typeof found)[number];
    const live = await locateLive(f.pid, this.o.open);
    const parent = await this.#ps(f.ppid);
    const shellPid =
      parent && basename(parent.comm) !== "tmux" && parent.tty === f.tty ? f.ppid : null;
    const w: RunWhere = { pid: f.pid, shellPid, live: { ...live, tty: live.tty ?? f.tty } };
    this.#where.set(launchId, w);
    return w;
  }

  /** 受け取りのときに居場所を覚える（失敗しても何もしない） */
  remember(launchId: string): void {
    void this.locate(launchId).catch(() => undefined);
  }

  /** そのプロセスがまだその tty にいるか（pid の使い回しに備えて tty も比べる） */
  async #onTty(pid: number | null, tty: string | null): Promise<boolean> {
    if (!pid || !tty) return false;
    const row = await this.#ps(pid);
    return !!row && row.tty === tty;
  }

  /** AI のプロセス（turnlane ai run）がまだ動いているか（終わりの知らせが無く、プロセスが見つかる） */
  async aiRunning(r: FinishLaunchRow): Promise<boolean> {
    if (r.exited_at !== null) return false;
    const w = await this.locate(r.id);
    return w !== null;
  }

  async #delivery(r: FinishLaunchRow, w: RunWhere): Promise<Delivery> {
    const live = w.live;
    let orca: Parameters<typeof resolveDelivery>[1];
    if (live.host && !live.tmux && /\/Orca\.app$/.test(live.host)) {
      const app = this.o.orcaApp?.() ?? { id: "orca", name: "Orca", path: live.host };
      const rows = parseOrcaTerminals((await this.o.open.capture?.(orcaList(app))) ?? null);
      const ext = r.session_id
        ? this.o.sqlite
            .query<{ tool: string; external_id: string }, [string]>(
              "SELECT tool, external_id FROM ai_session WHERE id = ?",
            )
            .get(r.session_id)
        : null;
      const handle = ext ? lastTermHandle(this.o.sqlite, ext.tool, ext.external_id) : null;
      const pick = pickOrcaTerminal(rows, { handle, cwd: r.cwd });
      orca = { app, pick, writable: pick.handle !== null && orcaWritable(rows, pick.handle) };
    }
    const ghostty =
      live.host && !live.tmux && hostTerminal(live.host).kind === "ghostty"
        ? {
            cwd: r.cwd,
            marker: ghosttyMarker(),
            scriptable: await ghosttyScriptable(this.o.open, live.host, this.o.now()),
          }
        : undefined;
    return resolveDelivery(live, orca, ghostty);
  }

  /** 許可・選択のダイアログで待っているか（Enter が選択になるので終了の指示を送らない） */
  #inDialog(r: FinishLaunchRow): boolean {
    const wi = launchWorkItem(this.o.sqlite, r.session_id);
    if (!wi) return false;
    try {
      const w = openWaitFor(this.o.sqlite, wi, this.o.sessionWait?.(wi) ?? null);
      return w?.kind === "permission" || w?.kind === "ask";
    } catch {
      return false;
    }
  }

  async #run(steps: Step[], orca: boolean): Promise<boolean> {
    for (const s of steps) {
      const opts = {
        ...(s.timeoutMs ? { timeoutMs: s.timeoutMs } : {}),
        ...(orca ? { stdoutMax: 64 * 1024 } : {}),
      };
      if (orca && this.o.open.runDetail) {
        const r = await this.o.open.runDetail(s.argv, opts);
        if (!r.ok || !parseOrcaSend(r.stdout ?? "").accepted) return false;
      } else if (!(await this.o.open.run(s.argv, opts))) return false;
    }
    return true;
  }

  /** 固定の文を届け先に送る（Ghostty は目印を書いて戻す） */
  async #send(d: Extract<Delivery, { ok: true }>, text: string): Promise<boolean> {
    const prep = sendPrep(d);
    for (const p of prep.prepare) runPrep(this.o.open, p);
    try {
      return await this.#run(planSend(d, { kind: "text", text }), d.via === "orca");
    } finally {
      for (const p of prep.finally) runPrep(this.o.open, p);
    }
  }

  /**
   * AI が終わるのを待つ。turnlane ai run は終わりを知らせて（exit_code）から自分も終わるので、その tty から居なくなったところで
   * 終わったとみなす（知らせがデーモンに届かなかったときも、プロセスが居なければ終わっている）
   */
  async #waitExit(w: RunWhere): Promise<boolean> {
    for (let waited = 0; ; waited += POLL_MS) {
      if (!(await this.#onTty(w.pid, w.live.tty))) return true;
      if (waited >= this.o.waitMs) return false;
      await this.o.sleep(POLL_MS);
    }
  }

  async close(r: FinishLaunchRow): Promise<TerminalCloseResult> {
    const fail = (reason: LaunchFinishReason, app: string | null = null): TerminalCloseResult => ({
      terminal: reason === "unsupported" ? "not_closable" : "failed",
      reason,
      app,
    });
    // 動いていれば今の居場所、終わっていれば受け取りのときに覚えた居場所
    const fresh = r.exited_at === null ? await this.locate(r.id) : null;
    const w = fresh ?? this.#where.get(r.id) ?? null;
    if (!w) return fail("not_found");
    const d = await this.#delivery(r, w);
    if (!d.ok) return fail(d.reason === "unsupported" ? "unsupported" : "not_found", d.app);
    const app = d.app;
    // AI がまだ動いている: その tty にまだ turnlane ai run がいるときだけ終了の指示を送る
    if (fresh && (await this.#onTty(w.pid, w.live.tty))) {
      if (this.#inDialog(r)) return fail("ai_waiting", app);
      if (!(await this.#send(d, exitCommand(r.tool)))) return fail("send_failed", app);
      if (!(await this.#waitExit(w)))
        return { terminal: "ai_still_running", reason: "not_exited", app };
    }
    // タブを閉じる
    if (d.via === "orca") {
      const ok = await this.#run(
        [
          {
            argv: [
              ...orcaCli(d.orca),
              "terminal",
              "close",
              `--terminal=${d.handle}`,
              "--tab",
              "--json",
            ],
            timeoutMs: ORCA_CLOSE_TIMEOUT_MS,
          },
        ],
        false,
      );
      return ok ? this.#closed(r.id, app) : fail("send_failed", app);
    }
    if (d.via === "tmux" && w.shellPid === null) {
      // Turnlane が包んだ tmux のセッション: ペインのコマンドが終われば tmux が閉じる。ペインが残っていれば閉じられなかった
      const panes = parsePanes(
        (await this.o.open.capture?.([
          ...tmuxBase(d.pane),
          "list-panes",
          "-a",
          "-F",
          LIST_PANES_FORMAT,
        ])) ?? "",
      );
      return panes.some((p) => p.paneId === d.pane.paneId && p.tty === w.live.tty)
        ? fail("not_exited", app)
        : this.#closed(r.id, app);
    }
    // タブのシェルがまだ同じ tty にいるときだけ exit を送る
    if (!(await this.#onTty(w.shellPid, w.live.tty))) return fail("not_found", app);
    if (!(await this.#send(d, SHELL_EXIT))) return fail("send_failed", app);
    return this.#closed(r.id, app);
  }

  #closed(id: string, app: string | null): TerminalCloseResult {
    this.#where.delete(id);
    return { terminal: "closed", reason: null, app };
  }
}
