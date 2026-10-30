/**
 * 画面の外枠（M2-1。ux-mvp 2章。確定デザイン: 3日ボード v2 のサイドバーと上部バー）。
 * サイドバー: 自分の番［件数］・Inbox / ボード / プロジェクト・取り込み・設定（今日・日報・朝の計画・一日を閉じるは D-192・D-193 で消した）。
 * ⌘\ で 56px のアイコンの列に畳む。上部バー: 前後・今日・日付・3日 / 週 / 日（D-074）・＋ 新規・検索 ⌘K・自分の番の件数。
 * AI activity と Weekly review は v1 なのでサイドバーに出さない。
 */

import { Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { isInternalSource, type QueueItem } from "@turnlane/core/web";
import type { SourceView } from "@turnlane/daemon";
import {
  Bot,
  CalendarPlus,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleArrowRight,
  CircleCheck,
  Columns3,
  Folder,
  Inbox,
  type LucideIcon,
  NotebookText,
  PanelLeft,
  Plus,
  Search,
  Settings,
  TriangleAlert,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { AiHoverLayer } from "../components/AiHoverCard.tsx";
import { FocusBar } from "../components/FocusBar.tsx";
import { clientName } from "../components/items.tsx";
import { MiniCalendar } from "../components/MiniCalendar.tsx";
import { TooltipLayer, tipProps } from "../components/Tooltip.tsx";
import { UpdateBar } from "../components/UpdateBar.tsx";
import { Button, MenuItem, Popover } from "../components/ui.tsx";
import {
  useHealth,
  useInbox,
  useProjects,
  useQueue,
  useSources,
  visibleQueue,
} from "../data/queries.ts";
import type { ConnState } from "../data/sse.ts";
import { onSse } from "../data/sse.ts";
import { RAIL_CELL, SidebarMode } from "../ext/parts.tsx";
import { ext } from "../ext/registry.ts";
import { type MessageKey, useI18n, useT } from "../i18n/index.tsx";
import { KeyHelp } from "../keys/KeyHelp.tsx";
import { keyHint, useKeymapVersion } from "../keys/keymap.ts";
import { dispatchKey, useGlobalKeys } from "../keys/use-keys.ts";
import { FinishSheet } from "../launch/FinishSheet.tsx";
import { ApiError, api } from "../lib/api.ts";
import { boardNav, dayNav, todayOrSystem } from "../lib/board-nav.ts";
import { useFitSteps } from "../lib/fit.ts";
import { markShell } from "../lib/open.ts";
import { PanelsAvailable } from "../lib/panels.ts";
import { type BoardMode, dismissToast, setBoardMode, setUi, toast, useUi } from "../lib/store.ts";
import { useNotifications } from "../notify/use-notifications.ts";
import { CommandPalette } from "../palette/CommandPalette.tsx";
import { AiPanel } from "../panel/AiPanel.tsx";
import { EventPanel } from "../panel/EventPanel.tsx";
import { RecordPanel } from "../panel/RecordPanel.tsx";
import { TaskPanel } from "../panel/TaskPanel.tsx";
import { useAiSummary } from "../routes/AiPage.tsx";
import {
  type CalendarNotice,
  calendarNotice,
  type SourcesNotice,
  sourcesNotice,
} from "./sources-notice.ts";

export function AppShell({ conn }: { conn: ConnState }) {
  const collapsed = useUi((s) => s.sidebarCollapsed);
  const queue = useQueue();
  useGlobalKeys();
  useNotifications(queue.data);
  useMcpToasts();
  // 拡張の openAiPanel: 枠の中ならその場でパネルを開く
  useEffect(() => markShell(), []);
  const unauthorized = queue.error instanceof ApiError && queue.error.status === 401;
  const items = visibleQueue(queue.data?.items);
  // 確定デザイン: 左にウインドウの高さいっぱいのサイドバー（220px、⌘\ で 56px のアイコンの列に畳む）、右に上部バーと画面
  return (
    <div className="flex h-full bg-bg text-fg">
      {collapsed ? <Rail queue={items} /> : <Sidebar queue={items} />}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <TopBar queue={items} />
        {unauthorized ? <Banner tone="error" k="banner.unauthorized" /> : null}
        {conn === "down" && !unauthorized ? <Banner tone="error" k="banner.daemonDown" /> : null}
        <FocusBar where="shell" />
        <UpdateBar />
        <div className="flex min-h-0 flex-1">
          <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">
            <PanelsAvailable.Provider value={true}>
              <Outlet />
            </PanelsAvailable.Provider>
          </main>
          <AiPanel />
          <TaskPanel />
          <EventPanel />
          {/* 記録のパネル（D-192）: デイビューだけ。詳細パネルと同じ場所に排他で開く */}
          <RecordPanel />
        </div>
      </div>
      <Toasts />
      <KeyHelp />
      <CommandPalette />
      <FinishSheet />
      <TooltipLayer />
      <AiHoverLayer />
    </div>
  );
}

function Banner({ tone, k }: { tone: "error"; k: MessageKey }) {
  const t = useT();
  return (
    <div
      role="alert"
      className={`flex h-7 items-center border-line border-b px-4 text-meta ${tone === "error" ? "text-error" : ""}`}
    >
      {t(k)}
    </div>
  );
}

/**
 * 自分の番の件数（自分の番の画面のレビュー「実装で直すこと」1）: 「自分の番 N」は常にブロック中・エラーを含む合計。
 * 上部・サイドバー・メニューバー・一覧の見出しで同じ数え方にする
 */
export function turnCounts(queue: readonly QueueItem[]): {
  total: number;
  blocked: number;
  error: number;
} {
  return {
    total: queue.length,
    blocked: queue.filter((x) => x.status === "needs_input").length,
    error: queue.filter((x) => x.status === "error").length,
  };
}

/** 上部の日付の見出し（`10月2日（金）` / `Fri, Oct 2`） */
export function longDate(date: string, locale: "en" | "ja"): string {
  const d = new Date(`${date}T12:00:00Z`);
  if (locale === "ja") {
    const wd = new Intl.DateTimeFormat("ja-JP", { weekday: "short", timeZone: "UTC" }).format(d);
    return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日（${wd}）`;
  }
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(d);
}

function AiTitleAside() {
  const text = useAiSummary();
  if (!text) return null;
  return (
    <span className="min-w-0 shrink truncate text-fg2 text-meta" data-testid="ai-summary">
      {text}
    </span>
  );
}

const PAGE_TITLE: Record<string, MessageKey> = {
  "/queue": "nav.yourTurn",
  "/inbox": "nav.inbox",
  "/ai": "nav.ai",
};

/**
 * 上部バー（52px。確定デザイン）: ボード・デイビューは ‹ › 今日・日付（押すと日付を選ぶ）・3日 / 週 / 日。自分の番の画面と Inbox は
 * 題名と数の丸（Inbox のレビュー v1）。
 * 右に「＋ 新規 ▾」（無彩色の主ボタン）・検索・自分の番の件数（言葉付き）。
 * 折り返さない。入らないときは次の順に省く（B-1 (1)。はみ出したら 1 つ省いて測り直す。固定の px の閾値は置かない）:
 * 1 日付の曜日 → 2 件数の括弧の中 → 3 検索の文字とキー → 4 「新規」の文字 → 5 件数の語
 */
function TopBar({ queue }: { queue: QueueItem[] }) {
  const { t, dayLabel, locale } = useI18n();
  const nav = useNavigate();
  const barRef = useRef<HTMLElement>(null);
  const omit = useFitSteps(barRef, 5);
  // ツールチップと ⌘K のキーは今の割り当て（D-077）
  useKeymapVersion();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const anchor = useUi(() => boardNav.anchor());
  const dayDate = useUi(() => dayNav.date());
  const mode = useUi((s) => s.boardMode);
  const range = useUi((s) => s.boardRange);
  const [pick, setPick] = useState<HTMLElement | null>(null);
  // デイビューでは前後が1日ずつ、期間の表示が日付になる。3日ボードは1稼働日ずつで期間は基準日、週表示は1週ずつ（D-074）
  const onDay = path === "/day";
  const onBoard = path === "/board";
  // 日付送り・今日・期間・3日 / 週 / 日 はボードとデイビューだけ（キュー・Inbox・設定・日報では出さない。U-17）
  const dated = onDay || onBoard;
  const c = turnCounts(queue);
  const title = PAGE_TITLE[path];
  // 拡張の画面の題名（ADR 0015。枠の中の経路の title）
  const extRoute = title
    ? undefined
    : ext.routes.find((r) => r.chrome !== "bare" && r.title && r.path === path.replace(/\/$/, ""));
  const ExtAside = extRoute?.titleAside;
  const inboxCount = useInbox().data?.tasks.length;
  const count = path === "/queue" ? c.total : path === "/inbox" ? inboxCount : undefined;
  const seg = (on: boolean) =>
    `flex h-6 items-center rounded-control px-2.5 font-medium text-meta ${
      on
        ? "bg-raised text-fg shadow-[0_1px_2px_rgb(0_0_0/0.08),0_0_0_1px_var(--dl-border)]"
        : "text-fg2 hover:text-fg"
    }`;
  return (
    <header
      ref={barRef}
      className="flex h-[52px] shrink-0 items-center gap-2 overflow-hidden whitespace-nowrap border-line border-b px-4"
      data-omit={omit}
    >
      {dated ? (
        <>
          <IconButton
            icon={ChevronLeft}
            label={t("top.prev")}
            boxed
            onClick={() => (onDay ? dayNav.shift(-1) : boardNav.step(-1))}
          />
          <IconButton
            icon={ChevronRight}
            label={t("top.next")}
            boxed
            onClick={() => (onDay ? dayNav.shift(1) : boardNav.step(1))}
          />
          <Button onClick={() => (onDay ? dayNav.today() : boardNav.today())}>
            {t("top.today")}
          </Button>
          <button
            type="button"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => setPick(pick ? null : e.currentTarget)}
            // 曜日を省いたらツールチップに
            title={
              omit >= 1 && (onDay || mode === "three")
                ? `${longDate(onDay ? dayDate : anchor, locale)} · ${t("top.pickDate")}`
                : t("top.pickDate")
            }
            className="ml-1 flex h-9 shrink-0 items-center gap-1 rounded-card px-1.5 font-semibold text-title hover:bg-sunken"
            data-testid="period"
          >
            {onDay || mode === "three"
              ? omit >= 1
                ? dayLabel(onDay ? dayDate : anchor).date
                : longDate(onDay ? dayDate : anchor, locale)
              : // 週表示は昨日からの7日（D-074）。見出しも中身の日付の範囲にする（D-101 (3)）
                rangeLabel(range, anchor, (d) => dayLabel(d).date)}
            <ChevronDown size={16} strokeWidth={1.5} className="text-fg2" aria-hidden="true" />
          </button>
          {pick ? (
            <Popover anchor={pick} onClose={() => setPick(null)}>
              <MiniCalendar
                value={onDay ? dayDate : anchor}
                today={todayOrSystem()}
                onPick={(v) => {
                  if (onDay) dayNav.set(v);
                  else boardNav.set(v);
                  setPick(null);
                  pick.focus();
                }}
              />
            </Popover>
          ) : null}
          <div className="ml-2 flex shrink-0 items-center gap-0.5 rounded-card bg-sunken p-0.5">
            {(["three", "week"] as BoardMode[]).map((m) => (
              <button
                key={m}
                type="button"
                data-testid={`mode-${m}`}
                onClick={() => {
                  setBoardMode(m);
                  if (!onBoard) void nav({ to: "/board" });
                }}
                title={`${t(m === "three" ? "keys.viewThree" : "keys.viewWeek")} · ${keyHint(m === "three" ? "viewThree" : "viewWeek")}`}
                className={seg(onBoard && mode === m)}
              >
                {t(m === "three" ? "top.three" : "top.week")}
              </button>
            ))}
            <Link
              to="/day"
              title={`${t("keys.viewDay")} · ${keyHint("viewDay")}`}
              className={seg(onDay)}
            >
              {t("top.day")}
            </Link>
          </div>
        </>
      ) : title ? (
        <h1 className="flex items-center gap-2 font-semibold text-title" data-testid="page-title">
          {t(title)}
          {count !== undefined ? (
            <span
              className="rounded-full bg-sunken px-2 font-mono font-medium text-fg2 text-meta"
              data-testid="page-count"
            >
              {count}
            </span>
          ) : null}
        </h1>
      ) : null}
      {/* AI の画面: 題名の右に `動いている 3 · 止まっている 2`（入らなければ先に縮んで消える） */}
      {path === "/ai" ? <AiTitleAside /> : null}
      {title ? null : extRoute?.title ? (
        <h1 className="flex items-center gap-2 font-semibold text-title" data-testid="page-title">
          {t(extRoute.title)}
          {ExtAside ? <ExtAside /> : null}
        </h1>
      ) : null}
      <div className="min-w-0 flex-1" />
      {/* 記録（D-192 §3.1、D-221）: デイビュー・3日ボード・週表示。押すと右のパネル、開いている間は沈んだ面、もう一度押すと閉じる */}
      {onDay || onBoard ? <RecordButton /> : null}
      <NewButton compact={omit >= 4} />
      {omit >= 3 ? (
        <IconButton
          icon={Search}
          label={t("top.search")}
          keys={keyHint("search")}
          onClick={() => setUi({ palette: "root", helpOpen: false })}
        />
      ) : (
        <button
          type="button"
          onClick={() => setUi({ palette: "root", helpOpen: false })}
          data-testid="open-palette"
          className="flex h-7 w-[180px] shrink-0 items-center gap-1.5 rounded-card border border-line bg-raised px-2.5 text-body text-fg3 hover:border-fg3"
        >
          <Search size={16} strokeWidth={1.5} aria-hidden="true" />
          <span className="flex-1 text-left">{t("top.searchShort")}</span>
          {keyHint("search") ? (
            <span className="font-mono text-micro">{keyHint("search")}</span>
          ) : null}
        </button>
      )}
      {/* 自分の番の件数（ブロック中・エラーを含む合計と、その内訳）。押すと自分の番の画面。括弧の中・語は省けたらツールチップへ */}
      {c.total > 0 ? (
        <Link
          to="/queue"
          className="flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-line bg-raised px-2.5 text-fg text-meta hover:border-fg3"
          title={[
            t("top.countHint", { label: t("nav.yourTurn"), count: c.total }),
            omit >= 2 && c.blocked > 0 ? `${c.blocked} ${t("status.needs_input")}` : null,
            omit >= 2 && c.error > 0 ? `${c.error} ${t("status.error")}` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
          data-testid="count-turn"
        >
          {omit >= 5 ? (
            <CircleArrowRight size={14} strokeWidth={1.5} className="text-fg2" aria-hidden="true" />
          ) : (
            <span
              className={`size-2 shrink-0 rounded-full ${c.blocked > 0 ? "bg-needs" : c.error > 0 ? "bg-error" : "bg-turn"}`}
              aria-hidden="true"
            />
          )}
          <b className="font-mono font-semibold">{c.total}</b>
          {omit >= 5 ? null : <span>{t("nav.yourTurn")}</span>}
          {omit < 2 && c.blocked + c.error > 0 ? (
            <span className="text-fg2">
              {t("top.of")}
              {c.blocked > 0 ? (
                <span data-testid="count-needs_input">
                  <span className="font-mono">{c.blocked}</span> {t("status.needs_input")}
                </span>
              ) : null}
              {c.blocked > 0 && c.error > 0 ? " · " : null}
              {c.error > 0 ? (
                <span data-testid="count-error">
                  <span className="font-mono">{c.error}</span> {t("status.error")}
                </span>
              ) : null}
              {t("top.ofEnd")}
            </span>
          ) : null}
        </Link>
      ) : null}
    </header>
  );
}

function RecordButton() {
  const { t } = useI18n();
  const open = useUi((s) => s.recordOpen);
  return (
    <button
      type="button"
      onClick={() => setUi({ recordOpen: !open })}
      aria-pressed={open}
      data-testid="open-record"
      title={`${t("keys.goRecord")} · ${keyHint("goRecord")}`}
      className={`flex h-7 items-center gap-1.5 rounded-card px-2.5 text-body ${
        open ? "bg-sunken text-fg" : "text-fg2 hover:bg-sunken hover:text-fg"
      }`}
    >
      <NotebookText size={16} strokeWidth={1.5} aria-hidden="true" />
      {t("nav.record")}
    </button>
  );
}

/**
 * 上部の「＋ 新規 ▾」（UX 監査 A5・U-03）: タスク / 予定。画面の `c` / `⇧C` の処理に渡す（ボード・デイビューは選んでいる列の日、
 * Inbox は Inbox）。タスクを受ける画面が無ければ ⌘K の新規タスクの入力、予定は今日のデイビューで開く（D-093）
 */
function NewButton({ compact = false }: { compact?: boolean }) {
  const { t } = useI18n();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const pick = (as: "task" | "event") => {
    setAnchor(null);
    // メニューを閉じてから（入力欄の位置とフォーカスのため次の描画の後）
    setTimeout(() => {
      if (as === "event") dispatchKey("newEvent");
      else if (!dispatchKey("new")) setUi({ palette: "new", helpOpen: false });
    }, 0);
  };
  return (
    <>
      <button
        type="button"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        data-testid="new-button"
        title={compact ? t("top.new") : undefined}
        className="flex h-7 shrink-0 items-center gap-1.5 rounded-card bg-accent px-2.5 font-medium text-body text-onaccent hover:opacity-90"
      >
        <Plus size={16} strokeWidth={1.5} aria-hidden="true" />
        {compact ? null : t("top.new")}
        <ChevronDown size={16} strokeWidth={1.5} aria-hidden="true" />
      </button>
      {anchor ? (
        <Popover anchor={anchor} onClose={() => setAnchor(null)} className="w-56">
          <MenuItem hint={keyHint("new")} onSelect={() => pick("task")}>
            <span data-testid="new-task" className="flex items-center gap-2">
              <CircleCheck size={16} strokeWidth={1.5} className="text-fg2" aria-hidden="true" />
              {t("top.newTask")}
            </span>
          </MenuItem>
          <MenuItem hint={keyHint("newEvent")} onSelect={() => pick("event")}>
            <span data-testid="new-event" className="flex items-center gap-2">
              <CalendarPlus size={16} strokeWidth={1.5} className="text-fg2" aria-hidden="true" />
              {t("top.newEvent")}
            </span>
          </MenuItem>
        </Popover>
      ) : null}
    </>
  );
}

/** その時刻の時（0〜23。tz が無ければブラウザの時刻） */
export function hourIn(ms: number, tz: string | undefined): number {
  const h = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    hourCycle: "h23",
    ...(tz ? { timeZone: tz } : {}),
  }).format(ms);
  return Number(h);
}

/** 週表示の見出し（`10/1 – 10/7`。D-101 (3)）。表示の範囲がまだ無ければ基準日だけ */
export function rangeLabel(
  range: { from: string; to: string } | null,
  anchor: string,
  md: (date: string) => string,
): string {
  if (!range) return md(anchor);
  return range.from === range.to ? md(range.from) : `${md(range.from)} – ${md(range.to)}`;
}

function IconButton({
  icon: Icon,
  label,
  onClick,
  keys,
  boxed = false,
  side = "top",
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  keys?: string;
  /** 枠付き（上部バーの ‹ ›） */
  boxed?: boolean;
  side?: "top" | "right";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      {...tipProps(label, keys, side)}
      className={`inline-flex size-7 shrink-0 items-center justify-center rounded-card text-fg2 hover:text-fg ${
        boxed ? "border border-line bg-raised hover:border-fg3" : "hover:bg-sunken"
      }`}
    >
      <Icon size={16} strokeWidth={1.5} aria-hidden="true" />
    </button>
  );
}

interface NavDef {
  to: string;
  icon: LucideIcon;
  k: MessageKey;
  count?: number | undefined;
  onClick?: (() => void) | undefined;
  testId?: string | undefined;
}

const NAV_ROW =
  "flex h-8 items-center gap-2.5 rounded-card px-2.5 text-body hover:bg-raised/60 hover:text-fg [&.active]:bg-raised [&.active]:font-medium [&.active]:text-fg [&.active]:shadow-[0_0_0_1px_var(--dl-border)]";

function NavItem({ d }: { d: NavDef }) {
  const t = useT();
  return (
    <Link to={d.to} onClick={d.onClick} data-testid={d.testId} className={`${NAV_ROW} text-fg2`}>
      <d.icon size={16} strokeWidth={1.5} aria-hidden="true" className="shrink-0" />
      <span className="flex-1 truncate">{t(d.k)}</span>
      {d.count ? <span className="font-mono text-fg2 text-meta">{d.count}</span> : null}
    </Link>
  );
}

/**
 * サイドバーの項目（開いた状態と畳んだ状態で同じ並び。D-192・D-193）: 自分の番 N / Inbox / ボード / AI（件数は出さない）。Inbox の件数は出さない
 * （B-7。3日ボードの左の帯には残る）。「今日」はデイビューへの経路（上部の「日」・⌘3・列の見出し・⌘K）で足りるので出さない（B-6）
 */
function useNavGroups(queue: QueueItem[]): NavDef[][] {
  return [
    [
      { to: "/queue", icon: CircleArrowRight, k: "nav.yourTurn", count: turnCounts(queue).total },
      { to: "/inbox", icon: Inbox, k: "nav.inbox" },
    ],
    // AI の画面（ux-mvp 4.19）は件数を出さない（件数の丸は「自分の番 N」だけ）
    [
      { to: "/board", icon: Columns3, k: "nav.week" },
      { to: "/ai", icon: Bot, k: "nav.ai" },
    ],
  ];
}

function Sidebar({ queue }: { queue: QueueItem[] }) {
  const t = useT();
  const projects = useProjects();
  const groups = useNavGroups(queue);
  return (
    <nav
      aria-label={t("nav.label")}
      className="flex w-[220px] shrink-0 flex-col border-line border-r bg-sidebar px-2.5 pb-3"
      data-testid="sidebar"
    >
      <div className="flex h-[52px] shrink-0 items-center justify-end">
        <IconButton
          icon={PanelLeft}
          label={t("nav.collapse")}
          keys={keyHint("toggleSidebar")}
          onClick={() => setUi((s) => ({ sidebarCollapsed: !s.sidebarCollapsed }))}
        />
      </div>
      {groups.map((g, i) => (
        <div key={g[0]?.to} className={`flex flex-col gap-0.5 ${i === 0 ? "mt-1" : "mt-5"}`}>
          {g.map((d) => (
            <NavItem key={d.to} d={d} />
          ))}
        </div>
      ))}
      <div className="flex-1" />
      {projects.data && projects.data.length > 0 ? (
        <div className="flex flex-col gap-0.5">
          <div className="flex h-7 items-center gap-2.5 px-2.5 text-body text-fg2">
            <Folder size={16} strokeWidth={1.5} aria-hidden="true" />
            {t("nav.projects")}
          </div>
          {projects.data.map((p) => (
            <div key={p.id} className="flex h-7 items-center gap-2.5 px-2.5 text-body text-fg2">
              <span
                className="mx-[5px] size-1.5 shrink-0 rounded-full"
                style={{ background: p.color ?? "var(--dl-text-3)" }}
                aria-hidden="true"
              />
              <span className="truncate">{p.name}</span>
            </div>
          ))}
        </div>
      ) : null}
      <div className="mx-1 my-3 h-px bg-line" />
      <ExtSidebarItems />
      <SourcesNoticeRow />
      <CalendarNoticeRow />
      <Link to="/settings" className={`${NAV_ROW} text-fg2`}>
        <Settings size={16} strokeWidth={1.5} aria-hidden="true" />
        <span className="flex-1 truncate">{t("nav.settings")}</span>
      </Link>
    </nav>
  );
}

/** 畳んだサイドバーのツールチップ: 開いたときの行と同じ（名前と、あれば件数。「自分の番 3」） */
export function navLabel(label: string, count?: number): string {
  return count ? `${label} ${count}` : label;
}

/** 畳んだサイドバー（56px のアイコンの列。⌘\）。件数は右上の小さな丸、名前はホバーのツールチップ */
function Rail({ queue }: { queue: QueueItem[] }) {
  const t = useT();
  const groups = useNavGroups(queue);
  const projects = useProjects();
  const notice = useSourcesNotice();
  const calNotice = useCalendarNotice();
  const cell = RAIL_CELL;
  return (
    <nav
      aria-label={t("nav.label")}
      className="flex w-14 shrink-0 flex-col items-center border-line border-r bg-sidebar pb-3"
      data-testid="sidebar-rail"
    >
      <div className="flex h-[52px] shrink-0 items-center">
        <IconButton
          icon={PanelLeft}
          label={t("nav.expand")}
          keys={keyHint("toggleSidebar")}
          side="right"
          onClick={() => setUi((s) => ({ sidebarCollapsed: !s.sidebarCollapsed }))}
        />
      </div>
      <div className="mb-1 h-px w-6 bg-line" />
      {groups.map((g, i) => (
        <div
          key={g[0]?.to}
          className={`flex flex-col items-center gap-0.5 ${i === 0 ? "mt-1" : "mt-4"}`}
        >
          {g.map((d) => (
            <Link
              key={d.to}
              to={d.to}
              onClick={d.onClick}
              data-testid={d.testId}
              className={cell}
              {...tipProps(navLabel(t(d.k), d.count), undefined, "right")}
            >
              <d.icon size={16} strokeWidth={1.5} aria-hidden="true" />
              {d.count ? (
                <span className="absolute top-0.5 right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-fg px-1 font-semibold text-[10px] text-bg">
                  {d.count}
                </span>
              ) : null}
            </Link>
          ))}
        </div>
      ))}
      <div className="flex-1" />
      {projects.data && projects.data.length > 0 ? (
        <button
          type="button"
          className={cell}
          {...tipProps(projects.data.map((p) => p.name).join(" · "), undefined, "right")}
          onClick={() => setUi({ sidebarCollapsed: false })}
        >
          <Folder size={16} strokeWidth={1.5} aria-hidden="true" />
        </button>
      ) : null}
      <SidebarMode.Provider value="rail">
        <ExtSidebarItems />
      </SidebarMode.Provider>
      {/* 取り込みが推定・停止のとき（D-118）と、予定を取れていないとき（D-130）だけ設定のアイコンに印。ホバーで知らせの文と
          説明、押すと設定の該当箇所（取り込みが先） */}
      {notice || calNotice ? (
        <Link
          to="/settings"
          hash={notice ? "ai" : "calendar"}
          className={cell}
          {...tipProps(
            [
              ...(notice ? [`${notice.text}\n${notice.detail}`] : []),
              ...(calNotice ? [`${calNotice.text}\n${calNotice.detail}`] : []),
            ].join("\n\n"),
            undefined,
            "right",
          )}
          data-testid="sources-state"
          data-level={notice?.level ?? "stopped"}
          data-calendar={calNotice?.problem}
        >
          <Settings size={16} strokeWidth={1.5} aria-hidden="true" />
          <span
            className={`absolute top-1.5 right-1.5 size-2 rounded-full ring-2 ring-sidebar ${notice?.level === "estimated" && !calNotice ? "bg-needs" : "bg-error"}`}
            data-testid="sources-mark"
          />
        </Link>
      ) : (
        <Link to="/settings" className={cell} {...tipProps(t("nav.settings"), undefined, "right")}>
          <Settings size={16} strokeWidth={1.5} aria-hidden="true" />
        </Link>
      )}
    </nav>
  );
}

/** 拡張のサイドバーの行（ADR 0015。取り込み・カレンダーの知らせの上）。公開のビルドでは何も出ない */
function ExtSidebarItems() {
  return (
    <>
      {ext.sidebarItems.map((x) => (
        <x.component key={x.key} />
      ))}
    </>
  );
}

/**
 * 取り込みの知らせ（サイドバーの下、設定の上。D-118）: 正常のときは出さない。推定か停止の取り込み元があるときだけ、
 * どの取り込み元か分かる1行（1つなら名前、複数なら件数）。押すと設定の AI（取り込み元）を開く。ホバーで状態の説明と
 * 取り込み元ごとの状態。畳んだサイドバーでは同じときだけ設定のアイコンに印を付ける（Rail）
 */
function useSourcesNotice(): SourcesNotice | null {
  const t = useT();
  const s = useSources();
  return sourcesNotice(userSources(s.data?.sources), t);
}

function SourcesNoticeRow() {
  const n = useSourcesNotice();
  if (!n) return null;
  return (
    <Link
      to="/settings"
      hash="ai"
      // 文は切らない（取り込み元の名前が長いときは2行に折り返す。D-118）
      className={`flex items-start gap-2.5 rounded-card px-2.5 py-1.5 text-body hover:bg-raised/60 ${n.level === "stopped" ? "text-error" : "text-needs"}`}
      {...tipProps(n.detail, undefined, "right")}
      data-testid="sources-state"
      data-level={n.level}
    >
      <TriangleAlert size={16} strokeWidth={1.5} aria-hidden="true" className="mt-0.5 shrink-0" />
      <span className="min-w-0 flex-1 text-fg leading-5" data-testid="sources-text">
        {n.text}
      </span>
    </Link>
  );
}

/**
 * カレンダーの知らせ（D-130。取り込みの知らせの下）: 権限が無い・ヘルパが未接続・同期が失敗し続けているときだけ
 * 「カレンダーの予定を取れていません」。押すと設定 > カレンダー、ホバーで理由
 */
function useCalendarNotice(): CalendarNotice | null {
  const t = useT();
  const h = useHealth();
  return calendarNotice(h.data?.calendarHelper.problem ?? null, t);
}

function CalendarNoticeRow() {
  const n = useCalendarNotice();
  if (!n) return null;
  return (
    <Link
      to="/settings"
      hash="calendar"
      className="flex items-start gap-2.5 rounded-card px-2.5 py-1.5 text-body text-error hover:bg-raised/60"
      {...tipProps(n.detail, undefined, "right")}
      data-testid="calendar-notice"
      data-problem={n.problem}
    >
      <TriangleAlert size={16} strokeWidth={1.5} aria-hidden="true" className="mt-0.5 shrink-0" />
      <span className="min-w-0 flex-1 text-fg leading-5">{n.text}</span>
    </Link>
  );
}

export function Toasts() {
  const toasts = useUi((s) => s.toasts);
  const t = useT();
  return (
    <div className="pointer-events-none fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 flex-col gap-2">
      {toasts.map((x) => (
        <div
          key={x.id}
          role="status"
          className="pointer-events-auto flex max-w-[420px] items-center gap-3 rounded-pop border border-line bg-raised px-3 py-2 text-body shadow-pop"
        >
          {/* 開くの失敗の文は 2〜3 行になることがある（B-5）。幅 420px の中で折り返す */}
          <span className="min-w-0 [overflow-wrap:anywhere]">{x.text}</span>
          {x.action ? (
            <button
              type="button"
              className="text-accent"
              onClick={() => {
                x.action?.run();
                dismissToast(x.id);
              }}
            >
              {x.action.label}
            </button>
          ) : null}
          <button
            type="button"
            aria-label={t("action.close")}
            className="text-fg3 hover:text-fg"
            onClick={() => dismissToast(x.id)}
          >
            <X size={14} strokeWidth={1.5} />
          </button>
        </div>
      ))}
    </div>
  );
}

/** 利用者に見せる取り込み元（hooks の spool は内部のものなので出さない） */
function userSources(xs: SourceView[] | undefined): SourceView[] {
  return (xs ?? []).filter((x) => x.enabled && !isInternalSource(x.tool));
}

/** MCP から追加されたタスクのトースト（ux-mvp 5章: 「<client> が1件追加しました [元に戻す]」） */
function useMcpToasts(): void {
  const t = useT();
  useEffect(
    () =>
      onSse((type, data) => {
        const by = (data as { addedBy?: string }).addedBy;
        const id = data.ids?.[0];
        if (type !== "task" || !by || !id) return;
        toast(t("toast.addedBy", { client: clientName(by, t) }), {
          label: t("action.undo"),
          run: () => void api.api.tasks[":id"].$delete({ param: { id } }),
        });
      }),
    [t],
  );
}

/** タブタイトルに要対応件数（ux-mvp 4.7） */
export function useTabTitle(n: number): void {
  useEffect(() => {
    document.title = n > 0 ? `(${n}) Turnlane` : "Turnlane";
  }, [n]);
}
