import { describe, expect, test } from "bun:test";
import { type ParsedTask, parseDateInput, parseTask } from "../../src/nlp/index.ts";

// 2026-10-02 は金曜日
const ctx = { today: "2026-10-02" };

type Expect = Partial<Omit<ParsedTask, "chips" | "tentative">>;

describe("parseTask: 日本語", () => {
  test.each<[string, Expect]>([
    ["資料 今日", { title: "資料", date: "2026-10-02" }],
    ["資料 本日", { title: "資料", date: "2026-10-02" }],
    ["資料 明日", { title: "資料", date: "2026-10-03" }],
    ["資料 あした", { title: "資料", date: "2026-10-03" }],
    ["資料 あさって", { title: "資料", date: "2026-10-04" }],
    ["資料 明後日", { title: "資料", date: "2026-10-04" }],
    ["資料 月曜", { title: "資料", date: "2026-10-05" }],
    ["資料 月曜日", { title: "資料", date: "2026-10-05" }],
    ["資料 金曜", { title: "資料", date: "2026-10-09" }],
    ["資料 日曜", { title: "資料", date: "2026-10-04" }],
    ["資料 来週水曜", { title: "資料", date: "2026-10-07" }],
    ["資料 来週の月曜", { title: "資料", date: "2026-10-05" }],
    ["資料 再来週月曜", { title: "資料", date: "2026-10-12" }],
    ["資料 10/5", { title: "資料", date: "2026-10-05" }],
    ["資料 10月5日", { title: "資料", date: "2026-10-05" }],
    ["資料 1/5", { title: "資料", date: "2027-01-05" }],
    ["資料 9/25", { title: "資料", date: "2026-09-25" }],
    ["資料 9/24", { title: "資料", date: "2027-09-24" }],
    ["資料 2/30", { title: "資料 2/30", date: null }],
    ["資料 2026-10-05", { title: "資料", date: "2026-10-05" }],
    ["会議 14時", { title: "会議", time: { hour: 14, minute: 0 } }],
    ["会議 14:00", { title: "会議", time: { hour: 14, minute: 0 } }],
    ["会議 9:30", { title: "会議", time: { hour: 9, minute: 30 } }],
    ["会議 14時半", { title: "会議", time: { hour: 14, minute: 30 } }],
    ["会議 14時15分", { title: "会議", time: { hour: 14, minute: 15 }, estimateMin: null }],
    ["会議 午後2時", { title: "会議", time: { hour: 14, minute: 0 } }],
    ["会議 午前10時", { title: "会議", time: { hour: 10, minute: 0 } }],
    ["会議 午前12時", { title: "会議", time: { hour: 0, minute: 0 } }],
    ["会議 25時", { title: "会議 25時", time: null }],
    ["会議 午後13時", { title: "会議 午後13時", time: null }],
    ["読む 30分", { title: "読む", estimateMin: 30, time: null }],
    ["読む 90分", { title: "読む", estimateMin: 90 }],
    ["読む 1時間", { title: "読む", estimateMin: 60, time: null }],
    ["読む 1時間半", { title: "読む", estimateMin: 90, time: null }],
    ["読む 2時間15分", { title: "読む", estimateMin: 135 }],
    ["読む 1.5時間", { title: "読む", estimateMin: 90 }],
    ["読む 0分", { title: "読む 0分", estimateMin: null }],
    ["構成を書く 明日 30分 #blog", { title: "構成を書く", date: "2026-10-03", estimateMin: 30 }],
    ["構成を書く #ブログ", { title: "構成を書く", project: "ブログ" }],
    ["C# の勉強", { title: "C# の勉強", project: null }],
    ["請求書 !1", { title: "請求書", priority: 1 }],
    ["請求書 !3", { title: "請求書", priority: 3 }],
    ["請求書 !4", { title: "請求書 !4", priority: null }],
    ["すごい!1", { title: "すごい!1", priority: null }],
    ["旅行の計画 いつか", { title: "旅行の計画", someday: true }],
    ["メモ インボックス", { title: "メモ", inbox: true }],
    ["いつか 明日", { title: "いつか 明日", someday: true, date: "2026-10-03" }],
    [
      "明日 14時 1時間 #work !2 企画書",
      {
        title: "企画書",
        date: "2026-10-03",
        time: { hour: 14, minute: 0 },
        estimateMin: 60,
        project: "work",
        priority: 2,
      },
    ],
    ["明日 あさって 掃除", { title: "あさって 掃除", date: "2026-10-03" }],
    ["明日、資料を送る", { title: "資料を送る", date: "2026-10-03" }],
    ["毎月の振り返り", { title: "毎月の振り返り", date: null }],
  ])("%s", (raw, want) => {
    expect(parseTask(raw, ctx)).toMatchObject(want);
  });
});

describe("parseTask: English", () => {
  test.each<[string, Expect]>([
    ["Write today", { title: "Write", date: "2026-10-02" }],
    ["Write tomorrow", { title: "Write", date: "2026-10-03" }],
    ["Write Tomorrow", { title: "Write", date: "2026-10-03" }],
    ["Write tmr", { title: "Write", date: "2026-10-03" }],
    ["Write day after tomorrow", { title: "Write", date: "2026-10-04" }],
    ["Write mon", { title: "Write", date: "2026-10-05" }],
    ["Write Monday", { title: "Write", date: "2026-10-05" }],
    ["Write fri", { title: "Write", date: "2026-10-09" }],
    ["Write thurs", { title: "Write", date: "2026-10-08" }],
    ["Write sunday", { title: "Write", date: "2026-10-04" }],
    ["Write next wed", { title: "Write", date: "2026-10-07" }],
    ["Write next Monday", { title: "Write", date: "2026-10-05" }],
    ["Write 10/5", { title: "Write", date: "2026-10-05" }],
    ["Write 1/5", { title: "Write", date: "2027-01-05" }],
    ["Write 2026/12/31", { title: "Write", date: "2026-12-31" }],
    ["Call 2pm", { title: "Call", time: { hour: 14, minute: 0 } }],
    ["Call 2:30pm", { title: "Call", time: { hour: 14, minute: 30 } }],
    ["Call 10am", { title: "Call", time: { hour: 10, minute: 0 } }],
    ["Call 12am", { title: "Call", time: { hour: 0, minute: 0 } }],
    ["Call 12pm", { title: "Call", time: { hour: 12, minute: 0 } }],
    ["Call 2 PM", { title: "Call", time: { hour: 14, minute: 0 } }],
    ["Call 14:00", { title: "Call", time: { hour: 14, minute: 0 } }],
    ["Call 24:00", { title: "Call 24:00", time: null }],
    ["Call 13pm", { title: "Call 13pm", time: null }],
    ["Buy 3 apples", { title: "Buy 3 apples", time: null, estimateMin: null }],
    ["Read 45m", { title: "Read", estimateMin: 45 }],
    ["Read 45min", { title: "Read", estimateMin: 45 }],
    ["Read 1h", { title: "Read", estimateMin: 60 }],
    ["Read 1.5h", { title: "Read", estimateMin: 90 }],
    ["Read 1h30m", { title: "Read", estimateMin: 90 }],
    ["Read 2hrs", { title: "Read", estimateMin: 120 }],
    ["Read 30mb file", { title: "Read 30mb file", estimateMin: null }],
    [
      "Write outline tomorrow 30m #blog",
      {
        title: "Write outline",
        date: "2026-10-03",
        estimateMin: 30,
        project: "blog",
      },
    ],
    ["Fix #api-v2_x bug", { title: "Fix bug", project: "api-v2_x" }],
    ["Learn C#", { title: "Learn C#", project: null }],
    ["Pay rent !2", { title: "Pay rent", priority: 2 }],
    ["Learn piano someday", { title: "Learn piano", someday: true }],
    ["Note inbox", { title: "Note", inbox: true }],
    ["Monthly review", { title: "Monthly review", date: null }],
    ["Plan wedding", { title: "Plan wedding", date: null }],
    ["Todays notes", { title: "Todays notes", date: null }],
    ["tomorrow", { title: "tomorrow", date: "2026-10-03" }],
    ["#blog !1", { title: "#blog !1", project: "blog", priority: 1 }],
    ["", { title: "", date: null }],
    ["   ", { title: "", date: null }],
  ])("%s", (raw, want) => {
    expect(parseTask(raw, ctx)).toMatchObject(want);
  });
});

describe("parseTask: 候補（確定しない）", () => {
  test.each<[string, string, Record<string, unknown>]>([
    ["3時間目の授業", "3時間", { estimateMin: 180 }],
    ["明日までに提出", "明日", { date: "2026-10-03" }],
    ["月曜の定例", "月曜", { date: "2026-10-05" }],
    ["14時に電話", "14時", { time: { hour: 14, minute: 0 } }],
    ["Meet at 3", "at 3", { time: { hour: 3, minute: 0 } }],
    ["Walk in the sun", "sun", { date: "2026-10-04" }],
  ])("%s", (raw, text, value) => {
    const p = parseTask(raw, ctx);
    expect(p.title).toBe(raw);
    expect(p.chips).toEqual([]);
    expect(p.tentative).toHaveLength(1);
    expect(p.tentative[0]).toMatchObject({ text, value });
  });

  test("at 3pm は確定", () => {
    const p = parseTask("Meet at 3pm", ctx);
    expect(p.time).toEqual({ hour: 15, minute: 0 });
    expect(p.tentative).toEqual([]);
    expect(p.title).toBe("Meet at");
  });
});

describe("parseTask: チップ", () => {
  test("位置と文字列", () => {
    const raw = "Write outline tomorrow 30m #blog";
    const p = parseTask(raw, ctx);
    expect(p.chips.map((c) => c.kind)).toEqual(["date", "estimate", "project"]);
    for (const c of p.chips) expect(raw.slice(c.start, c.end)).toBe(c.text);
    expect(p.chips[2]).toMatchObject({ text: "#blog", start: 27, end: 32 });
  });

  test("例外を投げない", () => {
    const inputs = ["!!!", "#", "##", "/", "1/", "時", "99999時間", "\u0000", "🙂 明日"];
    for (const raw of inputs) expect(() => parseTask(raw, ctx)).not.toThrow();
    expect(() => parseTask("明日", { today: "invalid" })).not.toThrow();
    expect(parseTask("明日", { today: "invalid" }).date).toBeNull();
  });
});

describe("parseDateInput", () => {
  test.each<[string, string | null | undefined]>([
    ["today", "2026-10-02"],
    ["t", "2026-10-02"],
    ["T", "2026-10-02"],
    ["+2", "2026-10-04"],
    ["+0", "2026-10-02"],
    ["next week", "2026-10-05"],
    ["来週", "2026-10-05"],
    ["tomorrow", "2026-10-03"],
    ["明日", "2026-10-03"],
    ["あさって", "2026-10-04"],
    ["mon", "2026-10-05"],
    ["来週水曜", "2026-10-07"],
    ["10/5", "2026-10-05"],
    ["1/5", "2027-01-05"],
    ["2026-11-01", "2026-11-01"],
    ["inbox", null],
    ["インボックス", null],
    ["なし", null],
    ["none", null],
    ["", undefined],
    ["asdf", undefined],
    ["明日 14時", undefined],
    ["2/30", undefined],
  ])("%s", (raw, want) => {
    expect(parseDateInput(raw, ctx)).toBe(want);
  });
});
