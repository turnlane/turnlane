import { describe, expect, test } from "bun:test";
import type { QueueItem } from "@turnlane/core/api";
import { BATCH_MS } from "@turnlane/core/web";
import { SseHub, type SseMessage } from "../src/http/sse.ts";
import { NotifyRunner, notifyLocale } from "../src/notify/runner.ts";

const T0 = Date.parse("2026-10-05T10:00:00+09:00");

function item(id: string, status: QueueItem["status"], fu: string): QueueItem {
  return {
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
  };
}

function setup(o: { lang?: string } = {}) {
  const hub = new SseHub({ bundleMs: 0 });
  const st = { now: T0, items: [] as QueueItem[] };
  const sent: SseMessage[] = [];
  hub.subscribe((m) => {
    if (m.type === "notify") sent.push(m);
  });
  const runner = new NotifyRunner({
    queue: () => ({ items: st.items }),
    locale: () => notifyLocale("system", o.lang ?? null),
    now: () => st.now,
    publish: (type, data) => hub.publish(type, data),
    subscribe: (l) => hub.subscribe(l),
    intervalMs: 3_600_000,
  });
  const titles = () =>
    sent.flatMap((m) => (m.data.notices as { title: string }[]).map((n) => n.title));
  return { hub, st, runner, sent, titles };
}

describe("NotifyRunner（desktop-shell.md 3.1）", () => {
  test("起動直後の1回目は出さない。その後に増えた needs_input は即時、your_turn は15分まとめ", () => {
    const e = setup();
    e.st.items = [item("old", "needs_input", "f0")];
    e.runner.run();
    expect(e.sent).toEqual([]);
    e.st.items = [item("old", "needs_input", "f0"), item("a", "needs_input", "f1")];
    e.st.now += 1000;
    e.runner.run();
    expect(e.titles()).toEqual(["task a"]);
    e.st.items = [...e.st.items, item("b", "your_turn", "f2")];
    e.st.now += 1000;
    e.runner.run();
    expect(e.titles()).toHaveLength(1);
    e.st.now = T0 + BATCH_MS;
    e.runner.run();
    expect(e.titles()).toEqual(["task a", "1 item is waiting on you"]);
  });

  test("時間に置いた自分の番（scheduled）は通知しない。開始が来て open になったら即時に 1 回出し、follow_up を流す", () => {
    const e = setup();
    const changed: SseMessage[] = [];
    e.hub.subscribe((m) => {
      if (m.type === "follow_up") changed.push(m);
    });
    const start = T0 + 60_000;
    const base = item("s", "needs_input", "fs");
    const scheduled: QueueItem = {
      ...base,
      followUps: base.followUps.map((f) => ({
        ...f,
        status: "scheduled" as const,
        scheduledAt: start,
      })),
    };
    e.runner.run();
    e.st.items = [scheduled];
    e.st.now += 1000;
    e.runner.run();
    expect(e.sent).toEqual([]);
    e.st.items = [base];
    e.st.now = start + 20_000;
    e.runner.run();
    expect(e.titles()).toEqual(["task s"]);
    expect(changed.map((m) => m.data.ids)).toEqual([["fs"]]);
    e.st.now += 60_000;
    e.runner.run();
    expect(e.titles()).toEqual(["task s"]);
    expect(changed).toHaveLength(1);
  });

  test("takePending: まとめ待ちの your_turn を取り出して空にし、通常のまとめから外す（集中の終わりのまとめに使う）", () => {
    const e = setup();
    e.runner.run();
    e.st.items = [item("a", "your_turn", "f1"), item("b", "your_turn", "f2")];
    e.st.now += 1000;
    e.runner.run();
    expect(e.runner.takePending().sort()).toEqual(["a", "b"]);
    expect(e.runner.takePending()).toEqual([]);
    e.st.now = T0 + BATCH_MS;
    e.runner.run();
    expect(e.titles()).toEqual([]);
    // 取り出した後に新しく出たカードは、次のまとめで出る
    e.st.items = [...e.st.items, item("c", "your_turn", "f3")];
    e.st.now += 1000;
    e.runner.run();
    e.st.now = T0 + 2 * BATCH_MS;
    e.runner.run();
    expect(e.titles()).toEqual(["1 item is waiting on you"]);
  });

  test("キューの SSE（follow_up）を受けて判定し、デスクトップの言語で文言を作る", async () => {
    const e = setup({ lang: "ja-JP" });
    e.runner.start();
    e.st.items = [item("a", "needs_input", "f1")];
    e.hub.publish("follow_up", { ids: ["f1"] });
    await Bun.sleep(5);
    e.runner.stop();
    expect(e.titles()).toEqual(["task a"]);
    const n = (e.sent[0]?.data.notices as { path: string; sound: boolean }[] | undefined)?.[0];
    expect(n).toMatchObject({ path: "/queue?item=a&open=f1", sound: true });
  });

  test("言語: 設定が en / ja ならそれ、system ならアプリが渡した macOS の言語", () => {
    expect(notifyLocale("ja", "en-US")).toBe("ja");
    expect(notifyLocale("system", "ja-JP")).toBe("ja");
    expect(notifyLocale("system", null)).toBe("en");
  });
});
