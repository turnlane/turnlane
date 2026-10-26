/**
 * SSE のイベント → 無効化するキャッシュキー（m2-api.md 4.3）。純粋関数にしてテストする。
 * キーの形（4.2）: ["board", from, to] / ["day", date] / ["queue"] / ["inbox"] / ["workItem", id] /
 * ["dailyNote", date] / ["search", q] / ["sources"] / ["health"] / ["settings"] / ["glance", workItemId, …]
 */
import { addDays, isLocalDate, type SseEventType } from "@turnlane/core/web";

export type Key = readonly unknown[];

export const keys = {
  board: (from: string, to: string) => ["board", from, to] as const,
  /**
   * 3日ボード（D-074、m2-api 20章）。前後の稼働日は応答まで分からないので、無効化の判定（overlaps）用に
   * 祝日の連休を含めて入りうる幅（±10日）を from / to に置く
   */
  boardAround: (around: string) =>
    ["board", addDays(around, -10), addDays(around, 10), "around", around] as const,
  day: (date: string) => ["day", date] as const,
  queue: () => ["queue"] as const,
  /** AI の画面の生きている AI 項目（GET /api/ai/live。ux-mvp 4.19） */
  aiLive: () => ["aiLive"] as const,
  away: () => ["away"] as const,
  inbox: () => ["inbox"] as const,
  workItem: (id: string) => ["workItem", id] as const,
  /** タスクの詳細パネル（D-070） */
  task: (id: string) => ["task", id] as const,
  /** 確認支援（差分・テスト・CI。D-109）。workItemId か launchId */
  aiCheck: (ref: string) => ["aiCheck", ref] as const,
  /** 予定の詳細パネル（D-070） */
  calendarEvent: (id: string) => ["calendarEvent", id] as const,
  sources: () => ["sources"] as const,
  health: () => ["health"] as const,
  settings: () => ["settings"] as const,
  /** 集中モード（D-097。m2-api 25章） */
  focus: () => ["focus"] as const,
  /** オンボーディング（onboarding.md 5.4）: 状態・検出・進捗・O3 の列・要約 */
  onboarding: (part: "state" | "detect" | "progress" | "board" | "summary") =>
    ["onboarding", part] as const,
  search: (q: string, limit: number) => ["search", q, limit] as const,
  /** 記録（日報。D-192）。言語は呼ぶ側が末尾に足す */
  dailyNote: (date: string) => ["dailyNote", date] as const,
};

/**
 * キーが日付の集合と重なるか（board は from - 1 ≤ d ≤ to、day は d = date か date - 1、dailyNote は一致）。board と day は
 * 暦日の時間軸で、0:00〜日付区切りには前日の論理日のもの（イベントの dates は論理日）を描くので、1日前まで含める（D-054）。
 * day を一致だけにしていたため、深夜に動いた AI（論理日は前日）で今日のデイビューが更新されなかった
 */
export function overlaps(key: Key, dates: readonly string[]): boolean {
  const [k, a, b] = key;
  if (k === "board" && typeof a === "string" && typeof b === "string") {
    const lo = isLocalDate(a) ? addDays(a, -1) : a;
    return dates.some((d) => lo <= d && d <= b);
  }
  if (k === "day" && typeof a === "string")
    return dates.includes(a) || (isLocalDate(a) && dates.includes(addDays(a, -1)));
  if (k === "dailyNote" && typeof a === "string") return dates.includes(a);
  return false;
}

export interface EventData {
  dates?: string[];
  ids?: string[];
  workItemIds?: string[];
  inbox?: boolean;
  /** 拡張の id（`ext` イベント。ADR 0015） */
  exts?: string[];
  /** `calendar`: カレンダーの一覧（役割・Turnlane の中の色。D-125）が変わった */
  calendars?: boolean;
}

export function shouldInvalidate(
  key: Key,
  type: SseEventType,
  data: EventData,
  today: string,
): boolean {
  const k = key[0];
  const dates = data.dates ?? [];
  switch (type) {
    case "task":
      return (
        ((k === "board" || k === "day" || k === "dailyNote") && overlaps(key, dates)) ||
        (k === "inbox" && data.inbox === true) ||
        // 新しいプロジェクト（#blog）はタスクの作成で作られる
        k === "projects" ||
        // 自分の番のタスクの変化は帯（queue）にも出る
        (k === "queue" && dates.includes(today)) ||
        // タスクの詳細パネル（時間ブロックの変化は ids にタスクの ID が入る）
        (k === "task" && (data.ids ?? []).includes(key[1] as string)) ||
        // 頼んだ AI の状態・確認支援（D-107）
        k === "aiCheck" ||
        // AI の画面の片付け（頼んだタスクの完了）
        k === "aiLive"
      );
    case "work_item":
      return (
        // 記録（日報）は AI の動きも集計する
        ((k === "board" || k === "day" || k === "dailyNote") && overlaps(key, dates)) ||
        (k === "workItem" && (data.ids ?? []).includes(key[1] as string)) ||
        // 待っている件の中身（D-207）。AI 項目が変われば読み直す
        (k === "glance" && (data.ids ?? []).includes(key[1] as string)) ||
        k === "queue" ||
        // AI の画面（プロセス・状態・片付け）
        k === "aiLive" ||
        // 離れていた間のまとめ（D-214 (2)）
        k === "away" ||
        // 頼んだタスクの状態は AI 項目から決まる（D-107）。確認支援（テストの結果）も
        k === "task" ||
        k === "aiCheck" ||
        // O3 の列と要約（取り込みで AI の作業が増える）
        (k === "onboarding" && (key[1] === "board" || key[1] === "summary"))
      );
    case "follow_up":
      return (
        k === "queue" ||
        k === "aiLive" ||
        k === "away" ||
        (k === "glance" && (data.workItemIds ?? []).includes(key[1] as string)) ||
        ((k === "board" || k === "day" || k === "dailyNote") && overlaps(key, [today])) ||
        (k === "workItem" && (data.workItemIds ?? []).includes(key[1] as string))
      );
    case "calendar":
      return (
        ((k === "board" || k === "day" || k === "dailyNote") && overlaps(key, dates)) ||
        k === "calendarEvent" ||
        // 予定が変われば問い・「次の予定の終わり」も変わる（D-097）
        k === "focus" ||
        // カレンダーの一覧（設定 > カレンダー、予定のパネルの移す先、作成のポップオーバーの書き先の色。D-125）
        (data.calendars === true &&
          (k === "calendars" ||
            (k === "settings" && (key[1] === "calendars" || key[1] === "calendar-status"))))
      );
    case "plan_guide":
      return (k === "board" || k === "day" || k === "dailyNote") && overlaps(key, dates);
    case "source":
      return k === "sources" || k === "health" || (k === "onboarding" && key[1] === "detect");
    case "onboarding":
      return k === "onboarding" && key[1] === "state";
    case "import_progress":
      return (
        k === "onboarding" && (key[1] === "progress" || key[1] === "board" || key[1] === "summary")
      );
    case "settings":
      // 設定「行に中身を出す」が変われば中身も読み直す（D-207）
      return k === "settings" || k === "focus" || k === "glance" || k === "away";
    case "daily_note":
      return k === "dailyNote" && overlaps(key, dates);
    case "desktop_status":
      // デスクトップアプリの通知の許可・ホットキー（設定画面。D-080）
      return k === "desktop" || k === "focus";
    case "focus":
      // 集中モードの状態・問い（D-097）。キューの QueueResponse.focus（ブラウザ通知の抑止）も変わる
      return k === "focus" || k === "queue";
    case "ext":
      // 拡張（ADR 0015）: そのキャッシュ（["ext", id, ...]）だけ
      return k === "ext" && typeof key[1] === "string" && (data.exts ?? []).includes(key[1]);
    case "day_boundary":
      return true;
    default:
      return false;
  }
}

/**
 * 再接続の判定（m2-api.md 3.3）: bootId が変わった（デーモン再起動）、または接続し直した時点の rev が最後に受けた
 * イベントの rev と違う（切れている間に取りこぼした）なら全キャッシュを無効化する。rev はイベントを送るたびに +1
 */
export function needsFullRefresh(
  prev: { bootId: string; lastRev: number } | null,
  hello: { bootId: string; rev: number },
): boolean {
  if (!prev) return false;
  return prev.bootId !== hello.bootId || hello.rev !== prev.lastRev;
}
