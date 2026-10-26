/**
 * turnlane ai run <起動 ID>（D-107。plan §B.1）: 端末の新しいタブで Turnlane が実行させるコマンド。
 * デーモンから起動 ID で1回だけ cwd と起動の引数を受け取り、Claude Code / Codex を引数の配列で起動する（題名・メモ・指示は
 * シェルを通らない）。子の終了コードをそのまま返す。Ctrl-C は子に任せ、turnlane は無視する。
 * 子には TURNLANE_LAUNCH_ID を渡す（hooks が引き継げばセッションとの紐づけに使える）。
 * 子が終わったら、終了コードと始めてから終わるまでの時間をデーモンに知らせる（セッションが見つからないときの理由。本文は送らない）。
 * すぐに（QUICK_EXIT_MS より前に）0 以外で終わったときは、その旨を1行出す（端末のタブはシェルに戻るので、上のエラーを読める）
 */
import { statSync } from "node:fs";
import type { AiLaunchClaim } from "@turnlane/core/api";
import { callApi, daemonHealth } from "../client.ts";
import type { CliEnv } from "../env.ts";
import { tr } from "../lang.ts";

export interface AiRunDeps {
  /** コマンド名 → 絶対パス（ログインシェルの PATH） */
  which(cmd: string): string | null;
  /** 子を端末につないで起動し、終了コードを返す */
  spawn(
    argv: string[],
    o: { cwd: string; env: Record<string, string | undefined> },
  ): Promise<number>;
  /** Ctrl-C を子に任せる（turnlane 自身は終わらない） */
  ignoreInterrupt(): void;
  isDir(path: string): boolean;
  /** 時刻（ms） */
  now(): number;
}

export const systemAiRun: AiRunDeps = {
  which: (cmd) => Bun.which(cmd),
  async spawn(argv, o) {
    const p = Bun.spawn(argv, {
      cwd: o.cwd,
      env: o.env,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    return await p.exited;
  },
  ignoreInterrupt() {
    process.on("SIGINT", () => {});
  },
  isDir(path) {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  },
  now: () => Date.now(),
};

const ID = /^[0-9a-f]{32}$/;
const COMMAND: Record<string, string> = { claude: "Claude Code", codex: "Codex" };
/** これより前に 0 以外で終わったら、すぐに終わったと1行出す */
export const QUICK_EXIT_MS = 30_000;

export async function aiRunCommand(
  env: CliEnv,
  id: string | undefined,
  deps: AiRunDeps = systemAiRun,
): Promise<number> {
  if (!id || !ID.test(id)) {
    env.err(
      tr(
        "Usage: turnlane ai run <launch ID> (Turnlane's Ask AI types this into the terminal)",
        "使い方: turnlane ai run <起動 ID>（Turnlane の「AI に頼む」が端末に入力します）",
      ),
    );
    return 2;
  }
  if (!(await daemonHealth(env))) {
    env.err(
      tr(
        "Turnlane's background service (turnlaned) isn't running. Run turnlane daemon start, then ask AI again.",
        "Turnlane のバックグラウンド（turnlaned）が動いていません。turnlane daemon start を実行してから、もう一度 AI に頼んでください。",
      ),
    );
    return 1;
  }
  const res = await callApi<AiLaunchClaim | { error: string }>(
    env.paths,
    "POST",
    `/api/ai/launches/${id}/claim`,
  );
  if (!res.ok || !("argv" in res.data)) {
    env.err(
      res.status === 409
        ? tr(
            "This request has expired or was already picked up. Ask AI again from Turnlane.",
            "この依頼は期限切れか、受け取り済みです。Turnlane からもう一度 AI に頼んでください。",
          )
        : tr(
            `Could not pick up the request (HTTP ${res.status})`,
            `依頼を受け取れませんでした（HTTP ${res.status}）`,
          ),
    );
    return 1;
  }
  const c = res.data;
  const [cmd, ...args] = c.argv;
  const bin = cmd ? deps.which(cmd) : null;
  if (!cmd || !bin) {
    await callApi(env.paths, "POST", `/api/ai/launches/${id}/fail`, { reason: "cli_missing" });
    const name = COMMAND[cmd ?? ""] ?? cmd ?? "AI";
    env.err(
      tr(
        `Could not find the ${name} command (${cmd}).`,
        `${name} のコマンド（${cmd}）が見つかりません。`,
      ),
    );
    return 127;
  }
  if (!deps.isDir(c.cwd)) {
    env.err(
      tr(`The working folder doesn't exist: ${c.cwd}`, `作業するフォルダがありません: ${c.cwd}`),
    );
    return 1;
  }
  deps.ignoreInterrupt();
  try {
    // 選んだ Claude のアカウント（D-122）: CLAUDE_CONFIG_DIR は c.env で付き、既定（~/.claude）なら unsetEnv で消す
    const childEnv: Record<string, string | undefined> = { ...env.vars, ...c.env };
    for (const k of c.unsetEnv ?? []) if (/^[A-Z_][A-Z0-9_]*$/.test(k)) delete childEnv[k];
    const t0 = deps.now();
    const code = await deps.spawn([bin, ...args], { cwd: c.cwd, env: childEnv });
    const afterMs = Math.max(0, Math.round(deps.now() - t0));
    // 知らせるのは終了コードと時間だけ。デーモンが止まっていても失敗にしない
    await callApi(env.paths, "POST", `/api/ai/launches/${id}/exit`, {
      code: Math.max(-1024, Math.min(1024, code)),
      afterMs,
    }).catch(() => undefined);
    if (code !== 0 && afterMs < QUICK_EXIT_MS) {
      const sec = Math.max(1, Math.round(afterMs / 1000));
      const name = COMMAND[cmd] ?? cmd;
      env.err(
        tr(
          `${name} ended after ${sec}s (exit code ${code}). Check the messages above.`,
          `${name} が ${sec} 秒で終わりました（終了コード ${code}）。上の表示を確かめてください。`,
        ),
      );
    }
    return code;
  } catch {
    env.err(
      tr(
        `Could not start ${COMMAND[cmd] ?? cmd}.`,
        `${COMMAND[cmd] ?? cmd} を起動できませんでした。`,
      ),
    );
    return 1;
  }
}
