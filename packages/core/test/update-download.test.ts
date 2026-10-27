/** 自動更新の状態と遷移（ADR 0008 の追記 4）: 失敗 3 回で手動のみ、版が変われば数え直す、起動時の読み直し、画面の段階 */
import { describe, expect, test } from "bun:test";
import { validateConfig } from "../src/config.ts";
import {
  downloadGaveUp,
  downloadOnStart,
  idleDownload,
  nextDownload,
  readUpdateDownload,
  shouldStartDownload,
  UPDATE_DOWNLOAD_MAX_ATTEMPTS,
  type UpdateDownload,
  updatePhase,
} from "../src/update-download.ts";

const T = 1_800_000_000_000;

/** 同じ版で取得 → 失敗を n 回 */
function failTimes(n: number, version = "0.7.2", start: UpdateDownload | null = null) {
  let d = start;
  for (let i = 0; i < n; i++) {
    d = nextDownload(d, { type: "start", version }, T + i);
    d = nextDownload(d, { type: "verifying" }, T + i);
    d = nextDownload(d, { type: "failed", error: "team_id" }, T + i);
  }
  return d as UpdateDownload;
}

describe("遷移", () => {
  test("取得 → 検証 → ready → installing → installed", () => {
    let d = nextDownload(null, { type: "start", version: "0.7.2" }, T);
    expect(d).toEqual({
      state: "downloading",
      version: "0.7.2",
      path: null,
      error: null,
      attempts: 0,
      at: T,
    });
    d = nextDownload(d, { type: "verifying" }, T + 1);
    expect(d.state).toBe("verifying");
    d = nextDownload(d, { type: "ready", path: "/x/Turnlane.app" }, T + 2);
    expect(d).toMatchObject({ state: "ready", path: "/x/Turnlane.app", at: T + 2 });
    d = nextDownload(d, { type: "installing" }, T + 3);
    expect(d).toMatchObject({ state: "installing", path: "/x/Turnlane.app" });
    d = nextDownload(d, { type: "installed" }, T + 4);
    expect(d).toMatchObject({ state: "installed", path: null, version: "0.7.2" });
  });

  test("失敗は回数を増やし、場所を消す。同じ版の start は回数を保つ", () => {
    const d = failTimes(2);
    expect(d).toMatchObject({ state: "failed", error: "team_id", attempts: 2, path: null });
    const again = nextDownload(d, { type: "start", version: "0.7.2" }, T + 10);
    expect(again).toMatchObject({ state: "downloading", attempts: 2, error: null });
  });

  test("同じ版で 3 回失敗したら手動の案内だけ（check でも始めない）", () => {
    const d = failTimes(UPDATE_DOWNLOAD_MAX_ATTEMPTS);
    expect(d.attempts).toBe(3);
    expect(downloadGaveUp(d, "0.7.2")).toBe(true);
    expect(shouldStartDownload(d, "0.7.2", "0.7.1", "check")).toBe(false);
    expect(updatePhase({ available: true, latest: { version: "0.7.2" }, download: d })).toEqual({
      kind: "failed",
      version: "0.7.2",
      reason: "verify",
    });
    // 2 回までは次の確認でやり直す
    expect(shouldStartDownload(failTimes(2), "0.7.2", "0.7.1", "check")).toBe(true);
  });

  test("版が変われば数え直す", () => {
    const d = failTimes(3);
    expect(downloadGaveUp(d, "0.7.3")).toBe(false);
    expect(shouldStartDownload(d, "0.7.3", "0.7.1", "check")).toBe(true);
    const next = nextDownload(d, { type: "start", version: "0.7.3" }, T + 100);
    expect(next).toMatchObject({ version: "0.7.3", attempts: 0, state: "downloading" });
  });
});

describe("始めるか（shouldStartDownload）", () => {
  test("新しい版でなければ始めない", () => {
    expect(shouldStartDownload(null, "0.7.1", "0.7.1", "check")).toBe(false);
    expect(shouldStartDownload(null, "0.7.0", "0.7.1", "check")).toBe(false);
    expect(shouldStartDownload(null, "0.7.2", "0.7.1", "check")).toBe(true);
  });

  test("取得中・ready・入れ替え中・入れ終わりは始めない。失敗は起動時には始めない（次の確認まで待つ）", () => {
    const base = nextDownload(null, { type: "start", version: "0.7.2" }, T);
    expect(shouldStartDownload(base, "0.7.2", "0.7.1", "check")).toBe(false);
    const ready = nextDownload(base, { type: "ready", path: "/p" }, T);
    expect(shouldStartDownload(ready, "0.7.2", "0.7.1", "check")).toBe(false);
    expect(
      shouldStartDownload(
        nextDownload(ready, { type: "installing" }, T),
        "0.7.2",
        "0.7.1",
        "start",
      ),
    ).toBe(false);
    expect(
      shouldStartDownload(nextDownload(ready, { type: "installed" }, T), "0.7.2", "0.7.1", "check"),
    ).toBe(false);
    const failed = failTimes(1);
    expect(shouldStartDownload(failed, "0.7.2", "0.7.1", "start")).toBe(false);
    expect(shouldStartDownload(failed, "0.7.2", "0.7.1", "check")).toBe(true);
    // 途中で終わった（起動時に idle に戻した）ものは起動時に続ける
    expect(
      shouldStartDownload(
        downloadOnStart(base, "0.7.1", T, () => true),
        "0.7.2",
        "0.7.1",
        "start",
      ),
    ).toBe(true);
  });
});

describe("起動時の読み直し（downloadOnStart）", () => {
  const ready = nextDownload(
    nextDownload(null, { type: "start", version: "0.7.2" }, T),
    { type: "ready", path: "/u/Turnlane.app" },
    T,
  );

  test("入れ替えが済んだ（対象の版が今の版以下）なら idle", () => {
    const done = nextDownload(ready, { type: "installed" }, T);
    expect(downloadOnStart(done, "0.7.2", T + 1, () => true)).toEqual(idleDownload(T + 1));
    expect(downloadOnStart(failTimes(3), "0.7.3", T + 1, () => true).state).toBe("idle");
    expect(downloadOnStart(null, "0.7.1", T + 1, () => true)).toEqual(idleDownload(T + 1));
  });

  test("途中で終わったものは同じ版の idle（回数は保つ）", () => {
    const mid = nextDownload(failTimes(1), { type: "start", version: "0.7.2" }, T);
    expect(downloadOnStart(mid, "0.7.1", T + 1, () => true)).toMatchObject({
      state: "idle",
      version: "0.7.2",
      attempts: 1,
    });
    const installing = nextDownload(ready, { type: "installing" }, T);
    expect(downloadOnStart(installing, "0.7.1", T + 1, () => true).state).toBe("idle");
  });

  test("ready は展開済みの場所があれば保ち、無ければ idle", () => {
    expect(downloadOnStart(ready, "0.7.1", T + 1, () => true)).toBe(ready);
    expect(downloadOnStart(ready, "0.7.1", T + 1, () => false)).toMatchObject({
      state: "idle",
      path: null,
      version: "0.7.2",
    });
  });
});

describe("保存した値の読み取り", () => {
  test("壊れた値は null。知らない理由は null に、負の回数は 0 に", () => {
    expect(readUpdateDownload(null)).toBeNull();
    expect(readUpdateDownload({ state: "nope", at: 1 })).toBeNull();
    expect(readUpdateDownload({ state: "ready" })).toBeNull();
    expect(readUpdateDownload({ state: "failed", at: 1, error: "x", attempts: -1 })).toEqual({
      state: "failed",
      version: null,
      path: null,
      error: null,
      attempts: 0,
      at: 1,
    });
    const d = failTimes(2);
    expect(readUpdateDownload(JSON.parse(JSON.stringify(d)))).toEqual(d);
  });
});

describe("画面の段階（updatePhase）", () => {
  const latest = { version: "0.7.2" };
  const at = (d: UpdateDownload | null, o: { downloadEnabled?: boolean } = {}) =>
    updatePhase({ available: true, latest, download: d, ...o });
  const start = nextDownload(null, { type: "start", version: "0.7.2" }, T);

  test("新しい版が無ければ null", () => {
    expect(updatePhase({ available: false, latest, download: start })).toBeNull();
    expect(updatePhase({ available: true, latest: null })).toBeNull();
  });

  test("download がオフ・状態が無い・別の版なら手動の案内", () => {
    expect(at(start, { downloadEnabled: false })).toEqual({ kind: "manual", version: "0.7.2" });
    expect(at(null)).toEqual({ kind: "manual", version: "0.7.2" });
    expect(at(idleDownload(T))).toEqual({ kind: "manual", version: "0.7.2" });
    expect(at(nextDownload(null, { type: "start", version: "0.7.1" }, T))?.kind).toBe("manual");
    // 古いデーモン（download が無い）
    expect(updatePhase({ available: true, latest })).toEqual({ kind: "manual", version: "0.7.2" });
  });

  test("状態ごとの段階", () => {
    expect(at(start)?.kind).toBe("downloading");
    expect(at(nextDownload(start, { type: "verifying" }, T))?.kind).toBe("downloading");
    const ready = nextDownload(start, { type: "ready", path: "/p" }, T);
    expect(at(ready)?.kind).toBe("ready");
    expect(at(nextDownload(ready, { type: "installing" }, T))?.kind).toBe("installing");
    expect(at(nextDownload(ready, { type: "installed" }, T))?.kind).toBe("installing");
    expect(at(nextDownload(ready, { type: "failed", error: "not_writable" }, T))).toEqual({
      kind: "failed",
      version: "0.7.2",
      reason: "install",
    });
    expect(at(nextDownload(start, { type: "failed", error: "sha256" }, T))).toMatchObject({
      reason: "verify",
    });
  });
});

describe("設定 update.download", () => {
  test("boolean だけ", () => {
    expect(validateConfig("update.download", false)).toEqual({ ok: true, value: false });
    expect(validateConfig("update.download", "no").ok).toBe(false);
  });
});
