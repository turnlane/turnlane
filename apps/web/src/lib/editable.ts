/**
 * 入力欄の判定と、入力欄の中の取り消し・やり直し。
 * - 文字を入れる欄（テキストの input・textarea・contenteditable）にフォーカスがある間は、画面のキーを Esc と少数の画面の
 *   キー（PASS_IN_TEXT_ENTRY）以外すべて素通りさせ、⌘Z・⇧⌘Z・⌘A・⌘X・⌘C・⌘V・⌥←→・⌘←→・⌘⌫ などをブラウザ（WKWebView）の
 *   文字の編集に任せる（keys/use-keys.ts）
 * - デスクトップアプリの Edit メニューの取り消し・やり直しは Rust が `window.__turnlaneEdit` を呼ぶ（desktop-shell.md 2.5）。
 *   WKWebView ではメニューのキーが web の keydown より先に取るので、欄の中なら文字の取り消し、欄の外なら同じキーを画面に渡す
 */

/** 文字を入れない input の type（チェックボックスなど。1文字キーは止めるが ⌘ 付きのキーは画面に渡す） */
const NON_TEXT_INPUT = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "hidden",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

/** 文字を入れる欄か（テキストの input・textarea・contenteditable） */
export function isTextEntry(t: EventTarget | null | undefined): boolean {
  const el = t as HTMLElement | null | undefined;
  if (!el || typeof el.tagName !== "string") return false;
  if (el.tagName === "TEXTAREA") return true;
  if (el.tagName === "INPUT") return !NON_TEXT_INPUT.has((el as HTMLInputElement).type);
  return el.isContentEditable === true;
}

/**
 * 文字を入れる欄の中でも画面が受ける定義（⌘ 付きの1打鍵で押したときだけ）。欄の中の編集に使わないキーで、入力の途中から
 * 画面を移りたいもの: ⌘K（コマンドパレット）・⌘1 / ⌘2 / ⌘3（画面の切り替え）・⌘\（サイドバー）。
 * ⌘Z・⇧⌘Z・⌘A・⌘X・⌘C・⌘V・⌘⌫・⌘←→ などの編集のキーは入れない（欄の中の編集に任せる）。⌘⏎（答えるの送信など）は部品の
 * 側で受けている。割り当てを変えたときも、⌘ 付きの1打鍵ならこの定義は欄の中で効く（`g w` などは効かない）
 */
const PASS_IN_TEXT_ENTRY: ReadonlySet<string> = new Set([
  "search",
  "viewThree",
  "viewWeek",
  "viewDay",
  "toggleSidebar",
]);

/** 文字を入れる欄の中で、押したキー（keyName）の定義 id を画面が受けてよいか */
export function passesInTextEntry(id: string, name: string): boolean {
  return name.startsWith("mod+") && !name.includes(" ") && PASS_IN_TEXT_ENTRY.has(id);
}

/** フォームの部品か（文字を入れる欄・select・チェックボックスなど）。1文字の画面のキーを止める範囲 */
export function isFormControl(t: EventTarget | null | undefined): boolean {
  const el = t as HTMLElement | null | undefined;
  if (!el || typeof el.tagName !== "string") return false;
  return (
    el.tagName === "INPUT" ||
    el.tagName === "TEXTAREA" ||
    el.tagName === "SELECT" ||
    el.isContentEditable === true
  );
}

export type EditCommand = "undo" | "redo";

/**
 * Edit メニューの取り消し・やり直し（デスクトップアプリ）。フォーカスが文字を入れる欄にあればその欄の取り消し・やり直し、
 * 無ければ ⌘Z / ⇧⌘Z を押したのと同じキーを画面に渡す（タスクの操作の取り消しなど。割り当ての変更に従う）
 */
export function runEditCommand(cmd: EditCommand): void {
  const el = document.activeElement;
  if (isTextEntry(el)) {
    // 文字の取り消しの履歴はブラウザ（WebKit）が持つ。execCommand は非推奨だが、履歴を辿る手段はこれだけ
    document.execCommand(cmd);
    return;
  }
  (el ?? document.body).dispatchEvent(
    new KeyboardEvent("keydown", {
      key: cmd === "redo" ? "Z" : "z",
      code: "KeyZ",
      metaKey: true,
      shiftKey: cmd === "redo",
      bubbles: true,
      cancelable: true,
    }),
  );
}
