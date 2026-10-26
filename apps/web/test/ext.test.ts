/**
 * 拡張点（Web 側。ADR 0015）: テスト用の拡張（ext-fixture/web.tsx）で、一覧の組み立て・メニュー・今日の列の知らせ・パレット・辞書が
 * つながることと、このビルド（alias が空の一覧）では何も増えないことを確かめる
 */
import { describe, expect, test } from "bun:test";
import { menuSpec } from "../src/actions/item-actions.tsx";
import { originLabel, viaLabel } from "../src/components/items.tsx";
import { buildRegistry, checkWebExtension, ext } from "../src/ext/registry.ts";
import type { WebExtension } from "../src/ext/types.ts";
import { en } from "../src/i18n/en.ts";
import { translate } from "../src/i18n/index.tsx";
import { ja } from "../src/i18n/ja.ts";
import {
  ALL_KEYS,
  findConflicts,
  footLabel,
  KEYMAP,
  keymapFor,
  setExtKeys,
} from "../src/keys/keymap.ts";
import { dispatchKey, matchIds, registerKeys } from "../src/keys/use-keys.ts";
import { markShell, openAiPanelInApp, openInApp, setAppNavigate } from "../src/lib/open.ts";
import { getUi, type SelItem, setUi } from "../src/lib/store.ts";
import { type BuildInput, buildSections, selectionRows } from "../src/palette/model.ts";
import { taskPrimaryOf } from "../src/panel/task-state.ts";
import { SETTINGS_SECTIONS, sectionOfHash } from "../src/routes/settings-index.ts";
import fixture from "./ext-fixture/web.tsx";

// dispatchKey は KeyboardEvent を作る（bun test には無い）
if (!("KeyboardEvent" in globalThis))
  Object.assign(globalThis, {
    KeyboardEvent: class {
      constructor(readonly type: string) {}
    },
  });

const EXT_ONLY = ["reorderUp", "reorderDown", "remove"];

describe("拡張なし（公開のビルド）", () => {
  test("一覧が空で、設定の節・知らせ・メニューは本体のまま", () => {
    expect(ext.ids).toEqual([]);
    expect(ext.timelineMarks).toEqual([]);
    expect(SETTINGS_SECTIONS.some((s) => s.id.startsWith("ext-"))).toBe(false);
    expect(SETTINGS_SECTIONS.at(-1)?.id).toBe("data");
    expect(sectionOfHash("#ext-test-main")).toBe("general");
    expect(ext.todayNotices).toEqual([]);
    expect(ext.sidebarItems).toEqual([]);
    expect(ext.trayItems).toEqual([]);
    const task = { kind: "task", task: { id: "t1", status: "todo" } } as unknown as SelItem;
    expect(menuSpec([task]).some((m) => m.id.startsWith("ext:"))).toBe(false);
    // 拡張のキーは辞書に無いのでキーのまま
    expect(translate("en", "ext.test.nav")).toBe("ext.test.nav");
    // 拡張が作ったタスクの出どころは、組み込んでいなければ内部の名前を出さない（経由は手入力の語）
    const o = {
      source: "manual",
      client: null,
      externalSource: "ext.test",
      externalUrl: null,
    } as const;
    const t = (k: string) => translate("en", k as never);
    expect(ext.taskOrigins.size).toBe(0);
    expect(originLabel(o, t)).toBeNull();
    expect(viaLabel(o, t)).toBe(translate("en", "inbox.via.manual"));
    expect(originLabel({ ...o, externalSource: "github" }, t)).toBe("GitHub");
  });

  test("キーマップ: 拡張だけが使うキー（⌘↑↓・⌫ の外す）は無く、一覧・設定・衝突は今までどおり", () => {
    expect(KEYMAP.map((d) => d.id)).toEqual(keymapFor(false).map((d) => d.id));
    for (const id of EXT_ONLY) expect(KEYMAP.some((d) => d.id === id)).toBe(false);
    expect(matchIds("mod+arrowup", null).ids).toEqual([]);
    expect(matchIds("backspace", null).ids).toEqual(["unblock"]);
  });
});

describe("拡張のキー（ext-host の useKeys・足）", () => {
  test("拡張だけが使う定義: 辞書が英日にあり、拡張を組み込むと出て、既定の割り当てに衝突が無い", () => {
    for (const id of EXT_ONLY) {
      const d = ALL_KEYS.find((x) => x.id === id);
      expect(d?.ext).toBe(true);
      expect(en[d?.label as keyof typeof en]).toBeDefined();
      expect((ja as Record<string, unknown>)[d?.label as string]).toBeDefined();
    }
    setExtKeys(true);
    try {
      expect(EXT_ONLY.every((id) => KEYMAP.some((d) => d.id === id))).toBe(true);
      expect(matchIds("mod+arrowup", null).ids).toEqual(["reorderUp"]);
      expect(matchIds("mod+arrowdown", null).ids).toEqual(["reorderDown"]);
      // ⌫ は本体の「時間軸から外す」が先、処理が無ければ拡張の「外す」
      expect(matchIds("backspace", null).ids).toEqual(["unblock", "remove"]);
      expect(findConflicts({}, "Alt+Shift+Space")).toEqual([]);
      // 足の表記は今の割り当てから
      expect(footLabel(["next", "prev"])).toBe("j/k");
      expect(footLabel(["reorderUp", "reorderDown"])).toBe("⌘↑/⌘↓");
      expect(footLabel(["remove"])).toBe("⌫");
    } finally {
      setExtKeys(false);
    }
    expect(KEYMAP.some((d) => d.id === "reorderUp")).toBe(false);
  });

  test("Esc: 部品の escape が先、受けなければ控えの本体へ", () => {
    const calls: string[] = [];
    let hold = true;
    // 本体の控え（入力欄を抜けるだけの処理は画面の処理のまま）
    const exit = registerKeys(
      {
        current: {
          escape: () => {
            calls.push("exit");
            return true;
          },
        },
      },
      { fallback: true },
    );
    const blur = registerKeys({ current: { escape: () => false } });
    const part = registerKeys({
      current: {
        escape: () => {
          calls.push("part");
          return hold;
        },
      },
    });
    expect(dispatchKey("escape")).toBe(true);
    expect(calls).toEqual(["part"]);
    hold = false;
    expect(dispatchKey("escape")).toBe(true);
    expect(calls).toEqual(["part", "part", "exit"]);
    part();
    blur();
    exit();
  });
});

describe("テスト用の拡張", () => {
  const reg = buildRegistry([fixture]);

  test("一覧: id・辞書・各拡張点", () => {
    expect(reg.ids).toEqual(["test"]);
    expect(reg.messages.en["ext.test.nav"]).toBe("Test extension");
    expect(reg.messages.ja["ext.test.nav"]).toBe("テスト用の拡張");
    expect(reg.settingsSections.map((s) => s.key)).toEqual(["ext-test-main"]);
    expect(reg.routes.map((r) => r.path)).toEqual(["/ext/test", "/ext/test/bare"]);
    expect(reg.taskMenuItems.map((x) => x.key)).toEqual(["test:action"]);
    expect(reg.panelSections.map((x) => x.key)).toEqual(["test:panel"]);
    expect(reg.paletteCommands.map((x) => x.key)).toEqual(["test:cmd"]);
    expect(reg.launchFields.map((x) => x.key)).toEqual(["test:later", "test:rows"]);
    expect(reg.launchFields.map((x) => x.layout ?? "row")).toEqual(["row", "rows"]);
    expect(reg.timelineMarks.map((x) => x.ext)).toEqual(["test"]);
    expect(reg.sidebarItems.map((x) => x.key)).toEqual(["test:notice"]);
    expect(reg.trayItems.map((x) => x.key)).toEqual(["test:row"]);
    expect(reg.todayNotices.map((x) => x.key)).toEqual(["test:today"]);
  });

  test("拡張が作ったタスクの出どころ: 拡張の言葉と移る先（ExtTaskOrigin）", () => {
    const reg = buildRegistry([fixture]);
    expect(reg.taskOrigins.get("ext.test")).toMatchObject({ ext: "test", to: "/ext/test" });
    const o = {
      source: "manual",
      client: null,
      externalSource: "ext.test",
      externalUrl: null,
    } as const;
    const t = (k: string) => (reg.messages.en[k] as string | undefined) ?? k;
    expect(originLabel(o, t as never, reg.taskOrigins)).toBe("Test list");
    // 知らない ext. の出どころは出さない
    expect(
      originLabel({ ...o, externalSource: "ext.other" }, t as never, reg.taskOrigins),
    ).toBeNull();
    // 検査: source は ext.<id> か ext.<id>.<名前>、label は ext.<id>.
    const bad = (taskOrigins: NonNullable<WebExtension["taskOrigins"]>) =>
      checkWebExtension({ ...fixture, taskOrigins });
    expect(bad([{ source: "ext.test.review", label: "ext.test.origin" }])).toBeNull();
    expect(bad([{ source: "github", label: "ext.test.origin" }])).toMatch(/task origin/);
    expect(bad([{ source: "ext.testx", label: "ext.test.origin" }])).toMatch(/task origin/);
    expect(bad([{ source: "ext.test", label: "ext.other.x" }])).toMatch(/task origin label/);
    expect(
      bad([{ source: "ext.test", label: "ext.test.origin", primary: "menu.today" as never }]),
    ).toMatch(/task origin primary/);
  });

  test("出どころの主ボタン（ExtTaskOrigin.primary）: 未完了のタスクで自分の番の次に来る（D-192 §5.4 (3)）", () => {
    expect(reg.taskOrigins.get("ext.test")?.primary).toBe("ext.test.origin.primary");
    const base = {
      status: "todo" as const,
      scheduledDate: "2026-10-02",
      followUpId: null,
      ai: null,
    };
    expect(taskPrimaryOf(base, false, true)).toBe("extOrigin");
    expect(taskPrimaryOf(base, true, true)).toBe("extOrigin");
    expect(taskPrimaryOf({ ...base, followUpId: "f1" }, true, true)).toBe("openTurn");
    expect(taskPrimaryOf({ ...base, status: "done" }, true, true)).toBeNull();
    expect(taskPrimaryOf(base, true, false)).toBe("askAi");
  });

  test("タスクのメニュー: 1件・未完了のタスクだけに出る", () => {
    const todo = { kind: "task", task: { id: "t1", status: "todo" } } as unknown as SelItem;
    const done = { kind: "task", task: { id: "t2", status: "done" } } as unknown as SelItem;
    const turn = { kind: "turn", item: { workItemId: "w1" } } as unknown as SelItem;
    const ids = (xs: SelItem[]) => menuSpec(xs, {}, reg.taskMenuItems).map((m) => m.id);
    expect(ids([todo])).toContain("ext:test:action");
    expect(ids([done])).not.toContain("ext:test:action");
    expect(ids([todo, todo])).not.toContain("ext:test:action");
    expect(ids([turn])).not.toContain("ext:test:action");
    // 削除が最後のまま
    expect(menuSpec([todo], {}, reg.taskMenuItems).at(-1)?.id).toBe("delete");
  });

  test("⌘K の選択中: 右クリックと同じ拡張の項目（1件・未完了・when）", () => {
    const t = (k: string) => (reg.messages.en[k] as string | undefined) ?? k;
    const base = { t, tEn: t, titleOf: () => "" } as unknown as BuildInput;
    const todo = { kind: "task", task: { id: "t1", status: "todo" } } as unknown as SelItem;
    const done = { kind: "task", task: { id: "t2", status: "done" } } as unknown as SelItem;
    const turn = { kind: "turn", item: { workItemId: "w1", followUps: [] } } as unknown as SelItem;
    const rows = (selection: SelItem[], menu = reg.taskMenuItems) =>
      selectionRows({ ...base, selection, extTaskMenu: menu });
    const row = rows([todo]).find((r) => r.id === "sel:ext:test:action");
    expect(row?.label).toBe("Test action");
    expect(row?.section).toBe("selected");
    // 対象は実行の時の選択（最近から選んでも今の選択に効く）
    expect(row?.run).toEqual({ t: "extTask", key: "test:action" });
    expect(rows([done]).some((r) => r.id.startsWith("sel:ext:"))).toBe(false);
    expect(rows([todo, todo]).some((r) => r.id.startsWith("sel:ext:"))).toBe(false);
    expect(rows([turn]).some((r) => r.id.startsWith("sel:ext:"))).toBe(false);
    const never = reg.taskMenuItems.map((x) => ({ ...x, when: () => false }));
    expect(rows([todo], never).some((r) => r.id.startsWith("sel:ext:"))).toBe(false);
    // 拡張なし（このビルド）では出ない
    expect(
      selectionRows({ ...base, selection: [todo] }).some((r) => r.id.startsWith("sel:ext:")),
    ).toBe(false);
  });

  test("経路の題名と題名の右の部品", () => {
    const r = reg.routes.find((x) => x.path === "/ext/test");
    expect(r?.title).toBe("ext.test.title");
    expect(typeof r?.titleAside).toBe("function");
    expect(reg.messages.en["ext.test.title"]).toBe("Test page");
    expect(reg.routes.find((x) => x.path === "/ext/test/bare")?.title).toBeUndefined();
  });

  test("パレット: コマンドに出る", () => {
    const t = (k: string) => (reg.messages.en[k] as string | undefined) ?? k;
    const input = {
      q: "test command",
      category: "commands",
      t,
      tEn: t,
      shortDate: (d: string) => d,
      titleOf: () => "",
      today: "2026-10-08",
      now: 0,
      tz: "Asia/Tokyo",
      selection: [],
      queue: [],
      recent: [],
      search: undefined,
      theme: "system",
      language: "en",
      hooksText: null,
      calendarText: null,
      extCommands: reg.paletteCommands,
    } as unknown as BuildInput;
    const rows = buildSections(input).flatMap((s) => s.rows);
    expect(rows.find((r) => r.id === "cmd:ext:test:cmd")?.run).toEqual({
      t: "ext",
      key: "test:cmd",
    });
  });

  test("検査: 版・キーの接頭辞・経路・id の重複", () => {
    expect(checkWebExtension(fixture)).toBeNull();
    expect(checkWebExtension({ ...fixture, apiVersion: 99 })).toContain("api");
    expect(checkWebExtension({ ...fixture, i18n: { en: { "menu.today": "x" } } })).toContain(
      "message key",
    );
    expect(
      checkWebExtension({ ...fixture, routes: [{ path: "/board", component: () => null }] }),
    ).toContain("route");
    const other: WebExtension = { id: "other", apiVersion: 2 };
    expect(buildRegistry([fixture, fixture, other]).ids).toEqual(["test", "other"]);
  });
});

describe("画面の移動・AI の詳細パネル（ext-host の navigate / openAiPanel）", () => {
  test("navigate: ルーターで移り、?panel= なら AI 詳細パネルも開く", () => {
    const went: string[] = [];
    setAppNavigate((p) => went.push(p));
    setUi({ panelWorkItemId: null });
    openInApp("/inbox");
    openInApp("/board?panel=w1");
    expect(went).toEqual(["/inbox", "/board"]);
    expect(getUi().panelWorkItemId).toBe("w1");
    setUi({ panelWorkItemId: null });
  });

  test("openAiPanel: 枠の中ならその場で開き、枠が無ければ週ボードへ移って開く", () => {
    const went: string[] = [];
    setAppNavigate((p) => went.push(p));
    setUi({ panelWorkItemId: null });
    openAiPanelInApp("w2");
    expect(went).toEqual(["/board"]);
    expect(getUi().panelWorkItemId).toBe("w2");
    setUi({ panelWorkItemId: null });
    const off = markShell();
    openAiPanelInApp("w3");
    expect(went).toEqual(["/board"]);
    expect(getUi().panelWorkItemId).toBe("w3");
    off();
    setUi({ panelWorkItemId: null });
  });
});
