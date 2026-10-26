/**
 * 依頼した AI をいつもの端末の新しいタブで起動する（D-107。plan §B.1）。端末に渡すのは `'<dl>' ai run <起動 ID>` だけで、
 * 題名・メモ・指示はシェルを通らない（turnlane ai run がデーモンから受け取り、引数の配列で起動する）。起動 ID は16進なので
 * どの段（AppleScript → 端末 → シェル）でもエスケープが要らない。
 *
 * | 端末 | 開き方 |
 * |---|---|
 * | Ghostty（1.3 以降） | `new tab in front window`（ウインドウが無ければ `new window`）。initial input の末尾の改行で実行 |
 * | iTerm2 | `create tab with default profile`（無ければ `create window`）→ `write text` |
 * | Terminal | `do script`（新しいウインドウ。タブはキー操作の偽装が要るので使わない） |
 * | Orca | 同梱の CLI の `orca terminal create --worktree path:<cwd> --command <dl ai run> --title <題名> --focus`。
 * |      | Orca に登録していないリポジトリは `orca repo add` してから作り直す（open/orca.ts。D-122） |
 * | それ以外（Warp など） | 端末を cwd で開き、コマンドをコピー |
 *
 * 送る口の無い端末（Warp などコピーに落ちる端末）では、設定「送れない端末では tmux で包む」
 * （launch.tmux_wrap。既定オン）がオンで tmux が入っていれば、`tmux new-session -s turnlane-<起動 ID の 8 桁>` の中で起動する
 * （そのタブが tmux のセッションにつながる）。Turnlane から答える（D-238）の届け先が tmux のペインになり、送れるようになる。
 * iTerm2・Terminal（D-243）・Orca・Ghostty（1.3 以降。D-244）は送れるので包まない（Terminal は tmux の無い Mac でも答えられる）。
 * Ghostty でも AppleScript を切っている・1.3 より古いと分かれば、また判定できなければ包む（open/ghostty.ts）。
 *
 * どれも失敗したら（オートメーションの許可を拒否された等）コピーだけに落とす。
 * 人のいないとき（unattended。拡張の時刻・条件による起動）は、Orca を前面に出さず、コピーには落とさない。
 * 画面のロック中に待つかは端末で決まる（unattendedWaitsWhileLocked）。
 */

import type { FoundApp } from "../open/apps.ts";
import { type Attempt, OSA_TIMEOUT_MS } from "../open/index.ts";
import { planOrca } from "../open/orca.ts";
import { shq } from "../open/target.ts";

const OPEN = "/usr/bin/open";
const OSA = "/usr/bin/osascript";

/** Ghostty: cwd で新しいタブ（無ければウインドウ）を開き、コマンドを入力して実行する */
export const GHOSTTY_RUN = `on run argv
  tell application "Ghostty"
    set cfg to new surface configuration
    set initial working directory of cfg to item 1 of argv
    set initial input of cfg to (item 2 of argv) & linefeed
    if (count of windows) > 0 then
      new tab in front window with configuration cfg
    else
      new window with configuration cfg
    end if
    activate
  end tell
end run`;

/** iTerm2: 新しいタブ（無ければウインドウ）で実行する */
export const ITERM_RUN = `on run argv
  tell application "iTerm"
    activate
    if (count of windows) = 0 then
      create window with default profile
    else
      tell current window to create tab with default profile
    end if
    tell current session of current window to write text (item 1 of argv)
  end tell
end run`;

/** Terminal: 新しいウインドウで実行する */
export const TERMINAL_RUN = `on run argv
  tell application "Terminal"
    activate
    do script (item 1 of argv)
  end tell
end run`;

const LAUNCH_ID = /^[0-9a-f]{32}$/;

/**
 * 人のいないときの起動で、画面のロック中は開かずに待つか（ロックが外れてから起動する）。S8 の結果
 * （docs/spikes/s8-launch-while-locked.md）から、ロック中に開けると確かめた Orca だけ待たない。Ghostty はロック中に開くと
 * 端末が立たず、Terminal.app・それ以外は確かめていないので待つ。
 * ロックは CGSSessionScreenIsLocked だけで見るので、パスワードを求めるスクリーンセーバーもロックと同じ扱いになる。
 * ロックしていないスクリーンセーバー・ディスプレイのスリープは、どの端末でも待たない
 */
export function unattendedWaitsWhileLocked(term: FoundApp | null): boolean {
  return term?.id !== "orca";
}

/**
 * tmux で包む端末（送る口が無い。D-238）。iTerm2・Terminal（D-243）・Orca は送れるので包まない。Ghostty は 1.3 以降の
 * AppleScript で送れるので包まない（D-244）。ただし AppleScript を切っている（`macos-applescript = false`）・1.3 より古いと
 * 分かったとき（ghosttyScriptable が false）と、判定できないとき（null・省略）は包む（D-244）
 */
export function wrapsInTmux(term: FoundApp | null, ghosttyScriptable?: boolean | null): boolean {
  if (term?.id === "ghostty") return ghosttyScriptable !== true;
  return term?.id !== "iterm" && term?.id !== "terminal" && term?.id !== "orca";
}

/** tmux のセッションの名前（起動 ID の先頭 8 桁） */
export function tmuxSessionName(launchId: string): string {
  return `turnlane-${launchId.slice(0, 8)}`;
}

/**
 * 端末に入力するコマンド（cd 付きはコピー・iTerm・Terminal 用）。tmux（絶対パス）を渡すと tmux の新しいセッションの中で
 * 起動する（入れ子にしないよう TMUX を外す。-c で作業フォルダ）
 */
export function runCommand(
  cli: string,
  launchId: string,
  cwd: string | null,
  tmux: string | null = null,
  tmuxCwd: string | null = cwd,
): string {
  if (!LAUNCH_ID.test(launchId)) throw new Error("bad launch id");
  const ai = `${shq(cli)} ai run ${launchId}`;
  const run = tmux
    ? `env -u TMUX ${shq(tmux)} new-session -s ${tmuxSessionName(launchId)}${
        tmuxCwd ? ` -c ${shq(tmuxCwd)}` : ""
      } ${ai}`
    : ai;
  return cwd ? `cd ${shq(cwd)} && ${run}` : run;
}

/** 端末 → 試す順の開き方（open/index.ts の Attempt と同じ形） */
export function planLaunch(
  term: FoundApp | null,
  cli: string,
  launchId: string,
  cwd: string,
  o: {
    title?: string;
    repo?: string;
    unattended?: boolean;
    /** tmux の絶対パス（送れない端末を tmux で包むとき。D-238）。iTerm2・Terminal・Orca・Ghostty では使わない */
    tmux?: string | null;
    /** Ghostty の AppleScript が使えるか（open/ghostty.ts。true でなければ Ghostty も包む。D-244） */
    ghosttyScriptable?: boolean | null;
  } = {},
): Attempt[] {
  const tmux = o.tmux && wrapsInTmux(term, o.ghosttyScriptable) ? o.tmux : null;
  const withCd = runCommand(cli, launchId, cwd, tmux);
  const out: Attempt[] = [];
  if (term?.id === "orca")
    out.push(
      ...planOrca(
        term,
        {
          worktree: cwd,
          command: runCommand(cli, launchId, null),
          title: o.title,
          repo: o.repo,
          // 人のいないときは前面に出さない
          ...(o.unattended ? { focus: false } : {}),
        },
        "typed",
      ),
    );
  else if (term?.id === "ghostty")
    out.push({
      steps: [
        {
          argv: [OSA, "-e", GHOSTTY_RUN, cwd, runCommand(cli, launchId, null, tmux, cwd)],
          timeoutMs: OSA_TIMEOUT_MS,
        },
      ],
      outcome: "typed",
      app: term.name,
    });
  else if (term?.id === "iterm")
    out.push({
      steps: [{ argv: [OSA, "-e", ITERM_RUN, withCd], timeoutMs: OSA_TIMEOUT_MS }],
      outcome: "typed",
      app: term.name,
    });
  else if (term?.id === "terminal")
    out.push({
      steps: [{ argv: [OSA, "-e", TERMINAL_RUN, withCd], timeoutMs: OSA_TIMEOUT_MS }],
      outcome: "typed",
      app: term.name,
    });
  // 人のいないときはコピーに落とさない（貼る人がいない）。開けなければ呼び出し側に返す
  if (o.unattended) return out;
  if (term)
    out.push({
      // Orca はフォルダを渡さず前面に出すだけ（open/orca.ts）
      steps: [
        { argv: term.id === "orca" ? [OPEN, "-a", term.path] : [OPEN, "-a", term.path, cwd] },
      ],
      outcome: "opened_copied",
      app: term.name,
      copy: withCd,
    });
  out.push({ steps: [], outcome: "copied", app: null, copy: withCd });
  return out;
}

/**
 * フォルダの信頼のために、端末で claude をそのフォルダで開くコマンド（人が操作する。Turnlane は信頼を書かない）。
 * アカウントは起動と同じ（claudeAccountEnv）: CLAUDE_CONFIG_DIR を付ける・消す・そのまま
 */
export function trustCommand(env: { set: Record<string, string>; unset: string[] }): string {
  const dir = env.set.CLAUDE_CONFIG_DIR;
  if (dir) return `CLAUDE_CONFIG_DIR=${shq(dir)} claude`;
  return env.unset.includes("CLAUDE_CONFIG_DIR") ? "env -u CLAUDE_CONFIG_DIR claude" : "claude";
}

/** 端末 → 試す順の開き方（人が見ている前で開く。前面に出す。開けなければコピー） */
export function planShell(
  term: FoundApp | null,
  cwd: string,
  command: string,
  o: { title?: string; repo?: string } = {},
): Attempt[] {
  const withCd = `cd ${shq(cwd)} && ${command}`;
  const out: Attempt[] = [];
  if (term?.id === "orca")
    out.push(...planOrca(term, { worktree: cwd, command, title: o.title, repo: o.repo }, "typed"));
  else if (term?.id === "ghostty")
    out.push({
      steps: [{ argv: [OSA, "-e", GHOSTTY_RUN, cwd, command], timeoutMs: OSA_TIMEOUT_MS }],
      outcome: "typed",
      app: term.name,
    });
  else if (term?.id === "iterm")
    out.push({
      steps: [{ argv: [OSA, "-e", ITERM_RUN, withCd], timeoutMs: OSA_TIMEOUT_MS }],
      outcome: "typed",
      app: term.name,
    });
  else if (term?.id === "terminal")
    out.push({
      steps: [{ argv: [OSA, "-e", TERMINAL_RUN, withCd], timeoutMs: OSA_TIMEOUT_MS }],
      outcome: "typed",
      app: term.name,
    });
  if (term)
    out.push({
      steps: [
        { argv: term.id === "orca" ? [OPEN, "-a", term.path] : [OPEN, "-a", term.path, cwd] },
      ],
      outcome: "opened_copied",
      app: term.name,
      copy: withCd,
    });
  out.push({ steps: [], outcome: "copied", app: null, copy: withCd });
  return out;
}
