/**
 * キーの定義（M2-7。ux-mvp 6章・6.2、D-077）。全ショートカットの既定値と説明（i18n の日英）を1か所にまとめ、
 * `?` の一覧・⌘K（M2-15）・ツールチップ・設定の「キーボード」の節が同じ定義を読む。
 * 表記: 文字はそのまま、修飾は `mod+`（⌘）・`shift+`・`alt+`、2打鍵は空白区切り（`g b`）。
 * 利用者の変更（上書き）は設定 `ui.keybindings`（端末ごと）に id → キーの配列で置き、`setKeyOverrides` で読み込む。
 * クイック入力のグローバルホットキー（scope desktop）だけは Tauri の書式で、設定 `desktop.quick_add_shortcut` に置く。
 */
import { useSyncExternalStore } from "react";
import type { MessageKey } from "../i18n/en.ts";

/**
 * global: どの画面でも / board: ボード・デイビュー / list: 項目の一覧（ボード・キュー・Inbox・拡張の画面）/
 * palette: ⌘K の中 / prompt: ボードでドラッグした後の入力欄（D-093）/ desktop: OS 全体（デスクトップアプリ）
 */
export type Scope = "global" | "board" | "list" | "palette" | "prompt" | "desktop";

export interface KeyDef {
  id: string;
  /** 既定のキー */
  keys: readonly string[];
  scope: Scope;
  label: MessageKey;
  /** 変えられない（⌘K の中の移動・Esc。入力欄と組み合わせて使うため。D-077 の仮置き） */
  fixed?: boolean;
  /** 既定のうち、一覧・⌘K・ツールチップに出さない旧キー（`g q`）。押せば効く */
  legacy?: readonly string[];
  /** 同じ画面で同じキーでも衝突にしない定義（拡張の ⌫ と本体の ⌫ など） */
  shadows?: readonly string[];
  /**
   * 拡張の画面だけが使う定義（本体の画面には処理が無い。ADR 0015）。拡張を組み込まないビルドでは定義ごと無く、
   * `?` の一覧・⌘K・キーボードの設定・衝突の検出に出ない
   */
  ext?: true;
}

/** すべての定義（拡張だけが使うものを含む）。画面・一覧が読むのは KEYMAP */
export const ALL_KEYS: readonly KeyDef[] = [
  // ビューの切り替え（D-075）: ⌘1 3日ボード / ⌘2 週表示 / ⌘3 デイビュー。デスクトップアプリは表示メニューから呼ぶ
  { id: "viewThree", keys: ["mod+1"], scope: "global", label: "keys.viewThree" },
  { id: "viewWeek", keys: ["mod+2", "g w"], scope: "global", label: "keys.viewWeek" },
  { id: "viewDay", keys: ["mod+3"], scope: "global", label: "keys.viewDay" },
  // ボードは最後に使った表示（3日 / 週）
  { id: "goBoard", keys: ["g b"], scope: "global", label: "keys.goBoard" },
  { id: "goDayToday", keys: ["g d"], scope: "global", label: "keys.goDayToday" },
  // 自分の番（D-075 で g y。旧 g q も残す）
  { id: "goQueue", keys: ["g y", "g q"], legacy: ["g q"], scope: "global", label: "keys.goQueue" },
  { id: "goInbox", keys: ["g i"], scope: "global", label: "keys.goInbox" },
  // AI の画面（ux-mvp 4.19）
  { id: "goAi", keys: ["g a"], scope: "global", label: "keys.goAi" },
  // 記録（D-192）: 今日のデイビューを記録のパネル付きで開く（旧 goDailyNote の g r を引き継ぐ）
  { id: "goRecord", keys: ["g r"], scope: "global", label: "keys.goRecord" },
  { id: "goSettings", keys: ["g s"], scope: "global", label: "keys.goSettings" },
  { id: "search", keys: ["mod+k"], scope: "global", label: "keys.search" },
  { id: "help", keys: ["?"], scope: "global", label: "keys.help" },
  { id: "toggleSidebar", keys: ["mod+\\"], scope: "global", label: "keys.toggleSidebar" },
  // 3日ボードと週表示の切り替え（D-074）。ボード以外の画面からは週表示を開く
  { id: "toggleWeek", keys: ["w"], scope: "global", label: "keys.toggleWeek" },
  { id: "undo", keys: ["mod+z"], scope: "global", label: "keys.undo" },
  // 集中モード（D-097。ux-mvp 4.15）。既定のキーは無く、キーボードの設定で割り当てる。⌘K からも選べる
  { id: "focus30", keys: [], scope: "global", label: "keys.focus30" },
  { id: "focus60", keys: [], scope: "global", label: "keys.focus60" },
  { id: "focusEvent", keys: [], scope: "global", label: "keys.focusEvent" },
  { id: "focusEnd", keys: [], scope: "global", label: "keys.focusEnd" },
  { id: "escape", keys: ["escape"], scope: "global", label: "keys.escape", fixed: true },

  { id: "prevDay", keys: ["h", "arrowleft"], scope: "board", label: "keys.prevDay" },
  { id: "nextDay", keys: ["l"], scope: "board", label: "keys.nextDay" },
  { id: "prevWeek", keys: ["["], scope: "board", label: "keys.prevWeek" },
  { id: "nextWeek", keys: ["]"], scope: "board", label: "keys.nextWeek" },
  { id: "today", keys: ["t"], scope: "board", label: "keys.today" },
  { id: "new", keys: ["c"], scope: "board", label: "keys.new" },
  // 新しい予定（Calendar.app のデフォルトカレンダーへ。入力に時刻が要る。D-093）
  { id: "newEvent", keys: ["shift+c"], scope: "board", label: "keys.newEvent" },
  { id: "later", keys: [">"], scope: "board", label: "keys.later" },
  { id: "earlier", keys: ["<"], scope: "board", label: "keys.earlier" },
  // b（いつかへ）・*（今日の一番）・f（実績の計測）・⌘.（閉店モード）は未実装なので定義しない（v1。D-101 (4)）

  { id: "next", keys: ["j", "arrowdown"], scope: "list", label: "keys.nextItem" },
  { id: "prev", keys: ["k", "arrowup"], scope: "list", label: "keys.prevItem" },
  { id: "extendDown", keys: ["shift+j"], scope: "list", label: "keys.extendDown" },
  { id: "extendUp", keys: ["shift+k"], scope: "list", label: "keys.extendUp" },
  { id: "open", keys: ["enter"], scope: "list", label: "keys.open" },
  // ⏎ は開く・対応（外部の開き先）、→ / ⌘⏎ は詳細パネル。全画面で同じ（D-067）
  { id: "detail", keys: ["arrowright", "mod+enter"], scope: "list", label: "keys.detail" },
  { id: "rename", keys: ["r"], scope: "list", label: "keys.rename" },
  { id: "complete", keys: ["space"], scope: "list", label: "keys.complete" },
  { id: "move", keys: ["m"], scope: "list", label: "keys.move" },
  // 時間に置く: 空き枠の候補を ⌘K のパレットの中に出す（ux-mvp 6.1）
  { id: "place", keys: ["p"], scope: "list", label: "keys.place" },
  { id: "snooze", keys: ["s"], scope: "list", label: "keys.snooze" },
  { id: "dismiss", keys: ["e"], scope: "list", label: "keys.dismiss" },
  { id: "openWith", keys: ["o"], scope: "list", label: "keys.openWith" },
  // AI カード: 返答タスクを手で作る（D-066 (2)）。他の開き方のメニューの中でも同じキー
  { id: "replyTask", keys: ["y"], scope: "list", label: "keys.replyTask" },
  // Turnlane から答える（D-238）: 自分の番の待ち（問い・許可）の「答える」の節を開く
  { id: "answer", keys: ["a"], scope: "list", label: "keys.answer" },
  { id: "select", keys: ["x"], scope: "list", label: "keys.select" },
  { id: "delete", keys: ["mod+backspace"], scope: "list", label: "keys.delete" },
  { id: "unblock", keys: ["backspace"], scope: "list", label: "keys.unblock" },
  // 拡張の画面の一覧（並べ替え・外す）。本体の画面では使わない
  { id: "reorderUp", keys: ["mod+arrowup"], scope: "list", label: "keys.reorderUp", ext: true },
  {
    id: "reorderDown",
    keys: ["mod+arrowdown"],
    scope: "list",
    label: "keys.reorderDown",
    ext: true,
  },
  {
    id: "remove",
    keys: ["backspace"],
    scope: "list",
    label: "keys.remove",
    ext: true,
    // 本体の画面の ⌫（時間軸から外す）と同じキー。同じ画面に両方の処理は無い
    shadows: ["unblock"],
  },

  // ⌘K の中（ux-mvp 6.1）。入力欄と一緒に使うので変えられない
  {
    id: "paletteMove",
    keys: ["arrowup", "arrowdown", "ctrl+p", "ctrl+n"],
    scope: "palette",
    label: "keys.paletteMove",
    fixed: true,
  },
  { id: "paletteRun", keys: ["enter"], scope: "palette", label: "keys.paletteRun", fixed: true },
  {
    id: "paletteDetail",
    keys: ["mod+enter"],
    scope: "palette",
    label: "keys.paletteDetail",
    fixed: true,
  },
  {
    id: "paletteFilter",
    keys: ["tab", "shift+tab"],
    scope: "palette",
    label: "keys.paletteFilter",
    fixed: true,
  },
  {
    id: "paletteClose",
    keys: ["escape", "mod+k"],
    scope: "palette",
    label: "keys.paletteClose",
    fixed: true,
    // ⌘K でもう一度閉じる・Esc で閉じるのはグローバルの同じキーと同じ働き
    shadows: ["search", "escape"],
  },

  // ボードでドラッグした後の入力欄の「タスク / 予定」の切り替え（D-093）。入力欄と一緒に使うので変えられない
  {
    id: "promptKind",
    keys: ["tab"],
    scope: "prompt",
    label: "keys.promptKind",
    fixed: true,
  },

  // デスクトップアプリのクイック入力（OS 全体。D-056 (2)）。Tauri の書式で desktop.quick_add_shortcut に置く
  { id: "quickAdd", keys: ["Alt+Shift+Space"], scope: "desktop", label: "keys.quickAdd" },
];

/** このビルドの定義。拡張を組み込まないビルドでは拡張だけが使う定義を除く（一覧・設定・衝突は今までどおり） */
export function keymapFor(withExt: boolean): readonly KeyDef[] {
  return withExt ? ALL_KEYS : ALL_KEYS.filter((d) => !d.ext);
}

/** このビルドの定義（拡張の一覧 ext/registry.ts が組み込んだ拡張があれば setExtKeys(true) で拡張の分を足す） */
export let KEYMAP: readonly KeyDef[] = keymapFor(false);

/** 拡張だけが使う定義を出すか（ext/registry.ts が起動のときに1回呼ぶ） */
export function setExtKeys(on: boolean): void {
  KEYMAP = keymapFor(on);
}

export const SCOPE_ORDER: readonly Scope[] = [
  "global",
  "board",
  "list",
  "palette",
  "prompt",
  "desktop",
];

// ---------- 利用者の変更（上書き） ----------

let overrides: Readonly<Record<string, readonly string[]>> = {};
let version = 0;
const listeners = new Set<() => void>();

/** 設定 `ui.keybindings` を読み込む（App の起動時と設定の変化）。変わらなければ何もしない */
export function setKeyOverrides(o: Readonly<Record<string, readonly string[]>> | undefined): void {
  const next = o ?? {};
  if (JSON.stringify(next) === JSON.stringify(overrides)) return;
  overrides = next;
  version++;
  for (const l of listeners) l();
}

export function getKeyOverrides(): Readonly<Record<string, readonly string[]>> {
  return overrides;
}

/** キーの変更で描き直す（一覧・⌘K の行・ツールチップ・拡張の画面の足） */
export function useKeymapVersion(): number {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => version,
    () => version,
  );
}

/** キーの基盤（use-keys）が受ける定義（⌘K の中とグローバルホットキーは除く） */
export function dispatchable(d: KeyDef): boolean {
  return d.scope !== "palette" && d.scope !== "prompt" && d.scope !== "desktop";
}

export function defsOf(id: string): KeyDef | undefined {
  return KEYMAP.find((d) => d.id === id);
}

/** 効いているキー（上書きがあればそれ、無ければ既定。変えられない定義は既定のまま）。o を渡すとその上書きで求める */
export function keysOf(
  id: string,
  o: Readonly<Record<string, readonly string[]>> = overrides,
): readonly string[] {
  const d = defsOf(id);
  if (!d) return [];
  if (d.fixed || d.scope === "desktop") return d.keys;
  return o[id] ?? d.keys;
}

/** 表示するキー（既定のままなら旧キーを除く） */
export function shownKeys(id: string): string[] {
  const d = defsOf(id);
  if (!d) return [];
  const ks = keysOf(id);
  return ks === d.keys && d.legacy ? ks.filter((k) => !d.legacy?.includes(k)) : [...ks];
}

/** キーボードイベント → 表記（`j` / `shift+j` / `mod+k` / `>` / `space` / `ctrl+n`） */
export function keyName(
  e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">,
): string {
  let k = e.key;
  if (k === " ") k = "space";
  k = k.length === 1 ? k : k.toLowerCase();
  const mod = e.metaKey || e.ctrlKey;
  // 記号（? > < * [ ]）は shift を含めて1文字になっているので shift を付けない
  const letter = /^[a-z]$/i.test(k);
  if (letter) k = k.toLowerCase();
  const parts: string[] = [];
  if (mod) parts.push("mod");
  if (e.shiftKey && (letter || k.length > 1) && k !== "shift") parts.push("shift");
  if (e.altKey && k.length > 1) parts.push("alt");
  parts.push(k);
  return parts.join("+");
}

const NAMED: Record<string, string> = {
  backspace: "⌫",
  delete: "⌦",
  escape: "Esc",
  enter: "⏎",
  space: "Space",
  tab: "Tab",
  arrowright: "→",
  arrowleft: "←",
  arrowdown: "↓",
  arrowup: "↑",
};

const MOD_LABEL: Record<string, string> = { mod: "⌘", ctrl: "⌃", alt: "⌥", shift: "⇧" };

/** 一覧の表示用（mono の ASCII と記号。`mod+k` → `⌘K`、`shift+j` → `⇧j`、`g b` → `g b`） */
export function keyLabel(spec: string): string {
  return spec
    .split(" ")
    .map((stroke) => {
      const parts = stroke === "+" ? ["+"] : stroke.split("+").filter((p) => p !== "");
      if (stroke.endsWith("++")) parts.push("+");
      const key = parts.pop() ?? "";
      const mods = parts.map((m) => MOD_LABEL[m] ?? m).join("");
      const named = NAMED[key];
      const body = named ?? (mods.includes("⌘") && /^[a-z]$/.test(key) ? key.toUpperCase() : key);
      return `${mods}${body}`;
    })
    .join(" ");
}

/** ツールチップ用のキーの表記（`⌘2 / g w`）。キーが無ければ空 */
export function keyHint(id: string): string {
  return shownKeys(id).map(keyLabel).join(" / ");
}

/** 足（拡張の画面の下の操作の表記）用: 定義ごとの最初のキーを `/` でつなぐ（`j/k`） */
export function footLabel(ids: readonly string[]): string {
  // 変えられない1つの定義はキーを全部並べる（↑↓）
  if (ids.length === 1 && defsOf(ids[0] as string)?.fixed)
    return shownKeys(ids[0] as string)
      .map(keyLabel)
      .join("");
  return ids
    .map((id) => {
      const k = shownKeys(id)[0];
      return k ? keyLabel(k) : "";
    })
    .filter((s) => s !== "")
    .join("/");
}

/** そのイベントがその定義のキー（1打鍵のもの）か（メニューの中など、キーの基盤を通らない所で使う） */
export function eventIs(
  id: string,
  e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">,
): boolean {
  return keysOf(id).includes(keyName(e));
}

// ---------- 衝突の検出（D-077。設定の保存前） ----------

/** 定義が効く画面（同じ画面に出る定義どうしで同じキーなら衝突） */
const CONTEXTS: Record<Scope, readonly string[]> = {
  global: ["main", "palette"],
  board: ["main"],
  list: ["main"],
  palette: ["palette"],
  prompt: ["prompt"],
  desktop: ["os"],
};

/** OS・ブラウザが先に取る（またはアプリのメニューにある）ので割り当てない ⌘ のキー */
export const RESERVED_APP_KEYS: readonly string[] = [
  "mod+q",
  "mod+w",
  "mod+t",
  "mod+n",
  "mod+h",
  "mod+m",
  "mod+r",
  "mod+l",
  "mod+c",
  "mod+v",
  "mod+x",
  "mod+a",
  "mod+,",
  "mod+tab",
  "mod+space",
  "mod+`",
  "tab",
  "shift+tab",
];

/** グローバルホットキーで OS が使っているもの（Tauri の書式を小文字・並びを正規化して比べる） */
const RESERVED_GLOBAL: readonly string[] = [
  "cmd+space",
  "ctrl+space",
  "cmd+tab",
  "cmd+q",
  "cmd+w",
  "cmd+h",
  "cmd+m",
  "cmd+shift+3",
  "cmd+shift+4",
  "cmd+shift+5",
  "alt+cmd+escape",
  "alt+cmd+space",
];

export type Conflict =
  | { kind: "same"; a: string; b: string; key: string }
  | { kind: "prefix"; a: string; b: string; key: string; prefix: string }
  | { kind: "reserved"; a: string; key: string };

function sharesContext(a: KeyDef, b: KeyDef): boolean {
  return CONTEXTS[a.scope].some((c) => CONTEXTS[b.scope].includes(c));
}

/** Tauri の書式（`Alt+Shift+Space`）を比べられる形に（`alt+shift+space`。修飾は並べ替える） */
export function normalizeAccel(accel: string): string {
  const parts = accel
    .split("+")
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p !== "");
  const key = parts.pop() ?? "";
  const alias: Record<string, string> = {
    option: "alt",
    control: "ctrl",
    command: "cmd",
    super: "cmd",
    cmdorctrl: "cmd",
    commandorcontrol: "cmd",
    esc: "escape",
  };
  const mods = [...new Set(parts.map((p) => alias[p] ?? p))].sort();
  return [...mods, alias[key] ?? key].join("+");
}

/**
 * 上書き o を当てたときの衝突（同じ画面で同じキー、2打鍵の接頭辞、OS・ブラウザの予約）。
 * quickAdd はグローバルホットキーの値（Tauri の書式）
 */
export function findConflicts(
  o: Readonly<Record<string, readonly string[]>>,
  quickAdd?: string | null,
): Conflict[] {
  const out: Conflict[] = [];
  const defs = KEYMAP.filter((d) => d.scope !== "desktop");
  for (const d of defs) {
    if (d.fixed) continue;
    for (const k of keysOf(d.id, o))
      if (RESERVED_APP_KEYS.includes(k)) out.push({ kind: "reserved", a: d.id, key: k });
  }
  for (let i = 0; i < defs.length; i++) {
    for (let j = i + 1; j < defs.length; j++) {
      const a = defs[i] as KeyDef;
      const b = defs[j] as KeyDef;
      if (!sharesContext(a, b)) continue;
      if (a.shadows?.includes(b.id) || b.shadows?.includes(a.id)) continue;
      const ka = keysOf(a.id, o);
      const kb = keysOf(b.id, o);
      for (const x of ka) {
        if (kb.includes(x)) out.push({ kind: "same", a: a.id, b: b.id, key: x });
        for (const y of kb) {
          if (y.startsWith(`${x} `))
            out.push({ kind: "prefix", a: a.id, b: b.id, key: y, prefix: x });
          else if (x.startsWith(`${y} `))
            out.push({ kind: "prefix", a: b.id, b: a.id, key: x, prefix: y });
        }
      }
    }
  }
  if (quickAdd) {
    const n = normalizeAccel(quickAdd);
    if (RESERVED_GLOBAL.includes(n)) out.push({ kind: "reserved", a: "quickAdd", key: quickAdd });
  }
  return out;
}

/** 既定と同じ割り当てを除いた上書き（保存する形） */
export function compactOverrides(
  o: Readonly<Record<string, readonly string[]>>,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [id, ks] of Object.entries(o)) {
    const d = defsOf(id);
    if (!d || d.fixed || d.scope === "desktop") continue;
    if (ks.length === d.keys.length && ks.every((k, i) => k === d.keys[i])) continue;
    out[id] = [...ks];
  }
  return out;
}

// ---------- 記録（設定の「キーを押して記録」） ----------

/** 記録できるキーか（修飾キーだけ・IME 中・Esc は除く） */
export function recordable(name: string): boolean {
  if (["shift", "meta", "control", "alt", "capslock", "escape", "process", "dead"].includes(name))
    return false;
  if (name.endsWith("+shift") || name.endsWith("+meta") || name.endsWith("+control")) return false;
  return name !== "" && name !== "unidentified";
}

/**
 * 記録の1打鍵: 前の打鍵（pending）と今の打鍵 → 確定したキーか、2打鍵目を待つ状態。
 * 修飾なしの英数字の1打目は2打鍵目を待つ（画面は 1 秒で1打鍵として確定する）。それ以外は1打鍵で確定
 */
export function recordStroke(
  pending: string | null,
  name: string,
): { done: string; pending: null } | { done: null; pending: string } {
  if (pending !== null) return { done: `${pending} ${name}`, pending: null };
  if (/^[a-z0-9]$/.test(name)) return { done: null, pending: name };
  return { done: name, pending: null };
}

const CODE_KEY: Record<string, string> = {
  Space: "Space",
  Enter: "Enter",
  Tab: "Tab",
  Backspace: "Backspace",
  Escape: "Escape",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Comma: "Comma",
  Period: "Period",
  Slash: "Slash",
  Semicolon: "Semicolon",
  Quote: "Quote",
  BracketLeft: "BracketLeft",
  BracketRight: "BracketRight",
  Backslash: "Backslash",
  Minus: "Minus",
  Equal: "Equal",
  Backquote: "Backquote",
};

/**
 * グローバルホットキーの記録: キーボードイベント → Tauri の書式（`Alt+Shift+Space`）。
 * 文字は e.code（⌥ で文字が変わるため）から取る。⌘・⌃・⌥ のどれかが要る（F キーは単独でよい）。作れなければ null
 */
export function accelFromEvent(
  e: Pick<KeyboardEvent, "code" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">,
): string | null {
  let key: string | null = null;
  const c = e.code;
  if (/^Key[A-Z]$/.test(c)) key = c.slice(3);
  else if (/^Digit[0-9]$/.test(c)) key = c.slice(5);
  else if (/^F([1-9]|1[0-9]|20)$/.test(c)) key = c;
  else key = CODE_KEY[c] ?? null;
  if (!key) return null;
  const fkey = /^F\d+$/.test(key);
  if (!fkey && !e.metaKey && !e.ctrlKey && !e.altKey) return null;
  const mods: string[] = [];
  if (e.metaKey) mods.push("Cmd");
  if (e.ctrlKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  return [...mods, key].join("+");
}
