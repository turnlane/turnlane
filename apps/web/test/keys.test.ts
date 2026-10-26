/** ⏎ と詳細パネルのキー（D-067）と、メニューバーから詳細パネルを開く path */
import { describe, expect, test } from "bun:test";
import { keyName } from "../src/keys/keymap.ts";
import { matchIds } from "../src/keys/use-keys.ts";
import { panelPath, takePanelParam } from "../src/lib/desktop.ts";

const ev = (key: string, meta = false) => ({
  key,
  metaKey: meta,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
});

describe("⏎ の統一（D-067）", () => {
  test("⏎ は開く・対応だけ", () => {
    expect(matchIds(keyName(ev("Enter")), null).ids).toEqual(["open"]);
  });
  test("→ は詳細パネル", () => {
    expect(matchIds(keyName(ev("ArrowRight")), null).ids).toEqual(["detail"]);
  });
  test("⌘⏎ は詳細パネル", () => {
    expect(matchIds(keyName(ev("Enter", true)), null).ids).toEqual(["detail"]);
  });
});

describe("panel の path", () => {
  test("作って取り出せる", () => {
    const p = panelPath("wi/1 2");
    expect(takePanelParam(p)).toEqual({ path: "/board", panel: "wi/1 2", answer: false });
  });
  test("他の検索語は残す", () => {
    expect(takePanelParam("/day?x=1&panel=a#h")).toEqual({
      path: "/day?x=1#h",
      panel: "a",
      answer: false,
    });
  });
  test("無ければそのまま", () => {
    expect(takePanelParam("/queue?open=f1")).toEqual({
      path: "/queue?open=f1",
      panel: null,
      answer: false,
    });
  });
  test("「答える」の節も開く（D-238）。panel が無ければ answer は読まない", () => {
    expect(takePanelParam(panelPath("w1", { answer: true }))).toEqual({
      path: "/board",
      panel: "w1",
      answer: true,
    });
    expect(takePanelParam("/board?answer=1")).toEqual({
      path: "/board",
      panel: null,
      answer: false,
    });
  });
});
