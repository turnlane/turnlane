/**
 * ⌘K の「最近」（端末ごとにブラウザに保存。ux-mvp 6.1）。読めない・書けないときは空として扱う。
 * 古い版が保存した形（廃止した画面・絵柄など）の行は読み飛ばす（isRecentRow）
 */
import { isRecentRow, pushRecent, RECENT_MAX, type Row } from "./model.ts";

const KEY = "turnlane.palette.recent";

export function readRecent(): Row[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter(isRecentRow).slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

export function rememberRecent(row: Row): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(pushRecent(readRecent(), row)));
  } catch {}
}
