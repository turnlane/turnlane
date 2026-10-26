/**
 * 飛んだ先の要素を少しの間強調する（設定の検索と同じ `dl-flash`。D-083）。データの読み込みを待つため、見つかるまで少しの間
 * 試す。見つけたら最初の要素を中央へ寄せ、全部を強調する
 */
export function flashEls(selector: string, tries = 30): void {
  const els = [...document.querySelectorAll<HTMLElement>(selector)];
  if (els.length === 0) {
    if (tries > 0) setTimeout(() => flashEls(selector, tries - 1), 50);
    return;
  }
  els[0]?.scrollIntoView({ block: "center" });
  for (const el of els) {
    el.classList.remove("dl-flash");
    void el.offsetWidth;
    el.classList.add("dl-flash");
    setTimeout(() => el.classList.remove("dl-flash"), 1600);
  }
}
