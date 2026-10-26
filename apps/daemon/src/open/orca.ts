/**
 * Orca（D-122）の端末を開く。Orca は AppleScript を持たないので、アプリに同梱の CLI（`orca terminal create`）を使う。
 *
 * - CLI は `/usr/local/bin/orca` のシェルスクリプトではなく、アプリの中の実体を `ELECTRON_RUN_AS_NODE=1` で直接起動する
 *   （シンボリックリンクを読めない環境があり、PATH にも依存しない）
 * - `--worktree path:<フォルダ>` は Orca に登録したリポジトリの worktree（Orca の外で作った `git worktree` も含む）の
 *   ルートだけを指せる。登録していないリポジトリは selector_not_found で失敗するので、`orca repo add --path <リポジトリ>`
 *   で登録してからもう一度作る。worktree は Turnlane が作り、Orca の worktree 作成は使わない
 * - Orca は worktree を git が返す実体のパス（シンボリックリンクを解いたパス）で持ち、`path:` は文字列で比べる。
 *   `/var/folders/…`（実体は `/private/var/folders/…`）やシンボリックリンクを含むパスのままでは selector_not_found に
 *   なり、repo add してもやり直しても開けない。`--worktree` と `repo add --path` には実体のパスを渡す
 * - Orca が起動していなければ `orca open`（起動して待つ。起動していれば前面に出すだけ）を先に呼ぶ
 * - どれも引数の配列で起動し、シェルを通さない。失敗したら呼び出し側がコピーに落とす
 */
import { realpathSync } from "node:fs";
import type { FoundApp } from "./apps.ts";
import type { Attempt, Step } from "./index.ts";

/** orca open は起動を最大15秒待つ */
const OPEN_TIMEOUT_MS = 20_000;
const CALL_TIMEOUT_MS = 15_000;

// biome-ignore lint/suspicious/noControlCharactersInRegex: 制御文字を除くための正規表現
const CONTROL = /[\u0000-\u001f\u007f]/g;

/** シンボリックリンクを解いた実体のパス（git・Orca が持つ形）。解けなければそのまま */
export function realDir(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** Orca の CLI の起動（アプリの中の実体を Node として動かす） */
export function orcaCli(app: FoundApp): string[] {
  return [
    "/usr/bin/env",
    "ELECTRON_RUN_AS_NODE=1",
    `${app.path}/Contents/MacOS/Orca`,
    `${app.path}/Contents/Resources/app.asar.unpacked/out/cli/index.js`,
  ];
}

export interface OrcaTerminal {
  /** 端末を開くフォルダ（Orca の worktree のルート） */
  worktree: string;
  /** 起動したら実行するコマンド（無ければシェルだけ） */
  command?: string | undefined;
  /** タブの題名（制御文字を除き80文字まで） */
  title?: string | undefined;
  /** 登録していなかったときに `orca repo add` するリポジトリ（無ければ worktree） */
  repo?: string | undefined;
  /** false なら Orca を前面に出さない（--focus を付けない。人のいないときの起動） */
  focus?: boolean | undefined;
}

export function orcaCreate(app: FoundApp, t: OrcaTerminal): Step {
  const title = t.title?.replace(CONTROL, " ").trim().slice(0, 80);
  return {
    argv: [
      ...orcaCli(app),
      "terminal",
      "create",
      "--worktree",
      `path:${realDir(t.worktree)}`,
      ...(t.command ? ["--command", t.command] : []),
      ...(title ? ["--title", title] : []),
      ...(t.focus === false ? [] : ["--focus"]),
      "--json",
    ],
    timeoutMs: CALL_TIMEOUT_MS,
  };
}

/**
 * Orca の端末を開く候補（試す順）:
 * 1. orca open → terminal create
 * 2. repo add（登録していないリポジトリ）→ terminal create
 */
export function planOrca(app: FoundApp, t: OrcaTerminal, outcome: Attempt["outcome"]): Attempt[] {
  const cli = orcaCli(app);
  const create = orcaCreate(app, t);
  return [
    {
      steps: [{ argv: [...cli, "open", "--json"], timeoutMs: OPEN_TIMEOUT_MS }, create],
      outcome,
      app: app.name,
    },
    {
      steps: [
        {
          argv: [...cli, "repo", "add", "--path", realDir(t.repo ?? t.worktree), "--json"],
          timeoutMs: CALL_TIMEOUT_MS,
        },
        create,
      ],
      outcome,
      app: app.name,
    },
  ];
}

// ---------- 動いている端末（D-238。開く・答える） ----------

/**
 * `orca terminal list --json` の 1 行から使う値だけ（画面の中身の preview・題名は読まない。読んだ JSON は捨てる）
 */
export interface OrcaTerminalRow {
  handle: string;
  worktreePath: string;
  tabId: string;
  connected: boolean;
  writable: boolean;
}

const HANDLE = /^term_[0-9A-Za-z-]{8,64}$/;

/** list の JSON → 使う値だけの行。形が合わなければ空 */
export function parseOrcaTerminals(out: string | null): OrcaTerminalRow[] {
  if (!out) return [];
  let v: unknown;
  try {
    v = JSON.parse(out);
  } catch {
    return [];
  }
  const ts = ((v as { result?: { terminals?: unknown } } | null)?.result?.terminals ??
    []) as unknown;
  if (!Array.isArray(ts)) return [];
  const rows: OrcaTerminalRow[] = [];
  for (const x of ts) {
    const t = (x ?? {}) as Record<string, unknown>;
    if (typeof t.handle !== "string" || !HANDLE.test(t.handle)) continue;
    rows.push({
      handle: t.handle,
      worktreePath: typeof t.worktreePath === "string" ? t.worktreePath : "",
      tabId: typeof t.tabId === "string" ? t.tabId.slice(0, 80) : "",
      connected: t.connected === true,
      writable: t.writable === true,
    });
  }
  return rows;
}

export type OrcaPick =
  | { handle: string; by: "handle" | "cwd" }
  | { handle: null; miss: "not_found" | "ambiguous"; candidates?: number };

/** パスが worktree の中か（worktree そのものを含む） */
const inside = (p: string, root: string) => {
  const r = root.replace(/\/+$/, "");
  return r.length > 0 && (p === r || p.startsWith(`${r}/`));
};

/**
 * セッションの端末を選ぶ: hooks が記録したハンドルが今もあればそれ。無ければ、つながっている端末のうち worktree が
 * セッションの cwd を含むもの（一番深い worktree）が 1 つだけならそれ。複数あれば選ばない（別のタブに送らない）
 */
export function pickOrcaTerminal(
  rows: readonly OrcaTerminalRow[],
  s: { handle: string | null; cwd: string | null },
): OrcaPick {
  const live = rows.filter((r) => r.connected);
  if (s.handle) {
    const hit = live.find((r) => r.handle === s.handle);
    if (hit) return { handle: hit.handle, by: "handle" };
  }
  if (!s.cwd) return { handle: null, miss: "not_found" };
  const cwd = realDir(s.cwd);
  const within = live.filter((r) => r.worktreePath && inside(cwd, realDir(r.worktreePath)));
  if (within.length === 0) return { handle: null, miss: "not_found" };
  const depth = (r: OrcaTerminalRow) => realDir(r.worktreePath).length;
  const deepest = Math.max(...within.map(depth));
  const best = within.filter((r) => depth(r) === deepest);
  if (best.length === 1) return { handle: (best[0] as OrcaTerminalRow).handle, by: "cwd" };
  return { handle: null, miss: "ambiguous", candidates: best.length };
}

/** その端末が書き込めるか（list の writable） */
export function orcaWritable(rows: readonly OrcaTerminalRow[], handle: string): boolean {
  return rows.some((r) => r.handle === handle && r.connected && r.writable);
}

export function orcaList(app: FoundApp): string[] {
  return [...orcaCli(app), "terminal", "list", "--json"];
}

/** そのタブに切り替えて Orca を前に出す（`orca terminal switch`） */
export function orcaSwitch(app: FoundApp, handle: string): Step {
  return {
    argv: [...orcaCli(app), "terminal", "switch", `--terminal=${handle}`, "--json"],
    timeoutMs: CALL_TIMEOUT_MS,
  };
}
