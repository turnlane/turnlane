/**
 * 記録（日報）・持ち越し・利用計測の API（phase0-plan 3.4、M4-2・M4-3・M5-1。儀式の画面は D-192 で廃止）。
 * サーバーは表示文字列を作らない（m2-api.md 6章）。記録は事実の構造（DailyReport）を返し、Markdown は
 * core/report/daily.ts の純粋関数が言語ごとに組み立てる（サーバーの Markdown は lang で指定した言語）。
 */
import { z } from "zod";
import type { EpochMs, LocalDate, ReadMeta, TitleSpec, WorkItemStatus } from "./common.ts";
import type { StoredWait } from "./work-items.ts";

const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export type ReportLocale = "en" | "ja";

/** What I did の1行（時間は実績、無ければ時間ブロック。どちらも無ければ null） */
export interface ReportDidLine {
  taskId: string;
  title: TitleSpec;
  ms: number | null;
  /** 自分の番から来たタスクなら元の AI 項目の題名（`← AI: …`） */
  fromAi: string | null;
}

/** What the AI did の結果 */
export type ReportAiResult =
  | { kind: "pr"; pr: number; state: "open" | "draft" | "merged" | "closed" | "unknown" }
  | {
      kind: "status";
      status: WorkItemStatus;
      /**
       * needs_input のときの待ちの種類（D-052 (3)）: 質問（AskUserQuestion）なら answer、許可待ちなら approval。
       * 省略・null は approval として書く
       */
      waitingFor?: "answer" | "approval" | null;
      /** 利用枠の上限待ち（status は done・理由 rate_limit）。「利用上限で停止」と書く。古い応答には無い */
      limit?: true;
    };

export interface ReportAiLine {
  workItemId: string;
  /** リポジトリ名（git 管理外は null → `(no repo)`） */
  repo: string | null;
  /** 壁打ち（D-135。repo は null → `[Scratch]`） */
  scratch?: boolean;
  /** AI 項目の題名（タイトルを保存しないモードでは null。ブランチ名で代用する） */
  title: string | null;
  branch: string | null;
  status: WorkItemStatus;
  /**
   * your_turn のときの自分の番の判定（D-214 (3)。自分の番の画面と同じ言葉にする）: open = 自分の番に出ている、
   * grace = 問いで止まって猶予中（まだ自分の番に出ていない）、none = 自分の番に出ない（変更の確認がオフなど。「完了」と書く）。
   * 古い行には無い（自分の番と書く）
   */
  turn?: "open" | "grace" | "none";
  /**
   * その日の最初の自分の指示の 1 行目（保存しているときだけ。伏せ字の後。ADR 0018・D-218）。あれば名前に使う
   */
  asked?: string;
  /** 今止まっている待ちの中身（保存しているときだけ。伏せ字の後。AI の発言の本文は含めない） */
  stopped?: StoredWait;
  result: ReportAiResult;
  aiMs: number;
  /** 未完了で次の日へ続く（needs_input / running / error） */
  carried: boolean;
}

export interface ReportCarryLine {
  taskId: string;
  title: TitleSpec;
  /** 持ち越し先（「残り N 件を今日へ」で移した日。D-192） */
  to: LocalDate;
  /** 持ち越しで飛ばした祝日（M3-6。日報に「Mon 10/12 is a holiday」と理由を出す）。無ければ省略 */
  skippedHolidays?: { date: LocalDate; name: string | null }[];
}

/** 記録の事実（M4-3）。テンプレートで Markdown にする（LLM 不要） */
export interface DailyReport {
  date: LocalDate;
  /** 自分の時間: タスクの実績（無い完了タスクは時間ブロック）の和集合（壁時計） */
  youMs: number;
  /** busy な時刻付き予定（終日を除く）の和集合（カレンダー未接続なら 0） */
  meetingsMs: number;
  aiMs: number;
  /** その日の AI の実行（ターン）数と、同時に動いていた最大数 */
  runs: number;
  maxParallel: number;
  idleMs: number;
  expired: number;
  idleByRepo: { repo: string | null; scratch?: boolean; ms: number }[];
  /** 期限切れになった項目の名前（S3） */
  expiredItems: TitleSpec[];
  did: ReportDidLine[];
  aiDid: ReportAiLine[];
  /** その日から実際に日付を変えたタスク（「残り N 件を今日へ」。D-192）。自動では動かさないので、押していなければ空 */
  carried: ReportCarryLine[];
  note: string | null;
}

/** 日報の AI 要約の失敗の理由（M4-6。stdout / stderr の中身は含めない） */
export type SummaryFailureView =
  | { kind: "not_found" }
  | { kind: "timed_out" }
  | { kind: "exit"; code: number | null; signal?: string | null }
  | { kind: "empty" }
  | { kind: "too_long" }
  | { kind: "spawn_failed" };

/** 日報の AI 要約の状態（M4-6）。job はデーモンのメモリにだけある（再起動で消える） */
export interface DailySummaryView {
  /** 設定 report.ai_summary.enabled */
  enabled: boolean;
  /** 設定で選んでいるツール */
  configuredTool: "claude_code" | "codex";
  /** 保存した要約（ユーザーが編集したものを含む）。無ければ null */
  md: string | null;
  tool: "claude_code" | "codex" | null;
  at: EpochMs | null;
  job:
    | { state: "running"; tool: "claude_code" | "codex"; startedAt: EpochMs }
    | { state: "failed"; tool: "claude_code" | "codex"; failure: SummaryFailureView; at: EpochMs }
    | null;
}

/** GET /api/reports/daily/:date?lang=（記録のパネル・turnlane report・MCP） */
export interface DailyReportResponse extends ReadMeta {
  date: LocalDate;
  report: DailyReport;
  /** 確定済みならその Markdown、未確定なら今の事実から組み立てたもの（Note を含む全文） */
  markdown: string;
  /** 日付区切りで確定した（report_md がある） */
  saved: boolean;
  /** 日報の AI 要約（M4-6） */
  summary: DailySummaryView;
  /** markdown の先頭に Summary を付けたもの（コピー・turnlane report・MCP。要約が無ければ markdown と同じ） */
  exportMarkdown: string;
}

/**
 * POST /api/follow-ups/:id/defer（`m` 明日。D-052 (1)）: タスクを次の稼働日へ移し、その日の計画の目安の開始まで
 * スヌーズする。タスクの無いフォローアップはスヌーズだけ（taskDate は null）
 */
export interface DeferFollowUpResponse {
  rev: number;
  followUpId: string;
  taskDate: LocalDate | null;
  snoozeUntil: EpochMs | null;
}

/**
 * POST /api/days/:date/carry（「残り N 件を今日へ」。D-192）: その日に残っている自分のタスク（未完了・自分の番でない）を
 * 今日の未定へ移す（時間ブロックは外し、rollover_count を +1）。older なら、その日より前（14日）の日付のまま残っている
 * 未完了も一緒に移す。未来の日は 400
 */
export const carryDayInput = z.object({ older: z.boolean().optional() });
export type CarryDayInput = z.infer<typeof carryDayInput>;

/** 移した1件（元に戻すために元の日付と時間ブロックを持つ） */
export interface CarriedTask {
  taskId: string;
  from: LocalDate;
  /** 外した時間ブロック（id は元のもの。元に戻すで復元する） */
  blocks: { id: string; start: EpochMs; end: EpochMs }[];
}

export interface CarryDayResponse {
  rev: number;
  /** 移した先（今日の論理日） */
  to: LocalDate;
  moved: CarriedTask[];
}

/** POST /api/days/carry/undo（元に戻す。CarryDayResponse.moved をそのまま渡す） */
export const undoCarryInput = z.object({
  moved: z
    .array(
      z.object({
        taskId: z.string(),
        from: localDate,
        blocks: z.array(
          z.object({ id: z.string(), start: z.number().int(), end: z.number().int() }),
        ),
      }),
    )
    .max(500),
});
export type UndoCarryInput = z.infer<typeof undoCarryInput>;

export interface UndoCarryResponse {
  rev: number;
  restored: string[];
}

export const putDailyNoteInput = z.object({ note: z.string().max(2000).nullable() });

/** POST /api/daily-notes/:date/summary（要約を作る・作り直す。M4-6） */
export const startSummaryInput = z.object({ lang: z.enum(["en", "ja"]).optional() });
/** PUT /api/daily-notes/:date/summary（手で直した要約。null か空で消す） */
export const putSummaryInput = z.object({ summary: z.string().max(4000).nullable() });

/** GET /api/summary/tools（要約に使う CLI の検出結果。M4-6） */
export interface SummaryToolView {
  tool: "claude_code" | "codex";
  /** 見つけた絶対パス（無ければ null） */
  bin: string | null;
  /** どこで見つけたか */
  foundBy: "setting" | "shell" | "known" | null;
  /** --help で確かめた、付ける起動フラグ */
  flags: string[];
  /** 無かった起動フラグ（付けない。作業ディレクトリの除外で補う） */
  missingFlags: string[];
}
export interface SummaryToolsResponse {
  tools: SummaryToolView[];
  /** 検出した Claude の設定ディレクトリ（2つ以上あれば設定画面で選べる） */
  claudeConfigDirs: string[];
  /** 要約の作業ディレクトリ（取り込みから除外する） */
  workDir: string;
}

/** POST /api/usage（UI の利用イベント。本人の操作には数えない） */
export const usageInput = z.object({ kind: z.enum(["ui_open"]) });

/** 利用計測（M5-1。turnlane stats） */
export interface UsageDay {
  date: LocalDate;
  /** UI を開いた */
  opened: boolean;
  /** 14日カウントに数える日（UI を開いた日。D-192 で儀式の条件を外した） */
  counted: boolean;
  /** その日に処理した自分の番 */
  processed: number;
}

export interface UsageStats {
  today: LocalDate;
  days: UsageDay[];
  countedDays: number;
  /** 今日（今日がまだ数えられていなければ昨日）で終わる連続日数 */
  streak: number;
  followUps: {
    processed: number;
    perWeek: number;
    replied: number;
    resolved: number;
    notNeeded: number;
    expired: number;
  };
  avgResponseMs: number | null;
}
