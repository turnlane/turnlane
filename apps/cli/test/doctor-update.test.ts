/** turnlane doctor の更新確認の行（M6-12）: on / off (setting) / off (custom build) / off (dev install)、最後の確認、最新の版 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { UpdateStatus } from "@turnlane/core/api";
import { updateDownloadLine, updateLine } from "../src/commands/doctor.ts";
import { setLang } from "../src/lang.ts";

beforeAll(() => setLang("en"));
afterAll(() => setLang("en"));

const base: UpdateStatus = {
  enabled: true,
  configured: true,
  current: "0.7.0",
  latest: null,
  available: false,
  checkedAt: null,
  error: null,
  channel: "download",
  upgradeCommand: null,
  off: null,
};
const AT = Date.UTC(2026, 9, 26, 9, 30);
const latest = (version: string) => ({
  version,
  url: `https://github.com/turnlane/turnlane/releases/download/v${version}/Turnlane-${version}.zip`,
  sha256: null,
});

describe("updateLine", () => {
  test.each([
    {
      name: "on・未確認",
      u: {},
      want: "Update check: on · not checked yet",
    },
    {
      name: "on・最新",
      u: { checkedAt: AT, latest: latest("0.7.0") },
      want: "Update check: on · up to date · last checked 2026-10-26T09:30 · latest 0.7.0",
    },
    {
      name: "on・前回は失敗",
      u: { checkedAt: AT, latest: latest("0.7.0"), error: "timeout" },
      want: "Update check: on · up to date · last checked 2026-10-26T09:30 · latest 0.7.0 · last check failed: timeout",
    },
    {
      name: "on・新しい版（Homebrew）",
      u: {
        checkedAt: AT,
        latest: latest("0.8.0"),
        available: true,
        channel: "homebrew" as const,
        upgradeCommand: "brew upgrade --cask turnlane",
      },
      want: "Update check: on · 0.8.0 is available (you have 0.7.0). Run brew upgrade --cask turnlane",
    },
    {
      name: "off (setting)",
      u: { enabled: false, off: "setting" as const },
      want: "Update check: off (setting; turn on with turnlane config set update.check true)",
    },
    {
      name: "off (setting)・off の無い古いデーモン",
      u: { enabled: false },
      drop: "off" as const,
      want: "Update check: off (setting; turn on with turnlane config set update.check true)",
    },
    {
      name: "off (custom build)",
      u: { off: "custom_build" as const },
      want: "Update check: off (custom build: includes an extension)",
    },
    {
      name: "off (dev install)・前の確認が残っている",
      u: { off: "dev_install" as const, checkedAt: AT, latest: latest("0.7.0") },
      want: "Update check: off (dev install) · last checked 2026-10-26T09:30 · latest 0.7.0",
    },
    {
      name: "確認先の無いビルド",
      u: { configured: false },
      want: "Update check: off (no update feed in this build)",
    },
  ])("$name", (c) => {
    const u: UpdateStatus = { ...base, ...c.u };
    if ("drop" in c) delete u.off;
    expect(updateLine(u)).toBe(c.want);
  });
});

describe("updateDownloadLine（自動更新の 1 行）", () => {
  const d = (o: Partial<NonNullable<UpdateStatus["download"]>>) => ({
    download: {
      state: "idle" as const,
      version: null,
      path: null,
      error: null,
      attempts: 0,
      at: AT,
      ...o,
    },
  });
  test.each([
    { name: "古いデーモン（download なし）", u: {}, want: null },
    {
      name: "オフ（設定）",
      u: { downloadEnabled: false, ...d({}) },
      want: "Update download: off (setting; turn on with turnlane config set update.download true)",
    },
    {
      name: "確認がオフ",
      u: { enabled: false, off: "setting" as const, downloadEnabled: true, ...d({}) },
      want: "Update download: off (the update check is off)",
    },
    {
      name: "開発時の配置",
      u: { channel: "dev" as const, downloadEnabled: true, ...d({}) },
      want: "Update download: on · only for the app install (Turnlane.app)",
    },
    { name: "何もない", u: { downloadEnabled: true, ...d({}) }, want: "Update download: on" },
    {
      name: "取得中",
      u: { ...d({ state: "downloading", version: "0.7.2" }) },
      want: "Update download: on · downloading 0.7.2",
    },
    {
      name: "ready",
      u: { ...d({ state: "ready", version: "0.7.2", path: "/p" }) },
      want: "Update download: on · 0.7.2 is ready (Restart to update in the menu bar or at the top of the board)",
    },
    {
      name: "失敗（やり直す）",
      u: { ...d({ state: "failed", version: "0.7.2", error: "team_id", attempts: 1 }) },
      want: "Update download: on · 0.7.2 failed: team_id (attempt 1 of 3; retried at the next check)",
    },
    {
      name: "失敗（やめた）",
      u: { ...d({ state: "failed", version: "0.7.2", error: "notarization", attempts: 3 }) },
      want: "Update download: on · 0.7.2 failed: notarization (gave up; update by hand)",
    },
  ])("$name", (c) => {
    expect(updateDownloadLine({ ...base, ...c.u })).toBe(c.want);
  });
});
