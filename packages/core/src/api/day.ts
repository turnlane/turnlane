/**
 * デイビュー（GET /api/day/:date。m2-api.md 2.3、M2-19）。週ボードの1日分（DayColumn）を詳しくしたもの。
 * AI はターンごと（D-061）、待ちは3区分（猶予・放置・集計外と理由）で返す。DayColumn と互換（同じ部品で描ける）。
 */
import type { AiLaneItem, DayColumn, DayTotals, WaitSegmentBrief } from "./board.ts";
import type { Interval, LocalDate, ReadMeta } from "./common.ts";
import type { ClosedTodayRow } from "./queue.ts";
import type { AiRunDetail, WaitSegmentDetail } from "./work-items.ts";

/** デイビューの待ち区間: 週ボードの2区分に、3区分の種類・集計外の理由・終わり方を足したもの */
export interface DayWaitSegment
  extends WaitSegmentBrief,
    Pick<WaitSegmentDetail, "kind" | "excludedBy" | "endReason"> {}

export interface AiLaneItemDetail extends AiLaneItem {
  /** ターンごと（週ボードのようにまとめない。D-061）。ポップオーバー用のツール呼び出し数・編集ファイル数・トークン */
  runs: AiRunDetail[];
  waits: DayWaitSegment[];
}

export interface DayDetailTotals extends DayTotals {
  /** 自分 = 全タスクの実績の和集合（壁時計。論理日） */
  youMs: number;
  /** busy な時刻付き予定（終日を除く）の和集合 */
  meetingsMs: number;
}

/**
 * 上部の集計・左パネル（Closed today・放置の内訳）がどの論理日の値か（D-054）。ふだんは同じ日付の論理日。
 * 暦日の今日を 0:00〜日付区切りに開いたとき（phase = today、logicalPhase = future）だけ、今の論理日（前日）になる
 */
export interface DaySummaryScope {
  date: LocalDate;
  /** その論理日の区分（集計の 0 表示に使う） */
  phase: DayColumn["logicalPhase"];
}

export interface DayDetail extends DayColumn {
  /** その日の AI 項目（今日は前日からの持ち越しを含む）。他の日も返す。暦日の時間軸（axis）にかかるもの */
  aiLane: AiLaneItemDetail[];
  /** summary.date の論理日の集計（AI · 自分 · 会議 · 放置 · Expired） */
  totals: DayDetailTotals;
  /** 上部の集計・Closed today・放置の内訳の論理日 */
  summary: DaySummaryScope;
  /** summary.date の論理日に閉じた自分の番（replied / resolved / not_needed / expired） */
  closedToday: ClosedTodayRow[];
  /** 時間軸へ置ける空き枠: 計画の窓 − busy な予定 − 時間ブロック。15分単位、今日は今より後だけ */
  freeSlots: Interval[];
  /** summary.date の論理日のリポジトリ別の放置（和集合。git 管理外は null、壁打ちは scratch。D-135） */
  idleByRepo: { repoRoot: string | null; scratch?: boolean; ms: number }[];
}

export interface DayResponse extends ReadMeta {
  day: DayDetail;
}
