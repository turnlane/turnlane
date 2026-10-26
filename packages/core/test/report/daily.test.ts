/** 日報のテンプレート（M4-3）の golden テスト（英日）と、持ち越し先・利用計測の表駆動テスト */
import { describe, expect, test } from "bun:test";
import type { DailyReport } from "../../src/api/index.ts";
import { reportAiResultText, reportAiText } from "../../src/report/daily.ts";
import {
  isWeekday,
  nextWeekday,
  renderDailyReport,
  renderDailyReportBody,
  usageStats,
} from "../../src/report/index.ts";

const MIN = 60_000;
const H = 60 * MIN;

const sample: DailyReport = {
  date: "2026-10-02",
  youMs: 5 * H + 10 * MIN,
  meetingsMs: 90 * MIN,
  aiMs: 4 * H + 5 * MIN,
  runs: 7,
  maxParallel: 3,
  idleMs: 42 * MIN,
  expired: 1,
  idleByRepo: [
    { repo: "api-gateway", ms: 22 * MIN },
    { repo: "turnlane", ms: 13 * MIN },
    { repo: null, ms: 7 * MIN },
  ],
  expiredItems: [{ t: "text", text: "Rename env var question" }],
  did: [
    { taskId: "a", title: { t: "text", text: "Morning email" }, ms: 25 * MIN, fromAi: null },
    {
      taskId: "b",
      title: {
        t: "auto",
        key: "followup.review_pr",
        params: {
          title: "Dependency update",
          repo: "infra",
          branch: "deps",
          pr: 138,
          prTitle: null,
        },
      },
      ms: 8 * MIN,
      fromAi: "Dependency update",
    },
    { taskId: "c", title: { t: "text", text: "Write article outline" }, ms: null, fromAi: null },
  ],
  aiDid: [
    {
      workItemId: "w1",
      repo: "turnlane",
      title: "Date lane DnD",
      branch: "feat/dnd",
      status: "your_turn",
      result: { kind: "pr", pr: 142, state: "open" },
      aiMs: 38 * MIN,
      carried: false,
    },
    {
      workItemId: "w2",
      repo: "infra",
      title: "Dependency update",
      branch: "deps",
      status: "done",
      result: { kind: "pr", pr: 138, state: "merged" },
      aiMs: 24 * MIN,
      carried: false,
    },
    {
      workItemId: "w3",
      repo: "api-gateway",
      title: "Auth token refresh",
      branch: "fix/auth",
      status: "needs_input",
      result: { kind: "status", status: "needs_input" },
      aiMs: 15 * MIN,
      carried: true,
    },
    {
      workItemId: "w5",
      repo: "billing",
      title: "Invoice schema",
      branch: "feat/invoice-schema",
      status: "needs_input",
      result: { kind: "status", status: "needs_input", waitingFor: "answer" },
      aiMs: 4 * MIN,
      carried: true,
    },
    {
      workItemId: "w4",
      repo: null,
      title: null,
      branch: null,
      status: "done",
      result: { kind: "status", status: "done" },
      aiMs: 45 * MIN,
      carried: false,
    },
  ],
  carried: [{ taskId: "d", title: { t: "text", text: "Invoice template fix" }, to: "2026-10-05" }],
  note: "Good day.",
};

describe("日報のテンプレート", () => {
  test("英語", () => {
    expect(renderDailyReport(sample, "en")).toBe(`## Fri 2026-10-02

Time: You 5h10m (meetings 1h30m) · AI 4h5m (7 runs, up to 3 in parallel)
Idle 42m · Expired 1
api-gateway 22m · turnlane 13m · (no repo) 7m
Expired: Rename env var question

### What I did
- Morning email (25m)
- Review PR #138: Dependency update (8m) ← AI: Dependency update
- Write article outline

### What the AI did
- [turnlane] Date lane DnD — PR #142 open, your turn (AI 38m)
- [infra] Dependency update — PR #138 merged (AI 24m)
- [api-gateway] Auth token refresh — waiting for approval, carried over (AI 15m)
- [billing] Invoice schema — waiting for your answer, carried over (AI 4m)
- [(no repo)] AI work — done (AI 45m)

### Carried over
- Invoice template fix → Mon 10/5

### Note
Good day.
`);
  });

  test("日本語", () => {
    expect(renderDailyReport(sample, "ja")).toBe(`## 2026-10-02（金）

時間: 自分 5h10m（会議 1h30m） · AI 4h5m（7回の実行、最大3並列）
放置 42m · 期限切れ 1
api-gateway 22m · turnlane 13m · （リポジトリなし） 7m
期限切れ: Rename env var question

### やったこと
- Morning email (25m)
- PR #138 をレビュー: Dependency update (8m) ← AI: Dependency update
- Write article outline

### AI がやったこと
- [turnlane] Date lane DnD — PR #142 未マージ、自分の番 (AI 38m)
- [infra] Dependency update — PR #138 マージ済み (AI 24m)
- [api-gateway] Auth token refresh — 許可待ち、持ち越し (AI 15m)
- [billing] Invoice schema — 回答待ち、持ち越し (AI 4m)
- [（リポジトリなし）] AI の作業 — 完了 (AI 45m)

### 持ち越し
- Invoice template fix → 10/5（月）

### メモ
Good day.
`);
  });

  test("空の日: Idle は 0 でも出し、Expired・空の節・会議・実行数は出さない", () => {
    const empty: DailyReport = {
      ...sample,
      youMs: 0,
      meetingsMs: 0,
      aiMs: 0,
      runs: 0,
      maxParallel: 0,
      idleMs: 0,
      expired: 0,
      idleByRepo: [],
      expiredItems: [],
      did: [],
      aiDid: [],
      carried: [],
      note: null,
    };
    expect(renderDailyReport(empty, "en")).toBe(
      "## Fri 2026-10-02\n\nTime: You 0m · AI 0m\nIdle 0m\n",
    );
  });

  test("1回だけの実行は並列を書かない", () => {
    expect(renderDailyReportBody({ ...sample, runs: 1, maxParallel: 1 }, "en")).toContain(
      "AI 4h5m (1 run)",
    );
  });

  test("編集した本文と Note を組み合わせる", () => {
    expect(renderDailyReport(sample, "en", { body: "## Edited\n\n", note: " Tired " })).toBe(
      "## Edited\n\n### Note\nTired\n",
    );
    expect(renderDailyReport(sample, "en", { body: "## Edited", note: null })).toBe("## Edited\n");
  });
});

describe("壁打ち（D-135）", () => {
  test("リポジトリの欄と放置の内訳は「Scratch」「壁打ち」（git 管理外の (no repo) と分ける）", () => {
    const r: DailyReport = {
      ...sample,
      idleByRepo: [
        { repo: null, scratch: true, ms: 9 * MIN },
        { repo: null, ms: 7 * MIN },
      ],
      aiDid: [
        {
          workItemId: "s",
          repo: null,
          scratch: true,
          title: "Offsite plan",
          branch: null,
          status: "your_turn",
          result: { kind: "status", status: "your_turn" },
          aiMs: 12 * MIN,
          carried: false,
        },
      ],
    };
    const en = renderDailyReport(r, "en");
    expect(en).toContain("Scratch 9m · (no repo) 7m");
    expect(en).toContain("- [Scratch] Offsite plan — your turn (AI 12m)");
    const ja = renderDailyReport(r, "ja");
    expect(ja).toContain("壁打ち 9m · （リポジトリなし） 7m");
    expect(ja).toContain("- [壁打ち] Offsite plan — 自分の番 (AI 12m)");
  });
  test("AI がやったことの状態は自分の番と同じ判定（D-214 (3)）: 猶予中・自分の番に出ないものは完了", () => {
    const line = (turn: "open" | "grace" | "none") =>
      reportAiResultText(
        {
          workItemId: "w",
          repo: "billing",
          title: "TZ test",
          branch: null,
          status: "your_turn",
          turn,
          result: { kind: "status", status: "your_turn" },
          aiMs: MIN,
          carried: false,
        },
        "ja",
      );
    expect(line("open")).toBe("自分の番");
    expect(line("grace")).toBe("止まった · 猶予中");
    expect(line("none")).toBe("完了");
  });
  test("保存した中身（ADR 0018・D-218）: 名前はその日の最初の指示、後ろに止まっている待ち。AI の発言は入れない", () => {
    const base = {
      workItemId: "w",
      repo: "billing",
      title: "Tax rounding",
      branch: null,
      status: "needs_input" as const,
      result: {
        kind: "status" as const,
        status: "needs_input" as const,
        waitingFor: "approval" as const,
      },
      aiMs: 3 * MIN,
      carried: false,
    };
    const ja = reportAiText(
      {
        ...base,
        asked: "税率の計算を直して",
        stopped: { kind: "permission", tool: "Bash", command: "bun test" },
      },
      "ja",
    );
    expect(ja).toBe("[billing] 税率の計算を直して — 許可待ち · Bash `bun test` (AI 3m)");
    expect(
      reportAiText({ ...base, stopped: { kind: "question", text: "どちらにしますか？" } }, "en"),
    ).toBe("[billing] Tax rounding — waiting for approval · “どちらにしますか？” (AI 3m)");
  });
});

describe("持ち越し先（D-040 の既定: 土日を除く平日。M3-6 まで）", () => {
  test.each([
    ["2026-10-01", "2026-10-02"], // 木 → 金
    ["2026-10-02", "2026-10-05"], // 金 → 月
    ["2026-10-03", "2026-10-05"], // 土 → 月
    ["2026-10-04", "2026-10-05"], // 日 → 月
    ["2026-12-31", "2027-01-01"], // 年をまたぐ（金）
  ])("%s → %s", (from, to) => {
    expect(nextWeekday(from)).toBe(to);
  });
  test("稼働日の判定を差し替えられる（祝日の月曜を飛ばす）", () => {
    expect(nextWeekday("2026-10-09", (d) => isWeekday(d) && d !== "2026-10-12")).toBe("2026-10-13");
  });
});

describe("利用計測（M5-1、D-006。D-192 で利用日はアプリを開いた日）", () => {
  const base = {
    today: "2026-10-04",
    days: 7,
    opened: new Set(["2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"]),
    followUps: [],
  };

  test("UI を開いた日を数える。連続日数は今日が未達なら昨日で終わる", () => {
    const s = usageStats(base);
    expect(s.days.map((d) => [d.date, d.counted])).toEqual([
      ["2026-09-28", false],
      ["2026-09-29", true],
      ["2026-09-30", true],
      ["2026-10-01", true],
      ["2026-10-02", true],
      ["2026-10-03", false], // 開いていない
      ["2026-10-04", false], // 今日はまだ
    ]);
    expect(s.countedDays).toBe(4);
    expect(s.streak).toBe(0); // 昨日（10/3）が数えられていない
    const s2 = usageStats({ ...base, opened: new Set([...base.opened, "2026-10-03"]) });
    expect(s2.streak).toBe(5);
    const s3 = usageStats({
      ...base,
      opened: new Set([...base.opened, "2026-10-03", "2026-10-04"]),
    });
    expect(s3.streak).toBe(6); // 今日も開いたら数える
  });

  test("自分の番の処理数（期限切れ・置き換えは数えない）と平均応答", () => {
    const f = (
      date: string,
      status: "done" | "dismissed" | "expired" | "superseded",
      closeReason: string | null,
      wait: number,
      engaged: number | null = null,
    ) => ({
      date,
      status,
      closeReason,
      triggerAt: 0,
      engagedAt: engaged,
      closedAt: wait,
      // 待ちの間ずっと勤務時間内（猶予と放置だけ）
      waitSegments: [{ kind: "idle" as const, start: 0, end: wait }],
    });
    const s = usageStats({
      ...base,
      followUps: [
        f("2026-10-01", "done", "auto:human_input", 10 * MIN),
        f("2026-10-01", "done", "auto:resolved:commit", 60 * MIN),
        f("2026-10-02", "done", "auto:pr_merged", 90 * MIN, 20 * MIN),
        f("2026-10-02", "dismissed", "manual", 5 * MIN),
        f("2026-10-03", "expired", "auto:expired", 72 * H),
        f("2026-10-03", "superseded", null, MIN),
        f("2026-09-01", "done", "auto:human_input", MIN), // 範囲外
      ],
    });
    expect(s.followUps).toEqual({
      processed: 4,
      perWeek: 4,
      replied: 1,
      resolved: 2,
      notNeeded: 1,
      expired: 1,
    });
    expect(s.days.find((d) => d.date === "2026-10-01")?.processed).toBe(2);
    // 返答（10m）と ⏎ した解決（20m）の平均。自動の解決と対応不要は入れない
    expect(s.avgResponseMs).toBe(15 * MIN);
  });

  test("平均応答は壁時計ではなく猶予と放置の区間で数え、待ち区間の分からないものは入れない（D-057）", () => {
    const fact = (
      closedAt: number,
      waitSegments: { kind: "grace" | "idle" | "excluded"; start: number; end: number }[],
    ) => ({
      date: "2026-10-03",
      status: "done" as const,
      closeReason: "auto:human_input",
      triggerAt: 0,
      engagedAt: null,
      closedAt,
      waitSegments,
    });
    const s = usageStats({
      ...base,
      followUps: [
        // 夜をまたいだ返答: 壁時計 15h、数えるのは猶予 15分と翌朝の放置 25分
        fact(15 * H, [
          { kind: "grace", start: 0, end: 15 * MIN },
          { kind: "excluded", start: 15 * MIN, end: 14 * H + 35 * MIN },
          { kind: "idle", start: 14 * H + 35 * MIN, end: 15 * H },
        ]),
        fact(20 * MIN, [
          { kind: "grace", start: 0, end: 15 * MIN },
          { kind: "idle", start: 15 * MIN, end: 20 * MIN },
        ]),
        fact(30 * MIN, []), // 待ち区間が無い → 入れない
      ],
    });
    expect(s.avgResponseMs).toBe(30 * MIN);
  });
});
