/**
 * 詳細パネルの枠（AI・タスク・予定で共通。右からスライド、Esc で閉じる。D-070。左の縁で幅を変える。ux-mvp 4.12.1）と、AI の詳細パネル（D-116）の作りの部品:
 * 頭（大きな題名と右の ×）、主のボタン・他のボタン（ActionButton）、「⋯」（MoreButton）。タスクの詳細パネルも同じ部品で作る
 */
import { MoreHorizontal, X } from "lucide-react";
import type { ReactNode } from "react";
import { useT } from "../i18n/index.tsx";
import { ResizablePanel } from "./ResizablePanel.tsx";

export function PanelFrame({
  label,
  testId,
  onClose,
  variant = "bar",
  children,
}: {
  label: string;
  testId: string;
  /** bar の帯の × */
  onClose?: () => void;
  /**
   * bar: 上に名前の帯と × を出す（予定のパネル）/ detail: 帯を出さず、中身の頭（PanelHead）が題名と × を持つ
   * （AI の詳細パネル D-116 とタスクの詳細パネル）
   */
  variant?: "bar" | "detail";
  children: ReactNode;
}) {
  const t = useT();
  if (variant === "detail")
    return (
      <ResizablePanel
        label={label}
        testId={testId}
        className="flex flex-col gap-5 overflow-y-auto border-line border-l bg-bg px-5 py-6"
      >
        {children}
      </ResizablePanel>
    );
  return (
    <ResizablePanel
      label={label}
      testId={testId}
      className="flex flex-col border-line border-l bg-sidebar"
    >
      <header className="flex h-10 shrink-0 items-center justify-between border-line border-b px-3">
        <span className="text-meta text-fg2">{label}</span>
        <button
          type="button"
          aria-label={t("action.close")}
          onClick={onClose}
          className="text-fg3 hover:text-fg"
        >
          <X size={16} strokeWidth={1.5} />
        </button>
      </header>
      {children}
    </ResizablePanel>
  );
}

/** パネルの1行（左に名前、右に値や入力欄。値の側は縮めない） */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-7 items-center justify-between gap-3">
      <span className="shrink-0 text-meta text-fg3">{label}</span>
      <div className="flex min-w-0 items-center justify-end gap-1.5">{children}</div>
    </div>
  );
}

/**
 * 詳細パネルの頭（D-116）: 大きな題名、右に ×。lead は題名の左（タスクの ○）。「⋯」は頭でなくボタンの行の右端に置く。
 * 題名は文字か、その場で編集する欄
 */
export function PanelHead({
  title,
  onClose,
  lead,
  aside,
}: {
  title: ReactNode;
  onClose: () => void;
  lead?: ReactNode;
  /** × の左に置くもの（記録のパネルの「Markdown をコピー」） */
  aside?: ReactNode;
}) {
  const t = useT();
  return (
    <div className="flex items-start gap-2">
      {lead}
      {typeof title === "string" ? (
        <h2 className="min-w-0 flex-1 font-semibold text-[18px] text-fg leading-6">{title}</h2>
      ) : (
        title
      )}
      {aside}
      <button
        type="button"
        aria-label={t("action.close")}
        onClick={onClose}
        className="inline-flex size-7 shrink-0 items-center justify-center rounded-control text-fg2 hover:bg-sunken hover:text-fg"
      >
        <X size={16} strokeWidth={1.5} aria-hidden="true" />
      </button>
    </div>
  );
}

/** 詳細パネルの「⋯」（その他の操作。メニューを開く） */
export function MoreButton({
  onClick,
  testId,
  className = "",
}: {
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  testId: string;
  className?: string;
}) {
  const t = useT();
  return (
    <button
      type="button"
      aria-label={t("menu.more")}
      data-testid={testId}
      onClick={onClick}
      className={`inline-flex size-8 shrink-0 items-center justify-center rounded-control text-fg2 hover:bg-sunken hover:text-fg ${className}`}
    >
      <MoreHorizontal size={16} strokeWidth={1.5} aria-hidden="true" />
    </button>
  );
}

/**
 * 詳細パネルの操作のボタン（主のボタンは1つ。他は枠のボタン。右にキーや ▾ を添える）。pressed は入り切りのボタン
 * （予定の「この予定の間は集中する」）、href は外へのリンク（会議に参加）
 */
export function ActionButton({
  children,
  primary = false,
  keys,
  onClick,
  testId,
  trail,
  pressed,
  href,
}: {
  trail?: ReactNode;
  children: ReactNode;
  primary?: boolean;
  keys?: string | undefined;
  onClick?: (e: React.MouseEvent<HTMLElement>) => void;
  testId?: string | undefined;
  pressed?: boolean | undefined;
  href?: string | undefined;
}) {
  const cls = `inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-card border px-2.5 font-medium text-body ${
    primary
      ? "border-accent bg-accent text-onaccent hover:opacity-90"
      : "border-line bg-bg text-fg hover:bg-sunken"
  }`;
  const inner = (
    <>
      {children}
      {keys ? <span className="font-mono text-[11px] opacity-70">{keys}</span> : null}
      {trail}
    </>
  );
  if (href)
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        data-testid={testId}
        data-primary={primary ? "" : undefined}
        className={cls}
      >
        {inner}
      </a>
    );
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      data-primary={primary ? "" : undefined}
      aria-pressed={pressed}
      data-on={pressed === undefined ? undefined : pressed ? "true" : "false"}
      className={cls}
    >
      {inner}
    </button>
  );
}

/** 詳細パネルの区切り（上の線と小見出し。「成果」「この項目の流れ」と同じ） */
export function PanelSection({
  title,
  testId,
  children,
}: {
  title: string;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2 border-line border-t pt-4" data-testid={testId}>
      <h3 className="font-semibold text-fg2 text-meta">{title}</h3>
      {children}
    </section>
  );
}

/** 属性の値（枠のない文字のボタン。押すとメニューやポップオーバー。タスク・予定の詳細パネル） */
export function ValueButton({
  children,
  onClick,
  testId,
  mono = false,
  empty = false,
}: {
  children: ReactNode;
  onClick: (el: HTMLElement) => void;
  testId: string;
  mono?: boolean;
  /** 値が無い（Inbox・未設定）。文字を薄くする */
  empty?: boolean;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={(e) => onClick(e.currentTarget)}
      className={`-mr-2 inline-flex h-7 min-w-0 items-center gap-1.5 rounded-control px-2 text-body hover:bg-sunken ${empty ? "text-fg2" : "text-fg"} ${mono ? "font-mono" : ""}`}
    >
      {children}
    </button>
  );
}

/** 読み取りだけの値（ValueButton と同じ位置・大きさの文字） */
export function ValueText({
  children,
  mono = false,
  testId,
  title,
}: {
  children: ReactNode;
  mono?: boolean;
  testId?: string;
  title?: string | undefined;
}) {
  return (
    <span
      data-testid={testId}
      title={title}
      className={`inline-flex h-7 min-w-0 items-center gap-1.5 text-body text-fg ${mono ? "font-mono" : ""}`}
    >
      {children}
    </span>
  );
}
