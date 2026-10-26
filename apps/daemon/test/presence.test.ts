/**
 * 在席の記録（D-105・D-110・D-139、ADR 0013）。サンプルの読み方（ioreg の出力の解釈）と、サンプルから presence_span を作る流れ。
 * 実機の入力の状態は読まない（偽の reader を使う）。ioreg の出力は形だけを真似た合成のもの
 */
import { afterEach, describe, expect, test } from "bun:test";
import { nullLogger } from "@turnlane/collectors";
import { getSetting } from "@turnlane/core";
import { type PresenceReading, parseConsoleState, parseHidIdleMs } from "../src/presence/reader.ts";
import { lastPresentBefore, PresenceService, presenceIn } from "../src/presence/service.ts";
import { type AiEnv, makeAiEnv } from "./helpers/env.ts";

const T0 = Date.UTC(2026, 8, 14, 1, 0);
const S = 1000;
const MIN = 60 * S;

describe("ioreg の出力の解釈", () => {
  test("HIDIdleTime（ns）を ms にする。無ければ null", () => {
    const out = '    | |   "HIDIdleTime" = 246599375\n    | |   "Other" = 1\n';
    expect(parseHidIdleMs(out)).toBe(246);
    expect(parseHidIdleMs("nothing")).toBeNull();
  });

  test("IOConsoleUsers から自分の uid のロック・コンソールの状態を読む", () => {
    const line = (dicts: string[]) => `  "IOConsoleUsers" = (${dicts.join(",")})\n`;
    const me = (extra: string) =>
      `{"kCGSSessionOnConsoleKey"=Yes,"kCGSSessionUserIDKey"=501,"kCGSessionLoginDoneKey"=Yes${extra}}`;
    expect(parseConsoleState(line([me("")]), 501)).toEqual({ locked: false, offConsole: false });
    expect(parseConsoleState(line([me(',"CGSSessionScreenIsLocked"=Yes')]), 501)).toEqual({
      locked: true,
      offConsole: false,
    });
    const switched =
      '{"kCGSSessionOnConsoleKey"=No,"kCGSSessionUserIDKey"=501},{"kCGSSessionOnConsoleKey"=Yes,"kCGSSessionUserIDKey"=502}';
    expect(parseConsoleState(line([switched]), 501)).toEqual({ locked: false, offConsole: true });
    // 読めなければ在席を落とさない
    expect(parseConsoleState("", 501)).toEqual({ locked: false, offConsole: false });
  });
});

let env: AiEnv;
afterEach(async () => {
  await env?.cleanup();
});

class FakeReader {
  next: PresenceReading = { idleMs: 0, locked: false, offConsole: false };
  method = () => "ffi" as const;
  async read() {
    return this.next;
  }
}

function service(reader: FakeReader, onResumed?: () => void) {
  return new PresenceService({
    sqlite: env.sqlite,
    mutate: env.mutate,
    clock: env.clock,
    logger: nullLogger,
    reader,
    intervalMs: 3_600_000,
    ...(onResumed ? { onResumed } : {}),
  });
}

const rows = () =>
  env.sqlite
    .query<{ start_at: number; end_at: number; seen_until: number | null }, []>(
      "SELECT start_at, end_at, seen_until FROM presence_span ORDER BY start_at",
    )
    .all()
    .map((r) => [r.start_at - T0, r.end_at - T0, r.seen_until === null ? null : r.seen_until - T0]);

const spans = (tailMin: number) =>
  presenceIn(env.sqlite, T0 - 60 * MIN, T0 + 60 * MIN, tailMin * MIN).map(([s, e]) => [
    s - T0,
    e - T0,
  ]);

describe("PresenceService", () => {
  test("起動時に idle.presence_since を入れ、入力のあった区間を残す（T は足さない。D-139）。離れたら新しい区間。ロック中は足さない", async () => {
    env = makeAiEnv({ now: T0 });
    const reader = new FakeReader();
    let resumed = 0;
    const svc = service(reader, () => resumed++);
    svc.start();
    svc.stop();
    expect(getSetting<number>(env.mutate.db, "idle.presence_since")).toBe(T0);
    await svc.sample();
    // 最初のサンプル（入力 0 秒前）: 入力の時刻だけの区間。在席の長さはまだ 0
    expect(rows()).toEqual([[0, 0, 0]]);
    expect(spans(5)).toEqual([]);
    env.clock.set(T0 + 30 * S);
    reader.next = { idleMs: 10 * S, locked: false, offConsole: false };
    await svc.sample();
    expect(rows()).toEqual([[0, 20 * S, 30 * S]]);
    expect(spans(5)).toEqual([[0, 30 * S]]);
    env.clock.set(T0 + 60 * S);
    reader.next = { idleMs: 5 * S, locked: false, offConsole: false };
    await svc.sample();
    expect(rows()).toEqual([[0, 55 * S, 60 * S]]);
    // 入力から 35 秒・ロック中
    env.clock.set(T0 + 90 * S);
    reader.next = { idleMs: 35 * S, locked: false, offConsole: false };
    await svc.sample();
    env.clock.set(T0 + 120 * S);
    reader.next = { idleMs: 65 * S, locked: true, offConsole: false };
    await svc.sample();
    expect(rows()).toEqual([[0, 55 * S, 90 * S]]);
    expect(spans(5)).toEqual([[0, 90 * S]]);
    // 戻ってきた（前のサンプルから 8 分）
    env.clock.set(T0 + 10 * MIN);
    reader.next = { idleMs: 2 * S, locked: false, offConsole: false };
    await svc.sample();
    expect(rows()).toEqual([
      [0, 55 * S, 90 * S],
      [10 * MIN - 2 * S, 10 * MIN - 2 * S, 10 * MIN],
    ]);
    expect(spans(5)).toEqual([
      [0, 90 * S],
      [10 * MIN - 2 * S, 10 * MIN],
    ]);
    expect(resumed).toBe(2);
  });

  test("「使っていた」とみなす長さは読むときに今の設定で足す。設定を変えると過去の区間も同じ規則で数え直す（D-139）", async () => {
    env = makeAiEnv({ now: T0 });
    const reader = new FakeReader();
    const svc = service(reader);
    // 0:00〜0:01 に入力、そのあと 20 分サンプルだけ続く
    for (let t = 0; t <= 20 * MIN; t += 30 * S) {
      env.clock.set(T0 + t);
      reader.next = { idleMs: t - Math.min(t, 1 * MIN), locked: false, offConsole: false };
      await svc.sample();
    }
    expect(rows()).toEqual([[0, 1 * MIN, 20 * MIN]]);
    expect(spans(5)).toEqual([[0, 6 * MIN]]);
    expect(spans(2)).toEqual([[0, 3 * MIN]]);
    expect(spans(15)).toEqual([[0, 16 * MIN]]);
    expect(lastPresentBefore(env.sqlite, T0 + 60 * MIN, 5 * MIN)).toBe(T0 + 6 * MIN);
    expect(lastPresentBefore(env.sqlite, T0 + 4 * MIN, 5 * MIN)).toBe(T0 + 4 * MIN);
    expect(lastPresentBefore(env.sqlite, T0, 5 * MIN)).toBeNull();
  });

  test("デーモンを再起動しても、2 分以内なら前回の最後の区間の続きとして扱う（D-139 (3)）", async () => {
    env = makeAiEnv({ now: T0 });
    const reader = new FakeReader();
    const a = service(reader);
    reader.next = { idleMs: 5 * S, locked: false, offConsole: false };
    await a.sample();
    env.clock.set(T0 + 30 * S);
    reader.next = { idleMs: 35 * S, locked: false, offConsole: false };
    await a.sample();
    // 0:30 で止まり、1:40 に起動。最初のサンプルは入力 1 分 45 秒前（起動の前の入力）
    env.clock.set(T0 + 100 * S);
    reader.next = { idleMs: 105 * S, locked: false, offConsole: false };
    await service(reader).sample();
    expect(rows()).toEqual([[-5 * S, -5 * S, 100 * S]]);
    expect(spans(5)).toEqual([[-5 * S, 100 * S]]);
    // 止まっていたのが 2 分以上なら引き継がない（その間は不在）
    env.clock.set(T0 + 10 * MIN);
    reader.next = { idleMs: 10 * MIN, locked: false, offConsole: false };
    await service(reader).sample();
    expect(rows()).toEqual([[-5 * S, -5 * S, 100 * S]]);
  });
});
