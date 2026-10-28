/**
 * AI の詳細パネルの見出し（D-115・D-116。案 design/mock-ai-detail-v1 の A〜F）: 状態とすること → 長さ → 補足、主ボタンの言葉。
 * 見出しは状態と待ちの種類（「自分の番 · 返答待ち · 1h24m」「ブロック中 · 許可待ち · 12m」「AI 完了 · PR の確認待ち · 4h07m」）。
 * PR を確認する前（status.ts の pr_open）は内部では自分の番だが「AI 完了 · PR の確認待ち」と出す（D-116）。純粋関数にしてテストする
 */
import type { WorkItemDetail, WorkItemStatus } from "@turnlane/core/web";
import type { MessageKey } from "../i18n/index.tsx";
import { itemFlow } from "./flow.ts";

export interface AiText {
  key: MessageKey;
  params?: Record<string, string>;
  /** 言葉に訳してから埋める引数（許可・エラーの種類） */
  keyParams?: Record<string, MessageKey>;
}

export interface AiHead {
  /** 状態アイコン */
  status: WorkItemStatus;
  head: MessageKey;
  sub: MessageKey | null;
  /** 見出しの長さ（実行中は今の稼働、待ちは今の待ち、PR の確認待ちは終わってから。完了は無し） */
  durMs: number | null;
  /** すること（文） */
  todo: AiText;
  /** 補足（「最後の動き 10 秒前」「あと 3m で放置に数えます」「10:51 に終了」「スヌーズ · 15:00 に戻る」） */
  hint: AiText | null;
  /** ブロック中だけ状態の面を琥珀にする（R4） */
  blocked: boolean;
  /** 主ボタンの言葉と、PR を開くか（無ければ既定の開き方） */
  primary: MessageKey;
  primaryPr: boolean;
}

type Detail = Pick<
  WorkItemDetail,
  | "workItem"
  | "turns"
  | "waits"
  | "artifacts"
  | "followUps"
  | "permissionKind"
  | "errorKind"
  | "graceMs"
>;

/** 開いている待ちの始まり（その待ちの最初の区間） */
function openWaitStart(d: Detail): number | null {
  const open = d.waits.find((w) => w.open);
  if (!open) return null;
  return Math.min(...d.waits.filter((w) => w.waitKey === open.waitKey).map((w) => w.start));
}

/** 猶予の残り（開いている待ちが今も猶予のとき）。「あと 3m で放置に数えます」 */
function graceLeft(d: Detail, now: number): number | null {
  const open = d.waits.find((w) => w.open);
  if (!open) return null;
  const segs = d.waits.filter((w) => w.waitKey === open.waitKey);
  const last = segs.at(-1);
  if (last?.kind !== "grace") return null;
  const start = Math.min(...segs.filter((w) => w.kind === "grace").map((w) => w.start));
  const left = start + d.graceMs - now;
  return left > 0 ? left : null;
}

/** 経過の言葉（「10 秒」「3m」）。秒は1分未満だけ */
export type Fmt = { clock: (ms: number) => string; dur: (ms: number) => string };

/**
 * waitingSince: 自分の番に出ている項目は、行と同じ待ちの始まり（QueueItem.waitingSince）を使う（同じ瞬間に行と詳細で
 * 待ちの分がずれないように。D-214 の §4）。無ければ開いている待ちの区間の始まり
 */
export function aiHeadOf(
  d: Detail,
  now: number,
  fmt: Fmt,
  waitingSince?: number,
  later?: AiText | null,
): AiHead {
  const h = baseHead(d, now, fmt, waitingSince);
  // 後でにした自分の番（スヌーズ・明日へ・時間に置いた開始の前）: 補足は「後で」の行と同じ戻る時刻の文。スヌーズ中は放置に
  // 数えないので猶予の文より優先する。見出しと待ちの長さは事実なのでそのまま
  return later && h.status !== "running" ? { ...h, hint: later } : h;
}

function baseHead(d: Detail, now: number, fmt: Fmt, waitingSince?: number): AiHead {
  const w = d.workItem;
  const pr = d.artifacts.filter((a) => a.kind === "pr").at(-1) ?? null;
  const waitFrom = waitingSince ?? openWaitStart(d);
  const lastEnd = d.turns.reduce((m, t) => Math.max(m, t.open ? now : t.end), 0);
  const grace = graceLeft(d, now);
  const graceHint: AiText | null =
    grace !== null ? { key: "ai.hint.grace", params: { time: fmt.dur(grace) } } : null;
  const waitDur = waitFrom !== null ? now - waitFrom : null;
  switch (w.status) {
    case "running": {
      const run = itemFlow(d, now).rows.findLast((r) => r.kind === "run");
      const ago = Math.max(0, now - w.lastActivityAt);
      return {
        status: "running",
        head: "status.running",
        sub: null,
        durMs: run ? now - run.start : null,
        todo: { key: "ai.todo.running" },
        hint:
          ago < 60_000
            ? { key: "ai.hint.lastSec", params: { n: String(Math.max(1, Math.round(ago / 1000))) } }
            : { key: "ai.hint.last", params: { time: fmt.dur(ago) } },
        blocked: false,
        primary: "ai.primary.session",
        primaryPr: false,
      };
    }
    case "needs_input": {
      const answer = w.reason === "ask_user_question";
      return {
        status: "needs_input",
        head: "status.needs_input",
        sub: answer ? "board.needsAnswer" : "board.needsPermission",
        durMs: waitDur,
        todo: answer
          ? { key: "ai.todo.answer" }
          : d.permissionKind
            ? {
                key: "ai.todo.permissionKind",
                keyParams: { kind: `ai.perm.${d.permissionKind}` as MessageKey },
              }
            : { key: "ai.todo.permission" },
        hint: graceHint,
        blocked: true,
        primary: answer ? "ai.primary.answer" : "ai.primary.permit",
        primaryPr: false,
      };
    }
    case "error":
      return {
        status: "error",
        head: "status.error",
        sub: "ai.sub.stopped",
        durMs: waitDur,
        todo: d.errorKind
          ? { key: "ai.todo.errorKind", keyParams: { kind: `ai.err.${d.errorKind}` as MessageKey } }
          : { key: "ai.todo.error" },
        hint: graceHint,
        blocked: false,
        primary: "ai.primary.resume",
        primaryPr: false,
      };
    case "your_turn": {
      // 再開のタスクが出ている（エラーの状態が閉じた後・上限待ちが明けた後）
      if (w.reason === "resume_error" || w.reason === "resume_limit") {
        const limit = w.reason === "resume_limit";
        return {
          status: "your_turn",
          head: "status.your_turn",
          sub: limit ? "turn.why.resume_limit" : "ai.sub.stopped",
          durMs: waitDur,
          todo: limit
            ? { key: "ai.todo.limitReset" }
            : d.errorKind
              ? {
                  key: "ai.todo.errorKind",
                  keyParams: { kind: `ai.err.${d.errorKind}` as MessageKey },
                }
              : { key: "ai.todo.error" },
          hint: graceHint,
          blocked: false,
          primary: "ai.primary.resume",
          primaryPr: false,
        };
      }
      // Stop の hook で終わり、トランスクリプトがまだ追いついていない（中身は分からない）。追いついたら問い・PR などに替わる
      if (w.reason === "hook:stop")
        return {
          status: "your_turn",
          head: "ai.head.aiDone",
          sub: "ai.sub.check",
          durMs: waitDur ?? (lastEnd > 0 ? now - lastEnd : null),
          todo: { key: "ai.todo.ended" },
          hint:
            graceHint ??
            (lastEnd > 0 ? { key: "ai.hint.ended", params: { time: fmt.clock(lastEnd) } } : null),
          blocked: false,
          primary: "ai.primary.check",
          primaryPr: false,
        };
      if (w.reason === "pr_open" || w.reason === "edits") {
        const isPr = w.reason === "pr_open" && pr !== null;
        return {
          status: "your_turn",
          head: "ai.head.aiDone",
          sub: isPr ? "ai.sub.prReview" : "ai.sub.changes",
          durMs: lastEnd > 0 ? now - lastEnd : null,
          todo: { key: isPr ? "ai.todo.prOpen" : "ai.todo.edits" },
          hint: lastEnd > 0 ? { key: "ai.hint.ended", params: { time: fmt.clock(lastEnd) } } : null,
          blocked: false,
          primary: isPr ? "ai.primary.pr" : "ai.primary.check",
          primaryPr: isPr,
        };
      }
      return {
        status: "your_turn",
        head: "status.your_turn",
        sub: "queue.kind.reply",
        durMs: waitDur,
        todo: { key: "ai.todo.reply" },
        hint: graceHint,
        blocked: false,
        primary: "ai.primary.reply",
        primaryPr: false,
      };
    }
    default: {
      // 上限待ち（利用枠で止まった。D-116 の rate_limit）: 琥珀。明けたら再開のタスクが出る
      if (w.reason === "rate_limit")
        return {
          status: "needs_input",
          head: "board.limit",
          sub: null,
          durMs: waitDur,
          todo: { key: "ai.todo.limit" },
          hint: null,
          blocked: true,
          primary: "ai.primary.session",
          primaryPr: false,
        };
      const merged = pr?.state === "merged";
      const closed = pr?.state === "closed";
      const at = merged || closed ? (pr?.stateChangedAt ?? null) : w.lastActivityAt;
      return {
        status: "done",
        head: "status.done",
        sub: merged ? "ai.sub.merged" : closed ? "ai.sub.prClosed" : null,
        durMs: null,
        todo: { key: "ai.todo.none" },
        hint:
          at !== null
            ? { key: merged ? "ai.hint.merged" : "ai.hint.ended", params: { time: fmt.clock(at) } }
            : null,
        blocked: false,
        primary: pr ? "ai.primary.pr" : "ai.primary.open",
        primaryPr: pr !== null,
      };
    }
  }
}

/** PR の状態の言葉（レビューの判定を含める。英語の状態名を出さない） */
export function prStateKey(
  a: Pick<WorkItemDetail["artifacts"][number], "state" | "reviewDecision">,
): MessageKey | null {
  if (a.state === "merged") return "ai.pr.merged";
  if (a.state === "closed") return "ai.pr.closed";
  if (a.state === "draft") return "ai.pr.draft";
  if (a.state === "open") {
    if (a.reviewDecision === "approved") return "ai.pr.approved";
    if (a.reviewDecision === "changes_requested") return "ai.pr.changes";
    return "ai.pr.review";
  }
  return null;
}
