/**
 * 拡張（ADR 0015）に公開する、本体と同じ作りの小さな部品（`@turnlane/ext-host` から使う）。
 * - SidebarNotice: サイドバーの下の知らせの1行（取り込み・カレンダーの知らせ D-118・D-130 と同じ作り）。畳んだサイドバーでは
 *   アイコンの列の1つ（右上に点）
 * - TrayRow: メニューバーのポップオーバーの下の操作の1行（集中の行・タスクを追加と同じ作り）
 * - TodayNotice: 今日の列の上部の先頭行（自分の番の帯の上）とデイビューの右の一覧の先頭の1行（D-192）
 * どれも押すと `to`（拡張の画面 `/ext/<id>/…` など）を開く。文は拡張が辞書で引いて渡す
 * - Icon: 本体の線のアイコン（Lucide。本体と同じ 1.5 の線）から名前で選ぶ。拡張は lucide-react を直接 import しない
 */
import { Link } from "@tanstack/react-router";
import {
  Check,
  ChevronDown,
  ChevronRight,
  CirclePause,
  Clock,
  CornerDownRight,
  ExternalLink,
  GitBranch,
  GripVertical,
  Info,
  ListChecks,
  type LucideIcon,
  Minus,
  Moon,
  PanelRight,
  Plug,
  Plus,
  Search,
  SquareTerminal,
  TriangleAlert,
  X,
} from "lucide-react";
import { createContext, useContext } from "react";
import { tipProps } from "../components/Tooltip.tsx";
import { desktopOpen } from "../lib/desktop.ts";
import { openInApp } from "../lib/open.ts";

/** 色（状態アイコンの色の名前）。neutral は本体の文字の色 */
export type ExtTone = "neutral" | "running" | "needs" | "error" | "done";

/** 部品のアイコン（本体のアイコンから選ぶ。pause は一時停止の丸） */
export type ExtIcon = "list" | "moon" | "clock" | "alert" | "pause";

const ICONS: Record<ExtIcon, LucideIcon> = {
  list: ListChecks,
  moon: Moon,
  clock: Clock,
  alert: TriangleAlert,
  pause: CirclePause,
};

/** `Icon` で選べる線のアイコン（Lucide の名前） */
export type ExtLineIcon =
  | "check"
  | "chevron-down"
  | "chevron-right"
  | "circle-pause"
  | "clock"
  | "corner-down-right"
  | "external-link"
  | "git-branch"
  | "grip-vertical"
  | "info"
  | "list-checks"
  | "minus"
  | "moon"
  | "panel-right"
  | "plug"
  | "plus"
  | "search"
  | "square-terminal"
  | "triangle-alert"
  | "x";

const LINE_ICONS: Record<ExtLineIcon, LucideIcon> = {
  check: Check,
  "chevron-down": ChevronDown,
  "chevron-right": ChevronRight,
  "circle-pause": CirclePause,
  clock: Clock,
  "corner-down-right": CornerDownRight,
  "external-link": ExternalLink,
  "git-branch": GitBranch,
  "grip-vertical": GripVertical,
  info: Info,
  "list-checks": ListChecks,
  minus: Minus,
  moon: Moon,
  "panel-right": PanelRight,
  plug: Plug,
  plus: Plus,
  search: Search,
  "square-terminal": SquareTerminal,
  "triangle-alert": TriangleAlert,
  x: X,
};

export interface IconProps {
  name: ExtLineIcon;
  /** px（既定 16） */
  size?: number;
  className?: string;
  /** 読み上げのラベル（無ければ飾りとして隠す） */
  label?: string;
}

/** 本体の線のアイコン（1.5 の線、色は文字の色） */
export function Icon({ name, size = 16, className = "", label }: IconProps) {
  const C = LINE_ICONS[name];
  return (
    <C
      size={size}
      strokeWidth={1.5}
      className={`shrink-0 ${className}`}
      data-icon={name}
      {...(label ? { "aria-label": label, role: "img" } : { "aria-hidden": true })}
    />
  );
}

const TEXT: Record<ExtTone, string> = {
  neutral: "text-fg2",
  running: "text-running",
  needs: "text-needs",
  error: "text-error",
  done: "text-done",
};

const DOT: Record<ExtTone, string> = {
  neutral: "bg-fg",
  running: "bg-running",
  needs: "bg-needs",
  error: "bg-error",
  done: "bg-done",
};

/** サイドバーの描き方（AppShell が畳んだ列の中で rail にする） */
export const SidebarMode = createContext<"full" | "rail">("full");

/**
 * 畳んだサイドバーのアイコンの枠（本体の項目と拡張の行で同じ。ホバー・今いる画面の面と枠）。フォーカスの輪は全体の
 * `:focus-visible`
 */
export const RAIL_CELL =
  "relative flex size-9 items-center justify-center rounded-card text-fg2 hover:bg-raised/60 hover:text-fg [&.active]:bg-raised [&.active]:text-fg [&.active]:shadow-[0_0_0_1px_var(--dl-border)]";

/** 開いたサイドバーの今いる画面の面と枠（本体の項目の行と同じ。文字の色は行の色のまま） */
const ACTIVE_ROW =
  "[&.active]:bg-raised [&.active]:font-medium [&.active]:shadow-[0_0_0_1px_var(--dl-border)]";

export interface SidebarNoticeProps {
  /** 1行の文（長ければ2行に折り返す。切らない）。畳んだサイドバーではこの文（と detail）がツールチップ */
  text: string;
  /** ホバーで出す説明（任意） */
  detail?: string;
  tone?: ExtTone;
  icon?: ExtIcon;
  /**
   * 文に含めた件数（任意。文には拡張が入れて渡す。ここでは描かない）。1 以上なら、畳んだサイドバーでアイコンの右上に点を付ける
   */
  count?: number;
  /**
   * 畳んだサイドバーの点を付けるか（任意。指定すればそれに従う）。省くと、件数が 1 以上か tone が neutral 以外のときだけ点を
   * 付ける（点は「見るものがある」の印。何も無い行に点を付けない）
   */
  mark?: boolean;
  /** 押したときに開く経路（`/ext/<id>/…`） */
  to: string;
  testId?: string;
}

/** 畳んだサイドバーで点を付けるか: mark の指定、なければ件数が 1 以上か状態（neutral 以外の tone）があるとき */
export function sidebarMark({
  tone = "neutral",
  count,
  mark,
}: {
  tone?: ExtTone | undefined;
  count?: number | undefined;
  mark?: boolean | undefined;
}): boolean {
  if (mark !== undefined) return mark;
  return (count ?? 0) > 0 || tone !== "neutral";
}

/** ツールチップ・読み上げの文（折り返しを止める見えない字 U+2060 を除く。見える文は開いたときの行と同じ） */
const plain = (s: string) => s.replace(/\u2060/g, "");

export function SidebarNotice({
  text,
  detail,
  tone = "neutral",
  icon = "list",
  count,
  mark,
  to,
  testId,
}: SidebarNoticeProps) {
  const mode = useContext(SidebarMode);
  const Icon = ICONS[icon];
  if (mode === "rail") {
    const dot = sidebarMark({ tone, count, mark });
    return (
      <Link
        to={to as never}
        className={RAIL_CELL}
        {...tipProps(plain(detail ? `${text}\n${detail}` : text), undefined, "right")}
        data-kind="ext-sidebar"
        data-tone={tone}
        data-mark={dot ? "true" : "false"}
        data-testid={testId}
      >
        <Icon size={16} strokeWidth={1.5} aria-hidden="true" />
        {dot ? (
          <span
            className={`absolute top-1.5 right-1.5 size-2 rounded-full ring-2 ring-sidebar ${DOT[tone]}`}
            data-testid="ext-sidebar-mark"
          />
        ) : null}
      </Link>
    );
  }
  return (
    <Link
      to={to as never}
      className={`flex items-start gap-2.5 rounded-card px-2.5 py-1.5 text-body hover:bg-raised/60 ${ACTIVE_ROW} ${TEXT[tone]}`}
      {...(detail ? tipProps(detail, undefined, "right") : {})}
      data-kind="ext-sidebar"
      data-tone={tone}
      data-testid={testId}
    >
      <Icon size={16} strokeWidth={1.5} aria-hidden="true" className="mt-0.5 shrink-0" />
      <span className="min-w-0 flex-1 text-fg leading-5">{text}</span>
    </Link>
  );
}

export interface TrayRowProps {
  text: string;
  /** 右に小さく出す値（件数・時刻など。mono） */
  meta?: string;
  tone?: ExtTone;
  icon?: ExtIcon;
  /** 押したときに main ウインドウで開く経路（`/ext/<id>/…`） */
  to: string;
  testId?: string;
}

export function TrayRow({ text, meta, tone = "neutral", icon = "list", to, testId }: TrayRowProps) {
  const Icon = ICONS[icon];
  return (
    <button
      type="button"
      className="flex h-9 w-full items-center gap-3 rounded-card px-3 text-left text-body text-fg hover:bg-sunken"
      onClick={() => desktopOpen(to)}
      data-kind="ext-tray"
      data-tone={tone}
      data-testid={testId}
    >
      <Icon size={16} strokeWidth={1.5} className={TEXT[tone]} aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">{text}</span>
      {meta ? <span className="shrink-0 font-mono text-fg3 text-micro">{meta}</span> : null}
    </button>
  );
}

export interface TodayNoticeProps {
  /** 1行の文（入らなければ末尾を省略する。折り返さない） */
  text: string;
  tone?: Exclude<ExtTone, "done">;
  icon?: ExtIcon;
  /** 押したときに開く経路（`/ext/<id>/…`） */
  to: string;
  testId?: string;
}

/** 面と文字の色（needs は琥珀 8% の面で文字は本体の色、error はアイコンだけ赤、running はアイコンだけ青） */
const NOTICE_TONE: Record<Exclude<ExtTone, "done">, { box: string; text: string; icon: string }> = {
  neutral: { box: "", text: "text-fg2", icon: "text-fg2" },
  needs: { box: "bg-needs-soft", text: "text-fg", icon: "text-needs" },
  error: { box: "", text: "text-fg", icon: "text-error" },
  running: { box: "", text: "text-fg", icon: "text-running" },
};

/**
 * 今日の列の先頭行の知らせ（D-192 §2.1）: 28px の1行。左に 16px のアイコン、文（13px・500）、右端に →。全体が1つのボタンで、
 * j / k の対象にはしない（⌘K の Go to で届く）
 */
export function TodayNotice({
  text,
  tone = "neutral",
  icon = "list",
  to,
  testId,
}: TodayNoticeProps) {
  const Icon = ICONS[icon];
  const c = NOTICE_TONE[tone];
  return (
    <button
      type="button"
      tabIndex={-1}
      onClick={() => openInApp(to)}
      className={`flex h-7 w-full min-w-0 items-center gap-2 rounded-card px-2 text-left font-medium text-body hover:bg-sunken ${c.box} ${c.text}`}
      data-kind="today-notice"
      data-tone={tone}
      data-testid={testId}
    >
      <Icon size={16} strokeWidth={1.5} className={`shrink-0 ${c.icon}`} aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">{text}</span>
      <ChevronRight size={16} strokeWidth={1.5} className="shrink-0 text-fg3" aria-hidden="true" />
    </button>
  );
}
