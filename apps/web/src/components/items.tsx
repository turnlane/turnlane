/**
 * 項目5種（M2-11。design-system の Item kinds）: 予定・自分のタスク・自分の番・AI 項目・外部タスク。
 * グレースケールでも区別できること: チェックボックスは「自分がやること」の印で、AI 項目には付けない。
 */

import {
  type AiRun,
  type CalendarEventView,
  fmtClock2,
  fmtDuration,
  formatTaskTitle,
  type SourceBadge,
  type TaskView,
  type TitleSpec,
  type WorkItemStatus,
} from "@turnlane/core/web";
import {
  ArrowRightToLine,
  CalendarArrowUp,
  Check as CheckIcon,
  Clock,
  SquareTerminal,
  Sun,
} from "lucide-react";
import { type ReactNode, useRef } from "react";
import { useItemActions } from "../actions/item-actions.tsx";
import { useAiItemSubject } from "../data/glance.ts";
import { type ExtRegistry, ext } from "../ext/registry.ts";
import { type I18n, type MessageKey, useI18n } from "../i18n/index.tsx";
import { TaskAiLine } from "../launch/TaskAiLine.tsx";
import { calColor } from "../lib/cal-color.ts";
import { usePanelsAvailable } from "../lib/panels.ts";
import { setUi } from "../lib/store.ts";
import { type AiHover, aiHoverProps } from "./AiHoverCard.tsx";
import { HoverToolbar } from "./HoverToolbar.tsx";
import { Nums } from "./Nums.tsx";
import { StatusIcon } from "./StatusIcon.tsx";
import { Check, Chip, sourceBadgeText, Warning } from "./ui.tsx";

export function titleText(t: TitleSpec, locale: "en" | "ja"): string {
  return t.t === "text" ? t.text : formatTaskTitle(t.key, t.params, locale);
}

export function useTitle() {
  const { locale } = useI18n();
  return (t: TitleSpec) => titleText(t, locale);
}

/**
 * 予定: カードにしない。カレンダー色の塗りだけ（D-103。左の線は無い。styles.css の .dl-ev。色はスタイルの --ev で渡す）。
 * 時刻（mono）と題名（13/500）はどちらも text-primary。compact（2行に足りない、またはタスクを中に入れる）は1行で
 * `14:00 1on1`（時刻が先）、2行は `11:00-12:00` の下に題名（確定デザインの3日ボード）
 */
export function EventBlock({
  e,
  tz,
  style,
  compact = false,
  hint,
  selected = false,
}: {
  e: CalendarEventView;
  tz: string;
  selected?: boolean;
  style?: React.CSSProperties;
  compact?: boolean;
  /** ホバーの説明（前日に計上する深夜のブロックの `Counted in Sun 10/4`。D-054） */
  hint?: string | undefined;
}) {
  const time = `${fmtClock2(e.start, tz)}-${fmtClock2(e.end, tz)}`;
  const panels = usePanelsAvailable();
  const mouse = useEventMouse(e.id, panels);
  const color = calColor(e.calendarColor, e.calendarColorKey);
  const meta = "text-evmeta";
  return (
    // 予定のクリックで詳細パネル（D-070）。キーボードは ⌘K から
    <div
      title={hint}
      className={`@container absolute overflow-hidden rounded-card px-2 dl-ev ${panels ? "cursor-pointer" : ""} ${selected ? "outline outline-[1.5px] outline-accent" : ""}`}
      style={{ ...style, ["--ev" as string]: color }}
      data-kind="event"
      data-id={e.id}
      {...mouse}
    >
      {compact ? (
        <div className="flex h-5 min-w-0 items-center gap-1.5">
          <span className={`shrink-0 font-mono text-meta ${meta} @max-[120px]:hidden`}>
            {fmtClock2(e.start, tz)}
          </span>
          <span className={"min-w-0 truncate font-medium text-body text-fg"}>{e.title}</span>
        </div>
      ) : (
        <>
          <div className={`truncate pt-1 font-mono text-meta ${meta}`}>{time}</div>
          <div className={"truncate font-medium text-body text-fg"}>{e.title}</div>
        </>
      )}
    </div>
  );
}

/** 終日の予定（ヘッダ直下の細い行） */
export function AllDayChip({ e }: { e: CalendarEventView }) {
  const panels = usePanelsAvailable();
  const mouse = useEventMouse(e.id, panels);
  return (
    // 予定のクリックで詳細パネル（D-070）
    <div
      className={`dl-ev flex h-5 items-center truncate rounded-control px-2 font-medium text-fg text-meta ${panels ? "cursor-pointer" : ""}`}
      style={{ ["--ev" as string]: calColor(e.calendarColor, e.calendarColorKey) }}
      data-kind="event"
      data-id={e.id}
      {...mouse}
    >
      {e.title}
    </div>
  );
}

/**
 * 予定のマウスの操作: 画面が文脈を配っていれば選択＋パネル・右クリックメニュー（UX 監査 A1・A3）、無ければパネルだけ（D-070）
 */
function useEventMouse(id: string, panels: boolean) {
  const actions = useItemActions();
  const k = `event:${id}`;
  if (actions)
    return {
      onClick: () => actions.click(k),
      onContextMenu: (ev: React.MouseEvent) => actions.menu(ev, k),
    };
  return { onClick: panels ? () => setUi({ panelEventId: id }) : undefined };
}

/** 持ち越しバッジ `↺ yesterday` / `↺ 3`（mono、色なし） */
export function Carry({ n }: { n: number }) {
  const { t } = useI18n();
  if (n <= 0) return null;
  return <Chip>{n === 1 ? `↺ ${t("board.carriedYesterday")}` : `↺ ${n}`}</Chip>;
}

const EXTERNAL_NAME: Record<string, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  linear: "Linear",
  jira: "Jira",
  notion: "Notion",
  slack: "Slack",
};
const MCP_CLIENT: Record<string, MessageKey> = {
  "claude-code": "inbox.from.claude",
  claude: "inbox.from.claude",
  codex: "inbox.from.codex",
};
const CLIENT_NAME: Record<string, MessageKey> = {
  "claude-code": "sources.tool.claude_code",
  claude: "sources.tool.claude_code",
  codex: "sources.tool.codex",
};

/** MCP のクライアント名（`claude-code`）→ 利用者の言葉（`Claude Code`）。知らない名前はそのまま */
export function clientName(client: string, t: I18n["t"]): string {
  const key = CLIENT_NAME[client.toLowerCase()];
  return key ? t(key) : client;
}

/**
 * 出どころ（Inbox の行・タスクのカードの2行目）: 利用者の言葉で（`Claude Code から`・`Codex から`・`GitHub`・`CLI`）。
 * 内部の名前・括弧は出さない。手で入れたもの（クイック入力を含む）・AI のカードから作ったものは出さない（null）
 */
export function originLabel(
  o: TaskView["origin"],
  t: I18n["t"],
  origins: ExtRegistry["taskOrigins"] = ext.taskOrigins,
): string | null {
  if (o.externalSource) {
    const k = o.externalSource.toLowerCase();
    // 拡張が作ったタスクは拡張の言葉（組み込んでいないビルドでは内部の名前を出さない）
    if (k.startsWith("ext.")) {
      const x = origins.get(k);
      return x ? t(x.label) : null;
    }
    return EXTERNAL_NAME[k] ?? o.externalSource;
  }
  if (o.source === "cli") return t("inbox.from.cli");
  if (o.source === "mcp") {
    const c = o.client?.toLowerCase() ?? "";
    const key = MCP_CLIENT[c];
    if (key) return t(key);
    return o.client ? t("inbox.from.client", { client: o.client }) : t("inbox.from.mcp");
  }
  return null;
}

const VIA_KEY: Partial<Record<TaskView["origin"]["source"], MessageKey>> = {
  desktop: "inbox.via.desktop",
  ai: "taskPanel.via.ai",
  calendar: "taskPanel.via.calendar",
};

/**
 * タスクの詳細パネルの「経由」: 行と同じ利用者の言葉（originLabel）。行では出さない手入力・クイック入力・AI・カレンダーも
 * 言葉で出す（内部の名前・等幅の札は出さない）
 */
export function viaLabel(o: TaskView["origin"], t: I18n["t"]): string {
  return originLabel(o, t) ?? t(VIA_KEY[o.source] ?? "inbox.via.manual");
}

/**
 * 自分のタスク。背景より明るい面（task surface）と枠線、丸いチェックボックス、13/500。計画（時間に置いたが未完了）は
 * 強い枠線のみ、完了は面＋枠線・塗った ✓・薄い字（取り消し線は付けない。T4。D-139 (4)）。○ はマウスを乗せたとき・選んで
 * いるときだけ。時間軸のカード（style で位置を渡すもの）は左の ○ を持たず、題名は予定と同じ左の余白から始める。完了は
 * 右のホバーのボタンの ✓（D-148）。mono の見積 `45m`、プロジェクト `#blog`、
 * 持ち越し `↺ 3`
 */
export function taskSurface(variant: "card" | "planned" | "done", selected: boolean): string {
  // 選択は無彩色の 1.5px の枠（D-104）。完了は面を外して薄く（部品シートの「完了」）。
  // 計画（時間に置いた未完了）も未定のカードと同じ白い面に薄い灰の枠（確定デザイン。濃い枠は選択中だけ。D-114）
  const ring = selected ? "border-accent shadow-[0_0_0_0.5px_var(--dl-accent)]" : "";
  if (variant === "planned") return `border ${selected ? ring : "border-line"} bg-task shadow-task`;
  if (variant === "done") return `border ${selected ? ring : "border-line"} bg-lane`;
  return `border ${selected ? ring : "border-line"} bg-task shadow-task`;
}

/**
 * 完了の薄さ。選んでいるときも中身（題名・時刻）は薄くして、選択の枠だけ濃く残す（選んだまま ✓ で完了にしても、完了に
 * 変わったと分かるように。2026-10-16）
 */
function doneFade(done: boolean, selected: boolean): string {
  if (!done) return "";
  // ホバーのボタンは薄くしない（地が透けて下の時刻が見える）
  return selected ? "[&>*:not(.dl-toolbar)]:opacity-60" : "opacity-60";
}

export function TaskCard({
  task,
  variant = "card",
  selected = false,
  overlapMs = 0,
  project,
  onToggle,
  onClick,
  style,
  right,
  compact = false,
  hint,
}: {
  task: TaskView;
  /** card = Unscheduled のカード、planned = 時間軸の計画（枠線）、done = 時間軸の実績（塗り） */
  variant?: "card" | "planned" | "done";
  selected?: boolean;
  overlapMs?: number;
  project?: string | null;
  onToggle?: () => void;
  onClick?: () => void;
  style?: React.CSSProperties;
  right?: ReactNode;
  /** 時間軸で高さが2行に足りないとき: 題名の行だけ（見積・プロジェクト・経由の行を出さない） */
  compact?: boolean;
  /** ホバーの説明（前日に計上する深夜のブロックの `Counted in Sun 10/4`。D-054） */
  hint?: string | undefined;
}) {
  const { t, locale } = useI18n();
  const done = task.status === "done";
  const title = titleText(task.title, locale);
  // 見積は題名の右（未定のカードも時間軸の計画も。確定デザイン。D-114）。2行目はプロジェクトと出どころ（利用者の言葉）
  const meta = [project ? `#${project}` : null, originLabel(task.origin, t)].filter(
    (x): x is string => x !== null,
  );
  const surface = taskSurface(variant, selected);
  const positioned = style !== undefined;
  // マウスの操作（UX 監査 A1・A2）: 右クリックメニュー、ダブルクリックで名前の変更、ホバーのボタン（今日へ・1日後へ・時間に置く・…）
  const actions = useItemActions();
  const k = `task:${task.id}`;
  const mouse = actions
    ? {
        onContextMenu: (e: React.MouseEvent) => actions.menu(e, k),
        onDoubleClick: () => actions.doubleClick(k),
      }
    : {};
  // 時間軸のカードは完了済みでも出す（塗った ✓ で未完了に戻す。D-148）。✓ →| ⋯ は 80px なので、120px 未満の
  // カードでは隠してつかむ場所（ドラッグ）を残す（右クリックのメニューは使える）
  const toolbar =
    actions && (!done || positioned) ? (
      <TaskToolbar
        k={k}
        align={positioned ? "center" : "top"}
        timeline={positioned}
        done={done}
        {...(onToggle ? { onComplete: onToggle } : {})}
        className={positioned ? "@max-[120px]:!hidden" : "@max-[180px]:!hidden"}
      />
    ) : null;
  // 2行目以降の字下げ（左の ○ の幅。時間軸のカードは ○ が無いので題名とそろえて字下げしない。D-148）
  const indent = positioned ? "" : "pl-6";
  return (
    // biome-ignore lint/a11y/useSemanticElements: カードの中にチェックボックス（ボタン）を置くため div
    <div
      role="button"
      tabIndex={-1}
      data-kind="task"
      data-id={task.id}
      data-selected={selected ? "" : undefined}
      title={hint}
      onClick={onClick}
      onKeyDown={undefined}
      {...mouse}
      className={`group @container ${positioned ? "absolute" : "relative"} overflow-hidden rounded-card px-2 ${surface} ${
        overlapMs > 0 ? "dl-hatch" : ""
      } ${variant === "card" ? "py-1.5" : positioned ? "py-0" : "py-0.5"} ${doneFade(done, selected)}`}
      style={style}
    >
      {/* 時間軸では題名の行を 18px に固定し、枠線と合わせて最小 20px に収める */}
      <div className={`flex min-w-0 items-center gap-2 ${positioned ? "h-[18px]" : ""}`}>
        {/* ○ はマウスを乗せたとき・選んでいるときだけ（完了の ✓ は常に。D-139 (4)）。時間軸のカードには置かない（D-148） */}
        {positioned ? null : (
          <Check
            checked={done}
            reveal
            label={done ? t("action.uncomplete") : t("action.complete")}
            {...(onToggle ? { onToggle } : {})}
          />
        )}
        <span
          className={`min-w-0 flex-1 font-medium text-body ${variant === "card" ? "line-clamp-2" : "truncate"} ${
            done ? "text-fg2" : "text-fg"
          }`}
        >
          {title}
        </span>
        {variant !== "done" && task.estimateMin !== null && !done ? (
          <span className="shrink-0 font-mono text-fg2 text-meta @max-[140px]:hidden">
            {fmtDuration(task.estimateMin * 60_000)}
          </span>
        ) : null}
        {task.rolloverCount > 0 ? <Carry n={task.rolloverCount} /> : null}
        {right}
      </div>
      {task.ai && !done && !compact ? (
        // 頼んだ AI の状態（D-107。AI 実行中・自分の番 · 返答・AI 完了 · 確認）
        <TaskAiLine ai={task.ai} className={indent} />
      ) : null}
      {meta.length > 0 && variant !== "done" && !compact ? (
        <div className={`truncate ${indent} text-fg2 text-meta`}>{meta.join(" · ")}</div>
      ) : null}
      {overlapMs > 0 ? (
        <div className={`${indent} text-meta`}>
          <Warning>
            {t("board.overlap")} · <span className="font-mono">{fmtDuration(overlapMs)}</span>
          </Warning>
        </div>
      ) : null}
      {toolbar}
    </div>
  );
}

/**
 * タスクのホバーのボタン（UX 監査 A2。今日へ・1日後へ・時間に置く・AI に頼む・…）。カード（ボード）と Inbox の行で共有
 */
export function TaskToolbar({
  k,
  align = "top",
  className = "",
  timeline = false,
  done = false,
  onComplete,
}: {
  k: string;
  align?: "center" | "top";
  className?: string;
  /** 時間軸のカード: 完了済み（✓ を塗って、押すと未完了に戻す。→| は出さない。D-148） */
  done?: boolean;
  /** 時間軸のカードの ✓（左の ○ と同じ書き込み。元に戻すの知らせ・⌘Z も同じ）。省略は選択の操作の「完了」 */
  onComplete?: (() => void) | undefined;
  /**
   * 時間軸のカード: 日付へ移す（→|）と ⋯ の2つだけ（T4。30分のカードでも題名を隠さない。今日へ・1日後へ・時間に置く・
   * AI に頼むは ⋯ の中。右クリックと同じ並び。D-139 (4)）。左の ○ をやめたので、先頭に完了の ✓ を足して ✓ →| ⋯（D-148）
   */
  timeline?: boolean;
}) {
  const { t } = useI18n();
  const actions = useItemActions();
  if (!actions) return null;
  if (timeline) {
    const complete = {
      id: "complete",
      icon: CheckIcon,
      label: done ? t("menu.uncomplete") : t("menu.complete"),
      keyId: "complete",
      filled: done,
      onClick: onComplete ?? (() => actions.run(k, "complete")),
    };
    const move = {
      id: "move",
      icon: ArrowRightToLine,
      label: t("menu.move"),
      keyId: "move",
      onClick: () => actions.run(k, "move"),
    };
    return (
      <HoverToolbar
        align={align}
        className={className}
        buttons={done ? [complete] : [complete, move]}
        onMore={(e) => actions.menu(e, k)}
      />
    );
  }
  return (
    <HoverToolbar
      align={align}
      className={className}
      buttons={[
        {
          id: "today",
          icon: Sun,
          label: t("menu.today"),
          keyId: "today",
          onClick: () => actions.run(k, "today"),
        },
        {
          id: "later",
          icon: CalendarArrowUp,
          label: t("menu.later"),
          keyId: "later",
          onClick: () => actions.run(k, "later"),
        },
        {
          id: "place",
          icon: Clock,
          label: t("menu.place"),
          keyId: "place",
          onClick: () => actions.run(k, "place"),
        },
        // AI に頼む（D-107。確定デザイン board-CreateTask のホバー）
        {
          id: "askAi",
          icon: SquareTerminal,
          label: t("launch.title"),
          onClick: (el) => actions.run(k, "askAi", el),
        },
      ]}
      onMore={(e) => actions.menu(e, k)}
    />
  );
}

/** AI の線の色（確定デザイン: 実行中は青、ブロック中は琥珀、エラーは赤、終わったもの（自分の番・完了）は灰） */
export const BAR_COLOR: Record<WorkItemStatus, string> = {
  running: "var(--dl-running)",
  needs_input: "var(--dl-needs)",
  error: "var(--dl-error)",
  your_turn: "var(--dl-done)",
  done: "var(--dl-done)",
};

/**
 * AI の作業（D-101 の「AI = 線」。確定デザインの部品シート・3日ボード）: カードにしない。状態の色の 3px の縦線（実行の長さ）と、
 * その右の1〜2行のラベル（状態アイコン・題名 / 長さ）。面は無い。ラベルは線の右の残りの幅をすべて使い、高さが足りなければ線の下へ
 * はみ出してよい（重なりは AI レーンが `+1` にまとめる）。選択は無彩色の枠
 */
type AiRunBlockProps = Parameters<typeof AiRunBlockView>[0];

export function AiRunBlock(props: AiRunBlockProps) {
  return props.item ? <AiRunBlockSubject {...props} /> : <AiRunBlockView {...props} />;
}

/** AI の線の項目の件名（直近の指示 → 自動の題名。spec-glance §2.2。fix-stale-title）をラベルとホバーに入れる */
function AiRunBlockSubject(props: AiRunBlockProps) {
  const ref = useRef<HTMLButtonElement>(null);
  const subject = useAiItemSubject(props.item, ref, !props.bare);
  return (
    <AiRunBlockView
      {...props}
      buttonRef={ref}
      title={props.title === null ? null : subject}
      hover={props.hover ? { ...props.hover, title: subject } : undefined}
    />
  );
}

function AiRunBlockView({
  title,
  status,
  estimated,
  sources,
  right,
  sub,
  more,
  selected = false,
  style,
  onClick,
  carried,
  hint,
  workItemId,
  compact = false,
  bare = false,
  shift = 0,
  labelStatus,
  barHeight,
  stickyTop = 4,
  drop = 0,
  hover,
  buttonRef,
}: {
  /** ラベルを線の上端から下へずらす px（今の線に重なるとき。board/lane-labels.ts） */
  drop?: number;
  buttonRef?: React.Ref<HTMLButtonElement>;
  /** AI の線の項目。あれば件名（直近の指示 → 自動の題名。spec-glance §2.2）をラベルとホバーに使う（fix-stale-title） */
  item?: Parameters<typeof useAiItemSubject>[0];
  /** ホバーの吹き出し（D-116。無ければ title 属性） */
  hover?: AiHover | undefined;
  /** ラベルを画面の上端に残すときの位置（px。並んだ長い線のラベルを重ねないよう、列ごとに下へずらす） */
  stickyTop?: number;
  /** 線だけ（ラベルは先のラベルの `+1` にまとめた） */
  bare?: boolean;
  /** ラベルの状態アイコン（項目の続きをまとめたラベルは最後のブロックの状態。省略は status） */
  labelStatus?: WorkItemStatus | undefined;
  /** 線の高さ（省略は要素の高さいっぱい）。ラベルが線より高いとき、線は実行の長さのまま */
  barHeight?: number | undefined;
  /** ラベルを右へずらす px（ラベルの高さの範囲で動いている右の線をまたがない） */
  shift?: number;
  title: string | null;
  status: WorkItemStatus;
  estimated: boolean;
  sources: SourceBadge[];
  /** 2行目の長さ（`2h59m`） */
  right: string | null;
  /** 2行目の続き（`放置 50m`、`ブロック中 12m`） */
  sub?: string | null | undefined;
  /** まとめた並列の件数（`+1`。ホバーで内訳） */
  more?: { count: number; hint: string } | null | undefined;
  selected?: boolean;
  style?: React.CSSProperties;
  onClick?: () => void;
  carried?: string | null;
  /** ホバーの説明（前日に計上する深夜のブロックの `Counted in Sun 10/4`。D-054） */
  hint?: string | undefined;
  /** 接続線（ホバー）と選択の位置合わせに使う */
  workItemId?: string | undefined;
  /** 1行（題名と長さを横に並べる。ポップオーバーの内訳） */
  compact?: boolean;
}) {
  const { t } = useI18n();
  const actions = useItemActions();
  const k = workItemId ? `ai:${workItemId}` : null;
  const meta = [right, sub].filter((x): x is string => !!x).join(" · ");
  const badges = sources.length > 0 ? sources.map((x) => sourceBadgeText(x)).join(" ") : "";
  return (
    <button
      ref={buttonRef}
      type="button"
      tabIndex={-1}
      title={hover ? undefined : [title ?? "", badges, hint ?? ""].filter(Boolean).join("\n")}
      {...(hover ? aiHoverProps({ ...hover, hint }) : {})}
      data-kind="ai"
      data-id={workItemId}
      onClick={onClick}
      onContextMenu={actions && k ? (e) => actions.menu(e, k) : undefined}
      onDoubleClick={actions && k ? () => actions.doubleClick(k) : undefined}
      className={`absolute flex gap-1.5 rounded-control text-left ${compact ? "items-center px-1" : "items-stretch"} ${
        selected ? "outline outline-[1.5px] outline-accent outline-offset-2" : ""
      }`}
      style={style}
    >
      <span
        className={`w-[3px] shrink-0 rounded-full ${compact ? "h-4" : barHeight !== undefined ? "self-start" : "self-stretch"}`}
        style={{
          background: BAR_COLOR[status],
          ...(barHeight !== undefined && !compact ? { height: barHeight } : {}),
        }}
        data-bar={status}
      />
      {bare ? null : (
        // 長い線のラベルは、線の上端が画面の上に隠れても画面の上端に残す（sticky。線の下端までで止まる。D-117）。
        // 残したラベルの下をほかの列の線が通るので、時間軸の地の色を敷く
        <span
          className={`flex min-w-0 flex-1 ${compact ? "items-center gap-2" : "sticky flex-col self-start rounded-control bg-lane pr-1"} text-meta leading-4`}
          style={{
            ...(shift > 0 ? { marginLeft: shift } : {}),
            ...(compact ? {} : { top: stickyTop }),
            ...(drop > 0 && !compact ? { marginTop: drop } : {}),
          }}
          data-label="ai"
        >
          <span className="flex min-w-0 items-center gap-1 font-medium text-fg">
            <StatusIcon status={labelStatus ?? status} estimated={estimated} size={14} />
            <span className="min-w-0 truncate text-[12.5px]">{title ?? t("common.none")}</span>
            {more ? (
              <span
                className="shrink-0 rounded-chip border border-line px-1 text-fg2 text-micro"
                title={more.hint}
              >
                +{more.count}
              </span>
            ) : null}
          </span>
          {meta || carried ? (
            <span className="min-w-0 truncate pl-[18px] text-fg2">
              {carried ? `${t("ai.carried", { date: carried.slice(5).replace("-", "/") })} ` : ""}
              <Nums text={meta} />
            </span>
          ) : null}
        </span>
      )}
    </button>
  );
}

/** AI の実行区間の長さ（開いている区間は now まで） */
export function runMs(r: AiRun, now: number): number {
  return Math.max(0, (r.open ? Math.max(r.end, now) : r.end) - r.start);
}
