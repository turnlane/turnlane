/**
 * 待っている件の中身を表示の瞬間に読む（GET /api/work-items/:id/glance。D-207、ADR 0005 の追記 2）。
 *
 * - 取り込みのパーサが carry（ingest_cursor.carry_state_json）に覚えた行の位置から、セッションの記録を 1〜3 行だけ読む
 * - 読んだものは返すだけ。DB・ログ・SSE・MCP・通知・記録・エクスポートに渡さない。このモジュールはロガーを受け取らない
 *   （JSON のパースの失敗の文もトークンの一部を含むので、理由はコードだけにする）
 * - 文字列は返す前に伏せ字を通す（redact）。Edit / Write の中身・MCP の引数の値は読まない（パスとキー名だけ）
 * - Claude Code と、Codex の返答待ちの問い（最後の発言。codex.ts。保存しない）。Codex の許可待ち・エラー・件名の指示は
 *   読まない（unsupported）。読めなければ unavailable の理由だけを返し、状態の判定には影響させない
 * - 設定「待ちの中身を保存する」（turn.store_detail。ADR 0018）がオンなら、先に DB を読む: 件名はその日の最初に保存した
 *   自分の指示（ai_instruction。無ければ直近の保存した指示）、待ちの中身は自分の番を作ったときに保存したもの（wait_detail）。
 *   DB に無いときだけ記録を読む。保存は snapshotWaitDetails（デーモンの判定の後）とシンク（指示）が行う
 */
import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import {
  claudeGlanceHints,
  claudeLastText,
  claudeToolResultIds,
  claudeToolUse,
  claudeUserText,
  findClaudeTranscript,
  promptSubject,
  questionExcerpt,
  readJsonLineAt,
  readTailRecords,
} from "@turnlane/collectors";
import type {
  ErrorKind,
  GlancePermission,
  GlanceResponse,
  GlanceUnavailable,
} from "@turnlane/core/api";
import { errorKindOf } from "@turnlane/core/api";
import { redact } from "@turnlane/core/web";
import { cleanSubject, storedSubject } from "../derive/stored-subject.ts";
import { readCodexLastText } from "./codex.ts";

/** 自分の番に出るフォローアップの種類と代表の順（core の primaryFollowUp と同じ） */
const RANK: Record<string, number> = {
  approve: 0,
  resume_error: 1,
  reply: 2,
  review_pr: 3,
  merge_pr: 4,
};
const SHOWN = Object.keys(RANK);

/** 詳細に出すコマンドの行数 */
const FULL_LINES = 20;
/** 行に出す中身の上限（表示は幅で切る） */
const DETAIL_MAX = 300;

type Rec = Record<string, unknown>;

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim().length > 0 ? v : undefined;
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export interface GlanceOptions {
  now: number;
  /** 設定 turn.show_detail（既定オン） */
  showDetail: boolean;
  /** 利用者のホーム（パスの `~`）。省略時は os.homedir() */
  home?: string;
  /** このフォローアップの待ちを読む（省略時は代表の open なもの） */
  followUpId?: string;
  /**
   * フォローアップの無いセッションの待ち（D-240 の sessionWaitOf。猶予中の問い。D-245）。代表のフォローアップが無いときだけ、
   * そのターンの問いを読む
   */
  sessionWait?: { kind: "question" | "ask" | "permission"; turnId: string } | null;
  /** 保存した中身を先に読む（ADR 0018）。day は件名の論理日（その日の最初の指示） */
  stored?: { day: string };
  /**
   * Codex の問いを記録から読む（既定 true）。待ちの中身の保存（snapshotWaitDetails）は false: Codex の問いは表示の瞬間に
   * 読むだけで保存しない（ADR 0018 の保存の範囲は Claude Code のまま）
   */
  readCodex?: boolean;
}

export interface Target {
  id: string;
  kind: string;
  artifactRef: string;
  turnId: string | null;
}

/** 代表の open なフォローアップ（スヌーズ中だけのカードはスヌーズ中のもの）。followUpId があればそれ */
export function target(db: Database, workItemId: string, followUpId?: string): Target | null {
  const rows = db
    .query<
      {
        id: string;
        kind: string;
        status: string;
        artifact_ref: string;
        trigger_turn_id: string | null;
      },
      [string]
    >(
      `SELECT id, kind, status, artifact_ref, trigger_turn_id FROM follow_up
       WHERE work_item_id = ? AND deleted_at IS NULL AND status IN ('open', 'snoozed')
         AND kind IN (${SHOWN.map((k) => `'${k}'`).join(",")})`,
    )
    .all(workItemId);
  if (followUpId) {
    const x = rows.find((r) => r.id === followUpId);
    return x
      ? { id: x.id, kind: x.kind, artifactRef: x.artifact_ref, turnId: x.trigger_turn_id }
      : null;
  }
  const open = rows.some((r) => r.status === "open")
    ? rows.filter((r) => r.status === "open")
    : rows;
  const r = open.sort((a, b) => (RANK[a.kind] ?? 9) - (RANK[b.kind] ?? 9))[0];
  return r
    ? { id: r.id, kind: r.kind, artifactRef: r.artifact_ref, turnId: r.trigger_turn_id }
    : null;
}

/**
 * 読む待ち: 代表のフォローアップ → 無ければ猶予中の問い（セッションの待ちの question。D-245）。id は空（保存した中身は無い）。
 * 許可待ちのセッションの待ちはフォローアップがすぐできるので、ここでは問いだけを扱う
 */
function targetOr(db: Database, workItemId: string, o: GlanceOptions): Target | null {
  const t = target(db, workItemId, o.followUpId);
  if (t || o.followUpId || o.sessionWait?.kind !== "question") return t;
  return { id: "", kind: "reply", artifactRef: o.sessionWait.turnId, turnId: o.sessionWait.turnId };
}

export interface SessionRow {
  id: string;
  tool: string;
  external_id: string;
  file_path: string | null;
  source_id: string;
  root_path: string;
  turn_key: string | null;
}

/** 待ちのセッション: フォローアップのトリガのターンのセッション（無ければ AI 項目の最後のターンのセッション） */
export function sessionOf(
  db: Database,
  workItemId: string,
  turnId: string | null,
): SessionRow | null {
  const q = (where: string, arg: string) =>
    db
      .query<SessionRow, [string]>(
        `SELECT s.id, s.tool, s.external_id, s.file_path, s.source_id, src.root_path, t.turn_key
         FROM ai_turn t JOIN ai_session s ON s.id = t.session_id JOIN ai_source src ON src.id = s.source_id
         WHERE ${where} ORDER BY t.started_at DESC LIMIT 1`,
      )
      .get(arg);
  return (turnId ? q("t.id = ?", turnId) : null) ?? q("t.work_item_id = ?", workItemId);
}

export function lastHook(
  db: Database,
  sessionId: string,
  name: string,
  col: "tool_name" | "error_type",
): string | null {
  return (
    db
      .query<{ v: string | null }, [string, string]>(
        `SELECT h.${col} AS v FROM hook_event h
         JOIN ai_session s ON s.external_id = h.session_external_id AND s.tool = h.tool
         WHERE s.id = ? AND h.hook_event_name = ?
           AND (h.hook_event_name <> 'PermissionRequest' OR COALESCE(h.permission_mode, '') <> 'bypassPermissions')
         ORDER BY h.occurred_at DESC LIMIT 1`,
      )
      .get(sessionId, name)?.v ?? null
  );
}

/**
 * 待ちのターンの許可待ち（PermissionRequest）のツール名。そのターンの始まりより後の hook だけを見る（前のターンの許可待ちの
 * 名前で今の待ちを選ばない）。ターンが無ければセッションの最後のもの。Claude Code は AskUserQuestion のダイアログにも
 * PermissionRequest を出す（2.1.3xx で確認）ので、名前が AskUserQuestion なら許可ではなく問い（isAskPermission）
 */
export function permissionToolOf(
  db: Database,
  sessionId: string,
  turnId: string | null,
): string | null {
  if (!turnId) return lastHook(db, sessionId, "PermissionRequest", "tool_name");
  return (
    db
      .query<{ v: string | null }, [string, string]>(
        `SELECT h.tool_name AS v FROM hook_event h
         JOIN ai_session s ON s.external_id = h.session_external_id AND s.tool = h.tool
         JOIN ai_turn t ON t.id = ?
         WHERE s.id = ? AND h.hook_event_name = 'PermissionRequest' AND h.occurred_at >= t.started_at - 1000
           AND COALESCE(h.permission_mode, '') <> 'bypassPermissions'
         ORDER BY h.occurred_at DESC LIMIT 1`,
      )
      .get(turnId, sessionId)?.v ?? null
  );
}

/** 許可待ちの hook が AskUserQuestion のダイアログのものか（許可ではなく問い。「許可する」= 1 を送らない） */
export const isAskPermission = (tool: string | null): boolean => tool === "AskUserQuestion";

export function carryOf(db: Database, s: SessionRow): unknown {
  const root = s.root_path.replace(/\/+$/, "");
  if (!s.file_path?.startsWith(`${root}/`)) return null;
  const row = db
    .query<{ c: string | null }, [string, string]>(
      "SELECT carry_state_json AS c FROM ingest_cursor WHERE source_id = ? AND stream_key = ?",
    )
    .get(s.source_id, s.file_path.slice(root.length + 1));
  if (!row?.c) return null;
  try {
    return JSON.parse(row.c) as unknown;
  } catch {
    return null;
  }
}

/** パスの表示: リポジトリの中は相対、ホームの下は `~`、ほかはそのまま */
function displayPath(p: string, repoRoot: string | null, home: string): string {
  if (repoRoot && p.startsWith(`${repoRoot.replace(/\/+$/, "")}/`))
    return p.slice(repoRoot.replace(/\/+$/, "").length + 1);
  const h = home.replace(/\/+$/, "");
  if (h && p.startsWith(`${h}/`)) return `~${p.slice(h.length)}`;
  return p;
}

/** URL の表示: スキームと `?`・`#` 以降を落とす（トークンが入りやすい。spec-glance §4.1） */
function displayUrl(u: string): string {
  try {
    const x = new URL(u);
    return `${x.host}${x.pathname === "/" ? "" : x.pathname}`;
  } catch {
    return u.replace(/^[a-z]+:\/\//i, "").replace(/[?#].*$/, "");
  }
}

/** ツールの呼び出し → 表示する中身（Edit / Write の中身・MCP の引数の値は読まない） */
export function permissionOf(
  name: string,
  input: Rec,
  repoRoot: string | null,
  home: string,
): GlancePermission {
  let masked = false;
  const m = (s: string) => {
    const r = redact(s);
    if (r.masked) masked = true;
    return r.text;
  };
  const out: GlancePermission = { tool: name, masked: false };
  const label = str(input.description);
  if (name.startsWith("mcp__")) {
    const [, server, ...tool] = name.split("__");
    out.tool = server || name;
    if (tool.length > 0) out.sub = tool.join("__");
    out.argKeys = Object.keys(input).slice(0, 8);
  } else if (name === "Bash") {
    if (label) out.label = m(cut(label, DETAIL_MAX));
    const cmd = str(input.command);
    if (cmd) {
      const lines = cmd.replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n");
      out.detail = m(cut((lines[0] ?? "").trim(), DETAIL_MAX));
      out.detailKind = "command";
      if (lines.length > 1) out.moreLines = lines.length - 1;
      const full = lines.slice(0, FULL_LINES).join("\n");
      out.full = m(lines.length > FULL_LINES ? `${full}\n…` : full);
    }
  } else if (/^(Edit|MultiEdit|Write|NotebookEdit|Read)$/.test(name)) {
    const p = str(input.file_path) ?? str(input.notebook_path);
    if (p) {
      out.detail = m(cut(displayPath(p, repoRoot, home), DETAIL_MAX));
      out.detailKind = "path";
      if (name === "Write" && p.startsWith("/") && !existsSync(p)) out.isNew = true;
    }
  } else if (name === "WebFetch") {
    const u = str(input.url);
    if (u) {
      out.detail = m(cut(displayUrl(u), DETAIL_MAX));
      out.detailKind = "url";
    }
  } else if (name === "WebSearch") {
    const q = str(input.query);
    if (q) {
      out.detail = m(cut(q, DETAIL_MAX));
      out.detailKind = "query";
    }
  } else if (name === "Agent" || name === "Task") {
    if (label) out.label = m(cut(label, DETAIL_MAX));
  }
  out.masked = masked;
  return out;
}

/** AskUserQuestion の問いと選択肢（選択肢の説明文は出さない） */
export function askOf(input: Rec): GlanceResponse["ask"] | null {
  const qs = Array.isArray(input.questions) ? input.questions : [];
  const questions = qs.flatMap((q) => {
    const x = (q ?? {}) as Rec;
    const question = str(x.question);
    if (!question) return [];
    const options = (Array.isArray(x.options) ? x.options : []).flatMap((o) => {
      const l = str(((o ?? {}) as Rec).label);
      return l ? [redact(cut(l, 80)).text] : [];
    });
    return [{ question: redact(cut(question, DETAIL_MAX)).text, options }];
  });
  const first = questions[0];
  if (!first) return null;
  return {
    question: first.question,
    options: first.options.slice(0, 3),
    more: Math.max(0, first.options.length - 3),
    questions,
  };
}

interface Found<T> {
  value: T | null;
  fail: GlanceUnavailable | null;
}

/** 位置の行を読み、型が合えば値にする。位置が無い・合わないときは末尾から探す */
export function readAt<T>(
  path: string,
  at: number | null,
  pick: (rec: unknown) => T | null,
  fallback: (records: unknown[]) => T | null,
): Found<T> {
  if (at !== null) {
    const r = readJsonLineAt(path, at);
    if (r.ok) {
      const v = pick(r.value);
      if (v !== null) return { value: v, fail: null };
    } else if (r.reason === "missing") return { value: null, fail: "missing" };
  }
  const tail = readTailRecords(path);
  if (!tail.ok) return { value: null, fail: tail.reason === "missing" ? "missing" : "unreadable" };
  const v = fallback(tail.records);
  return v !== null ? { value: v, fail: null } : { value: null, fail: "unreadable" };
}

/**
 * 末尾の記録（新しい順）から、want のツールの待ちが開いているか: 結果の無い tool_use があれば open、want の tool_use が
 * あってどれも結果があれば closed、人の指示まで戻っても無ければ unknown（Claude Code はダイアログの間、その tool_use を
 * 記録に書かないことがある。無いことを閉じたとは言わない）
 */
export function toolWaitInTail(
  records: unknown[],
  want: (name: string) => boolean,
): "open" | "closed" | "unknown" {
  const done = new Set<string>();
  let seen = false;
  for (const rec of records) {
    for (const id of claudeToolResultIds(rec)) done.add(id);
    const tu = claudeToolUse(rec);
    if (tu && want(tu.name)) {
      if (!done.has(tu.id)) return "open";
      seen = true;
    }
    if (claudeUserText(rec) !== null) break;
  }
  return seen ? "closed" : "unknown";
}

/** 末尾の記録（新しい順）から、結果の無い最後の tool_use */
export function pendingInTail(
  records: unknown[],
  want: (name: string) => boolean,
): { name: string; input: Rec } | null {
  const done = new Set<string>();
  for (const rec of records) {
    for (const id of claudeToolResultIds(rec)) done.add(id);
    const tu = claudeToolUse(rec);
    if (tu && !done.has(tu.id) && want(tu.name)) return tu;
    // 人の指示まで戻ったら、そのターンの外
    if (claudeUserText(rec) !== null) return null;
  }
  return null;
}

/** 件名に使う直近の意味のある指示の 1 行目（位置が無い・合わないときは末尾から探す） */
function readPrompt(path: string, at: number | null): string | null {
  return readAt(
    path,
    at,
    (rec) => promptSubject(claudeUserText(rec)),
    (records) => {
      for (const rec of records) {
        const v = promptSubject(claudeUserText(rec));
        if (v !== null) return v;
      }
      return null;
    },
  ).value;
}

export { storedSubject } from "../derive/stored-subject.ts";

interface WaitDetailRow {
  kind: "permission" | "question" | "ask" | "error";
  text: string | null;
  options_json: string | null;
  tool: string | null;
  label: string | null;
  command: string | null;
  error_kind: string | null;
  masked: number;
}

function storedWait(db: Database, followUpId: string): WaitDetailRow | null {
  return (
    db
      .query<WaitDetailRow, [string]>(
        "SELECT kind, text, options_json, tool, label, command, error_kind, masked FROM wait_detail WHERE follow_up_id = ?",
      )
      .get(followUpId) ?? null
  );
}

/** 保存した待ちの中身を glance の形にする（伏せ字は保存の前に済んでいる） */
function fromStored(base: GlanceResponse, w: WaitDetailRow): GlanceResponse {
  const out: GlanceResponse = { ...base };
  const ek = w.error_kind ? errorKindOf(w.error_kind) : null;
  if (ek) out.error = ek;
  if (w.kind === "permission" && w.tool) {
    out.kind = "permission";
    const [tool, sub] = w.tool.split("\u0000");
    let meta: {
      detailKind?: GlancePermission["detailKind"];
      argKeys?: string[];
      moreLines?: number;
    } = {};
    try {
      meta = JSON.parse(w.options_json ?? "{}") as typeof meta;
    } catch {}
    out.permission = {
      tool: tool ?? w.tool,
      ...(sub ? { sub } : {}),
      ...(w.label ? { label: w.label } : {}),
      ...(w.command ? { detail: w.command, detailKind: meta.detailKind ?? "command" } : {}),
      ...(Array.isArray(meta.argKeys) ? { argKeys: meta.argKeys } : {}),
      ...(typeof meta.moreLines === "number" ? { moreLines: meta.moreLines } : {}),
      masked: w.masked === 1,
    };
  } else if (w.kind === "question" && w.text) {
    out.kind = "question";
    const row = w.text.split(/(?<=[。？！?!])\s*/)[0] ?? w.text;
    out.question = { row: cut(row, 80), detail: w.text, masked: w.masked === 1 };
  } else if (w.kind === "ask" && w.text) {
    // AskUserQuestion の options_json はすべての問いと選択肢 [{ question, options }]
    let questions: { question: string; options: string[] }[] = [];
    try {
      const v = JSON.parse(w.options_json ?? "[]") as unknown;
      if (Array.isArray(v))
        questions = v.flatMap((x) => {
          const q = (x ?? {}) as Rec;
          return typeof q.question === "string"
            ? [
                {
                  question: q.question,
                  options: (Array.isArray(q.options) ? q.options : []).filter(
                    (o): o is string => typeof o === "string",
                  ),
                },
              ]
            : [];
        });
    } catch {}
    const options = questions[0]?.options ?? [];
    out.kind = "ask";
    out.ask = {
      question: w.text,
      options: options.slice(0, 3),
      more: Math.max(0, options.length - 3),
      questions: questions.length > 0 ? questions : [{ question: w.text, options }],
    };
  }
  return out;
}

/**
 * Codex の待ち（D-207 (7) の「後から」の分）: 返答待ちの問いだけを記録から読む。Codex の問いは最後の発言そのもの
 * （codexLastReply）で、行と詳細の抜き出し（questionExcerpt）と伏せ字は Claude Code と同じ。AskUserQuestion は無い。
 * 許可待ち（approval）・エラーは今までどおり読まない（unsupported）。件名の指示も読まない
 */
function codexGlance(out: GlanceResponse, s: SessionRow, t: Target): GlanceResponse {
  if (t.kind !== "reply" || t.artifactRef.endsWith(":ask"))
    return { ...out, unavailable: "unsupported" };
  const r = readCodexLastText(s);
  if ("fail" in r) return { ...out, unavailable: r.fail };
  const q = questionExcerpt(r.text);
  if (!q) return { ...out, unavailable: "unreadable" };
  const row = redact(q.row);
  const detail = redact(q.detail);
  return {
    ...out,
    kind: "question",
    question: { row: row.text, detail: detail.text, masked: row.masked || detail.masked },
  };
}

/**
 * glance の本体。AI 項目が無ければ null（404）。読めなければ kind: "none" と unavailable の理由
 */
export function readGlance(
  db: Database,
  workItemId: string,
  o: GlanceOptions,
): GlanceResponse | null {
  const wi = db
    .query<{ repo_root: string | null; status: string; status_estimated: number }, [string]>(
      "SELECT repo_root, status, status_estimated FROM work_item WHERE id = ? AND deleted_at IS NULL",
    )
    .get(workItemId);
  if (!wi) return null;
  const base: GlanceResponse = { workItemId, kind: "none", readAt: o.now };
  if (!o.showDetail) return { ...base, unavailable: "off" };
  if (o.stored) {
    // 保存した中身を先に（ADR 0018）。件名はその日の最初の指示で固定される
    const subject = storedSubject(db, workItemId, o.stored.day);
    const t = targetOr(db, workItemId, o);
    const w = t?.id ? storedWait(db, t.id) : null;
    if (subject !== null && (!t || w)) {
      const withPrompt = { ...base, prompt: { text: subject } };
      return w ? fromStored(withPrompt, w) : withPrompt;
    }
    // 足りない分だけ記録から読む（件名は保存したものを優先）
    const { stored: _stored, ...rest } = o;
    const read = readGlance(db, workItemId, rest);
    if (!read) return read;
    const filled = w ? fromStored({ ...read, kind: "none" }, w) : read;
    return subject !== null ? { ...filled, prompt: { text: subject } } : filled;
  }
  // 待っていない項目（AI の線・詳細の見出し）も、件名に使う直近の指示だけは読む（fix-stale-title。spec-glance §2.2 の 3）
  const t = targetOr(db, workItemId, o);
  const s = sessionOf(db, workItemId, t?.turnId ?? null);
  if (!s) return base;
  if (!t) {
    if (s.tool !== "claude_code") return base;
    const path = findClaudeTranscript(s.root_path, s.file_path, s.external_id);
    if (!path) return base;
    const v = cleanSubject(readPrompt(path, claudeGlanceHints(carryOf(db, s))?.promptAt ?? null));
    return v ? { ...base, prompt: { text: redact(v).text } } : base;
  }
  const error: ErrorKind | null =
    t.kind === "resume_error" ? errorKindOf(lastHook(db, s.id, "StopFailure", "error_type")) : null;
  const withError = error ? { error } : {};
  if (s.tool === "codex" && o.readCodex !== false)
    return codexGlance({ ...base, ...withError }, s, t);
  if (s.tool !== "claude_code") return { ...base, ...withError, unavailable: "unsupported" };
  const path = findClaudeTranscript(s.root_path, s.file_path, s.external_id);
  if (!path) return { ...base, ...withError, unavailable: "missing" };
  const hints = claudeGlanceHints(carryOf(db, s));
  const sameTurn = hints !== null && hints.turnKey !== null && hints.turnKey === s.turn_key;
  const out: GlanceResponse = { ...base, ...withError };
  let fail: GlanceUnavailable | null = null;

  // 件名: 直近の意味のある指示。PR の待ちも読む（PR の題名は件名にせず理由の行へ。D-214 (1)）
  const p = readPrompt(path, hints?.promptAt ?? null);
  if (p) out.prompt = { text: redact(p).text };

  // AskUserQuestion のダイアログの PermissionRequest（Claude Code が出す）は許可ではなく問いとして読む
  const hookTool = t.kind === "approve" ? permissionToolOf(db, s.id, t.turnId) : null;
  const askByHook = isAskPermission(hookTool);
  if (t.kind === "approve" && !askByHook) {
    // hooks の PermissionRequest のツール名があれば、その名前の待ちを選ぶ
    const want = (n: string) => n !== "AskUserQuestion" && (!hookTool || n === hookTool);
    const pend = sameTurn
      ? [...(hints?.pend ?? [])].reverse().find((x) => want(x.name))
      : undefined;
    const tu = readAt(
      path,
      pend?.at ?? null,
      (rec) => (pend ? claudeToolUse(rec, pend.id) : null),
      (records) => pendingInTail(records, want),
    );
    if (tu.value) {
      out.kind = "permission";
      out.permission = permissionOf(
        tu.value.name,
        tu.value.input,
        wi.repo_root,
        o.home ?? homedir(),
      );
    } else fail = tu.fail;
    if (!out.permission && wi.status_estimated === 1) fail = "no_hooks";
  } else if (askByHook || (t.kind === "reply" && t.artifactRef.endsWith(":ask"))) {
    const pend = sameTurn
      ? [...(hints?.pend ?? [])].reverse().find((x) => x.name === "AskUserQuestion")
      : undefined;
    const tu = readAt(
      path,
      pend?.at ?? null,
      (rec) => (pend ? claudeToolUse(rec, pend.id) : null),
      (records) => pendingInTail(records, (n) => n === "AskUserQuestion"),
    );
    const ask = tu.value ? askOf(tu.value.input) : null;
    if (ask) {
      out.kind = "ask";
      out.ask = ask;
    } else fail = tu.fail ?? "unreadable";
  } else if (t.kind === "reply") {
    // 別のターンの位置（返答タスクの後にターンが進んだ）は使わない
    const q = sameTurn
      ? readAt(
          path,
          hints?.textAt ?? null,
          (rec) => questionExcerpt(claudeLastText(rec)),
          () => null,
        )
      : hints === null
        ? readAt(
            path,
            null,
            () => null,
            (records) => {
              for (const rec of records) {
                const v = questionExcerpt(claudeLastText(rec));
                if (v) return v;
                if (claudeUserText(rec) !== null) return null;
              }
              return null;
            },
          )
        : { value: null, fail: null };
    if (q.value) {
      const row = redact(q.value.row);
      const detail = redact(q.value.detail);
      out.kind = "question";
      out.question = { row: row.text, detail: detail.text, masked: row.masked || detail.masked };
    } else fail = q.fail;
  }
  if (out.kind === "none" && fail) out.unavailable = fail;
  return out;
}

/**
 * 新しい自分の番の待ちの中身を保存する（ADR 0018、D-218）。open な許可待ち・返答待ち・エラーで、まだ wait_detail の無いものを
 * 記録から 1 度だけ読み（伏せ字の後）、wait_detail に持つ。読めなかったものは tried に入れて同じ起動の間は読み直さない
 */
export function snapshotWaitDetails(
  db: Database,
  o: { now: number; home?: string; tried: Set<string> },
): number {
  const rows = db
    .query<{ id: string; work_item_id: string }, []>(
      `SELECT f.id, f.work_item_id FROM follow_up f
       WHERE f.deleted_at IS NULL AND f.status IN ('open', 'snoozed')
         AND f.kind IN ('approve', 'reply', 'resume_error')
         AND NOT EXISTS (SELECT 1 FROM wait_detail w WHERE w.follow_up_id = f.id)`,
    )
    .all()
    .filter((r) => !o.tried.has(r.id));
  let n = 0;
  for (const r of rows) {
    o.tried.add(r.id);
    const g = readGlance(db, r.work_item_id, {
      now: o.now,
      showDetail: true,
      readCodex: false,
      ...(o.home ? { home: o.home } : {}),
      followUpId: r.id,
    });
    if (!g) continue;
    let v: (Omit<WaitDetailRow, "masked"> & { masked: boolean }) | null = null;
    if (g.kind === "permission" && g.permission) {
      const p = g.permission;
      v = {
        kind: "permission",
        text: null,
        // 許可待ちの options_json は表示の形（detailKind・MCP の引数のキー名・残りの行数）
        options_json: JSON.stringify({
          ...(p.detailKind ? { detailKind: p.detailKind } : {}),
          ...(p.argKeys ? { argKeys: p.argKeys } : {}),
          ...(p.moreLines ? { moreLines: p.moreLines } : {}),
        }),
        tool: p.sub ? `${p.tool}\u0000${p.sub}` : p.tool,
        label: p.label ?? null,
        command: p.detail ?? null,
        error_kind: null,
        masked: p.masked,
      };
    } else if (g.kind === "question" && g.question) {
      v = {
        kind: "question",
        text: g.question.detail || g.question.row,
        options_json: null,
        tool: null,
        label: null,
        command: null,
        error_kind: null,
        masked: g.question.masked,
      };
    } else if (g.kind === "ask" && g.ask) {
      v = {
        kind: "ask",
        text: g.ask.question,
        // 問いが多くても 2000 文字に収める（doctor の監査の上限。後ろの問いから落とす）
        options_json: (() => {
          const qs = [...g.ask.questions];
          let j = JSON.stringify(qs);
          while (j.length > 2000 && qs.length > 1) {
            qs.pop();
            j = JSON.stringify(qs);
          }
          return j.length > 2000 ? "[]" : j;
        })(),
        tool: null,
        label: null,
        command: null,
        error_kind: null,
        masked: false,
      };
    } else if (g.error) {
      v = {
        kind: "error",
        text: null,
        options_json: null,
        tool: null,
        label: null,
        command: null,
        error_kind: g.error,
        masked: false,
      };
    }
    if (!v) continue;
    db.run(
      `INSERT INTO wait_detail (follow_up_id, kind, text, options_json, tool, label, command, error_kind, masked, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (follow_up_id) DO NOTHING`,
      [
        r.id,
        v.kind,
        v.text,
        v.options_json,
        v.tool,
        v.label,
        v.command,
        v.error_kind,
        v.masked ? 1 : 0,
        o.now,
      ],
    );
    n++;
  }
  return n;
}
