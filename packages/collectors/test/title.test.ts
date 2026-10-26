import { describe, expect, test } from "bun:test";
import { cleanSubjectLine, cleanTitle, TITLE_ACKS, TITLE_MAX } from "../src/index.ts";

describe("cleanTitle（ai-session-ingestion 4.4）", () => {
  const cases: [string, unknown, string | null][] = [
    // 普通の題名はそのまま
    ["英語の題名", "Fix the login validation", "Fix the login validation"],
    ["日本語の題名", "ログイン画面の検証を直す", "ログイン画面の検証を直す"],
    ["OK で始まる英語の語", "OKR dashboard layout", "OKR dashboard layout"],
    ["英語の相づち＋空白＋英語は題名のまま", "OK button styling", "OK button styling"],
    ["Continue で始まる英語の題名", "Continue the parser refactor", "Continue the parser refactor"],
    ["y で始まる語", "yarn workspace setup", "yarn workspace setup"],
    ["相づち＋ハイフンは語の一部", "Yes-no toggle", "Yes-no toggle"],
    ["日本語の相づちの後に区切りが無い", "続けて実装する範囲の整理", "続けて実装する範囲の整理"],
    ["不等号はタグではない", "Compare a < b > c values", "Compare a < b > c values"],
    ["改行と連続空白は 1 つの空白", "Fix  the\nlogin  form", "Fix the login form"],
    // 貼り付けの印
    ["貼り付けの印だけ", '<pasted_content id="c7b5">', null],
    [
      "貼り付けの印（閉じあり）は中身ごと",
      '<pasted_content id="c7b5">pasted body</pasted_content>',
      null,
    ],
    ["貼り付けの印＋本文", '<pasted_content id="c7b5"> ビルドの失敗を直す', "ビルドの失敗を直す"],
    [
      "閉じありの印の後ろの本文",
      '<pasted_content id="a1">xxx</pasted_content> Fix the build',
      "Fix the build",
    ],
    ["ほかのタグもはがす", "<command-name>/review</command-name>", "/review"],
    ["タグだけ", "<local-command-stdout></local-command-stdout>", null],
    // 相づち
    ["OK", "OK", null],
    ["ok", "ok", null],
    ["はい", "はい", null],
    ["了解しました。", "了解しました。", null],
    ["つづきやって", "つづきやって", null],
    ["進めてください", "進めてください", null],
    ["ありがとうございます！", "ありがとうございます！", null],
    ["thank you", "Thank you!", null],
    // 相づち＋本文
    ["OK。コミットしておいて", "OK。コミットしておいて", "コミットしておいて"],
    ["OK＋空白＋日本語", "OK コミットしておいて", "コミットしておいて"],
    ["はい、＋本文", "はい、テストを足して", "テストを足して"],
    ["相づちが重なる", "はい、OK。READMEを直す", "READMEを直す"],
    ["英語の相づち＋句読点", "OK, add the migration", "add the migration"],
    ["相づち＋短すぎる残り", "OK。直す", null],
    // 3 文字以下・記号だけ
    ["3 文字", "Fix", null],
    ["空白を除いて 3 文字", " a b c ", null],
    ["4 文字は使う", "UI改善", "UI改善"],
    ["記号だけ", "...!?", null],
    ["全角の記号だけ", "「」。、・…", null],
    ["空", "", null],
    ["文字列でない", 42, null],
    ["undefined", undefined, null],
  ];
  for (const [name, raw, want] of cases) {
    test(name, () => expect(cleanTitle(raw)).toBe(want));
  }

  test(`${TITLE_MAX} 文字で切る（末尾は …）`, () => {
    const long = "あ".repeat(120);
    const got = cleanTitle(long);
    expect([...(got ?? "")].length).toBe(TITLE_MAX);
    expect(got?.endsWith("…")).toBe(true);
    expect(cleanTitle("い".repeat(TITLE_MAX))).toBe("い".repeat(TITLE_MAX));
  });

  test("表のどの相づちも、それだけなら無い扱い", () => {
    for (const a of TITLE_ACKS) expect(cleanTitle(a)).toBeNull();
  });
});

describe("cleanSubjectLine（自分の指示の 1 行目の掃除）", () => {
  test("空同然は null、相づちで始まる文はそのまま、タグは除く", () => {
    expect(cleanSubjectLine("OK", 120)).toBeNull();
    expect(cleanSubjectLine('<pasted_content id="1">', 120)).toBeNull();
    expect(cleanSubjectLine('OK <pasted_content id="1">本文</pasted_content>', 120)).toBeNull();
    expect(cleanSubjectLine("はい、その方針で進めて", 120)).toBe("はい、その方針で進めて");
    expect(cleanSubjectLine('税率を直して <pasted_content id="2">', 120)).toBe("税率を直して");
    expect(cleanSubjectLine("あ".repeat(130), 120)?.length).toBe(120);
  });
});
