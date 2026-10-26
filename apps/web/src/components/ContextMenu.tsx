/**
 * 右クリックメニュー（UX 監査 A1。5.P3 の「右クリック」の層）。マウスの位置に出し、行の右にキーを添える。
 * Esc・外側のクリック・スクロールで閉じる。↑↓ で行を移り ⏎ で実行する（画面のキーには流さない）。
 * panel のある行（カレンダーの色 ▸。D-125）はホバー・クリック・→・⏎ で右にサブメニューを開く（入らなければ左）。
 * サブメニューの中のキーはその中身が受け、← / Esc で back を呼んで行に戻る
 */
import { Check, ChevronRight, type LucideIcon } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { isImeKey } from "../lib/ime.ts";

export interface MenuEntry {
  id: string;
  label: string;
  /** 右に添えるキーの表記（`m`、`⌘⌫`）。無ければ出さない */
  keys?: string | undefined;
  /** 削除など。区切りの下に置き、文字を error 色にする */
  danger?: boolean | undefined;
  /** この行の前に区切りを入れる */
  sep?: boolean | undefined;
  /** 左のアイコン（確定デザインの部品シート: アイコン・名前・右にキー） */
  icon?: LucideIcon | undefined;
  /** アイコンの代わりの色の点（プロジェクトの一覧。null は色の無いもの） */
  swatch?: string | null | undefined;
  /** 今の値（右に ✓ を添える。見積・プロジェクトの選択） */
  checked?: boolean | undefined;
  /** 選ぶと次のメニュー（他の開き方）を開く。右に ▸ を添える */
  sub?: boolean | undefined;
  /** 行の右に開くサブメニューの中身（D-125 のパレット）。あれば run は呼ばない */
  panel?: ((ctx: SubPanelCtx) => ReactNode) | undefined;
  run: () => void;
}

export interface SubPanelCtx {
  /** メニューごと閉じる（選んだ後） */
  close: () => void;
  /** サブメニューを閉じて行に戻る（← / Esc） */
  back: () => void;
  /** キーで開いた（中身の最初の項目にフォーカスする） */
  autoFocus: boolean;
}

/** サブメニューの幅（パレット 6 × 24px と間） */
const SUB_W = 212;

export function ContextMenu({
  x,
  y,
  entries,
  onClose,
}: {
  x: number;
  y: number;
  entries: MenuEntry[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [active, setActive] = useState(-1);
  // 開いているサブメニュー（行の番号と、キーで開いたか）
  const [sub, setSub] = useState<{ index: number; keyboard: boolean } | null>(null);
  const subRef = useRef<HTMLDivElement>(null);
  const [subPos, setSubPos] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    const w = ref.current?.offsetWidth ?? 0;
    const h = ref.current?.offsetHeight ?? 0;
    const left = Math.max(8, Math.min(x, window.innerWidth - w - 8));
    const top = y + h > window.innerHeight - 8 ? Math.max(8, y - h) : y;
    setPos({ top, left });
  }, [x, y]);
  const pick = useCallback(
    (e: MenuEntry, i: number, keyboard: boolean) => {
      if (e.panel) {
        setActive(i);
        setSub({ index: i, keyboard });
        return;
      }
      onClose();
      e.run();
    },
    [onClose],
  );
  // サブメニューの置き場所: 行の右（入らなければ左）、行の上端に揃える
  useLayoutEffect(() => {
    if (!sub) {
      setSubPos(null);
      return;
    }
    const menu = ref.current;
    const row = menu?.querySelectorAll<HTMLElement>("[data-menu-id]")[sub.index];
    if (!menu || !row) return;
    const r = menu.getBoundingClientRect();
    const h = subRef.current?.offsetHeight ?? 0;
    const left = r.right + SUB_W - 4 > window.innerWidth - 8 ? -SUB_W + 4 : r.width - 4;
    let top = row.offsetTop - 5;
    if (r.top + top + h > window.innerHeight - 8) top = window.innerHeight - 8 - h - r.top;
    setSubPos({ top, left });
  }, [sub]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isImeKey(e)) return;
      // サブメニューの中のキーは中身が受ける（← / Esc は中身が back を呼ぶ）
      if (subRef.current?.contains(document.activeElement)) return;
      const cur = entries[active];
      if (e.key === "ArrowRight" && cur?.panel) {
        e.preventDefault();
        e.stopPropagation();
        pick(cur, active, true);
        return;
      }
      const handled = ["Escape", "ArrowDown", "ArrowUp", "Enter"].includes(e.key);
      if (!handled) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        if (sub) setSub(null);
        else onClose();
      } else if (e.key === "ArrowDown") {
        setSub(null);
        setActive((i) => (i + 1) % entries.length);
      } else if (e.key === "ArrowUp") {
        setSub(null);
        setActive((i) => (i <= 0 ? entries.length - 1 : i - 1));
      } else if (cur) pick(cur, active, true);
    };
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onScroll = (e: Event) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onClose);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("blur", onClose);
    };
  }, [entries, active, onClose, pick, sub]);
  const subEntry = sub ? entries[sub.index] : undefined;
  return createPortal(
    <div
      ref={ref}
      role="menu"
      tabIndex={-1}
      data-testid="context-menu"
      className="fixed z-50 w-[240px] rounded-pop border border-line bg-raised p-1 shadow-pop outline-none"
      style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999 }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {entries.map((e, i) => (
        <MenuRow
          key={e.id}
          entry={e}
          active={i === active}
          open={sub?.index === i}
          onHover={() => {
            setActive(i);
            // パネルのある行はホバーで開き、ほかの行に移ると閉じる
            if (e.panel) {
              if (sub?.index !== i) setSub({ index: i, keyboard: false });
            } else setSub(null);
          }}
          onPick={() => pick(e, i, false)}
        />
      ))}
      {sub && subEntry?.panel ? (
        <div
          ref={subRef}
          role="presentation"
          data-testid="context-submenu"
          className="absolute rounded-pop border border-line bg-raised p-1 shadow-pop"
          style={{ width: SUB_W, top: subPos?.top ?? -9999, left: subPos?.left ?? -9999 }}
        >
          {subEntry.panel({
            close: onClose,
            back: () => {
              setSub(null);
              setActive(sub.index);
              ref.current?.focus();
            },
            autoFocus: sub.keyboard,
          })}
        </div>
      ) : null}
    </div>,
    document.body,
  );
}

function MenuRow({
  entry,
  active,
  open,
  onHover,
  onPick,
}: {
  entry: MenuEntry;
  active: boolean;
  open: boolean;
  onHover: () => void;
  onPick: () => void;
}): ReactNode {
  return (
    <>
      {entry.sep ? <div className="mx-1.5 my-1 h-px bg-line" /> : null}
      <button
        type="button"
        {...(entry.checked !== undefined
          ? { role: "menuitemradio", "aria-checked": entry.checked }
          : { role: "menuitem" })}
        data-menu-id={entry.id}
        aria-haspopup={entry.panel ? "menu" : undefined}
        aria-expanded={entry.panel ? open : undefined}
        onMouseEnter={onHover}
        onClick={onPick}
        className={`flex h-7 w-full items-center gap-2 rounded-control px-2 text-left text-body ${
          active || open ? "bg-sunken" : ""
        } ${entry.danger ? "text-error" : "text-fg"}`}
      >
        {entry.icon ? (
          <entry.icon
            size={16}
            strokeWidth={1.5}
            aria-hidden="true"
            className={`shrink-0 ${entry.danger ? "text-error" : "text-fg2"}`}
          />
        ) : entry.swatch !== undefined ? (
          <span className="flex size-4 shrink-0 items-center justify-center" aria-hidden="true">
            <span
              className="size-2 rounded-full"
              style={{ background: entry.swatch ?? "var(--dl-text-3)" }}
            />
          </span>
        ) : null}
        <span className="min-w-0 flex-1 truncate">{entry.label}</span>
        {entry.keys ? (
          <span className="shrink-0 font-mono font-medium text-fg3 text-micro">{entry.keys}</span>
        ) : null}
        {entry.checked ? (
          <Check size={14} strokeWidth={1.5} aria-hidden="true" className="shrink-0 text-fg2" />
        ) : null}
        {entry.sub || entry.panel ? (
          <ChevronRight size={14} strokeWidth={1.5} aria-hidden="true" className="text-fg2" />
        ) : null}
      </button>
    </>
  );
}
