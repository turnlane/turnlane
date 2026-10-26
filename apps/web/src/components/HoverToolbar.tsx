/**
 * 行・カードのホバーで出るツールバー（UX 監査 A2。5.P3 の「ホバーで出る」層）。よく使う操作を3〜4個と `…`（右クリックと
 * 同じメニュー）。ボタンのツールチップは名前と今のキー（濃い地。Tooltip.tsx）。押しても行のクリック（選択・パネル）やドラッグを
 * 始めない。選んでいる行・カード（.group[data-selected]）でも出す（キーで選んだときにも ○ と同じく見える。D-139 (4)）。
 * 確定デザイン（部品シート）: 行の右端に 24px のアイコンボタンを並べ、地は行と同じ（行の文字の上に重ねて隠す）
 */
import { Ellipsis, type LucideIcon } from "lucide-react";
import type { SyntheticEvent } from "react";
import { useI18n } from "../i18n/index.tsx";
import { keyHint } from "../keys/keymap.ts";
import { tipProps } from "./Tooltip.tsx";

export interface ToolbarButton {
  id: string;
  icon: LucideIcon;
  label: string;
  /** ツールチップに添えるキー（keymap の id） */
  keyId?: string;
  /**
   * 塗った印にする（時間軸の完了済みのカードの ✓。押すと未完了に戻す。D-148）。アイコンを 16px の塗った丸の中に置く
   * （左の ○ の完了の見た目と同じ）
   */
  filled?: boolean;
  /**
   * ボタンの表示の指定（display を含める。例 `hidden @min-[480px]:inline-flex`: 狭い画面では出さない）。省略は常に出す
   */
  display?: string;
  onClick: (anchor: HTMLElement) => void;
}

const stop = (e: SyntheticEvent) => e.stopPropagation();
const BTN_BOX =
  "size-6 items-center justify-center rounded-control text-fg2 hover:bg-raised hover:text-fg hover:shadow-[0_0_0_1px_var(--dl-border)]";

export function HoverToolbar({
  buttons,
  onMore,
  className = "",
  align = "center",
  tipSide = "top",
}: {
  /** ボタンのツールチップの向き（帯の行は下。D-214 の §4） */
  tipSide?: "top" | "bottom";
  /** center: 行の高さの中央（1行の行）/ top: 上端（2行のカード） */
  align?: "center" | "top";
  buttons: ToolbarButton[];
  onMore?: (e: { clientX: number; clientY: number; preventDefault: () => void }) => void;
  className?: string;
}) {
  const { t } = useI18n();
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: 行のクリック・ドラッグに流さないための入れ物
    <span
      className={`dl-toolbar absolute right-1.5 z-[3] hidden ${align === "top" ? "top-1" : "top-1/2 -translate-y-1/2"} items-center gap-0.5 rounded-control bg-inherit pl-1 group-hover:flex group-data-[selected]:flex ${className}`}
      data-testid="hover-toolbar"
      onPointerDown={stop}
      onMouseDown={stop}
      onDoubleClick={stop}
    >
      {buttons.map((b) => {
        const k = b.keyId ? keyHint(b.keyId) : "";
        return (
          <button
            key={b.id}
            type="button"
            tabIndex={-1}
            {...tipProps(b.label, k, tipSide)}
            data-action={b.id}
            data-filled={b.filled ? "" : undefined}
            onClick={(e) => {
              e.stopPropagation();
              b.onClick(e.currentTarget);
            }}
            className={`${b.display ?? "inline-flex"} ${BTN_BOX}`}
          >
            {b.filled ? (
              <span className="inline-flex size-4 items-center justify-center rounded-full bg-fg text-bg">
                <b.icon size={11} strokeWidth={2.5} aria-hidden="true" />
              </span>
            ) : (
              <b.icon size={16} strokeWidth={1.5} aria-hidden="true" />
            )}
          </button>
        );
      })}
      {onMore ? (
        <button
          type="button"
          tabIndex={-1}
          {...tipProps(t("menu.more"), undefined, tipSide)}
          data-action="more"
          onClick={(e) => {
            e.stopPropagation();
            const r = e.currentTarget.getBoundingClientRect();
            onMore({ clientX: r.left, clientY: r.bottom + 2, preventDefault: () => {} });
          }}
          className={`inline-flex ${BTN_BOX}`}
        >
          <Ellipsis size={16} strokeWidth={1.5} aria-hidden="true" />
        </button>
      ) : null}
    </span>
  );
}
