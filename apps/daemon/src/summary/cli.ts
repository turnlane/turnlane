/**
 * 日報の AI 要約（M4-6）の子プロセス: CLI の検出、起動フラグの確認、実行（stdin・タイムアウト・出力の上限）。
 *
 * - 検出: (1) 設定の bin (2) ログインシェルでの `command -v`（`$SHELL -lc`、5秒で打ち切り）(3) 既知の場所
 * - 起動フラグは `--help`（Codex は `exec --help`）の出力にあるものだけ付ける
 * - 引数は配列で渡し、シェルを通さない。cwd は要約専用の作業ディレクトリ
 * - タイムアウトで SIGTERM、5秒後に SIGKILL。stdout は 16KB まで読み、残りは読み捨てる。stderr は捨てる
 * - stdout / stderr の中身はログに書かない（呼び出し側は理由のメタデータだけを残す）
 */
import { accessSync, constants, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  checkSummaryOutput,
  SUMMARY_STDOUT_LIMIT,
  type SummaryFailure,
  type SummaryTool,
  summaryToolCommand,
} from "@turnlane/core";

/** 付けたい起動フラグ（phase0-plan M4-6、U25） */
export const WANTED_FLAGS: Record<SummaryTool, readonly string[]> = {
  claude_code: ["--output-format", "--tools", "--no-session-persistence"],
  codex: ["--ephemeral", "--skip-git-repo-check", "--sandbox", "--cd", "--output-last-message"],
};

/**
 * あれば付ける起動フラグ（無くても要約は作れる。missingFlags には入れない）。応答の形（JSON Schema）を渡すときだけ使う
 * （拡張の ai.runOneShot の schema）
 */
export const OPTIONAL_FLAGS: Record<SummaryTool, readonly string[]> = {
  claude_code: ["--json-schema"],
  codex: ["--output-schema"],
};

export interface DetectOptions {
  home: string;
  /** ログインシェル（既定は $SHELL、無ければ /bin/zsh）。null なら使わない */
  shell?: string | null;
  /** 既知の場所（既定 ~/.local/bin、/opt/homebrew/bin、/usr/local/bin） */
  knownDirs?: readonly string[];
  /** シェルと --help の打ち切り（ms。既定 5000） */
  probeTimeoutMs?: number;
}

export interface DetectedCli {
  tool: SummaryTool;
  bin: string | null;
  foundBy: "setting" | "shell" | "known" | null;
  flags: string[];
  missingFlags: string[];
}

function executable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

interface Captured {
  out: string;
  code: number | null;
  signal: string | null;
  timedOut: boolean;
}

/**
 * 子プロセスを自分のプロセスグループで動かし（detached）、stdout を上限まで読む。打ち切り・取り消しはグループごと
 * SIGTERM → 猶予の後 SIGKILL。子プロセスの子（孫）が stdout を握ったまま残っても、本体が終わったら少し待って読むのをやめ、
 * 残ったグループを SIGKILL する（読み終わりを孫の終わりまで待たない）
 */
async function spawnCapture(
  cmd: string[],
  o: {
    cwd?: string;
    env?: Record<string, string | undefined>;
    input?: string;
    timeoutMs: number;
    killGraceMs?: number;
    limit: number;
    signal?: AbortSignal | undefined;
  },
): Promise<Captured | null> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(cmd, {
      ...(o.cwd ? { cwd: o.cwd } : {}),
      ...(o.env ? { env: o.env } : {}),
      stdin: o.input !== undefined ? "pipe" : "ignore",
      stdout: "pipe",
      stderr: "ignore",
      detached: true,
    });
  } catch {
    return null;
  }
  const killGroup = (sig: NodeJS.Signals) => {
    try {
      process.kill(-proc.pid, sig);
    } catch {
      try {
        proc.kill(sig);
      } catch {
        // もう居ない
      }
    }
  };
  let timedOut = false;
  let killTimer: ReturnType<typeof setTimeout> | null = null;
  const stop = () => {
    killGroup("SIGTERM");
    killTimer ??= setTimeout(() => killGroup("SIGKILL"), o.killGraceMs ?? 5000);
  };
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, o.timeoutMs);
  const onAbort = () => stop();
  o.signal?.addEventListener("abort", onAbort);
  // stdout は上限まで取っておき、残りは読み捨てる（子プロセスがパイプで詰まらないように）
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  const reading = (async () => {
    try {
      for (;;) {
        const r = await reader.read();
        if (r.done) break;
        if (size < o.limit) {
          const take = r.value.subarray(0, o.limit - size);
          chunks.push(take);
          size += take.length;
        }
      }
    } catch {
      // 取り消した
    }
  })();
  try {
    if (o.input !== undefined) {
      const stdin = proc.stdin as import("bun").FileSink;
      try {
        stdin.write(o.input);
        await stdin.end();
      } catch {
        // 子プロセスが先に終わった（stdin を読まない）。終了コードで判定する
      }
    }
    const code = await proc.exited;
    const drained = await Promise.race([
      reading.then(() => true),
      Bun.sleep(500).then(() => false),
    ]);
    if (!drained) await reader.cancel().catch(() => {});
    // 孫が残っていれば片付ける
    killGroup("SIGKILL");
    return {
      out: new TextDecoder().decode(Buffer.concat(chunks)),
      code,
      signal: proc.signalCode ?? null,
      timedOut,
    };
  } finally {
    clearTimeout(timer);
    if (killTimer) clearTimeout(killTimer);
    o.signal?.removeEventListener("abort", onAbort);
  }
}

/** 子プロセスを動かして stdout を返す（上限まで。打ち切り・失敗は null）。stderr は捨てる */
async function probe(
  cmd: string[],
  timeoutMs: number,
  env?: Record<string, string | undefined>,
): Promise<string | null> {
  const r = await spawnCapture(cmd, {
    ...(env ? { env } : {}),
    timeoutMs,
    killGraceMs: 500,
    limit: 64 * 1024,
  });
  if (!r || r.timedOut) return null;
  return r.code === 0 || r.out.length > 0 ? r.out : null;
}

/** 実行ファイルを探す（設定の bin → ログインシェル → 既知の場所） */
export async function findCli(
  tool: SummaryTool,
  settingBin: string | null,
  o: DetectOptions,
): Promise<{ bin: string; foundBy: "setting" | "shell" | "known" } | null> {
  if (settingBin && executable(settingBin)) return { bin: settingBin, foundBy: "setting" };
  const name = summaryToolCommand(tool);
  const timeout = o.probeTimeoutMs ?? 5000;
  const shell = o.shell === undefined ? process.env.SHELL || "/bin/zsh" : o.shell;
  if (shell) {
    const out = await probe([shell, "-lc", `command -v ${name}`], timeout);
    const line = out
      ?.split("\n")
      .map((x) => x.trim())
      .find((x) => x.startsWith("/"));
    if (line && executable(line)) return { bin: line, foundBy: "shell" };
  }
  const dirs = o.knownDirs ?? [
    join(o.home, ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  for (const d of dirs) {
    const p = join(d, name);
    if (executable(p)) return { bin: p, foundBy: "known" };
  }
  return null;
}

/** --help の出力から、付ける起動フラグと無いフラグを分ける */
export function flagsFromHelp(
  tool: SummaryTool,
  help: string | null,
): { flags: string[]; missingFlags: string[] } {
  const wanted = WANTED_FLAGS[tool];
  if (!help) return { flags: [], missingFlags: [...wanted] };
  const has = (f: string) => new RegExp(`(^|[\\s,])${f.replace(/-/g, "\\-")}(?![\\w-])`).test(help);
  return {
    flags: [...wanted.filter(has), ...OPTIONAL_FLAGS[tool].filter(has)],
    missingFlags: wanted.filter((f) => !has(f)),
  };
}

export async function detectCli(
  tool: SummaryTool,
  settingBin: string | null,
  o: DetectOptions,
): Promise<DetectedCli> {
  const found = await findCli(tool, settingBin, o);
  if (!found)
    return { tool, bin: null, foundBy: null, flags: [], missingFlags: [...WANTED_FLAGS[tool]] };
  const help = await probe(
    tool === "codex" ? [found.bin, "exec", "--help"] : [found.bin, "--help"],
    o.probeTimeoutMs ?? 5000,
    childEnv(found.bin, {}),
  );
  return { tool, ...found, ...flagsFromHelp(tool, help) };
}

/** 子プロセスの PATH: CLI のディレクトリ（npm で入れた claude が同じ場所の node を使えるように）と標準の場所 */
export function childEnv(
  bin: string,
  extra: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const dirs = [dirname(bin), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
  return {
    ...process.env,
    PATH: [...new Set(dirs)].join(":"),
    ...extra,
  };
}

/** 応答の形を CLI に渡せるか（フラグがあるか） */
export function schemaSupported(tool: SummaryTool, flags: readonly string[]): boolean {
  return tool === "claude_code"
    ? flags.includes("--json-schema") && flags.includes("--output-format")
    : flags.includes("--output-schema");
}

/**
 * 起動の引数（フラグは確かめたものだけ）。schema は応答の形（Claude は JSON の文字列、Codex は書き出したファイル）で、
 * 渡せる版のときだけ付ける
 */
export function summaryArgs(
  tool: SummaryTool,
  flags: readonly string[],
  workDir: string,
  outFile: string | null,
  schema: { json: string; file: string | null } | null = null,
): string[] {
  const has = (f: string) => flags.includes(f);
  const sc = schema !== null && schemaSupported(tool, flags) ? schema : null;
  if (tool === "claude_code") {
    return [
      "-p",
      ...(sc
        ? ["--output-format", "json", "--json-schema", sc.json]
        : has("--output-format")
          ? ["--output-format", "text"]
          : []),
      ...(has("--tools") ? ["--tools", ""] : []),
      ...(has("--no-session-persistence") ? ["--no-session-persistence"] : []),
    ];
  }
  return [
    "exec",
    ...(has("--ephemeral") ? ["--ephemeral"] : []),
    ...(has("--skip-git-repo-check") ? ["--skip-git-repo-check"] : []),
    ...(has("--sandbox") ? ["--sandbox", "read-only"] : []),
    ...(has("--cd") ? ["-C", workDir] : []),
    ...(outFile && has("--output-last-message") ? ["-o", outFile] : []),
    ...(sc?.file ? ["--output-schema", sc.file] : []),
    "-",
  ];
}

/** 文の前後のコードブロックの囲みを外して JSON として読む（読めなければ undefined） */
function parseJsonText(s: string): unknown {
  const t = s
    .trim()
    .replace(/^```(?:json)?\s*\n?/i, "")
    .replace(/\n?```\s*$/, "")
    .trim();
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

/**
 * 構造化の出力を読む。Claude（`--output-format json`）は結果の包み（`structured_output`、無ければ `result` の文）、Codex は
 * 最後の応答の文。エラーの包み（is_error）は exit の失敗、読めなければ empty
 */
export function readStructured(
  tool: SummaryTool,
  raw: string,
): { ok: true; text: string; json: unknown } | { ok: false; failure: SummaryFailure } {
  if (tool === "claude_code") {
    const env = parseJsonText(raw) as
      | { is_error?: unknown; result?: unknown; structured_output?: unknown }
      | undefined;
    if (!env || typeof env !== "object") return { ok: false, failure: { kind: "empty" } };
    if (env.is_error === true) return { ok: false, failure: { kind: "exit", code: null } };
    const text = typeof env.result === "string" ? env.result : "";
    const json =
      env.structured_output !== undefined && env.structured_output !== null
        ? env.structured_output
        : parseJsonText(text);
    if (json === undefined) return { ok: false, failure: { kind: "empty" } };
    return { ok: true, text: text || JSON.stringify(json), json };
  }
  const json = parseJsonText(raw);
  if (json === undefined) return { ok: false, failure: { kind: "empty" } };
  return { ok: true, text: raw.trim(), json };
}

export type RunResult =
  | { ok: true; text: string; json?: unknown }
  | { ok: false; failure: SummaryFailure };

export interface RunOptions {
  tool: SummaryTool;
  bin: string;
  flags: readonly string[];
  workDir: string;
  /** stdin に渡す全文（buildSummaryInput の出力だけ） */
  input: string;
  timeoutMs: number;
  /** SIGTERM から SIGKILL までの猶予（既定 5000） */
  killGraceMs?: number;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
  /** 応答の形（JSON Schema）。CLI の版が対応していれば渡し、結果の json に入れる */
  schema?: Record<string, unknown>;
}

/** 要約の子プロセスを1回動かす */
export async function runSummaryCli(o: RunOptions): Promise<RunResult> {
  if (!executable(o.bin)) return { ok: false, failure: { kind: "not_found" } };
  const structured = o.schema !== undefined && schemaSupported(o.tool, o.flags);
  const outDir =
    o.tool === "codex" && (o.flags.includes("--output-last-message") || structured)
      ? mkdtempSync(join(tmpdir(), "turnlane-summary-"))
      : null;
  const outFile =
    outDir && o.flags.includes("--output-last-message") ? join(outDir, "last-message.txt") : null;
  let schema: { json: string; file: string | null } | null = null;
  if (structured) {
    const json = JSON.stringify(o.schema);
    let file: string | null = null;
    if (o.tool === "codex" && outDir) {
      file = join(outDir, "schema.json");
      writeFileSync(file, json, { mode: 0o600 });
    }
    schema = { json, file };
  }
  try {
    const r = await spawnCapture(
      [o.bin, ...summaryArgs(o.tool, o.flags, o.workDir, outFile, schema)],
      {
        cwd: o.workDir,
        env: o.env ?? childEnv(o.bin, {}),
        input: o.input,
        timeoutMs: o.timeoutMs,
        ...(o.killGraceMs !== undefined ? { killGraceMs: o.killGraceMs } : {}),
        limit: SUMMARY_STDOUT_LIMIT,
        signal: o.signal,
      },
    );
    if (!r) return { ok: false, failure: { kind: "spawn_failed" } };
    if (r.timedOut) return { ok: false, failure: { kind: "timed_out" } };
    if (o.signal?.aborted)
      return { ok: false, failure: { kind: "exit", code: r.code, signal: "canceled" } };
    if (r.code !== 0)
      return { ok: false, failure: { kind: "exit", code: r.code, signal: r.signal } };
    let raw = r.out;
    if (outFile) {
      try {
        raw = readFileSync(outFile, "utf8").slice(0, SUMMARY_STDOUT_LIMIT);
      } catch {
        raw = r.out;
      }
    }
    if (structured) return readStructured(o.tool, raw);
    const c = checkSummaryOutput(raw);
    return c.ok ? { ok: true, text: c.text } : { ok: false, failure: { kind: c.reason } };
  } finally {
    if (outDir) rmSync(outDir, { recursive: true, force: true });
  }
}
