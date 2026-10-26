/**
 * ⌘K のパレットの中身（ux-mvp 6.1、M2-15）。入力・カテゴリ・画面の選択・YOUR TURN・最近・検索結果から、
 * 区分ごとの行を組み立てる純粋関数。行の実行内容（Action）は JSON にできる形にして、「最近」にそのまま保存する。
 */
import {
  fmtClock,
  fmtDuration,
  fmtWait,
  matchScore,
  parseDateInput,
  parseTask,
  primaryFollowUp,
  type QueueItem,
  type SearchResponse,
  searchTokens,
  type TitleSpec,
  type WorkItemStatus,
} from "@turnlane/core/web";
import { ext } from "../ext/registry.ts";
import type { MessageKey } from "../i18n/en.ts";
import type { AnyMessageKey, LanguageSetting, Params } from "../i18n/index.tsx";
import { shownKeys } from "../keys/keymap.ts";
import type { SelItem } from "../lib/store.ts";
import { whereName } from "../lib/where.ts";
import type { SettingsSectionId } from "../routes/settings-index.ts";

export type Category = "all" | "commands" | "tasks" | "ai" | "events" | "goto";
export const CATEGORIES: readonly Category[] = ["all", "commands", "tasks", "ai", "events", "goto"];

export type SectionId =
  | "selected"
  | "yourTurn"
  | "recent"
  | "goto"
  | "ai"
  | "tasks"
  | "events"
  | "commands"
  /** 時間に置く（`p`）の候補 */
  | "place"
  /** 新規タスクの入力 */
  | "new";

/** カテゴリで絞ったときに出す区分 */
const SECTIONS_OF: Record<Exclude<Category, "all">, SectionId[]> = {
  commands: ["selected", "commands"],
  tasks: ["tasks"],
  ai: ["ai"],
  events: ["events"],
  goto: ["goto"],
};

/** All のときの区分ごとの上限と、カテゴリで絞ったときの上限（ux-mvp 6.1） */
export const LIMIT_ALL = 5;
export const LIMIT_CATEGORY = 20;
const YOUR_TURN_TOP = 3;
export const RECENT_MAX = 5;

export const SCREEN_PATHS = ["/board", "/day", "/queue", "/inbox", "/ai", "/settings"] as const;
export type ScreenPath = (typeof SCREEN_PATHS)[number];

/** 行の実行内容（JSON にできる形。最近に保存する） */
export type Action =
  /** 画面へ。date: undefined = そのまま、null = 今日、文字列 = その日。record: デイビューで記録のパネルも開く（D-192） */
  | { t: "nav"; to: ScreenPath; date?: string | null; hash?: SettingsSectionId; record?: boolean }
  /** 画面のキーの処理に渡す（keymap の id） */
  | { t: "key"; id: string }
  | { t: "openAi"; workItemId: string }
  | { t: "openTurn"; followUpId: string }
  | { t: "panel"; workItemId: string }
  /** その日の週ボード（Inbox）へ移って選び、タスクの詳細パネルを開く（D-070） */
  | { t: "focusTask"; taskId: string; date: string | null }
  /** その日のデイビューへ移り、予定の詳細パネルを開く（D-070） */
  | { t: "event"; eventId: string; date: string }
  | { t: "mode"; mode: "new" | "place" }
  | { t: "createTask"; raw: string }
  | { t: "place"; taskId: string; date: string; start: number; end: number }
  | { t: "theme"; value: "light" | "dark" | "system" }
  | { t: "lang"; value: LanguageSetting }
  | { t: "rescan" }
  /** 拡張のコマンド（ADR 0015。key は `<拡張の id>:<コマンドの id>`） */
  | { t: "ext"; key: string }
  /** 選んでいるタスク（1件）への拡張のメニューの項目（右クリックと同じ。対象は実行の時の選択） */
  | { t: "extTask"; key: string };

/** パレットの行の絵柄の名前（CommandPalette.tsx の対応表のキー。対応表は Record<GlyphName, …> なので抜けは型で落ちる） */
export const GLYPH_NAMES = [
  "today",
  "week",
  "day",
  "turn",
  "inbox",
  "ai",
  "note",
  "settings",
  "date",
  "event",
  "plus",
  "theme",
  "lang",
  "hooks",
  "calendar",
  "rescan",
  "keys",
  "sidebar",
  "undo",
  "prev",
  "next",
  "action",
  "clock",
  "focus",
] as const;
export type GlyphName = (typeof GLYPH_NAMES)[number];

export type Icon =
  | { t: "status"; status: WorkItemStatus; estimated: boolean }
  | { t: "check"; checked: boolean }
  | { t: "glyph"; name: GlyphName };

export interface Row {
  id: string;
  section: SectionId;
  label: string;
  /** mono のメタ（`repo · branch #142`）や補足 */
  meta?: string | null;
  /** 右端の mono の文字（日付・待ち・状態） */
  right?: string | null;
  /** 右端のキー（keymap の表記） */
  keys?: string[];
  icon: Icon;
  /** 完了したタスク（取り消し線） */
  done?: boolean;
  run: Action;
  /** ⌘⏎ */
  alt?: Action;
  /** 一致を見る文字列（無ければ label） */
  hay?: string;
}

export interface Section {
  id: SectionId;
  rows: Row[];
  /** 見出しの横の補足（Selected の対象の題名・件数） */
  note?: string | null;
}

export interface BuildInput {
  q: string;
  category: Category;
  /** 今の言語で引く */
  t: (key: AnyMessageKey, params?: Params) => string;
  /** 英語で引く（日本語の UI でも英語の語で引けるようにする） */
  tEn: (key: AnyMessageKey, params?: Params) => string;
  shortDate: (date: string) => string;
  titleOf: (t: TitleSpec) => string;
  /** 論理日の今日（自然言語の日付の基準） */
  today: string;
  now: number;
  tz: string;
  selection: readonly SelItem[];
  /** 帯・キューに出す行（visibleQueue 済み） */
  queue: readonly QueueItem[];
  recent: readonly Row[];
  search: SearchResponse | undefined;
  theme: "system" | "light" | "dark";
  language: LanguageSetting;
  /** `Claude Code receiving · Codex off`（無ければ null） */
  hooksText: string | null;
  /** `Connected` など（無ければ null） */
  calendarText: string | null;
  /** 拡張のコマンド（省略時はこのビルドに組み込んだもの。テストで差し替える） */
  extCommands?: readonly { key: string; label: AnyMessageKey }[];
  /** 拡張のタスクのメニューの項目（省略時はこのビルドに組み込んだもの。テストで差し替える） */
  extTaskMenu?: readonly {
    key: string;
    label: AnyMessageKey;
    when?: (task: Extract<SelItem, { kind: "task" }>["task"]) => boolean;
  }[];
  /** 集中モード（D-097）: 集中中か、「次の予定の終わりまで」を選べるか（分からなければ出す / 出さない） */
  focus?: { active: boolean; eventAvailable: boolean } | null;
}

// ---------- 行 ----------

interface ScreenDef {
  id: string;
  label: MessageKey;
  to: ScreenPath;
  /** 画面への移動の代わりにキーの処理を呼ぶ（3日ボード / 週表示の切り替え。D-075） */
  key?: string;
  date?: string | null;
  /** 今日のデイビューを記録のパネル付きで開く（D-192） */
  record?: boolean;
  /** 行の右に出すキー（キーマップの id。今の割り当てを出す。D-077） */
  keyId?: string;
  icon: GlyphName;
}

const SCREENS: ScreenDef[] = [
  {
    id: "today",
    label: "palette.goto.today",
    to: "/day",
    date: null,
    keyId: "goDayToday",
    icon: "today",
  },
  { id: "week", label: "palette.goto.week", to: "/board", keyId: "goBoard", icon: "week" },
  // ビューの切り替え（D-075）
  {
    id: "three",
    label: "palette.goto.three",
    to: "/board",
    key: "viewThree",
    keyId: "viewThree",
    icon: "week",
  },
  {
    id: "weekView",
    label: "palette.goto.weekView",
    to: "/board",
    key: "viewWeek",
    keyId: "viewWeek",
    icon: "week",
  },
  { id: "day", label: "palette.goto.day", to: "/day", keyId: "viewDay", icon: "day" },
  { id: "queue", label: "nav.yourTurn", to: "/queue", keyId: "goQueue", icon: "turn" },
  { id: "inbox", label: "nav.inbox", to: "/inbox", keyId: "goInbox", icon: "inbox" },
  { id: "ai", label: "nav.ai", to: "/ai", keyId: "goAi", icon: "ai" },
  // 記録（D-192）: 今日のデイビューを記録のパネル付きで開く
  {
    id: "record",
    label: "nav.record",
    to: "/day",
    date: null,
    record: true,
    keyId: "goRecord",
    icon: "note",
  },
  { id: "settings", label: "nav.settings", to: "/settings", keyId: "goSettings", icon: "settings" },
];

/** 空入力の Go to（今日の画面への移動。Settings と Day は入れない） */
const EMPTY_GOTO = ["today", "week", "queue", "inbox", "record"];

function screenRows(i: BuildInput): Row[] {
  return SCREENS.map((s) => ({
    id: `goto:${s.id}`,
    section: "goto",
    label: i.t(s.label),
    hay: `${i.t(s.label)} ${i.tEn(s.label)}`,
    ...(s.keyId ? { keys: shownKeys(s.keyId) } : {}),
    icon: { t: "glyph", name: s.icon },
    run: s.key
      ? { t: "key", id: s.key }
      : {
          t: "nav",
          to: s.to,
          ...(s.date !== undefined ? { date: s.date } : {}),
          ...(s.record ? { record: true } : {}),
        },
  }));
}

/** 入力が日付として読めたら、その週とその日への2行（`水曜`・`10/12`・`tomorrow`） */
export function dateRows(i: BuildInput): Row[] {
  const q = i.q.trim();
  if (q === "") return [];
  const d = parseDateInput(q, { today: i.today });
  if (typeof d !== "string") return [];
  const label = i.shortDate(d);
  return [
    {
      id: `date:week:${d}`,
      section: "goto",
      label: i.t("palette.date.week", { date: label }),
      icon: { t: "glyph", name: "week" },
      run: { t: "nav", to: "/board", date: d },
      alt: { t: "nav", to: "/day", date: d },
    },
    {
      id: `date:day:${d}`,
      section: "goto",
      label: i.t("palette.date.day", { date: label }),
      icon: { t: "glyph", name: "date" },
      run: { t: "nav", to: "/day", date: d },
    },
  ];
}

function selectionTitle(i: BuildInput): string | null {
  const s = i.selection;
  if (s.length === 0) return null;
  if (s.length > 1) return i.t("palette.sel.count", { count: s.length });
  const x = s[0] as SelItem;
  if (x.kind === "task") return i.titleOf(x.task.title);
  if (x.kind === "turn") {
    const f = primaryFollowUp(x.item);
    return f ? i.titleOf(f.title) : (x.item.title ?? "");
  }
  return x.title ?? "";
}

/** 画面で選んでいる項目への操作（ux-mvp 6.1 の表）。キーは keymap と同じ */
export function selectionRows(i: BuildInput): Row[] {
  const s = i.selection;
  if (s.length === 0) return [];
  const has = (k: SelItem["kind"]) => s.some((x) => x.kind === k);
  const tasks = s.filter((x): x is Extract<SelItem, { kind: "task" }> => x.kind === "task");
  const out: Row[] = [];
  const add = (id: string, label: MessageKey, keys: string[], run: Action) =>
    out.push({
      id: `sel:${id}`,
      section: "selected",
      label: i.t(label),
      hay: `${i.t(label)} ${i.tEn(label)}`,
      keys,
      icon: { t: "glyph", name: "action" },
      run,
    });
  const onlyAi = s.length === 1 && s[0]?.kind === "ai";
  if (has("turn") || has("ai"))
    add(
      "open",
      "palette.sel.open",
      shownKeys("open"),
      onlyAi ? { t: "openAi", workItemId: (s[0] as { id: string }).id } : { t: "key", id: "open" },
    );
  if (has("turn") || has("ai"))
    add("openWith", "palette.sel.openWith", shownKeys("openWith"), { t: "key", id: "openWith" });
  if (has("turn") || has("ai") || tasks.some((x) => x.task.workItemId))
    add("detail", "palette.sel.detail", shownKeys("detail"), { t: "key", id: "detail" });
  if (has("turn"))
    add("moveTurn", "palette.sel.moveTurn", shownKeys("move"), { t: "key", id: "move" });
  else if (tasks.length > 0)
    add("moveTask", "palette.sel.moveTask", shownKeys("move"), { t: "key", id: "move" });
  if (tasks.length === 1 && s.length === 1)
    add("place", "palette.sel.place", shownKeys("place"), { t: "mode", mode: "place" });
  if (tasks.length > 0)
    add("today", "palette.sel.today", shownKeys("today"), { t: "key", id: "today" });
  if (has("turn")) {
    add("snooze", "palette.sel.snooze", shownKeys("snooze"), { t: "key", id: "snooze" });
    add("dismiss", "palette.sel.dismiss", shownKeys("dismiss"), { t: "key", id: "dismiss" });
  }
  if (has("ai"))
    add("reply", "palette.sel.reply", shownKeys("replyTask"), { t: "key", id: "replyTask" });
  if (tasks.length > 0 || has("turn"))
    add("complete", "palette.sel.complete", shownKeys("complete"), { t: "key", id: "complete" });
  if (tasks.length > 0) {
    add("rename", "palette.sel.rename", shownKeys("rename"), { t: "key", id: "rename" });
    add("delete", "palette.sel.delete", shownKeys("delete"), { t: "key", id: "delete" });
  }
  // 拡張のタスクのメニューの項目（ADR 0015。右クリックと同じく1件・未完了のタスクだけ。公開のビルドでは無い）
  const only = tasks.length === 1 && s.length === 1 ? tasks[0]?.task : undefined;
  if (only && only.status !== "done")
    for (const x of i.extTaskMenu ?? ext.taskMenuItems)
      if (!x.when || x.when(only))
        out.push({
          id: `sel:ext:${x.key}`,
          section: "selected",
          label: i.t(x.label),
          hay: `${i.t(x.label)} ${i.tEn(x.label)}`,
          icon: { t: "glyph", name: "action" },
          run: { t: "extTask", key: x.key },
        });
  return out;
}

function commandRows(i: BuildInput): Row[] {
  const out: Row[] = [];
  const add = (
    id: string,
    label: AnyMessageKey,
    icon: GlyphName,
    run: Action,
    extra: Partial<Row> = {},
  ) =>
    out.push({
      id: `cmd:${id}`,
      section: "commands",
      label: i.t(label),
      hay: `${i.t(label)} ${i.tEn(label)}`,
      icon: { t: "glyph", name: icon },
      run,
      ...extra,
    });
  add("new", "palette.cmd.newTask", "plus", { t: "mode", mode: "new" }, { keys: shownKeys("new") });
  // 新しい予定（D-093）: パレットを閉じて画面の新規予定の入力を開く（⇧C と同じ）
  add(
    "newEvent",
    "palette.cmd.newEvent",
    "plus",
    { t: "key", id: "newEvent" },
    { keys: shownKeys("newEvent") },
  );
  for (const [v, k] of [
    ["light", "palette.cmd.themeLight"],
    ["dark", "palette.cmd.themeDark"],
    ["system", "palette.cmd.themeSystem"],
  ] as const)
    if (i.theme !== v) add(`theme:${v}`, k, "theme", { t: "theme", value: v });
  for (const [v, k] of [
    ["en", "palette.cmd.langEn"],
    ["ja", "palette.cmd.langJa"],
    ["system", "palette.cmd.langSystem"],
  ] as const)
    if (i.language !== v) add(`lang:${v}`, k, "lang", { t: "lang", value: v });
  add(
    "hooks",
    "palette.cmd.hooks",
    "hooks",
    { t: "nav", to: "/settings", hash: "ai" },
    { right: i.hooksText },
  );
  add(
    "calendar",
    "palette.cmd.calendar",
    "calendar",
    { t: "nav", to: "/settings", hash: "calendar" },
    { right: i.calendarText },
  );
  add("rescan", "palette.cmd.rescan", "rescan", { t: "rescan" });
  add("help", "palette.cmd.help", "keys", { t: "key", id: "help" }, { keys: shownKeys("help") });
  // 設定 › キーボード（D-080。D-083 で節になった）
  add("keyboard", "palette.cmd.keyboard", "keys", { t: "nav", to: "/settings", hash: "keyboard" });
  add(
    "sidebar",
    "palette.cmd.sidebar",
    "sidebar",
    { t: "key", id: "toggleSidebar" },
    { keys: shownKeys("toggleSidebar") },
  );
  add(
    "prevWeek",
    "palette.cmd.prevWeek",
    "prev",
    { t: "key", id: "prevWeek" },
    { keys: shownKeys("prevWeek") },
  );
  add(
    "nextWeek",
    "palette.cmd.nextWeek",
    "next",
    { t: "key", id: "nextWeek" },
    { keys: shownKeys("nextWeek") },
  );
  add(
    "toggleWeek",
    "palette.cmd.toggleWeek",
    "week",
    { t: "key", id: "toggleWeek" },
    { keys: shownKeys("toggleWeek") },
  );
  add("undo", "palette.cmd.undo", "undo", { t: "key", id: "undo" }, { keys: shownKeys("undo") });
  // 集中モード（D-097。ux-mvp 4.15）: 30分 / 1時間 / 次の予定の終わりまで / 終了（集中中だけ）
  const focusCmd = (id: string, label: MessageKey) =>
    add(id, label, "focus", { t: "key", id }, { keys: shownKeys(id) });
  focusCmd("focus30", "palette.cmd.focus30");
  focusCmd("focus60", "palette.cmd.focus60");
  if (i.focus?.eventAvailable) focusCmd("focusEvent", "palette.cmd.focusEvent");
  if (i.focus?.active) focusCmd("focusEnd", "palette.cmd.focusEnd");
  // 拡張のコマンド（ADR 0015。公開のビルドでは無い）
  for (const c of i.extCommands ?? ext.paletteCommands)
    add(`ext:${c.key}`, c.label, "action", { t: "ext", key: c.key });
  return out;
}

/** 入力から新規タスクを作る行（日付が読めなければ Inbox。ux-mvp 6.1） */
export function createRow(i: Pick<BuildInput, "q" | "t" | "today" | "shortDate">): Row | null {
  const raw = i.q.trim();
  if (raw === "") return null;
  const p = parseTask(raw, { today: i.today });
  if (p.title.trim() === "") return null;
  const date = p.inbox ? null : p.date;
  const meta = [
    date ? i.shortDate(date) : i.t("palette.cmd.createInbox"),
    p.estimateMin ? fmtDuration(p.estimateMin * 60_000) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return {
    id: "cmd:create",
    section: "commands",
    label: i.t("palette.cmd.createTask", { title: p.title }),
    meta,
    icon: { t: "glyph", name: "plus" },
    run: { t: "createTask", raw },
  };
}

function yourTurnRows(i: BuildInput): Row[] {
  return i.queue.slice(0, YOUR_TURN_TOP).flatMap((x): Row[] => {
    const f = primaryFollowUp(x);
    if (!f) return [];
    const status = x.status === "needs_input" || x.status === "error" ? x.status : "your_turn";
    return [
      {
        id: `turn:${x.workItemId}`,
        section: "yourTurn",
        label: i.titleOf(f.title),
        meta: whereName(x, i.t("ai.scratch")),
        right: x.waitStartedAway
          ? i.t("turn.since", { time: fmtClock(x.waitingSince, i.tz) })
          : fmtWait(i.now - x.waitingSince),
        keys: shownKeys("open"),
        icon: { t: "status", status, estimated: x.estimated },
        run: { t: "openTurn", followUpId: f.id },
        alt: { t: "panel", workItemId: x.workItemId },
      },
    ];
  });
}

function searchRows(i: BuildInput): { ai: Row[]; tasks: Row[]; events: Row[] } {
  const r = i.search;
  if (!r) return { ai: [], tasks: [], events: [] };
  const ai = r.aiItems.map(
    (x): Row => ({
      id: `ai:${x.id}`,
      section: "ai",
      label: x.title ?? x.branch ?? x.repo ?? (x.scratch ? i.t("ai.scratch") : ""),
      meta: [
        [x.repo ?? (x.scratch ? i.t("ai.scratch") : null), x.branch].filter(Boolean).join(" · "),
        x.prs.map((n) => `#${n}`).join(" "),
      ]
        .filter(Boolean)
        .join(" "),
      right: i.shortDate(x.date),
      icon: { t: "status", status: x.status, estimated: x.estimated },
      run: { t: "openAi", workItemId: x.id },
      alt: { t: "panel", workItemId: x.id },
    }),
  );
  const tasks = r.tasks.map(({ task }): Row => {
    const focus: Action = { t: "focusTask", taskId: task.id, date: task.scheduledDate };
    return {
      id: `task:${task.id}`,
      section: "tasks",
      label: i.titleOf(task.title),
      right: task.scheduledDate ? i.shortDate(task.scheduledDate) : i.t("palette.inbox"),
      icon: { t: "check", checked: task.status === "done" },
      done: task.status === "done",
      run: focus,
      // ⌘⏎ も同じ（タスクの詳細パネル。元の AI 項目へはパネルから行く。D-070）
      alt: focus,
    };
  });
  const events = r.events.map(
    (e): Row => ({
      id: `event:${e.id}`,
      section: "events",
      label: e.title ?? "",
      meta: e.allDay
        ? i.t("palette.allDay")
        : `${fmtClock(e.start, i.tz)}–${fmtClock(e.end, i.tz)}`,
      right: i.shortDate(e.date),
      icon: { t: "glyph", name: "event" },
      run: { t: "event", eventId: e.id, date: e.date },
      alt: { t: "event", eventId: e.id, date: e.date },
    }),
  );
  return { ai, tasks, events };
}

/** 一致する行だけを点数の順に（入力が空ならそのまま） */
function filterRows(rows: Row[], tokens: string[]): Row[] {
  if (tokens.length === 0) return rows;
  return rows
    .map((r, n) => ({ r, n, s: matchScore(r.hay ?? r.label, tokens) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => b.s - a.s || a.n - b.n)
    .map((x) => x.r);
}

export function buildSections(i: BuildInput): Section[] {
  const tokens = searchTokens(i.q);
  const empty = tokens.length === 0;
  const limit = i.category === "all" ? LIMIT_ALL : LIMIT_CATEGORY;
  const wanted = (id: SectionId) =>
    i.category === "all" ? true : SECTIONS_OF[i.category].includes(id);
  const sections: Section[] = [];
  const push = (id: SectionId, rows: Row[], max = limit) => {
    if (!wanted(id) || rows.length === 0) return;
    sections.push({
      id,
      rows: rows.slice(0, max),
      ...(id === "selected" ? { note: selectionTitle(i) } : {}),
    });
  };

  if (empty && i.category === "all") {
    push("selected", selectionRows(i), 20);
    push("yourTurn", yourTurnRows(i));
    const recent = i.recent.slice(0, RECENT_MAX);
    push(
      "recent",
      recent.map((r) => ({ ...r, id: `recent:${r.id}`, section: "recent" })),
    );
    // 最近に出したものは Go to に重ねて出さない
    push(
      "goto",
      screenRows(i).filter(
        (r) => EMPTY_GOTO.includes(r.id.slice(5)) && !recent.some((x) => x.id === r.id),
      ),
      EMPTY_GOTO.length,
    );
    return sections;
  }

  push("selected", filterRows(selectionRows(i), tokens), 20);
  push("goto", [...dateRows(i), ...filterRows(screenRows(i), tokens)]);
  const found = empty ? { ai: [], tasks: [], events: [] } : searchRows(i);
  push("ai", found.ai);
  push("tasks", found.tasks);
  push("events", found.events);
  // 日付だけの入力（`水曜`）はタスクにしない
  const create = empty || dateRows(i).length > 0 ? null : createRow(i);
  push("commands", [...filterRows(commandRows(i), tokens), ...(create ? [create] : [])], limit + 1);
  return sections;
}

/** 区分を並べた順の行（↑↓ の移動） */
export function flatRows(sections: readonly Section[]): Row[] {
  return sections.flatMap((s) => s.rows);
}

/** Tab / ⇧Tab でカテゴリを順に */
export function nextCategory(c: Category, dir: 1 | -1): Category {
  const n = CATEGORIES.length;
  const i = CATEGORIES.indexOf(c);
  return CATEGORIES[(i + dir + n) % n] as Category;
}

/** 最近に足す（同じ行は先頭へ。作成・時間に置くは入れない） */
export function pushRecent(list: readonly Row[], row: Row): Row[] {
  if (row.run.t === "createTask" || row.run.t === "place") return [...list];
  const base = row.id.startsWith("recent:") ? row.id.slice(7) : row.id;
  // 選んでいる項目への操作は、その時の対象を覚えない（次に開いたときの選択に効く）
  const clean: Row = { ...row, id: base, ...(row.section === "selected" ? { meta: null } : {}) };
  return [clean, ...list.filter((x) => x.id !== base)].slice(0, RECENT_MAX);
}

// ---------- 最近に保存した行の確かめ ----------

const STATUSES: readonly string[] = ["running", "needs_input", "your_turn", "done", "error"];
const LANGS: readonly string[] = ["en", "ja", "system"];
const THEMES: readonly string[] = ["light", "dark", "system"];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const isStr = (v: unknown): v is string => typeof v === "string";
const optStr = (v: unknown) => v === undefined || v === null || isStr(v);

function isIcon(v: unknown): v is Icon {
  if (!isObj(v)) return false;
  if (v.t === "glyph") return (GLYPH_NAMES as readonly unknown[]).includes(v.name);
  if (v.t === "status") return STATUSES.includes(v.status as string);
  if (v.t === "check") return typeof v.checked === "boolean";
  return false;
}

/** 今の版で実行できる Action か（画面の廃止・Action の廃止で古くなった行を落とす） */
function isAction(v: unknown): v is Action {
  if (!isObj(v)) return false;
  switch (v.t) {
    case "nav":
      return (
        (SCREEN_PATHS as readonly unknown[]).includes(v.to) &&
        optStr(v.date) &&
        optStr(v.hash) &&
        (v.record === undefined || typeof v.record === "boolean")
      );
    case "key":
      return isStr(v.id);
    case "ext":
    case "extTask":
      return isStr(v.key);
    case "openAi":
    case "panel":
      return isStr(v.workItemId);
    case "openTurn":
      return isStr(v.followUpId);
    case "focusTask":
      return isStr(v.taskId) && optStr(v.date);
    case "event":
      return isStr(v.eventId) && isStr(v.date);
    case "mode":
      return v.mode === "new" || v.mode === "place";
    case "theme":
      return THEMES.includes(v.value as string);
    case "lang":
      return LANGS.includes(v.value as string);
    case "rescan":
      return true;
    default:
      // createTask・place は最近に入れない（pushRecent）
      return false;
  }
}

/**
 * ブラウザに保存した「最近」の1行が、今の版で描けて実行できる形か。古い版が保存した行（廃止した画面・絵柄・Action）や
 * 壊れた値は落とす（そのまま描くと要素の型が undefined になってパレットごと落ちる）
 */
export function isRecentRow(v: unknown): v is Row {
  if (!isObj(v)) return false;
  return (
    isStr(v.id) &&
    isStr(v.label) &&
    optStr(v.meta) &&
    optStr(v.right) &&
    optStr(v.hay) &&
    (v.keys === undefined || (Array.isArray(v.keys) && v.keys.every(isStr))) &&
    (v.done === undefined || typeof v.done === "boolean") &&
    isIcon(v.icon) &&
    isAction(v.run) &&
    (v.alt === undefined || isAction(v.alt))
  );
}
