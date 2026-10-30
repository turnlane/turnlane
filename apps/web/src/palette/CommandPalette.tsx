/**
 * ⌘K のコマンドパレット（S14。M2-15。ux-mvp 6.1）。画像は作らず、確定済みの部品（行・Kbd・ステータスアイコン・mono のメタ）で組む。
 * - 検索（タスク・AI 項目・予定は /api/search、日付・画面・コマンドはクライアント）、選んでいる項目への操作、空入力の YOUR TURN 上位・最近・移動
 * - キーボードだけで完結: ↑↓（⌃n / ⌃p）、⏎、⌘⏎（詳細）、Tab / ⇧Tab（カテゴリ）、Esc。日本語入力の変換中の ⏎ は拾わない
 * - `p`（時間に置く）は空き枠の候補、New task は新規タスクの入力に、パレットの中で切り替わる
 * キーはパレットの入力欄で止め（stopPropagation）、画面のキーの処理に流さない。
 */

import { useNavigate } from "@tanstack/react-router";
import {
  fmtClock,
  fmtDuration,
  isInternalSource,
  matchRanges,
  PLACE_MAX,
  parseDateInput,
  parseTask,
  placeCandidates,
  searchTokens,
  type TaskView,
} from "@turnlane/core/web";
import { Clock, Plus, Search } from "lucide-react";
import {
  Component,
  type ErrorInfo,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ParsedChips } from "../board/editors.tsx";
import { titleText } from "../components/items.tsx";
import { StatusIcon } from "../components/StatusIcon.tsx";
import { Check, Kbd } from "../components/ui.tsx";
import { createTask, openTask, scheduleTask } from "../data/mutations.ts";
import { usePrefs, useSavePrefs } from "../data/prefs.tsx";
import {
  useDay,
  useFocus,
  useHealth,
  useQueue,
  useSearch,
  useSources,
  visibleQueue,
} from "../data/queries.ts";
import { currentToday } from "../data/sse.ts";
import { ext } from "../ext/registry.ts";
import { type MessageKey, translate, useI18n } from "../i18n/index.tsx";
import { keyLabel, useKeymapVersion } from "../keys/keymap.ts";
import { dispatchKey } from "../keys/use-keys.ts";
import { api } from "../lib/api.ts";
import { boardNav, dayNav } from "../lib/board-nav.ts";
import { useNow } from "../lib/clock.ts";
import { isImeKey } from "../lib/ime.ts";
import { getUi, type PaletteMode, setUi, toast, useUi } from "../lib/store.ts";
import { glyphOf } from "./glyphs.ts";
import {
  type Action,
  buildSections,
  CATEGORIES,
  type Category,
  createRow,
  flatRows,
  type Icon,
  LIMIT_ALL,
  LIMIT_CATEGORY,
  nextCategory,
  type Row,
  type Section,
} from "./model.ts";
import { readRecent, rememberRecent } from "./recent.ts";

const ASCII = /^[\x20-\x7e]*$/;

/** hooks の状態の強さ（同じツールの取り込み元が複数あるときは良い方を出す） */
const HOOK_RANK = ["receiving", "installed", "pending_trust", "silent", "none"];

export function CommandPalette() {
  const mode = useUi((s) => s.palette);
  const { t } = useI18n();
  if (!mode) return null;
  return (
    <PaletteBoundary key={mode} onError={() => toast(t("palette.toast.failed"))}>
      <Palette mode={mode} />
    </PaletteBoundary>
  );
}

/**
 * パレットの中の例外でアプリ全体（ルートのエラー画面）を落とさない: パレットを閉じて1行の知らせを出す。
 * 開き直すと新しく描く（key が mode なので、閉じて開けば境界ごと作り直す）
 */
class PaletteBoundary extends Component<
  { onError: () => void; children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error("command palette failed", error, info.componentStack);
    setUi({ palette: null });
    this.props.onError();
  }
  override render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

function Palette({ mode }: { mode: PaletteMode }) {
  const { t, locale, shortDate } = useI18n();
  const nav = useNavigate();
  const [q, setQ] = useState("");
  const [category, setCategory] = useState<Category>("all");
  const [active, setActive] = useState(0);
  const [accepted, setAccepted] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const selection = useUi((s) => s.selection);
  const queue = useQueue();
  const focusQ = useFocus();
  const prefs = usePrefs();
  const save = useSavePrefs();
  const sources = useSources();
  const health = useHealth();
  const now = useNow();
  const today = useUi((s) => s.serverToday) ?? currentToday() ?? "";
  const tz = queue.data?.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [recent] = useState(readRecent);

  // 検索は入力から 120ms 待つ（m2-api.md 17章）
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const id = setTimeout(() => setDebounced(q), 120);
    return () => clearTimeout(id);
  }, [q]);
  const searching = mode === "root" && category !== "commands" && category !== "goto";
  const search = useSearch(
    searching ? debounced : "",
    category === "all" ? LIMIT_ALL : LIMIT_CATEGORY,
  );

  useEffect(() => {
    // WKWebView でも確実にフォーカスを移す（描画の後）
    const id = setTimeout(() => input.current?.focus(), 0);
    return () => clearTimeout(id);
  }, []);

  const hooksText = useMemo(() => {
    const xs = (sources.data?.sources ?? []).filter((x) => x.enabled && !isInternalSource(x.tool));
    if (xs.length === 0) return sources.data ? t("palette.hooks.noSources") : null;
    const byTool = new Map<string, string>();
    for (const x of xs) {
      const cur = byTool.get(x.tool);
      if (!cur || HOOK_RANK.indexOf(x.hooksState) < HOOK_RANK.indexOf(cur))
        byTool.set(x.tool, x.hooksState);
    }
    return [...byTool]
      .map(([tool, st]) => {
        const k = `sources.tool.${tool}` as MessageKey;
        const name = t(k) === k ? tool : t(k);
        const sk = `palette.hooks.${st}` as MessageKey;
        return `${name} ${t(sk) === sk ? st : t(sk)}`;
      })
      .join(" · ");
  }, [sources.data, t]);
  const calendarText = useMemo(() => {
    const c = health.data?.calendarHelper;
    if (!c) return null;
    return t(
      c.connected && c.authorization === "fullAccess"
        ? "palette.cal.ok"
        : c.connected
          ? "palette.cal.noAccess"
          : "palette.cal.off",
    );
  }, [health.data, t]);

  const placeTask: TaskView | null =
    mode === "place"
      ? ((selection.find((x) => x.kind === "task") as { task: TaskView } | undefined)?.task ?? null)
      : null;

  // キーの割り当ての変更で行のキーを出し直す（D-077）
  const keymapVersion = useKeymapVersion();
  const sections: Section[] = useMemo(() => {
    void keymapVersion;
    if (mode === "new") {
      const row = createRow({ q, t, today, shortDate });
      return row ? [{ id: "new", rows: [{ ...row, section: "new" }] }] : [];
    }
    if (mode === "place") return [];
    return buildSections({
      q,
      category,
      t,
      tEn: (k, p) => translate("en", k, p),
      shortDate,
      titleOf: (x) => titleText(x, locale),
      today,
      now,
      tz,
      selection,
      queue: visibleQueue(queue.data?.items),
      recent,
      search: q.trim() && debounced.trim() ? search.data : undefined,
      theme: prefs.theme,
      language: prefs.language,
      hooksText,
      calendarText,
      focus: focusQ.data
        ? { active: focusQ.data.active !== null, eventAvailable: focusQ.data.nextEventEnd !== null }
        : null,
    });
  }, [
    keymapVersion,
    mode,
    q,
    category,
    t,
    shortDate,
    locale,
    today,
    now,
    tz,
    selection,
    queue.data,
    recent,
    debounced,
    search.data,
    prefs.theme,
    prefs.language,
    hooksText,
    calendarText,
    focusQ.data,
  ]);

  const place = usePlaceRows(placeTask, q, today, now);
  const shown = mode === "place" ? place.sections : sections;
  const rows = flatRows(shown);
  const cur = Math.min(active, Math.max(0, rows.length - 1));

  // 入力・カテゴリが変わったら先頭を選ぶ
  // biome-ignore lint/correctness/useExhaustiveDependencies: 入力とカテゴリの変化だけで戻す
  useEffect(() => setActive(0), [q, category]);
  useEffect(() => {
    list.current
      ?.querySelector<HTMLElement>(`[data-row-index="${cur}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [cur]);

  const close = () => setUi({ palette: null });

  const exec = (a: Action, row: Row | null) => {
    if (row && mode === "root") rememberRecent(row);
    switch (a.t) {
      case "mode":
        if (a.mode === "place" && !getUi().selection.some((x) => x.kind === "task")) {
          toast(t("palette.toast.noSelection"));
          return;
        }
        setUi({ palette: a.mode });
        return;
      case "openAi":
        // クリップボードへのコピーは操作の中で始める（WebKit。openTask の注）
        close();
        void openTask({ workItemId: a.workItemId });
        return;
      case "openTurn":
        close();
        void openTask({ followUpId: a.followUpId });
        return;
      case "panel":
        close();
        setUi({ panelWorkItemId: a.workItemId });
        return;
      case "nav":
        close();
        if (a.to === "/day") {
          if (a.date === null) dayNav.today();
          else if (a.date) dayNav.set(a.date);
          // 記録（D-192）: 日の画面で既に開いていれば閉じない
          if (a.record) setUi({ recordOpen: true });
        }
        if (a.to === "/board") {
          if (a.date === null) boardNav.today();
          else if (a.date) boardNav.set(a.date);
        }
        void nav(a.hash ? { to: a.to, hash: a.hash } : { to: a.to });
        return;
      case "focusTask":
        close();
        setUi({ focus: { key: `task:${a.taskId}`, date: a.date }, panelTaskId: a.taskId });
        if (a.date) {
          boardNav.set(a.date);
          void nav({ to: "/board" });
        } else void nav({ to: "/inbox" });
        return;
      case "event":
        close();
        dayNav.set(a.date);
        setUi({ panelEventId: a.eventId });
        void nav({ to: "/day" });
        return;
      case "key":
        close();
        // パレットを閉じてから画面の処理へ（ポップオーバーの位置とフォーカスのため次の描画の後）
        setTimeout(() => {
          if (!dispatchKey(a.id)) toast(t("palette.toast.noSelection"));
        }, 0);
        return;
      case "createTask":
        close();
        void createTask({ raw: a.raw, date: null });
        return;
      case "place": {
        close();
        const task = placeTask;
        if (task) void scheduleTask(task, a.date, { start: a.start, end: a.end });
        return;
      }
      case "theme":
        close();
        save.mutate({ theme: a.value });
        return;
      case "lang":
        close();
        save.mutate({ language: a.value });
        return;
      case "rescan":
        close();
        toast(t("palette.toast.rescan"));
        void api.api.sources.rescan.$post();
        return;
      case "ext": {
        close();
        ext.paletteCommands.find((c) => c.key === a.key)?.run();
        return;
      }
      case "extTask": {
        close();
        // 対象は今の選択（最近から選んだときも。右クリックと同じく1件・未完了・when を満たすものだけ）
        const sel = getUi().selection;
        const only = sel.length === 1 && sel[0]?.kind === "task" ? sel[0].task : null;
        const item = ext.taskMenuItems.find((x) => x.key === a.key);
        if (!only || !item || only.status === "done" || (item.when && !item.when(only))) {
          toast(t("palette.toast.noSelection"));
          return;
        }
        // パレットを閉じてから（ポップオーバーの位置とフォーカスのため次の描画の後。key と同じ）
        setTimeout(
          () =>
            item.run(
              only,
              document.querySelector<HTMLElement>(
                `[data-kind="task"][data-id="${CSS.escape(only.id)}"]`,
              ),
            ),
          0,
        );
        return;
      }
    }
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    // 画面のキーの処理（window）に流さない
    e.stopPropagation();
    if (isImeKey(e)) return;
    const k = e.key;
    const ctrl = e.ctrlKey && !e.metaKey;
    if (k === "Escape" || ((e.metaKey || e.ctrlKey) && k.toLowerCase() === "k")) {
      e.preventDefault();
      close();
    } else if (k === "ArrowDown" || (ctrl && k === "n")) {
      e.preventDefault();
      setActive(rows.length === 0 ? 0 : (cur + 1) % rows.length);
    } else if (k === "ArrowUp" || (ctrl && k === "p")) {
      e.preventDefault();
      setActive(rows.length === 0 ? 0 : (cur - 1 + rows.length) % rows.length);
    } else if (k === "Enter") {
      e.preventDefault();
      const row = rows[cur];
      if (!row) return;
      exec(e.metaKey || e.ctrlKey ? (row.alt ?? row.run) : row.run, row);
    } else if (k === "Tab") {
      e.preventDefault();
      if (mode === "root") setCategory((c) => nextCategory(c, e.shiftKey ? -1 : 1));
      else if (mode === "new") setAccepted(true);
    } else if (mode === "place" && q === "" && /^[1-9]$/.test(k)) {
      const row = rows[Number(k) - 1];
      if (row) {
        e.preventDefault();
        exec(row.run, row);
      }
    }
  };

  const tokens = mode === "root" ? searchTokens(q) : [];
  const placeholder: MessageKey =
    mode === "new"
      ? "palette.placeholder.new"
      : mode === "place"
        ? "palette.placeholder.place"
        : "palette.placeholder";
  const pending = mode === "root" && q.trim() !== "" && (debounced !== q || search.isFetching);
  let index = 0;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: 背景のクリックで閉じる
    <div
      className="fixed inset-0 z-40 flex items-start justify-center bg-black/50 pt-24"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
      data-testid="palette-backdrop"
    >
      <div
        role="dialog"
        aria-label={t("palette.label")}
        aria-modal="true"
        className="flex max-h-[70vh] w-[640px] max-w-[90vw] flex-col overflow-hidden rounded-pop border border-line bg-raised shadow-pop"
        data-testid="command-palette"
      >
        <div className="flex h-11 shrink-0 items-center gap-2 border-line border-b px-3">
          {mode === "new" ? (
            <Plus size={16} strokeWidth={1.5} className="text-fg3" aria-hidden="true" />
          ) : mode === "place" ? (
            <Clock size={16} strokeWidth={1.5} className="text-fg3" aria-hidden="true" />
          ) : (
            <Search size={16} strokeWidth={1.5} className="text-fg3" aria-hidden="true" />
          )}
          <input
            ref={input}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setAccepted(false);
            }}
            onKeyDown={onKeyDown}
            placeholder={t(placeholder)}
            aria-label={t(placeholder)}
            aria-controls="palette-list"
            aria-activedescendant={rows[cur] ? `palette-row-${cur}` : undefined}
            role="combobox"
            aria-expanded="true"
            spellCheck={false}
            autoComplete="off"
            className="h-full min-w-0 flex-1 bg-transparent text-body outline-none placeholder:text-fg3"
            // 入力欄は枠で囲まない（全体の :focus-visible の枠はパレットでは重い）
            style={{ outline: "none" }}
            data-testid="palette-input"
          />
          <Kbd>esc</Kbd>
        </div>
        {mode === "root" ? (
          <div className="flex shrink-0 items-center gap-1 border-line border-b px-3 py-1.5">
            {CATEGORIES.map((c) => (
              <button
                key={c}
                type="button"
                tabIndex={-1}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setCategory(c)}
                className={`h-5 rounded-chip px-2 text-meta ${
                  c === category ? "bg-accent/15 text-fg" : "text-fg3 hover:text-fg2"
                }`}
                data-active={c === category}
              >
                {t(`palette.cat.${c}` as MessageKey)}
              </button>
            ))}
          </div>
        ) : null}
        {mode === "place" && place.header ? (
          <div className="shrink-0 truncate border-line border-b px-4 py-2 text-meta text-fg2">
            {place.header}
          </div>
        ) : null}
        {mode === "new" && q.trim() ? (
          <div className="shrink-0 border-line border-b px-4 py-2">
            <ParsedChips parsed={parseTask(q, { today })} fallbackDate={null} accepted={accepted} />
          </div>
        ) : null}
        <div
          ref={list}
          id="palette-list"
          role="listbox"
          className="min-h-0 flex-1 overflow-y-auto p-1.5"
        >
          {shown.map((s) => (
            <section
              key={s.id}
              className="mb-1"
              aria-label={t(`palette.sec.${s.id}` as MessageKey)}
            >
              <h3 className="flex min-w-0 gap-2 px-2.5 pt-1.5 pb-1 text-micro text-fg3">
                <span className="shrink-0 uppercase tracking-wide">
                  {t(`palette.sec.${s.id}` as MessageKey)}
                </span>
                {s.note ? <span className="min-w-0 truncate text-fg2">{s.note}</span> : null}
              </h3>
              {s.rows.map((r) => {
                const i = index++;
                return (
                  <PaletteRow
                    key={r.id}
                    row={r}
                    index={i}
                    active={i === cur}
                    tokens={tokens}
                    onHover={() => setActive(i)}
                    onRun={(alt) => exec(alt ? (r.alt ?? r.run) : r.run, r)}
                  />
                );
              })}
            </section>
          ))}
          {rows.length === 0 ? (
            <p className="px-3 py-6 text-center text-body text-fg3" data-testid="palette-empty">
              {mode === "place"
                ? place.empty
                : pending
                  ? t("palette.searching")
                  : q.trim() === "" && category !== "all"
                    ? t("palette.placeholder")
                    : t("palette.empty")}
            </p>
          ) : null}
        </div>
        <footer className="flex h-8 shrink-0 items-center gap-4 border-line border-t px-3 text-micro text-fg3">
          <FootKey k="↑↓" label={t("palette.foot.move")} />
          <FootKey k="⏎" label={t("palette.foot.run")} />
          {mode === "root" ? <FootKey k="⌘⏎" label={t("palette.foot.details")} /> : null}
          {mode === "root" ? <FootKey k="Tab" label={t("palette.foot.filter")} /> : null}
          {mode === "place" ? (
            <FootKey k={`1–${PLACE_MAX}`} label={t("palette.foot.pick")} />
          ) : null}
          <span className="flex-1" />
          <FootKey k="esc" label={t("palette.foot.close")} />
        </footer>
      </div>
    </div>
  );
}

function FootKey({ k, label }: { k: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <Kbd>{k}</Kbd>
      <span>{label}</span>
    </span>
  );
}

function PaletteRow({
  row,
  index,
  active,
  tokens,
  onHover,
  onRun,
}: {
  row: Row;
  index: number;
  active: boolean;
  tokens: string[];
  onHover: () => void;
  onRun: (alt: boolean) => void;
}) {
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: キーは入力欄で受ける（aria-activedescendant）
    <div
      id={`palette-row-${index}`}
      role="option"
      tabIndex={-1}
      aria-selected={active}
      data-row-index={index}
      data-row-id={row.id}
      onMouseMove={onHover}
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => onRun(e.metaKey || e.ctrlKey)}
      className={`flex h-8 cursor-default items-center gap-2.5 rounded-card px-2.5 text-body ${
        active ? "bg-bg shadow-[inset_0_0_0_1.5px_var(--dl-accent)]" : ""
      }`}
    >
      <RowIcon icon={row.icon} />
      <span className={`min-w-0 flex-1 truncate ${row.done ? "text-fg3 line-through" : "text-fg"}`}>
        <Highlight text={row.label} tokens={tokens} />
      </span>
      {row.meta ? (
        <span className="max-w-[45%] shrink truncate font-mono text-meta text-fg3">
          <Highlight text={row.meta} tokens={tokens} />
        </span>
      ) : null}
      {row.right ? (
        // 日付は UI フォントで描く（日本語の全角括弧を等幅に混ぜない。C2）
        <span className={`shrink-0 text-meta text-fg2 ${ASCII.test(row.right) ? "font-mono" : ""}`}>
          {row.right}
        </span>
      ) : null}
      {row.keys && row.keys.length > 0 ? (
        <span className="flex shrink-0 gap-1">
          {row.keys.map((k) => (
            <Kbd key={k}>{keyLabel(k)}</Kbd>
          ))}
        </span>
      ) : null}
    </div>
  );
}

function RowIcon({ icon }: { icon: Icon }) {
  if (icon.t === "status")
    return <StatusIcon status={icon.status} estimated={icon.estimated} size={14} />;
  if (icon.t === "check")
    return (
      <span className="pointer-events-none inline-flex">
        <Check checked={icon.checked} label="" />
      </span>
    );
  const G = glyphOf(icon.name);
  return <G size={14} strokeWidth={1.5} className="shrink-0 text-fg3" aria-hidden="true" />;
}

/** 一致した文字を太字に（色は付けない。デザイン案 (10)） */
function Highlight({ text, tokens }: { text: string; tokens: string[] }): ReactNode {
  if (tokens.length === 0) return text;
  const rs = matchRanges(text, tokens);
  if (rs.length === 0) return text;
  const out: ReactNode[] = [];
  let at = 0;
  for (const [a, b] of rs) {
    if (a > at) out.push(text.slice(at, a));
    out.push(
      <b key={a} className="font-semibold">
        {text.slice(a, b)}
      </b>,
    );
    at = b;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

/**
 * 時間に置く（`p`）の候補（ux-mvp 6.1）: 対象の日（入力の日付 → タスクの日付 → 今日）の空き枠から、見積（無ければ30分）が
 * 入る開始時刻を最大9件
 */
function usePlaceRows(
  task: TaskView | null,
  q: string,
  today: string,
  now: number,
): { sections: Section[]; header: string | null; empty: string } {
  const { t, shortDate, locale } = useI18n();
  const typed = q.trim() ? parseDateInput(q, { today }) : undefined;
  const base = task?.scheduledDate && task.scheduledDate >= today ? task.scheduledDate : today;
  const date = typeof typed === "string" && typed >= today ? typed : base;
  const day = useDay(date, task !== null);
  const tz = day.data?.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const durMs = (task?.estimateMin ?? 30) * 60_000;
  const dur = fmtDuration(durMs);
  if (!task) return { sections: [], header: null, empty: t("palette.toast.noSelection") };
  const header = `${t("palette.place.title", { title: titleText(task.title, locale), dur })} · ${shortDate(date)}`;
  const slots = day.data?.day.date === date ? day.data.day.freeSlots : [];
  const cands = placeCandidates(slots, durMs, date === today ? now : null);
  const rows: Row[] = cands.map((c, n) => ({
    id: `place:${date}:${c.start}`,
    section: "place",
    label: `${fmtClock(c.start, tz)}–${fmtClock(c.end, tz)}`,
    meta: shortDate(date),
    keys: [String(n + 1)],
    icon: { t: "glyph", name: "clock" },
    run: { t: "place", taskId: task.id, date, start: c.start, end: c.end },
  }));
  return {
    sections: rows.length > 0 ? [{ id: "place", rows }] : [],
    header,
    empty: day.isPending
      ? t("common.loading")
      : t("palette.place.none", { dur, date: shortDate(date) }),
  };
}
