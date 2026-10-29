/**
 * The desktop shell's debug symbols (turnlane.dSYM) are kept next to the build for reading crash reports, never shipped:
 * build:app copies them to <out>/symbols/, the release copies that folder to dist/release/v<version>/symbols/
 */
import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keepSymbols, SYMBOLS } from "../scripts/build-app.ts";

const ROOT = join(import.meta.dir, "..");

describe("keepSymbols", () => {
  test("copies turnlane.dSYM to <out>/symbols/ (replacing an older copy); none → null and no folder", () => {
    const root = mkdtempSync(join(tmpdir(), "turnlane-sym-"));
    try {
      const desktop = join(root, "desktop");
      const dwarf = join(desktop, "turnlane.dSYM", "Contents", "Resources", "DWARF");
      mkdirSync(dwarf, { recursive: true });
      writeFileSync(join(dwarf, "turnlane-abc"), "synthetic dwarf");
      const out = join(root, "out");
      mkdirSync(join(out, "symbols", "stale.dSYM"), { recursive: true });
      expect(keepSymbols(desktop, out)).toBe(join(out, "symbols"));
      expect(readdirSync(join(out, "symbols"))).toEqual(["turnlane.dSYM"]);
      expect(
        readFileSync(
          join(out, "symbols", "turnlane.dSYM", "Contents", "Resources", "DWARF", "turnlane-abc"),
          "utf8",
        ),
      ).toBe("synthetic dwarf");
      expect(keepSymbols(join(root, "nothing"), out)).toBeNull();
      expect(existsSync(join(out, "symbols"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the release profile makes a dSYM and keeps the shipped binary stripped; the app does not carry it", () => {
    expect(SYMBOLS).toEqual(["turnlane.dSYM"]);
    const cargo = readFileSync(join(ROOT, "apps/desktop/src-tauri/Cargo.toml"), "utf8");
    const release = cargo.slice(cargo.indexOf("[profile.release]"));
    expect(release).toContain("strip = true");
    expect(release).toContain('debug = "line-tables-only"');
    expect(release).toContain('split-debuginfo = "packed"');
    const build = readFileSync(join(ROOT, "apps/desktop/scripts/build.sh"), "utf8");
    // copied next to the app, not into it
    expect(build).toContain('cp -RL "${DSYM}" "${OUT}/turnlane.dSYM"');
    expect(build).not.toContain("Turnlane.app/Contents/Resources/turnlane.dSYM");
  });
});
