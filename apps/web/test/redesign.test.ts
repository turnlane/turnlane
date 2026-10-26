/**
 * 作り直したデザイン（D-099〜D-104。docs/design/README.md の「作り直し」）のトークンと部品の規則。
 * - 紫をやめた: 自分の番はティール（ライト #0D9488 / ダーク #2DD4BF）、主ボタン・選択・現在線は無彩色（text-primary）
 * - 予定は塗りだけ（D-103。event-surface-tokens.test.ts）、AI は線（AiRunBlock）
 * - 角丸: チップ 4 / 操作 6 / カード 8 / パネル・メニュー 12
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { QueueItem } from "@turnlane/core/web";
import { menuSpec } from "../src/actions/item-actions.tsx";
import { KEYMAP } from "../src/keys/keymap.ts";
import { longDate, turnCounts } from "../src/layout/AppShell.tsx";
import type { SelItem } from "../src/lib/store.ts";
import { filterOf } from "../src/routes/QueuePage.tsx";

const SRC = join(import.meta.dir, "../src");
const css = readFileSync(join(SRC, "styles.css"), "utf8");

function tokens(theme: "dark" | "light"): Map<string, string> {
  const start = css.indexOf(`:root[data-theme="${theme}"]`);
  const body = css.slice(start, css.indexOf("}", start));
  const out = new Map<string, string>();
  for (const m of body.matchAll(/(--dl-[\w-]+):\s*([^;]+);/g))
    out.set(m[1] as string, (m[2] as string).trim());
  return out;
}

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.(tsx?|css)$/.test(f) ? [p] : [];
  });
}

describe("色（D-104）", () => {
  test("自分の番はティール（ライト #0D9488、ダーク #2DD4BF）", () => {
    expect(tokens("light").get("--dl-turn")).toBe("#0d9488");
    expect(tokens("dark").get("--dl-turn")).toBe("#2dd4bf");
  });
  test("主ボタンは無彩色（text-primary の塗り）。上の文字はライト白・ダーク地の色", () => {
    for (const th of ["light", "dark"] as const)
      expect(tokens(th).get("--dl-accent")).toBe("var(--dl-text-1)");
    expect(tokens("light").get("--dl-on-accent")).toBe("#ffffff");
    expect(tokens("dark").get("--dl-on-accent")).toBe("#0e0f11");
    expect(css).toContain("--color-accent: var(--dl-accent);");
  });
  test("紫の値はどこにも無い", () => {
    for (const f of files(SRC)) {
      const s = readFileSync(f, "utf8").toLowerCase();
      for (const v of ["#9b7bff", "#6d4ae0", "violet", "purple-"]) expect(s).not.toContain(v);
    }
  });
  test("ティール（--dl-turn）は自分の番の意味でだけ使う: 現在線・選択・フォーカス・主ボタンには使わない", () => {
    expect(css).toMatch(/:focus-visible \{\s*outline: 1\.5px solid var\(--dl-accent\)/);
    const grid = readFileSync(join(SRC, "board/TimeGrid.tsx"), "utf8");
    expect(grid).not.toContain("dl-turn");
    const shell = readFileSync(join(SRC, "layout/AppShell.tsx"), "utf8");
    expect(shell).not.toContain("dl-turn");
  });
  test("ブロック中の行の面（琥珀 8%）と集計外の線のトークン", () => {
    expect(tokens("light").get("--dl-amber-surface")).toBe("#f5eee7");
    expect(tokens("dark").get("--dl-amber-surface")).toBe("#211b13");
    expect(tokens("light").get("--dl-line-excluded")).toBe("#c9cbcf");
  });
});

describe("角丸（tokens v4）", () => {
  test("チップ 4 / 操作 6 / カード 8 / パネル・メニュー 12", () => {
    expect(css).toContain("--radius-chip: 4px;");
    expect(css).toContain("--radius-control: 6px;");
    expect(css).toContain("--radius-card: 8px;");
    expect(css).toContain("--radius-pop: 12px;");
  });
});

describe("右クリックのメニュー（部品シート）", () => {
  const turn = { kind: "turn", item: { workItemId: "w1" } } as unknown as SelItem;
  test("対応不要・削除・非表示は区切りの下で赤", () => {
    const task = { kind: "task", task: { id: "t1", status: "todo" } } as unknown as SelItem;
    const ai: SelItem = { kind: "ai", id: "w2", title: null };
    for (const m of [menuSpec([task]), menuSpec([turn]), menuSpec([ai])])
      expect(m.at(-1)).toMatchObject({ danger: true, sep: true });
  });
  test("「AI に頼む」は今回は入れない（M5-B）", () => {
    expect(menuSpec([turn]).map((x) => x.id)).not.toContain("askAi");
    expect(KEYMAP.map((x) => x.id)).not.toContain("askAi");
  });
});

describe("上部バーとサイドバー", () => {
  const q = (status: string) => ({ status }) as unknown as QueueItem;
  test("「自分の番 N」はブロック中・エラーを含む合計（自分の番の画面のレビュー 1）", () => {
    expect(turnCounts([q("needs_input"), q("your_turn"), q("error"), q("your_turn")])).toEqual({
      total: 4,
      blocked: 1,
      error: 1,
    });
  });
  test("日付の見出しは `10月2日（金）` / `Fri, Oct 2`", () => {
    expect(longDate("2026-10-02", "ja")).toBe("10月2日（金）");
    expect(longDate("2026-10-02", "en")).toBe("Fri, Oct 2");
  });
});

describe("自分の番の画面", () => {
  const item = (status: string, kind: string) =>
    ({
      status,
      followUps: [{ id: "f", kind, status: "open", triggerAt: 0 }],
    }) as unknown as QueueItem;
  test("絞り込み: ブロック中（許可待ち）・エラー・レビュー（PR）・返答", () => {
    expect(filterOf(item("needs_input", "approve"))).toBe("blocked");
    expect(filterOf(item("error", "resume_error"))).toBe("error");
    expect(filterOf(item("your_turn", "review_pr"))).toBe("review");
    expect(filterOf(item("your_turn", "reply"))).toBe("reply");
  });
});
