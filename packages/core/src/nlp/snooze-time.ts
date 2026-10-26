/**
 * スヌーズの「時刻を指定…」の入力を読む（ux-mvp 4.6 の `s`）。決定的で、例外を投げない。
 *
 * 受ける形（全角の数字・コロンは半角に直す。前後と間の空白は問わない）:
 * - `9:00` / `21:30`: 今日のその時刻。過ぎていれば明日のその時刻
 * - `明日 9:00` / `あした 9:00` / `tomorrow 9:00`: 明日（論理日の次の日。深夜 1 時の「明日 9:00」は同じ暦日の 9:00）
 * - `今日 9:00` / `today 9:00`: 暦の今日のその時刻（過ぎていれば過去）
 * - `10/28 14:00`: 今年のその日（過ぎていれば過去。来年には送らない）
 *
 * 時刻は 0:00〜23:59。読めない形・無い日付は invalid、今より前（今と同じを含む）は past
 */
import { addDays, toLocalDate, wallClock, wallToEpoch } from "../dates.ts";

export type SnoozeTimeResult =
  | { ok: true; until: number }
  | { ok: false; error: "invalid" | "past" };

export interface SnoozeTimeContext {
  now: number;
  tz: string;
  /** 日付区切り（0 時からの分。「明日」を論理日の次の日にする） */
  dayBoundary?: number;
}

const TIME = String.raw`(\d{1,2}):(\d{2})`;
const RE_TIME = new RegExp(`^${TIME}$`);
const RE_REL = new RegExp(`^(明日|あした|tomorrow|今日|きょう|today)\\s*${TIME}$`, "i");
const RE_DATE = new RegExp(String.raw`^(\d{1,2})/(\d{1,2})\s*${TIME}$`);

const minutesOf = (h: string, m: string): number | null => {
  const hh = Number(h);
  const mm = Number(m);
  return hh <= 23 && mm <= 59 ? hh * 60 + mm : null;
};

const ymd = (date: string) => date.split("-").map(Number) as [number, number, number];

export function parseSnoozeTime(raw: string, ctx: SnoozeTimeContext): SnoozeTimeResult {
  const bad = { ok: false, error: "invalid" } as const;
  try {
    const s = (typeof raw === "string" ? raw : "").normalize("NFKC").trim().replace(/\s+/g, " ");
    if (s === "") return bad;
    const w = wallClock(ctx.now, ctx.tz);
    const today: [number, number, number] = [w.year, w.month, w.day];
    const at = (d: [number, number, number], min: number) =>
      wallToEpoch(d[0], d[1], d[2], min, ctx.tz);
    const future = (until: number): SnoozeTimeResult =>
      until > ctx.now ? { ok: true, until } : { ok: false, error: "past" };

    const t = RE_TIME.exec(s);
    if (t) {
      const min = minutesOf(t[1] as string, t[2] as string);
      if (min === null) return bad;
      const until = at(today, min);
      if (until > ctx.now) return { ok: true, until };
      const next = ymd(addDays(`${pad4(w.year)}-${pad2(w.month)}-${pad2(w.day)}`, 1));
      return future(at(next, min));
    }
    const r = RE_REL.exec(s);
    if (r) {
      const min = minutesOf(r[2] as string, r[3] as string);
      if (min === null) return bad;
      const word = (r[1] as string).toLowerCase();
      if (word === "今日" || word === "きょう" || word === "today") return future(at(today, min));
      const logical = toLocalDate(ctx.now, ctx.tz, ctx.dayBoundary);
      return future(at(ymd(addDays(logical, 1)), min));
    }
    const d = RE_DATE.exec(s);
    if (d) {
      const month = Number(d[1]);
      const day = Number(d[2]);
      const min = minutesOf(d[3] as string, d[4] as string);
      if (min === null || !validDate(w.year, month, day)) return bad;
      return future(at([w.year, month, day], min));
    }
    return bad;
  } catch {
    return bad;
  }
}

const pad2 = (n: number) => String(n).padStart(2, "0");
const pad4 = (n: number) => String(n).padStart(4, "0");

function validDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const x = new Date(Date.UTC(y, m - 1, d));
  return x.getUTCMonth() === m - 1 && x.getUTCDate() === d;
}
