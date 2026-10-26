/**
 * 新しい日からの取り込みの進捗（onboarding.md 5.3、M6-20）。
 * 日 D（論理日）が「完了」: 更新時刻が D の始まり以降のストリームがすべて処理済み（キューと処理中に残っていない）。
 * キューは新しい順に処理するので、今日 → 7日前の順に完了する。完了は戻さない（取り込み中に今のセッションが
 * 書き足されても、済んだ日を「取り込み中」に戻さない）。
 */

import { addDays, type DayBoundary, dayStartMs } from "@turnlane/core";
import type { ImportProgress } from "@turnlane/core/api";

export interface ProgressInput {
  today: string;
  tz: string;
  dayBoundary: DayBoundary;
  /** 日数（新しい日から）。既定 7 */
  days?: number;
  /** 取り込みを始めたか（同意の後） */
  begun: boolean;
  /** まだ読んでいないストリーム。null はまだ決められない（走査の途中・始める前） */
  pending: readonly { sourceId: string; mtimeMs: number }[] | null;
  /** 取り込み元（spool を除く、有効なもの） */
  sourceIds: readonly string[];
  skipped: ReadonlyMap<string, number>;
}

/** 完了の記録（単調に増える） */
export interface ProgressMemo {
  days: Set<string>;
  sources: Set<string>;
  doneAt: number | null;
}

export function emptyProgressMemo(): ProgressMemo {
  return { days: new Set(), sources: new Set(), doneAt: null };
}

export function computeProgress(i: ProgressInput, memo: ProgressMemo, now: number): ImportProgress {
  const n = i.days ?? 7;
  const days: ImportProgress["days"] = [];
  let importingShown = false;
  for (let k = 0; k < n; k++) {
    const date = addDays(i.today, -k);
    const start = dayStartMs(date, i.tz, i.dayBoundary);
    const done =
      memo.days.has(date) || (i.begun && i.pending?.every((p) => p.mtimeMs < start) === true);
    if (done) {
      memo.days.add(date);
      days.push({ date, state: "done" });
    } else if (i.begun && !importingShown) {
      importingShown = true;
      days.push({ date, state: "importing" });
    } else days.push({ date, state: "pending" });
  }
  const sources: ImportProgress["sources"] = i.sourceIds.map((id) => {
    const done =
      memo.sources.has(id) || (i.begun && i.pending?.some((p) => p.sourceId === id) === false);
    if (done) memo.sources.add(id);
    return {
      id,
      state: done ? "done" : i.begun ? "importing" : "pending",
      skipped: i.skipped.get(id) ?? 0,
    };
  });
  if (memo.doneAt === null && days.every((d) => d.state === "done")) memo.doneAt = now;
  return { days, sources, doneAt: memo.doneAt };
}

/** SSE を送るかの比較（状態だけ。件数の skipped も含める） */
export function progressKey(p: ImportProgress): string {
  return JSON.stringify([
    p.days.map((d) => d.state),
    p.sources.map((s) => [s.id, s.state, s.skipped]),
    p.doneAt !== null,
  ]);
}
