/** 入力の 1 行目が問い返しか（Issue #3）。文はすべて合成 */
import { describe, expect, test } from "bun:test";
import { asksBack } from "../src/asks-back.ts";

describe("asksBack", () => {
  test.each([
    "どうやって見るの？",
    "それはどこで確認できますか",
    "18 件ってどれのこと?",
    "ドライランとは",
    "ドライランって何",
    "なぜ 2 回走るの",
    "設定の場所を教えて",
    "やり方を教えてください",
    "何が違うのか分からない",
    "どうすれば全部見られる",
    "how do I see that?",
    "What is a dry run",
    "why does it run twice",
    "where is the log",
    "Which file did you change",
    "is it safe to delete the cache",
    "I don't understand the second step",
  ])("問い返し: %j", (s) => expect(asksBack(s)).toBe(true));

  test.each([
    "1 で",
    "全部見ました",
    "OK、進めて",
    "README も直してもらえますか？",
    "テストも書いてくれる？",
    "そのままでいいです",
    "Looks good, go ahead",
    "Can you also add tests?",
    "could you update the README?",
    "please rerun the migration",
    "Use the second option",
    "",
  ])("答え・依頼: %j", (s) => expect(asksBack(s)).toBe(false));

  test("null・undefined は問い返しではない", () => {
    expect(asksBack(null)).toBe(false);
    expect(asksBack(undefined)).toBe(false);
  });
});
