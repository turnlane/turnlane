/** 設定 › 一般の「更新」の行（版・最後の確認・結果・今すぐ確認） */
import { describe, expect, test } from "bun:test";
import type { UpdateStatus } from "@turnlane/core/web";
import { translate } from "../src/i18n/index.tsx";
import { updateLine } from "../src/lib/update-line.ts";

const TZ = "Asia/Tokyo";
// 2026-10-30 16:30 JST
const NOW = Date.UTC(2026, 9, 30, 7, 30);
const base: UpdateStatus = {
  enabled: true,
  configured: true,
  current: "0.8.0",
  build: "0.8.0+e820ba7",
  latest: { version: "0.8.0", url: "https://github.com/o/r", sha256: null },
  available: false,
  checkedAt: Date.UTC(2026, 9, 30, 7, 2),
  error: null,
  result: "up_to_date",
  channel: "download",
  off: null,
};
const line = (s: Partial<UpdateStatus>, locale: "ja" | "en" = "en") =>
  updateLine({ ...base, ...s }, NOW, TZ, (k, p) => translate(locale, k, p));

describe("updateLine", () => {
  test("最新です・新しい版がある・確認できなかった", () => {
    expect(line({})).toEqual({
      text: "v0.8.0+e820ba7 · Last checked 16:02 · Up to date",
      canCheck: true,
    });
    expect(line({}, "ja").text).toBe("v0.8.0+e820ba7 · 最後の確認 16:02 · 最新です");
    expect(
      line({
        latest: { version: "0.8.1", url: "https://github.com/o/r", sha256: null },
        available: true,
        result: "available",
      }).text,
    ).toBe("v0.8.0+e820ba7 · Last checked 16:02 · 0.8.1 is available");
    expect(line({ result: "failed", error: "network" }, "ja").text).toBe(
      "v0.8.0+e820ba7 · 最後の確認 16:02 · 確認できませんでした（オフライン）",
    );
  });
  test("昨日の確認は日付つき。まだ確認していない", () => {
    expect(line({ checkedAt: Date.UTC(2026, 9, 29, 7, 2) }).text).toContain(
      "Last checked 10/29 16:02",
    );
    expect(line({ checkedAt: null, result: null }).text).toBe("v0.8.0+e820ba7 · Not checked yet");
  });
  test("自動の確認がオフ: 文とボタン。確認しないビルド: ボタンなし", () => {
    expect(line({ enabled: false, off: "setting", checkedAt: null, result: null })).toEqual({
      text: "v0.8.0+e820ba7 · Automatic checks are off",
      canCheck: true,
    });
    for (const off of ["custom_build", "dev_install"] as const)
      expect(line({ off })).toEqual({
        text: "This build does not check for updates",
        canCheck: false,
      });
    expect(line({ configured: false }).canCheck).toBe(false);
  });
});
