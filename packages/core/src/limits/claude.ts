/**
 * Claude の利用枠の読み取り（statusLine の受け口）の純粋な部品。デーモン（起動の引数・値の記録）と CLI の
 * `turnlane statusline`（速い経路）の両方が使う。CLI の起動時間を保つため、このファイルは node:fs と node:path のほかを
 * import しない（型だけは可）。
 *
 * - 本体が起動する Claude のセッションにだけ `--settings` で statusLine を渡す（利用者の settings.json は書き換えない）
 * - 受け口は、statusLine の入力（JSON）から `rate_limits` の使用率とリセットの時刻だけを取り出してデーモンに送り、利用者が元々
 *   設定している statusLine のコマンドに同じ入力を渡して、その出力をそのまま返す
 * - `rate_limits` は claude.ai の Pro・Max の契約で、セッションの最初の応答の後にだけ届く（公式ドキュメント）。無ければ値なし
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ClaudeLimitWindow } from "../api/limits.ts";

/** 受け口のサブコマンド（`turnlane statusline`。使い方には出さない） */
export const STATUSLINE_SUBCOMMAND = "statusline";

/** デーモンへの送信を待つ上限（これを過ぎたら送らずに素通し） */
export const STATUSLINE_SEND_TIMEOUT_MS = 300;

/** statusLine の入力の `rate_limits` → 5時間・7日の使用率とリセットの時刻（ms）。どちらも無ければ null */
export function parseRateLimits(
  input: unknown,
): { fiveHour?: ClaudeLimitWindow; sevenDay?: ClaudeLimitWindow } | null {
  if (typeof input !== "object" || input === null) return null;
  const rl = (input as { rate_limits?: unknown }).rate_limits;
  if (typeof rl !== "object" || rl === null) return null;
  const win = (v: unknown): ClaudeLimitWindow | undefined => {
    if (typeof v !== "object" || v === null) return undefined;
    const { used_percentage: p, resets_at: r } = v as Record<string, unknown>;
    if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1000) return undefined;
    if (typeof r !== "number" || !Number.isFinite(r) || r <= 0) return undefined;
    // resets_at は Unix 秒（公式ドキュメント）。ms で来ても読めるように、大きすぎる値はそのまま ms とみなす
    return { usedPercentage: p, resetsAt: r < 1e11 ? Math.round(r * 1000) : Math.round(r) };
  };
  const r = rl as Record<string, unknown>;
  const fiveHour = win(r.five_hour);
  const sevenDay = win(r.seven_day);
  if (!fiveHour && !sevenDay) return null;
  return { ...(fiveHour ? { fiveHour } : {}), ...(sevenDay ? { sevenDay } : {}) };
}

/** Claude の設定ディレクトリ（アカウント）: CLAUDE_CONFIG_DIR、無ければ `<HOME>/.claude`。末尾の / は落とす */
export function claudeConfigDir(env: Record<string, string | undefined>): string {
  return (env.CLAUDE_CONFIG_DIR || `${env.HOME ?? ""}/.claude`).replace(/\/+$/, "");
}

/** 利用者が設定している statusLine（type: command のものだけ） */
export interface UserStatusLine {
  command: string;
  padding?: number;
  refreshInterval?: number;
  hideVimModeIndicator?: boolean;
}

function statusLineIn(path: string, readFile: (p: string) => string): UserStatusLine | null {
  let v: unknown;
  try {
    v = JSON.parse(readFile(path));
  } catch {
    return null;
  }
  const s = (v as { statusLine?: unknown } | null)?.statusLine;
  if (typeof s !== "object" || s === null) return null;
  const o = s as Record<string, unknown>;
  if (o.type !== "command" || typeof o.command !== "string" || o.command.trim() === "") return null;
  return {
    command: o.command,
    ...(typeof o.padding === "number" ? { padding: o.padding } : {}),
    ...(typeof o.refreshInterval === "number" ? { refreshInterval: o.refreshInterval } : {}),
    ...(typeof o.hideVimModeIndicator === "boolean"
      ? { hideVimModeIndicator: o.hideVimModeIndicator }
      : {}),
  };
}

/**
 * `--settings` が無ければ効いていたはずの statusLine。Claude Code の設定の優先順のうち、コマンドラインより下の
 * プロジェクトのローカル（`.claude/settings.local.json`）→ プロジェクト（`.claude/settings.json`）→ 利用者
 * （`<設定ディレクトリ>/settings.json`）の順に、最初に見つかったもの。組織の管理の設定はコマンドラインより強く、そのときは
 * 受け口が呼ばれないので見ない。読めない・無ければ null
 */
export function findUserStatusLine(o: {
  configDir: string;
  projectDir: string | null;
  readFile?: (p: string) => string;
}): UserStatusLine | null {
  const readFile = o.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  const files = [
    ...(o.projectDir
      ? [
          join(o.projectDir, ".claude", "settings.local.json"),
          join(o.projectDir, ".claude", "settings.json"),
        ]
      : []),
    join(o.configDir, "settings.json"),
  ];
  for (const f of files) {
    const s = statusLineIn(f, readFile);
    if (s) return s;
  }
  return null;
}

/** シェルの1語に（statusLine の command はシェルで実行される） */
function shellWord(s: string): string {
  return /^[A-Za-z0-9_./-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`;
}

/**
 * 本体が起動する Claude に渡す `--settings` の JSON。statusLine の受け口（`<turnlane> statusline`）だけを持つ。
 * 利用者の statusLine の見た目の設定（padding・refreshInterval・hideVimModeIndicator）は引き継ぐ
 */
export function statusLineSettingsJson(cliPath: string, user: UserStatusLine | null): string {
  return JSON.stringify({
    statusLine: {
      type: "command",
      command: `${shellWord(cliPath)} ${STATUSLINE_SUBCOMMAND}`,
      ...(user?.padding !== undefined ? { padding: user.padding } : {}),
      ...(user?.refreshInterval !== undefined ? { refreshInterval: user.refreshInterval } : {}),
      ...(user?.hideVimModeIndicator !== undefined
        ? { hideVimModeIndicator: user.hideVimModeIndicator }
        : {}),
    },
  });
}
