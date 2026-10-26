/**
 * IME（日本語入力など）の変換中・変換確定のキーを、アプリの操作として扱わないための共通の判定。
 *
 * ブラウザごとにイベントの順序が違う:
 * - Chrome 型: keydown(isComposing=true, keyCode=229) → compositionend
 * - WebKit 型（Safari・WKWebView）: compositionend → keydown(isComposing=false, keyCode=229)。
 *   版や IME によっては keyCode も 13 で来ることがある
 *
 * そのため `isComposing`・`keyCode === 229`・compositionstart/end の追跡を組み合わせ、
 * compositionend の直後（同じ打鍵）に来た ⏎ / Esc も変換の確定・取り消しとみなす。
 * テキスト入力の ⏎（追加・確定）、Esc（閉じる）、⇥ と、window のキー処理（単打のショートカット）はすべてこれを通す。
 */

/** 判定に使うキーイベントの部分（DOM の KeyboardEvent、React の合成イベントの nativeEvent） */
export type KeyLike = {
  key?: string;
  keyCode?: number;
  isComposing?: boolean;
  timeStamp?: number;
};

/** compositionend の後、同じ打鍵の keydown とみなす時間（ms）。人が続けて ⏎ を押すより十分短い */
export const AFTER_END_MS = 100;

/** compositionend 直後に来たら確定の続きとみなすキー */
const COMMIT_KEYS = new Set(["Enter", "Escape", "Tab"]);

export type ImeTracker = {
  /** compositionstart */
  start: () => void;
  /** compositionend（t は compositionend の timeStamp） */
  end: (t: number) => void;
  /** フォーカスが外れた・ウィンドウが非アクティブになった（compositionend が来ないまま終わった場合の保険） */
  reset: () => void;
  /** このキーは IME のもの（アプリの操作として扱わない） */
  isImeKey: (e: KeyLike) => boolean;
};

/** 純粋な追跡器（テストではイベント列をそのまま流す） */
export function createImeTracker(afterEndMs = AFTER_END_MS): ImeTracker {
  let composing = false;
  let endedAt: number | null = null;
  return {
    start: () => {
      composing = true;
    },
    end: (t) => {
      composing = false;
      endedAt = t;
    },
    reset: () => {
      composing = false;
      endedAt = null;
    },
    isImeKey: (e) => {
      if (e.isComposing === true) return true;
      if (e.keyCode === 229) return true;
      if (composing) return true;
      if (endedAt !== null && e.key !== undefined && COMMIT_KEYS.has(e.key)) {
        const d = (e.timeStamp ?? now()) - endedAt;
        if (d >= 0 && d < afterEndMs) return true;
      }
      return false;
    },
  };
}

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/** アプリ全体で1つの追跡器。window の capture で composition を見る（入力欄ごとの登録は要らない） */
const tracker = createImeTracker();
let installed = false;

/** 追跡を始める（このモジュールを読み込んだ時点で window に付く。2回目以降は何もしない） */
export function installImeTracker(target: Window = window): void {
  if (installed) return;
  installed = true;
  target.addEventListener("compositionstart", () => tracker.start(), true);
  target.addEventListener("compositionend", (e) => tracker.end(e.timeStamp), true);
  target.addEventListener("blur", () => tracker.reset());
  target.addEventListener("focusout", () => tracker.reset(), true);
}

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  installImeTracker(window);
}

/**
 * このキーは IME の変換中・変換確定のもの。真なら ⏎ で追加・確定、Esc で閉じる、単打のショートカットなどをしない。
 * DOM の KeyboardEvent と React の合成イベントのどちらも受ける。
 */
export function isImeKey(e: KeyLike | { nativeEvent: KeyLike }): boolean {
  const n = "nativeEvent" in e ? e.nativeEvent : e;
  return tracker.isImeKey(n);
}

/** ⏎ で欄を離れて確定する入力欄の onKeyDown（変換確定の ⏎ では離れない） */
export function blurOnEnter(e: {
  key: string;
  nativeEvent: KeyLike;
  currentTarget: { blur: () => void };
}): void {
  if (e.key === "Enter" && !isImeKey(e)) e.currentTarget.blur();
}

/**
 * 欄を離れたときの値を読む。変換中に離れたときは、確定（compositionend）が届いてから DOM の値を読む
 * （確定の文字が離れた後に入る環境で、題名の末尾の変換中の文字を落とさない）。確定が来なければ timeoutMs 後に読む。
 * React の状態ではなく DOM の値を読むので、同じ打鍵の中で状態の反映が遅れても最後の文字を落とさない
 */
export function readAfterComposition(
  el: { value: string } & Pick<EventTarget, "addEventListener" | "removeEventListener">,
  composing: boolean,
  fn: (value: string) => void,
  timeoutMs = 300,
): void {
  if (!composing) {
    fn(el.value);
    return;
  }
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    el.removeEventListener("compositionend", finish);
    clearTimeout(timer);
    // WebKit は compositionend の後に確定の input が来ることがあるので、次のタスクで読む
    setTimeout(() => fn(el.value), 0);
  };
  el.addEventListener("compositionend", finish);
  const timer = setTimeout(finish, timeoutMs);
}
