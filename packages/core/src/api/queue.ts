/** 要対応キュー（GET /api/queue。m2-api.md 2.3）。M1 の形にフィールドを足したもの */

import type { UpdateMenuItem } from "../desktop/menu-text.ts";
import type { OpenWaitBrief } from "./answer.ts";
import type { ChangeSize } from "./away.ts";
import type { SourceBadge } from "./board.ts";
import type {
  EpochMs,
  FollowUpKind,
  LocalDate,
  ReadMeta,
  TitleSpec,
  WorkItemStatus,
} from "./common.ts";
import type { FocusSummaryExtras } from "./focus.ts";

export interface QueueFollowUp {
  id: string;
  kind: FollowUpKind;
  /**
   * scheduled = 時間に置いた自分の番の開始の前（タスクの時間ブロックを作ってから開始まで。DB の状態は open のまま、
   * 読み取りの時刻で決める）。帯・件数・通知には入れず「後で」に出す。開始の時刻は scheduledAt
   * asked_back = 問い返し中（Issue #3）: 返答タスクの問いに問いで返し、AI がそれに答えている間（DB は open のまま、読み取りの
   * 時刻で決める）。帯・件数・通知・後でに出さない。AI の答えが問いでなければ open に戻る
   */
  status: "open" | "snoozed" | "scheduled" | "asked_back";
  /** status が scheduled のとき、帯に戻る時刻（時間ブロックの開始） */
  scheduledAt?: EpochMs;
  /** タスクの題名（読み取り時に解決。6.1） */
  title: TitleSpec;
  triggerAt: EpochMs;
  snoozeUntil: EpochMs | null;
  engagedAt: EpochMs | null;
  expiresAt: EpochMs | null;
  taskId: string | null;
  /** タスクの日付（シャットダウンの `m` で次の稼働日へ移したものは今日より後になる） */
  taskDate: LocalDate | null;
  /** AskUserQuestion への返答（回答待ち。artifact_ref が `:ask`。D-049 (1)） */
  ask?: boolean;
  /** 利用枠の上限待ちが明けた後の再開（「再開できる」。kind は resume_error、artifact_ref が `:limit`）。期限なし（再開するか対応不要まで残る。expiresAt は null） */
  limit?: boolean;
  /** M1 の形（CLI 用。保存値のまま）。UI は title を使う */
  task: { title: string; titleKey: string | null; titleParams: string | null } | null;
}

export interface QueueItem {
  workItemId: string;
  title: string | null;
  /** title が利用者の付けた名前（件名の最優先。D-207 (3)）。false なら title は自動の題名（ai-title・PR・ブランチ） */
  userTitled?: boolean;
  /**
   * title が PR の題名（指示・ai-title が無いときの件名。fix-subject-pr）。このとき理由の行は PR の番号と量だけにして題名を
   * 繰り返さない
   */
  titleSource?: "pr";
  status: WorkItemStatus;
  reason: string | null;
  estimated: boolean;
  repoRoot: string | null;
  /** 壁打ち（D-135） */
  scratch?: boolean;
  branch: string | null;
  prRef: string | null;
  sources: SourceBadge[];
  waitingSince: EpochMs;
  /** 待ちの始まりが不在の間（在席区間の外。D-105）なら true。UI は長さでなく `since 22:51` と出す */
  waitStartedAway: boolean;
  followUps: QueueFollowUp[];
  /** 答える対象の待ち（D-240。問い・許可・エラー。PR の確認には付かない） */
  wait?: OpenWaitBrief;
  /**
   * 猶予中（D-245。端末の前にいる間の問いで、返答タスクがまだ無い。D-214 (3)）。until は返答タスクができる目安の時刻
   * （ターンの終わり + `reply.delay_minutes`）。このとき followUps は空で、行は薄く `猶予 · あと 12m`。通知・放置・件数には入れない
   */
  grace?: { until: EpochMs };
  /**
   * 終わった件（PR の確認待ち・マージ待ち）の変更の量と CI（D-214 (2) の 6）。ファイル数は最後のひと続きの作業で編集した数、
   * +N −M と CI は gh で読めた控えがあるときだけ
   */
  change?: ChangeSize;
  /**
   * リセット前の上限待ち（利用枠で止まり、まだ明けていない。カードは done・理由 rate_limit）。`limitWaits` の行だけに付く
   * （followUps は空）。until が来たら「再開できる」（items の普通の行）に変わる
   */
  limitWait?: {
    /** 止まった時刻 */
    since: EpochMs;
    /** 明ける時刻（リセットの時刻。取れなければ停止から 5 時間） */
    until: EpochMs;
    /** until を利用枠のリセットの時刻から取れた */
    untilKnown: boolean;
  };
}

export type ClosedKind = "replied" | "resolved" | "not_needed" | "expired";

/**
 * 閉じた行の右に出す「何で閉じたか」（D-214 の §4 の言葉の統一）: 許可 / 返答 / 回答（AskUserQuestion）/ レビュー / マージ /
 * 再開 / 完了（手で）。kind が replied のときだけ付く
 */
export type ClosedVia = "approve" | "reply" | "answer" | "review" | "merge" | "resume" | "manual";

export interface ClosedTodayRow {
  followUpId: string;
  workItemId: string;
  title: TitleSpec;
  kind: ClosedKind;
  /** kind が replied のときの閉じ方（無ければ null） */
  via?: ClosedVia | null;
  /** 自分で付けた名前のある項目（件名を直近の指示に差し替えない。D-214 (1)） */
  userTitled?: boolean;
  signal: "commit" | "new_session" | "pr_merged" | null;
  closedAt: EpochMs;
  /**
   * 人が応えて閉じたときの応答時間（待ちの始まりから返答まで。猶予と放置の区間の和。`derive.countedResponseMs`）。
   * 自動で閉じた・対応不要・期限切れ、または待ちの区間が分からなければ null。デイビューの「今日閉じたもの」の返事までの中央値
   */
  responseMs?: number | null;
  repoRoot: string | null;
  /** 壁打ち（D-135） */
  scratch?: boolean;
  branch: string | null;
}

export interface QueueResponse extends ReadMeta {
  /**
   * needs_input → error → your_turn、同じ状態内は待ちの長い順。YOUR TURN のタスク（reply / review_pr / approve /
   * resume_error。open / snoozed）が1件以上あるカードだけ（D-048 (4)）
   */
  items: QueueItem[];
  /**
   * 猶予中の問い（D-245）: 返答タスクのまだ無い問いの待ち（item.grace 付き、followUps は空）。items とは別に持つ（通知・件数・
   * MCP・拡張は items だけを見る）。画面は `turnRows` で items の後ろに足す。待ちの始まりの古い順
   */
  grace?: QueueItem[];
  /**
   * リセット前の上限待ち（item.limitWait 付き、followUps は空）。自分の番の画面の「後で」の節にだけ出す（帯・件数・通知・
   * 放置・MCP には入れない）。open なフォローアップのあるカードは items のほうに出すので入れない。明ける早い順
   */
  limitWaits?: QueueItem[];
  /** 今日の閉じた件数（帯の閉じた行） */
  closedToday: Record<ClosedKind, number>;
  /** 今日閉じた行（帯の閉じた行の表示用。返答済みは取り消し線、解決済みは `~ resolved`） */
  closedRows: ClosedTodayRow[];
  /** 直近7日の平均応答時間（キュー画面）。壁時計ではなく猶予と放置の区間の和で数える（D-057） */
  avgResponseMs: number | null;
  /**
   * 直近7日（今日を含む 7 つの論理日）に処理した自分の番の件数（返答・解決・対応不要。期限切れは含まない。閉じた日で数える）。
   * 自分の番の画面の見出し「処理 N 件（7日）」（D-192・D-193） */
  handled7d: number;
  /**
   * デスクトップアプリ（client=desktop の SSE 購読者）がつながっている。true の間、web はブラウザ通知を出さない
   * （通知はアプリがネイティブで出す。desktop-shell.md 3.4）
   */
  desktopNotifier: boolean;
  /**
   * 集中モード中（D-097。m2-api 25章）。web はこの時刻までブラウザ通知を出さない（allowNeedsInput なら needs_input だけ出す）。
   * 集中していなければ null
   */
  focus: { until: EpochMs; allowNeedsInput: boolean } | null;
}

/** GET /api/queue/summary（メニューバーの件数。desktop-shell.md 4.1） */
export interface QueueSummaryResponse extends Partial<FocusSummaryExtras> {
  count: number;
  needsInput: number;
  error: number;
  yourTurn: number;
  rev: number;
  /** メニューバーの更新の知らせ（M6-17）。新しい版が無い・dev なら null。古いデーモンには無い */
  update?: UpdateMenuItem | null;
}
