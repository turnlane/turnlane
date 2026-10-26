/** AI 詳細パネル（GET /api/work-items/:id。m2-api.md 2.3） */
import type { OpenWaitBrief } from "./answer.ts";
import type { AiItemSummary, AiRun } from "./board.ts";
import type { EpochMs, FollowUpKind, ReadMeta } from "./common.ts";

export interface AiRunDetail extends AiRun {
  /** このターンを始めた自分の指示の 1 行目（保存しているときだけ。伏せ字の後。ADR 0018） */
  instruction?: string;
  toolCalls: number;
  editedFiles: number;
  inputTokens: number | null;
  outputTokens: number | null;
  endedWith: "end_turn" | "question" | "permission" | "error" | "aborted" | null;
  tool: string;
}

/** 保存した待ちの中身（wait_detail。ADR 0018）。AI の発言の本文は持たない */
export interface StoredWait {
  kind: "permission" | "question" | "ask" | "error";
  /** AI の問い（2 文まで）/ AskUserQuestion の問い */
  text?: string;
  /** AskUserQuestion の選択肢 */
  options?: string[];
  tool?: string;
  label?: string;
  command?: string;
  errorKind?: ErrorKind;
}

export interface WaitSegmentDetail {
  start: EpochMs;
  end: EpochMs;
  waitKey: string;
  kind: "grace" | "idle" | "excluded" | "expired";
  excludedBy: "closed" | "away" | "event" | "snoozed" | "no_task" | "scheduled" | null;
  open: boolean;
  endReason: string | null;
  followUpId: string | null;
}

/**
 * 許可を求めているツールの種類（D-116。PermissionRequest の hook の tool_name から。種類だけで、コマンドや入力の中身は持たない。
 * ADR 0005）: command = シェルのコマンド、file = ファイルの書き込み・編集、web = Web の取得・検索、mcp = MCP のツール、other = それ以外
 */
export type PermissionKind = "command" | "file" | "web" | "mcp" | "other";

/** エラーの種類（D-116。StopFailure の hook の error_type から。種類だけ） */
export type ErrorKind =
  | "rate_limit"
  | "overloaded"
  | "server_error"
  | "authentication"
  | "billing"
  | "other";

/** GitHub の PR のレビューの判定（pr-poller の reviewDecision。D-116） */
export type ReviewDecision = "approved" | "changes_requested" | "review_required";

export interface WorkItemDetail extends ReadMeta {
  workItem: AiItemSummary & {
    groupKey: string;
    manualDoneAt: EpochMs | null;
    hidden: boolean;
    firstActivityAt: EpochMs;
    lastActivityAt: EpochMs;
  };
  turns: AiRunDetail[];
  artifacts: {
    kind: string;
    ref: string;
    url: string | null;
    title: string | null;
    state: string | null;
    /** PR のレビューの判定（PR 以外・未取得は null。D-116） */
    reviewDecision: ReviewDecision | null;
    /** merged / closed になった時刻（D-116。「16:20 にマージ」） */
    stateChangedAt: EpochMs | null;
  }[];
  followUps: {
    id: string;
    kind: FollowUpKind;
    status: string;
    triggerAt: EpochMs;
    closedAt: EpochMs | null;
    closeReason: string | null;
    /** 何で止まったか（保存しているときだけ。伏せ字の後。ADR 0018） */
    wait?: StoredWait;
  }[];
  waits: WaitSegmentDetail[];
  breakdown: {
    aiMs: number;
    youMs: number;
    idleMs: number;
    graceMs: number;
    excludedMs: Record<"closed" | "away" | "event" | "snoozed" | "no_task" | "scheduled", number>;
    expiredMs: number;
    /** 依頼から完了（または現在）までの壁時計の時間 */
    wallMs: number;
  };
  open: { resume: boolean; pr: string | null; folder: boolean };
  /** ブロック中（PermissionRequest の hook による許可待ち）のとき、許可を求めているツールの種類（D-116） */
  permissionKind: PermissionKind | null;
  /** エラーで止まっているとき、StopFailure の hook のエラーの種類（D-116。hook が無いエラーは null） */
  errorKind: ErrorKind | null;
  /** 猶予の長さ（設定 wait.grace_min。「あと 3m で放置に数えます」） */
  graceMs: number;
  /**
   * 答える対象の待ち（D-240。queue の item の wait と同じ判定）。猶予の間の問いのように自分の番の行がまだ無い待ちにも付く。
   * 無ければ省く
   */
  openWait?: OpenWaitBrief;
}

/** hook の tool_name → 許可の種類（D-116。名前は種類に丸めて返し、MCP のサーバー名などは出さない） */
export function permissionKindOf(toolName: string | null): PermissionKind | null {
  if (!toolName) return null;
  if (toolName === "Bash" || toolName === "shell" || toolName === "exec_command") return "command";
  if (/^(Edit|MultiEdit|Write|NotebookEdit|apply_patch)$/.test(toolName)) return "file";
  if (toolName === "WebFetch" || toolName === "WebSearch") return "web";
  if (toolName.startsWith("mcp__")) return "mcp";
  return "other";
}

/** hook の error_type → エラーの種類（D-116） */
export function errorKindOf(errorType: string | null): ErrorKind | null {
  if (!errorType) return null;
  if (errorType === "rate_limit") return "rate_limit";
  if (errorType === "overloaded") return "overloaded";
  if (errorType === "server_error" || errorType === "api_error") return "server_error";
  if (/auth/.test(errorType)) return "authentication";
  if (/billing/.test(errorType)) return "billing";
  return "other";
}

/** pr-poller の reviewDecision（GitHub の値）→ API の値 */
export function reviewDecisionOf(v: string | null): ReviewDecision | null {
  if (v === "APPROVED") return "approved";
  if (v === "CHANGES_REQUESTED") return "changes_requested";
  if (v === "REVIEW_REQUIRED") return "review_required";
  return null;
}
