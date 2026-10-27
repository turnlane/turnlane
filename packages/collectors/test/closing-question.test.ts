import { describe, expect, test } from "bun:test";
import { endsWithQuestion, isClosingQuestion, textTraits } from "../src/closing-question.ts";

// phase0-plan 5.5: 締めの決まり文句の判定は日本語・英語各30件程度の表で確かめる
const CLOSING_JA = [
  "他に何かありますか？",
  "何か他にお手伝いできることはありますか？",
  "他にご質問はありますか？",
  "ほかに何かありますか?",
  "他に何かお手伝いできることはありますか？",
  "修正しました。他に何かお手伝いできることはありますか？",
  "他にご要望はありますか？",
  "他に気になる点はありますか？",
  "他に対応することはありますか？",
  "他にやることはありますか？",
  "何か他にご質問はございますか？",
  "他にも何かありますか？",
  "ほかに確認したいことはありますか？",
  "何かご不明な点はありますか？",
  "ご不明な点はありますか？",
  "何か気になる点はありますか？",
  "他に何かございますか？",
  "他に必要なことはありますか？",
  "以上です。他に何かありますか？",
  "他にありますか？",
  "何か他にありますか？",
  "引き続き何かお手伝いできることはありますか？",
  "他に何かお手伝いできることがあれば",
  "何かあればお知らせください。",
  "必要があればお気軽にお知らせください。",
  "ご不明な点があればお知らせください。",
  "何かありましたらお申し付けください。",
  "ほかに気になることはありますか？",
  "他になにかありますか？",
  "ご質問があればお知らせください。",
  // D-066: 締めの決まり文句を広げた分（質問の言い回しを含むが締め）
  "必要であれば追加で調整しますので教えてください。",
  "他に何かあれば教えてください。",
  "ご要望があればお気軽にどうぞ。",
  "修正しました。必要であれば turnlane reingest を実行してください。",
  "何かあればいつでも聞いてください？",
];

const CLOSING_EN = [
  "Anything else?",
  "Is there anything else?",
  "Is there anything else I can help with?",
  "Anything else you'd like me to do?",
  "Let me know if you'd like any changes.",
  "Let me know if you need anything else.",
  "Let me know if there's anything else.",
  "Let me know if you have any questions.",
  "Let me know if you would like me to adjust anything.",
  "Feel free to ask if you have questions.",
  "Don't hesitate to reach out.",
  "Any other questions?",
  "Do you have any other questions?",
  "Hope this helps!",
  "I hope this helps.",
  "Happy to help with anything else!",
  "What else can I help with?",
  "Can I help with anything else?",
  "Is there anything else you'd like?",
  "Done. Anything else?",
  "Need anything else?",
  "Do you need anything else?",
  "Just let me know if you want changes.",
  "Let me know if anything needs tweaking.",
  "Any further questions?",
  "Is there anything else you want me to look at?",
  "Anything else I can do?",
  "Feel free to let me know.",
  "Let me know if I can help further.",
  "Let me know if you’d like any changes.",
  // D-066
  "I can also add tests if you need anything else.",
  "Happy to adjust if you need anything else!",
  "If you have any other questions, let me know.",
  "Feel free to ping me if there's anything else?",
];

const REAL_QUESTIONS = [
  "どちらの案にしますか？",
  "Should I proceed with the migration?",
  "この方針で進めてよろしいですか？",
  "A と B のどちらがよいでしょうか？",
  "マイグレーションを実行しますか？",
  "Which option do you prefer?",
  "Do you want me to open a PR?",
  "テストも追加しますか？",
  "Should I also update the docs?",
  "ブランチ名は何にしますか？",
];

/**
 * D-066 (1): 答え・判断を求める言い回し（質問 true・締め false）。「？」が無い・文末でないものを含む。
 * 先頭の行はオーナーの実機で YOUR TURN に出なかった例（本文は匿名化した言い換え）
 */
const ASK_JA = [
  "ほかに、前のメッセージで聞いた 2 点の回答を待っています。",
  "上の2点について回答を待っています。",
  "返答を待っています。",
  "どちらの方式にするか教えてください。",
  "移行の方針を決めてください。",
  "A 案と B 案から選んでください。",
  "この PR をマージするかどうしますか。",
  "設定の置き場所をどうしましょう。",
  "このまま進めてよいですか。",
  "main に直接入れてもいいですか",
  "削除してよいか確認させてください。",
  "問題ないかご確認ください。",
  "ご判断をお願いします。",
  "ご指示ください。",
  "次の手順はいかがしましょう。",
  "優先度について確認させてください。\n1. API を先に作る\n2. UI を先に作る",
  "2点あります。\n\n1. 名前は X でよいか？\n2. 期限はいつか",
  "実装は終わりました。ところで、ログの保存期間は 7 日と 30 日のどちらがよいでしょうか。テストは通っています。",
  "**どちらにしますか？**",
  "`main` に入れますか?\n",
];

const ASK_EN = [
  "Let me know which option you prefer.",
  "Which do you prefer: A or B.",
  "Should I squash the commits before merging.",
  "I'm waiting for your answer on the two points above.",
  "Please confirm the target branch.",
  "Please choose one of the approaches below.",
  "Do you want me to rename the module as well.",
  "Would you prefer a flag or a config file.",
  "Shall I push the fix",
  "Before I continue, I need your decision on the schema.",
  "Is it ok to drop the old table.",
  "Ok to proceed with the migration.",
  "Two questions remain:\n- the default timeout?\n- the retry count?",
  "Proceed?",
];

/** 質問ではない（作業の依頼・報告・コード中の ?）: 質問 false */
const NOT_QUESTIONS = [
  "確認してください。",
  "確認してください",
  "完了しました。",
  "Done.",
  "",
  "PR を作成しました。ご確認ください。",
  "テストが通るか確認してください。",
  "turnlane reingest を実行してください。",
  "どちらの方式でも動きます。",
  "これで直るでしょう。",
  "なぜ落ちていたのか調べた結果、原因はタイムゾーンでした。",
  "原因は `a ?? b` の評価順でした。",
  "API は https://example.com/api?limit=10 で確かめました。",
  "```ts\nconst x = y ? 1 : 2;\n```\n\nビルドは通っています。",
  "どうしますか？\n\n→ A にしました。テストも通っています。",
  "I fixed the bug and pushed the branch.",
  "Run `bun test` to verify.",
  "The query uses ?limit=10 now.",
  "Please run the migration on your machine.",
  "I wonder if the timeout was too short; increasing it fixed the flake.",
];

describe("締めの決まり文句（closing-question.ts）", () => {
  test.each(CLOSING_JA)("日本語: %s → true", (s) => expect(isClosingQuestion(s)).toBe(true));
  test.each(CLOSING_EN)("英語: %s → true", (s) => expect(isClosingQuestion(s)).toBe(true));
  test.each([...CLOSING_JA, ...CLOSING_EN])("返答タスクを作らない: %s", (s) => {
    const t = textTraits(s);
    expect(t.question && !t.closing).toBe(false);
  });
  test.each(REAL_QUESTIONS)("本当の質問: %s → false", (s) => {
    expect(isClosingQuestion(s)).toBe(false);
    expect(endsWithQuestion(s)).toBe(true);
  });
  test("質問の文がすべて締めのときだけ締め", () => {
    expect(isClosingQuestion("他に何かありますか？ それとも A にしますか？")).toBe(false);
    expect(isClosingQuestion("A にしました。Anything else?")).toBe(true);
    expect(textTraits("どちらにしますか？ 他に何かあれば教えてください。")).toEqual({
      question: true,
      closing: false,
    });
  });
});

describe("答え・判断を求める言い回し（D-066 (1)）", () => {
  test.each(ASK_JA)("日本語: %j → 質問", (s) =>
    expect(textTraits(s)).toEqual({ question: true, closing: false }),
  );
  test.each(ASK_EN)("英語: %j → 質問", (s) =>
    expect(textTraits(s)).toEqual({ question: true, closing: false }),
  );
  test.each(NOT_QUESTIONS)("質問ではない: %j", (s) => expect(endsWithQuestion(s)).toBe(false));
  test("最後の段落だけを見る", () => {
    expect(endsWithQuestion("どちらにしますか？\n\n念のためテストも追加しました。")).toBe(false);
    expect(endsWithQuestion("テストを追加しました。\n\nどちらにしますか")).toBe(true);
  });
});

describe("質問で終わるか", () => {
  test("文字列以外は false", () => {
    expect(endsWithQuestion(undefined)).toBe(false);
    expect(endsWithQuestion(1)).toBe(false);
    expect(textTraits(null)).toEqual({ question: false, closing: false });
  });
  test("textTraits: 締めの決まり文句は締め", () => {
    expect(textTraits("Let me know if you'd like any changes.")).toEqual({
      question: true,
      closing: true,
    });
    expect(textTraits("Anything else?")).toEqual({ question: true, closing: true });
    expect(textTraits("Should I proceed?")).toEqual({ question: true, closing: false });
    expect(textTraits("完了しました。")).toEqual({ question: false, closing: false });
  });
});

/** 判断待ちの条件文の一般化と、データを求める依頼（文はすべて合成） */
describe("条件文の一般化・データを求める依頼", () => {
  const ASKING = [
    "結果をまとめました。\n\n動画名と見た割合を『名前：○○%』の形でメモして貼ってもらえれば、回を重ねるほど下がっているかを判断します。スマホのアプリでも同じ数字が見られます。",
    "名前：○○% の形でメモして貼ってください。",
    "ログを送っていただけたら、原因を調査します。",
    "ログを貼ってもらえれば切り分けます。",
    "数字を送ってもらえれば比べます。",
    "決まったらお見せします。",
    "If you paste the numbers here, I'll compare them with the new layout.",
    "Please send me the export when you have it.",
    "Paste the error output here and I'll take a look.",
  ];
  const NOT_ASKING = [
    "確認してもらえれば助かります。",
    "見ていただければ幸いです。",
    "試してもらえたら嬉しいです。",
    "確認してください。",
    "試してください。",
    "試してみてください。",
    "見てもらえれば分かります。",
    "Please review the diff when you have a moment.",
    "Please check the logs.",
    "If that helps, great.",
    "I'll paste the summary below.",
  ];
  test.each(ASKING)("問い: %j", (s) =>
    expect(textTraits(s)).toEqual({ question: true, closing: false }),
  );
  test.each(NOT_ASKING)("問いではない: %j", (s) => expect(endsWithQuestion(s)).toBe(false));
  test("締めの決まり文句は締めのまま", () => {
    expect(isClosingQuestion("他に何かあれば教えてください。")).toBe(true);
    expect(isClosingQuestion("I can also add tests if you need anything else.")).toBe(true);
  });
});
