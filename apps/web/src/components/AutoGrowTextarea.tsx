/**
 * 行数に合わせて高さが伸びる textarea（AI に頼むの指示・タスクのメモ）。
 * - 最小は minRows（CSS の min-height があれば大きいほう）。上限は maxRows と、fitViewport なら入っている枠（role="dialog"）が
 *   画面に収まる高さ（ただし FLOOR_ROWS 行は下回らない）。上限を超えたら中でスクロールする
 * - 右下のつまみ（resize: vertical）で手で広げた高さは、自動の縮みの下限にする（手で狭めたら、その高さが新しい下限）
 * - 貼り付け・削除も value の変化で測り直す。窓の高さ・欄の幅が変わったら測り直す
 */
import { type Ref, type TextareaHTMLAttributes, useEffect, useLayoutEffect, useRef } from "react";

/** fitViewport の上限の下限（画面が低くてもこの行数までは伸ばす） */
export const FLOOR_ROWS = 4;
/** 画面の上下に残す余白（Popover と同じ 8px ずつ） */
const VIEWPORT_MARGIN = 16;

/**
 * 高さを決める（純粋関数）。content: 中身の高さ、min: 最小、max: 自動で伸ばす上限、manual: 手で広げた高さ（無ければ 0）、
 * hardMax: 手で広げても超えない上限（枠が画面に収まる高さ。無ければ Infinity）
 */
export function growHeight(p: {
  content: number;
  min: number;
  max: number;
  manual: number;
  hardMax: number;
}): number {
  const auto = Math.min(Math.max(p.content, p.min), p.max);
  return Math.max(p.min, Math.min(Math.max(auto, p.manual), p.hardMax));
}

/** 中身の高さを測るために縮めたとき、外側のスクロールの位置が飛ばないように戻す */
function scrollParents(el: HTMLElement): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (let p = el.parentElement; p; p = p.parentElement) {
    if (p.scrollHeight > p.clientHeight) out.push(p);
  }
  return out;
}

export function AutoGrowTextarea({
  minRows = 2,
  maxRows,
  fitViewport = false,
  ref,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement> & {
  minRows?: number;
  maxRows?: number;
  /** 入っている枠（role="dialog"）が画面からはみ出さない高さまでにする */
  fitViewport?: boolean;
  ref?: Ref<HTMLTextAreaElement>;
}) {
  const own = useRef<HTMLTextAreaElement | null>(null);
  /** 自分で最後に付けた高さ（ResizeObserver で手の変化と区別する） */
  const last = useRef(0);
  /** 手で広げた高さ（自動の縮みの下限） */
  const manual = useRef(0);

  const fit = () => {
    const el = own.current;
    if (!el) return;
    const cs = getComputedStyle(el);
    const line = Number.parseFloat(cs.lineHeight) || 18;
    const border = Number.parseFloat(cs.borderTopWidth) + Number.parseFloat(cs.borderBottomWidth);
    const frame = Number.parseFloat(cs.paddingTop) + Number.parseFloat(cs.paddingBottom) + border;
    const rows = (n: number) => n * line + frame;
    const min = Math.max(rows(minRows), Number.parseFloat(cs.minHeight) || 0);
    let hardMax = Number.POSITIVE_INFINITY;
    if (fitViewport) {
      const box = el.closest<HTMLElement>('[role="dialog"]');
      if (box) {
        const room = window.innerHeight - VIEWPORT_MARGIN - (box.offsetHeight - el.offsetHeight);
        hardMax = Math.max(room, rows(FLOOR_ROWS), min);
      }
    }
    const max = Math.min(maxRows ? rows(maxRows) : Number.POSITIVE_INFINITY, hardMax);
    const parents = scrollParents(el).map((p) => [p, p.scrollTop] as const);
    el.style.height = `${min}px`;
    const content = el.scrollHeight + border;
    const h = growHeight({ content, min, max, manual: manual.current, hardMax });
    el.style.height = `${h}px`;
    el.style.maxHeight = Number.isFinite(hardMax) ? `${hardMax}px` : "";
    el.style.overflowY = content > h + 1 ? "auto" : "hidden";
    for (const [p, top] of parents) p.scrollTop = top;
    last.current = el.offsetHeight;
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: 値が変わるたびに測り直す
  useLayoutEffect(fit, [rest.value, minRows, maxRows, fitViewport]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: 付けるのは最初の1回
  useEffect(() => {
    const el = own.current;
    if (!el) return;
    const onWin = () => fit();
    window.addEventListener("resize", onWin);
    // 右下のつまみで高さが変わった（自分で付けた高さと違う）→ 手の高さを下限にする。幅が変わったら折り返しが変わるので測り直す
    let width = el.offsetWidth;
    const ro =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            const h = el.offsetHeight;
            if (el.offsetWidth !== width) {
              width = el.offsetWidth;
              fit();
            } else if (last.current && Math.abs(h - last.current) > 1) {
              manual.current = h;
              last.current = h;
              el.style.overflowY = el.scrollHeight > el.clientHeight + 1 ? "auto" : "hidden";
            }
          });
    ro?.observe(el);
    return () => {
      window.removeEventListener("resize", onWin);
      ro?.disconnect();
    };
  }, []);

  const setRef = (el: HTMLTextAreaElement | null) => {
    own.current = el;
    if (typeof ref === "function") ref(el);
    else if (ref) ref.current = el;
  };
  return <textarea ref={setRef} rows={minRows} {...rest} data-autogrow="" />;
}
