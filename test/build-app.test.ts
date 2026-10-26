/** build:app（M6-13）と版を1か所から（M6-17）: バンドルの形の検査・latest.json・版。実際の組み立て（Tauri・Swift）は手元で */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EVENTS_HELPER, versionBelow } from "../apps/daemon/src/calendar/events.ts";
import { bundleAgentPlist } from "../apps/daemon/src/launchd/plist.ts";
import { parseLatest } from "../packages/core/src/update.ts";
import {
  AGENTS,
  APP_BUNDLE_ID,
  APP_REQUIRED_ENTITLEMENTS,
  appSignCommand,
  checkBundle,
  HELPER_APP,
  latestJson,
} from "../scripts/build-app.ts";
import { buildVersion, productVersion } from "../scripts/version.ts";

let dir: string;
let app: string;

const plist = (entries: Record<string, string>) =>
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>${Object.entries(entries)
    .map(([k, v]) => `<key>${k}</key><string>${v}</string>`)
    .join("")}</dict></plist>
`;

function makeBundle(o: { appVersion?: string; helperVersion?: string; skip?: string } = {}) {
  rmSync(app, { recursive: true, force: true });
  const files = [
    "Contents/MacOS/turnlane",
    "Contents/Helpers/turnlaned",
    "Contents/Helpers/turnlane",
    `Contents/Library/LoginItems/${HELPER_APP}/Contents/MacOS/TurnlaneCalendarHelper`,
  ];
  for (const f of files) {
    if (f === o.skip) continue;
    mkdirSync(join(app, f, ".."), { recursive: true });
    writeFileSync(join(app, f), "");
  }
  writeFileSync(
    join(app, "Contents/Info.plist"),
    plist({
      CFBundleIdentifier: APP_BUNDLE_ID,
      CFBundleShortVersionString: o.appVersion ?? "0.7.0",
      LSMinimumSystemVersion: "14.0",
      TurnlaneBuild: "0.7.0+abc",
      NSCalendarsFullAccessUsageDescription: "x",
      NSAppleEventsUsageDescription: "x",
    }),
  );
  writeFileSync(
    join(app, `Contents/Library/LoginItems/${HELPER_APP}/Contents/Info.plist`),
    plist({ CFBundleShortVersionString: o.helperVersion ?? "0.7.0" }),
  );
  mkdirSync(join(app, "Contents/Library/LaunchAgents"), { recursive: true });
  for (const a of AGENTS)
    writeFileSync(
      join(app, "Contents/Library/LaunchAgents", `${a.label}.plist`),
      bundleAgentPlist({ ...a, associatedBundleId: APP_BUNDLE_ID }),
    );
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "turnlane-build-app-"));
  app = join(dir, "Turnlane.app");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("バンドルの検査", () => {
  test("形・LaunchAgent・Info.plist・版がそろっていれば問題なし", () => {
    makeBundle();
    expect(checkBundle(app, { version: "0.7.0", build: "0.7.0+abc" })).toEqual([]);
  });

  test("足りないもの・版のずれを挙げる", () => {
    makeBundle({ skip: "Contents/Helpers/turnlaned", helperVersion: "0.6.0" });
    const p = checkBundle(app, { version: "0.7.0", build: "0.7.0+abc" });
    expect(p).toContain("missing: Contents/Helpers/turnlaned");
    expect(p.some((x) => x.startsWith("helper version 0.6.0"))).toBe(true);
    // デーモンの LaunchAgent の BundleProgram の先が無い
    expect(p.some((x) => x.includes("dev.turnlane.daemon.plist: BundleProgram"))).toBe(true);
  });

  test("外側の署名は --deep を使わず、識別子を固定する", () => {
    const c = appSignCommand("/x/Turnlane.app", "-");
    expect(c).not.toContain("--deep");
    expect(c).toContain(APP_BUNDLE_ID);
    expect(c).toContain("runtime");
    // hardened runtime でカレンダーの許可を求めるのに要る（無いと TCC が黙って断る。2026-10-21 の Neo）
    const ent = c[c.indexOf("--entitlements") + 1] as string;
    const xml = readFileSync(ent, "utf8");
    for (const k of APP_REQUIRED_ENTITLEMENTS) expect(xml).toContain(`<key>${k}</key>`);
    expect(APP_REQUIRED_ENTITLEMENTS).toContain("com.apple.security.automation.apple-events");
  });
});

describe("版を1か所から", () => {
  test("package.json の版は SemVer で、カレンダーヘルパに要る版（予定の作成）以上", () => {
    const v = productVersion();
    expect(v).toMatch(/^\d+\.\d+\.\d+/);
    // 同梱のヘルパは製品の版をそのまま持つので、予定の作成・編集に要る版を下回らない
    expect(versionBelow(v, EVENTS_HELPER)).toBe(false);
    expect(buildVersion().startsWith(`${v}+`)).toBe(true);
  });

  test("latest.json は更新確認（parseLatest）が読める形", () => {
    const url = "https://github.com/example/turnlane/releases/download/v0.7.0/Turnlane-0.7.0.zip";
    const body = JSON.parse(latestJson({ version: "0.7.0", url, sha256: "a".repeat(64) }));
    expect(
      parseLatest(body, "https://github.com/example/turnlane/releases/latest/download/latest.json"),
    ).toEqual({
      version: "0.7.0",
      url,
      sha256: "a".repeat(64),
    });
    expect(() => latestJson({ version: "x", url, sha256: "" })).toThrow();
  });
});
