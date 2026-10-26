/**
 * 直前のポインタ操作の修飾キー（⇧ / ⌘ クリックの複数選択。UX 監査 A14）。行・カードのクリックは多くの部品を通るので、
 * イベントを受け渡す代わりに、押した時点の修飾キーをここに覚える（キーを押したら消す: ⏎ でのクリックは修飾なし）
 */
let mods = { shift: false, meta: false };

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener(
    "pointerdown",
    (e) => {
      mods = { shift: e.shiftKey, meta: e.metaKey || e.ctrlKey };
    },
    true,
  );
  window.addEventListener(
    "keydown",
    () => {
      mods = { shift: false, meta: false };
    },
    true,
  );
}

export function lastPointerMods(): { shift: boolean; meta: boolean } {
  return mods;
}
