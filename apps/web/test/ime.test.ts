/** IME の変換確定の ⏎ を確定の操作として扱わない（lib/ime.ts） */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  AFTER_END_MS,
  createImeTracker,
  isImeKey,
  type KeyLike,
  readAfterComposition,
} from "../src/lib/ime.ts";

type Step =
  | { t: number; type: "compositionstart" }
  | { t: number; type: "compositionend" }
  | { t: number; type: "keydown"; key: string; keyCode: number; isComposing: boolean };

/** イベント列を流し、keydown ごとに「IME のキーか」を返す */
function run(steps: Step[]): boolean[] {
  const tr = createImeTracker();
  const out: boolean[] = [];
  for (const s of steps) {
    if (s.type === "compositionstart") tr.start();
    else if (s.type === "compositionend") tr.end(s.t);
    else
      out.push(
        tr.isImeKey({ key: s.key, keyCode: s.keyCode, isComposing: s.isComposing, timeStamp: s.t }),
      );
  }
  return out;
}

const kd = (t: number, key: string, keyCode: number, isComposing: boolean): Step => ({
  t,
  type: "keydown",
  key,
  keyCode,
  isComposing,
});

describe("Chrome 型（keydown が compositionend より先、isComposing=true）", () => {
  test("変換中の文字と確定の ⏎ は IME のもの。確定後に押した ⏎ は通す", () => {
    expect(
      run([
        kd(0, "Process", 229, false), // 最初の1打鍵（compositionstart の前に来る）
        { t: 1, type: "compositionstart" },
        kd(100, "Process", 229, true),
        kd(200, "Enter", 229, true), // 変換確定
        { t: 201, type: "compositionend" },
        kd(900, "Enter", 13, false), // 確定後にもう一度 ⏎（追加する）
      ]),
    ).toEqual([true, true, true, false]);
  });
  test("変換中の Esc（取り消し）も IME のもの", () => {
    expect(
      run([
        { t: 0, type: "compositionstart" },
        kd(100, "Escape", 229, true),
        { t: 101, type: "compositionend" },
        kd(800, "Escape", 27, false),
      ]),
    ).toEqual([true, false]);
  });
});

describe("WebKit 型（Safari・WKWebView。compositionend の後に isComposing=false の keydown）", () => {
  test("確定の ⏎ が keyCode 229 で来る", () => {
    expect(
      run([
        { t: 0, type: "compositionstart" },
        kd(50, "あ", 229, true),
        { t: 200, type: "compositionend" },
        kd(201, "Enter", 229, false),
        kd(900, "Enter", 13, false),
      ]),
    ).toEqual([true, true, false]);
  });
  test("確定の ⏎ が keyCode 13 で来ても、compositionend の直後なら IME のもの", () => {
    expect(
      run([
        { t: 0, type: "compositionstart" },
        { t: 200, type: "compositionend" },
        kd(201, "Enter", 13, false),
        kd(202, "Escape", 27, false),
        kd(200 + AFTER_END_MS + 1, "Enter", 13, false),
      ]),
    ).toEqual([true, true, false]);
  });
  test("compositionend の直後でも、⏎ / Esc / ⇥ 以外の文字は通す", () => {
    expect(run([{ t: 200, type: "compositionend" }, kd(201, "a", 65, false)])).toEqual([false]);
  });
});

describe("追跡の状態", () => {
  test("compositionstart から compositionend までは、isComposing が偽でも IME のもの", () => {
    const tr = createImeTracker();
    tr.start();
    expect(tr.isImeKey({ key: "t", keyCode: 84, isComposing: false, timeStamp: 10 })).toBe(true);
  });
  test("compositionend が来ないままフォーカスが外れたら戻す", () => {
    const tr = createImeTracker();
    tr.start();
    tr.reset();
    expect(tr.isImeKey({ key: "t", keyCode: 84, isComposing: false, timeStamp: 10 })).toBe(false);
  });
  test("IME を使っていなければ何も止めない", () => {
    const tr = createImeTracker();
    for (const key of ["Enter", "Escape", "Tab", "t", "j"])
      expect(tr.isImeKey({ key, keyCode: 13, isComposing: false, timeStamp: 5 })).toBe(false);
  });
  test("isImeKey は React の合成イベント（nativeEvent）も受ける", () => {
    const n: KeyLike = { key: "Enter", keyCode: 229, isComposing: false };
    expect(isImeKey({ nativeEvent: n })).toBe(true);
    expect(isImeKey({ key: "Enter", keyCode: 13, isComposing: false })).toBe(false);
  });
});

/** src 以下の .ts / .tsx */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? sources(p) : /\.tsx?$/.test(f) ? [p] : [];
  });
}

describe("テキスト入力のキー処理は共通の判定を通す", () => {
  const SRC = join(import.meta.dir, "../src");
  const files = sources(SRC).map((p) => ({
    path: relative(SRC, p),
    text: readFileSync(p, "utf8"),
  }));

  test("isComposing / keyCode 229 を直接見るのは lib/ime.ts だけ", () => {
    const bad = files
      .filter((f) => f.path !== join("lib", "ime.ts"))
      .filter((f) => /isComposing|keyCode\s*===?\s*229/.test(f.text))
      .map((f) => f.path);
    expect(bad).toEqual([]);
  });

  test("⏎ で確定する入力欄（onKeyDown で Enter を見るファイル）は isImeKey / blurOnEnter を使う", () => {
    const bad = files
      .filter((f) => /onKeyDown=\{\(e\)[\s\S]*?e\.key === "Enter"/.test(f.text))
      .filter((f) => !/from "\.\.\/lib\/ime\.ts"/.test(f.text))
      .map((f) => f.path);
    expect(bad).toEqual([]);
  });

  test("対象の入力欄が共通の判定を使っている", () => {
    const uses = (path: string, name: "isImeKey" | "blurOnEnter") =>
      (files.find((f) => f.path === path)?.text ?? "").includes(`${name}(`) ||
      (files.find((f) => f.path === path)?.text ?? "").includes(`={${name}}`);
    // c の新規タスク・r の題名・m の日付（ポップオーバーの入力）
    expect(uses(join("board", "editors.tsx"), "isImeKey")).toBe(true);
    // Inbox / Inbox トレイの + Add
    expect(uses(join("components", "AddRow.tsx"), "isImeKey")).toBe(true);
    // クイック入力・⌘K・キーボード設定のキー記録・設定の検索・ショートカット一覧
    expect(uses(join("routes", "QuickAddPage.tsx"), "isImeKey")).toBe(true);
    expect(uses(join("palette", "CommandPalette.tsx"), "isImeKey")).toBe(true);
    expect(uses(join("routes", "KeyboardSection.tsx"), "isImeKey")).toBe(true);
    expect(uses(join("routes", "SettingsPage.tsx"), "isImeKey")).toBe(true);
    expect(uses(join("keys", "KeyHelp.tsx"), "isImeKey")).toBe(true);
    // 詳細パネル（題名・見積の任意・時間の開始。⏎ で確定する欄は isImeKey で変換の確定を除く）
    expect(uses(join("panel", "TaskPanel.tsx"), "isImeKey")).toBe(true);
    // 設定の入力欄・計画の目安
    expect(uses(join("routes", "SettingsSections.tsx"), "blurOnEnter")).toBe(true);
    expect(uses(join("routes", "PlanGuideSection.tsx"), "blurOnEnter")).toBe(true);
    // 画面のキー処理（単打のショートカット）とポップオーバーの Esc
    expect(uses(join("keys", "use-keys.ts"), "isImeKey")).toBe(true);
    expect(uses(join("components", "ui.tsx"), "isImeKey")).toBe(true);
  });
});

describe("欄を離れたときの値（readAfterComposition）", () => {
  const field = (value: string) => {
    const t = new EventTarget() as EventTarget & { value: string };
    t.value = value;
    return t;
  };

  test("変換中でなければ、その場で DOM の値を読む", () => {
    const el = field("ドメインを取得する");
    let got: string | null = null;
    readAfterComposition(el, false, (v) => {
      got = v;
    });
    expect(got as string | null).toBe("ドメインを取得する");
  });

  test("変換中に離れたら、確定（compositionend と確定の文字）が届いてから読む（末尾を落とさない）", async () => {
    const el = field("ドメインを取得す");
    let got: string | null = null;
    readAfterComposition(el, true, (v) => {
      got = v;
    });
    expect(got as string | null).toBeNull();
    el.dispatchEvent(new Event("compositionend"));
    el.value = "ドメインを取得する"; // WebKit は compositionend の後に確定の input が来ることがある
    await Bun.sleep(5);
    expect(got as string | null).toBe("ドメインを取得する");
  });

  test("確定が来なければ timeout 後に読む", async () => {
    const el = field("abc");
    let got: string | null = null;
    readAfterComposition(
      el,
      true,
      (v) => {
        got = v;
      },
      10,
    );
    await Bun.sleep(30);
    expect(got as string | null).toBe("abc");
  });
});
