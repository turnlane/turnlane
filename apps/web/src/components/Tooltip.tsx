/**
 * ツールチップ（確定デザインの部品シート: 濃い地に名前と今のキー）。ホバーのボタン・畳んだサイドバーのアイコンに付ける。
 * 画面に1つだけ出す（TooltipLayer を画面の外枠に1つ置く）。親の overflow で切れないよう body に描く
 */
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

interface Tip {
  rect: { top: number; left: number; right: number; bottom: number; width: number };
  label: string;
  keys?: string | undefined;
  /** bottom: 行の下に出す（帯の行のボタン。上の行の理由に重ねない。D-214 の §4） */
  side: "top" | "right" | "bottom";
  /** 的の要素（画面から外れたら消す。押した結果でカードが描き直されると mouseleave・blur が来ないため） */
  anchor: Element;
}

let current: Tip | null = null;
const listeners = new Set<() => void>();
const set = (t: Tip | null) => {
  current = t;
  for (const l of listeners) l();
};

/** ツールチップを消す（押したときなど） */
export function hideTip(): void {
  set(null);
}

/** キーでのフォーカスか（押したときのフォーカスでは出さない。WebKit は tabIndex を持つボタンを押すとフォーカスする） */
function keyboardFocus(el: Element): boolean {
  try {
    return el.matches(":focus-visible");
  } catch {
    return true;
  }
}

/**
 * ボタンに付けるハンドラ（ホバー・キーのフォーカスで出し、離れる・押すと消す）。押したときのフォーカスでは出し直さない
 * （押した後も「完了 Space」が残った。2026-10-16）
 */
export function tipProps(label: string, keys?: string, side: Tip["side"] = "top") {
  const show = (e: { currentTarget: Element }) => {
    const r = e.currentTarget.getBoundingClientRect();
    set({
      rect: { top: r.top, left: r.left, right: r.right, bottom: r.bottom, width: r.width },
      label,
      keys: keys || undefined,
      side,
      anchor: e.currentTarget,
    });
  };
  const hide = () => set(null);
  return {
    onMouseEnter: show,
    onMouseLeave: hide,
    onFocus: (e: { currentTarget: Element }) => {
      if (keyboardFocus(e.currentTarget)) show(e);
    },
    onBlur: hide,
    onMouseDown: hide,
    "aria-label": label,
  };
}

/** 画面の端からの余白（px） */
const EDGE = 4;
/** 的との間（px） */
const GAP = 6;

type Rect = Tip["rect"];

/**
 * ツールチップの置き場所（D-117: ウインドウの端で切らない）。上に出すものは上に入らなければ下に、右に出すものは右に
 * 入らなければ左に出し、そのうえで画面の内側に寄せる。size はツールチップの大きさ、view は画面の大きさ
 */
export function placeTip(
  side: Tip["side"],
  r: Rect,
  size: { width: number; height: number },
  view: { width: number; height: number },
): { top: number; left: number; side: "top" | "bottom" | "right" | "left" } {
  const clampX = (x: number) => Math.max(EDGE, Math.min(x, view.width - size.width - EDGE));
  const clampY = (y: number) => Math.max(EDGE, Math.min(y, view.height - size.height - EDGE));
  if (side === "right") {
    const cy = r.top + (r.bottom - r.top) / 2 - size.height / 2;
    const right = r.right + GAP + 2;
    if (right + size.width + EDGE <= view.width)
      return { top: clampY(cy), left: right, side: "right" };
    return { top: clampY(cy), left: clampX(r.left - GAP - 2 - size.width), side: "left" };
  }
  const cx = clampX(r.left + r.width / 2 - size.width / 2);
  const below = r.bottom + GAP;
  if (side === "bottom" && below + size.height + EDGE <= view.height)
    return { top: below, left: cx, side: "bottom" };
  const above = r.top - GAP - size.height;
  if (above >= EDGE) return { top: above, left: cx, side: "top" };
  return { top: clampY(r.bottom + GAP), left: cx, side: "bottom" };
}

export function TooltipLayer() {
  const tip = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
    () => current,
  );
  const ref = useRef<HTMLDivElement>(null);
  // 的が画面から外れたら消す（時間軸のカードは完了でドラッグの入れ物が外れて描き直され、ボタンが別の要素になる）
  useEffect(() => {
    if (!tip) return;
    if (!tip.anchor.isConnected) {
      hideTip();
      return;
    }
    const mo = new MutationObserver(() => {
      if (current === tip && !tip.anchor.isConnected) hideTip();
    });
    mo.observe(document.body, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, [tip]);
  const [pos, setPos] = useState<{ tip: Tip; top: number; left: number; side: string } | null>(
    null,
  );
  // 描いてから大きさを測って置き直す（測るまでは見せない）
  useLayoutEffect(() => {
    const el = ref.current;
    if (!tip || !el) return;
    const p = placeTip(
      tip.side,
      tip.rect,
      { width: el.offsetWidth, height: el.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight },
    );
    setPos({ tip, ...p });
  }, [tip]);
  if (!tip) return null;
  const placed = pos && pos.tip === tip ? pos : null;
  return createPortal(
    <div
      ref={ref}
      role="tooltip"
      data-testid="tooltip"
      data-side={placed?.side}
      className="pointer-events-none fixed z-[60] flex max-w-[360px] items-center gap-2 whitespace-nowrap rounded-control bg-fg px-2 py-1 text-bg text-meta shadow-pop"
      style={{
        top: placed?.top ?? 0,
        left: placed?.left ?? 0,
        visibility: placed ? "visible" : "hidden",
      }}
    >
      {/* 複数行（取り込みの状態など）は改行を残して折り返す */}
      <span className="whitespace-pre-line">{tip.label}</span>
      {tip.keys ? <span className="font-mono text-micro opacity-70">{tip.keys}</span> : null}
    </div>,
    document.body,
  );
}
