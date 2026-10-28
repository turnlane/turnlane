/**
 * 後でにした自分の番（スヌーズ・明日へ・時間に置いた開始の前）の言葉。自分の番の画面の「後で」の行の右端（LaterRow）・
 * AI の詳細パネルの補足（ai-state）・AI のレーンの札（AiLane）が同じものを使う。純粋関数にしてテストする
 */
import {
  fmtClock,
  isLater,
  laterFollowUp,
  laterKind,
  type QueueItem,
  wallClock,
} from "@turnlane/core/web";
import type { MessageKey } from "../i18n/index.tsx";
import { clockOrDate } from "./back-time.ts";

export interface LaterText {
  key: MessageKey;
  params?: Record<string, string>;
}

/** 後でにした自分の番か（上限待ちの行は別。open なフォローアップがあれば後ででない） */
export function deferredTurn(item: QueueItem | null | undefined): item is QueueItem {
  return !!item && !item.limitWait && isLater(item) && laterFollowUp(item) !== undefined;
}

/**
 * 戻る時刻の文（`スヌーズ · 15:00 に戻る` / 今日でなければ `スヌーズ · 10/29 14:00 に戻る` / `明日へ · 10/29 10:00` /
 * `9:00 に`）。上限待ちの行は null（limitText）
 */
export function laterTextOf(
  item: QueueItem,
  today: string,
  now: number,
  tz: string,
): LaterText | null {
  const kind = laterKind(item, today);
  if (kind === "limit") return null;
  const f = laterFollowUp(item);
  if (kind === "scheduled" && f?.scheduledAt !== undefined)
    return { key: "queue.later.scheduled", params: { time: clockOrDate(f.scheduledAt, now, tz) } };
  const until = f?.snoozeUntil ?? null;
  if (kind === "tomorrow") {
    // 日付は相対でなく実際の日付（`10/24 10:00`）。時刻が分からなければタスクの日付
    const date =
      until !== null
        ? (() => {
            const w = wallClock(until, tz);
            return `${w.month}/${w.day} ${fmtClock(until, tz)}`;
          })()
        : (f?.taskDate ?? "")
            .slice(5)
            .split("-")
            .map((x) => String(Number(x)))
            .join("/");
    return { key: "queue.later.tomorrow", params: { date } };
  }
  return until !== null
    ? { key: "queue.later.snoozed", params: { time: clockOrDate(until, now, tz) } }
    : { key: "queue.later.snoozedNoTime" };
}

/** AI のレーンの札の短い言葉（時刻は出さない）: 明日へ / 後で（スヌーズ中・時間に置いた開始の前） */
export function laterShortKey(item: QueueItem, today: string): MessageKey {
  return laterKind(item, today) === "tomorrow" ? "menu.tomorrow" : "board.later";
}
