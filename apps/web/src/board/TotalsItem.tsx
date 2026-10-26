/**
 * 見出しの集計の 1 項目（3日ボード・週表示の列の見出し、デイビューの上部。R79）。点線の下線で、ホバーとキーのフォーカスで
 * 定義と内訳をツールチップ（濃い地の部品。Tooltip.tsx）に出す。押せる項目（期限切れ）はボタン
 */
import { useNavigate, useRouterState } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { hideTip, tipProps } from "../components/Tooltip.tsx";
import { dayNav } from "../lib/board-nav.ts";
import { flashEls } from "../lib/flash.ts";
import { setUi } from "../lib/store.ts";

/** デイビューの「今日閉じた」の期限切れの行 */
/** デイビューの「今日閉じたもの」を開く合図（畳んだ一覧の期限切れの行を強調する前に開く） */
export const CLOSED_OPEN_EVENT = "turnlane:closed-open";
export const EXPIRED_ROWS = '[data-testid="closed-today"] [data-closed="expired"]';

export function TotalsItem({
  name,
  tip,
  focusable = false,
  onClick,
  children,
  ...data
}: {
  /** 項目の文（`期限切れ 2`）。読み上げの名前に使う */
  name: string;
  /** ホバーの文（改行で区切る）。無ければツールチップを出さない */
  tip?: string | undefined;
  /** キーでフォーカスできる（内訳を持つ項目。押せる項目は常に） */
  focusable?: boolean;
  onClick?: (() => void) | undefined;
  children: ReactNode;
  "data-totals"?: string | undefined;
  "data-over"?: string | undefined;
  "data-testid"?: string | undefined;
}) {
  const hover = tip
    ? { ...tipProps(tip, undefined, "bottom"), "aria-label": `${name}\n${tip}` }
    : {};
  if (onClick)
    return (
      <button
        type="button"
        {...hover}
        {...data}
        onClick={() => {
          hideTip();
          onClick();
        }}
        className="border-fg3 border-b border-dotted hover:border-fg2 hover:text-fg"
      >
        {children}
      </button>
    );
  return (
    <span
      {...hover}
      {...data}
      {...(focusable && tip ? { tabIndex: 0, role: "group" } : {})}
      className="border-fg3 border-b border-dotted"
    >
      {children}
    </span>
  );
}

/**
 * 期限切れの件へ（R79）: その日のデイビューの「今日閉じた」の期限切れの行まで送って少しの間強調する。3日ボード・週表示の
 * 列の「今日閉じた」（帯の畳み）は返答済み・解決済みだけ（D-074）なので、期限切れの行のあるデイビューへ `?closed=expired` で移る。
 * 同じ日のデイビューにいればその場で強調する
 */
export function useOpenExpired(): (date: string) => void {
  const nav = useNavigate();
  const path = useRouterState({ select: (s) => s.location.pathname });
  return (date) => {
    hideTip();
    if (path === "/day" && dayNav.date() === date) {
      flashExpired();
      return;
    }
    dayNav.set(date);
    void nav({ to: "/day", search: { closed: "expired" } as never });
  };
}

/**
 * デイビューの期限切れの行を強調する。幅が 1200px 未満で詳細パネルが開いていると右の一覧が隠れる（DayView の hideList）ので、
 * そのときはパネルを閉じる
 */
export function flashExpired(): void {
  if (window.innerWidth < 1200)
    setUi({ panelWorkItemId: null, panelTaskId: null, panelEventId: null, recordOpen: false });
  // 畳んだ「今日閉じたもの」は開いてから強調する（行が描かれるまで flashEls が少し待つ）
  window.dispatchEvent(new Event(CLOSED_OPEN_EVENT));
  flashEls(EXPIRED_ROWS);
}
