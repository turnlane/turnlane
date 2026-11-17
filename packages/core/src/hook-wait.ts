/**
 * hook で答える（ADR 0023。m2-api 42 章）の純粋な部分: 待っている hook とカードの待ちの対応、hook の待ちを取り下げる
 * 条件、AskUserQuestion の答えの検証。デーモン（answer/hook-waits.ts）が使い、表駆動のテストで確かめる。
 *
 * 前提（Claude Code 2.1.326 で確かめた。ADR 0023 の Context）
 * - PermissionRequest の hook は本体の確認（端末のダイアログ・SDK のアプリの canUseTool）と並んで動き、先に答えた方が勝つ
 * - 同じセッションの同じエージェント（本体、または 1 つのサブエージェント）の確認は 1 つずつ出る（前が閉じてから次の hook が
 *   動く）。並んだサブエージェントの確認は同時に開く（agent_id が違う）
 * - hook の入力に tool_use の ID は無い（session_id・agent_id・tool_name だけで対応させる）
 */
import { prepareAnswer } from "./answer.ts";
import type { HookAskChoice } from "./api/hook-wait.ts";

/** hook の 1 回の long-poll の上限 */
export const HOOK_WAIT_POLL_MAX_MS = 25_000;
/** hook から聞かれない時間がこれを超えたら、hook はもう居ない（取り下げる） */
export const HOOK_WAIT_STALE_MS = 90_000;
/**
 * 開いてからこの時間たってもカードに待ちとして一度も現れなかった hook は取り下げる（Turnlane から答えられない待ち。
 * プログラム経由・判定の対象外のサブエージェントなど）。取り込みの遅れ（spool の追記からの数秒）より十分に長くとる
 */
export const HOOK_WAIT_UNSEEN_MS = 60_000;
/** 同時に開いておく hook の待ちの上限（超えたら古いものから取り下げる） */
export const HOOK_WAIT_MAX = 64;
/** 取り下げた・答えた待ちを覚えておく長さ（遅れて聞きに来た hook に withdrawn を返す） */
export const HOOK_WAIT_KEEP_MS = 10 * 60_000;

export interface HookWaitEntry {
  id: string;
  /** Claude Code の session_id */
  session: string;
  /** サブエージェントの agent_id（本体は null） */
  agentId: string | null;
  tool: string;
  openedAt: number;
  lastPollAt: number;
  /** カードの待ちとして一度でも見えたか */
  seen: boolean;
}

/** カードの待ち（答える対象）と同じものを待っている hook。ちょうど 1 つに決まらなければ null（hook では送らない） */
export function matchHookWait<T extends Pick<HookWaitEntry, "session" | "tool">>(
  entries: Iterable<T>,
  q: { session: string; kind: "permission" | "ask"; tool: string | null },
): T | null {
  const hits: T[] = [];
  for (const e of entries) {
    if (e.session !== q.session) continue;
    if (q.kind === "ask" ? e.tool !== "AskUserQuestion" : e.tool === "AskUserQuestion") continue;
    if (q.kind === "permission" && q.tool && e.tool !== q.tool) continue;
    hits.push(e);
  }
  return hits.length === 1 ? (hits[0] as T) : null;
}

/** 取り下げの理由（meta だけをログに出す） */
export type HookWaitWithdrawal =
  | "superseded"
  | "turn_moved"
  | "session_end"
  | "closed"
  | "unseen"
  | "gone";

/** そのセッションの、hook の待ちを開いた後に届いた hook のイベント（spool に残すキーだけ） */
export interface LaterHook {
  name: string;
  agentId: string | null;
  at: number;
}

/**
 * hook の待ちを取り下げるか（理由。続けるなら null）。どれも「待ちが別の形で閉じた」の手がかりで、取り下げても hook は
 * 何も出さずに終わるだけ（本体の確認はそのまま残る）なので、迷ったら取り下げる向きに倒してよい
 * - gone: hook から聞かれなくなった（hook が終わった）
 * - session_end: セッションが終わった（SessionEnd の hook）
 * - turn_moved: 本体の待ちで、その後に人の指示・ターンの終わり（UserPromptSubmit・Stop・StopFailure）が来た。サブエージェント
 *   の待ちは本体のターンが終わっても開いたままのことがある（背景のサブエージェント）ので、これでは取り下げない
 * - closed: カードの待ちとして見えた後に、カードに待ちが無くなった（記録が進んだ・許可のタスクが閉じた）
 * - unseen: 開いてから HOOK_WAIT_UNSEEN_MS たってもカードの待ちとして一度も見えない
 */
export function hookWaitWithdrawal(
  e: Pick<HookWaitEntry, "agentId" | "openedAt" | "lastPollAt" | "seen">,
  f: { now: number; open: boolean; later: readonly LaterHook[] },
): HookWaitWithdrawal | null {
  if (f.now - e.lastPollAt > HOOK_WAIT_STALE_MS) return "gone";
  for (const h of f.later) {
    if (h.at < e.openedAt) continue;
    if (h.name === "SessionEnd") return "session_end";
    if (
      e.agentId === null &&
      h.agentId === null &&
      (h.name === "UserPromptSubmit" || h.name === "Stop" || h.name === "StopFailure")
    )
      return "turn_moved";
  }
  if (e.seen && !f.open) return "closed";
  if (!e.seen && f.now - e.openedAt > HOOK_WAIT_UNSEEN_MS) return "unseen";
  return null;
}

/** AskUserQuestion の 1 問（記録の tool_use から読んだもの） */
export interface AskQuestionShape {
  multiSelect: boolean;
  options: number;
}

/**
 * 画面から来た AskUserQuestion の答え（問いごとに選んだ番号か自由な文）を確かめて整える。問いの数・番号の範囲・単一選択で
 * 1 つ・複数選択で 1 つ以上・重なりなし。自由な文は制御文字を除いて 1 行に畳む（空なら不可）。だめなら null
 */
export function parseAskChoices(
  questions: readonly AskQuestionShape[],
  input: unknown,
): HookAskChoice[] | null {
  if (!Array.isArray(input) || input.length !== questions.length || questions.length === 0)
    return null;
  const out: HookAskChoice[] = [];
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i] as AskQuestionShape;
    const c = input[i] as Record<string, unknown> | null;
    if (typeof c !== "object" || c === null || Array.isArray(c)) return null;
    const keys = Object.keys(c);
    if (keys.length !== 1) return null;
    if (keys[0] === "text") {
      if (typeof c.text !== "string" || c.text.length > 4000) return null;
      const p = prepareAnswer(c.text, false);
      if (!p) return null;
      out.push({ text: p.text });
      continue;
    }
    if (keys[0] !== "options" || !Array.isArray(c.options)) return null;
    const ns = c.options as unknown[];
    if (ns.length === 0 || (!q.multiSelect && ns.length !== 1)) return null;
    if (!ns.every((n) => Number.isInteger(n) && (n as number) >= 0 && (n as number) < q.options))
      return null;
    if (new Set(ns).size !== ns.length) return null;
    out.push({ options: [...(ns as number[])].sort((a, b) => a - b) });
  }
  return out;
}
