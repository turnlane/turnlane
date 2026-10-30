/**
 * 設定（setting テーブル。phase0-plan 3.3・3.3.1・3.4）の既定値と読み出し。
 * 値は JSON。未設定・壊れた値は既定値にする。
 */
import {
  type DayBoundary,
  DEFAULT_DAY_BOUNDARY,
  parseDayBoundary,
  systemTimeZone,
} from "./dates.ts";
import type { DB } from "./db/client.ts";
import { getSetting } from "./db/mutate.ts";
import { PRESENCE_TAIL_MIN } from "./derive/presence.ts";
import { defaultPlannedHours, type PlannedHours, readPlannedHours } from "./plan/planned-hours.ts";
import type { SummaryTool } from "./report/summary.ts";
import { readScratchDirs } from "./scratch.ts";

export type FollowUpKindSetting =
  | "approve"
  | "reply"
  | "review_pr"
  | "resume_error"
  | "check_changes";

/** 日報の AI 要約（M4-6。report.ai_summary）。既定はオフ */
export interface AiSummarySettings {
  enabled: boolean;
  tool: SummaryTool;
  /** CLI の絶対パス（null は検出する） */
  bin: string | null;
  /** CLAUDE_CONFIG_DIR に入れる設定ディレクトリ（null は検出した最初のもの） */
  claudeConfigDir: string | null;
  timeoutMs: number;
}

export const DEFAULT_AI_SUMMARY: AiSummarySettings = {
  enabled: false,
  tool: "claude_code",
  bin: null,
  claudeConfigDir: null,
  timeoutMs: 90_000,
};

/** report.ai_summary の値（壊れた値・未設定は既定値） */
export function readAiSummary(v: unknown): AiSummarySettings {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const abs = (x: unknown) => (typeof x === "string" && x.startsWith("/") ? x : null);
  const sec = o.timeout_sec;
  return {
    enabled: o.enabled === true,
    tool: o.tool === "codex" ? "codex" : "claude_code",
    bin: abs(o.bin),
    claudeConfigDir: abs(o.claude_config_dir),
    timeoutMs:
      typeof sec === "number" && Number.isInteger(sec) && sec >= 10 && sec <= 600
        ? sec * 1000
        : DEFAULT_AI_SUMMARY.timeoutMs,
  };
}

export interface TurnlaneSettings {
  tz: string;
  dayBoundary: DayBoundary;
  /** 待ちの猶予（D-019） */
  graceMs: number;
  /** 返答タスクを作るまでの待ち（S3。猶予と同じ15分） */
  replyDelayMs: number;
  /** 質問の your_turn と返答タスクの期限（D-020） */
  replyExpireMs: number;
  /** git 管理外のカードの「編集あり」の your_turn の期限（S3） */
  nonGitEditExpireMs: number;
  /** 「Mac を使っていた」とみなす長さ T（最後の入力からの ms。D-105・D-110 (2)。presence.tail_min、2〜15 分） */
  presenceTailMs: number;
  /**
   * 在席の記録を始めた時刻（idle.presence_since。D-110 (3)）。これより前の日の放置は作り直さない。未設定は null
   * （デーモンの起動時に入れる）
   */
  presenceSince: number | null;
  followUpKinds: Record<FollowUpKindSetting, boolean>;
  /** タイトルを保存しない（ブランチ名のみ）モード（ADR 0005） */
  storeTitles: boolean;
  /**
   * 待ちの中身を保存する（turn.store_detail。既定オン。ADR 0018、D-218）: 自分の指示の 1 行目と待ちの中身（問い・
   * 許可のコマンド・エラーの種類）を伏せ字の後に DB に持つ。オフなら持たず、表示の瞬間に記録から読む
   */
  storeDetail: boolean;
  /** 待ち区間を自動で作り直す範囲（カレンダーの窓。M3-2） */
  waitRecomputeDays: number;
  /** 稼働曜日（ISO: 月 = 1 … 日 = 7。M3-6、D-040） */
  workdays: number[];
  /** 祝日カレンダー（calendar.id）。null は自動判定、[] は祝日なし（M3-6） */
  holidayCalendars: string[] | null;
  /**
   * 表示しないカレンダー（calendar.id。Issue #5）。ボード・デイビューに描かないだけで、忙しい時間・空き枠・会議中の判定・
   * 集中モードは変えない。取り込みも続ける。この Mac の設定
   */
  hiddenCalendars: string[];
  /** 計画の目安（曜日ごと。D-062・D-106。キーは work_hours.planned のまま）。空き時間と「明日朝」に使う */
  plannedHours: PlannedHours;
  /** 日報の AI 要約（M4-6） */
  aiSummary: AiSummarySettings;
  /** 壁打ちの印を付けたフォルダ（ai.scratch_dirs。D-135）。Codex の ~/Documents/Codex は印が無くても壁打ち */
  scratchDirs: string[];
}

export const DEFAULT_SETTINGS: TurnlaneSettings = {
  tz: "UTC",
  dayBoundary: DEFAULT_DAY_BOUNDARY,
  graceMs: 15 * 60_000,
  replyDelayMs: 15 * 60_000,
  replyExpireMs: 72 * 3_600_000,
  nonGitEditExpireMs: 24 * 3_600_000,
  presenceTailMs: PRESENCE_TAIL_MIN.default * 60_000,
  presenceSince: null,
  followUpKinds: {
    approve: true,
    reply: true,
    review_pr: true,
    resume_error: true,
    check_changes: false,
  },
  storeTitles: true,
  storeDetail: true,
  waitRecomputeDays: 7,
  workdays: [1, 2, 3, 4, 5],
  holidayCalendars: null,
  hiddenCalendars: [],
  plannedHours: defaultPlannedHours(),
  aiSummary: DEFAULT_AI_SUMMARY,
  scratchDirs: [],
};

function hhmm(v: unknown, dflt: number): number {
  if (typeof v !== "string") return dflt;
  try {
    return parseDayBoundary(v);
  } catch {
    return dflt;
  }
}

function posNum(v: unknown, dflt: number): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : dflt;
}

/** 「使っていた」とみなす長さ（分。D-110 (2)）。turnlane config と同じ範囲 2〜15 の外は既定 5 */
function tailMin(v: unknown): number {
  return typeof v === "number" &&
    Number.isInteger(v) &&
    v >= PRESENCE_TAIL_MIN.min &&
    v <= PRESENCE_TAIL_MIN.max
    ? v
    : PRESENCE_TAIL_MIN.default;
}

function weekdays(v: unknown): number[] {
  if (!Array.isArray(v)) return [...DEFAULT_SETTINGS.workdays];
  const xs = [...new Set(v.filter((x): x is number => Number.isInteger(x) && x >= 1 && x <= 7))];
  return xs.length > 0 ? xs.sort() : [...DEFAULT_SETTINGS.workdays];
}

function stringsOrNull(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  return v.filter((x): x is string => typeof x === "string");
}

/** setting テーブルから読む。tz は実行環境のタイムゾーン（setting の 'tz' があればそれ） */
export function readSettings(db: DB, tz: string = systemTimeZone()): TurnlaneSettings {
  const get = <V>(k: string) => {
    try {
      return getSetting<V>(db, k);
    } catch {
      return undefined;
    }
  };
  const kinds = get<Partial<Record<FollowUpKindSetting, boolean>>>("followup.kinds") ?? {};
  const privacy = get<{ storeTitles?: boolean }>("privacy");
  const t = get<string>("tz");
  return {
    tz: typeof t === "string" && t ? t : tz,
    dayBoundary: hhmm(get("day_boundary"), DEFAULT_SETTINGS.dayBoundary),
    graceMs: posNum(get("wait.grace_min"), 15) * 60_000,
    replyDelayMs: posNum(get("reply.delay_min"), 15) * 60_000,
    replyExpireMs: posNum(get("reply.expire_hours"), 72) * 3_600_000,
    nonGitEditExpireMs: posNum(get("your_turn.non_git_edit_expire_hours"), 24) * 3_600_000,
    presenceTailMs: tailMin(get("presence.tail_min")) * 60_000,
    presenceSince: (() => {
      const v = get("idle.presence_since");
      return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
    })(),
    followUpKinds: { ...DEFAULT_SETTINGS.followUpKinds, ...kinds },
    storeTitles: privacy?.storeTitles !== false,
    storeDetail: get<unknown>("turn.store_detail") !== false,
    waitRecomputeDays: DEFAULT_SETTINGS.waitRecomputeDays,
    workdays: weekdays(get("workdays.weekdays")),
    holidayCalendars: stringsOrNull(get("workdays.holiday_calendars")),
    hiddenCalendars: stringsOrNull(get("calendar.hidden")) ?? [],
    plannedHours: readPlannedHours(get("work_hours.planned")),
    aiSummary: readAiSummary(get("report.ai_summary")),
    scratchDirs: readScratchDirs(get("ai.scratch_dirs")),
  };
}
