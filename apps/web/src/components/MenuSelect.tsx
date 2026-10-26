/**
 * 選択の欄（OS の select の代わり。D-138）: 今の値の文字と ▾ のボタンで、押すと右クリックと同じメニュー（ContextMenu）に
 * 選択肢を並べ、今の値に ✓ を添える。色の点（swatch）も出せる。キーは ⏎ / Space で開き、↑↓ で移り ⏎ で選ぶ、Esc で閉じる
 * （メニューの部品のまま）。設定画面の選択の欄（プロジェクトのアカウント・開くアプリ・カレンダーの役割など）に使う
 */
import { ChevronDown } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { ContextMenu } from "./ContextMenu.tsx";

export interface MenuOption<T extends string> {
  value: T;
  label: string;
  /** 左の色の点（null は色の無いもの） */
  swatch?: string | null | undefined;
  /** この行の前に区切り */
  sep?: boolean | undefined;
}

export function MenuSelect<T extends string>({
  value,
  options,
  onChange,
  label,
  display,
  testId,
  className = "",
  size = "md",
  placeholder,
}: {
  value: T | null;
  options: MenuOption<T>[];
  onChange: (v: T) => void;
  /** 読み上げの名前（欄の見出し） */
  label: string;
  /** ボタンに出す文字（省略は選んでいる選択肢の名前） */
  display?: ReactNode;
  testId?: string | undefined;
  className?: string;
  /** md: 高さ 28px（text-body）/ sm: 24px（text-meta） */
  size?: "sm" | "md";
  /** 値が選択肢に無いときの文字 */
  placeholder?: string | undefined;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  // 開いているメニューの外を押すと閉じる（mousedown）。同じボタンの click で開き直さない
  const closedAt = useRef(0);
  const cur = options.find((o) => o.value === value);
  const open = () => {
    const r = ref.current?.getBoundingClientRect();
    if (r) setMenu({ x: r.left, y: r.bottom + 4 });
  };
  return (
    <>
      <button
        ref={ref}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        data-testid={testId}
        data-value={value ?? ""}
        onClick={() => {
          if (Date.now() - closedAt.current < 300) return;
          if (menu) setMenu(null);
          else open();
        }}
        className={`inline-flex min-w-0 items-center gap-1.5 rounded-card border border-line bg-bg px-2 text-left outline-none hover:border-fg3 focus-visible:border-accent ${
          size === "sm" ? "h-6 text-meta" : "h-7 text-body"
        } ${cur || display ? "text-fg" : "text-fg3"} ${className}`}
      >
        {display ??
          (cur ? (
            <>
              {cur.swatch !== undefined ? (
                <span
                  className="size-2 shrink-0 rounded-full"
                  style={{ background: cur.swatch ?? "var(--dl-text-3)" }}
                  aria-hidden="true"
                />
              ) : null}
              <span className="min-w-0 flex-1 truncate">{cur.label}</span>
            </>
          ) : (
            <span className="min-w-0 flex-1 truncate">{placeholder ?? ""}</span>
          ))}
        <ChevronDown
          size={14}
          strokeWidth={1.5}
          aria-hidden="true"
          className="ml-auto shrink-0 text-fg2"
        />
      </button>
      {menu ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => {
            closedAt.current = Date.now();
            setMenu(null);
            ref.current?.focus();
          }}
          entries={options.map((o) => ({
            id: `opt-${o.value}`,
            label: o.label,
            checked: o.value === value,
            sep: o.sep,
            ...(o.swatch !== undefined ? { swatch: o.swatch } : {}),
            run: () => {
              if (o.value !== value) onChange(o.value);
            },
          }))}
        />
      ) : null}
    </>
  );
}
