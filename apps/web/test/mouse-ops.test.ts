/**
 * UX 監査（2026-10）の (a) 実装ですぐ直す（D-099・D-101）: マウスで完結する操作と、キーの誤動作の回帰テスト
 */
import { describe, expect, test } from "bun:test";
import { menuSpec, rangeKeys, toggleKey } from "../src/actions/item-actions.tsx";
import { bulkActions } from "../src/components/BulkBar.tsx";
import { KEYMAP } from "../src/keys/keymap.ts";
import { dispatchKey, registerKeys } from "../src/keys/use-keys.ts";
import { rangeLabel } from "../src/layout/AppShell.tsx";
import type { SelItem } from "../src/lib/store.ts";

// dispatchKey は KeyboardEvent を作る（bun test には無い）
if (!("KeyboardEvent" in globalThis))
  Object.assign(globalThis, {
    KeyboardEvent: class {
      constructor(readonly type: string) {}
    },
  });

const _ui = {
  panelWorkItemId: null,
  panelTaskId: null,
  panelEventId: null,
  palette: null,
  helpOpen: false,
  selection: [] as SelItem[],
};

describe("⏎ の控えの処理の順（U-08。朝の計画の帯は D-192 で廃止、順の規則だけ残す）", () => {
  test("後から登録した控えの処理は、画面の処理より後に回る", () => {
    const calls: string[] = [];
    const offScreen = registerKeys({
      current: {
        open: () => {
          calls.push("screen");
          return true;
        },
      },
    });
    const offBand = registerKeys(
      {
        current: {
          open: () => {
            calls.push("band");
            return true;
          },
        },
      },
      { fallback: true },
    );
    expect(dispatchKey("open")).toBe(true);
    expect(calls).toEqual(["screen"]);
    offScreen();
    expect(dispatchKey("open")).toBe(true);
    expect(calls).toEqual(["screen", "band"]);
    offBand();
  });
});

describe("未実装のキーを出さない（D-101 (4)）", () => {
  test("b・*・f・⌘. は定義に無い（`?` の一覧・⌘K・キーボードの設定は定義から作る）", () => {
    const ids = KEYMAP.map((d) => d.id);
    expect(ids).not.toContain("someday");
    expect(ids).not.toContain("highlight");
    const keys = KEYMAP.flatMap((d) => d.keys);
    for (const k of ["b", "*", "f", "mod+."]) expect(keys).not.toContain(k);
  });
});

describe("週表示の見出し（D-101 (3)）", () => {
  const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8))}`;
  test("表示中の7日の範囲", () => {
    expect(rangeLabel({ from: "2026-10-01", to: "2026-10-07" }, "2026-10-02", md)).toBe(
      "10/1 – 10/7",
    );
  });
  test("範囲がまだ無ければ基準日", () => {
    expect(rangeLabel(null, "2026-10-02", md)).toBe("10/2");
  });
});

// 右クリックメニューの対象（最小のダミー。メニューが読むのは kind と task.status だけ）
const task = (status = "todo") =>
  ({ kind: "task", task: { id: "t1", status } }) as unknown as SelItem;
const turn = { kind: "turn", item: { workItemId: "w1" } } as unknown as SelItem;
const ai: SelItem = { kind: "ai", id: "w2", title: null };

describe("右クリックメニュー（UX 監査 A1。5.P3）", () => {
  const ids = (xs: { id: string }[]) => xs.map((x) => x.id);
  test("タスク: 詳細・完了・AI に頼む・今日へ・1日後へ・日付・時間に置く・名前・削除（削除は区切りの下）", () => {
    const m = menuSpec([task()]);
    expect(ids(m)).toEqual([
      "detail",
      "complete",
      "askAi",
      "today",
      "later",
      "move",
      "place",
      "rename",
      "delete",
    ]);
    expect(m.at(-1)).toMatchObject({ danger: true, sep: true });
  });
  test("時間軸のタスクには「時間から外す」、完了したタスクは「未完了に戻す」", () => {
    expect(ids(menuSpec([task()], { placed: true }))).toContain("unblock");
    expect(menuSpec([task("done")]).find((x) => x.id === "complete")?.label).toBe(
      "menu.uncomplete",
    );
  });
  test("自分の番: 開いて対応・他の開き方・詳細・完了 / 明日へ・スヌーズ / 対応不要（確定デザインの並び）", () => {
    const m = menuSpec([turn]);
    expect(ids(m)).toEqual(["open", "openWith", "detail", "complete", "move", "snooze", "dismiss"]);
    expect(m.at(-1)).toMatchObject({ danger: true, sep: true });
  });
  test("AI の作業: 開く・詳細・他の開き方・返答タスク・完了にする・非表示", () => {
    expect(ids(menuSpec([ai]))).toEqual([
      "open",
      "detail",
      "openWith",
      "replyTask",
      "aiDone",
      "aiHide",
    ]);
  });
  test("予定: 詳細・カレンダーで開く。編集できる予定だけ削除", () => {
    expect(ids(menuSpec([], { event: { editable: false } }))).toEqual(["detail", "eventOpen"]);
    expect(ids(menuSpec([], { event: { editable: true } }))).toContain("eventDelete");
  });
  test("予定: カレンダーが分かれば「カレンダーの色 ▸」（D-125。読み取りのみの予定でも。削除の上）", () => {
    expect(ids(menuSpec([], { event: { editable: false, calendarId: "c1" } }))).toEqual([
      "detail",
      "eventOpen",
      "calColor",
    ]);
    expect(ids(menuSpec([], { event: { editable: true, calendarId: "c1" } }))).toEqual([
      "detail",
      "eventOpen",
      "calColor",
      "eventDelete",
    ]);
  });
  test("複数選択では1件だけの操作（詳細・名前・時間に置く）を出さない", () => {
    const m = ids(menuSpec([task(), task()]));
    expect(m).not.toContain("detail");
    expect(m).not.toContain("rename");
    expect(m).not.toContain("place");
    expect(ids(menuSpec([task(), turn]))).toEqual(["complete", "today", "delete"]);
  });
  test("キーの処理を呼ぶ行は keymap の定義にある id（キーの表記は今の割り当てから出す）", () => {
    const defs = new Set(KEYMAP.map((d) => d.id));
    for (const m of [menuSpec([task()], { placed: true }), menuSpec([turn]), menuSpec([ai])])
      for (const x of m) if (x.action.t === "key") expect(defs.has(x.action.id)).toBe(true);
  });
});

describe("⇧ / ⌘ クリックの複数選択（UX 監査 A14）", () => {
  const order = ["a", "b", "c", "d"];
  test("⇧ クリックは今の選択からの範囲（逆向きも）", () => {
    expect(rangeKeys(order, "b", "d")).toEqual(["b", "c", "d"]);
    expect(rangeKeys(order, "c", "a")).toEqual(["a", "b", "c"]);
    expect(rangeKeys(order, null, "c")).toEqual(["c"]);
  });
  test("⌘ クリックは選択に加える・外す（選んでいた1件も含める）", () => {
    expect(toggleKey([], "a", "c")).toEqual(["a", "c"]);
    expect(toggleKey(["a", "c"], "c", "c")).toEqual(["a"]);
    expect(toggleKey([], null, "b")).toEqual(["b"]);
  });
  test("一括操作のバー: タスクは今日へ・1日後へ・完了・削除、自分の番は明日へ・対応不要・完了", () => {
    expect(bulkActions(["task:1", "task:2"]).map((x) => x.id)).toEqual([
      "today",
      "later",
      "complete",
      "delete",
    ]);
    expect(bulkActions(["turn:1"]).map((x) => x.id)).toEqual(["move", "dismiss", "complete"]);
  });
});
