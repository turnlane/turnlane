import { describe, expect, test } from "bun:test";
import {
  applyOnboardingConsent,
  applyOnboardingStep,
  compareVersions,
  existingUserOnboarding,
  initialOnboarding,
  parseLatest,
  readOnboarding,
  resolveUpdateFeed,
  restartOnboarding,
} from "../src/index.ts";

describe("オンボーディングの状態（onboarding.md 5.1、M6-18）", () => {
  test("新しい DB は pending・同意なし。既存の利用者は done・同意の時刻あり", () => {
    expect(initialOnboarding()).toMatchObject({
      state: "pending",
      step: "sources",
      consentedAt: null,
    });
    const e = existingUserOnboarding(123);
    expect(e).toMatchObject({ state: "done", consentedAt: 123 });
    expect(Object.values(e.steps).every((s) => s === "done")).toBe(true);
  });

  test("読み出しは壊れた値を既定に寄せる。同意の時刻の無い consented は pending に戻す", () => {
    expect(readOnboarding(undefined)).toBeNull();
    expect(readOnboarding("x")).toBeNull();
    const r = readOnboarding({ state: "consented", step: "nope", steps: { hooks: "done", x: 1 } });
    expect(r).toMatchObject({ state: "pending", step: "sources", consentedAt: null });
    expect(r?.steps.hooks).toBe("done");
    expect(r?.steps.calendar).toBe("pending");
    // Not now のまま流れを終えた（done・同意なし）はそのまま
    expect(readOnboarding({ state: "done", consentedAt: null })?.state).toBe("done");
  });

  test("同意 → 段を進める → start の done で済む。pending は戻る", () => {
    let o = applyOnboardingConsent(initialOnboarding(), 1000, 400);
    expect(o).toMatchObject({
      state: "consented",
      consentedAt: 1000,
      importSince: 400,
      step: "import",
    });
    expect(o.steps.sources).toBe("done");
    o = applyOnboardingStep(o, "import", "done");
    o = applyOnboardingStep(o, "calendar", "skipped");
    expect(o.step).toBe("hooks");
    o = applyOnboardingStep(o, "calendar", "pending");
    expect(o.step).toBe("calendar");
    o = applyOnboardingStep(o, "start", "done");
    expect(o.state).toBe("done");
    // もう一度同意しても時刻と取り込む範囲は保つ（D-181）
    expect(applyOnboardingConsent(o, 5000, 4000)).toMatchObject({
      consentedAt: 1000,
      importSince: 400,
    });
    // 既存の利用者（範囲の制限なし）は、同意し直しても制限なしのまま
    expect(applyOnboardingConsent(existingUserOnboarding(10), 5000, 4000).importSince).toBeNull();
    expect(readOnboarding({ state: "done", consentedAt: 1, importSince: 7 })?.importSince).toBe(7);
    expect(readOnboarding({ state: "done", consentedAt: 1 })?.importSince).toBeNull();
  });

  test("Run setup again: 同意済みなら consented に戻し、段を最初から（同意は消さない）", () => {
    const r = restartOnboarding(existingUserOnboarding(10));
    expect(r).toMatchObject({ state: "consented", step: "sources", consentedAt: 10 });
    expect(Object.values(r.steps).every((s) => s === "pending")).toBe(true);
    expect(restartOnboarding(initialOnboarding()).state).toBe("pending");
  });
});

describe("更新確認の純粋な部分（M6-12）", () => {
  test("SemVer の比較（プレリリースは正式版より前）", () => {
    expect(compareVersions("0.7.0", "0.6.9")).toBeGreaterThan(0);
    expect(compareVersions("v1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.0.0-beta.2", "1.0.0")).toBeLessThan(0);
    expect(compareVersions("1.0.0-beta.10", "1.0.0-beta.2")).toBeGreaterThan(0);
    expect(compareVersions("0.0.0-dev", "0.1.0")).toBeLessThan(0);
    expect(compareVersions("x", "1.0.0")).toBeNull();
  });

  test("latest.json の検証: URL は GitHub か確認先と同じオリジンだけ", () => {
    const feed = "https://github.com/o/r/releases/latest/download/latest.json";
    expect(
      parseLatest(
        {
          version: "v0.7.0",
          url: "https://github.com/o/r/releases/tag/v0.7.0",
          sha256: "A".repeat(64),
        },
        feed,
      ),
    ).toEqual({
      version: "0.7.0",
      url: "https://github.com/o/r/releases/tag/v0.7.0",
      sha256: "a".repeat(64),
    });
    expect(parseLatest({ version: "0.7.0", url: "https://evil.example/x" }, feed)).toBeNull();
    expect(parseLatest({ version: "seven", url: "https://github.com/x" }, feed)).toBeNull();
    expect(parseLatest(null, feed)).toBeNull();
    expect(
      parseLatest(
        { version: "0.7.0", url: "http://127.0.0.1:9/dl" },
        "http://127.0.0.1:9/latest.json",
      )?.sha256,
    ).toBeNull();
  });

  test("確認先の差し替えはループバックだけ受け付ける", () => {
    expect(resolveUpdateFeed({}, null)).toBeNull();
    expect(resolveUpdateFeed({ TURNLANE_UPDATE_FEED_URL: "http://127.0.0.1:1/l.json" }, null)).toBe(
      "http://127.0.0.1:1/l.json",
    );
    expect(resolveUpdateFeed({ TURNLANE_UPDATE_FEED_URL: "https://example.com/l.json" }, "b")).toBe(
      "b",
    );
  });
});
