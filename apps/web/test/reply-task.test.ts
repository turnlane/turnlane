import { describe, expect, test } from "bun:test";
import { replyTaskOutcome } from "../src/data/mutations.ts";

describe("AI カードの y の結果の出し方（D-066 (2)）", () => {
  test("作ったら追加の知らせだけ。パネルは開かない", () => {
    expect(replyTaskOutcome({ created: true, taskId: "t1", followUp: { kind: "reply" } })).toEqual({
      message: "toast.replyTask.created",
      openTaskId: null,
    });
  });
  test("返答タスクがもうあれば、それを開く", () => {
    expect(replyTaskOutcome({ created: false, taskId: "t1", followUp: { kind: "reply" } })).toEqual(
      { message: "toast.replyTask.exists", openTaskId: "t1" },
    );
  });
  test("別の種類のタスク（PR の確認）や頼んだタスクになっていれば「もうタスクになっています」と出して開く", () => {
    expect(
      replyTaskOutcome({ created: false, taskId: "t2", followUp: { kind: "review_pr" } }),
    ).toEqual({ message: "toast.replyTask.linked", openTaskId: "t2" });
    expect(replyTaskOutcome({ created: false, taskId: "t3", followUp: null })).toEqual({
      message: "toast.replyTask.linked",
      openTaskId: "t3",
    });
  });
});
