/**
 * 幅を変えられる右の詳細パネルの枠（ux-mvp 4.12.1）。左の縁をドラッグして幅を変え、ダブルクリックで既定（380px）に戻す。
 * 幅は設定 `ui.panel_width`（この Mac に1つ。全画面・全種類のパネルで共通）に、離したときにだけ保存する。
 *
 * - ドラッグ中は React を通さず枠の style.width を requestAnimationFrame で書き換える（中身を再描画しない）。
 *   ドラッグ中は <html data-panel-resizing> を付け、文字の選択を止めてカーソルを col-resize に保つ（styles.css）
 * - 範囲は core の clampPanelWidth（最小 320px、最大はパネルの左に PANEL_MAIN_MIN を残す幅）。窓の幅の変化は
 *   ResizeObserver で親（パネルとその左の領域を合わせた行）を測って当て直す。保存した値は変えない（窓を広げれば戻る）
 * - 縁は role="separator"。フォーカスして ←/→ で幅を変える（⇧ で4倍）。キーは止まってから保存する
 * - つまむ所はパネルの内側の 6px だけにする（左のボードの列のクリック・D&D の当たりを奪わない）
 */
import {
  clampPanelWidth,
  PANEL_WIDTH_MIN,
  PANEL_WIDTH_STEP,
  panelWidthMax,
} from "@turnlane/core/web";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { usePrefs, useSavePrefs } from "../data/prefs.tsx";
import { useT } from "../i18n/index.tsx";

/** キーで変えた幅を保存するまでの待ち */
const KEY_SAVE_MS = 400;

export function ResizablePanel({
  label,
  testId,
  className,
  children,
}: {
  label: string;
  testId: string;
  /** 中の aside の class（幅以外） */
  className: string;
  children: ReactNode;
}) {
  const t = useT();
  const prefs = usePrefs();
  const save = useSavePrefs();
  const wrap = useRef<HTMLDivElement>(null);
  const edge = useRef<HTMLDivElement>(null);
  const [row, setRow] = useState<number | null>(null);
  // キーで変えている間の幅（保存するまで）
  const [draft, setDraft] = useState<number | null>(null);
  const keyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useLayoutEffect(() => {
    const parent = wrap.current?.parentElement;
    if (!parent) return;
    setRow(parent.clientWidth);
    const ro = new ResizeObserver(() => setRow(parent.clientWidth));
    ro.observe(parent);
    return () => ro.disconnect();
  }, []);

  useEffect(
    () => () => {
      if (keyTimer.current) clearTimeout(keyTimer.current);
      delete document.documentElement.dataset.panelResizing;
    },
    [],
  );

  const width = clampPanelWidth(draft ?? prefs.panelWidth, row);
  const max = panelWidthMax(row);

  const commit = (w: number) => save.mutate({ panelWidth: w });

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !wrap.current || !edge.current) return;
    e.preventDefault();
    e.stopPropagation();
    const el = wrap.current;
    const handle = edge.current;
    const parent = el.parentElement;
    const rowNow = parent ? parent.clientWidth : row;
    const startX = e.clientX;
    const startW = el.getBoundingClientRect().width;
    let w = Math.round(startW);
    let frame = 0;
    handle.setPointerCapture(e.pointerId);
    handle.dataset.active = "";
    document.documentElement.dataset.panelResizing = "";
    const paint = () => {
      frame = 0;
      el.style.width = `${w}px`;
      handle.setAttribute("aria-valuenow", String(w));
    };
    const move = (ev: PointerEvent) => {
      w = clampPanelWidth(startW + (startX - ev.clientX), rowNow);
      if (!frame) frame = requestAnimationFrame(paint);
    };
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      handle.removeEventListener("lostpointercapture", end);
      if (frame) cancelAnimationFrame(frame);
      paint();
      delete handle.dataset.active;
      delete document.documentElement.dataset.panelResizing;
      if (w !== Math.round(startW)) commit(w);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
    handle.addEventListener("lostpointercapture", end);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = PANEL_WIDTH_STEP * (e.shiftKey ? 4 : 1);
    let next: number | null = null;
    // 縁が左へ動く（←）とパネルは広がる
    if (e.key === "ArrowLeft") next = width + step;
    else if (e.key === "ArrowRight") next = width - step;
    else if (e.key === "Home") next = PANEL_WIDTH_MIN;
    else if (e.key === "End") next = max;
    if (next === null) return;
    e.preventDefault();
    e.stopPropagation();
    const w = clampPanelWidth(next, row);
    setDraft(w);
    if (keyTimer.current) clearTimeout(keyTimer.current);
    keyTimer.current = setTimeout(() => {
      keyTimer.current = null;
      commit(w);
      setDraft(null);
    }, KEY_SAVE_MS);
  };

  return (
    <div
      ref={wrap}
      className="relative flex min-h-0 shrink-0"
      style={{ width }}
      data-testid="panel-frame"
    >
      <aside aria-label={label} className={`min-w-0 flex-1 ${className}`} data-testid={testId}>
        {children}
      </aside>
      {/* biome-ignore lint/a11y/useSemanticElements: 縦の区切りを動かす部品。<hr> はフォーカス・ドラッグを持てない */}
      <div
        ref={edge}
        role="separator"
        aria-orientation="vertical"
        aria-label={t("panel.resize")}
        aria-valuenow={width}
        aria-valuemin={PANEL_WIDTH_MIN}
        aria-valuemax={max}
        tabIndex={0}
        data-testid="panel-resize"
        onPointerDown={onPointerDown}
        onDoubleClick={() => {
          setDraft(null);
          save.mutate({ panelWidth: null });
        }}
        onKeyDown={onKeyDown}
        className="group/edge absolute inset-y-0 left-0 z-20 w-1.5 cursor-col-resize touch-none outline-none"
      >
        <span className="pointer-events-none absolute inset-y-0 left-0 w-0.5 bg-fg3 opacity-0 transition-opacity duration-100 group-hover/edge:opacity-100 group-focus-visible/edge:bg-accent group-focus-visible/edge:opacity-100 group-data-[active]/edge:bg-accent group-data-[active]/edge:opacity-100" />
      </div>
    </div>
  );
}
