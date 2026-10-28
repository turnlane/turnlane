/**
 * 判定ロジック（packages/core/src/derive/）が受け取る「事実」の型。DB の行から runner が組み立てる。
 * 純粋関数はこれと now・設定だけを受け取り、時計や DB に触らない（phase0-plan 3.3）。
 */
export type WorkItemStatus = "running" | "needs_input" | "your_turn" | "done" | "error";
export type TurnStatus = "running" | "completed" | "interrupted" | "error";
export type EndedWith = "end_turn" | "question" | "permission" | "error" | "aborted";
export type Initiator = "human" | "queued" | "scheduled" | "system";

export interface TurnFact {
  id: string;
  sessionId: string;
  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;
  status: TurnStatus;
  endedWith: EndedWith | null;
  initiator: Initiator | null;
  gitBranch: string | null;
  cwd: string | null;
  editedFiles: number;
  pendingQuestion: boolean;
  closingQuestion: boolean;
  localDate: string;
}

export interface SessionFact {
  id: string;
  tool: string;
  externalId: string;
  parentId: string | null;
  isSubagent: boolean;
  isNoise: boolean;
  archived: boolean;
  liveStatus: "busy" | "idle" | "gone" | null;
  liveCheckedAt: number | null;
  lastActivityAt: number;
}

export interface HookFact {
  id: string;
  sessionExternalId: string;
  tool: string;
  name: string;
  notificationType: string | null;
  occurredAt: number;
  /** StopFailure のエラーの種類（hook の error。古い記録は error_type。種類だけ。rate_limit なら利用枠で止まった）。無ければ省略 */
  errorType?: string | null;
  /** hook を受けた設定ディレクトリ（Claude は CLAUDE_CONFIG_DIR。利用枠のアカウントと同じ書き方）。無ければ省略 */
  configRoot?: string | null;
  /**
   * 利用枠の自動再開を止めた通知（quota_auto_resume_disabled）が「明けるのが 24 時間より先」の定型文だった（週の上限など。
   * 文は持たず真偽値だけ）。明ける時刻が分からないときの見込みを 24 時間にする。違えば省略
   */
  horizon?: boolean | null;
  /**
   * サブエージェントの中で出た hook のサブエージェントの ID（Claude Code の agent_id。sessionExternalId は親のもの）。
   * 親の hook なら省略
   */
  agentId?: string | null;
  /**
   * 権限のモード（hook の permission_mode。default / plan / acceptEdits / auto / dontAsk / bypassPermissions）。hook に
   * 無ければ、normalizeFacts が同じセッションの前の hook のものを引き継ぐ。分からなければ省略
   */
  permissionMode?: string | null;
}

/**
 * サブエージェントのセッション（Claude Code の `subagents/agent-<id>.jsonl`）。ターンを持たず、親のセッションに内包する
 * （ai-session-ingestion 4.2）。親のターンが閉じた後もサブエージェントが動いている間は、親はまだ働いている
 */
export interface SubagentFact {
  id: string;
  /** 親の ai_session.id */
  parentId: string;
  /** サブエージェントの ID（`agent-<id>` の <id>。hook の agentId と同じ）。分からなければ null */
  agentId: string | null;
  startedAt: number;
  lastActivityAt: number;
  /** トランスクリプトが最後の応答（end_turn）で終わった時刻。終わっていなければ null */
  endedAt: number | null;
}

/**
 * Claude の利用枠の最新の値（claude_limit の行。アカウント = 設定ディレクトリ）。リセットの時刻と使用率だけ。
 * 利用枠で止まったセッションの「上限待ち」の終わり（until）に使う
 */
export interface ClaudeLimitFact {
  account: string;
  fiveHourPct: number | null;
  fiveHourResetsAt: number | null;
  sevenDayPct: number | null;
  sevenDayResetsAt: number | null;
}

export type PrState = "open" | "draft" | "merged" | "closed" | "unknown";

export interface PrFact {
  ref: string;
  number: number;
  state: PrState;
  headRef: string | null;
  title: string | null;
  firstSeenAt: number;
  stateChangedAt: number | null;
  myReviewAt: number | null;
  /** gh で状態を確かめた時刻（まだなら null。unknown のまま確かめていない PR にはレビュータスクを作らない） */
  stateCheckedAt?: number | null;
}

export type FollowUpKind =
  | "approve"
  | "reply"
  | "review_pr"
  | "resume_error"
  | "check_changes"
  | "merge_pr";
export type FollowUpStatus = "open" | "snoozed" | "done" | "dismissed" | "superseded" | "expired";

export interface FollowUpFact {
  id: string;
  kind: FollowUpKind;
  artifactRef: string;
  dedupeKey: string;
  triggerAt: number;
  triggerTurnId: string | null;
  status: FollowUpStatus;
  snoozeUntil: number | null;
  /** スヌーズした区間 [開始, 終了]（D-032） */
  snoozes: [number, number][];
  /** タスクを時間に置いていた区間 [ブロックを作った時刻, ブロックの開始]（D-051。無ければ省略） */
  scheduled?: [number, number][];
  engagedAt: number | null;
  closedAt: number | null;
  closeReason: string | null;
  /** 行を作った時刻（YOUR TURN に出た時刻。D-045 (1)。初回の取り込みで作ったタスクを過去に遡って数えないため） */
  createdAt?: number | null;
}

/** 1枚のカード（WorkItem）の判定に要る事実 */
export interface WorkItemFacts {
  workItemId: string;
  kind: "branch" | "session";
  /** git 管理外（repo_root が無い） */
  nonGit: boolean;
  /** 既定ブランチの session カード（git 管理下） */
  defaultBranchCard: boolean;
  /** このカードのターン（startedAt 順） */
  turns: TurnFact[];
  /** このカードのターンを持つセッション */
  sessions: SessionFact[];
  /** それらのセッションのすべてのターン（他のカードのものを含む。startedAt 順）。「別の作業へ移った」の判定に使う */
  sessionTurns: Map<string, TurnFact[]>;
  /** それらのセッションの hook（occurredAt 順） */
  hooks: HookFact[];
  prs: PrFact[];
  manualDoneAt: number | null;
  /** 既定ブランチの session カードの「今も未コミットの変更がある」（git status。分からなければ null） */
  dirty: boolean | null;
  /**
   * 編集がコミットで解決済みのターン（既定ブランチの session カードで dirty のとき、セッションの最後の編集ありのターンのうち、
   * その終わりより後に同じリポジトリ・ブランチでコミットがあるもの。runner が git で調べる。返答タスクの resolved:commit と
   * 同じ源）。無ければ省略
   */
  editsCommitted?: ReadonlySet<string>;
  /** このカードのフォローアップ（全状態） */
  followUps: FollowUpFact[];
  /**
   * タスクから頼んだ AI の項目（D-107。plan §B.2）: 依頼した時刻と、頼んだタスクを閉じた時刻（開いていれば null）。
   * 頼んだタスクがボードに出ているので、質問・許可・エラーなしで終わったターンからも待ちを数え（AI 完了 · 確認）、
   * タスクが出ている間を「タスクが出ていた区間」に入れる。無ければ省略
   */
  launch?: { at: number; closedAt: number | null } | null;
  /** Claude の利用枠（アカウントごと。上限待ちの終わりの時刻に使う）。無ければ省略（停止から 5 時間とみなす） */
  claudeLimits?: ClaudeLimitFact[];
  /** このカードのセッションを親に持つサブエージェント（ターンを持たないもの）。無ければ省略 */
  subagents?: SubagentFact[];
}

export interface DeriveTiming {
  /** ツール → runningStaleMs（Claude 5分、Codex 10分） */
  runningStaleMs: Record<string, number>;
  /**
   * その時刻に本人がいなかった（在席の区間の外。D-105）。AI が問いで止まった時刻にいなかったら、返答タスクを猶予
   * （reply_delay）を待たずにすぐ作る（D-214 (3)）。省略すると今までどおり猶予を待つ
   */
  awayAt?: (at: number) => boolean;
}

export const HUMAN_INITIATORS: readonly (Initiator | null)[] = ["human", "queued"];

export function isHumanTurn(t: Pick<TurnFact, "initiator">): boolean {
  return HUMAN_INITIATORS.includes(t.initiator);
}

/**
 * permission_mode の無い hook（Notification など、モードを持たないイベント）に、同じセッションの前の hook のモードを
 * 引き継ぐ（時刻順の hook を受け取る）
 */
function withPermissionModes(hooks: HookFact[]): HookFact[] {
  const last = new Map<string, string>();
  return hooks.map((h) => {
    if (h.permissionMode) {
      last.set(h.sessionExternalId, h.permissionMode);
      return h;
    }
    const m = last.get(h.sessionExternalId);
    return m ? { ...h, permissionMode: m } : h;
  });
}

/** 入力の並び順に依存しないよう、ターン・hook を時刻順にそろえる（取り込みの順序が違っても結果を同じにする） */
export function normalizeFacts(f: WorkItemFacts): WorkItemFacts {
  const byStart = (a: TurnFact, b: TurnFact) =>
    a.startedAt - b.startedAt || a.id.localeCompare(b.id);
  const sessionTurns = new Map<string, TurnFact[]>();
  for (const [k, v] of f.sessionTurns) sessionTurns.set(k, [...v].sort(byStart));
  return {
    ...f,
    turns: [...f.turns].sort(byStart),
    sessions: [...f.sessions].sort((a, b) => a.id.localeCompare(b.id)),
    sessionTurns,
    hooks: withPermissionModes(
      [...f.hooks].sort((a, b) => a.occurredAt - b.occurredAt || a.id.localeCompare(b.id)),
    ),
    prs: [...f.prs].sort((a, b) => a.firstSeenAt - b.firstSeenAt),
    ...(f.subagents
      ? {
          subagents: [...f.subagents].sort(
            (a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id),
          ),
        }
      : {}),
    followUps: [...f.followUps].sort(
      (a, b) => a.triggerAt - b.triggerAt || a.id.localeCompare(b.id),
    ),
  };
}
