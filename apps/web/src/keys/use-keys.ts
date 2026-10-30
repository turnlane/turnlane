/**
 * キーボード基盤（M2-7）: スコープ付きのキーマップ。画面（ボード・キュー・Inbox）とパネルが、定義の id → 処理 を登録する。
 * - 文字を入れる欄にフォーカスがあるときは Esc と少数の画面のキー（⌘K・⌘1〜3・⌘\）以外を画面で受けない（⌘Z・⌘⌫・⌘A
 *   などは欄の中の編集。lib/editable.ts）。
 *   チェックボックス・select などのフォーカスでは1文字キーだけ止める（修飾付きと Esc は通す）
 * - `g` 始まりなどの2打鍵（1.2秒以内。D-077 で接頭辞は割り当てから決める）
 * - 後から登録したもの（パネルなど）が優先。処理が false を返したら次へ回す
 */

import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { endFocus, startFocus, undoLast } from "../data/mutations.ts";
import { boardNav, dayNav } from "../lib/board-nav.ts";
import { isFormControl, isTextEntry, passesInTextEntry } from "../lib/editable.ts";
import { isImeKey } from "../lib/ime.ts";
import { anyPanelOpen, getUi, setBoardMode, setUi } from "../lib/store.ts";
import { placeTargetOf } from "../palette/place-target.ts";
import { dispatchable, KEYMAP, keyName, keysOf } from "./keymap.ts";

export type Handlers = Partial<Record<string, (e: KeyboardEvent) => boolean | undefined>>;

type Entry = { handlers: { current: Handlers } };
const stack: Entry[] = [];
/**
 * 画面の処理が受けなかったときだけ試す処理（控え）。後から登録しても画面・パネルより後に回す。
 * 帯がデータの到着の後に出ると stack の上に積まれ、パネルを開いたままの ⏎ を奪っていた（UX 監査 U-08）
 */
const fallbacks: Entry[] = [];

/** 登録の順に処理を探す（画面・パネル（後から登録したものが先）→ 控え）。グローバルは呼び出し側 */
function* handlersFor(id: string): Generator<(e: KeyboardEvent) => boolean | undefined> {
  for (let i = stack.length - 1; i >= 0; i--) {
    const h = stack[i]?.handlers.current[id];
    if (h) yield h;
  }
  for (let i = fallbacks.length - 1; i >= 0; i--) {
    const h = fallbacks[i]?.handlers.current[id];
    if (h) yield h;
  }
}
/** グローバルの処理（useGlobalKeys が置く）。⌘K のコマンドからも呼ぶ */
let globalHandlers: Handlers = {};

/**
 * 定義の id の処理を、キーを押したのと同じ順（画面・パネル → グローバル）で呼ぶ（⌘K のコマンド。ux-mvp 6.1）。
 * 処理したら true
 */
export function dispatchKey(id: string): boolean {
  const e = new KeyboardEvent("keydown");
  for (const h of handlersFor(id)) if (h(e) !== false) return true;
  const g = globalHandlers[id];
  return !!g && g(e) !== false;
}

/** キーの処理を登録する（戻り値で外す）。fallback は画面・パネルが受けなかったときだけ試す */
export function registerKeys(
  handlers: { current: Handlers },
  opts: { fallback?: boolean } = {},
): () => void {
  const list = opts.fallback ? fallbacks : stack;
  const entry = { handlers };
  list.push(entry);
  return () => {
    const i = list.indexOf(entry);
    if (i >= 0) list.splice(i, 1);
  };
}

/** 画面ごとのキーの処理を登録する（アンマウントで外れる） */
export function useKeys(handlers: Handlers, opts: { fallback?: boolean } = {}): void {
  const ref = useRef(handlers);
  ref.current = handlers;
  const fallback = opts.fallback === true;
  useEffect(() => registerKeys(ref, { fallback }), [fallback]);
}

/** 押したキー（2打鍵を含む）→ 定義の id の候補 */
export function matchIds(name: string, pending: string | null): { ids: string[]; prefix: boolean } {
  const full = pending ? `${pending} ${name}` : name;
  const defs = KEYMAP.filter(dispatchable);
  const ids = defs.filter((d) => keysOf(d.id).includes(full)).map((d) => d.id);
  const prefix = !pending && defs.some((d) => keysOf(d.id).some((k) => k.startsWith(`${name} `)));
  return { ids, prefix };
}

export function useGlobalKeys(): void {
  const nav = useNavigate();
  useEffect(() => {
    let pending: string | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const global: Handlers = {
      goQueue: () => {
        void nav({ to: "/queue" });
        return true;
      },
      goInbox: () => {
        void nav({ to: "/inbox" });
        return true;
      },
      goAi: () => {
        void nav({ to: "/ai" });
        return true;
      },
      goBoard: () => {
        void nav({ to: "/board" });
        return true;
      },
      // ビューの切り替え（D-075）
      viewThree: () => {
        setBoardMode("three");
        void nav({ to: "/board" });
        return true;
      },
      viewWeek: () => {
        setBoardMode("week");
        void nav({ to: "/board" });
        return true;
      },
      viewDay: () => {
        void nav({ to: "/day" });
        return true;
      },
      // 新しい予定（⇧C・⌘K）: ボード・デイビューは画面の処理が先に受ける。他の画面からは今日のデイビューで開く（D-093）
      newEvent: () => {
        setUi({ newEventRequest: Date.now() });
        dayNav.today();
        void nav({ to: "/day" });
        return true;
      },
      goDayToday: () => {
        dayNav.today();
        void nav({ to: "/day" });
        return true;
      },
      goSettings: () => {
        void nav({ to: "/settings" });
        return true;
      },
      // 記録（D-192）: 今日のデイビューを記録のパネル付きで開く。日の画面で既に開いていれば閉じない
      goRecord: () => {
        dayNav.today();
        setUi({ recordOpen: true });
        void nav({ to: "/day" });
        return true;
      },
      search: () => {
        setUi((s) => ({ palette: s.palette ? null : "root", helpOpen: false }));
        return true;
      },
      place: () => {
        // 時間に置く（p）: 選んでいるタスク 1 件か、自分の番の行 1 件（タスクのある待ち。Issue #4。自分レーンへ
        // ドラッグしたのと同じ）なら、パレットに空き枠の候補を出す（ux-mvp 6.1）
        if (!placeTargetOf(getUi().selection)) return false;
        setUi({ palette: "place", helpOpen: false });
        return true;
      },
      help: () => {
        setUi((s) => ({ helpOpen: !s.helpOpen }));
        return true;
      },
      toggleSidebar: () => {
        setUi((s) => ({ sidebarCollapsed: !s.sidebarCollapsed }));
        return true;
      },
      // 操作の取り消し。入力欄の中の ⌘Z は文字の取り消しで、ここには来ない（上の onKey が欄の中のキーを渡さない）
      undo: () => {
        void undoLast();
        return true;
      },
      // 集中モード（D-097）。⌘K と、割り当てたキー
      focus30: () => {
        void startFocus({ minutes: 30 });
        return true;
      },
      focus60: () => {
        void startFocus({ minutes: 60 });
        return true;
      },
      focusEvent: () => {
        void startFocus({ until: "event_end" });
        return true;
      },
      focusEnd: () => {
        void endFocus();
        return true;
      },
      escape: () => {
        const u = getUi();
        if (u.palette) setUi({ palette: null });
        else if (u.helpOpen) setUi({ helpOpen: false });
        else if (anyPanelOpen(u))
          setUi({ panelWorkItemId: null, panelTaskId: null, panelEventId: null });
        else if (u.recordOpen) setUi({ recordOpen: false });
        else return false;
        return true;
      },
      // ボードの前後（3日ボードは1稼働日、週表示は1週。D-074）。デイビューは画面の処理が先に受ける
      prevWeek: () => {
        boardNav.step(-1);
        return true;
      },
      nextWeek: () => {
        boardNav.step(1);
        return true;
      },
      toggleWeek: () => {
        const onBoard = window.location.pathname === "/board";
        setBoardMode(onBoard && getUi().boardMode === "week" ? "three" : "week");
        if (!onBoard) void nav({ to: "/board" });
        return true;
      },
    };
    globalHandlers = global;
    /** 定義の処理を画面・パネル → グローバルの順に試し、受けたら既定の動作を止めて true */
    const run = (id: string, e: KeyboardEvent): boolean => {
      for (const h of handlersFor(id))
        if (h(e) !== false) {
          e.preventDefault();
          return true;
        }
      const g = global[id];
      if (g && g(e) !== false) {
        e.preventDefault();
        return true;
      }
      return false;
    };
    const onKey = (e: KeyboardEvent) => {
      if (isImeKey(e)) return;
      const name = keyName(e);
      if (name === "shift" || name === "meta" || name === "control" || name === "alt") return;
      // 文字を入れる欄の中は Esc と少数の画面のキー（⌘K・⌘1〜3・⌘\）だけ画面が受ける（⌘Z・⇧⌘Z・⌘A・⌘X・⌘C・⌘V・⌘⌫・
      // ⌘←→ などは欄の編集）。2打鍵の途中の状態には触れない
      if (name !== "escape" && isTextEntry(e.target)) {
        const pass = matchIds(name, null).ids.filter((id) => passesInTextEntry(id, name));
        for (const id of pass) if (run(id, e)) return;
        return;
      }
      const modded = name.startsWith("mod+") || name === "escape";
      if (!modded && isFormControl(e.target)) return;
      const { ids, prefix } = matchIds(name, pending);
      if (timer) clearTimeout(timer);
      if (prefix && ids.length === 0) {
        pending = name;
        timer = setTimeout(() => {
          pending = null;
        }, 1200);
        e.preventDefault();
        return;
      }
      pending = null;
      for (const id of ids) if (run(id, e)) return;
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (globalHandlers === global) globalHandlers = {};
    };
  }, [nav]);
}
