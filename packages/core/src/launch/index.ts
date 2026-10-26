/**
 * タスクから AI に頼む（D-107。plan §B）の純粋関数: 依頼の型とプロンプトの組み立て、worktree のブランチ名と置き場所、
 * ツールの起動の引数、タスクから見た状態、差分と CI の要約。DB・プロセスには触れない（daemon の launch/ が使う）。
 * web からも使う（依頼の型の名前・状態の言葉）ので Bun の API に依存しない。
 */
import type {
  AiLaunchTool,
  AiTemplateView,
  CiState,
  TaskAiState,
  WorkItemStatus,
} from "../api/index.ts";

// ---------- 依頼の型（plan §B.4） ----------

export type BuiltinTemplateKey = "implement" | "research" | "tests" | "review";

interface Builtin {
  key: BuiltinTemplateKey;
  name: { ja: string; en: string };
  body: { ja: string; en: string };
  readOnly: boolean;
  worktree: boolean | null;
}

/**
 * 組み込みの4つ。本文の {title} {notes} {repo} {branch} を差し込み、空の行は詰める。指示（任意）は最後の段落に足す。
 * 読み取りのみの型は Claude を --permission-mode plan、Codex を -s read-only で起動する（許可の自動承認はしない。D-109）
 */
export const BUILTIN_TEMPLATES: readonly Builtin[] = [
  {
    key: "implement",
    name: { ja: "実装する", en: "Implement" },
    body: {
      ja: "タスク: {title}\n\n{notes}\n\n終わったら変更点を3行でまとめてください。",
      en: "Task: {title}\n\n{notes}\n\nWhen you are done, summarize the changes in three lines.",
    },
    readOnly: false,
    worktree: null,
  },
  {
    key: "research",
    name: { ja: "調べてまとめる（読み取りのみ）", en: "Research and summarize (read-only)" },
    body: {
      ja: "次のことを調べて、分かったことを短くまとめてください。ファイルは変更しないでください。\n\n{title}\n\n{notes}",
      en: "Look into the following and summarize what you find. Do not modify files.\n\n{title}\n\n{notes}",
    },
    readOnly: true,
    worktree: false,
  },
  {
    key: "tests",
    name: { ja: "テストを書く", en: "Write tests" },
    body: {
      ja: "次の対象にテストを書いてください。既存のテストの書き方に合わせ、テストが通ることを確かめてください。\n\n{title}\n\n{notes}",
      en: "Write tests for the following. Follow the existing test style and make sure they pass.\n\n{title}\n\n{notes}",
    },
    readOnly: false,
    worktree: null,
  },
  {
    key: "review",
    name: { ja: "PR をレビューする（読み取りのみ）", en: "Review a PR (read-only)" },
    body: {
      ja: "次の PR・変更をレビューし、問題点と提案を重要な順に挙げてください。ファイルは変更しないでください。\n\n{title}\n\n{notes}",
      en: "Review the following PR or change and list issues and suggestions, most important first. Do not modify files.\n\n{title}\n\n{notes}",
    },
    readOnly: true,
    worktree: false,
  },
];

export const DEFAULT_TEMPLATE_ID = "builtin:implement";

export function builtinTemplates(locale: "ja" | "en"): AiTemplateView[] {
  return BUILTIN_TEMPLATES.map((b) => ({
    id: `builtin:${b.key}`,
    name: b.name[locale],
    builtin: true,
    body: b.body[locale],
    tool: null,
    readOnly: b.readOnly,
    worktree: b.worktree,
  }));
}

export interface PromptVars {
  title: string;
  notes: string | null;
  repo: string | null;
  branch: string | null;
  /** 指示（任意） */
  instruction: string | null;
}

/** 依頼の型にタスクを差し込む。3行以上の空行は2行に詰め、前後の空白を落とす */
export function composePrompt(body: string, v: PromptVars): string {
  const filled = body.replace(/\{(title|notes|repo|branch)\}/g, (_, k: string) => {
    if (k === "title") return v.title;
    if (k === "notes") return v.notes?.trim() ?? "";
    if (k === "repo") return v.repo ?? "";
    return v.branch ?? "";
  });
  const extra = v.instruction?.trim();
  return (extra ? `${filled}\n\n${extra}` : filled)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---------- worktree（plan §B.3） ----------

/** 題名 → ブランチ名の一部（ASCII の英数字とハイフン、30字まで。無ければ task） */
export function branchSlug(title: string): string {
  const s = title
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30)
    .replace(/-+$/g, "");
  return s || "task";
}

/** `tl/<slug>-<4桁>`。rand は 0〜9999 */
export function worktreeBranch(title: string, rand: number): string {
  return `tl/${branchSlug(title)}-${String(Math.abs(Math.trunc(rand)) % 10000).padStart(4, "0")}`;
}

/**
 * worktree の置き場所: `<base>/<repo 名>-wt/<branch の / を - に>`。base の既定はリポジトリの親（D-110 (4)）。
 * 設定 ai.worktree_dir で base を変えられる
 */
export function worktreePathFor(repoRoot: string, branch: string, baseDir: string | null): string {
  const parts = repoRoot.replace(/\/+$/, "").split("/");
  const name = parts.at(-1) || "repo";
  const parent = baseDir?.replace(/\/+$/, "") || parts.slice(0, -1).join("/") || "/";
  return `${parent === "/" ? "" : parent}/${name}-wt/${branch.replaceAll("/", "-")}`;
}

// ---------- 起動の引数（plan §B.1） ----------

export interface LaunchArgs {
  tool: AiLaunchTool;
  prompt: string;
  /** Claude Code の --session-id（UUID） */
  sessionUuid: string | null;
  /** セッションの表示名（Claude Code の -n） */
  name: string;
  readOnly: boolean;
  cwd: string;
  /** Claude Code の --settings（statusLine の受け口。limits/claude.ts の statusLineSettingsJson）。無ければ付けない */
  settings?: string | null;
}

/**
 * 対話モードで起動する引数（argv[0] はコマンド名。turnlane ai run がログインシェルの PATH で探す）。
 * 許可の自動承認・`--dangerously-*` は付けない（D-109）。権限は利用者の設定に従い、読み取りのみの型だけ狭める
 */
export function launchArgv(a: LaunchArgs): string[] {
  // `--` で区切らずに、先頭が `-` のときだけ空白を前に足してオプションと読ませない（CLI ごとの `--` の扱いに頼らない）
  const prompt = a.prompt.startsWith("-") ? ` ${a.prompt}` : a.prompt;
  if (a.tool === "claude_code") {
    return [
      "claude",
      ...(a.sessionUuid ? ["--session-id", a.sessionUuid] : []),
      "-n",
      a.name.replace(/^-+/, "").slice(0, 80) || "task",
      ...(a.readOnly ? ["--permission-mode", "plan"] : []),
      ...(a.settings ? ["--settings", a.settings] : []),
      prompt,
    ];
  }
  return ["codex", "-C", a.cwd, ...(a.readOnly ? ["-s", "read-only"] : []), prompt];
}

// ---------- タスクから見た状態（plan §B.2） ----------

export interface LaunchStateFacts {
  status: "pending" | "started" | "linked" | "unlinked" | "failed";
  /** 紐づいた AI 項目の状態（紐づく前・項目がまだ無ければ null） */
  workItem: { status: WorkItemStatus; reason: string | null } | null;
  /** 開いている自分の番の種類 */
  openFollowUp: string | null;
}

/**
 * 頼んだ AI の状態。紐づいたら AI 項目の状態から: needs_input・error はそのまま、your_turn は質問（返答待ち）なら your_turn、
 * 編集・PR なら done_check、done（質問も許可もエラーもなく終わった）も done_check（依頼したものは必ず本人が確かめる）
 */
export function taskAiState(f: LaunchStateFacts): TaskAiState {
  if (f.status === "failed") return "failed";
  if (f.status === "unlinked") return "unlinked";
  if (f.status !== "linked" || !f.workItem) return "starting";
  const w = f.workItem;
  if (w.status === "needs_input" || f.openFollowUp === "approve") return "needs_input";
  if (w.status === "running") return "running";
  if (w.status === "error") return "error";
  // 利用枠の上限待ち。明けた後の再開（「再開できる」）は自分の番、エラーの状態（1 時間）の後の再開待ちはエラーのまま
  if (w.status === "done" && w.reason === "rate_limit") return "limit";
  if (w.status === "your_turn" && w.reason === "resume_limit") return "your_turn";
  if (w.status === "your_turn" && w.reason === "resume_error") return "error";
  if (f.openFollowUp === "reply") return "your_turn";
  if (w.status === "your_turn" && (w.reason ?? "").includes("question")) return "your_turn";
  return "done_check";
}

// ---------- 確認支援（plan §B.5） ----------

/** `git diff --numstat` の出力 → ファイル数・追加・削除・ディレクトリごと（バイナリは行数 0 で数える） */
export function parseNumstat(out: string): {
  files: number;
  additions: number;
  deletions: number;
  dirs: { dir: string; files: number }[];
} {
  let files = 0;
  let additions = 0;
  let deletions = 0;
  const dirs = new Map<string, number>();
  for (const line of out.split("\n")) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (!m) continue;
    files++;
    additions += m[1] === "-" ? 0 : Number(m[1]);
    deletions += m[2] === "-" ? 0 : Number(m[2]);
    // リネーム（a => b、{a => b}）は新しい側のパス
    const path = numstatPath(m[3] as string);
    const i = path.indexOf("/");
    const dir = i > 0 ? path.slice(0, i) : ".";
    dirs.set(dir, (dirs.get(dir) ?? 0) + 1);
  }
  return {
    files,
    additions,
    deletions,
    dirs: [...dirs]
      .map(([dir, n]) => ({ dir, files: n }))
      .sort((a, b) => b.files - a.files || a.dir.localeCompare(b.dir))
      .slice(0, 5),
  };
}

/** numstat のパス（リネームは新しい側） */
function numstatPath(raw: string): string {
  return raw
    .replace(/\{[^}]*? => ([^}]*)\}/g, "$1")
    .replace(/^.* => /, "")
    .replace(/\/\//g, "/");
}

/** `git diff --numstat` の出力 → ファイルごとの追加・削除（バイナリは null）。出てきた順 */
export function parseNumstatFiles(
  out: string,
): { path: string; additions: number | null; deletions: number | null }[] {
  const files: { path: string; additions: number | null; deletions: number | null }[] = [];
  for (const line of out.split("\n")) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (!m) continue;
    files.push({
      path: numstatPath(m[3] as string),
      additions: m[1] === "-" ? null : Number(m[1]),
      deletions: m[2] === "-" ? null : Number(m[2]),
    });
  }
  return files;
}

/**
 * `git diff` の出力（unified）から上限つきの抜粋を作る。ファイルごとに `diff --git` の塊に分け、各ファイルに
 * perFile バイトまで（行の途中では切らない）、全体で maxBytes まで。バイナリの塊（`Binary files … differ`）は入れない。
 * 切ったら truncated
 */
export function diffExcerpt(
  raw: string,
  o: { maxBytes: number; perFile: number },
): { excerpt: string; truncated: boolean } {
  const chunks = raw.split(/^(?=diff --git )/m).filter((c) => c.startsWith("diff --git "));
  const enc = new TextEncoder();
  const size = (s: string) => enc.encode(s).length;
  let out = "";
  let used = 0;
  let truncated = false;
  for (const c of chunks) {
    if (/^Binary files .* differ$/m.test(c) || /^GIT binary patch$/m.test(c)) continue;
    const budget = Math.min(o.perFile, o.maxBytes - used);
    if (budget <= 0) {
      truncated = true;
      break;
    }
    let part = "";
    let n = 0;
    for (const line of c.replace(/\n$/, "").split("\n")) {
      const add = size(line) + 1;
      if (n + add > budget) {
        truncated = true;
        break;
      }
      part += `${line}\n`;
      n += add;
    }
    out += part;
    used += n;
  }
  return { excerpt: out, truncated };
}

/** `git status --porcelain` の行数（未コミットの変更のファイル数） */
export function countPorcelain(out: string): number {
  return out.split("\n").filter((l) => l.trim().length > 0).length;
}

/**
 * gh の statusCheckRollup → CI の状態。CheckRun は status / conclusion、StatusContext は state を見る。
 * 失敗が1つでもあれば fail、終わっていないものがあれば pending、すべて成功・中立・スキップなら pass、無ければ none。
 * 名前だけを残す（ログ・本文は読まない）
 */
export function summarizeChecks(rollup: unknown): {
  state: CiState;
  total: number;
  failing: string[];
} {
  if (!Array.isArray(rollup) || rollup.length === 0)
    return { state: "none", total: 0, failing: [] };
  const FAIL = new Set([
    "FAILURE",
    "ERROR",
    "CANCELLED",
    "TIMED_OUT",
    "ACTION_REQUIRED",
    "STARTUP_FAILURE",
  ]);
  const OK = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
  const failing: string[] = [];
  let pending = 0;
  let total = 0;
  for (const c of rollup as Record<string, unknown>[]) {
    if (!c || typeof c !== "object") continue;
    total++;
    const name = String(c.name ?? c.context ?? "?").slice(0, 80);
    const conclusion = typeof c.conclusion === "string" ? c.conclusion.toUpperCase() : "";
    const state = typeof c.state === "string" ? c.state.toUpperCase() : "";
    const status = typeof c.status === "string" ? c.status.toUpperCase() : "";
    const v = conclusion || state;
    if (FAIL.has(v)) failing.push(name);
    else if (OK.has(v) && (status === "" || status === "COMPLETED")) continue;
    else pending++;
  }
  const state: CiState = failing.length > 0 ? "fail" : pending > 0 ? "pending" : "pass";
  return { state, total, failing };
}

// ---------- Claude のアカウント（D-122） ----------

/**
 * 設定ディレクトリ → ディレクトリ名からの名前。`<home>/.claude` は null（「既定」と出す）、`.claude-acme` → `acme`、
 * それ以外（$CLAUDE_CONFIG_DIR の任意の場所）はディレクトリ名
 */
export function claudeAccountDirName(path: string, home: string): string | null {
  const p = path.replace(/\/+$/, "");
  if (p === `${home.replace(/\/+$/, "")}/.claude`) return null;
  const base = p.slice(p.lastIndexOf("/") + 1);
  const m = /^\.claude-(.+)$/.exec(base);
  return m ? (m[1] as string) : base || p;
}

export interface ClaudeAccountEnv {
  /** 子に足す（CLAUDE_CONFIG_DIR） */
  set: Record<string, string>;
  /** 子の環境から消す */
  unset: string[];
}

/**
 * 選んだアカウント → 起動するときの環境変数。`~/.claude` 以外は CLAUDE_CONFIG_DIR を付ける（既存のセッションを開くときの
 * resume コマンドと同じ考え方）。`~/.claude` を選んだときは、端末のシェルが CLAUDE_CONFIG_DIR を持っていても既定に戻すため
 * 消す（選択肢が2つ以上のとき＝利用者が選べたときだけ。1つだけなら端末の環境に任せる）
 */
export function claudeAccountEnv(
  account: string | null,
  home: string,
  choices: number,
): ClaudeAccountEnv {
  if (!account) return { set: {}, unset: [] };
  if (claudeAccountDirName(account, home) === null)
    return { set: {}, unset: choices >= 2 ? ["CLAUDE_CONFIG_DIR"] : [] };
  return { set: { CLAUDE_CONFIG_DIR: account }, unset: [] };
}

// ---------- Claude Code のフォルダの信頼 ----------

/**
 * Claude Code がそのフォルダを信頼しているか。untrusted のとき、対話モードの claude は起動の直後に
 * 「このフォルダを信頼しますか」で止まり、答えるまでセッションを作らない（hooks も動かない）。
 * unknown は設定のファイルが読めない・Claude Code でない
 */
export type FolderTrust = "trusted" | "untrusted" | "unknown";

/**
 * そのアカウントで Claude Code が読む設定のファイル（Claude Code 2.1 の決め方）: 設定ディレクトリ（無ければ `~/.claude`）に
 * 古い `.config.json` があればそれ、無ければ `$CLAUDE_CONFIG_DIR/.claude.json`（CLAUDE_CONFIG_DIR を付けない `~/.claude` は
 * `~/.claude.json`）。account が null・`~/.claude` は CLAUDE_CONFIG_DIR を付けずに起動する（claudeAccountEnv）
 */
export function claudeConfigFile(
  account: string | null,
  home: string,
  exists: (path: string) => boolean,
): string {
  const h = home.replace(/\/+$/, "");
  const dir = account ? account.replace(/\/+$/, "") : null;
  const configHome = dir ?? `${h}/.claude`;
  if (exists(`${configHome}/.config.json`)) return `${configHome}/.config.json`;
  return !dir || dir === `${h}/.claude` ? `${h}/.claude.json` : `${dir}/.claude.json`;
}

/** フォルダの git の位置: top は作業ツリーのルート、main は worktree のときの元のリポジトリのルート（無ければ top） */
export interface GitRoots {
  top: string | null;
  main: string | null;
}

function parentDir(p: string): string {
  const i = p.replace(/\/+$/, "").lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
}

/**
 * 信頼の判定で見る設定のキー（パス）。Claude Code 2.1 と同じ順:
 * 1. git のリポジトリなら元のリポジトリのルート（worktree は元のリポジトリの信頼を引き継ぐ）
 * 2. フォルダから上へ。git のリポジトリの中ではそのルートで止まる（リポジトリの外の親フォルダの信頼は効かない）。
 *    git でなければ `/` まで（親フォルダの信頼が効く）
 */
export function trustKeys(path: string, roots: GitRoots): string[] {
  const out: string[] = [];
  if (roots.main) out.push(roots.main);
  let s = path.replace(/\/+$/, "") || "/";
  for (let i = 0; i < 256; i++) {
    if (!out.includes(s)) out.push(s);
    if (roots.top && s === roots.top) break;
    const up = parentDir(s);
    if (up === s) break;
    s = up;
  }
  return out;
}

/** 設定のファイルの projects[<キー>].hasTrustDialogAccepted（キーごとの値。読めなければ null）から判定する */
export function folderTrust(keys: string[], flags: Record<string, boolean> | null): FolderTrust {
  if (!flags) return "unknown";
  return keys.some((k) => flags[k] === true) ? "trusted" : "untrusted";
}

/**
 * 依頼のセッションが見つからなかった（unlinked）理由:
 * - exited: claude（codex）がセッションを作らずに終わった（終了コードと、始めてから終わるまでの時間がある）
 * - untrusted: 動いているが、Claude Code がそのフォルダを信頼していない（信頼の確認で止まっている）
 * - no_session: 動いているが、セッションが来ない（それ以外）
 */
export type UnlinkedReason = "exited" | "untrusted" | "no_session";

/** turnlane ai run が知らせた終了から、紐づけを待つ時間（取り込みの遅れの分） */
export const EXIT_GRACE_MS = 60_000;

/** 紐づかないまま、unlinked にする理由（まだ待つなら null） */
export function unlinkedReason(o: {
  now: number;
  /** 受け取った時刻（無ければ依頼の時刻） */
  since: number;
  windowMs: number;
  exitedAt: number | null;
  trust: FolderTrust;
}): UnlinkedReason | null {
  if (o.exitedAt !== null && o.now - o.exitedAt >= EXIT_GRACE_MS) return "exited";
  if (o.since + o.windowMs >= o.now) return null;
  if (o.exitedAt !== null) return "exited";
  return o.trust === "untrusted" ? "untrusted" : "no_session";
}
