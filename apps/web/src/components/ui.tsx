/**
 * 基本部品（M2-11）: ボタン、キー表示、ソースバッジ、mono のメタ、警告、丸いチェックボックス、ポップオーバー。
 * 色はトークンだけを使う。琥珀は needs_input 専用で、警告は無彩色の三角＋text-primary（C3）。
 */
import type { SourceBadge as SourceBadgeData } from "@turnlane/core/web";
import { TriangleAlert } from "lucide-react";
import {
  type ButtonHTMLAttributes,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { isImeKey } from "../lib/ime.ts";

export function Button({
  variant = "secondary",
  size = "md",
  className = "",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost";
  size?: "sm" | "md";
}) {
  // 主ボタンは無彩色（text-primary の塗り。D-104）。1つの画面に1つ
  const v =
    variant === "primary"
      ? "border border-accent bg-accent text-onaccent hover:opacity-90"
      : variant === "ghost"
        ? "text-fg2 hover:bg-sunken hover:text-fg"
        : "border border-line bg-raised text-fg hover:border-fg3";
  const s = size === "sm" ? "h-6 px-2 text-meta" : "h-7 px-2.5 text-body";
  return (
    <button
      type="button"
      className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-card font-medium transition-colors disabled:opacity-50 ${v} ${s} ${className}`}
      {...rest}
    />
  );
}

/** キー表示（mono、ASCII と記号のみ） */
export function Kbd({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={`inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-chip border border-line px-1 font-mono text-micro text-fg2 ${className}`}
    >
      {children}
    </kbd>
  );
}

const TOOL_BADGE: Record<string, string> = {
  claude_code: "CC",
  codex: "CX",
  claude_desktop: "CD",
};

export function sourceBadgeText(s: SourceBadgeData): string {
  const base = TOOL_BADGE[s.tool] ?? s.tool.slice(0, 2).toUpperCase();
  return s.profile ? `${base}·${s.profile}` : base;
}

/** ソースバッジ `CC` / `CX` / `CD`、複数アカウントは `CC·main`（mono の枠なしの小さい文字。design の週ボード） */
export function SourceBadges({
  sources,
  className = "",
}: {
  sources: SourceBadgeData[];
  className?: string;
}) {
  if (sources.length === 0) return null;
  return (
    <span className={`inline-flex shrink-0 gap-1 font-mono text-micro text-fg3 ${className}`}>
      {sources.map((s) => (
        <span key={`${s.tool}:${s.profile ?? ""}`}>{sourceBadgeText(s)}</span>
      ))}
    </span>
  );
}

/** 枠付きのチップ（外部タスクのソース `github`、経由 `CLI` など） */
export function Chip({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={`inline-flex h-4 shrink-0 items-center rounded-chip border border-line px-1 font-mono text-micro text-fg2 ${className}`}
    >
      {children}
    </span>
  );
}

/** mono のメタ行（`api-gateway · fix/auth-refresh`） */
export function Meta({ parts, className = "" }: { parts: (string | null)[]; className?: string }) {
  const xs = parts.filter((p): p is string => !!p);
  if (xs.length === 0) return null;
  return (
    <span className={`truncate font-mono text-meta text-fg3 ${className}`}>{xs.join(" · ")}</span>
  );
}

/** 警告（無彩色の三角＋text-primary。C3） */
export function Warning({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 text-fg">
      <TriangleAlert size={12} strokeWidth={1.5} aria-hidden="true" />
      <span>{children}</span>
    </span>
  );
}

/**
 * 丸いチェックボックス（自分のタスク。AI 項目には付けない）。完了は黒く塗った ✓（オーナーの画像 T4。docs/design/README.md）。
 * reveal: 一覧の行・カードの ○ は、ふだんは出さずにマウスを乗せたとき（.group:hover）・選んでいるとき（.group[data-selected]）・
 * キーでフォーカスしたときだけ出す（D-139 (4)）。透明にするだけで、場所は取ったまま（題名の位置が動かない）・支援技術からも読める
 */
export function Check({
  checked,
  dashed = false,
  onToggle,
  label,
  reveal = false,
}: {
  checked: boolean;
  /** 解決済み（推定）は破線のチェック */
  dashed?: boolean;
  onToggle?: () => void;
  label: string;
  reveal?: boolean;
}) {
  const hide =
    reveal && !checked
      ? "opacity-0 group-hover:opacity-100 group-data-[selected]:opacity-100 focus-visible:opacity-100"
      : "";
  return (
    // biome-ignore lint/a11y/useSemanticElements: 丸いチェックボックスの見た目のため button に role を付ける
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      tabIndex={-1}
      data-reveal={reveal && !checked ? "" : undefined}
      onClick={(e) => {
        e.stopPropagation();
        onToggle?.();
      }}
      className={`inline-flex size-4 shrink-0 items-center justify-center rounded-full border-[1.5px] outline-none focus-visible:ring-2 focus-visible:ring-accent ${
        checked ? "border-fg bg-fg text-bg" : "border-fg3 bg-raised text-fg3 hover:border-fg2"
      } ${dashed ? "border-dashed bg-transparent text-fg2" : ""} ${hide}`}
    >
      <svg
        width="9"
        height="9"
        viewBox="0 0 8 8"
        aria-hidden="true"
        className={checked ? "" : "opacity-0 group-hover:opacity-60"}
      >
        <path
          d="M1.3 4.2 3.2 6 6.8 2"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}

/** アンカー要素の下に出すポップオーバー（Esc・外側クリックで閉じる） */
export function Popover({
  anchor,
  onClose,
  children,
  align = "start",
  className = "",
  style,
}: {
  anchor: HTMLElement | null;
  onClose: () => void;
  children: ReactNode;
  align?: "start" | "end";
  className?: string;
  style?: React.CSSProperties | undefined;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    if (!anchor) return;
    const place = () => {
      const r = anchor.getBoundingClientRect();
      const w = ref.current?.offsetWidth ?? 0;
      const h = ref.current?.offsetHeight ?? 0;
      let top = r.bottom + 4;
      if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 4);
      let left = align === "end" ? r.right - w : r.left;
      left = Math.min(Math.max(8, left), window.innerWidth - w - 8);
      setPos((p) => (p && p.top === top && p.left === left ? p : { top, left }));
    };
    place();
    // 中身が伸びたら（作成のポップオーバーで「AI に頼む」を開いた等）置き直す
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(place);
    ro.observe(el);
    return () => ro.disconnect();
  }, [anchor, align]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 変換中の Esc は変換の取り消し。ポップオーバー（新規タスク・題名・日付の入力）を閉じない
      if (e.key === "Escape" && !isImeKey(e)) {
        e.stopPropagation();
        onClose();
      }
    };
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("mousedown", onDown);
    };
  }, [onClose]);
  return createPortal(
    <div
      ref={ref}
      role="dialog"
      className={`fixed z-50 rounded-pop border border-line bg-raised p-1 shadow-pop ${className}`}
      style={{ ...style, top: pos?.top ?? -9999, left: pos?.left ?? -9999 }}
    >
      {children}
    </div>,
    document.body,
  );
}

/** ポップオーバー内のメニュー項目 */
export function MenuItem({
  children,
  hint,
  onSelect,
  active = false,
}: {
  children: ReactNode;
  hint?: ReactNode;
  onSelect: () => void;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`flex h-7 w-full items-center justify-between gap-4 rounded-control px-2 text-left text-body ${
        active ? "bg-sunken text-fg" : "text-fg hover:bg-sunken"
      }`}
    >
      <span>{children}</span>
      {hint ? <span className="font-mono text-micro text-fg3">{hint}</span> : null}
    </button>
  );
}

/** 確認ダイアログ（中央。Esc で取り消し、⏎ で実行）。AI カードの統合（ux-mvp 7章）で使う */
export function ConfirmDialog({
  title,
  body,
  note,
  confirm,
  cancel,
  destructive = false,
  onConfirm,
  onCancel,
}: {
  title: string;
  body: string;
  /** 本文の下のもう1段落（無ければ出さない） */
  note?: string;
  confirm: string;
  cancel: string;
  /**
   * 取り消せない操作（消す・捨てる）。確定のボタンを赤い字（面は塗らない）にし、やめるのボタンに Esc を付ける
   */
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isImeKey(e)) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onCancel();
      } else if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        onConfirm();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onConfirm, onCancel]);
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
      <div
        role="alertdialog"
        aria-label={title}
        className={`${destructive ? "w-[480px]" : "w-[420px]"} max-w-[calc(100vw-32px)] rounded-pop border border-line bg-raised p-4 shadow-pop`}
        data-testid="confirm-dialog"
      >
        <h2 className="font-semibold text-body">{title}</h2>
        <p className="mt-1.5 text-body text-fg2">{body}</p>
        {note ? <p className="mt-1.5 text-body text-fg2">{note}</p> : null}
        <div className="mt-4 flex justify-end gap-2">
          {destructive ? (
            <>
              <Button variant="ghost" onClick={onCancel}>
                {cancel}
                <Kbd>{"Esc"}</Kbd>
              </Button>
              <button
                type="button"
                onClick={onConfirm}
                className="inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-card border border-line bg-raised px-2.5 font-medium text-body text-error transition-colors hover:border-fg3"
                data-testid="confirm-destructive"
              >
                {confirm}
                <Kbd className="border-error/40 text-error">⏎</Kbd>
              </button>
            </>
          ) : (
            <>
              <Button onClick={onCancel}>{cancel}</Button>
              <Button variant="primary" onClick={onConfirm}>
                {confirm}
                <Kbd className="border-onaccent/30 text-onaccent">⏎</Kbd>
              </Button>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
