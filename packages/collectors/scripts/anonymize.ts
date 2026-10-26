/**
 * 実データ → 匿名化フィクスチャ（phase0-plan 5.2）。コミュニティのアダプタ作者も使う。
 *
 *   bun run --cwd packages/collectors anonymize -- --tool claude_code --root <検出ルート> --out <ケースのディレクトリ>
 *     [--max-turns N] [--partial-tail] <files...>
 *
 * 1. 各行をアダプタの許可リスト（allowlist）で絞る。本文は落とし、パーサの判定に要る性質だけを合成値で残す
 *    （質問で終わるか・締めの決まり文句か → "どちらにしますか？" / "他に何かありますか？" / "done."）
 * 2. cwd・ブランチ・セッション ID・PR 番号・リポジトリ名・タイトル・MCP のサーバ名を一貫した写像で置き換える
 *    （同じ入力は同じ出力。関係を保つ）。パスの中のセッション ID・cwd のエンコードも同じ写像で置き換える
 * 3. タイムスタンプは一定量ずらす（最初の時刻を 2026-09-01T09:00:00Z にそろえる。間隔は保つ）
 * 4. type・subtype・stop_reason・ツール名（mcp__ 以外）・バージョン・モデル名はそのまま残す
 * 5. 出力に元データの cwd・ユーザー名・ホーム・ホスト名・メールアドレス・リポジトリ名・ブランチ名・
 *    セッション ID が含まれないことを検査し、含まれていれば失敗する
 * 6. 出力はコミット前に目視で確認する
 *
 * --max-turns: 人間入力（Claude）/ task_started（Codex）が N 個を超えたところで切る
 * --partial-tail: 最後の行を途中で切り、改行なしで書く（書き込み途中の末尾行のケース）
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { dirname, join, relative } from "node:path";
import { CLAUDE_ALLOWLIST } from "../src/adapters/claude-code/transcript.ts";
import { CODEX_ALLOWLIST, SESSION_INDEX_KEYS } from "../src/adapters/codex/rollout.ts";
import { pickAllowed } from "../src/allowlist.ts";
import { textTraits } from "../src/closing-question.ts";

type Rec = Record<string, unknown>;

const TARGET_START = Date.UTC(2026, 8, 1, 9, 0, 0);
const KEEP_BRANCHES = new Set(["main", "master", "develop", "HEAD"]);
/** cwd の要素のうち、ありふれていて検査の対象にしないもの（キー名などに偶然含まれるため） */
const COMMON_DIRS = new Set([
  "Users",
  "home",
  "source",
  "src",
  "Documents",
  "Library",
  "projects",
  "repos",
  "work",
  "code",
  "Desktop",
  "private",
  "worktree",
  "worktrees",
  "Codex",
]);

export class Anonymizer {
  readonly #salt: string;
  readonly #maps = new Map<string, Map<string, string>>();
  /** 元データに含まれていた秘匿すべき文字列（出力の検査に使う） */
  readonly secrets = new Set<string>();
  shift = 0;

  constructor(salt = "turnlane-fixture") {
    this.#salt = salt;
  }

  #map(kind: string, value: string, make: (n: number) => string): string {
    let m = this.#maps.get(kind);
    if (!m) {
      m = new Map();
      this.#maps.set(kind, m);
    }
    let v = m.get(value);
    if (!v) {
      v = make(m.size + 1);
      m.set(value, v);
    }
    return v;
  }

  /** 決定的な偽の UUID（元の値の hash から） */
  id(value: string): string {
    return this.#map("id", value, () => {
      const h = createHash("sha256").update(`${this.#salt}:${value}`).digest("hex");
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
    });
  }

  cwd(value: string): string {
    this.secret(value);
    for (const part of value.split("/")) if (!COMMON_DIRS.has(part)) this.secret(part);
    return this.#map(
      "cwd",
      value,
      (n) => `/fixture/repo-${String.fromCharCode(96 + ((n - 1) % 26) + 1)}${n > 26 ? n : ""}`,
    );
  }

  branch(value: string): string {
    if (KEEP_BRANCHES.has(value)) return value;
    this.secret(value);
    return this.#map("branch", value, (n) => `feat/branch-${n}`);
  }

  repo(value: string): string {
    this.secret(value);
    for (const p of value.split("/")) if (p.length >= 4) this.secret(p);
    return this.#map("repo", value, (n) => `fixture-org/repo-${n}`);
  }

  prNumber(repo: string, n: number): number {
    return Number(this.#map("pr", `${repo}#${n}`, (k) => String(100 + k)));
  }

  title(value: string, kind = "title"): string {
    this.secret(value);
    return this.#map(kind, value, (n) => `Fixture ${kind} ${n}`);
  }

  mcpTool(name: string): string {
    if (!name.startsWith("mcp__")) return name;
    return this.#map("mcp", name, (n) => `mcp__fixture__tool${n}`);
  }

  secret(s: string): void {
    if (s.length >= 4) this.secrets.add(s);
  }

  time(ms: number): number {
    return ms + this.shift;
  }

  iso(s: unknown): unknown {
    if (typeof s !== "string") return s;
    const t = Date.parse(s);
    return Number.isNaN(t) ? s : new Date(this.time(t)).toISOString();
  }
}

/** 本文から判定に要る性質だけを残した合成文 */
function syntheticText(original: unknown): string {
  const t = textTraits(original);
  if (t.question && t.closing) return "他に何かありますか？";
  if (t.question) return "どちらの案にしますか？";
  return "done.";
}

function anonClaude(a: Anonymizer, raw: Rec): Rec | null {
  const type = typeof raw.type === "string" ? raw.type : "";
  const keys = (CLAUDE_ALLOWLIST as Record<string, readonly string[]>)[type];
  if (!keys) return null; // 対象外の型は落とす
  const r = pickAllowed(raw, keys);
  for (const k of ["sessionId", "uuid", "promptId"])
    if (typeof r[k] === "string") r[k] = a.id(r[k] as string);
  if (typeof r.cwd === "string") r.cwd = a.cwd(r.cwd);
  if (typeof r.gitBranch === "string") r.gitBranch = a.branch(r.gitBranch);
  if (r.timestamp !== undefined) r.timestamp = a.iso(r.timestamp);
  if (typeof r.aiTitle === "string") r.aiTitle = a.title(r.aiTitle);
  if (typeof r.prRepository === "string" && typeof r.prNumber === "number") {
    const repo = r.prRepository;
    r.prNumber = a.prNumber(repo, r.prNumber);
    r.prRepository = a.repo(repo);
    r.prUrl = `https://github.com/${r.prRepository}/pull/${r.prNumber}`;
    a.secret(String(raw.prUrl ?? ""));
  }
  const msg = r.message as Rec | undefined;
  const rawMsg = raw.message as Rec | undefined;
  if (msg) {
    if (typeof msg.id === "string") msg.id = a.id(msg.id);
    if (Array.isArray(msg.content) && Array.isArray(rawMsg?.content)) {
      msg.content = (msg.content as Rec[]).map((c, i) => {
        const src = (rawMsg.content as Rec[])[i] ?? {};
        const out: Rec = { ...(c ?? {}) };
        if (typeof out.id === "string") out.id = a.id(out.id);
        if (typeof out.tool_use_id === "string") out.tool_use_id = a.id(out.tool_use_id);
        if (typeof out.name === "string") out.name = a.mcpTool(out.name);
        if (out.type === "text") {
          const text = src.text;
          out.text =
            type === "user" && typeof text === "string" && text.startsWith("[Request interrupted")
              ? "[Request interrupted by user]"
              : type === "assistant"
                ? syntheticText(text)
                : "(text)";
        }
        return out;
      });
    }
  }
  // 人間の入力（文字列の content）は合成値に置き換える
  if (type === "user" && typeof rawMsg?.content === "string") {
    const first = rawMsg.content as string;
    r.message = {
      ...((r.message as Rec | undefined) ?? {}),
      content: first.startsWith("[Request interrupted")
        ? "[Request interrupted by user]"
        : "(prompt)",
    };
  }
  return r;
}

function anonCodex(a: Anonymizer, raw: Rec): Rec | null {
  const type = typeof raw.type === "string" ? raw.type : "";
  const ptype =
    typeof (raw.payload as Rec | undefined)?.type === "string" ? (raw.payload as Rec).type : "";
  const key = type === "event_msg" ? `event_msg:${ptype}` : type;
  const keys = (CODEX_ALLOWLIST as Record<string, readonly string[]>)[key];
  if (!keys) return null;
  const r = pickAllowed(raw, keys);
  if (r.timestamp !== undefined) r.timestamp = a.iso(r.timestamp);
  const p = (r.payload as Rec | undefined) ?? {};
  for (const k of ["id", "session_id", "turn_id", "parent_thread_id"]) {
    if (typeof p[k] === "string") p[k] = a.id(p[k] as string);
  }
  if (typeof p.cwd === "string") p.cwd = a.cwd(p.cwd);
  if (p.timestamp !== undefined) p.timestamp = a.iso(p.timestamp);
  for (const k of ["started_at", "completed_at"]) {
    if (typeof p[k] === "number") p[k] = Math.round(a.time((p[k] as number) * 1000) / 1000);
  }
  const git = p.git as Rec | undefined;
  if (git && typeof git.branch === "string") git.branch = a.branch(git.branch);
  if (key === "event_msg:task_complete") {
    p.last_agent_message = syntheticText((raw.payload as Rec).last_agent_message);
  }
  return r;
}

function anonSessionIndex(a: Anonymizer, raw: Rec): Rec | null {
  const r = pickAllowed(raw, SESSION_INDEX_KEYS);
  if (typeof r.id === "string") r.id = a.id(r.id);
  if (typeof r.thread_name === "string") r.thread_name = a.title(r.thread_name, "thread");
  if (r.updated_at !== undefined) r.updated_at = a.iso(r.updated_at);
  return r;
}

function firstTimestamp(lines: Rec[]): number | undefined {
  let min: number | undefined;
  for (const l of lines) {
    const t = typeof l.timestamp === "string" ? Date.parse(l.timestamp) : Number.NaN;
    if (!Number.isNaN(t)) min = Math.min(min ?? t, t);
  }
  return min;
}

/** 出力パス: パスの中のセッション ID・cwd のエンコード・日付を同じ写像で置き換える */
function outPath(a: Anonymizer, tool: string, rel: string, sessionCwd: string | undefined): string {
  const uuidRe = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
  let p = rel.replace(uuidRe, (m) => a.id(m));
  if (tool === "claude_code") {
    // projects/<enc-cwd>/... の enc-cwd は cwd から作り直す
    const parts = p.split("/");
    if (parts[0] === "projects" && parts[1] && sessionCwd) {
      parts[1] = a.cwd(sessionCwd).replaceAll(/[/.]/g, "-");
      p = parts.join("/");
    }
  } else {
    p = p.replace(/^sessions\/\d{4}\/\d{2}\/\d{2}\//, () => {
      const d = new Date(TARGET_START);
      const ymd = d.toISOString().slice(0, 10).split("-");
      return `sessions/${ymd[0]}/${ymd[1]}/${ymd[2]}/`;
    });
    p = p.replace(/rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}/, () => {
      const iso = new Date(TARGET_START).toISOString().slice(0, 19).replaceAll(":", "-");
      return `rollout-${iso}`;
    });
  }
  return p;
}

export interface AnonymizeOptions {
  tool: "claude_code" | "codex";
  root: string;
  out: string;
  files: string[];
  maxTurns?: number;
  partialTail?: boolean;
  anonymizer?: Anonymizer;
}

export function anonymize(o: AnonymizeOptions): { written: string[]; anonymizer: Anonymizer } {
  const a = o.anonymizer ?? new Anonymizer();
  const user = userInfo().username;
  for (const s of [user, o.root, dirname(o.root), hostname()]) a.secret(s);
  const parsed = o.files.map((f) => ({
    file: f,
    lines: readFileSync(f, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as Rec];
        } catch {
          return [];
        }
      }),
  }));
  // 時刻のずらし量はファイル全体で共通（関係を保つ）
  const starts = parsed
    .map((p) => firstTimestamp(p.lines))
    .filter((t): t is number => t !== undefined);
  if (starts.length > 0) a.shift = TARGET_START - Math.min(...starts);

  const written: string[] = [];
  for (const { file, lines } of parsed) {
    const rel = relative(o.root, file);
    const isIndex = rel === "session_index.jsonl";
    let turns = 0;
    const out: Rec[] = [];
    let sessionCwd: string | undefined;
    for (const raw of lines) {
      if (typeof raw.cwd === "string" && !sessionCwd) sessionCwd = raw.cwd;
      const pc = (raw.payload as Rec | undefined)?.cwd;
      if (typeof pc === "string" && !sessionCwd) sessionCwd = pc;
      // 秘匿すべき値を集める（出力の検査用）
      for (const k of ["sessionId", "session_id", "id"])
        if (typeof raw[k] === "string") a.secret(raw[k] as string);
      if (typeof raw.gitBranch === "string" && !KEEP_BRANCHES.has(raw.gitBranch))
        a.secret(raw.gitBranch);
      if (o.maxTurns !== undefined) {
        const startsTurn =
          o.tool === "claude_code"
            ? raw.type === "user" && (raw.origin as Rec | undefined)?.kind === "human"
            : raw.type === "event_msg" && (raw.payload as Rec | undefined)?.type === "task_started";
        if (startsTurn && ++turns > o.maxTurns) break;
      }
      const r = isIndex
        ? anonSessionIndex(a, raw)
        : o.tool === "claude_code"
          ? anonClaude(a, raw)
          : anonCodex(a, raw);
      if (r) out.push(r);
    }
    for (const s of [...rel.matchAll(/[0-9a-f]{8}-[0-9a-f-]{27}/g)].map((m) => m[0])) a.secret(s);
    const dest = join(o.out, outPath(a, o.tool, rel, sessionCwd));
    let text = out.map((r) => JSON.stringify(r)).join("\n");
    text =
      o.partialTail && text.length > 20
        ? text.slice(0, text.length - Math.floor((text.length - text.lastIndexOf("\n")) / 2))
        : `${text}\n`;
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, text);
    written.push(dest);
  }
  // 5. 出力に元の値が残っていないことを検査する
  for (const w of written) {
    const text = readFileSync(w, "utf8") + w.slice(o.out.length);
    for (const s of a.secrets) {
      if (text.includes(s)) {
        throw new Error(`anonymize: 出力に元データの値が残っています（${w}、長さ ${s.length}）`);
      }
    }
    if (/[\w.+-]+@[\w-]+\.[\w.]+/.test(text))
      throw new Error(`anonymize: メールアドレスらしき値が残っています（${w}）`);
  }
  return { written, anonymizer: a };
}

if (import.meta.main) {
  const args = process.argv.slice(2).filter((x) => x !== "--");
  const opt = (k: string) => {
    const i = args.indexOf(k);
    if (i < 0) return undefined;
    const v = args[i + 1];
    args.splice(i, 2);
    return v;
  };
  const tool = opt("--tool");
  const root = opt("--root");
  const out = opt("--out");
  const maxTurns = opt("--max-turns");
  const partialIdx = args.indexOf("--partial-tail");
  if (partialIdx >= 0) args.splice(partialIdx, 1);
  if ((tool !== "claude_code" && tool !== "codex") || !root || !out || args.length === 0) {
    console.error(
      "usage: anonymize --tool claude_code|codex --root <dir> --out <case dir> [--max-turns N] [--partial-tail] <files...>",
    );
    process.exit(2);
  }
  const r = anonymize({
    tool,
    root,
    out,
    files: args,
    ...(maxTurns ? { maxTurns: Number(maxTurns) } : {}),
    partialTail: partialIdx >= 0,
  });
  for (const w of r.written) console.log(`wrote ${relative(process.cwd(), w)}`);
}
