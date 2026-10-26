/**
 * mono のメタの整形（m2-api.md 6.2、design-system の Durations）。ロケールに関係なく ASCII で出す。
 * 時間は `12m` / `1h12m` / `1h` / `<1m`、待ちは 24時間以上で `1d2h`、時刻は `13:20`。
 */
import { wallClock } from "./dates.ts";

const MIN = 60_000;

/** 時間（ms）→ `<1m` / `12m` / `1h` / `1h12m`。負の値は 0 とみなす */
export function fmtDuration(ms: number): string {
  if (!(ms >= MIN)) return ms > 0 ? "<1m" : "0m";
  const total = Math.floor(ms / MIN);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h${m}m`;
}

/** 待ちの長さ。24時間以上は `1d2h`（日と時間）、それ未満は fmtDuration */
export function fmtWait(ms: number): string {
  const day = 24 * 60 * MIN;
  if (ms < day) return fmtDuration(ms);
  const d = Math.floor(ms / day);
  const h = Math.floor((ms % day) / (60 * MIN));
  return h === 0 ? `${d}d` : `${d}d${h}h`;
}

/** 時刻 `9:05` / `13:20`（先頭の 0 は付けない。design の `Started 8:42`） */
export function fmtClock(ms: number, tz: string): string {
  const w = wallClock(ms, tz);
  return `${w.hour}:${String(w.minute).padStart(2, "0")}`;
}

/** 時刻 `09:05`（2桁。時間軸の目盛りと範囲表示 `13:00-14:00`） */
export function fmtClock2(ms: number, tz: string): string {
  const w = wallClock(ms, tz);
  return `${String(w.hour).padStart(2, "0")}:${String(w.minute).padStart(2, "0")}`;
}

/** リポジトリ名（repo_root の最後の要素） */
export function repoName(repoRoot: string | null): string | null {
  if (!repoRoot) return null;
  const parts = repoRoot.split("/").filter(Boolean);
  return parts.at(-1) ?? null;
}

/** PR の参照（`owner/repo#142`）→ `#142` */
export function prLabel(prRef: string | null): string | null {
  if (!prRef) return null;
  const i = prRef.lastIndexOf("#");
  return i >= 0 ? prRef.slice(i) : prRef;
}
