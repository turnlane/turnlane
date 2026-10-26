/**
 * 動いているセッションのタブ（ペイン）を前に出す手順の組み立て（D-214 (4)。desktop-shell.md 4.4、ADR 0014 の追記）。
 * 居場所（locate.ts）から、試す順の開き方（Attempt）を作る純粋な関数。探す順は tty → tmux のペイン → cwd → アプリ。
 *
 * | 端末 | タブの選び方 |
 * |---|---|
 * | iTerm2 | AppleScript で `tty of session` が一致するセッションを選ぶ |
 * | Terminal | AppleScript で `tty of tab` が一致するタブを選び、ウインドウを前に出す（答えるの届け先と同じ tty。D-243） |
 * | Ghostty | AppleScript に tty が無いので、tty に OSC 7（作業フォルダの報告）で一時的な目印のフォルダを書き、
 * |         | `working directory` がその目印の端末を選んでから元の cwd に戻す（approach after cctop, MIT。答えるの届け先も同じ。D-244）。
 * |         | できなければ cwd の一致（同じ cwd が複数なら1つ目を前に出し、そう言う） |
 * | tmux の中 | `select-window` と `select-pane`（クライアントが別のセッションなら `switch-client`）の後、クライアントの tty で上の端末のタブを選ぶ |
 * | Orca | 同梱の CLI の `orca terminal switch --terminal <ハンドル>` でそのタブに切り替える（D-238）。ハンドルは hooks が記録した |
 * |      | ORCA_TERMINAL_HANDLE、無ければ `orca terminal list` の worktree が cwd を含む端末が 1 つだけのとき。list の画面の中身 |
 * |      | （preview）・題名は読まずに捨てる（open/orca.ts の parseOrcaTerminals）。選べなければアプリを前に出すだけ |
 * | Warp・それ以外 | アプリを前に出すだけ（タブを選ぶ手段が無い） |
 */

import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { OpenLanding } from "@turnlane/core/api";
import type { FoundApp } from "./apps.ts";
import type { Attempt, Prep, Step } from "./index.ts";
import { type LiveLocation, TTY, tmuxBase } from "./locate.ts";
import { type OrcaPick, orcaSwitch } from "./orca.ts";

const OPEN = "/usr/bin/open";
const OSA = "/usr/bin/osascript";
/** オートメーションの許可の確認ダイアログで待たされるので短く打ち切る（open/index.ts の OSA_TIMEOUT_MS と同じ） */
const OSA_TIMEOUT_MS = 5_000;
const TMUX_TIMEOUT_MS = 3_000;

/** iTerm2: tty が一致するセッションのタブとウインドウを選ぶ。タブの番号を返す */
export const ITERM_FOCUS = `on run argv
  set want to item 1 of argv
  tell application "iTerm"
    repeat with w in windows
      set i to 0
      repeat with t in tabs of w
        set i to i + 1
        repeat with s in sessions of t
          if tty of s is want then
            set miniaturized of w to false
            set index of w to 1
            tell t to select
            tell s to select
            activate
            return i as text
          end if
        end repeat
      end repeat
    end repeat
  end tell
  error "no session" number 1
end run`;

/** Terminal: tty が一致するタブを選び、ウインドウを前に出す。タブの番号を返す */
export const TERMINAL_FOCUS = `on run argv
  set want to item 1 of argv
  tell application "Terminal"
    repeat with w in windows
      set i to 0
      repeat with t in tabs of w
        set i to i + 1
        if tty of t is want then
          set miniaturized of w to false
          set selected of t to true
          set index of w to 1
          activate
          return i as text
        end if
      end repeat
    end repeat
  end tell
  error "no tab" number 1
end run`;

/**
 * Ghostty: working directory が目印のフォルダ（末尾の / も）の端末を集める（OSC 7 が反映されるまで少し待つ）。
 * 「開く」の着地（GHOSTTY_FOCUS_MARK）と答えるの届け先（answer/deliver.ts の GHOSTTY_WRITE。D-244）が同じ判定を使う
 * （スクリプトの末尾に足す）。返すのは {ウインドウ, タブ, 端末} の並び
 */
export const GHOSTTY_MARKED = `on markedTerminals(want)
  tell application "Ghostty"
    repeat 6 times
      set hits to {}
      repeat with w in windows
        repeat with t in tabs of w
          repeat with term in terminals of t
            set d to working directory of term
            if d is want or d is (want & "/") then set end of hits to {contents of w, contents of t, contents of term}
          end repeat
        end repeat
      end repeat
      if (count of hits) > 0 then return hits
      delay 0.05
    end repeat
  end tell
  return {}
end markedTerminals`;

/** Ghostty: 目印の端末（1 つ目）を選ぶ。タブの番号を返す */
export const GHOSTTY_FOCUS_MARK = `on run argv
  set hits to markedTerminals(item 1 of argv)
  if (count of hits) is 0 then error "no terminal" number 1
  set hit to item 1 of hits
  tell application "Ghostty"
    activate window (item 1 of hit)
    select tab (item 2 of hit)
    focus (item 3 of hit)
    activate
    return (index of (item 2 of hit)) as text
  end tell
end run

${GHOSTTY_MARKED}`;

/** Ghostty: cwd が一致する端末の1つ目を選ぶ。「タブの番号 一致した数」を返す。無ければ失敗 */
export const GHOSTTY_FOCUS_CWD = `on run argv
  set want to item 1 of argv
  set hit to missing value
  set n to 0
  tell application "Ghostty"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with term in terminals of t
          set d to working directory of term
          if d is want or d is (want & "/") then
            set n to n + 1
            if hit is missing value then set hit to {w, t, term}
          end if
        end repeat
      end repeat
    end repeat
    if hit is missing value then error "no terminal" number 1
    activate window (item 1 of hit)
    select tab (item 2 of hit)
    focus (item 3 of hit)
    activate
    return ((index of (item 2 of hit)) as text) & " " & (n as text)
  end tell
end run`;

/**
 * OSC 7（作業フォルダの報告）。Ghostty はホストが localhost か自分のホスト名のときだけ受け付ける
 * （approach after cctop, MIT）
 */
export function osc7(dir: string): string {
  return `\u001b]7;file://localhost${encodeURI(dir)}\u0007`;
}

/** Ghostty の目印のフォルダ（一意な名前。作るのは Prep） */
export function ghosttyMarker(): string {
  return join(tmpdir(), `turnlane-focus-${randomBytes(6).toString("hex")}`);
}

/**
 * Ghostty の目印の下ごしらえ: 目印のフォルダを作り、tty に OSC 7 で目印を書く。後で（成功しても失敗しても）元の cwd に
 * 戻してフォルダを消す。「開く」の着地と答えるの届け先（D-244）で同じものを使う
 */
export function ghosttyMarkPrep(
  tty: string,
  marker: string,
  cwd: string,
): { prepare: Prep[]; finally: Prep[] } {
  return {
    prepare: [{ mkdir: marker }, { tty, write: osc7(marker) }],
    finally: [{ tty, write: osc7(cwd) }, { rmdir: marker }],
  };
}

type TermKind = "ghostty" | "iterm" | "terminal" | "orca" | "other";

/** `.app` のパス → 端末の種類と表示名 */
export function hostTerminal(host: string): { kind: TermKind; name: string } {
  const b = basename(host).replace(/\.app$/, "");
  if (b === "Ghostty") return { kind: "ghostty", name: "Ghostty" };
  if (b === "iTerm" || b === "iTerm2") return { kind: "iterm", name: "iTerm2" };
  if (b === "Terminal") return { kind: "terminal", name: "Terminal" };
  if (b === "Orca") return { kind: "orca", name: "Orca" };
  return { kind: "other", name: b };
}

const landing = (l: Partial<OpenLanding> & Pick<OpenLanding, "level">): OpenLanding => ({
  by: null,
  tab: null,
  pane: null,
  miss: null,
  ...l,
});

export interface FocusOptions {
  /** セッションの cwd（Ghostty の cwd の一致と、目印の後に戻す作業フォルダ） */
  cwd: string | null;
  /** Ghostty の目印のフォルダ（呼び出し側が一意な名前を決める。作るのは Prep） */
  marker: string;
  /** 居場所の分からないときに前に出す、設定の端末 */
  fallback: { path: string; name: string } | null;
  /** Orca の中のセッション: Orca のアプリと選んだ端末（D-238。調べていなければ省く） */
  orca?: { app: FoundApp; pick: OrcaPick } | null;
}

/** 居場所 → 試す順の開き方。どれも outcome は focused で、landing に着地を書く */
export function planLiveFocus(loc: LiveLocation, o: FocusOptions): Attempt[] {
  const out: Attempt[] = [];
  const mux = loc.tmux;
  const pane = mux?.label ?? null;
  // tmux: ペインのウインドウとペインを選ぶ（クライアントが別のセッションを見ていれば切り替える）
  const tmuxSteps: Step[] = mux
    ? [
        ...(mux.switchClient && mux.client
          ? [
              {
                argv: [...tmuxBase(mux), "switch-client", "-c", mux.client.tty, "-t", mux.paneId],
                timeoutMs: TMUX_TIMEOUT_MS,
              },
            ]
          : []),
        {
          argv: [...tmuxBase(mux), "select-window", "-t", mux.paneId],
          timeoutMs: TMUX_TIMEOUT_MS,
        },
        {
          argv: [...tmuxBase(mux), "select-pane", "-t", mux.paneId],
          timeoutMs: TMUX_TIMEOUT_MS,
        },
      ]
    : [];
  // 端末のアプリから見た tty（tmux の中ならクライアントの tty）
  const termTty = mux ? (mux.client?.tty ?? null) : loc.tty;
  const tty = termTty && TTY.test(termTty) ? termTty : null;
  const host = loc.host;
  if (!host) {
    // 端末のアプリが分からない（tmux にクライアントがつながっていない等）: ペインだけ選び、設定の端末を前に出す
    const f = o.fallback;
    if (mux && f)
      out.push({
        steps: [...tmuxSteps, { argv: [OPEN, "-a", f.path] }],
        outcome: "focused",
        app: f.name,
        landing: landing({ level: "app", pane, miss: "not_found" }),
      });
    if (f)
      out.push({
        steps: [{ argv: [OPEN, "-a", f.path] }],
        outcome: "focused",
        app: f.name,
        landing: landing({ level: "app", miss: "not_found" }),
      });
    return out;
  }
  const term = hostTerminal(host);
  const tabByTty = (script: string): Attempt => ({
    steps: [...tmuxSteps, { argv: [OSA, "-e", script, tty as string], timeoutMs: OSA_TIMEOUT_MS }],
    outcome: "focused",
    app: term.name,
    landing: landing({ level: "tab", by: "tty", pane }),
    tabFromOutput: true,
  });
  // 1. tty（tmux の中なら、ペインを選んでからクライアントの tty）
  if (tty && term.kind === "iterm") out.push(tabByTty(ITERM_FOCUS));
  if (tty && term.kind === "terminal") out.push(tabByTty(TERMINAL_FOCUS));
  if (tty && term.kind === "ghostty" && o.cwd) {
    out.push({
      ...tabByTty(GHOSTTY_FOCUS_MARK),
      steps: [
        ...tmuxSteps,
        { argv: [OSA, "-e", GHOSTTY_FOCUS_MARK, o.marker], timeoutMs: OSA_TIMEOUT_MS },
      ],
      // 目印は成功しても失敗しても戻す
      ...ghosttyMarkPrep(tty, o.marker, o.cwd),
    });
  }
  // Orca: そのタブに切り替えて前に出す（D-238）
  if (term.kind === "orca" && o.orca?.pick.handle)
    out.push({
      steps: [
        ...tmuxSteps,
        orcaSwitch(o.orca.app, o.orca.pick.handle),
        { argv: [OPEN, "-a", host] },
      ],
      outcome: "focused",
      app: term.name,
      landing: landing({ level: "tab", by: o.orca.pick.by, pane }),
    });
  // 2. cwd（Ghostty。tmux の中では端末の cwd がセッションの cwd と限らないので使わない）
  if (term.kind === "ghostty" && o.cwd && !mux)
    out.push({
      steps: [{ argv: [OSA, "-e", GHOSTTY_FOCUS_CWD, o.cwd], timeoutMs: OSA_TIMEOUT_MS }],
      outcome: "focused",
      app: term.name,
      landing: landing({ level: "tab", by: "cwd" }),
      tabFromOutput: true,
    });
  // 3. アプリを前に出す（tmux ならペインは選ぶ）
  const miss =
    term.kind === "other"
      ? "unsupported"
      : term.kind === "orca" && !o.orca
        ? "unsupported"
        : "not_found";
  if (mux)
    out.push({
      steps: [...tmuxSteps, { argv: [OPEN, "-a", host] }],
      outcome: "focused",
      app: term.name,
      landing: landing({ level: "app", pane, miss }),
    });
  out.push({
    steps: [{ argv: [OPEN, "-a", host] }],
    outcome: "focused",
    app: term.name,
    landing: landing({ level: "app", miss }),
  });
  return out;
}

/** AppleScript の返した「タブの番号 [一致した数]」を着地に足す */
export function withTab(l: OpenLanding, stdout: string): OpenLanding {
  const m = /^\s*(\d+)(?:\s+(\d+))?\s*$/.exec(stdout);
  if (!m) return l;
  const tab = Number(m[1]);
  const n = m[2] ? Number(m[2]) : null;
  return {
    ...l,
    tab: tab > 0 ? tab : null,
    ...(n !== null && n > 1 ? { miss: "ambiguous" as const, candidates: n } : {}),
  };
}
