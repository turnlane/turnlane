import { describe, expect, test } from "bun:test";
import {
  answerLanding,
  answerSentText,
  answerWhere,
  numberedOptions,
  prepareAnswer,
} from "../src/answer.ts";
import { openLandingText } from "../src/open.ts";

describe("prepareAnswer（D-238）", () => {
  test("1 行はそのまま（前後の空白を落とす）", () => {
    expect(prepareAnswer("  はい、進めて  ", false)).toEqual({
      text: "はい、進めて",
      folded: false,
    });
  });
  test("空・空白だけは null", () => {
    expect(prepareAnswer("", false)).toBeNull();
    expect(prepareAnswer(" \n \r\n\t", true)).toBeNull();
  });
  test("複数行を畳む: 行を空白でつなぎ、空行を落とす（改行を Enter にしない）", () => {
    expect(prepareAnswer("A にして\r\n\r\nB は不要\n", false)).toEqual({
      text: "A にして B は不要",
      folded: true,
    });
  });
  test("multiline なら LF のまま（CRLF は LF、前後の空行は落とす）", () => {
    expect(prepareAnswer("\nA\r\n\r\nB\n\n", true)).toEqual({ text: "A\n\nB", folded: false });
  });
  test("制御文字（ESC・BEL・DEL）を除き、タブは空白", () => {
    expect(prepareAnswer("a\u001b[2Jb\u0007\tc\u007f", false)).toEqual({
      text: "a[2Jb c",
      folded: false,
    });
  });
});

describe("numberedOptions", () => {
  test("最後の番号の並びを選択肢にする", () => {
    const t = [
      "手順は 1. 調べる 2. 直す の順です。",
      "",
      "どちらにしますか？",
      "1. Issue にする",
      "2. **実装まで進める**",
      "3) 何もしない",
    ].join("\n");
    expect(numberedOptions(t)).toEqual([
      { n: 1, label: "Issue にする" },
      { n: 2, label: "実装まで進める" },
      { n: 3, label: "何もしない" },
    ]);
  });
  test("説明の字下げ・空行は並びを切らない", () => {
    expect(numberedOptions("1. A\n   説明\n\n2. B")).toEqual([
      { n: 1, label: "A" },
      { n: 2, label: "B" },
    ]);
  });
  test("1 つだけ・番号の飛び・1 から始まらないものは選択肢にしない", () => {
    expect(numberedOptions("1. だけ")).toEqual([]);
    expect(numberedOptions("2. B\n3. C")).toEqual([]);
    expect(numberedOptions("1. A\n3. C")).toEqual([]);
  });
  test("後ろの並びが優先（前に別の番号の並びがあっても）", () => {
    expect(numberedOptions("1. x\n2. y\n\n本文\n1. P\n2. Q")).toEqual([
      { n: 1, label: "P" },
      { n: 2, label: "Q" },
    ]);
  });
});

describe("届け先の言葉", () => {
  test("タブ・タブの番号・tmux のペイン", () => {
    expect(answerWhere("Orca", {}, "ja")).toBe("Orca · タブ");
    expect(answerWhere("iTerm2", { tab: 3 }, "ja")).toBe("iTerm2 · タブ 3");
    expect(answerWhere("Ghostty", { pane: "main:1.0" }, "en")).toBe("Ghostty · main:1.0");
    expect(answerWhere("iTerm2", { tab: 2 }, "en")).toBe("iTerm2 · tab 2");
  });
  test("ターミナル.app は日本語では「ターミナル」（D-243）", () => {
    expect(answerWhere("Terminal", {}, "ja")).toBe("ターミナル · タブ");
    expect(answerWhere("Terminal", {}, "en")).toBe("Terminal · tab");
    const tab = { level: "tab" as const, by: "tty" as const, tab: 2, pane: null, miss: null };
    expect(answerLanding("Terminal", "terminal", null, tab, "ja")).toBe("ターミナル · タブ 2");
    expect(answerLanding("Terminal", "tmux", "w:1.0", null, "ja")).toBe("ターミナル · w:1.0");
  });
  test("Ghostty（tmux の外。D-244）は「Ghostty · タブ」", () => {
    expect(answerWhere("Ghostty", {}, "ja")).toBe("Ghostty · タブ");
    expect(answerWhere("Ghostty", { pane: null }, "en")).toBe("Ghostty · tab");
    const tab = { level: "tab" as const, by: "tty" as const, tab: 2, pane: null, miss: null };
    expect(answerLanding("Ghostty", "ghostty", null, tab, "ja")).toBe("Ghostty · タブ 2");
    expect(answerLanding("Ghostty", "ghostty", null, null, "ja")).toBe("Ghostty · タブ");
    expect(openLandingText("Ghostty", tab, "ja")).toBe("Ghostty のタブ 2 を前に出しました。");
  });
  test("送った後: タブを前に出した番号を使う。tmux はペイン", () => {
    const tab = { level: "tab" as const, by: "tty" as const, tab: 3, pane: null, miss: null };
    expect(answerLanding("iTerm2", "iterm", null, tab, "ja")).toBe("iTerm2 · タブ 3");
    expect(answerLanding("Ghostty", "tmux", "w:1.0", tab, "ja")).toBe("Ghostty · w:1.0");
    expect(answerLanding("Orca", "orca", null, null, "ja")).toBe("Orca · タブ");
  });
  test("知らせの文", () => {
    expect(answerSentText({ confirmed: true, landing: "Orca · タブ" }, "ja")).toBe(
      "送りました · Orca · タブ",
    );
    expect(answerSentText({ confirmed: false, landing: "Orca · タブ" }, "ja")).toBe(
      "送りましたが進んだか確認できません · Orca · タブ",
    );
    expect(answerSentText({ confirmed: true, landing: "Orca · tab" }, "en")).toBe(
      "Sent · Orca · tab",
    );
  });
});
