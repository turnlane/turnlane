/**
 * turnlane hook --tool <ToolId> [--managed-by turnlane]（phase0-plan 3.6・3.6.1、ai-session-ingestion 3.3、ADR 0009）。
 * stdin の JSON から許可リストのキーだけを取り出し、spool に1行追記して exit 0。
 * デーモンとは通信しない。どんな失敗でも呼び出し元のツールを止めないよう exit 0 にする。
 * `--managed-by turnlane` は hooks 設定ファイル上で Turnlane のエントリを識別するための語で、ここでは読み飛ばす。
 * 未知の引数も無視する。
 *
 * 起動時間の目標は 50ms 以内（S4: p95 8.9ms）。そのため、このディレクトリは node:fs、同じディレクトリの
 * ファイル、@turnlane/collectors/hook-allowlist（import を持たない定数モジュール）以外を import しない（biome.json）。
 */
import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import {
  HOOK_ALLOWLIST,
  HOOK_SPOOL_VERSION,
  HOOK_TOOL_IDS,
  type HookToolId,
  hookValueAllowed,
  quotaHorizonOf,
  TERM_HANDLE_RE,
  trimClaudeProjectPath,
  trimCodexScratchCwd,
} from "@turnlane/collectors/hook-allowlist";

/** 1回の write で原子的に追記できる大きさ（PIPE_BUF 相当）に収める */
export const MAX_LINE_BYTES = 4000;
const MAX_VALUE_LENGTH = 1024;

export function spoolDir(env: Record<string, string | undefined>): string {
  if (env.TURNLANE_DATA_DIR) return `${env.TURNLANE_DATA_DIR}/spool`;
  return `${env.HOME ?? ""}/Library/Application Support/turnlane/spool`;
}

export function spoolFileName(now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `hooks-${y}${m}${d}.jsonl`;
}

/**
 * hook を受けた設定ディレクトリ（S5）。hook のプロセスは親（Claude Code / Codex）の環境変数を引き継ぐので、
 * CLAUDE_CONFIG_DIR / CODEX_HOME があればその値、無ければ既定のディレクトリ。
 */
export function configRoot(tool: HookToolId, env: Record<string, string | undefined>): string {
  const home = env.HOME ?? "";
  const v = tool === "claude_code" ? env.CLAUDE_CONFIG_DIR : env.CODEX_HOME;
  const dflt = tool === "claude_code" ? `${home}/.claude` : `${home}/.codex`;
  return (v || dflt).replace(/\/+$/, "");
}

export function isHookTool(s: string | undefined): s is HookToolId {
  return s !== undefined && (HOOK_TOOL_IDS as readonly string[]).includes(s);
}

/**
 * 許可リストのキーだけを、短い文字列・数値・真偽値に限って残す。cwd は Codex のプロジェクト外の作業フォルダなら
 * 日付までに切り落とす（最初の依頼から作ったフォルダ名を spool に書かない。D-135）。Claude Code の transcript_path
 * （`projects/<cwd を符号化した名前>/…`）も同じ名前を含むので、その1段を切り落とす（D-136）
 */
export function extract(
  input: unknown,
  tool: HookToolId,
  receivedAt: number,
  root?: string,
  home?: string,
  term?: string,
): Record<string, unknown> | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const src = input as Record<string, unknown>;
  const out: Record<string, unknown> = { v: HOOK_SPOOL_VERSION, tool, received_at: receivedAt };
  if (root && root.length <= MAX_VALUE_LENGTH) out.config_root = root;
  // Orca の端末のハンドル（D-238）。形が合うものだけ
  if (term && TERM_HANDLE_RE.test(term)) out.term = term;
  for (const k of HOOK_ALLOWLIST[tool].keys) {
    const v = src[k];
    if (typeof v === "string" && v.length <= MAX_VALUE_LENGTH && hookValueAllowed(k, v))
      out[k] =
        k === "cwd" && home
          ? trimCodexScratchCwd(v, home)
          : k === "transcript_path"
            ? trimClaudeProjectPath(v)
            : v;
    else if (typeof v === "number" || typeof v === "boolean") out[k] = v;
  }
  // 利用枠の自動再開を止めた理由が「24 時間より先に明ける」か（message は残さず真偽値だけ）
  if (tool === "claude_code" && quotaHorizonOf(src)) out.quota_horizon = true;
  return out;
}

/** JSON の1行にする。4KB を超えたら落としてよいキーから順に落とす（最後に config_root） */
export function toLine(rec: Record<string, unknown>): string {
  const tool = rec.tool;
  const droppable = [
    ...(isHookTool(String(tool)) ? HOOK_ALLOWLIST[tool as HookToolId].droppable : []),
    "term",
    "config_root",
  ];
  let line = `${JSON.stringify(rec)}\n`;
  for (const k of droppable) {
    if (Buffer.byteLength(line) <= MAX_LINE_BYTES) break;
    delete rec[k];
    rec.truncated = true;
    line = `${JSON.stringify(rec)}\n`;
  }
  return Buffer.byteLength(line) <= MAX_LINE_BYTES ? line : "";
}

function append(dir: string, name: string, line: string): void {
  const path = `${dir}/${name}`;
  let fd: number;
  try {
    fd = openSync(path, "a", 0o600);
  } catch {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    fd = openSync(path, "a", 0o600);
  }
  try {
    writeSync(fd, line);
  } finally {
    closeSync(fd);
  }
}

export async function runHook(args: string[]): Promise<never> {
  try {
    const i = args.indexOf("--tool");
    const tool = i >= 0 ? args[i + 1] : undefined;
    if (isHookTool(tool)) {
      const now = new Date();
      const env = process.env;
      const rec = extract(
        JSON.parse(await Bun.stdin.text()),
        tool,
        now.getTime(),
        configRoot(tool, env),
        env.HOME,
        env.ORCA_TERMINAL_HANDLE,
      );
      if (rec) {
        const line = toLine(rec);
        if (line) append(spoolDir(env), spoolFileName(now), line);
      }
    }
  } catch {
    // 呼び出し元（Claude Code / Codex）を止めない
  }
  process.exit(0);
}
