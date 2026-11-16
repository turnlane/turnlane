/**
 * 図つきの問いのメモリの置き場（ADR 0022）: 開く → 返す・閉じる・取り消す、受け取られなかった答え・古い控えの片付け。
 * 偽の時計で確かめる
 */
import { describe, expect, test } from "bun:test";
import { FakeClock } from "@turnlane/core";
import type { AskCreateInput } from "@turnlane/core/api";
import { ABANDON_MS, AskStore, RESULT_KEEP_MS, TOMBSTONE_MS } from "../src/ask/store.ts";

const input: AskCreateInput = {
  question: "Which one?",
  options: [
    { label: "A", description: "first" },
    { label: "B", description: "second" },
  ],
};
const at = { workItemId: "wi1", turnId: "t1" };

function make() {
  const clock = new FakeClock(Date.UTC(2026, 10, 16, 1, 0));
  return { clock, store: new AskStore(() => clock.now()) };
}

describe("AskStore", () => {
  test("返した答えは MCP のプロセスが受け取るまで開いている扱い。受け取った時刻で閉じ、中身と答えを捨てる", async () => {
    const { clock, store } = make();
    store.open("a1", input, at);
    clock.set(clock.now() + 1000);
    store.answer("a1", { choice: "B" });
    const r = store.get("a1");
    expect(r?.content).toBeNull();
    expect(store.isLive(r as NonNullable<typeof r>)).toBe(true);
    clock.set(clock.now() + 500);
    expect(await store.result("a1", 0)).toEqual({ state: "answered", choice: "B" });
    expect(store.get("a1")).toMatchObject({ result: null, closedAt: clock.now() });
    expect(store.live()).toEqual([]);
  });

  test("long-poll は閉じたらすぐ返る。開いたままなら wait の後に open", async () => {
    const { store } = make();
    store.open("a1", input, at);
    expect(await store.result("a1", 10)).toEqual({ state: "open" });
    const p = store.result("a1", 5000);
    store.close("a1", "dismissed");
    expect(await p).toEqual({ state: "dismissed" });
    expect(await store.result("nope", 0)).toBeNull();
  });

  test("片付け: 待ちに来ない問いは取り消し、受け取られない答えは捨て、古い控えは消す", () => {
    const { clock, store } = make();
    store.open("gone", input, at);
    store.open("late", input, at);
    store.answer("late", { note: "n" });
    clock.set(clock.now() + Math.max(ABANDON_MS, RESULT_KEEP_MS));
    store.sweep();
    expect(store.get("gone")?.state).toBe("cancelled");
    expect(store.get("late")).toMatchObject({ state: "answered", result: null });
    expect(store.get("late")?.closedAt).not.toBeNull();
    clock.set(clock.now() + TOMBSTONE_MS);
    store.sweep();
    expect(store.get("gone")).toBeNull();
    expect(store.get("late")).toBeNull();
  });

  test("同時に開ける数には上限がある", () => {
    const { store } = make();
    for (let i = 0; i < 20; i++) store.open(`a${i}`, input, at);
    expect(() => store.open("one-more", input, at)).toThrow("too_many_asks");
    store.close("a0", "cancelled");
    expect(() => store.open("one-more", input, at)).not.toThrow();
  });

  test("閉じた問いの画面の形は状態と時刻だけ（中身なし）", () => {
    const { clock, store } = make();
    store.open("a1", input, at);
    expect(store.view("a1")?.question).toBe("Which one?");
    clock.set(clock.now() + 60_000);
    store.close("a1", "cancelled");
    expect(store.view("a1")).toEqual({
      id: "a1",
      workItemId: "wi1",
      state: "cancelled",
      createdAt: clock.now() - 60_000,
      closedAt: clock.now(),
    });
  });
});
