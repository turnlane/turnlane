/**
 * カレンダーの色のパレット（D-125。R52）。Google カレンダーの色の選択のように色の丸を並べ、選んでいる色にチェック。
 * 下に区切りと「カレンダーの色に戻す」（カレンダーアプリの色の丸。戻すとカレンダーアプリの色に従う）。
 * 設定 > カレンダー の色の丸（ポップオーバー）と、予定の右クリック「カレンダーの色 ▸」（サブメニュー）で使う。
 * 色は Turnlane の中だけに保存し、カレンダーアプリ・Google 側の色は書き換えない
 */
import type { CalendarColorKey } from "@turnlane/core/web";
import { Check } from "lucide-react";
import { type KeyboardEvent, useRef, useState } from "react";
import { setCalendarColor } from "../data/mutations.ts";
import { useI18n } from "../i18n/index.tsx";
import {
  CAL_COLOR_FALLBACK,
  calColor,
  calColorVar,
  PALETTE,
  paletteLabel,
} from "../lib/cal-color.ts";
import { hideTip, tipProps } from "./Tooltip.tsx";
import { Popover } from "./ui.tsx";

/** 1行の色の数（12色を 6 × 2） */
const COLS = 6;
/** ライトで白のチェックが見えにくい明るい色（チェックを text-primary にする） */
const DARK_CHECK: ReadonlySet<CalendarColorKey> = new Set(["orange", "yellow", "lime", "sky"]);

export function PaletteGrid({
  value,
  sourceColor,
  onPick,
  autoFocus = false,
  onExit,
}: {
  /** 選んでいる色（null ならカレンダーアプリの色） */
  value: CalendarColorKey | null;
  /** カレンダーアプリの色（戻す行の丸） */
  sourceColor: string | null;
  onPick: (key: CalendarColorKey | null) => void;
  /** 開いたら選んでいる色（無ければ先頭）にフォーカスする（右クリックのサブメニューを → で開いたとき） */
  autoFocus?: boolean;
  /** 左端の ← と Esc（右クリックのサブメニューから行に戻る） */
  onExit?: (() => void) | undefined;
}) {
  const { t } = useI18n();
  const box = useRef<HTMLDivElement>(null);
  // ↑↓←→ で丸と戻す行を移る（戻す行は最後）
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = [...(box.current?.querySelectorAll<HTMLButtonElement>("[data-cal-color]") ?? [])];
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    // ⏎・Space はボタンの既定の動き（押す）だけにして、画面のキー（開く・完了など）に流さない
    if (e.key === "Enter" || e.key === " ") {
      e.stopPropagation();
      return;
    }
    if (e.key === "Escape" && onExit) {
      e.preventDefault();
      e.stopPropagation();
      onExit();
      return;
    }
    const n = PALETTE.length;
    let j = i;
    if (e.key === "ArrowRight") j = Math.min(items.length - 1, i + 1);
    else if (e.key === "ArrowLeft") {
      if ((i % COLS === 0 || i >= n) && onExit) {
        // 左端の ← はサブメニューを閉じて行に戻る
        e.preventDefault();
        e.stopPropagation();
        onExit();
        return;
      }
      j = Math.max(0, i - 1);
    } else if (e.key === "ArrowDown") j = i >= n ? i : Math.min(n, i + COLS);
    else if (e.key === "ArrowUp") j = i >= n ? n - COLS : Math.max(0, i - COLS);
    else return;
    e.preventDefault();
    e.stopPropagation();
    items[j]?.focus();
  };
  return (
    <div
      ref={box}
      role="menu"
      aria-label={t("calColor.title")}
      data-testid="cal-palette"
      onKeyDown={onKey}
      className="flex flex-col gap-1"
    >
      <div className="grid grid-cols-6 gap-1.5 p-2">
        {PALETTE.map((k, i) => {
          const on = value === k;
          return (
            <button
              key={k}
              type="button"
              role="menuitemradio"
              aria-checked={on}
              data-cal-color={k}
              // biome-ignore lint/a11y/noAutofocus: キーで開いたサブメニューは選んでいる色から動かす
              autoFocus={autoFocus && (on || (value === null && i === 0))}
              {...tipProps(t(paletteLabel(k)))}
              onClick={() => {
                hideTip();
                onPick(k);
              }}
              className="dl-cal-swatch grid size-6 place-items-center rounded-full outline-none"
              style={{ background: calColorVar(k) }}
            >
              {on ? (
                <Check
                  size={14}
                  strokeWidth={2.5}
                  aria-hidden="true"
                  className={`dl-cal-check ${DARK_CHECK.has(k) ? "dl-cal-check-dark" : ""}`}
                />
              ) : null}
            </button>
          );
        })}
      </div>
      <div className="mx-1.5 h-px bg-line" />
      <button
        type="button"
        role="menuitemradio"
        aria-checked={value === null}
        data-cal-color="reset"
        onClick={() => onPick(null)}
        title={t("calColor.resetHint")}
        className="flex h-7 w-full items-center gap-2 rounded-control px-2 text-left text-body text-fg outline-none hover:bg-sunken focus-visible:bg-sunken"
      >
        <span
          className="dl-cal-swatch size-4 shrink-0 rounded-full"
          style={{ background: sourceColor ?? CAL_COLOR_FALLBACK }}
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1 truncate">{t("calColor.reset")}</span>
        {value === null ? (
          <Check size={14} strokeWidth={1.5} aria-hidden="true" className="shrink-0 text-fg2" />
        ) : null}
      </button>
    </div>
  );
}

/** 設定 > カレンダー の各カレンダーの色の丸。押すとパレットのポップオーバー */
export function CalendarColorButton({
  calendar,
}: {
  calendar: { id: string; name: string; color: string | null; colorKey: CalendarColorKey | null };
}) {
  const { t } = useI18n();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return (
    <>
      <button
        type="button"
        data-testid="cal-color-button"
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        {...tipProps(t("calColor.change", { name: calendar.name }))}
        onClick={(e) => {
          hideTip();
          setAnchor(anchor ? null : e.currentTarget);
        }}
        className="grid size-6 shrink-0 place-items-center rounded-control hover:bg-sunken focus-visible:outline-accent"
      >
        <span
          className="dl-cal-swatch size-3 rounded-full"
          style={{ background: calColor(calendar.color, calendar.colorKey) }}
          aria-hidden="true"
        />
      </button>
      {anchor ? (
        <Popover anchor={anchor} onClose={() => setAnchor(null)} className="w-[212px]">
          <PaletteGrid
            value={calendar.colorKey}
            sourceColor={calendar.color}
            autoFocus
            onPick={(k) => {
              setAnchor(null);
              void setCalendarColor(calendar.id, k);
            }}
          />
        </Popover>
      ) : null}
    </>
  );
}
