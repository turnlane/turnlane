/**
 * Turnlane から答える（D-238、ADR 0019）: 届け先の決め方と、端末ごとの送り方（純粋な関数。OS には触れない）。
 * 居場所は「開く」と同じ（D-217。tty → tmux のペイン → 端末のアプリ。open/locate.ts）。
 *
 * | 端末 | 送り方 |
 * |---|---|
 * | tmux の中（どの端末でも） | `tmux -u send-keys -t <ペイン> -l -- <文>` の後に `send-keys -t <ペイン> Enter`。末尾の `;` は tmux が |
 * |  | コマンドの区切りに読むので 16 進（`-H 3b`）で送る。改行は LF（Claude Code では Ctrl+J = 改行）のまま |
 * | iTerm2 | AppleScript で tty の一致するセッションに `write text`（末尾に改行 = Enter） |
 * | Terminal（ターミナル.app） | AppleScript で tty の一致するタブに `do script <文> in <タブ>`（文と Return をそのタブに入れる。 |
 * |  | 動いているプログラムがあればその入力に入る。D-243） |
 * | Orca | 同梱の CLI の `orca terminal send --terminal <h> --text=<文> --enter --wait-submit 5 --json`。受理（accepted）と |
 * |  | 送信の観測（stages の turn_started）を分けて読む |
 * | Ghostty（1.3 以降） | AppleScript に tty が無いので、「開く」の着地と同じ目印（tty に OSC 7 で一時的なフォルダを書き、 |
 * |  | `working directory` がそれの端末。open/focus.ts の GHOSTTY_MARKED）で端末を選び、`input text` の後に |
 * |  | `send key "enter"`。目印の端末が 1 つに決まらなければ送らない（同じフォルダの別のセッションに送らない）。 |
 * |  | AppleScript を切っている（`macos-applescript = false`）・1.3 より古いと分かれば unsupported。D-244 |
 * | Warp・Kitty・それ以外 | 送らない（動いているタブに文字を入れる口が無い） |
 *
 * どれも引数の配列で起動し、シェルを通さない（AppleScript には文を `item 2 of argv` で渡し、スクリプトに埋め込まない。
 * 引用符・バックスラッシュのエスケープが要らない。制御文字は prepareAnswer が除く）。文の改行は、改行を送れない端末では呼び出し側が 1 行に畳む（prepareAnswer）。
 * 許可待ちの「許可する」は `1` と Enter を別々に送る（Claude Code の許可のダイアログの 1 = Yes。今後も許可（2）は送らない）
 */
import { prepareAnswer } from "@turnlane/core";
import type { AnswerUndeliverable } from "@turnlane/core/api";
import type { FoundApp } from "../open/apps.ts";
import { GHOSTTY_MARKED, ghosttyMarkPrep, hostTerminal } from "../open/focus.ts";
import type { Prep, Step } from "../open/index.ts";
import { type LiveLocation, type TmuxPane, TTY, tmuxBase } from "../open/locate.ts";
import { type OrcaPick, orcaCli } from "../open/orca.ts";

const OSA = "/usr/bin/osascript";
const OSA_TIMEOUT_MS = 5_000;
const TMUX_TIMEOUT_MS = 3_000;
/** Orca の CLI が送信を観測する時間（秒）。CLI の打ち切りはその後ろに余裕を持たせる */
export const ORCA_WAIT_SUBMIT_S = 5;
const ORCA_TIMEOUT_MS = (ORCA_WAIT_SUBMIT_S + 15) * 1000;

/** iTerm2: tty が一致するセッションに文を書く（write text は末尾に改行を付ける = Enter）。見つからなければ失敗 */
export const ITERM_WRITE = `on run argv
  set want to item 1 of argv
  tell application "iTerm"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if tty of s is want then
            tell s to write text (item 2 of argv)
            return "ok"
          end if
        end repeat
      end repeat
    end repeat
  end tell
  error "no session" number 1
end run`;

/**
 * Terminal（ターミナル.app）: tty が一致するタブに文を入れる（do script は文と Return をそのタブに入れる。動いている
 * プログラムがあればその入力に入る。D-243）。見つからなければ失敗
 */
export const TERMINAL_WRITE = `on run argv
  set want to item 1 of argv
  tell application "Terminal"
    repeat with w in windows
      repeat with t in tabs of w
        if tty of t is want then
          do script (item 2 of argv) in t
          return "ok"
        end if
      end repeat
    end repeat
  end tell
  error "no tab" number 1
end run`;

/**
 * Ghostty（1.3 以降。D-244）: 目印のフォルダ（item 1）が working directory の端末が 1 つだけのとき、文（item 2）を入れて
 * Enter を送る。input text は貼り付けと同じ扱い。0 個なら「no terminal」(1)、2 個以上なら「ambiguous」(2) で失敗（送らない）
 */
export const GHOSTTY_WRITE = `on run argv
  set hits to markedTerminals(item 1 of argv)
  if (count of hits) is 0 then error "no terminal" number 1
  if (count of hits) > 1 then error "ambiguous" number 2
  set term to item 3 of (item 1 of hits)
  tell application "Ghostty" to input text (item 2 of argv) to term
  delay 0.1
  tell application "Ghostty" to send key "enter" to term
  return "ok"
end run

${GHOSTTY_MARKED}`;

// biome-ignore lint/suspicious/noControlCharactersInRegex: 端末に送る文から制御文字を除く（prepareAnswer の取り残し）
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

export type Delivery =
  | { ok: true; via: "tmux"; app: string; pane: TmuxPane }
  | { ok: true; via: "iterm"; app: string; tty: string }
  | { ok: true; via: "terminal"; app: string; tty: string }
  | { ok: true; via: "ghostty"; app: string; tty: string; cwd: string; marker: string }
  | { ok: true; via: "orca"; app: string; orca: FoundApp; handle: string }
  | { ok: false; app: string | null; reason: AnswerUndeliverable };

/** Ghostty の届け先を決める材料（D-244）。cwd は目印の後に戻す作業フォルダ、scriptable は open/ghostty.ts の判定 */
export interface GhosttyContext {
  cwd: string | null;
  marker: string;
  scriptable: boolean | null;
}

/**
 * 居場所 → 届け先。tmux の中なら外側の端末に関係なく tmux で送る。iTerm2・Terminal は tty、Orca は選んだ端末のハンドル
 * （書き込めるものだけ）、Ghostty は tty と cwd（目印を書いて戻す。AppleScript が使えないと分かれば unsupported。D-244）。
 * それ以外の端末は unsupported
 */
export function resolveDelivery(
  live: LiveLocation | null,
  orca: { app: FoundApp; pick: OrcaPick; writable: boolean } | null | undefined,
  ghostty?: GhosttyContext,
): Delivery {
  if (!live) return { ok: false, app: null, reason: "not_live" };
  const app = live.host ? hostTerminal(live.host).name : null;
  if (live.tmux) return { ok: true, via: "tmux", app: app ?? "tmux", pane: live.tmux };
  if (!live.host) return { ok: false, app: null, reason: "not_found" };
  const term = hostTerminal(live.host);
  if (term.kind === "iterm" || term.kind === "terminal") {
    if (live.tty && TTY.test(live.tty))
      return { ok: true, via: term.kind, app: term.name, tty: live.tty };
    return { ok: false, app: term.name, reason: "not_found" };
  }
  if (term.kind === "ghostty") {
    if (ghostty?.scriptable === false) return { ok: false, app: term.name, reason: "unsupported" };
    if (live.tty && TTY.test(live.tty) && ghostty?.cwd)
      return {
        ok: true,
        via: "ghostty",
        app: term.name,
        tty: live.tty,
        cwd: ghostty.cwd,
        marker: ghostty.marker,
      };
    return { ok: false, app: term.name, reason: "not_found" };
  }
  if (term.kind === "orca") {
    if (orca?.pick.handle && orca.writable)
      return { ok: true, via: "orca", app: term.name, orca: orca.app, handle: orca.pick.handle };
    return { ok: false, app: term.name, reason: "not_found" };
  }
  return { ok: false, app: term.name, reason: "unsupported" };
}

/** 改行をそのまま送れるか（tmux の Claude Code だけ。Ctrl+J が改行。ほかは 1 行に畳む） */
export function sendsNewlines(d: Delivery, tool: string | null): boolean {
  return d.ok && d.via === "tmux" && tool === "claude_code";
}

/**
 * 送る文の組み立て（ツールごと。Issue #10）。
 * - Claude Code: 改行を送れる届け先（tmux の Ctrl+J）なら改行のまま、ほかは 1 行に畳む
 * - Codex: いつも 1 行に畳む。Codex の TUI の入力欄で改行を入れるキーは端末と設定で違い（Enter は送信）、tmux から
 *   確かに改行にする送り方が分からないため（仮置き）。選択肢の番号（`1`）は文字のまま送る（Codex の問いは文で答える
 *   もので、Claude Code の AskUserQuestion のような番号のダイアログは無い）。許可する（`1`）は送らない（canAllow）
 */
export function answerText(
  tool: string | null,
  d: Delivery,
  text: string,
): { text: string; folded: boolean } | null {
  return prepareAnswer(text, tool === "codex" ? false : sendsNewlines(d, tool));
}

/** tmux: 文を文字のまま送る（末尾の `;` は 16 進で）。Enter は enterStep で別に送る */
export function tmuxTextSteps(p: TmuxPane, text: string): Step[] {
  const base = [...tmuxBase(p), "send-keys", "-t", p.paneId];
  const m = /;+$/.exec(text);
  const body = m ? text.slice(0, m.index) : text;
  const semis = m ? m[0].length : 0;
  const out: Step[] = [];
  if (body) out.push({ argv: [...base, "-l", "--", body], timeoutMs: TMUX_TIMEOUT_MS });
  if (semis > 0)
    out.push({ argv: [...base, "-H", ...Array(semis).fill("3b")], timeoutMs: TMUX_TIMEOUT_MS });
  return out;
}

export function tmuxEnterStep(p: TmuxPane): Step {
  return {
    argv: [...tmuxBase(p), "send-keys", "-t", p.paneId, "Enter"],
    timeoutMs: TMUX_TIMEOUT_MS,
  };
}

/** Orca: 文と Enter（送信を観測する）。`--text=` の形で渡す（`--` で始まる文を旗と読ませない） */
export function orcaSendStep(app: FoundApp, handle: string, text: string): Step {
  return {
    argv: [
      ...orcaCli(app),
      "terminal",
      "send",
      `--terminal=${handle}`,
      `--text=${text}`,
      "--enter",
      "--wait-submit",
      String(ORCA_WAIT_SUBMIT_S),
      "--json",
    ],
    timeoutMs: ORCA_TIMEOUT_MS,
  };
}

/** Orca: 文字だけ（Enter なし）／ Enter だけ（許可のダイアログの番号と確定） */
export function orcaRawStep(
  app: FoundApp,
  handle: string,
  input: { text: string } | "enter",
): Step {
  return {
    argv: [
      ...orcaCli(app),
      "terminal",
      "send",
      `--terminal=${handle}`,
      ...(input === "enter" ? ["--enter"] : [`--text=${input.text}`]),
      "--json",
    ],
    timeoutMs: ORCA_TIMEOUT_MS,
  };
}

/**
 * 届け先 → 送る手順。kind = text は文と Enter、allow は許可のダイアログの `1` と Enter
 */
export function planSend(
  d: Extract<Delivery, { ok: true }>,
  input: { kind: "text"; text: string } | { kind: "allow" },
): Step[] {
  const text = input.kind === "allow" ? "1" : input.text;
  switch (d.via) {
    case "tmux":
      return [...tmuxTextSteps(d.pane, text), tmuxEnterStep(d.pane)];
    case "iterm":
      return [{ argv: [OSA, "-e", ITERM_WRITE, d.tty, text], timeoutMs: OSA_TIMEOUT_MS }];
    case "terminal":
      // do script は改行ごとに Return になるので、畳み残しがあっても 1 行で送る（prepareAnswer が先に畳む）
      return [
        {
          argv: [OSA, "-e", TERMINAL_WRITE, d.tty, text.replace(/[\r\n]+/g, " ")],
          timeoutMs: OSA_TIMEOUT_MS,
        },
      ];
    case "ghostty":
      // 貼り付けと同じ扱いなので、改行（Enter になる）と制御文字（貼り付けの外に出る ESC など）を残さない
      return [
        {
          argv: [
            OSA,
            "-e",
            GHOSTTY_WRITE,
            d.marker,
            text.replace(/[\r\n\t]+/g, " ").replace(CONTROL, ""),
          ],
          timeoutMs: OSA_TIMEOUT_MS,
        },
      ];
    case "orca":
      return input.kind === "allow"
        ? [orcaRawStep(d.orca, d.handle, { text }), orcaRawStep(d.orca, d.handle, "enter")]
        : [orcaSendStep(d.orca, d.handle, text)];
  }
}

/** 送る前後の下ごしらえ（Ghostty の目印。「開く」と同じもの）。ほかの端末は無し */
export function sendPrep(d: Extract<Delivery, { ok: true }>): { prepare: Prep[]; finally: Prep[] } {
  return d.via === "ghostty"
    ? ghosttyMarkPrep(d.tty, d.marker, d.cwd)
    : { prepare: [], finally: [] };
}

/**
 * Ghostty に送れなかった理由（osascript の失敗）。目印の端末が 0 個・複数（GHOSTTY_WRITE の 1・2）は not_found、
 * 打ち切り・自動化の拒否は send_failed（許可のダイアログ待ちかもしれない）、それ以外（AppleScript を切っている・古い版で
 * 口が無い）は unsupported。どれも文は入っていない
 */
export function ghosttyFailure(r: {
  stderr?: string;
  timedOut?: boolean;
}): "not_found" | "unsupported" | "send_failed" {
  const err = r.stderr ?? "";
  if (r.timedOut || /-1743|not authorized/i.test(err)) return "send_failed";
  if (/\((1|2)\)\s*$/.test(err.trim())) return "not_found";
  return "unsupported";
}

/**
 * `orca terminal send --json` の出力 → 受理（accepted）と送信の観測（turn_started）。読めなければどちらも false
 */
export function parseOrcaSend(out: string): { accepted: boolean; observed: boolean } {
  try {
    const v = JSON.parse(out) as {
      result?: { send?: { accepted?: unknown; prompt?: { stages?: unknown } } };
    };
    const send = v.result?.send;
    const stages = Array.isArray(send?.prompt?.stages) ? (send?.prompt?.stages as unknown[]) : [];
    return { accepted: send?.accepted === true, observed: stages.includes("turn_started") };
  } catch {
    return { accepted: false, observed: false };
  }
}
