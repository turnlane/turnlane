import { describe, expect, test } from "bun:test";
import type { GlanceResponse } from "../../src/api/glance.ts";
import type { QueueFollowUp, QueueItem } from "../../src/api/queue.ts";
import { reasonParts, turnSubject, withSubject } from "../../src/glance/reason.ts";
import { MASK } from "../../src/glance/redact.ts";
import { formatTaskSubject } from "../../src/i18n/task-title.ts";

const params = (o: Partial<{ title: string; pr: number; prTitle: string }> = {}) => ({
  title: o.title ?? "Fix auth refresh flow",
  repo: "api-gateway",
  branch: "fix/auth-refresh",
  pr: o.pr ?? null,
  prTitle: o.prTitle ?? null,
});

function item(kind: QueueFollowUp["kind"], o: Partial<QueueItem> & { ask?: boolean } = {}) {
  const key = `followup.${kind}` as const;
  return {
    workItemId: "w1",
    title: "Fix auth refresh flow",
    userTitled: false,
    status: kind === "approve" ? "needs_input" : "your_turn",
    reason: null,
    estimated: false,
    repoRoot: "/w/api-gateway",
    branch: "fix/auth-refresh",
    prRef: null,
    sources: [],
    waitingSince: 0,
    waitStartedAway: false,
    followUps: [
      {
        id: "f1",
        kind,
        status: "open",
        ...(o.ask ? { ask: true } : {}),
        title: { t: "auto", key, params: params({ pr: 142, prTitle: "Fix day view widths" }) },
        triggerAt: 0,
        snoozeUntil: null,
        engagedAt: null,
        expiresAt: null,
        taskId: null,
        taskDate: null,
        task: null,
      },
    ],
    ...o,
  } as QueueItem;
}

const g = (o: Partial<GlanceResponse>): GlanceResponse => ({
  workItemId: "w1",
  kind: "none",
  readAt: 0,
  ...o,
});

describe("件名（spec-glance §2.2、D-207 (3)(5)、D-214 (1)）", () => {
  test("前置きを外す。PR の待ちでも PR の題名は件名にしない（理由の行へ）", () => {
    expect(formatTaskSubject("followup.approve", params(), "ja")).toBe("Fix auth refresh flow");
    expect(
      formatTaskSubject("followup.review_pr", params({ pr: 1, prTitle: "Fix widths" }), "en"),
    ).toBe("Fix auth refresh flow");
  });
  test("直近の指示があれば件名にし、自動の題名はセッションとして出す", () => {
    const s = turnSubject(
      item("approve"),
      g({ prompt: { text: "リフレッシュトークンの期限切れで 401 になるのを直して" } }),
      "ja",
    );
    expect(s).toEqual({
      subject: "リフレッシュトークンの期限切れで 401 になるのを直して",
      session: "Fix auth refresh flow",
    });
  });
  test("自分で付けた名前は指示より先。PR の待ちもその日に固定した指示を件名にする", () => {
    const named = item("approve", { userTitled: true });
    expect(turnSubject(named, g({ prompt: { text: "x" } }), "en")).toEqual({
      subject: "Fix auth refresh flow",
      session: null,
    });
    expect(
      turnSubject(item("review_pr"), g({ prompt: { text: "3日ボードの列幅を直して" } }), "ja")
        .subject,
    ).toBe("3日ボードの列幅を直して");
  });
  test("読めなければ自動の題名（ai-title）", () => {
    expect(turnSubject(item("reply"), null, "en")).toEqual({
      subject: "Fix auth refresh flow",
      session: null,
    });
  });
  test("件名が PR の題名（指示も ai-title も無い）: fromPr。理由の行は番号だけで題名を繰り返さない（fix-subject-pr）", () => {
    const pr = item("review_pr", { title: "Fix day view widths", titleSource: "pr" });
    (pr.followUps[0] as QueueFollowUp).title = {
      t: "auto",
      key: "followup.review_pr",
      params: params({ title: "Fix day view widths", pr: 142, prTitle: "Fix day view widths" }),
    };
    const s = turnSubject(pr, null, "ja");
    expect(s).toEqual({ subject: "Fix day view widths", session: null, fromPr: true });
    const p = withSubject(reasonParts(pr, null), s);
    expect(p.pr).toBe(142);
    expect(p.prTitle).toBeUndefined();
    expect(p.prFirst).toBe(true);
    // 指示が読めたら件名は指示。理由の行は今まで通り PR #142 題名
    const s2 = turnSubject(pr, g({ prompt: { text: "3日ボードの列幅を直して" } }), "ja");
    expect(s2.fromPr).toBeUndefined();
    const p2 = withSubject(reasonParts(pr, null), s2);
    expect(p2.prTitle).toBe("Fix day view widths");
    expect(p2.prFirst).toBeUndefined();
    // 自分で付けた名前のときは PR 由来でない
    expect(turnSubject({ ...pr, userTitled: true }, null, "ja").fromPr).toBeUndefined();
  });
  test("件名にも伏せ字を通す", () => {
    expect(
      turnSubject(item("reply"), g({ prompt: { text: "use TOKEN=abc123" } }), "en").subject,
    ).toBe(`use TOKEN=${MASK}`);
  });
});

describe("理由の部品（spec-glance §2.3・§4）", () => {
  test("許可待ち: 説明・コマンド。伏せ字をもう一度通す", () => {
    const p = reasonParts(
      item("approve"),
      g({
        kind: "permission",
        permission: {
          tool: "Bash",
          label: "Push the fix",
          detail: "TOKEN=abc123 git push origin main",
          detailKind: "command",
          masked: false,
        },
      }),
    );
    expect(p).toMatchObject({
      why: "approve",
      tool: "Bash",
      label: "Push the fix",
      detail: `TOKEN=${MASK} git push origin main`,
      masked: true,
      hasContent: true,
    });
  });
  test("返答待ち: 問いの文。回答待ち: 問いと選択肢", () => {
    expect(
      reasonParts(
        item("reply"),
        g({
          kind: "question",
          question: { row: "右の列も同じ幅にしますか?", detail: "d", masked: false },
        }),
      ),
    ).toMatchObject({ why: "reply", quote: "右の列も同じ幅にしますか?", hasContent: true });
    const a = reasonParts(
      item("reply", { ask: true }),
      g({
        kind: "ask",
        ask: {
          question: "デプロイ先は?",
          options: ["staging", "production", "両方"],
          more: 2,
          questions: [
            { question: "デプロイ先は?", options: [] },
            { question: "いつ?", options: [] },
          ],
        },
      }),
    );
    expect(a).toMatchObject({
      why: "answer",
      quote: "デプロイ先は?",
      options: ["staging", "production", "両方"],
      moreOptions: 2,
      moreQuestions: 1,
    });
  });
  test("中身が無ければ種類だけ。PR の待ちは番号と題名（D-214 (1)）", () => {
    expect(reasonParts(item("approve"), g({ unavailable: "missing" }))).toMatchObject({
      why: "approve",
      hasContent: false,
      unavailable: "missing",
    });
    expect(reasonParts(item("review_pr"), null)).toMatchObject({
      why: "review_pr",
      pr: 142,
      prTitle: "Fix day view widths",
    });
    expect(reasonParts(item("resume_error"), g({ error: "overloaded" }))).toMatchObject({
      why: "resume_error",
      error: "overloaded",
    });
  });
});

describe("猶予中の問いの行（D-245）: 返答タスクは無いが、普通の行と同じ理由の作り", () => {
  const graceItem = (kind: "question" | "ask") =>
    ({
      ...item("reply"),
      followUps: [],
      wait: { kind, turnId: "t1", followUpId: null },
      grace: { until: 15 * 60_000 },
    }) as QueueItem;
  test("問い: 返答待ちの言葉と問いの 1 行", () => {
    const g = {
      workItemId: "w1",
      kind: "question",
      readAt: 0,
      question: { row: "どうしますか？", detail: "どうしますか？", masked: false },
    } as GlanceResponse;
    const p = reasonParts(graceItem("question"), g);
    expect(p.why).toBe("reply");
    expect(p.quote).toBe("どうしますか？");
    expect(p.hasContent).toBe(true);
  });
  test("AskUserQuestion は回答待ち。猶予中でなく返答タスクも無ければ言葉は無い", () => {
    expect(reasonParts(graceItem("ask"), null).why).toBe("answer");
    const { grace: _g, ...plain } = graceItem("question");
    expect(reasonParts(plain as QueueItem, null).why).toBeNull();
  });
});
