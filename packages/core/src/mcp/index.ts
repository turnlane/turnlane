/**
 * Claude Code / Codex への Turnlane の MCP サーバの登録（D-145。phase0-plan 3.6.2）。
 * `turnlane mcp install|uninstall|status`、`turnlane onboarding mcp`、`turnlane self-install`（古いパスの更新）、
 * デーモンの取り込み元の表示（設定 > AI の取り込み）が使う。
 *
 * - 登録先はユーザーのスコープ。名前は `turnlane`、command は turnlane の絶対パス、args は `["mcp"]`
 * - Claude Code: プロファイル（設定ディレクトリ）ごとの `.claude.json` の `mcpServers.turnlane`。
 *   既定の `~/.claude` は `~/.claude.json`、CLAUDE_CONFIG_DIR のプロファイル（`~/.claude-*` など）は `<dir>/.claude.json`。
 *   どちらも `<dir>/.config.json`（古い版の名前）があればそちらを読む（Claude Code の読み方に合わせる）
 * - Codex: `<CODEX_HOME>/config.toml` の `[mcp_servers.turnlane]`
 * - `.claude.json` にはサインインの情報やプロジェクトの状態も入っているので、読むのは `mcpServers.turnlane` だけ。
 *   中身をメッセージ・ログに出さない（JSON の読み取りエラーの文言も出さない。位置や断片が入りうる）
 * - 書く前に退避（`*.bak-turnlane-<時刻>`）、他のキーと書式を保つ、冪等。認証情報のファイルには触れない
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { ConfigParseError, type LoadedJson, loadJson, saveText } from "../hooks/json-file.ts";
import { codexHome, detectClaudeDirs } from "../hooks/targets.ts";

export const MCP_SERVER_NAME = "turnlane";
export const MCP_ARGS = ["mcp"] as const;

export type McpTool = "claude_code" | "codex";

export interface McpTarget {
  tool: McpTool;
  /** プロファイル（Claude の設定ディレクトリ）か CODEX_HOME */
  dir: string;
  /** 登録を書くファイル */
  file: string;
}

/** 失敗の種類（文言は CLI 側で言語に合わせる。ファイルの中身は含めない） */
export type McpErrorCode =
  | "unreadable" // JSON / TOML として読めない
  | "not_object" // トップレベルや mcpServers がオブジェクトでない
  | "changed" // 読んだ後に他のプロセスが書き換えた
  | "unsafe_toml"; // config.toml の turnlane が [mcp_servers.turnlane] の表の形でない・安全に書き換えられない

export class McpConfigError extends Error {
  constructor(
    readonly code: McpErrorCode,
    readonly file: string,
  ) {
    super(`${code}: ${file}`);
  }
}

/** Claude Code のユーザーの設定（.claude.json）の場所。dir が既定の ~/.claude なら ~/.claude.json */
export function claudeUserConfigFile(dir: string, home: string): string {
  const legacy = join(dir, ".config.json");
  if (existsSync(legacy)) return legacy;
  const d = dir.replace(/\/+$/, "");
  return d === join(home, ".claude") ? join(home, ".claude.json") : join(d, ".claude.json");
}

export function codexConfigFile(codexDir: string): string {
  return join(codexDir, "config.toml");
}

export function mcpTargetFor(tool: McpTool, dir: string, home: string): McpTarget {
  return {
    tool,
    dir,
    file: tool === "codex" ? codexConfigFile(dir) : claudeUserConfigFile(dir, home),
  };
}

/**
 * 登録先の一覧。claudeDirs も codex も指定しなければ、hooks と同じく見つかった Claude のプロファイルすべてと、
 * ~/.codex（CODEX_HOME）があれば Codex
 */
export function mcpTargets(
  home: string,
  vars: Record<string, string | undefined>,
  o: { claudeDirs?: string[]; codex?: boolean } = {},
): McpTarget[] {
  const explicit = (o.claudeDirs?.length ?? 0) > 0 || o.codex === true;
  const dirs = explicit ? (o.claudeDirs ?? []) : detectClaudeDirs(home, vars);
  const out = dirs.map((d) => mcpTargetFor("claude_code", d.replace(/\/+$/, ""), home));
  const ch = codexHome(home, vars);
  if (o.codex || (!explicit && existsSync(ch))) out.push(mcpTargetFor("codex", ch, home));
  return out;
}

/** 登録の中身のうち見るところ */
export interface McpEntry {
  command: string | null;
  args: string[] | null;
}

export type McpState = "none" | "installed" | "outdated";

export interface McpStatus {
  state: McpState;
  entry: McpEntry | null;
  /** outdated の理由: path（別の turnlane を指す）/ missing（command のファイルが無い）/ args / type */
  reason?: "path" | "missing" | "args" | "type";
}

/**
 * 登録の状態。expected（今の turnlane の絶対パス）があれば command がそれと同じかで見る。
 * 無ければ（開発中のデーモンなど）command のファイルがあるかで見る
 */
export function mcpStatusOf(entry: McpEntry | null, expected?: string | null): McpStatus {
  if (!entry) return { state: "none", entry: null };
  if (entry.command === null) return { state: "outdated", entry, reason: "type" };
  if (entry.args?.length !== 1 || entry.args[0] !== "mcp")
    return { state: "outdated", entry, reason: "args" };
  if (expected?.startsWith("/"))
    return entry.command === expected
      ? { state: "installed", entry }
      : { state: "outdated", entry, reason: "path" };
  return entry.command.startsWith("/") && existsSync(entry.command)
    ? { state: "installed", entry }
    : { state: "outdated", entry, reason: "missing" };
}

// ---------------------------------------------------------------- Claude（JSON）

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function entryOf(v: unknown): McpEntry | null {
  if (v === undefined) return null;
  if (!isObj(v)) return { command: null, args: null };
  const command = typeof v.command === "string" ? v.command : null;
  const args =
    Array.isArray(v.args) && v.args.every((x) => typeof x === "string")
      ? (v.args as string[])
      : null;
  return { command, args };
}

/** .claude.json の値から turnlane の登録だけを取り出す */
export function claudeEntry(value: Obj): McpEntry | null {
  const servers = value.mcpServers;
  if (!isObj(servers)) return null;
  return entryOf(servers[MCP_SERVER_NAME]);
}

/** `claude mcp add --scope user` と同じ形 */
export function claudeServerConfig(cli: string): Obj {
  return { type: "stdio", command: cli, args: [...MCP_ARGS], env: {} };
}

/** turnlane の登録を足す・直す（他のキーと順序はそのまま。既存の env などは残す） */
export function claudeInstall(value: Obj, cli: string, file = ""): Obj {
  const servers = value.mcpServers;
  if (servers !== undefined && !isObj(servers)) throw new McpConfigError("not_object", file);
  const cur = servers?.[MCP_SERVER_NAME];
  const next =
    isObj(cur) && (cur.type === undefined || cur.type === "stdio")
      ? { ...cur, command: cli, args: [...MCP_ARGS] }
      : claudeServerConfig(cli);
  return { ...value, mcpServers: { ...(servers ?? {}), [MCP_SERVER_NAME]: next } };
}

export function claudeUninstall(value: Obj, file = ""): Obj {
  const servers = value.mcpServers;
  if (servers === undefined) return value;
  if (!isObj(servers)) throw new McpConfigError("not_object", file);
  if (!(MCP_SERVER_NAME in servers)) return value;
  const { [MCP_SERVER_NAME]: _, ...rest } = servers;
  return { ...value, mcpServers: rest };
}

// ---------------------------------------------------------------- Codex（TOML）

/** TOML の基本文字列（JSON の文字列のエスケープは TOML の基本文字列と同じ範囲） */
function tomlString(s: string): string {
  return JSON.stringify(s);
}

export function codexBlock(cli: string): string {
  return `[mcp_servers.${MCP_SERVER_NAME}]\ncommand = ${tomlString(cli)}\nargs = ["mcp"]\n`;
}

/** 表の見出し（[a.b] / [[a.b]]）のキーの並び。見出しでなければ null */
function headerKeys(line: string): string[] | null {
  const m = /^\s*\[(\[?)(.*?)\](\]?)\s*(#.*)?$/.exec(line);
  if (!m) return null;
  const body = m[2] ?? "";
  const keys: string[] = [];
  let i = 0;
  const skip = () => {
    while (i < body.length && /\s/.test(body[i] as string)) i++;
  };
  while (i <= body.length) {
    skip();
    const c = body[i];
    if (c === '"' || c === "'") {
      const end = body.indexOf(c, i + 1);
      if (end < 0) return null;
      const raw = body.slice(i + 1, end);
      keys.push(c === '"' ? raw.replaceAll('\\"', '"').replaceAll("\\\\", "\\") : raw);
      i = end + 1;
    } else {
      const k = /^[A-Za-z0-9_-]+/.exec(body.slice(i));
      if (!k) return null;
      keys.push(k[0]);
      i += k[0].length;
    }
    skip();
    if (i >= body.length) break;
    if (body[i] !== ".") return null;
    i++;
  }
  return keys;
}

interface TomlLine {
  text: string;
  /** 見出しならキーの並び（複数行の文字列の中は見出しとみなさない） */
  header: string[] | null;
}

function scanToml(raw: string): TomlLine[] {
  const out: TomlLine[] = [];
  let inMulti: '"""' | "'''" | null = null;
  for (const text of raw.split("\n")) {
    let header: string[] | null = null;
    if (!inMulti) header = headerKeys(text);
    // 複数行の文字列の始まりと終わり（行の中の個数が奇数なら状態が変わる）
    for (const q of ['"""', "'''"] as const) {
      if (inMulti && inMulti !== q) continue;
      const n = text.split(q).length - 1;
      if (n % 2 === 1) inMulti = inMulti ? null : q;
    }
    out.push({ text, header });
  }
  return out;
}

const isTurnlaneHeader = (h: string[] | null) =>
  h !== null && h[0] === "mcp_servers" && h[1] === MCP_SERVER_NAME;

/** [mcp_servers.turnlane] とその下の表（.env など）の行の範囲。末尾の空行・コメントは次の表のものとして含めない */
function turnlaneRange(lines: TomlLine[]): { start: number; main: number; end: number } | null {
  const start = lines.findIndex((l) => isTurnlaneHeader(l.header) && l.header?.length === 2);
  if (start < 0) return null;
  let end = start + 1;
  let main = -1;
  while (end < lines.length) {
    const h = lines[end]?.header ?? null;
    if (h && !isTurnlaneHeader(h)) break;
    if (h && main < 0) main = end;
    end++;
  }
  if (main < 0) main = end;
  // 他の場所（離れた位置）に turnlane の下の表があれば安全に扱えない
  for (let i = end; i < lines.length; i++)
    if (isTurnlaneHeader(lines[i]?.header ?? null)) return null;
  while (end > start + 1) {
    const t = (lines[end - 1]?.text ?? "").trim();
    if (t === "" || t.startsWith("#")) end--;
    else break;
  }
  if (main > end) main = end;
  return { start, main, end };
}

function parseToml(raw: string, file: string): Obj {
  try {
    const v = Bun.TOML.parse(raw) as unknown;
    return isObj(v) ? v : {};
  } catch {
    throw new McpConfigError("unreadable", file);
  }
}

function withoutTurnlane(v: Obj): Obj {
  const servers = v.mcp_servers;
  if (!isObj(servers) || !(MCP_SERVER_NAME in servers)) return v;
  const { [MCP_SERVER_NAME]: _, ...rest } = servers;
  if (Object.keys(rest).length > 0) return { ...v, mcp_servers: rest };
  const { mcp_servers: _s, ...others } = v;
  return others;
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (!isObj(v)) return v;
  return Object.fromEntries(
    Object.keys(v)
      .sort()
      .map((k) => [k, sortKeys(v[k])]),
  );
}

export function codexEntry(value: Obj): McpEntry | null {
  const servers = value.mcp_servers;
  if (!isObj(servers)) return null;
  return entryOf(servers[MCP_SERVER_NAME]);
}

/**
 * 書き換えた結果が「turnlane 以外は同じ」で「turnlane が期待どおり」かを TOML として読んで確かめる。
 * 確かめられなければ書かない（unsafe_toml）
 */
function verifyToml(before: Obj, text: string, want: McpEntry | null, file: string): boolean {
  let after: Obj;
  try {
    after = parseToml(text, file);
  } catch {
    return false;
  }
  if (!sameJson(withoutTurnlane(before), withoutTurnlane(after))) return false;
  const e = codexEntry(after);
  if (want === null) return e === null;
  return e !== null && e.command === want.command && sameJson(e.args, want.args);
}

/** 値の行（key = ...）を置き換える。配列が複数行にわたるときは閉じ括弧の行まで */
function replaceKey(
  lines: string[],
  from: number,
  to: number,
  key: string,
  value: string,
): boolean {
  const re = new RegExp(`^\\s*${key}\\s*=`);
  for (let i = from; i < to; i++) {
    if (!re.test(lines[i] ?? "")) continue;
    let last = i;
    const rest = (lines[i] ?? "").replace(re, "").trim();
    if (rest.startsWith("[") && !rest.includes("]")) {
      while (last + 1 < to && !(lines[last] ?? "").includes("]")) last++;
    }
    lines.splice(i, last - i + 1, `${key} = ${value}`);
    return true;
  }
  return false;
}

/** config.toml に turnlane の登録を足す・直す（他の行はそのまま） */
export function codexInstallText(raw: string, cli: string, file = ""): string {
  const before = parseToml(raw, file);
  const want: McpEntry = { command: cli, args: [...MCP_ARGS] };
  const cur = codexEntry(before);
  if (cur && cur.command === cli && sameJson(cur.args, want.args)) return raw;
  const scanned = scanToml(raw);
  const range = turnlaneRange(scanned);
  if (cur && !range) throw new McpConfigError("unsafe_toml", file);
  let text: string;
  if (!range) {
    const block = codexBlock(cli);
    text = raw.trim() === "" ? block : `${raw.endsWith("\n") ? raw : `${raw}\n`}\n${block}`;
  } else {
    // 見出しの直下（下の表より前）の command と args だけを置き換える。無ければ見出しの直後に足す
    const lines = scanned.map((l) => l.text);
    const mainEnd = range.main;
    if (!replaceKey(lines, range.start + 1, mainEnd, "command", tomlString(cli)))
      lines.splice(range.start + 1, 0, `command = ${tomlString(cli)}`);
    const end2 = mainEnd + (lines.length - scanned.length);
    if (!replaceKey(lines, range.start + 1, end2, "args", '["mcp"]'))
      lines.splice(range.start + 2, 0, 'args = ["mcp"]');
    text = lines.join("\n");
  }
  if (!verifyToml(before, text, want, file)) throw new McpConfigError("unsafe_toml", file);
  return text;
}

/** config.toml から turnlane の登録（下の表を含む）を外す */
export function codexUninstallText(raw: string, file = ""): string {
  const before = parseToml(raw, file);
  if (!codexEntry(before)) return raw;
  const scanned = scanToml(raw);
  const range = turnlaneRange(scanned);
  if (!range) throw new McpConfigError("unsafe_toml", file);
  const lines = scanned.map((l) => l.text);
  lines.splice(range.start, range.end - range.start);
  // 足したときの空行を戻す（前が空行で、後ろが空行か終わりなら1行詰める）
  const s = range.start;
  if (s > 0 && lines[s - 1] === "" && (s >= lines.length || lines[s] === ""))
    lines.splice(s - 1, 1);
  let text = lines.join("\n");
  if (text === "\n") text = "";
  if (!verifyToml(before, text, null, file)) throw new McpConfigError("unsafe_toml", file);
  return text;
}

// ---------------------------------------------------------------- ファイル

export interface McpPlan {
  target: McpTarget;
  /** 実体のパス（シンボリックリンクなら先） */
  path: string;
  exists: boolean;
  before: McpEntry | null;
  after: McpEntry | null;
  /** 書く内容（変更が無ければ元と同じ） */
  text: string;
  changed: boolean;
  /** 足した・直した・外した・変更なし */
  action: "added" | "updated" | "removed" | "none";
  /** 書くために持っておく元の内容 */
  raw: string;
}

/** 読み取りエラーの文言を捨てる（.claude.json の断片を出さない） */
function loadClaude(file: string): LoadedJson {
  try {
    return loadJson(file);
  } catch (e) {
    if (e instanceof ConfigParseError) {
      const code = /トップレベル/.test(e.message) ? "not_object" : "unreadable";
      throw new McpConfigError(code, file);
    }
    throw new McpConfigError("unreadable", file);
  }
}

function loadText(file: string): { path: string; exists: boolean; raw: string } {
  const path = existsSync(file) ? realpathSync(file) : file;
  if (!existsSync(path)) return { path, exists: false, raw: "" };
  try {
    return { path, exists: true, raw: readFileSync(path, "utf8") };
  } catch {
    throw new McpConfigError("unreadable", file);
  }
}

/** 今の登録（読み取りだけ） */
export function readMcpEntry(target: McpTarget): McpEntry | null {
  if (target.tool === "claude_code") return claudeEntry(loadClaude(target.file).value);
  const f = loadText(target.file);
  return f.exists ? codexEntry(parseToml(f.raw, target.file)) : null;
}

export function mcpTargetStatus(target: McpTarget, expected?: string | null): McpStatus {
  return mcpStatusOf(readMcpEntry(target), expected);
}

/** install / uninstall で書く内容を決める（書かない） */
export function planMcp(target: McpTarget, action: "install" | "uninstall", cli: string): McpPlan {
  if (target.tool === "claude_code") {
    const f = loadClaude(target.file);
    const before = claudeEntry(f.value);
    const next =
      action === "install"
        ? claudeInstall(f.value, cli, target.file)
        : claudeUninstall(f.value, target.file);
    const text = `${JSON.stringify(next, null, f.indent)}${f.trailingNewline ? "\n" : ""}`;
    const after = claudeEntry(next);
    const changed = f.exists ? text !== f.raw : action === "install";
    return {
      target,
      path: f.path,
      exists: f.exists,
      before,
      after,
      text,
      changed,
      action: actionOf(before, after, changed),
      raw: f.raw,
    };
  }
  const f = loadText(target.file);
  const text =
    action === "install"
      ? codexInstallText(f.raw, cli, target.file)
      : codexUninstallText(f.raw, target.file);
  const before = f.exists ? codexEntry(parseToml(f.raw, target.file)) : null;
  const after = codexEntry(parseToml(text, target.file));
  const changed = text !== f.raw;
  return {
    target,
    path: f.path,
    exists: f.exists,
    before,
    after,
    text,
    changed,
    action: actionOf(before, after, changed),
    raw: f.raw,
  };
}

function actionOf(
  before: McpEntry | null,
  after: McpEntry | null,
  changed: boolean,
): McpPlan["action"] {
  if (!changed) return "none";
  if (!before && after) return "added";
  if (before && !after) return "removed";
  return "updated";
}

/** 決めた内容を書く（変更があるときだけ。既存のファイルは退避する） */
export function applyMcp(
  plan: McpPlan,
  opts: { backupSuffix: string; dryRun?: boolean },
): { changed: boolean; backup?: string } {
  if (!plan.changed) return { changed: false };
  try {
    const r = saveText({ path: plan.path, exists: plan.exists, raw: plan.raw }, plan.text, opts);
    return r.backup ? { changed: r.changed, backup: r.backup } : { changed: r.changed };
  } catch (e) {
    if (e instanceof Error && /変更されました/.test(e.message))
      throw new McpConfigError("changed", plan.target.file);
    throw e;
  }
}

/** 退避の名前の時刻（hooks と同じ形） */
export function backupStamp(now: number): string {
  return new Date(now)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}
