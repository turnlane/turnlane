/**
 * `bun run release --from-app <Turnlane.app>`: argument handling, the validation decisions (synthetic command
 * results; no real codesign / stapler / spctl), the dry-run plan, the shared zip + latest.json, and the staple hint
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseLatest } from "../packages/core/src/update.ts";
import { packageApp, stapleResumeHint } from "../scripts/build-app.ts";
import {
  checkFromApp,
  type FromAppResults,
  fromAppCommands,
  fromAppPlan,
  parseReleaseArgs,
  teamOf,
} from "../scripts/release/from-app.ts";
import type { ExecResult } from "../scripts/signing.ts";

const ID = "Developer ID Application: Example Maker (AB12CD34EF)";
const APP = "/tmp/out/release/.stage-x/Turnlane.app";

describe("parseReleaseArgs", () => {
  test("--from-app takes a path and keeps the other flags", () => {
    const a = parseReleaseArgs(["--from-app", APP, "--tap-dir", "../tap", "--publish", "--yes"]);
    expect(a).toMatchObject({
      fromApp: APP,
      tapDir: "../tap",
      publish: true,
      yes: true,
      dryRun: false,
      errors: [],
    });
    expect(parseReleaseArgs(["--dry-run", "--from-app", APP]).errors).toEqual([]);
  });

  test("--from-app without a path, or with --skip-notarize / --allow-adhoc, is refused", () => {
    expect(parseReleaseArgs(["--from-app"]).errors).toEqual([
      "--from-app needs the path to Turnlane.app",
    ]);
    expect(parseReleaseArgs(["--from-app", "--publish"]).errors).toContain(
      "--from-app needs the path to Turnlane.app",
    );
    for (const f of ["--skip-notarize", "--allow-adhoc"])
      expect(parseReleaseArgs(["--from-app", APP, f]).errors.join("\n")).toContain(
        "--from-app cannot be combined with --skip-notarize or --allow-adhoc",
      );
  });

  test("the existing rules stay: --publish with --dry-run / --allow-adhoc, --tap-dir needs a path", () => {
    expect(parseReleaseArgs(["--publish", "--dry-run"]).errors).toEqual([
      "--publish cannot be combined with --dry-run or --allow-adhoc",
    ]);
    expect(parseReleaseArgs(["--tap-dir"]).errors).toEqual(["--tap-dir needs a path"]);
    expect(parseReleaseArgs([])).toMatchObject({ fromApp: null, tapDir: null, errors: [] });
  });
});

const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
const fail = (stderr: string): ExecResult => ({ code: 1, stdout: "", stderr });
/** The results for a good, stapled, notarized release app */
const good = (): FromAppResults => ({
  verify: ok(),
  display: {
    code: 0,
    stdout: "",
    stderr: `Executable=${APP}/Contents/MacOS/turnlane\nIdentifier=dev.turnlane.desktop\nAuthority=${ID}\nAuthority=Developer ID Certification Authority\nAuthority=Apple Root CA\nTeamIdentifier=AB12CD34EF\n`,
  },
  version: ok("0.7.2\n"),
  extensions: ok("\n"),
  stapler: ok("The validate action worked!\n"),
  spctl: { code: 0, stdout: "", stderr: `${APP}: accepted\nsource=Notarized Developer ID\n` },
});
const check = (results: FromAppResults, o: Partial<{ app: string; isDirectory: boolean }> = {}) =>
  checkFromApp({
    app: o.app ?? APP,
    isDirectory: o.isDirectory ?? true,
    identity: ID,
    version: "0.7.2",
    results,
  });

describe("checkFromApp", () => {
  test("a signed, stapled, notarized 0.7.2 app without extensions is accepted", () => {
    expect(check(good())).toEqual({ errors: [], warnings: [] });
    expect(teamOf(ID)).toBe("AB12CD34EF");
  });

  test("not a directory / not named Turnlane.app", () => {
    expect(check(good(), { isDirectory: false }).errors).toEqual([`${APP} is not a directory`]);
    expect(check(good(), { app: "/tmp/Other.app" }).errors).toEqual([
      "/tmp/Other.app is not named Turnlane.app",
    ]);
  });

  test("codesign --verify fails", () => {
    const r = { ...good(), verify: fail("a sealed resource is missing or invalid") };
    expect(check(r).errors).toEqual([
      "codesign --verify --deep --strict failed: a sealed resource is missing or invalid",
    ]);
  });

  test("signed by another certificate or another team", () => {
    const other = good();
    other.display = {
      code: 0,
      stdout: "",
      stderr:
        "Authority=Developer ID Application: Someone Else (ZZ99ZZ99ZZ)\nTeamIdentifier=ZZ99ZZ99ZZ\n",
    };
    expect(check(other).errors).toEqual([
      `signed by Developer ID Application: Someone Else (ZZ99ZZ99ZZ), not ${ID}`,
      "TeamIdentifier ZZ99ZZ99ZZ != AB12CD34EF",
    ]);
    const adhoc = { ...good(), display: ok("") };
    adhoc.display.stderr = "Signature=adhoc\nTeamIdentifier=not set\n";
    expect(check(adhoc).errors).toContain(`signed by (no authority), not ${ID}`);
  });

  test("version mismatch", () => {
    expect(check({ ...good(), version: ok("0.7.1\n") }).errors).toEqual([
      "app version 0.7.1 != 0.7.2",
    ]);
  });

  test("extensions: recorded ones refuse; a missing key (older build) is a warning", () => {
    expect(check({ ...good(), extensions: ok("example-ext\n") }).errors).toEqual([
      "the app includes extensions (example-ext); a release must not",
    ]);
    const old = check({ ...good(), extensions: fail("Could not extract value") });
    expect(old.errors).toEqual([]);
    expect(old.warnings.join("\n")).toContain("could not check for extensions");
  });

  test("not stapled: refuse and print the staple command", () => {
    const e = check({ ...good(), stapler: fail("does not have a ticket stapled to it") }).errors;
    expect(e).toHaveLength(1);
    expect(e[0]).toContain("the app is not stapled");
    expect(e[0]).toContain(`xcrun stapler staple "${APP}"`);
  });

  test("spctl rejects", () => {
    expect(
      check({ ...good(), spctl: fail("rejected\nsource=Unnotarized Developer ID") }).errors,
    ).toEqual(["spctl rejected the app: rejected\nsource=Unnotarized Developer ID"]);
  });

  test("the commands only read the app", () => {
    const c = fromAppCommands(APP);
    expect(c.verify).toEqual(["codesign", "--verify", "--deep", "--strict", APP]);
    expect(c.stapler).toEqual(["xcrun", "stapler", "validate", APP]);
    expect(c.spctl.slice(0, 4)).toEqual(["/usr/sbin/spctl", "--assess", "--type", "execute"]);
    for (const cmd of Object.values(c)) {
      expect(cmd).not.toContain("staple");
      expect(cmd).not.toContain("--sign");
      expect(cmd).not.toContain("-s");
    }
  });
});

describe("dry-run plan and the staple hint", () => {
  test("--dry-run --from-app prints validation, copy, zip and latest.json instead of check and build", () => {
    const lines = fromAppPlan({ app: APP, buildOut: "/r/out/release", version: "0.7.2" });
    const text = lines.join("\n");
    expect(text).toContain("no bun run check, no build");
    expect(text).toContain(`xcrun stapler validate ${APP}`);
    expect(text).toContain(`copy ${APP} to /r/out/release/Turnlane.app`);
    expect(text).toContain(
      "/usr/bin/ditto -c -k --keepParent /r/out/release/Turnlane.app /r/out/release/Turnlane-0.7.2.zip",
    );
    expect(text).not.toContain("build:app");
  });

  test("the kept-stage hint tells how to continue from the stapled app", () => {
    const h = stapleResumeHint("/r/out/release/.stage-abc");
    expect(h).toContain('bun run release --from-app "/r/out/release/.stage-abc/Turnlane.app"');
    expect(h).toContain('rm -rf "/r/out/release/.stage-abc"');
  });
});

describe("packageApp (shared by build:app and --from-app)", () => {
  test("zips with ditto --keepParent and writes latest.json with the zip's sha256", () => {
    const out = mkdtempSync(join(tmpdir(), "turnlane-pkg-"));
    try {
      const calls: string[][] = [];
      const r = packageApp({
        app: join(out, "Turnlane.app"),
        outDir: out,
        version: "0.7.2",
        downloadUrl:
          "https://github.com/turnlane/turnlane/releases/download/v0.7.2/Turnlane-0.7.2.zip",
        exec: (cmd) => {
          calls.push(cmd);
          writeFileSync(cmd.at(-1) as string, "synthetic zip bytes");
        },
      });
      expect(calls).toEqual([
        [
          "/usr/bin/ditto",
          "-c",
          "-k",
          "--keepParent",
          join(out, "Turnlane.app"),
          join(out, "Turnlane-0.7.2.zip"),
        ],
      ]);
      const sha = new Bun.CryptoHasher("sha256").update("synthetic zip bytes").digest("hex");
      expect(r).toEqual({ zip: join(out, "Turnlane-0.7.2.zip"), sha256: sha });
      const latest = parseLatest(
        JSON.parse(readFileSync(join(out, "latest.json"), "utf8")),
        "https://github.com/turnlane/turnlane/releases/latest/download/latest.json",
      );
      expect(latest).toMatchObject({ version: "0.7.2", sha256: sha });
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});
