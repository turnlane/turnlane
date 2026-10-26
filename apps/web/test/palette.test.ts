/**
 * ⌘K のパレットの中身（ux-mvp 6.1、M2-15）: 空入力の区分、選んでいる項目への操作、日付・画面・コマンドの一致、
 * 検索結果の行、カテゴリの絞り込み、最近。
 */
import { describe, expect, test } from "bun:test";
import type { QueueItem, SearchResponse, TaskView } from "@turnlane/core/web";
import { makeI18n, translate } from "../src/i18n/index.tsx";
import type { SelItem } from "../src/lib/store.ts";
import { GLYPH, glyphOf } from "../src/palette/glyphs.ts";
import {
  type BuildInput,
  buildSections,
  CATEGORIES,
  flatRows,
  GLYPH_NAMES,
  isRecentRow,
  nextCategory,
  pushRecent,
  type Row,
} from "../src/palette/model.ts";

const TODAY = "2026-10-05"; // 月
const NOW = Date.parse("2026-10-05T13:20:00+09:00");

function task(id: string, p: Partial<TaskView> = {}): TaskView {
  return {
    id,
    title: { t: "text", text: id },
    status: "todo",
    scheduledDate: TODAY,
    laneOrder: "a",
    estimateMin: 30,
    projectId: null,
    rolloverCount: 0,
    isHighlight: false,
    completedAt: null,
    autoCompleted: false,
    origin: { source: "manual", client: null, externalSource: null, externalUrl: null },
    followUpId: null,
    workItemId: null,
    createdAt: 0,
    deletedAt: null,
    ...p,
  };
}

function turn(id: string, title: string, status: QueueItem["status"] = "your_turn"): QueueItem {
  return {
    workItemId: id,
    title,
    status,
    reason: null,
    estimated: false,
    repoRoot: "/w/billing-api",
    branch: "feat/x",
    prRef: null,
    sources: [],
    waitingSince: NOW - 25 * 60_000,
    waitStartedAway: false,
    followUps: [
      {
        id: `fu-${id}`,
        kind: "reply",
        status: "open",
        title: { t: "text", text: title },
        triggerAt: NOW - 25 * 60_000,
        snoozeUntil: null,
        engagedAt: null,
        expiresAt: null,
        taskId: null,
        taskDate: TODAY,
        task: null,
      },
    ],
  };
}

function input(p: Partial<BuildInput> = {}, locale: "en" | "ja" = "en"): BuildInput {
  const i18n = makeI18n(locale);
  return {
    q: "",
    category: "all",
    t: i18n.t,
    tEn: (k, x) => translate("en", k, x),
    shortDate: i18n.shortDate,
    titleOf: (x) => (x.t === "text" ? x.text : (x.params.title ?? "")),
    today: TODAY,
    now: NOW,
    tz: "Asia/Tokyo",
    selection: [],
    queue: [],
    recent: [],
    search: undefined,
    theme: "dark",
    language: "en",
    hooksText: "Claude Code receiving",
    calendarText: "Connected",
    ...p,
  };
}

const ids = (rows: Row[]) => rows.map((r) => r.id);
/** コマンドの行（入力から作る「タスクを作る」を除く） */
const cmds = (rows: Row[] | undefined) =>
  (rows ?? []).filter((r) => r.id !== "cmd:create").map((r) => r.label);
const sectionIds = (i: BuildInput) => buildSections(i).map((s) => s.id);

describe("空入力", () => {
  test("Your turn の上位3件、最近、今日の画面への移動。選んでいなければ Selected は出さない", () => {
    const queue = [
      turn("a", "Approve migration", "needs_input"),
      turn("b", "Review PR"),
      turn("c", "Pricing"),
      turn("d", "Extra"),
    ];
    const recent: Row[] = [
      {
        id: "cmd:help",
        section: "commands",
        label: "Show shortcuts",
        icon: { t: "glyph", name: "keys" },
        run: { t: "key", id: "help" },
      },
    ];
    const s = buildSections(input({ queue, recent }));
    expect(s.map((x) => x.id)).toEqual(["yourTurn", "recent", "goto"]);
    expect(ids(s[0]?.rows ?? [])).toEqual(["turn:a", "turn:b", "turn:c"]);
    expect(s[0]?.rows[0]).toMatchObject({
      right: "25m",
      run: { t: "openTurn", followUpId: "fu-a" },
      alt: { t: "panel", workItemId: "a" },
      icon: { t: "status", status: "needs_input" },
    });
    expect(ids(s[1]?.rows ?? [])).toEqual(["recent:cmd:help"]);
    expect(s[2]?.rows.map((r) => r.label)).toEqual([
      "Today",
      "Board",
      "Your turn",
      "Inbox",
      "Daily note",
    ]);
    // 記録（D-192）: 今日のデイビューを記録のパネル付きで開く
    expect(s[2]?.rows.find((r) => r.label === "Daily note")?.run).toEqual({
      t: "nav",
      to: "/day",
      date: null,
      record: true,
    });
  });
});

describe("選んでいる項目への操作", () => {
  const labels = (selection: SelItem[]) =>
    buildSections(input({ selection }))
      .find((s) => s.id === "selected")
      ?.rows.map((r) => `${r.label}|${r.keys?.join(",")}`);

  test("タスク1件: 移動・時間に置く・今日へ・完了・タイトル・削除", () => {
    expect(labels([{ kind: "task", task: task("Write outline") }])).toEqual([
      "Move to a date…|m",
      "Schedule…|p",
      "Move to today|t",
      "Complete / not done|space",
      "Rename|r",
      "Delete|mod+backspace",
    ]);
  });

  test("自分の番: 開く・他の開き方・詳細・次の稼働日へ・スヌーズ・対応不要・完了", () => {
    expect(labels([{ kind: "turn", item: turn("a", "Review PR") }])).toEqual([
      "Open|enter",
      "Open with…|o",
      "Open details|arrowright,mod+enter",
      "Move to next workday|m",
      "Snooze…|s",
      "Not needed|e",
      "Complete / not done|space",
    ]);
  });

  test("AI カード: 開くは既定の開き先（パネルではない）、返答タスク", () => {
    const s = buildSections(
      input({ selection: [{ kind: "ai", id: "w1", title: "Auth refresh" }] }),
    );
    const rows = s.find((x) => x.id === "selected")?.rows ?? [];
    expect(rows.map((r) => r.label)).toEqual([
      "Open",
      "Open with…",
      "Open details",
      "Create a reply task",
    ]);
    expect(rows[0]?.run).toEqual({ t: "openAi", workItemId: "w1" });
    expect(s.find((x) => x.id === "selected")?.note).toBe("Auth refresh");
    expect(rows[3]?.run).toEqual({ t: "key", id: "replyTask" });
  });

  test("タスク2件では時間に置くを出さない。入力で絞る", () => {
    const sel: SelItem[] = [
      { kind: "task", task: task("a") },
      { kind: "task", task: task("b") },
    ];
    expect(labels(sel)).not.toContain("Schedule…|p");
    const s = buildSections(input({ selection: sel, q: "move" }));
    expect(
      s
        .find((x) => x.id === "selected")
        ?.rows.map((r) => r.label)
        .sort(),
    ).toEqual(["Move to a date…", "Move to today"]);
    expect(s.find((x) => x.id === "selected")?.note).toBe("2 items");
  });
});

describe("入力したとき", () => {
  test("日付（水曜・10/12・tomorrow）で週ボードとデイビューへの2行", () => {
    for (const [q, d] of [
      ["水曜", "2026-10-07"],
      ["10/12", "2026-10-12"],
      ["tomorrow", "2026-10-06"],
    ] as const) {
      const goto = buildSections(input({ q })).find((s) => s.id === "goto");
      expect(goto?.rows.slice(0, 2).map((r) => r.run)).toEqual([
        { t: "nav", to: "/board", date: d },
        { t: "nav", to: "/day", date: d },
      ]);
    }
    const ja = buildSections(input({ q: "水曜" }, "ja")).find((s) => s.id === "goto");
    expect(ja?.rows[0]?.label).toBe("10/7（水） の週");
  });

  test("今のテーマ・言語の行は出さない。hooks・カレンダーの状態を右に出す", () => {
    const c = buildSections(input({ q: "hooks", theme: "dark" })).find((s) => s.id === "commands");
    expect(c?.rows[0]).toMatchObject({ label: "Hooks status", right: "Claude Code receiving" });
    const t = buildSections(input({ q: "theme", theme: "dark" })).find((s) => s.id === "commands");
    expect(cmds(t?.rows)).toEqual(["Theme: Light", "Theme: Follow system"]);
  });

  test("新規タスクの行（日付が読めなければ Inbox）", () => {
    const c = buildSections(input({ q: "Write outline tomorrow 30m" })).find(
      (s) => s.id === "commands",
    );
    const create = c?.rows.find((r) => r.id === "cmd:create");
    expect(create).toMatchObject({
      label: "Create task “Write outline”",
      meta: "Tue 10/6 · 30m",
      run: { t: "createTask", raw: "Write outline tomorrow 30m" },
    });
    const inbox = buildSections(input({ q: "Call bank" }))
      .find((s) => s.id === "commands")
      ?.rows.find((r) => r.id === "cmd:create");
    expect(inbox?.meta).toBe("Inbox");
  });

  test("検索結果: AI（⏎ 開く・⌘⏎ 詳細）、タスク（⏎ も ⌘⏎ もその日へ移ってタスクの詳細パネル）、予定（その日のデイビューと予定のパネル。D-070）", () => {
    const search: SearchResponse = {
      today: TODAY,
      displayToday: TODAY,
      now: NOW,
      rev: 1,
      tz: "Asia/Tokyo",
      dayBoundary: 240,
      q: "142",
      aiItems: [
        {
          id: "w1",
          title: "Day lane DnD",
          status: "done",
          estimated: false,
          sources: [],
          repo: "turnlane",
          branch: "feat/day-view",
          prs: [142],
          lastActivityAt: NOW,
          date: "2026-10-02",
        },
      ],
      tasks: [
        {
          task: task("Review PR #142", {
            workItemId: "w1",
            scheduledDate: "2026-10-02",
            status: "done",
          }),
        },
        { task: task("Note 142", { scheduledDate: null }) },
      ],
      events: [
        {
          id: "e1",
          title: "Sprint 142 review",
          start: NOW,
          end: NOW + 30 * 60_000,
          allDay: false,
          date: TODAY,
        },
      ],
    } as SearchResponse;
    const s = buildSections(input({ q: "142", search }));
    // 区分の順。コマンドの最後に「タスクを作る」
    expect(s.map((x) => x.id)).toEqual(["ai", "tasks", "events", "commands"]);
    expect(s[3]?.rows.map((r) => r.id)).toEqual(["cmd:create"]);
    expect(s[0]?.rows[0]).toMatchObject({
      meta: "turnlane · feat/day-view #142",
      right: "Fri 10/2",
      run: { t: "openAi", workItemId: "w1" },
      alt: { t: "panel", workItemId: "w1" },
    });
    expect(s[1]?.rows[0]).toMatchObject({
      done: true,
      right: "Fri 10/2",
      run: { t: "focusTask", taskId: "Review PR #142", date: "2026-10-02" },
      alt: { t: "focusTask", taskId: "Review PR #142", date: "2026-10-02" },
    });
    expect(s[1]?.rows[1]?.right).toBe("Inbox");
    expect(s[2]?.rows[0]).toMatchObject({
      meta: "13:20–13:50",
      run: { t: "event", eventId: "e1", date: TODAY },
    });
  });

  test("カテゴリで絞る（Tab）。All は区分ごと5件まで", () => {
    const many = Array.from({ length: 8 }, (_, n) => ({ task: task(`Draft ${n}`) }));
    const search = { aiItems: [], tasks: many, events: [] } as unknown as SearchResponse;
    expect(
      buildSections(input({ q: "draft", search })).find((s) => s.id === "tasks")?.rows,
    ).toHaveLength(5);
    expect(sectionIds(input({ q: "draft", search, category: "tasks" }))).toEqual(["tasks"]);
    expect(buildSections(input({ q: "draft", search, category: "tasks" }))[0]?.rows).toHaveLength(
      8,
    );
    expect(sectionIds(input({ q: "", category: "commands" }))).toEqual(["commands"]);
    expect(sectionIds(input({ q: "", category: "ai" }))).toEqual([]);
    expect(nextCategory("all", 1)).toBe("commands");
    expect(nextCategory("all", -1)).toBe("goto");
    expect(nextCategory("goto", 1)).toBe("all");
  });

  test("flatRows は区分の順", () => {
    const s = buildSections(input({ q: "week" }));
    expect(flatRows(s).map((r) => r.section)).toEqual(s.flatMap((x) => x.rows.map(() => x.id)));
  });
});

describe("最近", () => {
  const row = (id: string): Row => ({
    id,
    section: "commands",
    label: id,
    icon: { t: "glyph", name: "keys" },
    run: { t: "key", id: "help" },
  });
  test("同じ行は先頭へ、5件まで。作成と時間に置くは残さない", () => {
    let xs: Row[] = [];
    for (const id of ["a", "b", "c", "d", "e", "f"]) xs = pushRecent(xs, row(id));
    expect(ids(xs)).toEqual(["f", "e", "d", "c", "b"]);
    xs = pushRecent(xs, { ...row("c"), id: "recent:c" });
    expect(ids(xs)).toEqual(["c", "f", "e", "d", "b"]);
    expect(ids(pushRecent(xs, { ...row("x"), run: { t: "createTask", raw: "x" } }))).toEqual(
      ids(xs),
    );
  });
});

describe("古い形・欠けた形で落ちない", () => {
  /** 上限待ちだけの「後で」の行（followUps が空。GET /api/queue の limitWaits） */
  const limitWait: QueueItem = {
    ...turn("w-limit", "usage cap"),
    title: null,
    followUps: [],
    limitWait: { since: NOW - 40 * 60_000, until: NOW + 4 * 3600_000, untilKnown: false },
  } as QueueItem;
  const search: SearchResponse = {
    q: "a",
    aiItems: [
      {
        id: "w-ai",
        title: null,
        repo: null,
        branch: null,
        scratch: true,
        prs: [],
        date: TODAY,
        status: "done",
        estimated: true,
      },
    ],
    tasks: [{ task: task("a-task") }],
    events: [
      { id: "e1", title: null, start: NOW, end: NOW + 3600_000, allDay: false, date: TODAY },
    ],
  } as unknown as SearchResponse;
  const selections: SelItem[][] = [
    [],
    [{ kind: "task", task: task("t1") }],
    [{ kind: "turn", item: limitWait }],
    [{ kind: "turn", item: turn("w1", "Reply") }],
    [{ kind: "ai", id: "w-ai", title: null }],
    [
      { kind: "turn", item: limitWait },
      { kind: "ai", id: "w-ai", title: null },
    ],
  ];
  const all = (): Row[] =>
    selections.flatMap((selection) =>
      CATEGORIES.flatMap((category) =>
        ["", "a", "水曜", "set"].flatMap((q) =>
          flatRows(
            buildSections(
              input({
                q,
                category,
                selection,
                queue: [limitWait, turn("w1", "Reply")],
                search: q ? search : undefined,
                focus: { active: true, eventAvailable: true },
              }),
            ),
          ),
        ),
      ),
    );

  test("上限待ち（followUps が空）を選んでも、帯に混ざっても組み立てられる", () => {
    const secs = buildSections(
      input({ selection: [{ kind: "turn", item: limitWait }], queue: [limitWait] }),
    );
    expect(secs.find((s) => s.id === "selected")?.note).toBe("");
    // 開く問いの無い行は YOUR TURN に出さない
    expect(secs.find((s) => s.id === "yourTurn")).toBeUndefined();
  });

  test("絵柄の対応表は名前の一覧と同じで、どの行の絵柄も対応表にある", () => {
    expect(Object.keys(GLYPH).sort()).toEqual([...GLYPH_NAMES].sort());
    for (const n of GLYPH_NAMES) expect(GLYPH[n]).toBeDefined();
    const rows = all();
    expect(rows.length).toBeGreaterThan(50);
    for (const r of rows) if (r.icon.t === "glyph") expect(GLYPH_NAMES).toContain(r.icon.name);
  });

  test("知らない絵柄の名前でも undefined を返さない", () => {
    expect(glyphOf("morning")).toBeDefined();
    expect(glyphOf("close")).toBeDefined();
    expect(glyphOf("toString")).toBe(glyphOf("action"));
  });

  test("最近に保存した行は、次に開いたときに読める（保存と読み込みが同じ形）", () => {
    for (const r of all()) {
      const saved = pushRecent([], r);
      if (saved.length === 0) continue;
      expect(isRecentRow(JSON.parse(JSON.stringify(saved[0])))).toBe(true);
    }
  });

  test("古い版が保存した行・壊れた値は最近から落とす", () => {
    const old: unknown[] = [
      // 廃止した画面と絵柄（朝の計画・今日を閉じる）
      {
        id: "goto:morning",
        section: "goto",
        label: "Plan",
        icon: { t: "glyph", name: "morning" },
        run: { t: "nav", to: "/morning" },
      },
      {
        id: "cmd:closeToday",
        section: "commands",
        label: "Close",
        icon: { t: "glyph", name: "close" },
        run: { t: "nav", to: "/shutdown" },
      },
      {
        id: "cmd:reopenToday",
        section: "commands",
        label: "Reopen",
        icon: { t: "glyph", name: "today" },
        run: { t: "reopenDay" },
      },
      // 絵柄が無い・ラベルが文字でない・状態が知らない値
      { id: "x", section: "goto", label: "x", run: { t: "rescan" } },
      {
        id: "y",
        section: "goto",
        label: { a: 1 },
        icon: { t: "glyph", name: "today" },
        run: { t: "rescan" },
      },
      {
        id: "z",
        section: "ai",
        label: "z",
        icon: { t: "status", status: "stale", estimated: false },
        run: { t: "openAi", workItemId: "w" },
      },
      null,
      "goto:today",
    ];
    for (const v of old) expect(isRecentRow(v)).toBe(false);
    expect(
      isRecentRow({
        id: "goto:ai",
        section: "goto",
        label: "AI",
        icon: { t: "glyph", name: "ai" },
        run: { t: "nav", to: "/ai" },
      }),
    ).toBe(true);
  });
});
