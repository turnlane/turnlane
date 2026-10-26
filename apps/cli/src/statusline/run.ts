/**
 * turnlane statusline（使い方には出さない）: Turnlane が起動した Claude Code のセッションにだけ `--settings` で渡す
 * statusLine の受け口。
 *
 * 1. statusLine の入力（stdin の JSON）から `rate_limits` の使用率とリセットの時刻だけを取り出し、デーモンに送る
 *    （300ms を過ぎたら・デーモンが落ちていたら送らずに素通し）。会話・費用・モデル・パスなどは送らない（ADR 0005）
 * 2. 利用者が元々設定している statusLine のコマンド（プロジェクトのローカル → プロジェクト → 利用者の settings.json）に
 *    同じ入力を渡し、その出力をそのまま返す。無ければ何も出さない
 *
 * どんな失敗でも Claude Code を止めない（終了コードは利用者のコマンドのもの、無ければ 0）。Claude Code が次の更新で
 * この受け口を止めたら（SIGTERM）、利用者のコマンドも止める。
 *
 * 起動時間を保つため、ここで import するのは node:fs、@turnlane/core/paths・@turnlane/core/limits（小さなモジュール）だけ。
 * TURNLANE_STATUSLINE_TRACE にファイルを指定すると、1回ごとに中身を含まない記録（届いた枠・送れたか・時間）を1行足す
 * （スパイク S9 用）
 */
import { appendFileSync, readFileSync } from "node:fs";
import {
  claudeConfigDir,
  findUserStatusLine,
  parseRateLimits,
  STATUSLINE_SEND_TIMEOUT_MS,
  type UserStatusLine,
} from "@turnlane/core/limits";
import { resolvePaths } from "@turnlane/core/paths";

type Env = Record<string, string | undefined>;

export interface StatusLineDeps {
  env: Env;
  readStdin(): Promise<string>;
  write(s: string): void;
  /** 利用者の statusLine のコマンドを動かし、出力と終了コードを返す */
  runUser(command: string, input: string, env: Env): Promise<{ out: string; code: number }>;
  /** デーモンに送る（成功したら true） */
  send(url: string, token: string, body: unknown, timeoutMs: number): Promise<boolean>;
  readToken(path: string): string | null;
  findUser(o: { configDir: string; projectDir: string | null }): UserStatusLine | null;
  now(): number;
}

/** 入れ子で呼ばれたとき（利用者の statusLine が turnlane statusline 自身だった）の印 */
const DEPTH = "TURNLANE_STATUSLINE_DEPTH";

let child: ReturnType<typeof Bun.spawn> | null = null;

export const systemStatusLine: StatusLineDeps = {
  env: process.env,
  readStdin: () => Bun.stdin.text(),
  write: (s) => {
    process.stdout.write(s);
  },
  async runUser(command, input, env) {
    const p = Bun.spawn(["/bin/sh", "-c", command], {
      env,
      stdin: new Blob([input]),
      stdout: "pipe",
      stderr: "ignore",
    });
    child = p;
    const out = await new Response(p.stdout).text();
    const code = await p.exited;
    child = null;
    return { out, code };
  },
  async send(url, token, body, timeoutMs) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          // 本人の「操作」に数えない（cli ではない）
          "x-turnlane-client": "statusline",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      return res.ok;
    } catch {
      return false;
    }
  },
  readToken(path) {
    try {
      return readFileSync(path, "utf8").trim() || null;
    } catch {
      return null;
    }
  },
  findUser: (o) => findUserStatusLine(o),
  now: () => Date.now(),
};

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 && v.length <= 4096 ? v : null;
}

/** 受け口の本体。終了コードを返す */
export async function runStatusLine(d: StatusLineDeps = systemStatusLine): Promise<number> {
  const t0 = d.now();
  const env = d.env;
  let raw = "";
  try {
    raw = await d.readStdin();
  } catch {}
  let input: unknown = null;
  try {
    input = JSON.parse(raw);
  } catch {}
  const configDir = claudeConfigDir(env);
  const ws = (input as { workspace?: { project_dir?: unknown } } | null)?.workspace;
  const projectDir =
    str(ws?.project_dir) ?? str((input as { cwd?: unknown } | null)?.cwd ?? null) ?? null;

  // 1. 利用枠をデーモンへ（並行。300ms で打ち切る）
  const limits = parseRateLimits(input);
  let sent: "ok" | "failed" | "skipped" = "skipped";
  const sending = (async () => {
    if (!limits) return;
    let paths: ReturnType<typeof resolvePaths>;
    try {
      paths = resolvePaths(env);
    } catch {
      sent = "failed";
      return;
    }
    const token = d.readToken(paths.tokenPath);
    if (!token) {
      sent = "failed";
      return;
    }
    const ok = await d.send(
      `http://127.0.0.1:${paths.port}/api/limits/claude`,
      token,
      { account: configDir, ...limits },
      STATUSLINE_SEND_TIMEOUT_MS,
    );
    sent = ok ? "ok" : "failed";
  })();

  // 2. 利用者の statusLine に同じ入力を渡し、出力をそのまま返す
  let code = 0;
  let user: UserStatusLine | null = null;
  if (!env[DEPTH]) {
    try {
      user = d.findUser({ configDir, projectDir });
    } catch {}
    if (user) {
      try {
        const r = await d.runUser(user.command, raw, { ...env, [DEPTH]: "1" });
        d.write(r.out);
        code = r.code;
      } catch {}
    }
  }
  await sending;

  const trace = env.TURNLANE_STATUSLINE_TRACE;
  if (trace) {
    try {
      appendFileSync(
        trace,
        `${JSON.stringify({
          at: t0,
          account: configDir.slice(configDir.lastIndexOf("/") + 1),
          fiveHour: !!limits?.fiveHour,
          sevenDay: !!limits?.sevenDay,
          userStatusLine: user !== null,
          userExit: user ? code : null,
          sent,
          ms: d.now() - t0,
        })}\n`,
      );
    } catch {}
  }
  return code;
}

/** CLI の入り口（main.ts の速い経路）。SIGTERM・SIGINT で利用者のコマンドも止める */
export async function statusLineMain(): Promise<never> {
  const stop = () => {
    try {
      child?.kill();
    } catch {}
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  let code = 0;
  try {
    code = await runStatusLine();
  } catch {}
  process.exit(code);
}
