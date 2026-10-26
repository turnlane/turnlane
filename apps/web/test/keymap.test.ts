/**
 * D-077（ux-mvp 6.2）: キーマップの1か所の定義、利用者の上書き（ui.keybindings）、衝突の検出（同じ画面で同じキー・
 * 2打鍵の接頭辞・OS / ブラウザの予約）、記録（2打鍵・グローバルホットキー）、上書きの反映（キーの基盤・`?`・⌘K・
 * ツールチップ・儀式のフッタ）。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { en } from "../src/i18n/en.ts";
import { makeI18n, translate } from "../src/i18n/index.tsx";
import { ja } from "../src/i18n/ja.ts";
import {
  accelFromEvent,
  compactOverrides,
  eventIs,
  findConflicts,
  footLabel,
  KEYMAP,
  keyHint,
  keyLabel,
  keysOf,
  normalizeAccel,
  recordStroke,
  SCOPE_ORDER,
  setKeyOverrides,
  shownKeys,
} from "../src/keys/keymap.ts";
import { matchIds } from "../src/keys/use-keys.ts";
import { type BuildInput, buildSections } from "../src/palette/model.ts";
import { conflictText } from "../src/routes/KeyboardSection.tsx";

afterEach(() => setKeyOverrides({}));

const ev = (key: string, o: Partial<KeyboardEvent> = {}) => ({
  key,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...o,
});

describe("D-077: キーマップの定義", () => {
  test("id は重複しない。説明は英日の両方にある。カテゴリは一覧の順に含まれる", () => {
    const ids = KEYMAP.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const d of KEYMAP) {
      expect(en[d.label]).toBeDefined();
      expect((ja as Record<string, unknown>)[d.label]).toBeDefined();
      expect(SCOPE_ORDER).toContain(d.scope);
    }
  });

  test("網羅: 単打・g の2打鍵・⌘ 系・⌘K の中・グローバルホットキー", () => {
    const has = (id: string, scope: string) =>
      expect(KEYMAP.find((d) => d.id === id)?.scope).toBe(scope as never);
    has("toggleWeek", "global"); // w
    has("goBoard", "global"); // g b
    has("viewThree", "global"); // ⌘1
    has("paletteFilter", "palette");
    has("goRecord", "global"); // g r（旧 goDailyNote）
    has("quickAdd", "desktop");
  });

  test("既定の割り当てには衝突が無い", () => {
    expect(findConflicts({}, "Alt+Shift+Space")).toEqual([]);
  });
});

describe("D-077: 上書きの反映", () => {
  test("キーの基盤: 上書きしたキーで動き、元のキーでは動かない。2打鍵の接頭辞も上書きから決まる", () => {
    setKeyOverrides({ goBoard: ["g x"], goInbox: [", i"], toggleWeek: [] });
    expect(matchIds("x", "g").ids).toEqual(["goBoard"]);
    expect(matchIds("b", "g").ids).toEqual([]);
    expect(matchIds(",", null)).toEqual({ ids: [], prefix: true });
    expect(matchIds("i", ",").ids).toEqual(["goInbox"]);
    expect(matchIds("w", null).ids).toEqual([]);
  });

  test("変えられない定義（Esc・⌘K の中）は上書きを無視する", () => {
    setKeyOverrides({ escape: ["q"], paletteRun: ["x"] });
    expect(keysOf("escape")).toEqual(["escape"]);
    expect(keysOf("paletteRun")).toEqual(["enter"]);
  });

  test("ツールチップ・一覧: 既定は旧キー（g q）を出さない。上書きしたら全部出す", () => {
    expect(keyHint("goQueue")).toBe("g y");
    expect(keyHint("viewWeek")).toBe("⌘2 / g w");
    setKeyOverrides({ goQueue: ["g y", "g q"], viewWeek: ["mod+shift+w"] });
    expect(keyHint("goQueue")).toBe("g y / g q");
    expect(keyHint("viewWeek")).toBe("⌘⇧W");
  });

  test("⌘K の行（Go to・コマンド・選択中の操作）は今の割り当てを出す", () => {
    const i18n = makeI18n("en");
    const input = (q: string, category: BuildInput["category"]): BuildInput => ({
      q,
      category,
      t: i18n.t,
      tEn: (k, x) => translate("en", k, x),
      shortDate: i18n.shortDate,
      titleOf: (x) => (x.t === "text" ? x.text : ""),
      today: "2026-10-05",
      now: Date.parse("2026-10-05T13:20:00+09:00"),
      tz: "Asia/Tokyo",
      selection: [],
      queue: [],
      recent: [],
      search: undefined,
      theme: "dark",
      language: "en",
      hooksText: null,
      calendarText: null,
    });
    const row = (q: string, category: BuildInput["category"], id: string) =>
      buildSections(input(q, category))
        .flatMap((s) => s.rows)
        .find((r) => r.id === id);
    expect(row("3 days", "goto", "goto:three")?.keys).toEqual(["mod+1"]);
    setKeyOverrides({ viewThree: ["mod+4"], help: ["shift+/"], toggleSidebar: [] });
    expect(row("3 days", "goto", "goto:three")?.keys).toEqual(["mod+4"]);
    expect(row("shortcuts", "commands", "cmd:help")?.keys).toEqual(["shift+/"]);
    expect(row("sidebar", "commands", "cmd:sidebar")?.keys).toEqual([]);
  });

  test("足の表記: 定義ごとの最初のキー。変えられない定義は全部", () => {
    expect(footLabel(["next", "prev"])).toBe("j/k");
    expect(footLabel(["escape"])).toBe("Esc");
    expect(footLabel(["detail"])).toBe("→");
    setKeyOverrides({ next: ["n"], dismiss: ["shift+e"] });
    expect(footLabel(["next", "prev"])).toBe("n/k");
    expect(footLabel(["dismiss"])).toBe("⇧e");
  });

  test("メニューの中のキー（他の開き方の返答タスク）も上書きに従う", () => {
    expect(eventIs("replyTask", ev("y"))).toBe(true);
    setKeyOverrides({ replyTask: ["shift+r"] });
    expect(eventIs("replyTask", ev("y"))).toBe(false);
    expect(eventIs("replyTask", ev("R", { shiftKey: true }))).toBe(true);
  });

  test("k は prev だけ、↑↓ は prev / next だけ（儀式の上書きは D-192 で消えた）", () => {
    expect(matchIds("k", null).ids).toEqual(["prev"]);
    expect(matchIds("arrowdown", null).ids).toEqual(["next"]);
  });
});

describe("D-077: 衝突の検出", () => {
  test("同じ画面で同じキー（グローバルとボード）", () => {
    expect(findConflicts({ toggleWeek: ["t"] })).toEqual([
      { kind: "same", a: "toggleWeek", b: "today", key: "t" },
    ]);
  });

  test("別の画面なら同じキーでもよい（⌘K の中の ⏎ と一覧の ⏎、グローバルホットキーとアプリ内のキー）", () => {
    expect(findConflicts({ open: ["enter"] })).toEqual([]);
    expect(findConflicts({ search: ["mod+shift+space"] }, "Cmd+Shift+Space")).toEqual([]);
  });

  test("一覧のキーどうしは同じ画面なので衝突する", () => {
    expect(findConflicts({ snooze: ["e"] })).toEqual([
      { kind: "same", a: "snooze", b: "dismiss", key: "e" },
    ]);
  });

  test("2打鍵の接頭辞: 単独の g は g b などと衝突する", () => {
    const cs = findConflicts({ help: ["g"] });
    expect(cs.length).toBeGreaterThan(0);
    expect(cs.every((c) => c.kind === "prefix" && c.a === "help" && c.prefix === "g")).toBe(true);
    expect(cs.map((c) => (c.kind === "prefix" ? c.b : "")).sort()).toContain("goBoard");
  });

  test("OS・ブラウザの予約（⌘Q・⌘W・Tab）と、グローバルホットキーの予約（⌘Space）", () => {
    expect(findConflicts({ search: ["mod+w"], toggleWeek: ["mod+q"], new: ["tab"] })).toEqual([
      { kind: "reserved", a: "search", key: "mod+w" },
      { kind: "reserved", a: "toggleWeek", key: "mod+q" },
      { kind: "reserved", a: "new", key: "tab" },
    ]);
    expect(findConflicts({}, "Cmd+Space")).toEqual([
      { kind: "reserved", a: "quickAdd", key: "Cmd+Space" },
    ]);
    expect(findConflicts({}, "Shift+CmdOrCtrl+3")).toHaveLength(1);
  });

  test("衝突の文（英日）", () => {
    const labelOf = (id: string) =>
      translate("en", KEYMAP.find((d) => d.id === id)?.label ?? "keys.help");
    const [same] = findConflicts({ toggleWeek: ["t"] });
    const tEn = (k: Parameters<typeof translate>[1], p?: Record<string, string | number>) =>
      translate("en", k, p);
    expect(conflictText(same as never, "toggleWeek", tEn, labelOf)).toBe(
      "t is also “Jump to today / move selection to today”",
    );
    const tJa = (k: Parameters<typeof translate>[1], p?: Record<string, string | number>) =>
      translate("ja", k, p);
    const [reserved] = findConflicts({ search: ["mod+w"] });
    expect(conflictText(reserved as never, "search", tJa, labelOf)).toBe(
      "⌘W は macOS・ブラウザが使います",
    );
    const [quick] = findConflicts({}, "Cmd+Space");
    expect(conflictText(quick as never, "quickAdd", tEn, labelOf)).toBe(
      "⌘Space is used by macOS or the browser",
    );
  });
});

describe("D-077: 保存の形と記録", () => {
  test("既定と同じもの・変えられないもの・知らない id は保存しない", () => {
    expect(
      compactOverrides({
        viewThree: ["mod+1"],
        viewWeek: ["mod+2"],
        escape: ["q"],
        nope: ["x"],
        toggleWeek: [],
      }),
    ).toEqual({ viewWeek: ["mod+2"], toggleWeek: [] });
  });

  test("2打鍵の記録: 修飾なしの英数字の1打目は2打目を待つ", () => {
    expect(recordStroke(null, "g")).toEqual({ done: null, pending: "g" });
    expect(recordStroke("g", "x")).toEqual({ done: "g x", pending: null });
    expect(recordStroke(null, "mod+4")).toEqual({ done: "mod+4", pending: null });
    expect(recordStroke(null, "?")).toEqual({ done: "?", pending: null });
  });

  test("グローバルホットキーの記録は e.code から Tauri の書式に。⌘・⌃・⌥ が要る（F キーは単独可）", () => {
    const k = (code: string, o: Partial<KeyboardEvent> = {}) =>
      accelFromEvent({
        code,
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        ...o,
      });
    expect(k("Space", { altKey: true, shiftKey: true })).toBe("Alt+Shift+Space");
    expect(k("KeyK", { metaKey: true, shiftKey: true })).toBe("Cmd+Shift+K");
    expect(k("Digit1", { ctrlKey: true })).toBe("Ctrl+1");
    expect(k("F5")).toBe("F5");
    expect(k("KeyA")).toBeNull();
    expect(k("KeyA", { shiftKey: true })).toBeNull();
    expect(k("IntlYen", { metaKey: true })).toBeNull();
    expect(normalizeAccel("Shift+Alt+Space")).toBe(normalizeAccel("Alt+Shift+Space"));
  });

  test("キーの表記", () => {
    expect(keyLabel("mod+k")).toBe("⌘K");
    expect(keyLabel("mod+shift+k")).toBe("⌘⇧K");
    expect(keyLabel("shift+j")).toBe("⇧j");
    expect(keyLabel("mod+\\")).toBe("⌘\\");
    expect(keyLabel("mod+backspace")).toBe("⌘⌫");
    expect(keyLabel("ctrl+n")).toBe("⌃n");
    expect(keyLabel("g b")).toBe("g b");
    expect(keyLabel("arrowup")).toBe("↑");
    expect(shownKeys("goQueue")).toEqual(["g y"]);
  });
});

describe("D-077: 保存して読み戻したキーで動く", () => {
  test("保存の形（compactOverrides）を JSON で読み戻して読み込むと、変えたキーで動き元のキーでは動かない", () => {
    const draft = { goInbox: ["g n"], goAi: ["g a", "v"], viewThree: ["mod+1"] };
    const saved = JSON.parse(JSON.stringify(compactOverrides(draft))) as Record<string, string[]>;
    expect(saved).toEqual({ goInbox: ["g n"], goAi: ["g a", "v"] });
    setKeyOverrides(saved);
    expect(matchIds("n", "g").ids).toEqual(["goInbox"]);
    expect(matchIds("i", "g").ids).toEqual([]);
    expect(matchIds("v", null).ids).toEqual(["goAi"]);
    expect(matchIds("a", "g").ids).toEqual(["goAi"]);
    expect(matchIds("1", null).ids).toEqual([]);
    expect(matchIds("mod+1", null).ids).toEqual(["viewThree"]);
  });
});
