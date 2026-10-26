/** タスクから開く（D-059。ux-mvp 4.11）: 種類ごとの既定の開き先と `o` のメニューの並び */
import { expect, test } from "bun:test";
import type { OpenLanding } from "../src/api/open.ts";
import {
  defaultOpenAction,
  OPEN_ACTIONS,
  openLandingShort,
  openLandingText,
  openMenu,
} from "../src/open.ts";

test("既定（⏎）: PR のレビューは PR、変更の確認は差分ツール、返答・許可・再開はセッション", () => {
  expect(defaultOpenAction("review_pr")).toBe("pr");
  expect(defaultOpenAction("merge_pr")).toBe("pr");
  expect(defaultOpenAction("check_changes")).toBe("diff");
  expect(defaultOpenAction("reply")).toBe("session");
  expect(defaultOpenAction("approve")).toBe("session");
  expect(defaultOpenAction("resume_error")).toBe("session");
});

test("o のメニュー: 種類ごとの他の開き方。カードだけなら全部", () => {
  expect(openMenu("review_pr")).toEqual(["pr", "pr_files", "editor"]);
  expect(openMenu("check_changes")).toEqual(["diff", "editor", "finder", "terminal"]);
  expect(openMenu("reply")).toEqual(["session", "editor", "copy_resume"]);
  expect([...openMenu(null)].sort()).toEqual([...OPEN_ACTIONS].sort());
});

test("着地の文（D-214 (4)）: タブまで行けたか、行けなかったなら理由を事実で言う", () => {
  const l = (x: Partial<OpenLanding>): OpenLanding => ({
    level: "tab",
    by: "tty",
    tab: null,
    pane: null,
    miss: null,
    ...x,
  });
  expect(openLandingText("iTerm2", l({ tab: 3 }), "ja")).toBe("iTerm2 のタブ 3 を前に出しました。");
  expect(openLandingText("iTerm2", l({ tab: 3 }), "en")).toBe("Brought iTerm2 tab 3 to the front.");
  expect(openLandingText("Ghostty", l({}), "ja")).toBe("Ghostty のタブを前に出しました。");
  expect(openLandingText("Ghostty", l({}), "en")).toBe("Brought the Ghostty tab to the front.");
  expect(openLandingText("Terminal", l({ tab: 2, pane: "work:2.1" }), "ja")).toBe(
    "ターミナルのタブ 2 で tmux の work:2.1 を選びました。",
  );
  expect(openLandingText("Terminal", l({ tab: 2 }), "en")).toBe(
    "Brought Terminal tab 2 to the front.",
  );
  expect(
    openLandingText("Ghostty", l({ by: "cwd", tab: 1, miss: "ambiguous", candidates: 2 }), "ja"),
  ).toBe("Ghostty で同じフォルダのタブが 2 個あり、タブ 1 を前に出しました。");
  const app = (x: Partial<OpenLanding>) => l({ level: "app", by: null, ...x });
  expect(openLandingText("Ghostty", app({ miss: "not_found" }), "ja")).toBe(
    "Ghostty を前に出しました。タブは見つかりませんでした。",
  );
  expect(openLandingText("Ghostty", app({ miss: "not_found" }), "en")).toBe(
    "Brought Ghostty to the front — couldn't find the tab.",
  );
  expect(openLandingText("Orca", app({ miss: "unsupported" }), "ja")).toBe(
    "Orca を前に出しました。Orca ではタブまでは選べません。",
  );
  expect(openLandingText("Ghostty", app({ pane: "work:2.1", miss: "not_found" }), "ja")).toBe(
    "tmux の work:2.1 を選び、Ghostty を前に出しました。タブは見つかりませんでした。",
  );
  // 行に残す短い形
  expect(openLandingShort("iTerm2", l({ tab: 3 }), "ja")).toBe("iTerm2 · タブ 3");
  expect(openLandingShort("iTerm2", l({ tab: 3 }), "en")).toBe("iTerm2 · tab 3");
  expect(openLandingShort("Ghostty", l({ pane: "work:2.1" }), "ja")).toBe("Ghostty · work:2.1");
  expect(openLandingShort("Orca", app({ miss: "unsupported" }), "ja")).toBe("Orca");
  expect(openLandingShort("Terminal", l({ tab: 1 }), "ja")).toBe("ターミナル · タブ 1");
  // タブまで行けたが番号が分からない: 「タブ」（答えるの届け先と同じ言葉。D-244）
  expect(openLandingShort("Ghostty", l({}), "ja")).toBe("Ghostty · タブ");
  expect(openLandingShort("Ghostty", l({}), "en")).toBe("Ghostty · tab");
  expect(openLandingShort("Ghostty", l({ tab: 2 }), "ja")).toBe("Ghostty · タブ 2");
});
