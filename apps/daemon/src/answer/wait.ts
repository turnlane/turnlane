/**
 * Turnlane から答える（D-238、ADR 0019）: 今開いている待ちの中身を表示の瞬間に読む（GET /api/work-items/:id/wait）と、
 * 待ちがまだ開いているか・送った後に記録が進んだかを記録ファイルの末尾から確かめる。
 *
 * - 読むのは glance と同じ記録（Claude Code のトランスクリプト）。問いの全文（2,000 字まで）は返すだけで保存しない。
 *   DB・ログ・SSE・MCP・通知に渡さない。このモジュールはロガーを受け取らない（ADR 0005 の追記 2、ADR 0018）
 * - 文字列は返す前に伏せ字を通す（redact）。許可待ちの中身は glance と同じ（permissionOf）
 * - Codex は返答待ちの問いだけ記録から読む（最後の発言。glance と同じ codex.ts）。許可待ち・エラーは読まない。開いているかは
 *   DB の状態だけで見る
 * - 待ちの対象は core の `derive.openWaitOf`（D-240）: 開いているフォローアップ → 無ければセッションの待ち（runner が
 *   判定のたびに作る。猶予の間の問いもここに入る）
 */
import type { Database } from "bun:sqlite";
import { homedir } from "node:os";
import {
  claudeGlanceHints,
  claudeLastText,
  claudeToolUse,
  claudeUserText,
  findClaudeTranscript,
  REPORT_ENTRYPOINT,
  readTailRecords,
} from "@turnlane/collectors";
import { derive, numberedOptions, WAIT_QUESTION_MAX } from "@turnlane/core";
import type { ErrorKind, GlancePermission, GlanceUnavailable, WaitKind } from "@turnlane/core/api";
import { errorKindOf } from "@turnlane/core/api";
import { redact } from "@turnlane/core/web";
import { readCodexLastText } from "../glance/codex.ts";
import {
  askOf,
  carryOf,
  isAskPermission,
  lastHook,
  pendingInTail,
  permissionOf,
  permissionToolOf,
  readAt,
  reportWaitDetail,
  type SessionRow,
  sessionOf,
  type Target,
  target,
  toolWaitInTail,
} from "../glance/index.ts";

export interface WaitRead {
  /** 答える対象（D-240）。無ければ null（kind は none） */
  wait: derive.OpenWait | null;
  /** 答える先のフォローアップ（対象がフォローアップのときだけ） */
  followUp: (Target & { status: string; triggerAt: number }) | null;
  session: SessionRow | null;
  kind: WaitKind;
  question?: { text: string; truncated: boolean; masked: boolean };
  options?: { n: number; label: string }[];
  permission?: GlancePermission;
  error?: ErrorKind;
  unavailable?: GlanceUnavailable;
}

type Rec = Record<string, unknown>;

/** フォローアップの種類 → 待ちの種類 */
export function waitKindOf(t: Pick<Target, "kind" | "artifactRef"> | null): WaitKind {
  return (t && derive.followUpWaitKind(t.kind, t.artifactRef)) ?? "none";
}

/**
 * カードの答える対象（D-240。core の openWaitOf）: 開いているフォローアップ（approve → resume_error → reply）→
 * 無ければセッションの待ち。queue・詳細・wait・answer が同じ関数を使う
 */
export function openWaitFor(
  db: Database,
  workItemId: string,
  sessionWait: derive.SessionWait | null,
): derive.OpenWait | null {
  const t = target(db, workItemId);
  const w = derive.openWaitOf(t, sessionWait);
  if (w?.kind !== "permission") return w;
  // Claude Code は AskUserQuestion のダイアログにも PermissionRequest を出す。許可ではなく問いとして扱う
  // （「許可する」= 1 を送ると最初の選択肢を選んでしまう）
  const s = sessionOf(db, workItemId, w.turnId);
  return s && isAskPermission(permissionToolOf(db, s.id, w.turnId)) ? { ...w, kind: "ask" } : w;
}

const cutText = (s: string) =>
  s.length > WAIT_QUESTION_MAX
    ? { text: `${s.slice(0, WAIT_QUESTION_MAX - 1)}…`, truncated: true }
    : { text: s, truncated: false };

function followUpOf(db: Database, workItemId: string): WaitRead["followUp"] {
  const t = target(db, workItemId);
  if (!t) return null;
  const r = db
    .query<{ status: string; trigger_at: number }, [string]>(
      "SELECT status, trigger_at FROM follow_up WHERE id = ?",
    )
    .get(t.id);
  return r ? { ...t, status: r.status, triggerAt: r.trigger_at } : null;
}

/** 記録の末尾（新しい順）から、結果の無い最後の AI の問いの文（人の指示まで戻ったら無し） */
function questionInTail(records: unknown[]): string | null {
  for (const rec of records) {
    if (claudeUserText(rec) !== null) return null;
    const t = claudeLastText(rec);
    if (t) return t;
  }
  return null;
}

/** 待ちの中身を表示の瞬間に読む。AI 項目が無ければ null */
export function readWait(
  db: Database,
  workItemId: string,
  o: { showDetail: boolean; home?: string; sessionWait?: derive.SessionWait | null },
): WaitRead | null {
  const wi = db
    .query<{ repo_root: string | null }, [string]>(
      "SELECT repo_root FROM work_item WHERE id = ? AND deleted_at IS NULL",
    )
    .get(workItemId);
  if (!wi) return null;
  const wait = openWaitFor(db, workItemId, o.sessionWait ?? null);
  const fu = wait?.followUpId ? followUpOf(db, workItemId) : null;
  const kind: WaitKind = wait?.kind ?? "none";
  const s = sessionOf(db, workItemId, wait?.turnId ?? null);
  const out: WaitRead = { wait, followUp: fu, session: s, kind };
  if (!wait) return out;
  if (kind === "error") {
    const e = s ? errorKindOf(lastHook(db, s.id, "StopFailure", "error_type")) : null;
    if (e) out.error = e;
  }
  if (!o.showDetail) return { ...out, unavailable: "off" };
  if (!s) return { ...out, unavailable: "missing" };
  if (s.tool === "codex" && kind === "question") {
    // Codex の問いは最後の発言そのもの（glance と同じ読み方。codex.ts）。許可待ち・エラーは今までどおり読まない
    const r = readCodexLastText(s);
    if ("fail" in r) return { ...out, unavailable: r.fail };
    if (!r.text) return { ...out, unavailable: "unreadable" };
    return withQuestion(out, r.text);
  }
  // 報告の項目（ADR 0021）: 記録は無いので、取り込みのときに持った中身（自分の番の wait_detail か、ターンの wait_json）
  const reported = reportWaitOf(db, wait.followUpId, wait.turnId);
  if (reported !== undefined) {
    if (!reported) return { ...out, unavailable: "unsupported" };
    if (reported.kind === "permission") {
      out.permission = { tool: reported.tool ?? "permission", masked: reported.masked };
      if (reported.label) out.permission.label = reported.label;
      return out;
    }
    const text = reported.text ?? "";
    out.question = { ...cutText(text), masked: reported.masked };
    const opts = reported.options_json ? optionsOf(reported.options_json) : [];
    if (opts.length > 0) out.options = opts.map((label, i) => ({ n: i + 1, label }));
    return out;
  }
  if (s.tool !== "claude_code") return { ...out, unavailable: "unsupported" };
  if (kind === "error") return out;
  const path = findClaudeTranscript(s.root_path, s.file_path, s.external_id);
  if (!path) return { ...out, unavailable: "missing" };
  const hints = claudeGlanceHints(carryOf(db, s));
  const sameTurn = hints !== null && hints.turnKey !== null && hints.turnKey === s.turn_key;
  if (kind === "permission" || kind === "ask") {
    const ask = kind === "ask";
    const hookTool = ask ? null : permissionToolOf(db, s.id, wait.turnId);
    const want = (n: string) =>
      ask ? n === "AskUserQuestion" : n !== "AskUserQuestion" && (!hookTool || n === hookTool);
    const pend = sameTurn
      ? [...(hints?.pend ?? [])].reverse().find((x) => want(x.name))
      : undefined;
    const tu = readAt(
      path,
      pend?.at ?? null,
      (rec) => (pend ? claudeToolUse(rec, pend.id) : null),
      (records) => pendingInTail(records, want),
    );
    if (!tu.value) return { ...out, unavailable: tu.fail ?? "unreadable" };
    if (!ask) {
      out.permission = permissionOf(
        tu.value.name,
        tu.value.input,
        wi.repo_root,
        o.home ?? homedir(),
      );
      return out;
    }
    const a = askOf(tu.value.input);
    if (!a) return { ...out, unavailable: "unreadable" };
    // AskUserQuestion: 問いを改行でつなぐ。選択肢は最初の問いのもの（ダイアログは 1 問ずつ出る）
    const text = cutText(a.questions.map((q) => q.question).join("\n"));
    out.question = { ...text, masked: false };
    out.options = (a.questions[0]?.options ?? []).map((label, i) => ({ n: i + 1, label }));
    return out;
  }
  // AI の問い（返答待ち）: 全文を読む
  const q = sameTurn
    ? readAt(path, hints?.textAt ?? null, (rec) => claudeLastText(rec), questionInTail)
    : readAt(path, null, () => null, questionInTail);
  if (!q.value) return { ...out, unavailable: q.fail ?? "unreadable" };
  return withQuestion(out, q.value);
}

/** 問いの全文（伏せ字の後に 2,000 字で切る）と、文の最後の番号付きの選択肢 */
function withQuestion(out: WaitRead, text: string): WaitRead {
  const r = redact(text.trim());
  out.question = { ...cutText(r.text), masked: r.masked };
  const opts = numberedOptions(r.text);
  if (opts.length > 0) out.options = opts;
  return out;
}

/**
 * 待ちがまだ開いているか（送る前と、送った後に記録が進んだかの確かめ）。
 * - DB のフォローアップが open / snoozed でなければ閉じている
 * - フォローアップの無い待ち（D-240）は、今のセッションの待ち（runner の最後の判定）が同じターン・同じ種類でなければ閉じている
 * - Claude Code: 記録の末尾で、許可待ち・AskUserQuestion は結果の無い tool_use が残っているか、問い・エラーは最後の
 *   人の指示より後に AI の発言があるか（人の指示が最後なら閉じている）
 * - 記録が読めない・Codex は DB の状態だけで判断する（読めないことを閉じたとは言わない）
 * 戻り値の readable は確かめられたか（DB で閉じている・記録を読めた）
 */
export function waitOpen(
  db: Database,
  w: Pick<WaitRead, "wait" | "followUp" | "session" | "kind">,
  sessionWait: derive.SessionWait | null = null,
): { open: boolean; readable: boolean } {
  if (!w.wait) return { open: false, readable: true };
  const fu = w.followUp;
  if (fu) {
    const st = db
      .query<{ status: string }, [string]>(
        "SELECT status FROM follow_up WHERE id = ? AND deleted_at IS NULL",
      )
      .get(fu.id)?.status;
    if (st !== "open" && st !== "snoozed") return { open: false, readable: true };
  } else if (sessionWait?.turnId !== w.wait.turnId || sessionWait?.kind !== w.wait.kind)
    return { open: false, readable: true };
  const s = w.session;
  if (s?.tool !== "claude_code") return { open: true, readable: false };
  const path = findClaudeTranscript(s.root_path, s.file_path, s.external_id);
  if (!path) return { open: true, readable: false };
  const tail = readTailRecords(path, 256 * 1024);
  if (!tail.ok) return { open: true, readable: false };
  const st = waitStateInTail(tail.records, w.kind);
  return st === "unknown"
    ? { open: true, readable: false }
    : { open: st === "open", readable: true };
}

/**
 * 記録の末尾（新しい順）から、待ちが開いているか（純粋な関数。テストする）。許可待ち・AskUserQuestion で、その tool_use が
 * 記録にまだ無い（Claude Code はダイアログの間、書かないことがある）ときは unknown（DB の状態だけで判断する）
 */
export function waitStateInTail(records: unknown[], kind: WaitKind): "open" | "closed" | "unknown" {
  if (kind === "permission") return toolWaitInTail(records, (n) => n !== "AskUserQuestion");
  if (kind === "ask") return toolWaitInTail(records, (n) => n === "AskUserQuestion");
  for (const rec of records) {
    if (claudeUserText(rec) !== null) return "closed";
    if ((rec as Rec | null)?.type === "assistant") return "open";
  }
  return "open";
}

/**
 * 報告の項目の待ちの中身（ADR 0021）。報告のセッションでなければ undefined、報告だが中身が無い（保存しない設定）なら null
 */
function reportWaitOf(
  db: Database,
  followUpId: string | null,
  turnId: string | null,
): (ReturnType<typeof reportWaitDetail> & object) | null | undefined {
  if (!turnId) return undefined;
  const t = db
    .query<{ wait_json: string | null; entrypoint: string | null }, [string]>(
      "SELECT t.wait_json, s.entrypoint FROM ai_turn t JOIN ai_session s ON s.id = t.session_id WHERE t.id = ?",
    )
    .get(turnId);
  if (t?.entrypoint !== REPORT_ENTRYPOINT) return undefined;
  const stored = followUpId
    ? db
        .query<
          {
            kind: "permission" | "question" | "ask" | "error";
            text: string | null;
            options_json: string | null;
            tool: string | null;
            label: string | null;
            masked: number;
          },
          [string]
        >(
          "SELECT kind, text, options_json, tool, label, masked FROM wait_detail WHERE follow_up_id = ?",
        )
        .get(followUpId)
    : null;
  if (stored)
    return {
      ...stored,
      command: null,
      error_kind: null,
      masked: stored.masked === 1,
    };
  return t.wait_json ? reportWaitDetail(t.wait_json) : null;
}

/** 報告の問いの選択肢（wait_detail の options_json は AskUserQuestion と同じ問いの配列） */
function optionsOf(json: string): string[] {
  try {
    const v = JSON.parse(json) as { options?: unknown }[];
    const o = Array.isArray(v) ? v[0]?.options : undefined;
    return Array.isArray(o) ? o.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
