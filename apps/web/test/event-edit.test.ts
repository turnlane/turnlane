/**
 * D-093（タスクと予定を分ける。ux-mvp 7章・4.12・6章）の純粋な部分: 予定のドロップ先、範囲の無い新規予定の時刻、
 * 予定の楽観的な置き直し、作り分けのキーの登録（キーボードの設定・⌘K）。
 */
import { describe, expect, test } from "bun:test";
import { type BoardResponse, type CalendarEventView, parseTask } from "@turnlane/core/web";
import { type DragItem, type DropData, forbiddenDrop, isDropGhost } from "../src/board/dnd.tsx";
import { eventRangeOf } from "../src/board/editors.tsx";
import { putEventInBoard } from "../src/data/mutations.ts";
import { makeI18n, translate } from "../src/i18n/index.tsx";
import { dispatchable, findConflicts, KEYMAP, keysOf } from "../src/keys/keymap.ts";
import { type BuildInput, buildSections } from "../src/palette/model.ts";

const H = 3_600_000;
const jst = (s: string) => Date.parse(`${s}:00+09:00`);
const today = "2026-10-02";

const ev = (p: Partial<CalendarEventView> = {}): CalendarEventView => ({
  id: "e1",
  title: "Dentist",
  start: jst(`${today}T16:00`),
  end: jst(`${today}T17:00`),
  allDay: false,
  startDate: null,
  endDate: null,
  calendarColor: "#6b8cc7",
  calendarColorKey: null,
  calendarId: "cal-1",
  busy: true,
  editable: true,
  ...p,
});

describe("D-093: 予定のドロップ先（ux-mvp 7章）", () => {
  const event: DragItem = { kind: "event", event: ev(), grabOffsetMs: 0 };
  const task: DragItem = {
    task: { id: "t1" } as never,
    block: null,
    grabOffsetMs: 0,
  };
  const ai: DragItem = { kind: "ai", workItemId: "w1", title: "x", grabOffsetMs: 0 };
  const grid = (lane?: "events"): DropData => ({
    kind: "grid",
    date: today,
    axis: { start: 0, end: 24 * H },
    busy: [],
    ...(lane ? { lane } : {}),
  });
  test.each<[string, DragItem, DropData, boolean]>([
    ["予定 → 自分レーン（時刻を変える）", event, grid(), false],
    ["予定 → 予定のレーン", event, grid("events"), false],
    ["予定 → 日付カラム（不可）", event, { kind: "date", date: today }, true],
    ["予定 → Inbox（不可）", event, { kind: "inbox" }, true],
    ["予定 → カード（不可）", event, { kind: "card", date: today, taskId: "t", ids: [] }, true],
    ["タスク → 予定のレーン（不可）", task, grid("events"), true],
    ["AI カード → 予定のレーン（不可）", ai, grid("events"), true],
    ["タスク → 自分レーン", task, grid(), false],
  ])("%s", (_, a, over, want) => {
    expect(forbiddenDrop(a, over, today)).toBe(want);
  });

  test("伸縮中（タスク・予定）は仮置きの枠を出さない", () => {
    const base = { date: today, range: { start: 0, end: H }, overlap: false };
    expect(isDropGhost({ ...base, taskId: null })).toBe(true);
    expect(isDropGhost({ ...base, taskId: "t1" })).toBe(false);
    expect(isDropGhost({ ...base, taskId: null, eventId: "e1" })).toBe(false);
    expect(isDropGhost(null)).toBe(false);
  });
});

describe("D-093: 範囲の無い新規予定（⇧C・⌘K）の時刻", () => {
  const p = (s: string) => parseTask(s, { today });
  test("時刻と長さを読む。長さが無ければ30分、日付が無ければ列の日付", () => {
    expect(eventRangeOf(p("Lunch 12:00 1h"), "2026-10-05", "Asia/Tokyo")).toEqual({
      start: jst("2026-10-05T12:00"),
      end: jst("2026-10-05T13:00"),
    });
    expect(eventRangeOf(p("Call 15:30"), "2026-10-05", "Asia/Tokyo")).toEqual({
      start: jst("2026-10-05T15:30"),
      end: jst("2026-10-05T16:00"),
    });
  });
  test("入力に日付があればその日", () => {
    const r = eventRangeOf(p("Dentist tomorrow 9:00 45m"), today, "Asia/Tokyo");
    expect(r).toEqual({ start: jst("2026-10-03T09:00"), end: jst("2026-10-03T09:45") });
  });
  test("時刻が無ければ作らない（null）", () => {
    expect(eventRangeOf(p("Lunch"), today, "Asia/Tokyo")).toBeNull();
  });
});

describe("D-093: 予定の楽観的な置き直し", () => {
  const day = (date: string, events: CalendarEventView[]) => ({
    date,
    axis: { start: jst(`${date}T00:00`), end: jst(`${date}T00:00`) + 24 * H },
    events,
  });
  const board = (days: ReturnType<typeof day>[]) => ({ days }) as unknown as BoardResponse;

  test("作る: 時間軸にかかる列にだけ足し、開始順に並べる", () => {
    const b = board([
      day(today, [ev({ id: "x", start: jst(`${today}T18:00`), end: jst(`${today}T19:00`) })]),
      day("2026-10-03", []),
    ]);
    const next = putEventInBoard(b, "new", ev({ id: "new" }));
    expect(next.days[0]?.events.map((e) => e.id)).toEqual(["new", "x"]);
    expect(next.days[1]?.events).toEqual([]);
  });

  test("別の日へ動かす: 元の列から外して新しい列へ", () => {
    const b = board([day(today, [ev()]), day("2026-10-03", [])]);
    const moved = ev({ start: jst("2026-10-03T10:00"), end: jst("2026-10-03T11:00") });
    const next = putEventInBoard(b, "e1", moved);
    expect(next.days[0]?.events).toEqual([]);
    expect(next.days[1]?.events).toEqual([moved]);
  });

  test("消す: どの列からも外す", () => {
    const b = board([day(today, [ev()])]);
    expect(putEventInBoard(b, "e1", null).days[0]?.events).toEqual([]);
  });
});

describe("作り分けのキー（D-077 のキーボードの設定）", () => {
  test("⇧C = 新しい予定（ボード）。Tab = タスク / 予定の切り替え（ドラッグ後の入力欄。固定）", () => {
    const newEvent = KEYMAP.find((d) => d.id === "newEvent");
    expect(newEvent).toMatchObject({ scope: "board", keys: ["shift+c"] });
    const kind = KEYMAP.find((d) => d.id === "promptKind");
    expect(kind).toMatchObject({ scope: "prompt", keys: ["tab"], fixed: true });
    expect(keysOf("promptKind", { promptKind: ["x"] })).toEqual(["tab"]);
    // 入力欄の中のキーは画面のキーの基盤では受けない
    expect(kind && dispatchable(kind)).toBe(false);
  });

  test("既定の割り当てに衝突は無い（Tab は入力欄だけの固定のキー）", () => {
    expect(findConflicts({})).toEqual([]);
  });

  test("⌘K に「New event」（⇧C）", () => {
    const i18n = makeI18n("en");
    const input: BuildInput = {
      q: "event",
      category: "commands",
      t: i18n.t,
      tEn: (k, x) => translate("en", k, x),
      shortDate: i18n.shortDate,
      titleOf: (x) => (x.t === "text" ? x.text : ""),
      today,
      now: jst(`${today}T13:20`),
      tz: "Asia/Tokyo",
      selection: [],
      queue: [],
      recent: [],
      search: undefined,
      theme: "dark",
      language: "en",
      hooksText: null,
      calendarText: null,
    };
    const row = buildSections(input)
      .flatMap((s) => s.rows)
      .find((r) => r.id === "cmd:newEvent");
    expect(row?.label).toBe("New event");
    expect(row?.keys).toEqual(["shift+c"]);
    expect(row?.run).toEqual({ t: "key", id: "newEvent" });
  });
});
