/** リリースの一本道（M6-10）の純粋な部分: CHANGELOG・前提の検査・公開のコマンド列・latest.json の形 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  HOMEBREW_INSTALL_COMMAND,
  LATEST_JSON_URL,
  LATEST_ZIP_NAME,
  LATEST_ZIP_URL,
  RELEASE_REPO_URL,
  releaseZipUrl,
} from "../packages/core/src/release-config.ts";
import { parseLatest } from "../packages/core/src/update.ts";
import { latestJson } from "../scripts/build-app.ts";
import {
  changelogSection,
  changelogTopVersion,
  defaultTapDir,
  publishSteps,
  type ReleaseFacts,
  releaseCheck,
  releaseFiles,
  sha256Line,
  tapReadme,
  tapScaffold,
} from "../scripts/release/plan.ts";
import { productVersion } from "../scripts/version.ts";

const ROOT = join(import.meta.dir, "..");

const CL = `# Changelog

## [Unreleased]

- something not released

## [0.7.0] - 2026-10-26

### Added

- First thing.

## [0.6.0] - 2026-10-01

- Older.

[Unreleased]: https://example.invalid/compare
[0.7.0]: https://example.invalid/0.7.0
`;

describe("CHANGELOG", () => {
  test("最上段の版（Unreleased を飛ばす）と、その版の節", () => {
    expect(changelogTopVersion(CL)).toEqual({ version: "0.7.0", date: "2026-10-26" });
    expect(changelogSection(CL, "0.7.0")).toBe("### Added\n\n- First thing.");
    expect(changelogSection(CL, "0.6.0")).toBe("- Older.");
    expect(changelogSection(CL, "0.5.0")).toBeNull();
    expect(changelogTopVersion("# Changelog\n\n## [Unreleased]\n")).toBeNull();
  });

  test("リポジトリの CHANGELOG.md の最上段は package.json の版で、節が空でない", () => {
    const md = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8");
    expect(changelogTopVersion(md)?.version).toBe(productVersion(ROOT));
    expect(changelogSection(md, productVersion(ROOT))?.length ?? 0).toBeGreaterThan(0);
    expect(md).toContain("## [Unreleased]");
  });
});

const OK: ReleaseFacts = {
  branch: "main",
  clean: true,
  version: "0.7.0",
  changelog: CL,
  tagExists: false,
  identity: "Developer ID Application: Example (ABCDE12345)",
  notaryProfile: "notary",
  allowAdhoc: false,
  skipNotarize: false,
};

describe("前提の検査（releaseCheck）", () => {
  test.each([
    { name: "すべて揃っている", f: {}, errors: [], warnings: [] },
    {
      name: "main 以外",
      f: { branch: "feat/x" },
      errors: ["not on main (on feat/x)"],
      warnings: [],
    },
    {
      name: "detached HEAD",
      f: { branch: null },
      errors: ["not on main (on a detached HEAD)"],
      warnings: [],
    },
    {
      name: "作業ツリーに変更",
      f: { clean: false },
      errors: ["the working tree has uncommitted changes"],
      warnings: [],
    },
    {
      name: "版が CHANGELOG と違う",
      f: { version: "0.7.1" },
      errors: ["CHANGELOG.md's top version 0.7.0 does not match package.json 0.7.1"],
      warnings: [],
    },
    {
      name: "CHANGELOG が無い",
      f: { changelog: null },
      errors: ["CHANGELOG.md is missing"],
      warnings: [],
    },
    {
      name: "日付の無い見出し",
      f: { changelog: "## [0.7.0]\n\n- x\n" },
      errors: ["CHANGELOG.md: ## [0.7.0] has no date"],
      warnings: [],
    },
    {
      name: "空の節",
      f: { changelog: "## [0.7.0] - 2026-10-26\n\n## [0.6.0] - 2026-10-01\n- y\n" },
      errors: ["CHANGELOG.md: ## [0.7.0] is empty"],
      warnings: [],
    },
    {
      name: "タグがある",
      f: { tagExists: true },
      errors: ["tag v0.7.0 already exists"],
      warnings: [],
    },
    {
      name: "Apple Development の証明書",
      f: { identity: "Apple Development: Example (ABCDE12345)" },
      errors: [
        "TURNLANE_CODESIGN_IDENTITY is not a Developer ID Application certificate (a release must be signed with Developer ID)",
      ],
      warnings: [],
    },
    {
      name: "証明書も公証のプロファイルも無い",
      f: { identity: null, notaryProfile: null },
      errors: [
        "TURNLANE_CODESIGN_IDENTITY is not set (a release must be signed with Developer ID)",
        "TURNLANE_NOTARY_PROFILE is not set (a release must be notarized)",
      ],
      warnings: [],
    },
    {
      name: "--skip-notarize",
      f: { skipNotarize: true },
      errors: ["--skip-notarize (a release must be notarized)"],
      warnings: [],
    },
    {
      name: "--allow-adhoc は署名・公証・ブランチを警告に緩める",
      f: {
        allowAdhoc: true,
        branch: "feat/x",
        identity: "-",
        notaryProfile: null,
        skipNotarize: true,
      },
      errors: [],
      warnings: [
        "not on main (on feat/x)",
        "TURNLANE_CODESIGN_IDENTITY is not a Developer ID Application certificate (a release must be signed with Developer ID)",
        "TURNLANE_NOTARY_PROFILE is not set (a release must be notarized)",
        "--skip-notarize (a release must be notarized)",
      ],
    },
    {
      name: "--allow-adhoc でも作業ツリー・版・タグは緩めない",
      f: { allowAdhoc: true, clean: false, tagExists: true, version: "0.8.0" },
      errors: [
        "the working tree has uncommitted changes",
        "CHANGELOG.md's top version 0.7.0 does not match package.json 0.8.0",
        "tag v0.8.0 already exists",
      ],
      warnings: [],
    },
  ])("$name", (c) => {
    expect(releaseCheck({ ...OK, ...c.f })).toEqual({
      errors: [...c.errors],
      warnings: [...c.warnings],
    });
  });
});

describe("公開のコマンド列（publishSteps）", () => {
  test("タグ → push → Releases（4 つを添付）→ tap の push。push と Releases は外に出す操作", () => {
    const steps = publishSteps({ version: "0.7.0", dir: "/d", tapDir: "/tap", tapCommitted: true });
    expect(steps.map((s) => [s.cmd, s.remote])).toEqual([
      [["git", "tag", "-a", "v0.7.0", "-m", "Turnlane 0.7.0"], false],
      [["git", "push", "origin", "main", "v0.7.0"], true],
      [
        [
          "gh",
          "release",
          "create",
          "v0.7.0",
          "/d/Turnlane-0.7.0.zip",
          "/d/Turnlane.zip",
          "/d/latest.json",
          "/d/Turnlane-0.7.0.zip.sha256",
          "--verify-tag",
          "--title",
          "Turnlane 0.7.0",
          "--notes-file",
          "/d/notes.md",
        ],
        true,
      ],
      [["git", "-C", "/tap", "push", "origin", "HEAD"], true],
    ]);
  });

  test("tap が無い・コミットしていないなら tap の push は無い。プレリリースは --prerelease", () => {
    const steps = publishSteps({
      version: "0.8.0-rc.1",
      dir: "/d",
      tapDir: null,
      tapCommitted: false,
    });
    expect(steps).toHaveLength(3);
    expect(steps[2]?.cmd).toContain("--prerelease");
    expect(
      publishSteps({ version: "0.7.0", dir: "/d", tapDir: "/tap", tapCommitted: false }),
    ).toHaveLength(3);
  });
});

describe("tap（defaultTapDir・tapScaffold）", () => {
  test("--tap-dir の既定は本体のリポジトリの隣の homebrew-tap", () => {
    expect(defaultTapDir("/src/turnlane/turnlane")).toBe("/src/turnlane/homebrew-tap");
    expect(defaultTapDir("/src/turnlane/wt/x/")).toBe("/src/turnlane/wt/homebrew-tap");
  });

  test.each([
    { hasLicense: false, hasReadme: false, license: "MIT\n", paths: ["LICENSE", "README.md"] },
    { hasLicense: true, hasReadme: false, license: "MIT\n", paths: ["README.md"] },
    { hasLicense: false, hasReadme: true, license: "MIT\n", paths: ["LICENSE"] },
    { hasLicense: true, hasReadme: true, license: "MIT\n", paths: [] },
    { hasLicense: false, hasReadme: true, license: null, paths: [] },
  ])("LICENSE $hasLicense・README $hasReadme・本体の LICENSE $license → $paths", (c) => {
    expect(tapScaffold(c).map((f) => f.path)).toEqual([...c.paths]);
  });

  test("LICENSE は本体のものをそのまま写す", () => {
    const text = "MIT License\n\nCopyright (c) someone\n";
    expect(tapScaffold({ hasLicense: false, hasReadme: true, license: text })[0]?.content).toBe(
      text,
    );
  });

  test("README は tap であること・インストールのコマンド・本体へのリンク", () => {
    const r = tapReadme();
    expect(r).toContain("Homebrew tap");
    expect(r).toContain(HOMEBREW_INSTALL_COMMAND);
    expect(r).toContain(`(${RELEASE_REPO_URL})`);
    expect(HOMEBREW_INSTALL_COMMAND).toBe("brew install --cask turnlane/tap/turnlane");
    expect(
      r
        .trimEnd()
        .split("\n")
        .filter((l) => l.trim()).length,
    ).toBeLessThanOrEqual(5);
  });
});

describe("添付ファイル", () => {
  test("名前と sha256 の形（shasum -a 256 -c で読める）", () => {
    expect(releaseFiles("0.7.0")).toEqual({
      zip: "Turnlane-0.7.0.zip",
      latestZip: "Turnlane.zip",
      latest: "latest.json",
      sha256: "Turnlane-0.7.0.zip.sha256",
      cask: "turnlane.rb",
      notes: "notes.md",
    });
    expect(sha256Line("a".repeat(64), "Turnlane-0.7.0.zip")).toBe(
      `${"a".repeat(64)}  Turnlane-0.7.0.zip\n`,
    );
    expect(sha256Line("a".repeat(64), "Turnlane-0.7.0.zip", "Turnlane.zip")).toBe(
      `${"a".repeat(64)}  Turnlane-0.7.0.zip\n${"a".repeat(64)}  Turnlane.zip\n`,
    );
  });

  test("版の付かない zip の固定 URL（サイトの Download ボタンの先。変えるとサイトのリンクが切れる）", () => {
    expect(LATEST_ZIP_NAME).toBe("Turnlane.zip");
    expect(LATEST_ZIP_URL).toBe(
      "https://github.com/turnlane/turnlane/releases/latest/download/Turnlane.zip",
    );
    expect(releaseZipUrl("0.7.0")).not.toBe(LATEST_ZIP_URL);
  });

  test("latest.json は { version, url, sha256 } で、url は Releases の zip。確認先から読める", () => {
    const body = latestJson({
      version: "0.7.0",
      url: releaseZipUrl("0.7.0"),
      sha256: "c".repeat(64),
    });
    const o = JSON.parse(body);
    expect(Object.keys(o)).toEqual(["version", "url", "sha256"]);
    expect(o.url).toBe(
      "https://github.com/turnlane/turnlane/releases/download/v0.7.0/Turnlane-0.7.0.zip",
    );
    expect(parseLatest(o, LATEST_JSON_URL)).toEqual({
      version: "0.7.0",
      url: o.url,
      sha256: "c".repeat(64),
    });
  });
});
