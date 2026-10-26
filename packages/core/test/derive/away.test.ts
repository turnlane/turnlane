import { describe, expect, test } from "bun:test";
import { wallToEpoch } from "../../src/dates.ts";
import {
  AWAY_SHOW_MS,
  type AwayEvent,
  awayGap,
  awayKey,
  composeAway,
} from "../../src/derive/index.ts";

const TZ = "Asia/Tokyo";
/** 2026-10-16 の "17:14"（day = -1 で前の日） */
const at = (hhmm: string, day = 0) => {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  return wallToEpoch(2026, 10, 16 + day, h * 60 + m, TZ);
};
const MIN = 60_000;

describe("awayGap", () => {
  test("10 分以上切れた後に戻って、今も在席なら、その離席", () => {
    const p: [number, number][] = [
      [at("09:00"), at("17:14")],
      [at("17:48"), at("17:50")],
    ];
    expect(awayGap(p, at("17:50"))).toEqual({ from: at("17:14"), to: at("17:48") });
  });

  test("10 分未満の間は離席にしない（前の離席を置き換えない）", () => {
    const p: [number, number][] = [
      [at("09:00"), at("17:14")],
      [at("17:48"), at("18:00")],
      [at("18:08"), at("18:10")],
    ];
    expect(awayGap(p, at("18:10"))).toEqual({ from: at("17:14"), to: at("17:48") });
    // ちょうど 10 分は離席
    const q: [number, number][] = [
      [at("09:00"), at("17:14")],
      [at("17:24"), at("17:30")],
    ];
    expect(awayGap(q, at("17:30"))).toEqual({ from: at("17:14"), to: at("17:24") });
  });

  test("新しい離席が前の離席を置き換える", () => {
    const p: [number, number][] = [
      [at("09:00"), at("12:00")],
      [at("13:00"), at("17:14")],
      [at("17:48"), at("17:50")],
    ];
    expect(awayGap(p, at("17:50"))?.to).toBe(at("17:48"));
  });

  test("夜をまたいだ離席（昨日の最後の在席から今朝の最初の在席まで）", () => {
    const p: [number, number][] = [
      [at("09:00", -1), at("19:02", -1)],
      [at("08:35"), at("08:40")],
    ];
    expect(awayGap(p, at("08:40"))).toEqual({ from: at("19:02", -1), to: at("08:35") });
  });

  test("今が在席でなければ（離席の途中）出さない。前の在席が無ければ「いつから」が言えないので出さない", () => {
    const p: [number, number][] = [
      [at("09:00"), at("17:14")],
      [at("17:48"), at("17:50")],
    ];
    expect(awayGap(p, at("18:30"))).toBeNull();
    // 最後の区間の終わりからサンプルの間（2 分）未満は在席のうち
    expect(awayGap(p, at("17:50") + MIN)).not.toBeNull();
    expect(awayGap([[at("08:35"), at("08:40")]], at("08:40"))).toBeNull();
    expect(awayGap([], at("08:40"))).toBeNull();
  });
});

describe("composeAway", () => {
  const gap = { from: at("17:14"), to: at("17:48") };
  const ev = (
    workItemId: string,
    kind: AwayEvent["kind"],
    hhmm: string,
    extra: Partial<AwayEvent> = {},
  ): AwayEvent => ({ workItemId, kind, at: at(hhmm), ...extra });

  test("完了 1 · PR 1 · 新しい待ち 1（1 件に 1 つ、時刻の順）", () => {
    const c = composeAway(
      gap,
      [
        ev("log", "done", "17:22"),
        ev("width", "done", "17:30"),
        ev("width", "pr_opened", "17:31", { prNumber: 190, prRef: "o/r#190" }),
        ev("tz", "question", "17:41", { followUpId: "f1" }),
      ],
      { now: at("17:50") },
    );
    expect(c?.counts).toEqual({ done: 1, pr: 1, wait: 1, error: 0 });
    expect(c?.items.map((x) => [x.workItemId, x.kind])).toEqual([
      ["log", "done"],
      ["width", "pr_opened"],
      ["tz", "question"],
    ]);
    expect(c?.key).toBe(awayKey(gap));
    expect(c?.until).toBe(at("17:48") + AWAY_SHOW_MS);
  });

  test("代表は 待ち > エラー > PR > 完了（同じ強さなら新しい方）", () => {
    const c = composeAway(
      gap,
      [
        ev("a", "done", "17:20"),
        ev("a", "error", "17:25"),
        ev("a", "permission", "17:21", { followUpId: "f" }),
        ev("b", "pr_opened", "17:20"),
        ev("b", "pr_merged", "17:40"),
        ev("c", "error", "17:30"),
        ev("c", "done", "17:35"),
      ],
      { now: at("17:50") },
    );
    expect(c?.items.map((x) => [x.workItemId, x.kind])).toEqual([
      ["a", "permission"],
      ["c", "error"],
      ["b", "pr_merged"],
    ]);
    expect(c?.counts).toEqual({ done: 0, pr: 1, wait: 1, error: 1 });
  });

  test("離席の区間の外の変化は数えない。変化が無ければ出さない", () => {
    expect(
      composeAway(gap, [ev("a", "done", "17:10"), ev("b", "done", "17:48")], { now: at("17:50") }),
    ).toBeNull();
    expect(composeAway(gap, [], { now: at("17:50") })).toBeNull();
    expect(composeAway(null, [ev("a", "done", "17:20")], { now: at("17:50") })).toBeNull();
  });

  test("戻ってから 30 分で消える", () => {
    const e = [ev("a", "done", "17:20")];
    expect(composeAway(gap, e, { now: at("18:17") })).not.toBeNull();
    expect(composeAway(gap, e, { now: at("18:18") })).toBeNull();
  });

  test("閉じた印が同じなら出さない。新しい離席は印が変わるので出る（置き換え）", () => {
    const e = [ev("a", "done", "17:20"), ev("b", "done", "18:30")];
    expect(composeAway(gap, e, { now: at("17:50"), dismissedKey: awayKey(gap) })).toBeNull();
    const next = { from: at("18:05"), to: at("18:40") };
    const c = composeAway(next, e, { now: at("18:41"), dismissedKey: awayKey(gap) });
    expect(c?.items.map((x) => x.workItemId)).toEqual(["b"]);
  });

  test("並んだ件のどれかを戻った後に開いたら消える", () => {
    const e = [ev("a", "done", "17:20"), ev("b", "question", "17:41", { followUpId: "f" })];
    const opened = new Set(["b"]);
    expect(
      composeAway(gap, e, {
        now: at("17:55"),
        openedSince: (id, since) => since === gap.to && opened.has(id),
      }),
    ).toBeNull();
    expect(composeAway(gap, e, { now: at("17:55"), openedSince: () => false })).not.toBeNull();
  });

  test("夜をまたいだ離席: 昨日の 19:02 から今朝までの変化を数える", () => {
    const night = { from: at("19:02", -1), to: at("08:35") };
    const c = composeAway(
      night,
      [
        { workItemId: "a", kind: "done", at: at("21:00", -1) },
        { workItemId: "b", kind: "done", at: at("02:10") },
        { workItemId: "c", kind: "done", at: at("05:40") },
        { workItemId: "d", kind: "question", at: at("23:10", -1), followUpId: "f1" },
        { workItemId: "e", kind: "permission", at: at("03:00"), followUpId: "f2" },
        { workItemId: "z", kind: "done", at: at("18:00", -1) },
      ],
      { now: at("08:40") },
    );
    expect(c?.counts).toEqual({ done: 3, pr: 0, wait: 2, error: 0 });
  });
});
