/** 週ボード（GET /api/board?from&to。m2-api.md 2.3） */

import type { CalendarColorKey } from "../calendar/colors.ts";
import type {
  EpochMs,
  Interval,
  LocalDate,
  ReadMeta,
  SourceTool,
  TitleSpec,
  WorkItemStatus,
} from "./common.ts";
import type { TaskAiView } from "./launch.ts";

export interface CalendarEventView {
  id: string;
  title: string | null;
  start: EpochMs;
  end: EpochMs;
  allDay: boolean;
  /** 終日予定は日付で持つ（終わりを含まない） */
  startDate: LocalDate | null;
  endDate: LocalDate | null;
  /** カレンダーアプリの色（同期した値） */
  calendarColor: string | null;
  /** Turnlane の中で選んだ色（D-125。パレットのキー）。null ならカレンダーアプリの色 calendarColor を使う */
  calendarColorKey: CalendarColorKey | null;
  /** calendar.id（右クリックの「カレンダーの色」。D-125） */
  calendarId: string;
  busy: boolean;
  /** Turnlane から動かす・伸ばす・消せる（D-093。書き込めるカレンダー・参加者なし・繰り返しでない・終日でない） */
  editable: boolean;
}

/** 予定の詳細パネルで編集できない理由（D-093） */
export type EventReadOnlyReason = "attendees" | "calendar" | "recurring" | "all_day" | "helper";

/** GET /api/calendar-events/:id（予定の詳細パネル。D-070、m2-api 18章・24章） */
export interface CalendarEventDetail {
  id: string;
  title: string | null;
  start: EpochMs;
  end: EpochMs;
  allDay: boolean;
  startDate: LocalDate | null;
  endDate: LocalDate | null;
  tz: string | null;
  calendarName: string;
  calendarAccount: string | null;
  calendarColor: string | null;
  /** Turnlane の中で選んだ色（D-125）。null ならカレンダーアプリの色 */
  calendarColorKey: CalendarColorKey | null;
  location: string | null;
  conferenceUrl: string | null;
  /** 空き時間と放置の計算で「予定中」に数えるか（phase0-plan 3.3.1 の busy な予定） */
  busy: boolean;
  status: "confirmed" | "tentative" | "cancelled" | null;
  /** 会議リンク（Meet / Zoom / Teams 等）がある。集中モードの対象の判定（D-097）。null = まだ分からない */
  hasMeetingLink: boolean | null;
  /** Turnlane が書き戻した時間ブロックの予定なら、そのブロックとタスク（M3-3）。パネルはタスクを開く */
  ownTimeBlock: { blockId: string; taskId: string | null } | null;
  /** calendar.id（カレンダーの選択。D-093） */
  calendarId: string;
  /** 題名・時刻・カレンダーの編集と削除ができる（D-093） */
  editable: boolean;
  /** 編集できない理由（編集できれば null） */
  readOnlyReason: EventReadOnlyReason | null;
  /** Turnlane で作った予定（url = turnlane://event/） */
  createdByTurnlane: boolean;
}

export type TaskStatus = "todo" | "doing" | "done" | "canceled" | "someday";
/**
 * タスクの経由。desktop はデスクトップアプリのクイック入力（desktop-shell.md 5章）。DB の task.source の CHECK を
 * 変えないため、DB には source = manual・source_ref = desktop:quick_add で保存し、読み取り時に desktop にする
 */
export type TaskSource = "manual" | "cli" | "mcp" | "ai" | "calendar" | "desktop";

export interface TaskView {
  id: string;
  title: TitleSpec;
  status: TaskStatus;
  scheduledDate: LocalDate | null;
  laneOrder: string;
  estimateMin: number | null;
  projectId: string | null;
  rolloverCount: number;
  isHighlight: boolean;
  completedAt: EpochMs | null;
  autoCompleted: boolean;
  /** 経由の印。外部取り込みは externalSource、MCP は client 名 */
  origin: {
    source: TaskSource;
    client: string | null;
    externalSource: string | null;
    externalUrl: string | null;
  };
  /** 自分の番のタスクなら、そのフォローアップ（帯に出ている間は tasks に入れない） */
  followUpId: string | null;
  /** 自分の番のタスクの元になった AI 項目（閉じた後に時間軸へ置くときの `← AI` 表示用） */
  workItemId: string | null;
  createdAt: EpochMs;
  deletedAt: EpochMs | null;
  /** AI に頼んだタスクなら、最後の依頼とその状態（D-107。plan §B.2） */
  ai?: TaskAiView | null;
  /** メモがある（Inbox の行の右端のメモの印。本文は詳細パネルだけが読む） */
  hasNotes?: boolean;
}

/** 時間ブロック（Turnlane の中だけ。カレンダーには書かない。D-093） */
export interface TimeBlockView {
  id: string;
  taskId: string | null;
  title: string | null;
  start: EpochMs;
  end: EpochMs;
}

/** 実績（自分の時間）。完了タスクを時間軸に置く位置と、AI への応答区間 */
export interface TimeEntryView {
  id: string;
  taskId: string;
  start: EpochMs;
  /** null = 計測中（クライアントが now まで描く） */
  end: EpochMs | null;
  source: "tap" | "followup_estimate" | "timeblock_assumed";
  /** AI への応答なら、どの AI 項目のどの待ちに答えたか（コネクタ用） */
  respondsTo: { workItemId: string; waitKey: string | null } | null;
}

export interface SourceBadge {
  tool: SourceTool;
  /** 複数アカウントのときだけ UI が付ける（同じツールの有効なソースが2つ以上） */
  profile: string | null;
  /** このツールのセッションにプログラム経由（entrypoint が `sdk-*`）のものがある。UI は「SDK 経由」の札を出す */
  sdk?: true;
  /** 報告（ADR 0021）の出どころ。tool はその識別子（UI は汎用のバッジ） */
  report?: true;
  /** 報告の最後のプロジェクトの名前（リポジトリの欄の代わりに `出どころ · プロジェクト`） */
  project?: string;
}

export interface AiItemSummary {
  id: string;
  title: string | null;
  titleSource: string | null;
  status: WorkItemStatus;
  reason: string | null;
  estimated: boolean;
  sources: SourceBadge[];
  repoRoot: string | null;
  /** 壁打ち（プロジェクトに属さない会話。D-135）。UI はリポジトリの代わりに「壁打ち」と出す */
  scratch?: boolean;
  branch: string | null;
  prRef: string | null;
  aiMs: number;
  youMs: number;
  idleMs: number;
  turns: number;
  carriedFrom: LocalDate | null;
}

export interface AiRun extends Interval {
  turnId: string;
  /** true = 稼働中（end は応答時点の now。クライアントが現在時刻まで描き足す） */
  open: boolean;
}

/** 週ボードの待ちは2区分（D-028）。idle = 放置、それ以外（猶予・閉じた後・不在・会議中・タスクなし・スヌーズ）は idle: false */
export interface WaitSegmentBrief extends Interval {
  waitKey: string;
  idle: boolean;
  open: boolean;
  /**
   * 線の色。フォローアップの種類から決める（approve → needs_input、resume_error → error、ほか your_turn）。上限待ちと
   * 明けた後の再開は needs_input
   */
  tone: "needs_input" | "your_turn" | "error";
  followUpId: string | null;
}

export interface AiLaneItem extends AiItemSummary {
  runs: AiRun[];
  waits: WaitSegmentBrief[];
  /**
   * 上限待ち（利用枠で止まった。カードは done・理由 rate_limit）: 止まった時刻と明ける時刻。untilKnown が false なら
   * until は停止から 5 時間の見込み（利用枠のリセットの時刻が分からない）。上限待ちでなければ省く
   */
  limit?: { since: EpochMs; until: EpochMs; untilKnown: boolean };
}

export interface DayTotals {
  /** 今日・未来（定義は m2-api.md 9.1。過去日は 0） */
  freeMs: number;
  eventsMs: number;
  /** 見積なしのタスクは30分として足した値 */
  plannedMs: number;
  /** 見積なしで30分とみなしたタスクの件数。1以上なら UI は `Planned ~2h10m` と `~` を付ける */
  plannedUnestimated: number;
  /** 過去 */
  doneCount: number;
  taskCount: number;
  /** 共通 */
  aiMs: number;
  idleMs: number;
  expired: number;
}

export interface DayColumn {
  date: LocalDate;
  /** 表示の区分（暦日。D-054）。今日の列（帯・AI レーン・現在線）を決める */
  phase: "past" | "today" | "future";
  /** 集計の区分（同じ日付の論理日）。ヘッダの集計の種類と計画の窓に使う */
  logicalPhase: "past" | "today" | "future";
  /** 時間軸の範囲（暦日の 0:00〜翌 0:00。DST の日は23 / 25時間。D-054） */
  axis: Interval;
  /** 同じ日付の論理日の範囲。axis.start〜logical.start のブロックは前日に計上する */
  logical: Interval;
  /** 稼働日か（土日を除く平日。祝日の判定は M3-6 で足す。判定できなければ null） */
  workday: boolean | null;
  /** その日の計画の目安（D-062・D-106）。稼働日でなければ null。空き時間と AI レーンの初期位置に使う */
  plannedHours: Interval | null;
  allDayEvents: CalendarEventView[];
  events: CalendarEventView[];
  /** その日のタスク（自分の番として帯に出ているものを除く）。時間に置いたかは timeBlocks で判断 */
  tasks: TaskView[];
  /** 前日の日付のタスクのうち、時間ブロックか実績がこの列の時間軸にかかるもの（0:00 をまたぐブロック。D-054） */
  crossTasks: TaskView[];
  timeBlocks: TimeBlockView[];
  timeEntries: TimeEntryView[];
  totals: DayTotals;
  /** 過去日のリボン（稼働区間の和集合）。今日・未来は空 */
  aiRibbon: Interval[];
  /** 今日だけ。他の日は null */
  aiLane: AiLaneItem[] | null;
  /**
   * 「残り N 件を今日へ」（D-192）。今日より前の列だけ。count はその日に残っている自分のタスク（未完了・自分の番でない）、
   * older はそれより前の日付（14日）のまま残っている未完了（範囲の最初の過去の列にだけ数える。ほかは 0）
   */
  carry?: { count: number; older: number };
}

export interface BoardResponse extends ReadMeta {
  days: DayColumn[];
}
