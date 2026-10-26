/**
 * 週ボードの基準日（ナビゲーション）。null の間は今日に追従する。週ボードの「今日」は暦日（D-054）なので、
 * 0:00 で付け替わる（論理日の今日は日付区切りまで前日のまま）
 */
import { addDays } from "@turnlane/core/web";
import { currentToday } from "../data/sse.ts";
import { getUi, setUi } from "./store.ts";

/** 表示の今日（暦日。サーバーから届く前は端末の日付） */
export function todayOrSystem(): string {
  const t = getUi().serverDisplayToday ?? getUi().serverToday ?? currentToday();
  if (t) return t;
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export const boardNav = {
  anchor(): string {
    return getUi().boardAnchor ?? todayOrSystem();
  },
  today(): void {
    setUi({ boardAnchor: null });
  },
  set(date: string): void {
    setUi({ boardAnchor: date === todayOrSystem() ? null : date });
  },
  shift(days: number): void {
    const next = addDays(boardNav.anchor(), days);
    setUi({ boardAnchor: next === todayOrSystem() ? null : next });
  },
  /**
   * 前後へ1つ（`[` / `]` と上部の ‹ ›。D-074）: 3日ボードは左・右の列の日へ（応答の列から。左は作業した休日のこともある。D-076。まだ無ければ1日）、
   * 週表示は1週
   */
  step(dir: -1 | 1): void {
    const u = getUi();
    if (u.boardMode === "week") {
      boardNav.shift(7 * dir);
      return;
    }
    const anchor = boardNav.anchor();
    const n = u.boardNeighbors;
    const to = n && n.around === anchor ? (dir < 0 ? n.prev : n.next) : addDays(anchor, dir);
    boardNav.set(to);
  },
};

/** デイビューの日付（M2-19）。null の間は表示の今日（暦日）に追従する */
export const dayNav = {
  date(): string {
    return getUi().dayAnchor ?? todayOrSystem();
  },
  today(): void {
    setUi({ dayAnchor: null });
  },
  set(date: string): void {
    setUi({ dayAnchor: date === todayOrSystem() ? null : date });
  },
  shift(days: number): void {
    dayNav.set(addDays(dayNav.date(), days));
  },
};
