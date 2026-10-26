/**
 * 会議前に聞く集中モード（D-097。m2-api 25章）の純粋な判定: 会議リンク、対象の予定、問いの開閉と期限、答え、手動、
 * 集中の終わり、集中中の絞り込み、まとめの通知の件数と文言。時刻は引数（偽の時計）。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { QueueItem } from "../../src/api/queue.ts";
import { hasMeetingLink, isMeetingHost, MEETING_HOSTS } from "../../src/focus/meeting-link.ts";
import {
  addHeld,
  answerPrompt,
  cancelReservation,
  DEFAULT_FOCUS_SETTINGS,
  endFocus,
  FOCUS_MAX_MS,
  type FocusEventFact,
  type FocusSettings,
  type FocusState,
  filterFocus,
  focusLabel,
  focusSummary,
  initialFocusState,
  isFocusTarget,
  nextEventEnd,
  promptMessage,
  reserveEvent,
  startManual,
  stepFocus,
} from "../../src/focus/plan.ts";
import type { Notice } from "../../src/notify/plan.ts";

const MIN = 60_000;
const jst = (hm: string) => Date.parse(`2026-10-07T${hm}:00+09:00`);
const TZ = "Asia/Tokyo";

const ev = (p: Partial<FocusEventFact> & { id: string; start: number; end: number }) =>
  ({
    title: p.id,
    allDay: false,
    busy: true,
    hasAttendees: false,
    hasMeetingLink: false,
    ...p,
  }) as FocusEventFact;

/** 15:00–16:00 のデザインレビュー（参加者あり） */
const review = ev({
  id: "e-review",
  title: "デザインレビュー",
  start: jst("15:00"),
  end: jst("16:00"),
  hasAttendees: true,
});
const S = (p: Partial<FocusSettings> = {}): FocusSettings => ({ ...DEFAULT_FOCUS_SETTINGS, ...p });

function step(
  s: FocusState,
  now: number,
  events: FocusEventFact[] = [review],
  o: { settings?: FocusSettings } = {},
) {
  return stepFocus(s, { now, events, settings: o.settings ?? S() });
}

describe("会議リンク（メモ・場所・URL）", () => {
  test.each<[string, (string | null)[], boolean]>([
    ["Google Meet", ["https://meet.google.com/abc-defg-hij"], true],
    ["Zoom のサブドメイン", ["Join: https://example.zoom.us/j/123?pwd=x"], true],
    ["Teams", [null, "https://teams.microsoft.com/l/meetup-join/xyz"], true],
    ["Webex", ["https://acme.webex.com/meet/a"], true],
    ["大文字", ["HTTPS://MEET.GOOGLE.COM/x"], true],
    ["会議でない URL", ["https://example.com/zoom.us"], false],
    ["似たドメイン", ["https://notzoom.us/j/1"], false],
    ["URL でない文字", ["Zoom で話す"], false],
    ["空", [null, "", undefined as unknown as null], false],
  ])("%s", (_, texts, want) => {
    expect(hasMeetingLink(texts)).toBe(want);
  });

  test("ヘルパ（Swift）の一覧と同じ", () => {
    const swift = readFileSync(
      join(
        import.meta.dir,
        "../../../../native/calendar-helper/Sources/CalendarHelper/MeetingLink.swift",
      ),
      "utf8",
    );
    const block = /let meetingHosts: \[String\] = \[([\s\S]*?)\]/.exec(swift)?.[1] ?? "";
    const hosts = [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(hosts).toEqual([...MEETING_HOSTS]);
    expect(isMeetingHost("zoom.us.")).toBe(true);
  });
});

describe("対象の予定", () => {
  test.each<[string, Partial<FocusEventFact>, "meetings" | "busy", boolean]>([
    ["参加者あり", { hasAttendees: true }, "meetings", true],
    ["会議リンクあり", { hasMeetingLink: true }, "meetings", true],
    ["どちらもない", {}, "meetings", false],
    ["どちらもない（予定ありのすべて）", {}, "busy", true],
    ["free（予定中でない）", { hasAttendees: true, busy: false }, "busy", false],
    ["終日", { hasAttendees: true, allDay: true }, "meetings", false],
    ["参加者が分からない", { hasAttendees: null }, "meetings", false],
  ])("%s", (_, p, target, want) => {
    expect(isFocusTarget(ev({ id: "x", start: 0, end: 1, ...p }), target)).toBe(want);
  });
});

describe("問いと答え（開始の5分前、答えなければ集中しない）", () => {
  test("5分前より前は聞かない。5分前に1回だけ聞く。開始で閉じ、集中しない", () => {
    let s = initialFocusState();
    let r = step(s, jst("14:54"));
    expect(r.opened).toBeNull();
    r = step(r.state, jst("14:55"));
    expect(r.opened).toMatchObject({ eventId: "e-review", title: "デザインレビュー" });
    expect(r.changed).toBe(true);
    s = r.state;
    r = step(s, jst("14:57"));
    expect(r.opened).toBeNull();
    expect(r.state.prompt?.eventId).toBe("e-review");
    r = step(r.state, jst("15:00"));
    expect(r.state.prompt).toBeNull();
    expect(r.state.active).toBeNull();
    // 閉じた後も聞き直さない
    r = step(r.state, jst("15:00") - 1);
    expect(r.opened).toBeNull();
  });

  test("自動で集中（focus.auto）: 答えなければ開始の時刻に予定の終わりまで集中する", () => {
    const o = { settings: S({ auto: true }) };
    let r = step(initialFocusState(), jst("14:56"), [review], o);
    r = step(r.state, jst("15:00"), [review], o);
    expect(r.state.active).toEqual({
      since: jst("15:00"),
      until: jst("16:00"),
      source: "meeting",
      title: "デザインレビュー",
      eventId: "e-review",
    });
  });

  test("集中する: 今から予定の終わりまで。しない: 何もしない。違う key は古い（null）", () => {
    const r = step(initialFocusState(), jst("14:56"));
    const key = r.state.prompt?.key as string;
    expect(answerPrompt(r.state, "other", "focus", jst("14:57"))).toBeNull();
    const yes = answerPrompt(r.state, key, "focus", jst("14:57"));
    expect(yes?.late).toBe(false);
    expect(yes?.state.active).toMatchObject({ since: jst("14:57"), until: jst("16:00") });
    expect(yes?.state.prompt).toBeNull();
    const no = answerPrompt(r.state, key, "skip", jst("14:57"));
    expect(no?.state.active).toBeNull();
    expect(no?.state.prompt).toBeNull();
  });

  test("遅れた答え: 開始の時刻で閉じた問いは予定が続く間 closed に残り、集中するで今から予定の終わりまで", () => {
    let r = step(initialFocusState(), jst("14:56"));
    const key = r.state.prompt?.key as string;
    r = step(r.state, jst("15:00"));
    expect(r.state.prompt).toBeNull();
    expect(r.state.closed).toMatchObject({ key, eventId: "e-review", end: jst("16:00") });
    expect(r.changed).toBe(true);
    // 開始の後のボタン（会議に入ってから押した）
    const yes = answerPrompt(r.state, key, "focus", jst("15:03"));
    expect(yes?.late).toBe(true);
    expect(yes?.state.active).toEqual({
      since: jst("15:03"),
      until: jst("16:00"),
      source: "meeting",
      title: "デザインレビュー",
      eventId: "e-review",
    });
    expect(yes?.state.closed).toBeNull();
    // しない: 何もしないが、閉じた問いは忘れる（通知を取り下げる）
    const no = answerPrompt(r.state, key, "skip", jst("15:03"));
    expect(no?.late).toBe(true);
    expect(no?.state.active).toBeNull();
    expect(no?.state.closed).toBeNull();
    // 違う key は古い
    expect(answerPrompt(r.state, "other", "focus", jst("15:03"))).toBeNull();
    // 答えた後の tick で聞き直さない
    expect(step(yes?.state as FocusState, jst("15:04")).opened).toBeNull();
  });

  test("閉じた問いを忘れる: 予定が終わった・消えた・開始が変わった・終わりまで集中している・次の問いを開いた", () => {
    const closedAt1500 = () =>
      step(step(initialFocusState(), jst("14:56")).state, jst("15:00")).state;
    const key = closedAt1500().closed?.key as string;
    // 予定が延びたら追う
    const longer = { ...review, end: jst("16:30") };
    expect(step(closedAt1500(), jst("15:30"), [longer]).state.closed?.end).toBe(jst("16:30"));
    // 予定の終わりで忘れる（以後は stale）
    const ended = step(closedAt1500(), jst("16:00")).state;
    expect(ended.closed).toBeNull();
    expect(answerPrompt(ended, key, "focus", jst("16:00"))).toBeNull();
    // 終わりの直前に答えるのは間に合う
    expect(answerPrompt(closedAt1500(), key, "focus", jst("15:59"))?.late).toBe(true);
    // 予定が消えた・開始が変わった
    expect(step(closedAt1500(), jst("15:10"), []).state.closed).toBeNull();
    expect(
      step(closedAt1500(), jst("15:10"), [{ ...review, start: jst("15:05") }]).state.closed,
    ).toBeNull();
    // 手動で予定の終わりまで集中していれば忘れる（押しても何も変わらないため）
    const manual = startManual(closedAt1500(), jst("15:10"), jst("16:00"));
    expect(step(manual, jst("15:10")).state.closed).toBeNull();
    const shorter = startManual(closedAt1500(), jst("15:10"), jst("15:40"));
    expect(step(shorter, jst("15:10")).state.closed).not.toBeNull();
    // 集中中に遅れて集中するなら終わりを予定の終わりまで延ばす
    expect(answerPrompt(shorter, key, "focus", jst("15:10"))?.state.active).toMatchObject({
      since: jst("15:10"),
      until: jst("16:00"),
    });
    // 予約したら忘れる
    expect(reserveEvent(closedAt1500(), review, jst("15:10"))?.closed).toBeNull();
    // 次の問いを開いたら忘れる（通知が置き換わる）
    const next = ev({ id: "e2", start: jst("15:20"), end: jst("16:30"), hasMeetingLink: true });
    const r = step(closedAt1500(), jst("15:15"), [review, next]);
    expect(r.opened?.eventId).toBe("e2");
    expect(r.state.closed).toBeNull();
    // 自動で集中の設定なら閉じた問いは残さない（開始の時刻に集中している）
    const auto = step(step(initialFocusState(), jst("14:56")).state, jst("15:00"), [review], {
      settings: S({ auto: true }),
    }).state;
    expect(auto.closed).toBeNull();
    expect(auto.active).not.toBeNull();
  });

  test("聞かない: 設定でオフ・既に始まった・対象でない・集中中で予定の終わりまで続く", () => {
    expect(
      step(initialFocusState(), jst("14:56"), [review], { settings: S({ prompt: false }) }).opened,
    ).toBeNull();
    expect(step(initialFocusState(), jst("15:01")).opened).toBeNull();
    const plain = ev({ id: "p", start: jst("15:00"), end: jst("16:00") });
    expect(step(initialFocusState(), jst("14:56"), [plain]).opened).toBeNull();
    expect(
      step(initialFocusState(), jst("14:56"), [plain], { settings: S({ target: "busy" }) }).opened,
    ).not.toBeNull();
    const focused = startManual(initialFocusState(), jst("14:00"), jst("16:30"));
    expect(step(focused, jst("14:56")).opened).toBeNull();
  });

  test("何分前（focus.lead_min）", () => {
    const o = { settings: S({ leadMin: 15 }) };
    expect(step(initialFocusState(), jst("14:44"), [review], o).opened).toBeNull();
    expect(step(initialFocusState(), jst("14:45"), [review], o).opened).not.toBeNull();
  });

  test("予定が消えた・開始が変わったら問いを閉じる（開始が変われば新しい開始で聞き直す）", () => {
    const r = step(initialFocusState(), jst("14:56"));
    expect(step(r.state, jst("14:57"), []).state.prompt).toBeNull();
    const moved = { ...review, start: jst("14:58") };
    const m = step(r.state, jst("14:57"), [moved]);
    expect(m.state.prompt?.start).toBe(jst("14:58"));
  });

  test("続けて2つの会議: 先に始まるものを聞き、集中を次の会議の終わりまで延ばせる", () => {
    const next = ev({ id: "e2", start: jst("16:00"), end: jst("17:00"), hasMeetingLink: true });
    let r = step(initialFocusState(), jst("14:56"), [review, next]);
    expect(r.state.prompt?.eventId).toBe("e-review");
    let s = answerPrompt(r.state, r.state.prompt?.key as string, "focus", jst("14:56"));
    r = step(s?.state as FocusState, jst("15:56"), [review, next]);
    expect(r.opened?.eventId).toBe("e2");
    s = answerPrompt(r.state, r.state.prompt?.key as string, "focus", jst("15:56"));
    expect(s?.state.active).toMatchObject({
      since: jst("14:56"),
      until: jst("17:00"),
      eventId: "e2",
    });
  });
});

describe("集中の終わり", () => {
  test("終わりの時刻で終わり、止めた分を返す。会議の集中は予定の終わりを追う", () => {
    let r = step(initialFocusState(), jst("14:56"));
    let s = answerPrompt(r.state, r.state.prompt?.key as string, "focus", jst("14:56"))
      ?.state as FocusState;
    s = addHeld(s, [{ workItemId: "w1", status: "your_turn" }]);
    // 会議が16:30まで延びた
    const longer = { ...review, end: jst("16:30") };
    r = step(s, jst("16:00"), [longer]);
    expect(r.ended).toBeNull();
    expect(r.state.active?.until).toBe(jst("16:30"));
    r = step(r.state, jst("16:30"), [longer]);
    expect(r.ended?.held).toEqual([{ workItemId: "w1", status: "your_turn" }]);
    expect(r.state.active).toBeNull();
    expect(r.state.held).toEqual([]);
  });

  test("手動: 終わりを置き換え、上限は12時間。終了で止めた分を返す", () => {
    let s = startManual(initialFocusState(), jst("10:00"), jst("10:30"));
    expect(s.active).toMatchObject({ since: jst("10:00"), until: jst("10:30"), source: "manual" });
    s = startManual(s, jst("10:10"), jst("11:10"));
    expect(s.active).toMatchObject({ since: jst("10:00"), until: jst("11:10") });
    expect(startManual(s, jst("10:10"), jst("10:10") + 2 * FOCUS_MAX_MS).active?.until).toBe(
      jst("10:10") + FOCUS_MAX_MS,
    );
    s = addHeld(s, [{ workItemId: "w1", status: "needs_input" }]);
    const e = endFocus(s);
    expect(e.state.active).toBeNull();
    expect(e.ended?.held).toHaveLength(1);
    expect(endFocus(e.state).ended).toBeNull();
  });

  test("次の予定の終わり: 今の予定、無ければこれからの最初の予定（範囲の外・終日・free は除く）", () => {
    const evs = [
      ev({ id: "a", start: jst("09:00"), end: jst("10:00") }),
      ev({ id: "b", start: jst("11:00"), end: jst("11:30") }),
      ev({ id: "allday", start: jst("00:00"), end: jst("23:59"), allDay: true }),
      ev({ id: "free", start: jst("10:15"), end: jst("10:45"), busy: false }),
    ];
    const horizon = jst("23:59");
    expect(nextEventEnd(evs, jst("09:30"), horizon)).toBe(jst("10:00"));
    expect(nextEventEnd(evs, jst("10:10"), horizon)).toBe(jst("11:30"));
    expect(nextEventEnd(evs, jst("12:00"), horizon)).toBeNull();
    expect(nextEventEnd(evs, jst("10:10"), jst("10:30"))).toBeNull();
  });
});

const item = (id: string, status: QueueItem["status"]): QueueItem =>
  ({
    workItemId: id,
    title: id,
    status,
    repoRoot: "/w/app",
    branch: "feat/x",
    followUps: [{ id: `f-${id}`, kind: "reply", status: "open" }],
  }) as unknown as QueueItem;

describe("集中中の通知", () => {
  const needs: Notice = { kind: "immediate", item: item("a", "needs_input") };
  const err: Notice = { kind: "immediate", item: item("b", "error") };
  const batch: Notice = { kind: "batch", items: [item("c", "your_turn"), item("d", "your_turn")] };

  test("集中していなければそのまま。集中中はすべて止めて止めた分にする", () => {
    expect(
      filterFocus([needs, batch], { active: false, allowNeedsInput: false }).pass,
    ).toHaveLength(2);
    const r = filterFocus([needs, err, batch], { active: true, allowNeedsInput: false });
    expect(r.pass).toEqual([]);
    expect(r.held).toEqual([
      { workItemId: "a", status: "needs_input" },
      { workItemId: "b", status: "error" },
      { workItemId: "c", status: "your_turn" },
      { workItemId: "d", status: "your_turn" },
    ]);
  });

  test("集中中も許可待ちは通知する: needs_input の即時だけ通す", () => {
    const r = filterFocus([needs, err, batch], { active: true, allowNeedsInput: true });
    expect(r.pass).toEqual([needs]);
    expect(r.held.map((h) => h.workItemId)).toEqual(["b", "c", "d"]);
  });

  test("止めた分は同じカードを新しい状態で置き換える", () => {
    let s = addHeld(initialFocusState(), [{ workItemId: "a", status: "your_turn" }]);
    s = addHeld(s, [{ workItemId: "a", status: "needs_input" }]);
    expect(s.held).toEqual([{ workItemId: "a", status: "needs_input" }]);
  });
});

describe("まとめの通知と文言", () => {
  const meeting = {
    since: jst("15:00"),
    until: jst("16:00"),
    source: "meeting" as const,
    title: "x",
    eventId: "e",
  };
  test("止めた分のうち今も残っているカードだけを数える（状態は今のもの）。許可待ちがあれば添えて鳴らす", () => {
    const held = [
      { workItemId: "a", status: "your_turn" as const },
      { workItemId: "b", status: "your_turn" as const },
      { workItemId: "c", status: "your_turn" as const },
      { workItemId: "gone", status: "needs_input" as const },
    ];
    const q = [
      item("a", "your_turn"),
      item("b", "needs_input"),
      item("c", "error"),
      item("z", "your_turn"),
    ];
    const o = { now: jst("16:00"), tz: "Asia/Tokyo", notifyEnd: true };
    const ja = focusSummary({ active: meeting, held }, q, { ...o, locale: "ja" });
    expect(ja).toMatchObject({
      id: "focus-summary",
      kind: "focus_summary",
      title: "会議中に自分の番が 3 件（許可待ち 1）",
      path: "/queue",
      sound: true,
    });
    // 本文は各カードの件名（repo · branch ではない）
    expect(ja?.body.split("\n")).toEqual(["a", "b", "c"]);
    // 件名も出さない設定なら repo · branch
    expect(
      focusSummary({ active: meeting, held }, q, { ...o, locale: "ja", content: "minimal" })?.body,
    ).toBe("app · feat/x\napp · feat/x\napp · feat/x");
    const en = focusSummary(
      { active: { ...meeting, source: "manual" }, held: held.slice(0, 1) },
      q,
      { ...o, locale: "en" },
    );
    expect(en).toMatchObject({ title: "1 waiting on you from focus", sound: false });
    // 止めた分が今は残っていなくても、設定がオフでなければ終わったことを知らせる
    expect(
      focusSummary({ active: meeting, held: [held[3] as never] }, q, {
        ...o,
        locale: "ja",
        notifyEnd: false,
      }),
    ).toBeNull();
  });

  test("4 件以上は 3 件まで並べて「ほか N 件」", () => {
    const ids = ["a", "b", "c", "d", "e"];
    const held = ids.map((workItemId) => ({ workItemId, status: "your_turn" as const }));
    const q = ids.map((id) => item(id, "your_turn"));
    const o = { now: jst("16:00"), tz: "Asia/Tokyo", notifyEnd: true };
    const manual = { ...meeting, source: "manual" as const };
    expect(focusSummary({ active: manual, held }, q, { ...o, locale: "ja" })).toMatchObject({
      title: "集中モード中に自分の番が 5 件",
      body: "a\nb\nc\nほか 2 件",
      status: "your_turn",
      sound: false,
    });
    expect(focusSummary({ active: manual, held }, q, { ...o, locale: "en" })?.body).toBe(
      "a\nb\nc\nand 2 more",
    );
  });

  test("止めた分が 0 件: 終わったことだけを知らせる（鳴らさない・ボードを開く）。設定オフなら出さない", () => {
    const o = { tz: "Asia/Tokyo", notifyEnd: true };
    const manual = { ...meeting, source: "manual" as const, title: null, eventId: null };
    // 手動で 14:58 に終えた（終わりの時刻 16:00 より前）: 実際に終えた時刻
    const ja = focusSummary({ active: manual, held: [] }, [], {
      ...o,
      now: jst("14:58"),
      locale: "ja",
    });
    expect(ja).toEqual({
      id: "focus-summary",
      kind: "focus_summary",
      status: "focus",
      title: "集中モードを終了しました",
      body: "14:58 まで · 止めた通知はありません",
      path: "/board",
      sound: false,
    });
    // 終わりの時刻を過ぎてから気づいた（30秒ごとの判定）: 終わりの時刻
    expect(
      focusSummary({ active: manual, held: [] }, [], {
        ...o,
        now: jst("16:00") + 20_000,
        locale: "en",
      }),
    ).toMatchObject({ title: "Focus ended", body: "Until 16:00 · No muted notifications" });
    // 予定由来（会議・この予定の間は集中する）は題名
    const ev = { ...meeting, title: "定例" };
    expect(
      focusSummary({ active: ev, held: [] }, [], { ...o, now: jst("16:00"), locale: "ja" })?.body,
    ).toBe("「定例」の間 · 止めた通知はありません");
    expect(
      focusSummary({ active: { ...ev, title: "Team sync" }, held: [] }, [], {
        ...o,
        now: jst("16:00"),
        locale: "en",
      })?.body,
    ).toBe("During Team sync · No muted notifications");
    // 題名の無い予定は時刻
    expect(
      focusSummary({ active: { ...ev, title: null }, held: [] }, [], {
        ...o,
        now: jst("16:00"),
        locale: "ja",
      })?.body,
    ).toBe("16:00 まで · 止めた通知はありません");
    expect(
      focusSummary({ active: ev, held: [] }, [], {
        ...o,
        notifyEnd: false,
        now: jst("16:00"),
        locale: "ja",
      }),
    ).toBeNull();
  });

  test("表示と問いの通知", () => {
    expect(focusLabel(meeting, TZ, "ja")).toBe("集中モード中 · 16:00 まで");
    expect(focusLabel(meeting, TZ, "en")).toBe("Focusing until 16:00");
    const r = step(initialFocusState(), jst("14:56"));
    const m = promptMessage(r.state.prompt as never, TZ, "ja");
    expect(m).toMatchObject({
      id: "focus-prompt",
      kind: "focus_prompt",
      title: "15:00 デザインレビュー · 集中モードにしますか？",
      actions: [
        { id: "focus", title: "集中する" },
        { id: "skip", title: "しない" },
      ],
    });
    expect(m.path).toBe(`/board?focus=${encodeURIComponent(r.state.prompt?.key as string)}`);
  });
});

test("問いの key は英数字・-・_・: だけ（デスクトップアプリの検証）", () => {
  const r = step(initialFocusState(), jst("14:56"), [
    { ...review, id: "0192aa3c-1b2c-7d00-8e00-1234567890ab" },
  ]);
  expect(r.state.prompt?.key).toMatch(/^[A-Za-z0-9_:-]{1,64}$/);
  expect(MIN).toBe(60_000);
});

describe("この予定の間は集中する（D-130）", () => {
  /** 13:00–14:00 の作業の予定（会議でない） */
  const work = ev({ id: "e-work", title: "資料づくり", start: jst("13:00"), end: jst("14:00") });

  test("予約すると開始の時刻に始まり、予定の終わりで終わる。予定の延長を追う", () => {
    const s0 = reserveEvent(initialFocusState(), work, jst("10:00"));
    expect(s0?.active).toBeNull();
    expect(s0?.reserved.map((r) => r.eventId)).toEqual(["e-work"]);
    const before = step(s0 as FocusState, jst("12:59"), [work]);
    expect(before.state.active).toBeNull();
    const started = step(before.state, jst("13:00"), [work]);
    expect(started.state.active).toMatchObject({
      since: jst("13:00"),
      until: jst("14:00"),
      source: "manual",
      eventId: "e-work",
    });
    // 予定が 14:30 まで延びた
    const longer = { ...work, end: jst("14:30") };
    const followed = step(started.state, jst("13:30"), [longer]);
    expect(followed.state.active?.until).toBe(jst("14:30"));
    expect(followed.state.reserved[0]?.end).toBe(jst("14:30"));
    const ended = step(followed.state, jst("14:30"), [longer]);
    expect(ended.state.active).toBeNull();
    expect(ended.ended?.active.eventId).toBe("e-work");
    expect(ended.state.reserved).toEqual([]);
  });

  test("進行中の予定なら今から。会議なら会議の集中（まとめの文が会議）", () => {
    const s = reserveEvent(initialFocusState(), review, jst("15:20"));
    expect(s?.active).toMatchObject({
      since: jst("15:20"),
      until: jst("16:00"),
      source: "meeting",
    });
    expect(s?.reserved[0]?.started).toBe(true);
  });

  test("予約した会議は5分前に聞かない。開いている問いは閉じる", () => {
    const s = reserveEvent(initialFocusState(), review, jst("14:00")) as FocusState;
    expect(step(s, jst("14:55")).opened).toBeNull();
    const asked = step(initialFocusState(), jst("14:55"));
    expect(asked.state.prompt?.eventId).toBe("e-review");
    const r = reserveEvent(asked.state, review, jst("14:56"));
    expect(r?.prompt).toBeNull();
    expect(step(r as FocusState, jst("15:00")).state.active?.eventId).toBe("e-review");
  });

  test("途中で終了したら同じ予定の間は始め直さない", () => {
    const s = reserveEvent(initialFocusState(), work, jst("13:10")) as FocusState;
    const stopped = endFocus(s).state;
    expect(step(stopped, jst("13:20"), [work]).state.active).toBeNull();
  });

  test("取り消し: 始まる前なら予約だけ外す。最中なら集中も終える", () => {
    const s = reserveEvent(initialFocusState(), work, jst("10:00")) as FocusState;
    const c = cancelReservation(s, "e-work");
    expect(c.state.reserved).toEqual([]);
    expect(c.ended).toBeNull();
    expect(step(c.state, jst("13:00"), [work]).state.active).toBeNull();
    const running = reserveEvent(initialFocusState(), work, jst("13:10")) as FocusState;
    const c2 = cancelReservation(running, "e-work");
    expect(c2.state.active).toBeNull();
    expect(c2.ended?.active.eventId).toBe("e-work");
    // 手動の集中の最中に別の予定の予約を取り消しても、集中は続く
    const manual = startManual(s, jst("10:00"), jst("10:30"));
    expect(cancelReservation(manual, "e-work").state.active).not.toBeNull();
  });

  test("終わった予定・終日の予定は予約できない。予定が消えたら外す", () => {
    expect(reserveEvent(initialFocusState(), work, jst("14:00"))).toBeNull();
    expect(reserveEvent(initialFocusState(), { ...work, allDay: true }, jst("10:00"))).toBeNull();
    const s = reserveEvent(initialFocusState(), work, jst("10:00")) as FocusState;
    const gone = step(s, jst("11:00"), []);
    expect(gone.state.reserved).toEqual([]);
    expect(gone.changed).toBe(true);
  });

  test("古い保存値（reserved が無い）でも進められる", () => {
    const old = { active: null, prompt: null, asked: [], held: [] } as unknown as FocusState;
    expect(step(old, jst("10:00")).state.reserved).toEqual([]);
  });
});
