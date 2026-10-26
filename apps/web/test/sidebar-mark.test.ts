/**
 * 畳んだサイドバーの印（拡張の行・本体の項目）: 点・件数の丸は「見るものがある」ときだけ。ツールチップは開いたときの行と同じ文
 */
import { describe, expect, test } from "bun:test";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  SidebarMode,
  SidebarNotice,
  type SidebarNoticeProps,
  sidebarMark,
} from "../src/ext/parts.tsx";
import { navLabel } from "../src/layout/AppShell.tsx";

const router = createRouter({
  routeTree: createRootRoute(),
  history: createMemoryHistory({ initialEntries: ["/board"] }),
});

function render(mode: "full" | "rail", props: Partial<SidebarNoticeProps> = {}): string {
  const el = createElement(
    SidebarMode.Provider,
    { value: mode },
    createElement(SidebarNotice, { text: "Row", to: "/ext/x", ...props }),
  );
  // RouterContextProvider の型は children を props で要る（createElement の第3引数では型が合わない）
  // biome-ignore lint/correctness/noChildrenProp: 上の理由
  return renderToStaticMarkup(createElement(RouterContextProvider, { router, children: el }));
}

const hasDot = (h: string) => h.includes('data-testid="ext-sidebar-mark"');

describe("畳んだサイドバーの拡張の行の点", () => {
  test("件数も状態も無い行（neutral）には点を付けない", () => {
    const h = render("rail", { tone: "neutral", icon: "moon" });
    expect(hasDot(h)).toBe(false);
    expect(h).toContain('data-mark="false"');
    expect(hasDot(render("rail"))).toBe(false);
    expect(hasDot(render("rail", { count: 0 }))).toBe(false);
  });

  test("件数が 1 以上か、状態（neutral 以外の tone）があれば点を付ける", () => {
    const counted = render("rail", { count: 2 });
    expect(hasDot(counted)).toBe(true);
    expect(counted).toContain("bg-fg");
    for (const [tone, cls] of [
      ["running", "bg-running"],
      ["needs", "bg-needs"],
      ["error", "bg-error"],
      ["done", "bg-done"],
    ] as const) {
      const h = render("rail", { tone });
      expect(hasDot(h)).toBe(true);
      expect(h).toContain(cls);
    }
  });

  test("mark を指定すればそれに従う（件数の無い状態の行・点を止めたい行）", () => {
    expect(hasDot(render("rail", { mark: true }))).toBe(true);
    expect(hasDot(render("rail", { tone: "running", mark: false }))).toBe(false);
    expect(sidebarMark({ count: 3, mark: false })).toBe(false);
    expect(sidebarMark({})).toBe(false);
  });

  test("開いたサイドバーには点を描かない", () => {
    expect(hasDot(render("full", { count: 2, tone: "needs" }))).toBe(false);
  });

  test("ツールチップ（読み上げ）は開いたときの行の文と同じ。折り返しを止める見えない字は除く", () => {
    const h = render("rail", { text: "拡張の\u2060行 2 · 準備中", detail: "説明" });
    expect(h).toContain('aria-label="拡張の行 2 · 準備中\n説明"');
    expect(render("rail", { text: "Today's row" })).toContain('aria-label="Today&#x27;s row"');
  });

  test("今いる画面の面と枠は本体の項目と同じ（畳んだ・開いた）", () => {
    const rail = render("rail");
    expect(rail).toContain("[&amp;.active]:bg-raised");
    expect(rail).toContain("[&amp;.active]:shadow-[0_0_0_1px_var(--dl-border)]");
    expect(rail).toContain("size-9");
    const full = render("full");
    expect(full).toContain("[&amp;.active]:bg-raised");
    expect(full).toContain("[&amp;.active]:font-medium");
  });
});

describe("畳んだサイドバーの本体の項目のツールチップ", () => {
  test("件数があれば開いたときと同じく名前と件数、無ければ名前だけ", () => {
    expect(navLabel("自分の番", 3)).toBe("自分の番 3");
    expect(navLabel("Your turn", 3)).toBe("Your turn 3");
    expect(navLabel("自分の番", 0)).toBe("自分の番");
    expect(navLabel("Inbox")).toBe("Inbox");
  });
});
