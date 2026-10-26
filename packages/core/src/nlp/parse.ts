/**
 * クイック入力の自然言語パーサ（決定的。LLM は使わない。日本語・英語）。
 *
 * 仕様は docs/spec/ux-mvp.md の 5 章。認識したトークンはチップとして確定し、タイトルから取り除く。
 * 誤爆しそうなもの（「3時間目の授業」のように前後が語に接しているもの、`at 3` のような裸の数字、
 * 英語の `sun` / `sat`）は確定させず `tentative` に候補として返す（UI が ⇥ で確定させる）。
 * 候補はタイトルに残す。
 *
 * 日付は `ctx.today`（論理日付 `YYYY-MM-DD`）からの暦計算だけで求め、タイムゾーンに依存しない。
 * どんな入力でも例外を投げない。
 */

export interface ParseContext {
  /** 論理日付 `YYYY-MM-DD` */
  today: string;
}

export type ChipKind = "date" | "time" | "estimate" | "project" | "priority" | "someday" | "inbox";

/** `raw` 上の [start, end) の範囲 */
export interface Chip {
  kind: ChipKind;
  start: number;
  end: number;
  text: string;
}

export interface ParsedTask {
  /** 確定チップを除き、空白を詰めた本文。全部がチップだった場合は raw をそのまま使う */
  title: string;
  /** `YYYY-MM-DD` */
  date: string | null;
  time: { hour: number; minute: number } | null;
  estimateMin: number | null;
  /** `#` を除いた名前 */
  project: string | null;
  priority: 1 | 2 | 3 | null;
  someday: boolean;
  /** 「inbox」「インボックス」の明示指定 */
  inbox: boolean;
  /** 確定したチップ（出現順） */
  chips: Chip[];
  /** 確定させなかった候補（出現順）。タイトルには残る */
  tentative: (Chip & { value: Partial<Pick<ParsedTask, "date" | "time" | "estimateMin">> })[];
}

// ---------------------------------------------------------------------------
// 暦の計算（YYYY-MM-DD の文字列だけで扱う）

const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function formatYmd(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function validYmd(y: number, m: number, d: number): boolean {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false;
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

function parseYmd(s: string): { y: number; m: number; d: number } | null {
  const m = YMD_RE.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  return validYmd(y, mo, d) ? { y, m: mo, d } : null;
}

function addDays(date: string, days: number): string {
  const p = parseYmd(date);
  if (!p) return date;
  const t = new Date(Date.UTC(p.y, p.m - 1, p.d + days));
  return formatYmd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/** 月曜 = 0 … 日曜 = 6 */
function weekdayMon0(date: string): number {
  const p = parseYmd(date);
  if (!p) return 0;
  return (new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay() + 6) % 7;
}

/** 明日以降で最初の該当曜日（今日と同じ曜日なら翌週） */
function nextWeekday(today: string, wd: number): string {
  const delta = (wd - weekdayMon0(today) + 7) % 7 || 7;
  return addDays(today, delta);
}

/** n 週後のカレンダー週（月曜始まり）の該当曜日 */
function weekdayInWeek(today: string, weeksAhead: number, wd: number): string {
  return addDays(today, -weekdayMon0(today) + 7 * weeksAhead + wd);
}

/** 年なしの月日。今年の日付が今日より7日を超えて過去なら来年とする */
function resolveMonthDay(today: string, month: number, day: number): string | null {
  const t = parseYmd(today);
  if (!t) return null;
  for (const y of [t.y, t.y + 1]) {
    if (!validYmd(y, month, day)) continue;
    const date = formatYmd(y, month, day);
    if (date >= addDays(today, -7)) return date;
  }
  return null;
}

// ---------------------------------------------------------------------------
// ルール

type Value = Partial<Pick<ParsedTask, "date" | "time" | "estimateMin" | "project" | "priority">>;

interface Rule {
  kind: ChipKind;
  re: RegExp;
  /** word: 前後が文字・数字でないこと。space: 直前が先頭か空白、直後が文字・数字でないこと */
  edge: "word" | "space";
  /** 前後が語に接している場合に候補として返すか（日本語のトークン向け） */
  tentativeIfUnbounded: boolean;
  /** 境界を満たしても候補にとどめるか */
  alwaysTentative?: (m: RegExpExecArray) => boolean;
  value: (m: RegExpExecArray, today: string) => Value | null;
}

const JA_WEEKDAY: Record<string, number> = { 月: 0, 火: 1, 水: 2, 木: 3, 金: 4, 土: 5, 日: 6 };
const EN_WEEKDAY: Record<string, number> = {
  mon: 0,
  tue: 1,
  wed: 2,
  thu: 3,
  fri: 4,
  sat: 5,
  sun: 6,
};
const EN_WEEKDAY_SRC =
  "mon(?:day)?|tue(?:s(?:day)?)?|wed(?:s|nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?";

const JA_RELATIVE: Record<string, number> = {
  今日: 0,
  本日: 0,
  明日: 1,
  あした: 1,
  明後日: 2,
  あさって: 2,
};
const EN_RELATIVE: Record<string, number> = {
  today: 0,
  tomorrow: 1,
  tmr: 1,
  tmrw: 1,
  "day after tomorrow": 2,
};

function time(hour: number, minute: number): Value | null {
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { time: { hour, minute } };
}

function estimate(min: number): Value | null {
  const n = Math.round(min);
  return Number.isFinite(n) && n > 0 ? { estimateMin: n } : null;
}

function enWeekday(word: string | undefined): number {
  return EN_WEEKDAY[(word ?? "").slice(0, 3).toLowerCase()] ?? -1;
}

const RULES: Rule[] = [
  // --- 日付
  {
    kind: "date",
    re: /(\d{4})[-/](\d{1,2})[-/](\d{1,2})/gu,
    edge: "word",
    tentativeIfUnbounded: false,
    value: (m) => {
      const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
      return validYmd(y, mo, d) ? { date: formatYmd(y, mo, d) } : null;
    },
  },
  {
    kind: "date",
    re: /(\d{1,2})月(\d{1,2})日/gu,
    edge: "word",
    tentativeIfUnbounded: true,
    value: (m, today) => {
      const date = resolveMonthDay(today, Number(m[1]), Number(m[2]));
      return date ? { date } : null;
    },
  },
  {
    kind: "date",
    re: /(\d{1,2})\/(\d{1,2})/gu,
    edge: "word",
    tentativeIfUnbounded: false,
    value: (m, today) => {
      const date = resolveMonthDay(today, Number(m[1]), Number(m[2]));
      return date ? { date } : null;
    },
  },
  {
    kind: "date",
    re: /明後日|あさって|明日|あした|今日|本日/gu,
    edge: "word",
    tentativeIfUnbounded: true,
    value: (m, today) => ({ date: addDays(today, JA_RELATIVE[m[0]] ?? 0) }),
  },
  {
    kind: "date",
    re: /day\s+after\s+tomorrow|tomorrow|tmrw|tmr|today/giu,
    edge: "word",
    tentativeIfUnbounded: false,
    value: (m, today) => {
      const key = m[0].toLowerCase().replace(/\s+/gu, " ");
      return { date: addDays(today, EN_RELATIVE[key] ?? 0) };
    },
  },
  {
    kind: "date",
    re: /(?:(再来週|来週)の?)?([月火水木金土日])曜日?/gu,
    edge: "word",
    tentativeIfUnbounded: true,
    value: (m, today) => {
      const wd = JA_WEEKDAY[m[2] ?? ""];
      if (wd === undefined) return null;
      if (m[1] === "来週") return { date: weekdayInWeek(today, 1, wd) };
      if (m[1] === "再来週") return { date: weekdayInWeek(today, 2, wd) };
      return { date: nextWeekday(today, wd) };
    },
  },
  {
    kind: "date",
    re: new RegExp(`next\\s+(${EN_WEEKDAY_SRC})`, "giu"),
    edge: "word",
    tentativeIfUnbounded: false,
    value: (m, today) => {
      const wd = enWeekday(m[1]);
      return wd < 0 ? null : { date: weekdayInWeek(today, 1, wd) };
    },
  },
  {
    kind: "date",
    re: new RegExp(`(${EN_WEEKDAY_SRC})`, "giu"),
    edge: "word",
    tentativeIfUnbounded: false,
    // 「sun」「sat」は普通の英単語としても使うので候補にとどめる
    alwaysTentative: (m) => /^(sun|sat)$/iu.test(m[0]),
    value: (m, today) => {
      const wd = enWeekday(m[1]);
      return wd < 0 ? null : { date: nextWeekday(today, wd) };
    },
  },
  // --- 時刻（「3時間」は見積もりなので「時」の直後の「間」を除く）
  {
    kind: "time",
    re: /(午前|午後)?(\d{1,2})時(?:(半)|(\d{1,2})分)?(?!間)/gu,
    edge: "word",
    tentativeIfUnbounded: true,
    value: (m) => {
      let h = Number(m[2]);
      const min = m[3] ? 30 : m[4] ? Number(m[4]) : 0;
      if (m[1]) {
        if (h > 12) return null;
        if (m[1] === "午後" && h < 12) h += 12;
        if (m[1] === "午前" && h === 12) h = 0;
      }
      return time(h, min);
    },
  },
  {
    kind: "time",
    re: /(\d{1,2})(?::(\d{2}))?\s?(am|pm)/giu,
    edge: "word",
    tentativeIfUnbounded: false,
    value: (m) => {
      let h = Number(m[1]);
      if (h < 1 || h > 12) return null;
      const pm = (m[3] ?? "").toLowerCase() === "pm";
      if (pm && h < 12) h += 12;
      if (!pm && h === 12) h = 0;
      return time(h, m[2] ? Number(m[2]) : 0);
    },
  },
  {
    kind: "time",
    re: /(\d{1,2}):(\d{2})/gu,
    edge: "word",
    tentativeIfUnbounded: false,
    value: (m) => time(Number(m[1]), Number(m[2])),
  },
  {
    // 「at 3」のような裸の数字は時刻かもしれないが確定させない
    kind: "time",
    re: /at\s+(\d{1,2})(?![\d:]|\s?[ap]m)/giu,
    edge: "word",
    tentativeIfUnbounded: false,
    alwaysTentative: () => true,
    value: (m) => time(Number(m[1]), 0),
  },
  // --- 見積もり
  {
    kind: "estimate",
    re: /(\d+(?:\.\d+)?)時間(?:(半)|(\d{1,2})分)?|(\d+)分/gu,
    edge: "word",
    tentativeIfUnbounded: true,
    value: (m) => {
      if (m[4]) return estimate(Number(m[4]));
      const extra = m[2] ? 30 : m[3] ? Number(m[3]) : 0;
      return estimate(Number(m[1]) * 60 + extra);
    },
  },
  {
    kind: "estimate",
    re: /(\d+(?:\.\d+)?)(?:hours|hour|hrs|hr|h)(?:(\d+)(?:minutes|minute|mins|min|m))?|(\d+)(?:minutes|minute|mins|min|m)/giu,
    edge: "word",
    tentativeIfUnbounded: false,
    value: (m) => {
      if (m[3]) return estimate(Number(m[3]));
      return estimate(Number(m[1]) * 60 + (m[2] ? Number(m[2]) : 0));
    },
  },
  // --- プロジェクト・優先度・いつか・Inbox
  {
    kind: "project",
    re: /#([\p{L}\p{N}_-]+)/gu,
    edge: "space",
    tentativeIfUnbounded: false,
    value: (m) => ({ project: m[1] ?? "" }),
  },
  {
    kind: "priority",
    re: /!([1-3])/gu,
    edge: "space",
    tentativeIfUnbounded: false,
    value: (m) => ({ priority: Number(m[1]) as 1 | 2 | 3 }),
  },
  {
    kind: "someday",
    re: /いつか|someday/giu,
    edge: "word",
    tentativeIfUnbounded: false,
    value: () => ({}),
  },
  {
    kind: "inbox",
    re: /inbox|インボックス/giu,
    edge: "word",
    tentativeIfUnbounded: false,
    value: () => ({}),
  },
];

// ---------------------------------------------------------------------------
// 本体

const WORD_CHAR = /[\p{L}\p{N}_]/u;
const SPACE = /\s/u;

interface Candidate {
  rule: Rule;
  order: number;
  start: number;
  end: number;
  text: string;
  value: Value;
  bounded: boolean;
  forceTentative: boolean;
}

function isBounded(raw: string, start: number, end: number, edge: Rule["edge"]): boolean {
  const before = start > 0 ? raw.charAt(start - 1) : "";
  const after = end < raw.length ? raw.charAt(end) : "";
  const afterOk = after === "" || !WORD_CHAR.test(after);
  if (edge === "space") return (before === "" || SPACE.test(before)) && afterOk;
  return (before === "" || !WORD_CHAR.test(before)) && afterOk;
}

function collect(raw: string, today: string): Candidate[] {
  const out: Candidate[] = [];
  const hasToday = parseYmd(today) !== null;
  RULES.forEach((rule, order) => {
    if (rule.kind === "date" && !hasToday) return;
    const re = new RegExp(rule.re.source, rule.re.flags);
    for (let m = re.exec(raw); m !== null; m = re.exec(raw)) {
      if (m[0] === "") {
        re.lastIndex += 1;
        continue;
      }
      const value = rule.value(m, today);
      if (!value) continue;
      const start = m.index;
      const end = start + m[0].length;
      out.push({
        rule,
        order,
        start,
        end,
        text: m[0],
        value,
        bounded: isBounded(raw, start, end, rule.edge),
        forceTentative: rule.alwaysTentative?.(m) ?? false,
      });
    }
  });
  // 出現順。同じ位置なら長い方、次にルール順
  out.sort((a, b) => a.start - b.start || b.end - a.end || a.order - b.order);
  return out;
}

function emptyParsed(title: string): ParsedTask {
  return {
    title,
    date: null,
    time: null,
    estimateMin: null,
    project: null,
    priority: null,
    someday: false,
    inbox: false,
    chips: [],
    tentative: [],
  };
}

function collapse(s: string): string {
  return s.replace(/\s+/gu, " ").trim();
}

function parseTaskUnsafe(raw: string, ctx: ParseContext): ParsedTask {
  const result = emptyParsed("");
  const claimed: { start: number; end: number }[] = [];
  const committedKinds = new Set<ChipKind>();
  const overlaps = (c: Candidate) => claimed.some((r) => c.start < r.end && r.start < c.end);

  for (const c of collect(raw, ctx.today)) {
    if (overlaps(c)) continue;
    const chip: Chip = { kind: c.rule.kind, start: c.start, end: c.end, text: c.text };
    const tentative = c.bounded ? c.forceTentative : c.rule.tentativeIfUnbounded;
    if (!c.bounded && !tentative) continue;
    if (tentative) {
      const v: Partial<Pick<ParsedTask, "date" | "time" | "estimateMin">> = {};
      if (c.value.date !== undefined) v.date = c.value.date;
      if (c.value.time !== undefined) v.time = c.value.time;
      if (c.value.estimateMin !== undefined) v.estimateMin = c.value.estimateMin;
      result.tentative.push({ ...chip, value: v });
      claimed.push(c);
      continue;
    }
    // 同じ種類は最初の1つだけ確定する。2つ目以降はタイトルに残す
    if (committedKinds.has(c.rule.kind)) continue;
    committedKinds.add(c.rule.kind);
    claimed.push(c);
    result.chips.push(chip);
    switch (c.rule.kind) {
      case "date":
        result.date = c.value.date ?? null;
        break;
      case "time":
        result.time = c.value.time ?? null;
        break;
      case "estimate":
        result.estimateMin = c.value.estimateMin ?? null;
        break;
      case "project":
        result.project = c.value.project ?? null;
        break;
      case "priority":
        result.priority = c.value.priority ?? null;
        break;
      case "someday":
        result.someday = true;
        break;
      case "inbox":
        result.inbox = true;
        break;
    }
  }

  const parts: string[] = [];
  let pos = 0;
  for (const chip of result.chips) {
    parts.push(raw.slice(pos, chip.start));
    pos = chip.end;
  }
  parts.push(raw.slice(pos));
  const title = collapse(parts.join(" ")).replace(/^[、,，]+|[、,，]+$/gu, "");
  result.title = collapse(title) || collapse(raw);
  return result;
}

export function parseTask(raw: string, ctx: ParseContext): ParsedTask {
  const text = typeof raw === "string" ? raw : "";
  try {
    return parseTaskUnsafe(text, ctx);
  } catch {
    return emptyParsed(collapse(text));
  }
}

const NO_DATE_WORDS = new Set(["inbox", "インボックス", "なし", "none"]);

/**
 * 「日付へ移動」（`m` キー）の入力を解釈する。日付なら `YYYY-MM-DD`、Inbox / 日付なしの指定なら null、
 * 解釈できなければ undefined。parseTask の日付表現に加えて「today」「t」「+2」（今日から n 日後）、
 * 「next week」「来週」（来週の月曜）を受け付ける。
 */
export function parseDateInput(raw: string, ctx: ParseContext): string | null | undefined {
  try {
    if (typeof raw !== "string" || parseYmd(ctx.today) === null) return undefined;
    const s = collapse(raw).toLowerCase();
    if (s === "") return undefined;
    if (NO_DATE_WORDS.has(s)) return null;
    if (s === "t" || s === "today") return ctx.today;
    const plus = /^\+(\d{1,4})$/u.exec(s);
    if (plus) return addDays(ctx.today, Number(plus[1]));
    if (s === "next week" || s === "来週") return weekdayInWeek(ctx.today, 1, 0);
    const p = parseTaskUnsafe(s, ctx);
    const only = p.chips[0];
    if (
      p.chips.length === 1 &&
      only?.kind === "date" &&
      only.start === 0 &&
      only.end === s.length
    ) {
      return p.date ?? undefined;
    }
    return undefined;
  } catch {
    return undefined;
  }
}
