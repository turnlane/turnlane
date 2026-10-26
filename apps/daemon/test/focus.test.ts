/**
 * 会議前に聞く集中モード（D-097。m2-api 25章）の結合テスト: 偽のカレンダー → calendar_event（会議リンクの列）→
 * FocusService（問い・答え・自動の集中・終わり）→ HTTP（/api/focus、/api/queue、/api/queue/summary）→ NotifyRunner
 * （集中中に止め、終わったらまとめて1回）。時計は偽物（2026-09-14 月曜 JST）。
 */
import { afterEach, describe, expect, test } from "bun:test";
import { type MetaOnlyLogger, nullLogger } from "@turnlane/collectors";
import { readSettings } from "@turnlane/core";
import type { FocusView, QueueItem, QueueResponse, QueueSummaryResponse } from "@turnlane/core/api";
import { DEFAULT_FOCUS_SETTINGS, type FocusSettings, type NoticeMessage } from "@turnlane/core/web";
import { type CalendarSystem, createCalendar } from "../src/calendar/index.ts";
import { FakeCalendarProvider, type HelperEvent } from "../src/calendar/provider.ts";
import { FocusService } from "../src/focus/service.ts";
import { createApp } from "../src/http/app.ts";
import type { SseMessage } from "../src/http/sse.ts";
import { NotifyRunner } from "../src/notify/runner.ts";
import { type AiEnv, makeAiEnv } from "./helpers/env.ts";

const TOKEN = "f".repeat(64);
const HOST = "127.0.0.1:7317";
const D = "2026-09-14";
const jst = (hm: string) => Date.parse(`${D}T${hm}:00+09:00`);

let env: AiEnv;
let cal: CalendarSystem;
afterEach(async () => {
  cal?.stop();
  await env?.cleanup();
});

const ev = (p: Partial<HelperEvent> & { eventId: string; start: number; end: number }) =>
  ({
    calendarId: "ek-work",
    externalId: `uid-${p.eventId}`,
    occurrenceStart: p.start,
    title: p.eventId,
    allDay: false,
    status: "confirmed",
    availability: "busy",
    url: null,
    location: null,
    hasAttendees: false,
    recurring: false,
    ...p,
  }) as HelperEvent;

const events = (): HelperEvent[] => [
  ev({
    eventId: "review",
    title: "Design review",
    start: jst("15:00"),
    end: jst("16:00"),
    hasAttendees: true,
  }),
  // 0.5.0 のヘルパ: メモに会議リンクがある（本文は来ない）
  ev({
    eventId: "standup",
    title: "Standup",
    start: jst("17:00"),
    end: jst("17:15"),
    hasMeetingLink: true,
  }),
  // 0.5.0 より前のヘルパ: 場所の URL でデーモンが判定する
  ev({
    eventId: "zoom",
    title: "Zoom call",
    start: jst("18:00"),
    end: jst("18:30"),
    location: "https://example.zoom.us/j/1",
  }),
  ev({ eventId: "dentist", title: "Dentist", start: jst("12:00"), end: jst("13:00") }),
];

const item = (id: string, status: QueueItem["status"], fu: string): QueueItem => ({
  workItemId: id,
  title: id,
  status,
  reason: null,
  estimated: false,
  repoRoot: "/w/app",
  branch: "feat/x",
  prRef: null,
  sources: [],
  waitingSince: 0,
  waitStartedAway: false,
  followUps: [
    {
      id: fu,
      kind: status === "needs_input" ? "approve" : "reply",
      status: "open",
      title: { t: "text", text: `task ${id}` },
      triggerAt: 0,
      snoozeUntil: null,
      engagedAt: null,
      expiresAt: null,
      taskId: null,
      taskDate: null,
      task: null,
    },
  ],
});

async function setup(o: { settings?: Partial<FocusSettings>; desktop?: boolean } = {}) {
  env = makeAiEnv({ now: jst("14:50") });
  const provider = new FakeCalendarProvider({
    calendars: [
      {
        id: "ek-work",
        title: "Work",
        sourceTitle: "Example",
        sourceType: "calDAV",
        colorHex: "#6b8cc7",
        allowsModify: true,
        type: "calDAV",
      },
    ],
    events: events(),
  });
  cal = createCalendar({
    sqlite: env.sqlite,
    mutate: env.mutate,
    clock: env.clock,
    hub: env.hub,
    logger: nullLogger,
    provider,
    openSystem: env.open,
  });
  await cal.deps.sync();
  const st = {
    settings: { ...DEFAULT_FOCUS_SETTINGS, ...o.settings } as FocusSettings,
    desktop: o.desktop ?? true,
    items: [] as QueueItem[],
  };
  const sent: SseMessage[] = [];
  env.hub.subscribe((m) => {
    if (m.type === "notify" || m.type === "focus") sent.push(m);
  });
  // デーモンのログ（答えが届いたか・結果の切り分けに残すもの）
  const logs: { event: string; fields: Record<string, unknown> }[] = [];
  const logger: MetaOnlyLogger = {
    debug() {},
    info: (event, fields) => void logs.push({ event, fields: { ...fields } }),
    warn: (event, fields) => void logs.push({ event, fields: { ...fields } }),
    error: (event, fields) => void logs.push({ event, fields: { ...fields } }),
  };
  let runner: NotifyRunner | undefined;
  const make = () =>
    new FocusService({
      sqlite: env.sqlite,
      mutate: env.mutate,
      clock: env.clock,
      settings: () => readSettings(env.mutate.db),
      prefs: () => st.settings,
      locale: () => "ja",
      queue: () => st.items,
      takePending: () => runner?.takePending() ?? [],
      desktopChannel: () => st.desktop,
      publish: (type, data) => env.hub.publish(type, data),
      logger,
    });
  const focus = make();
  runner = new NotifyRunner({
    queue: () => ({ items: st.items }),
    locale: () => "ja",
    now: () => env.clock.now(),
    publish: (type, data) => env.hub.publish(type, data),
    subscribe: () => () => {},
    focus: {
      active: (now) => focus.active(now),
      allowNeedsInput: () => focus.allowNeedsInput(),
      hold: (h) => focus.hold(h),
    },
  });
  runner.run();
  const app = createApp({
    token: TOKEN,
    port: 7317,
    hub: env.hub,
    health: () => ({}) as never,
    admin: { backup: () => ({ date: "", path: "" }) },
    ai: () => env.ai.deps,
    calendar: () => cal.deps,
    focus: () => focus,
  });
  const call = async <T>(method: string, path: string, body?: unknown) => {
    const r = await app.request(`http://${HOST}${path}`, {
      method,
      headers: {
        host: HOST,
        authorization: `Bearer ${TOKEN}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, body: (await r.json()) as T };
  };
  const notices = () => {
    env.hub.flush();
    return sent
      .filter((m) => m.type === "notify")
      .flatMap((m) => m.data.notices as NoticeMessage[]);
  };
  const at = (hm: string) => {
    env.clock.set(jst(hm));
    focus.tick();
    env.hub.flush();
  };
  return { focus, runner, st, sent, call, notices, at, make, provider, logs };
}

describe("会議リンク（0008 の has_meeting_link）", () => {
  test("ヘルパの hasMeetingLink を入れ、無ければ URL・場所で判定する", async () => {
    await setup();
    const rows = env.sqlite
      .query<{ title: string; has_meeting_link: number | null }, []>(
        "SELECT title, has_meeting_link FROM calendar_event ORDER BY start_at",
      )
      .all();
    expect(Object.fromEntries(rows.map((r) => [r.title, r.has_meeting_link]))).toEqual({
      Dentist: 0,
      "Design review": 0,
      Standup: 1,
      "Zoom call": 1,
    });
  });
});

describe("問いと答え", () => {
  test("開始の5分前に聞く（デスクトップアプリがあれば通知のボタン）。集中するで予定の終わりまで", async () => {
    const e = await setup();
    e.at("14:54");
    expect(e.focus.view().prompt).toBeNull();
    e.at("14:55");
    const v = e.focus.view();
    expect(v.prompt?.label).toBe("15:00 Design review · 集中モードにしますか？");
    expect(v.channel).toBe("desktop");
    expect(e.logs.find((l) => l.event === "focus.prompted")?.fields).toEqual({
      lead_min: 5,
      channel: "desktop",
    });
    const n = e.notices();
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({
      id: "focus-prompt",
      kind: "focus_prompt",
      actions: [
        { id: "focus", title: "集中する" },
        { id: "skip", title: "しない" },
      ],
    });
    expect(e.sent.some((m) => m.type === "focus" && m.data.prompt === true)).toBe(true);
    const stale = await e.call<{ error: string }>("POST", "/api/focus/prompt", {
      key: "nope",
      answer: "focus",
    });
    expect([stale.status, stale.body.error]).toEqual([409, "stale"]);
    const r = await e.call<FocusView>("POST", "/api/focus/prompt", {
      key: v.prompt?.key,
      answer: "focus",
    });
    expect(r.body.active).toMatchObject({
      since: jst("14:55"),
      until: jst("16:00"),
      source: "meeting",
      label: "集中モード中 · 16:00 まで",
    });
    expect(r.body.prompt).toBeNull();
  });

  test("アプリが無い・通知が拒否なら帯（channel band）で聞き、通知は出さない", async () => {
    const e = await setup({ desktop: false });
    e.at("14:56");
    expect(e.focus.view()).toMatchObject({ channel: "band", prompt: { title: "Design review" } });
    expect(e.notices()).toEqual([]);
    expect(e.logs.find((l) => l.event === "focus.prompted")?.fields).toMatchObject({
      channel: "band",
    });
  });

  test("答えなければ集中しない。自動で集中の設定なら開始の時刻に集中する", async () => {
    let e = await setup();
    e.at("14:56");
    e.at("15:00");
    expect(e.focus.view()).toMatchObject({ active: null, prompt: null });
    cal.stop();
    await env.cleanup();
    e = await setup({ settings: { auto: true } });
    e.at("14:56");
    e.at("15:00");
    expect(e.focus.view().active).toMatchObject({ until: jst("16:00"), source: "meeting" });
  });

  test("遅れた答え: 開始の後に通知のボタンを押しても、予定が続く間は予定の終わりまで集中する。結果はログに残る", async () => {
    const e = await setup();
    e.at("14:55");
    const key = e.focus.view().prompt?.key as string;
    e.at("15:00");
    // 問いは閉じる（帯・ポップオーバーには出ない）が、通知は取り下げない（late）
    expect(e.focus.view().prompt).toBeNull();
    const closedAt = e.sent.filter((m) => m.type === "focus").at(-1);
    expect(closedAt?.data).toMatchObject({ active: false, prompt: false, late: true });
    expect(e.focus.state.closed?.key).toBe(key);
    // 会議に入ってからボタンを押した
    e.at("15:03");
    const r = await e.call<FocusView>("POST", "/api/focus/prompt", { key, answer: "focus" });
    expect(r.status).toBe(200);
    expect(r.body.active).toMatchObject({
      since: jst("15:03"),
      until: jst("16:00"),
      source: "meeting",
      label: "集中モード中 · 16:00 まで",
    });
    expect(e.sent.filter((m) => m.type === "focus").at(-1)?.data).toMatchObject({
      active: true,
      prompt: false,
      late: false,
    });
    expect(e.logs.filter((l) => l.event.startsWith("focus.answer"))).toEqual([
      { event: "focus.answered", fields: { answer: "focus", late: true } },
    ]);
    // 2度目は古い。予定が終わった後も古い（どちらもログに残る）
    const again = await e.call<{ error: string }>("POST", "/api/focus/prompt", {
      key,
      answer: "focus",
    });
    expect([again.status, again.body.error]).toEqual([409, "stale"]);
    expect(e.logs.at(-1)).toEqual({
      event: "focus.answer_stale",
      fields: { answer: "focus", prompt_open: false, closed_open: false },
    });
    // 「しない」を遅れて押すと、何もしないで通知を取り下げる（late: false）
    cal.stop();
    await env.cleanup();
    const e2 = await setup();
    e2.at("14:55");
    const key2 = e2.focus.view().prompt?.key as string;
    e2.at("15:10");
    const skip = await e2.call<FocusView>("POST", "/api/focus/prompt", {
      key: key2,
      answer: "skip",
    });
    expect([skip.status, skip.body.active]).toEqual([200, null]);
    expect(e2.sent.filter((m) => m.type === "focus").at(-1)?.data).toMatchObject({ late: false });
    expect(e2.focus.state.closed).toBeNull();
    // 予定が終わったら忘れる
    cal.stop();
    await env.cleanup();
    const e3 = await setup();
    e3.at("14:55");
    const key3 = e3.focus.view().prompt?.key as string;
    e3.at("15:00");
    e3.at("16:00");
    expect(e3.sent.filter((m) => m.type === "focus").at(-1)?.data).toMatchObject({ late: false });
    const late = await e3.call<{ error: string }>("POST", "/api/focus/prompt", {
      key: key3,
      answer: "focus",
    });
    expect([late.status, late.body.error]).toEqual([409, "stale"]);
  });

  test("入力の不備・予定が無いなどの 4xx はログに残る（通知のボタンが効かないときの切り分け）", async () => {
    const e = await setup();
    const bad = await e.call<{ error: string }>("POST", "/api/focus/prompt", {
      key: "has space",
      answer: "focus",
    });
    expect([bad.status, bad.body.error]).toEqual([400, "invalid_input"]);
    expect(e.logs.at(-1)).toEqual({
      event: "focus.rejected",
      fields: { path: "/api/focus/prompt", status: 400, error: "invalid_input" },
    });
    const none = await e.call<{ error: string }>("POST", "/api/focus/events/nope");
    expect(none.status).toBe(404);
    expect(e.logs.at(-1)).toMatchObject({
      event: "focus.rejected",
      fields: { status: 404, error: "not_found" },
    });
  });

  test("対象: 会議リンクの予定は聞き、参加者もリンクも無い予定は聞かない（予定ありのすべてなら聞く）", async () => {
    let e = await setup();
    e.at("11:56");
    expect(e.focus.view().prompt).toBeNull();
    e.at("16:56");
    expect(e.focus.view().prompt?.title).toBe("Standup");
    cal.stop();
    await env.cleanup();
    e = await setup({ settings: { target: "busy" } });
    e.at("11:56");
    expect(e.focus.view().prompt?.title).toBe("Dentist");
  });
});

describe("集中中の通知と、終わったときのまとめ", () => {
  test("集中中は止め、終わったら今も残っている分を1回だけ通知する", async () => {
    const e = await setup();
    e.at("14:56");
    await e.call("POST", "/api/focus/prompt", {
      key: e.focus.view().prompt?.key,
      answer: "focus",
    });
    e.st.items = [item("a", "needs_input", "f1"), item("b", "your_turn", "f2")];
    env.clock.set(jst("15:10"));
    e.runner.run();
    e.st.items = [...e.st.items, item("c", "error", "f3")];
    env.clock.set(jst("15:40"));
    e.runner.run();
    expect(e.notices().filter((n) => n.kind !== "focus_prompt")).toEqual([]);
    expect(e.focus.state.held.map((h) => h.workItemId).sort()).toEqual(["a", "b", "c"]);
    // 帯の `止めた通知 3`（GET /api/focus の held）
    expect((await e.call<FocusView>("GET", "/api/focus")).body.held).toBe(3);
    // b は会議中に片付いた
    e.st.items = e.st.items.filter((x) => x.workItemId !== "b");
    e.at("16:00");
    const sum = e.notices().filter((n) => n.kind === "focus_summary");
    expect(sum).toHaveLength(1);
    expect(sum[0]).toMatchObject({ title: "会議中に自分の番が 2 件（許可待ち 1）", sound: true });
    e.at("16:01");
    expect(e.notices().filter((n) => n.kind === "focus_summary")).toHaveLength(1);
    expect(e.focus.view().active).toBeNull();
    expect((await e.call<FocusView>("GET", "/api/focus")).body.held).toBe(0);
  });

  test("集中中も許可待ちは通知する（設定）: needs_input だけ即時", async () => {
    const e = await setup({ settings: { allowNeedsInput: true } });
    await e.call("POST", "/api/focus/start", { minutes: 30 });
    e.st.items = [item("a", "needs_input", "f1"), item("c", "error", "f3")];
    env.clock.advance(60_000);
    e.runner.run();
    expect(e.notices().map((n) => n.title)).toEqual(["task a"]);
  });

  test("15分より短い集中: 集中中に増えた your_turn（まとめ待ち）も終わりのまとめに入れ、通常のまとめには出さない", async () => {
    const e = await setup();
    // 14:50 に起動して1回判定している（まとめの起点）。14:52 から 15:02 まで集中
    env.clock.set(jst("14:52"));
    await e.call("POST", "/api/focus/start", { minutes: 30 });
    e.st.items = [item("a", "your_turn", "f1"), item("b", "your_turn", "f2")];
    env.clock.set(jst("14:53"));
    e.runner.run();
    // まとめの時刻（15:05）が来ていないので止めた分には入らない
    expect(e.focus.state.held).toEqual([]);
    // b は集中中に片付いた
    e.st.items = e.st.items.filter((x) => x.workItemId !== "b");
    env.clock.set(jst("15:02"));
    await e.call("POST", "/api/focus/end");
    const sum = e.notices().filter((n) => n.kind === "focus_summary");
    expect(sum).toHaveLength(1);
    expect(sum[0]).toMatchObject({ title: "集中モード中に自分の番が 1 件", sound: false });
    // 通常のまとめの時刻になっても、a は二重に出ない
    env.clock.set(jst("15:06"));
    e.runner.run();
    env.clock.set(jst("15:30"));
    e.runner.run();
    expect(e.notices().filter((n) => n.kind !== "focus_summary")).toEqual([]);
    // その後に新しく出たカードは通常のまとめで出る
    e.st.items = [...e.st.items, item("c", "your_turn", "f3")];
    env.clock.set(jst("15:31"));
    e.runner.run();
    env.clock.set(jst("15:46"));
    e.runner.run();
    expect(e.notices().filter((n) => n.kind !== "focus_summary")).toHaveLength(1);
  });
});

describe("集中の終わりの通知（2026-10-19: 必ず 1 通）", () => {
  test("0 件: 手動で終えたら `集中モードを終了しました` と実際に終えた時刻（鳴らさない・ボード）", async () => {
    const e = await setup();
    await e.call("POST", "/api/focus/start", { minutes: 30 });
    env.clock.set(jst("14:58"));
    await e.call("POST", "/api/focus/end");
    const sum = e.notices().filter((n) => n.kind === "focus_summary");
    expect(sum).toEqual([
      {
        id: "focus-summary",
        kind: "focus_summary",
        status: "focus",
        title: "集中モードを終了しました",
        body: "14:58 まで · 止めた通知はありません",
        path: "/board",
        sound: false,
      },
    ]);
    // 集中していないときの終了は何も出さない
    await e.call("POST", "/api/focus/end");
    expect(e.notices().filter((n) => n.kind === "focus_summary")).toHaveLength(1);
  });

  test("0 件: 会議の終わりで終わったら予定の題名（終わり方で題名を変えない）", async () => {
    const e = await setup();
    e.at("14:56");
    await e.call("POST", "/api/focus/prompt", { key: e.focus.view().prompt?.key, answer: "focus" });
    e.at("16:00");
    const sum = e.notices().filter((n) => n.kind === "focus_summary");
    expect(sum).toHaveLength(1);
    expect(sum[0]).toMatchObject({
      title: "集中モードを終了しました",
      body: "「Design review」の間 · 止めた通知はありません",
      sound: false,
    });
    e.at("16:01");
    expect(e.notices().filter((n) => n.kind === "focus_summary")).toHaveLength(1);
  });

  test("N 件: 件数の題名と各カードの件名（3 件まで＋ほか N 件）", async () => {
    const e = await setup();
    await e.call("POST", "/api/focus/start", { minutes: 30 });
    e.st.items = ["a", "b", "c", "d"].map((id, i) =>
      item(id, i === 0 ? "needs_input" : "error", `f${id}`),
    );
    env.clock.advance(60_000);
    e.runner.run();
    env.clock.advance(60_000);
    await e.call("POST", "/api/focus/end");
    const sum = e.notices().filter((n) => n.kind === "focus_summary");
    expect(sum).toEqual([
      {
        id: "focus-summary",
        kind: "focus_summary",
        status: "needs_input",
        title: "集中モード中に自分の番が 4 件（許可待ち 1）",
        body: "task a\ntask b\ntask c\nほか 1 件",
        path: "/queue",
        sound: true,
      },
    ]);
  });

  test("設定「集中の終わりを知らせる」がオフ: 0 件なら出さず、止めた分があれば今までどおり出す", async () => {
    const e = await setup({ settings: { notifyEnd: false } });
    await e.call("POST", "/api/focus/start", { minutes: 30 });
    env.clock.advance(60_000);
    await e.call("POST", "/api/focus/end");
    expect(e.notices().filter((n) => n.kind === "focus_summary")).toEqual([]);
    await e.call("POST", "/api/focus/start", { minutes: 30 });
    e.st.items = [item("a", "needs_input", "f1")];
    env.clock.advance(60_000);
    e.runner.run();
    await e.call("POST", "/api/focus/end");
    const sum = e.notices().filter((n) => n.kind === "focus_summary");
    expect(sum).toHaveLength(1);
    expect(sum[0]).toMatchObject({
      title: "集中モード中に自分の番が 1 件（許可待ち 1）",
      body: "task a",
    });
  });
});

describe("手動", () => {
  test("30分・1時間・次の予定の終わりまで・終了。予定が無ければ 409 no_event", async () => {
    const e = await setup();
    let r = await e.call<FocusView>("POST", "/api/focus/start", { minutes: 30 });
    expect(r.body.active).toMatchObject({ until: jst("15:20"), source: "manual" });
    r = await e.call<FocusView>("POST", "/api/focus/start", { until: "event_end" });
    expect(r.body.active?.until).toBe(jst("16:00"));
    expect((await e.call("POST", "/api/focus/start", { minutes: 45 })).status).toBe(400);
    // your_turn は15分ごとのまとめに乗った時点で止める
    e.st.items = [item("b", "your_turn", "f2")];
    env.clock.advance(60_000);
    e.runner.run();
    env.clock.advance(15 * 60_000);
    e.runner.run();
    r = await e.call<FocusView>("POST", "/api/focus/end");
    expect(r.body.active).toBeNull();
    expect(e.notices().map((n) => n.title)).toEqual(["集中モード中に自分の番が 1 件"]);
    env.clock.set(jst("19:00"));
    const none = await e.call<{ error: string }>("POST", "/api/focus/start", {
      until: "event_end",
    });
    expect([none.status, none.body.error]).toEqual([409, "no_event"]);
  });

  test("キューと件数に集中の表示（web の抑止とメニューバー）", async () => {
    const e = await setup();
    await e.call("POST", "/api/focus/start", { minutes: 60 });
    const q = await e.call<QueueResponse>("GET", "/api/queue");
    expect(q.body.focus).toEqual({ until: jst("15:50"), allowNeedsInput: false });
    const s = await e.call<QueueSummaryResponse>("GET", "/api/queue/summary");
    expect(s.body.focus).toEqual({ label: "集中モード中 · 15:50 まで" });
    expect(s.body.focusMenu?.event).toBe("次の予定の終わりまで");
    expect(s.body.focusEventAvailable).toBe(true);
    // ネイティブのメニューの文言も同じロケール（デスクトップは ja）
    expect(s.body.nativeMenu?.quit).toBe("Turnlane を終了");
    expect(s.body.nativeMenu?.view.three).toBe("3日");
  });

  test("状態は保存され、作り直しても続く（閉じた問いも）", async () => {
    const e = await setup();
    await e.call("POST", "/api/focus/start", { minutes: 30 });
    expect(e.make().view().active?.until).toBe(jst("15:20"));
    e.at("14:56");
    e.at("15:21");
    expect(e.focus.state.closed).not.toBeNull();
    expect(e.make().state.closed).toEqual(e.focus.state.closed);
  });
});

describe("この予定の間は集中する（D-130）", () => {
  const idOf = (title: string) =>
    env.sqlite
      .query<{ id: string }, [string]>("SELECT id FROM calendar_event WHERE title = ?")
      .get(title)?.id as string;

  test("API: 予約すると問いを出さず、開始で始まり終わりで終わる。再起動しても続く", async () => {
    const e = await setup();
    const id = idOf("Design review");
    const r = await e.call<FocusView>("POST", `/api/focus/events/${id}`);
    expect(r.status).toBe(200);
    expect(r.body.reserved).toEqual([{ eventId: id, start: jst("15:00"), end: jst("16:00") }]);
    expect(r.body.active).toBeNull();
    e.at("14:55");
    expect(e.focus.view().prompt).toBeNull();
    expect(e.notices()).toHaveLength(0);
    // 保存した状態から作り直す（デーモンの再起動）
    const again = e.make();
    expect(again.view().reserved?.[0]?.eventId).toBe(id);
    e.at("15:00");
    expect(e.focus.view().active).toMatchObject({ until: jst("16:00"), source: "meeting" });
    e.at("16:00");
    expect(e.focus.view().active).toBeNull();
    expect(e.focus.view().reserved).toEqual([]);
  });

  test("API: 進行中なら今から。取り消すと終わる。終わった予定は 409、無い予定は 404", async () => {
    const e = await setup();
    e.at("12:10");
    const id = idOf("Dentist");
    const r = await e.call<FocusView>("POST", `/api/focus/events/${id}`);
    expect(r.body.active).toMatchObject({
      since: jst("12:10"),
      until: jst("13:00"),
      source: "manual",
    });
    const c = await e.call<FocusView>("DELETE", `/api/focus/events/${id}`);
    expect(c.body.active).toBeNull();
    expect(c.body.reserved).toEqual([]);
    e.at("13:30");
    expect((await e.call<{ error: string }>("POST", `/api/focus/events/${id}`)).body).toEqual({
      error: "ended",
    });
    expect((await e.call("POST", "/api/focus/events/nope")).status).toBe(404);
  });

  test("予定が延びたら追い、予定が消えたら予約を外す", async () => {
    const e = await setup();
    const id = idOf("Standup");
    await e.call("POST", `/api/focus/events/${id}`);
    e.provider.events = e.provider.events.map((x) =>
      x.eventId === "standup" ? { ...x, end: jst("17:45") } : x,
    );
    await cal.deps.sync();
    e.at("17:00");
    expect(e.focus.view().active?.until).toBe(jst("17:45"));
    const id2 = idOf("Zoom call");
    await e.call("POST", `/api/focus/events/${id2}`);
    e.provider.events = e.provider.events.filter((x) => x.eventId !== "zoom");
    await cal.deps.sync();
    e.at("17:10");
    expect(e.focus.view().reserved?.map((x) => x.eventId)).toEqual([id]);
  });
});
