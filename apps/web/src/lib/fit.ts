/**
 * 狭い幅の規則（B-1。D-193）の道具。固定の px の閾値は置かず、「はみ出したら 1 つ省いて測り直す」を繰り返す（3日ボードの
 * 見出しの集計と同じ考え）。
 * - useFitSteps: 要素がはみ出している間、省く段を 1 つずつ進める（max まで）。幅が変わったら 0 から測り直す
 * - useWindowWidth: ウインドウの幅（側の列の帯・サイドバーの自動の畳み・デイビューの右の一覧の出し分けの条件）
 */
import { type RefObject, useEffect, useLayoutEffect, useState } from "react";

/** 文字が要素の幅からはみ出しているか（1px 未満のはみ出しも見る） */
export function overflowsX(el: HTMLElement): boolean {
  return el.scrollWidth > el.clientWidth + 0.5;
}

export function useFitSteps(ref: RefObject<HTMLElement | null>, max: number): number {
  const [fit, setFit] = useState<{ w: number; n: number }>({ w: 0, n: 0 });
  const [, setTick] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const refit = () => {
      setFit({ w: el.clientWidth, n: 0 });
      setTick((x) => x + 1);
    };
    let w = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth !== w) {
        w = el.clientWidth;
        refit();
      }
    });
    ro.observe(el);
    const fonts = document.fonts;
    fonts?.addEventListener("loadingdone", refit);
    return () => {
      ro.disconnect();
      fonts?.removeEventListener("loadingdone", refit);
    };
  }, [ref]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && overflowsX(el) && fit.n < max) setFit({ w: el.clientWidth, n: fit.n + 1 });
  });
  return fit.n;
}

export function useWindowWidth(): number {
  const [w, setW] = useState(() => (typeof window === "undefined" ? 1440 : window.innerWidth));
  useEffect(() => {
    const on = () => setW(window.innerWidth);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return w;
}
