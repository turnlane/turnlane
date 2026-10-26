import { describe, expect, test } from "bun:test";
import {
  endsWithQuestion,
  isClosingQuestion,
  questionExcerpt,
  textTraits,
} from "../src/closing-question.ts";

/**
 * 判断を待つ返答のまとまり（見出し＋列挙＋判断待ちの条件文）。最後の段落だけでは問いに見えない形。
 * 文面は作り話（実際のセッションの文面は入れない）
 */
const DECISION_BLOCK = [
  "決めていただきたいこと",
  "",
  "1. 「役割ではなく文脈で分ける」という方向で進めてよいか",
  "2. 最初に移すのを A と B の 2 体にするか",
  "3. 試すのを X にするか Y にするか",
  "",
  "決まったら、変更案（設定の差分と下書き 2 本）をファイルに書く前にお見せします。",
].join("\n");

const ASK = { question: true, closing: false };
const NONE = { question: false, closing: false };

/** 自分の番（問い）になるもの */
const QUESTION_JA = [
  DECISION_BLOCK,
  // 見出し＋列挙（短い締めで終わる）
  "## ご判断いただきたい点\n\n- キャッシュを残すかどうか\n- 期限を 7 日にするか 30 日にするか\n\nテストは通っています。",
  "確認したいこと\n\n- 名前を変えるか\n- 古い設定を消してよいか",
  "質問\n\n1. 既定をオンにするか\n2. 移行を先に入れるか",
  "お聞きしたいことが 2 点あります。\n\n- 表の列を増やすか\n- 並び順を変えるか",
  // 条件文だけ
  "下書きは手元にあります。\n\nご指示があれば、そのまま PR を作ります。",
  "方針が決まり次第、実装に入ります。",
  "どちらにするか決まり次第、差分をお見せします。",
  "お返事をいただければ続けます。",
  "OK なら main に入れます。",
  "この案でよければ進めます。",
  "ご判断いただければ、残りを直します。",
  // 列挙だけ
  "残っている点です。\n\n- 古い行を消すか\n- 移行を後回しにするかどうか",
  // 依頼の形
  "どちらの方式にするか決めていただきたいです。",
  "既定の値を教えていただけますか。",
  "表示する列をお選びいただければと思います。",
  "ご判断いただけると助かります。",
  "移行の順番を決めてもらえますか。",
  "どちらがよいか教えてほしいです。",
];

const QUESTION_EN = [
  // 見出し＋列挙＋条件文
  "Decisions I need from you\n\n1. Whether to split by context instead of role\n2. Which two agents to move first\n3. X or Y for the trial\n\nOnce you decide, I'll show you the diff before writing anything.",
  "Questions for you:\n\n- whether to keep the cache\n- which branch to target",
  "Open questions\n\n- Postgres or SQLite\n- REST or RPC",
  // 条件文だけ
  "The draft is ready.\n\nOnce you confirm, I'll open the PR.",
  "When you've decided, I'll apply the change.",
  "If that works for you, I'll merge it tonight.",
  "Let me know and I'll update the config.",
  "After you confirm the scope, I'll start on the tests.",
  // 列挙だけ
  "Two things remain.\n\n- whether to rename the flag\n- which default to use",
  // 見出しの言い回し
  "I need you to decide between the two layouts.",
  "Your call on the naming.",
];

/** 問いにならないもの（作業の依頼・作業が残るだけの報告） */
const NOT_QUESTION = [
  "確認してください。",
  "試してください。",
  "マージしてください。",
  "PR を作りました。\n\nマージしてください。",
  "PR を作成しました。ご確認いただければと思います。",
  "完了しました。マージは PO が行います。",
  "ここまで済みました。次は入れ直しです。",
  "変更点\n\n- 判定を直した\n- テストを足した\n\n完了しました。マージは PO が行います。",
  "調べたこと\n\n- なぜ落ちていたか\n- どこで止まっていたのか\n\n原因はタイムゾーンでした。",
  "CI が通って問題なければマージします。",
  "Please try it on your machine.",
  "Please merge when ready.",
  "Done. The merge is up to you.",
  "Changes\n\n- Fixed A or B handling\n- Supports Linux or macOS\n\nAll tests pass.",
  "Summary\n\n- whether-check moved into the parser\n\nDone.",
  "- Which files changed\n- How it was tested\n\nDone.",
];

/** 締め（返答タスクを作らない） */
const CLOSING = [
  "直しました。\n\n- 判定を直した\n- テストを足した\n\n他に何かあれば教えてください。",
  "必要であれば言ってください。",
  "他に何かあれば。",
  "必要であれば追加で調整しますので教えてください。",
  "Fixed.\n\n- parser\n- tests\n\nLet me know if you need anything else.",
  "Anything else?",
];

describe("判断を待つ返答のまとまり", () => {
  test("見出し＋列挙＋条件文は問い（作り話の例）", () => {
    expect(textTraits(DECISION_BLOCK)).toEqual(ASK);
    expect(endsWithQuestion(DECISION_BLOCK)).toBe(true);
    expect(isClosingQuestion(DECISION_BLOCK)).toBe(false);
  });
  test("表示: 列挙の最後の 2 項目を出す（条件文より問いの文を優先）", () => {
    const q = questionExcerpt(DECISION_BLOCK);
    expect(q?.row).toBe("試すのを X にするか Y にするか");
    expect(q?.detail).toBe("最初に移すのを A と B の 2 体にするか 試すのを X にするか Y にするか");
  });
  test("表示: 条件文しか無ければ条件文", () => {
    expect(questionExcerpt("ご指示があれば、そのまま PR を作ります。")?.row).toBe(
      "ご指示があれば、そのまま PR を作ります。",
    );
  });
  test("表示: 見出しだけが問いなら見出し", () => {
    expect(questionExcerpt("確認したいこと\n\n- 名前\n- 期限\n\n以上です。")?.row).toBe(
      "確認したいこと",
    );
  });
  test.each(QUESTION_JA)("日本語: %j → 問い", (s) => expect(textTraits(s)).toEqual(ASK));
  test.each(QUESTION_EN)("英語: %j → 問い", (s) => expect(textTraits(s)).toEqual(ASK));
  test.each(NOT_QUESTION)("問いではない: %j", (s) => expect(textTraits(s)).toEqual(NONE));
  test.each(CLOSING)("締め（返答タスクを作らない）: %j", (s) => {
    expect(isClosingQuestion(s)).toBe(true);
    const t = textTraits(s);
    expect(t.question && !t.closing).toBe(false);
  });
  test("締めの後ろの段落が長ければ直前の段落を見ない", () => {
    const longTail = `${"報告です。".repeat(30)}`;
    expect(endsWithQuestion(`- 消すか\n- 残すか\n\n${longTail}`)).toBe(false);
  });
  test("直前の段落が箇条書きでなければ短い締めでも見ない（今までどおり）", () => {
    expect(endsWithQuestion("どちらにしますか？\n\nテストは通っています。")).toBe(false);
  });
  test("600 文字の上限は保つ", () => {
    const long = `決めていただきたいこと\n\n- ${"あ".repeat(700)}\n\n決まったら直します。`;
    expect(endsWithQuestion(long)).toBe(true);
  });
});
