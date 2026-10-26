/**
 * 日報のテンプレート（M4-3。phase0-plan 4.6、ux-mvp 8章）。LLM を使わず、事実（DailyReport）から Markdown を組み立てる。
 * 見出しと文言は UI の言語（英語が正、日本語）。時間・時刻・リポジトリ・PR 番号は言語に関係なく ASCII（m2-api.md 6.2）。
 * 壁打ち（D-135）はリポジトリの欄に `Scratch` / `壁打ち`（言語ごと）。
 *
 *   ## Fri 2026-10-02
 *   Time: You 5h10m (meetings 1h30m) · AI 4h5m (7 runs, up to 3 in parallel)
 *   Idle 42m · Expired 1
 *   api-gateway 22m · Turnlane 13m · blog 7m
 *   Expired: Rename env var question
 *
 *   ### What I did
 *   - Review dependency update (8m) ← AI: Dependency update
 *   ...
 */
import type {
  DailyReport,
  ReportAiLine,
  ReportAiResult,
  ReportLocale,
  StoredWait,
  TitleSpec,
} from "../api/index.ts";
import { fmtDuration } from "../format.ts";
import { formatTaskTitle } from "../i18n/task-title.ts";

interface Strings {
  time: string;
  you: string;
  meetings: string;
  runs: (n: number, max: number) => string;
  idle: string;
  expired: string;
  expiredItems: string;
  noRepo: string;
  scratch: string;
  did: string;
  aiDid: string;
  carried: string;
  note: string;
  aiWork: string;
  fromAi: string;
  result: (
    r: ReportAiResult,
    status: ReportAiLine["status"],
    turn?: ReportAiLine["turn"],
  ) => string;
  carriedSuffix: string;
  open: (lp: string, rp: string) => [string, string];
  sep: string;
  listSep: string;
}

const WEEKDAY_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEKDAY_JA = ["日", "月", "火", "水", "木", "金", "土"];

const en: Strings = {
  time: "Time",
  you: "You",
  meetings: "meetings",
  runs: (n, max) =>
    `${n} ${n === 1 ? "run" : "runs"}${max > 1 ? `, up to ${max} in parallel` : ""}`,
  idle: "Idle",
  expired: "Expired",
  expiredItems: "Expired",
  noRepo: "(no repo)",
  scratch: "Scratch",
  did: "What I did",
  aiDid: "What the AI did",
  carried: "Carried over",
  note: "Note",
  aiWork: "AI work",
  fromAi: "AI",
  result: (r, status, turn) => {
    if (r.kind === "pr") {
      const base = `PR #${r.pr} ${r.state === "unknown" ? "" : r.state}`.trimEnd();
      return status === "your_turn" &&
        (turn ?? "open") === "open" &&
        (r.state === "open" || r.state === "draft")
        ? `${base}, your turn`
        : base;
    }
    switch (r.status) {
      case "done":
        return r.limit ? "stopped at the usage limit" : "done";
      case "running":
        return "still running";
      case "your_turn":
        return turn === "grace" ? "stopped · in grace" : turn === "none" ? "done" : "your turn";
      case "needs_input":
        return r.waitingFor === "answer" ? "waiting for your answer" : "waiting for approval";
      case "error":
        return "stopped with an error";
    }
  },
  carriedSuffix: ", carried over",
  open: (l, r) => [` (${l}`, `${r})`],
  sep: " · ",
  listSep: ", ",
};

const ja: Strings = {
  time: "時間",
  you: "自分",
  meetings: "会議",
  runs: (n, max) => `${n}回の実行${max > 1 ? `、最大${max}並列` : ""}`,
  idle: "放置",
  expired: "期限切れ",
  expiredItems: "期限切れ",
  noRepo: "（リポジトリなし）",
  scratch: "壁打ち",
  did: "やったこと",
  aiDid: "AI がやったこと",
  carried: "持ち越し",
  note: "メモ",
  aiWork: "AI の作業",
  fromAi: "AI",
  result: (r, status, turn) => {
    if (r.kind === "pr") {
      const st = {
        open: "未マージ",
        draft: "下書き",
        merged: "マージ済み",
        closed: "閉じた",
        unknown: "",
      }[r.state];
      const base = `PR #${r.pr}${st ? ` ${st}` : ""}`;
      return status === "your_turn" &&
        (turn ?? "open") === "open" &&
        (r.state === "open" || r.state === "draft")
        ? `${base}、自分の番`
        : base;
    }
    switch (r.status) {
      case "done":
        return r.limit ? "利用上限で停止" : "完了";
      case "running":
        return "実行中";
      case "your_turn":
        // 自分の番の画面と同じ判定（D-214 (3)）: 猶予中はまだ自分の番に出ていない。出ないもの（変更の確認がオフ）は完了
        return turn === "grace" ? "止まった · 猶予中" : turn === "none" ? "完了" : "自分の番";
      case "needs_input":
        return r.waitingFor === "answer" ? "回答待ち" : "許可待ち";
      case "error":
        return "エラーで停止";
    }
  },
  carriedSuffix: "、持ち越し",
  open: (l, r) => [`（${l}`, `${r}）`],
  sep: " · ",
  listSep: "、",
};

const STRINGS: Record<ReportLocale, Strings> = { en, ja };

function parts(date: string): { y: number; m: number; d: number; dow: number } {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return { y, m, d, dow: new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay() };
}

/** 日報の見出しの日付: `Fri 2026-10-02` / `2026-10-02（金）` */
export function reportDateLabel(date: string, locale: ReportLocale): string {
  const p = parts(date);
  return locale === "ja" ? `${date}（${WEEKDAY_JA[p.dow]}）` : `${WEEKDAY_EN[p.dow]} ${date}`;
}

/** 持ち越し先の短い日付: `Mon 10/5` / `10/5（月）` */
export function reportShortDate(date: string, locale: ReportLocale): string {
  const p = parts(date);
  return locale === "ja"
    ? `${p.m}/${p.d}（${WEEKDAY_JA[p.dow]}）`
    : `${WEEKDAY_EN[p.dow]} ${p.m}/${p.d}`;
}

export function reportTitle(t: TitleSpec, locale: ReportLocale): string {
  return t.t === "text" ? t.text : formatTaskTitle(t.key, t.params, locale);
}

/** `Time: You 5h10m (meetings 1h30m) · AI 4h5m (7 runs, up to 3 in parallel)` */
export function reportTimeLine(r: DailyReport, locale: ReportLocale): string {
  const s = STRINGS[locale];
  const [lo, lc] = s.open("", "");
  const meet = r.meetingsMs > 0 ? `${lo}${s.meetings} ${fmtDuration(r.meetingsMs)}${lc}` : "";
  const runs = r.runs > 0 ? `${lo}${s.runs(r.runs, r.maxParallel)}${lc}` : "";
  return `${s.time}: ${s.you} ${fmtDuration(r.youMs)}${meet}${s.sep}AI ${fmtDuration(r.aiMs)}${runs}`;
}

/** `Idle 42m · Expired 1`（Idle は 0 でも出す。プロダクトの芯の指標。Expired は 0 なら出さない） */
export function reportIdleLine(r: DailyReport, locale: ReportLocale): string {
  const s = STRINGS[locale];
  const xs = [`${s.idle} ${fmtDuration(r.idleMs)}`];
  if (r.expired > 0) xs.push(`${s.expired} ${r.expired}`);
  return xs.join(s.sep);
}

/** リポジトリ別の放置 `api-gateway 22m · Turnlane 13m`（無ければ null） */
export function reportIdleByRepoLine(r: DailyReport, locale: ReportLocale): string | null {
  const s = STRINGS[locale];
  const xs = r.idleByRepo.filter((x) => x.ms > 0);
  if (xs.length === 0) return null;
  return xs
    .map((x) => `${x.repo ?? (x.scratch ? s.scratch : s.noRepo)} ${fmtDuration(x.ms)}`)
    .join(s.sep);
}

/** `Expired: Rename env var question`（無ければ null。S3） */
export function reportExpiredLine(r: DailyReport, locale: ReportLocale): string | null {
  const s = STRINGS[locale];
  if (r.expiredItems.length === 0) return null;
  return `${s.expiredItems}: ${r.expiredItems.map((t) => reportTitle(t, locale)).join(s.listSep)}`;
}

export function reportDidText(line: DailyReport["did"][number], locale: ReportLocale): string {
  const s = STRINGS[locale];
  const time = line.ms !== null && line.ms > 0 ? ` (${fmtDuration(line.ms)})` : "";
  const ai = line.fromAi !== null ? ` ← ${s.fromAi}: ${line.fromAi}` : "";
  return `${reportTitle(line.title, locale)}${time}${ai}`;
}

/** AI の行のリポジトリの欄: リポジトリ名、壁打ち（D-135）、git 管理外は `(no repo)` */
export function reportAiWhere(
  line: Pick<ReportAiLine, "repo" | "scratch">,
  locale: ReportLocale,
): string {
  const s = STRINGS[locale];
  return line.repo ?? (line.scratch ? s.scratch : s.noRepo);
}

/** 名前: その日の最初の自分の指示（保存しているとき。ADR 0018）→ 題名 → ブランチ */
export function reportAiName(line: ReportAiLine, locale: ReportLocale): string {
  return line.asked ?? line.title ?? line.branch ?? STRINGS[locale].aiWork;
}

const ERR_TEXT: Record<ReportLocale, Record<string, string>> = {
  en: {
    rate_limit: "usage limit reached",
    overloaded: "API overloaded",
    server_error: "API error",
    authentication: "authentication error",
    billing: "billing error",
    other: "unknown error",
  },
  ja: {
    rate_limit: "API の利用上限",
    overloaded: "API の混雑",
    server_error: "API のエラー",
    authentication: "認証のエラー",
    billing: "支払いのエラー",
    other: "不明なエラー",
  },
};

/** 今止まっている待ちの中身（`Bash \`bun test\``・「問い」・エラーの種類）。保存しているときだけ */
export function reportStoppedText(w: StoredWait, locale: ReportLocale): string {
  const q = (s: string) => (locale === "ja" ? `「${s}」` : `“${s}”`);
  if (w.kind === "permission")
    return [w.tool, w.command ? `\`${w.command}\`` : w.label].filter(Boolean).join(" ");
  if (w.kind === "error") return w.errorKind ? (ERR_TEXT[locale][w.errorKind] ?? "") : "";
  return w.text ? q(w.text) : "";
}

export function reportAiResultText(line: ReportAiLine, locale: ReportLocale): string {
  const s = STRINGS[locale];
  const stop = line.stopped ? reportStoppedText(line.stopped, locale) : "";
  return `${s.result(line.result, line.status, line.turn)}${stop ? `${s.sep}${stop}` : ""}${line.carried ? s.carriedSuffix : ""}`;
}

/** `[Turnlane] Date lane DnD — PR #142 open, your turn (AI 38m)` */
export function reportAiText(line: ReportAiLine, locale: ReportLocale): string {
  const repo = `[${reportAiWhere(line, locale)}]`;
  return `${repo} ${reportAiName(line, locale)} — ${reportAiResultText(line, locale)} (AI ${fmtDuration(line.aiMs)})`;
}

export function reportCarryText(
  line: DailyReport["carried"][number],
  locale: ReportLocale,
): string {
  const base = `${reportTitle(line.title, locale)} → ${reportShortDate(line.to, locale)}`;
  const skipped = line.skippedHolidays ?? [];
  if (skipped.length === 0) return base;
  // 飛ばした祝日（phase0-plan 4.5: `→ Tue 10/13 (Mon 10/12 is a holiday)`。祝日名は予定の題名のまま）
  const why = skipped
    .map((h) =>
      locale === "ja"
        ? `${reportShortDate(h.date, locale)}は祝日${h.name ? `: ${h.name}` : ""}`
        : `${reportShortDate(h.date, locale)} is a holiday${h.name ? `: ${h.name}` : ""}`,
    )
    .join(locale === "ja" ? "、" : "; ");
  return locale === "ja" ? `${base}（${why}）` : `${base} (${why})`;
}

export function reportHeadings(locale: ReportLocale) {
  const s = STRINGS[locale];
  return { did: s.did, aiDid: s.aiDid, carried: s.carried, note: s.note };
}

/** 本文（Note を除く） */
export function renderDailyReportBody(r: DailyReport, locale: ReportLocale): string {
  const h = reportHeadings(locale);
  const lines: string[] = [`## ${reportDateLabel(r.date, locale)}`, ""];
  lines.push(reportTimeLine(r, locale));
  lines.push(reportIdleLine(r, locale));
  const byRepo = reportIdleByRepoLine(r, locale);
  if (byRepo) lines.push(byRepo);
  const exp = reportExpiredLine(r, locale);
  if (exp) lines.push(exp);
  const section = (title: string, items: string[]) => {
    if (items.length === 0) return;
    lines.push("", `### ${title}`, ...items.map((x) => `- ${x}`));
  };
  section(
    h.did,
    r.did.map((x) => reportDidText(x, locale)),
  );
  section(
    h.aiDid,
    r.aiDid.map((x) => reportAiText(x, locale)),
  );
  section(
    h.carried,
    r.carried.map((x) => reportCarryText(x, locale)),
  );
  return `${lines.join("\n")}\n`;
}

/** Note の節（空なら空文字） */
export function renderNoteSection(note: string | null | undefined, locale: ReportLocale): string {
  const n = note?.trim();
  if (!n) return "";
  return `\n### ${reportHeadings(locale).note}\n${n}\n`;
}

/** 末尾の Note の節（英日どちらの見出しでも）を本文から切り離す */
function splitNote(saved: string): { body: string; note: string } {
  for (const locale of ["en", "ja"] as const) {
    const head = `\n### ${reportHeadings(locale).note}\n`;
    const i = saved.lastIndexOf(head);
    if (i >= 0) return { body: saved.slice(0, i).replace(/\s+$/, ""), note: saved.slice(i) };
  }
  return { body: saved.replace(/\s+$/, ""), note: "" };
}

/**
 * 確定済みの日報に、確定の後で移した持ち越し（「残り N 件を今日へ」。D-192）の節を足す。持ち越しが無ければそのまま。
 * 既にある持ち越しの節（英日どちらでも）は置き換える
 */
export function withCarried(
  saved: string,
  carried: DailyReport["carried"],
  locale: ReportLocale,
): string {
  if (carried.length === 0) return saved;
  const { body, note } = splitNote(saved);
  let base = body;
  for (const l of ["en", "ja"] as const) {
    const head = `\n### ${reportHeadings(l).carried}\n`;
    const i = base.lastIndexOf(head);
    if (i >= 0) base = base.slice(0, i).replace(/\s+$/, "");
  }
  const lines = carried.map((x) => `- ${reportCarryText(x, locale)}`);
  return `${base}\n\n### ${reportHeadings(locale).carried}\n${lines.join("\n")}\n${note}`;
}

/** 日報の全文（本文 + Note）。body を渡せば（編集した本文）それを使う */
export function renderDailyReport(
  r: DailyReport,
  locale: ReportLocale,
  opts: { body?: string | undefined; note?: string | null | undefined } = {},
): string {
  const body = (opts.body ?? renderDailyReportBody(r, locale)).replace(/\s+$/, "");
  const note = opts.note !== undefined ? opts.note : r.note;
  return `${body}\n${renderNoteSection(note, locale)}`;
}
