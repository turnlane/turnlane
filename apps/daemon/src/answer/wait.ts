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
